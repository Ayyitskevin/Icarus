import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { retrieveReadOnlyContextV3 } from "../packages/core/dist/index.js";
import { GitController } from "../packages/core/dist/git.js";
import { DEFAULT_CEILING, DEFAULT_SANDBOX_LIMITS } from "../packages/core/dist/policy.js";
import { createProviderConfig } from "../packages/core/dist/provider.js";
import { OllamaGateway } from "../packages/core/dist/providers.js";
import { createIcarusRuntime } from "../packages/core/dist/runtime.js";
import { DockerSandboxRunner } from "../packages/core/dist/sandbox.js";
import { loadGate2BenchmarkContract } from "./gate2-benchmark-contract.mjs";
import {
  computeGate2SchemaSuccessorEvidenceDigest,
  GATE2_SCHEMA_SUCCESSOR_COHORT_LIMITATIONS,
  GATE2_SCHEMA_SUCCESSOR_MANIFEST_CASE_IDS,
  GATE2_SCHEMA_SUCCESSOR_ORACLES,
  GATE2_SCHEMA_SUCCESSOR_PROVIDER,
  parseAndValidateGate2SchemaSuccessorCohortResult,
  validateGate2SchemaSuccessorCohortResult,
} from "./gate2-schema-successor-cohort-contract.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(scriptPath), "..");
const manifestPath = path.join(root, "fixtures/evals/gate2/manifest.v2.json");
const reportDirectory = path.join(root, ".local");
const reportPath = path.join(reportDirectory, "gate2-schema-successor-cohort-report.json");
const PYTHON_IMAGE =
  "python:3.12-slim@sha256:c3d81d25b3154142b0b42eb1e61300024426268edeb5b5a26dd7ddf64d9daf28";
const MAX_PROVIDER_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_CONTEXT_FILES_PER_CASE = 8;
process.umask(0o077);

function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(",")}}`;
}

function hasCode(error, code) {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function within(base, relative, label) {
  const resolved = path.resolve(base, relative);
  assertCondition(
    resolved !== base && resolved.startsWith(`${base}${path.sep}`),
    `${label} escapes its root`,
  );
  return resolved;
}

async function readRegularFile(filePath, label) {
  const metadata = await lstat(filePath);
  assertCondition(
    metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1,
    `${label} must be one non-linked regular file`,
  );
  return readFile(filePath);
}

async function snapshotFiles(directory, prefix = "", skipTopLevelGit = true) {
  const result = [];
  const current = prefix === "" ? directory : within(directory, prefix, "snapshot directory");
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (skipTopLevelGit && prefix === "" && entry.name === ".git") continue;
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    const absolute = within(directory, relative, "snapshot path");
    const metadata = await lstat(absolute);
    assertCondition(!metadata.isSymbolicLink(), `snapshot path is symbolic: ${relative}`);
    if (metadata.isDirectory()) {
      result.push(...(await snapshotFiles(directory, relative, false)));
    } else {
      assertCondition(
        metadata.isFile() && metadata.nlink === 1,
        `snapshot path is special or multiply linked: ${relative}`,
      );
      result.push({ path: relative, sha256: sha256(await readFile(absolute)) });
    }
  }
  return result;
}

function git(cwd, controlHome, args) {
  const result = spawnSync(
    "/usr/bin/git",
    [
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "credential.helper=",
      "-c",
      "protocol.allow=never",
      ...args,
    ],
    {
      cwd,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 10_000,
      shell: false,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: controlHome,
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "/bin/false",
        GIT_SSH_COMMAND: "false",
        GIT_AUTHOR_NAME: "Icarus Gate 2 Eval",
        GIT_AUTHOR_EMAIL: "icarus-gate2@example.invalid",
        GIT_COMMITTER_NAME: "Icarus Gate 2 Eval",
        GIT_COMMITTER_EMAIL: "icarus-gate2@example.invalid",
        GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
        GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
      },
    },
  );
  if (result.error !== undefined) throw result.error;
  assertCondition(
    result.status === 0,
    `fixture Git ${args[0] ?? "command"} failed: ${result.stderr || result.stdout}`,
  );
  return result.stdout.trim();
}

function summarizeChecks(checks) {
  return checks.map((check) => ({
    checkId: check.checkId,
    argv: check.argv,
    exitCode: check.exitCode,
    signal: check.signal,
    stdoutBytes: Buffer.byteLength(check.stdout, "utf8"),
    stdoutSha256: sha256(check.stdout),
    stderrBytes: Buffer.byteLength(check.stderr, "utf8"),
    stderrSha256: sha256(check.stderr),
    truncated: check.truncated,
    outcome: check.outcome,
  }));
}

function countOfflineInMemoryDatabaseChecks(observations) {
  return observations.reduce((count, observation) => {
    const oracle = GATE2_SCHEMA_SUCCESSOR_ORACLES.find(
      (entry) => entry.caseId === observation.caseId,
    );
    assertCondition(oracle !== undefined, `${observation.caseId} schema oracle is missing`);
    const expectedArgv = JSON.stringify(oracle.check.argv);
    return (
      count +
      [...observation.baseline.checks, ...observation.mutation.checks].filter(
        (check) =>
          check.checkId === oracle.check.id &&
          JSON.stringify(check.argv) === expectedArgv &&
          check.signal === null &&
          check.truncated === false &&
          Number.isSafeInteger(check.exitCode),
      ).length
    );
  }, 0);
}

function operatorTargets(benchmarkCase, repository) {
  const targets = [...benchmarkCase.expectedOutcome.expectedChangedPaths];
  const sourcePaths = new Set(repository.files.map((file) => file.path));
  if (!sourcePaths.has(targets[0])) {
    const existingAnchor = repository.files
      .map((file) => file.path)
      .filter((entry) => entry.localeCompare(targets[0]) < 0)
      .sort((left, right) => left.localeCompare(right))[0];
    assertCondition(existingAnchor !== undefined, `${benchmarkCase.id} has no existing anchor`);
    targets.push(existingAnchor);
  }
  return targets.sort((left, right) => left.localeCompare(right));
}

function planResponse(benchmarkCase, repository, oracle) {
  const targets = benchmarkCase.expectedOutcome.expectedChangedPaths;
  const anchor = operatorTargets(benchmarkCase, repository)[0];
  return {
    summary: "Apply the bounded Gate 2 schema successor fixture.",
    steps: ["Apply only the approved schema successor change", "Run the registered scenario check"],
    risks: ["The exact preimage may have changed"],
    target: anchor,
    targets,
    iterationCeiling: 0,
    checkIds: [oracle.check.id],
    grants: [],
  };
}

async function patchResponse(benchmarkCase, repository, oracle) {
  const sourceRoot = within(root, repository.fixturePath, `${benchmarkCase.id} fixture`);
  const sourceByPath = new Map();
  for (const file of repository.files) {
    sourceByPath.set(
      file.path,
      await readRegularFile(within(sourceRoot, file.path, "fixture file"), "fixture file"),
    );
  }
  return {
    summary: "Apply only the pinned Gate 2 schema successor.",
    edits: oracle.approvedFiles.map((file) => {
      if (file.op === "create") {
        return {
          op: "create",
          path: file.path,
          expectedPreimageSha256: null,
          replacements: null,
          content: file.content,
          rationale: "Create only the manifest-approved schema successor change module.",
        };
      }
      const baseline = sourceByPath.get(file.path);
      assertCondition(baseline !== undefined, `${benchmarkCase.id} baseline file is absent`);
      return {
        op: "modify",
        path: file.path,
        expectedPreimageSha256: sha256(baseline),
        replacements: [
          {
            findText: baseline.toString("utf8"),
            replaceText: file.content,
          },
        ],
        content: null,
        rationale: "Apply only the manifest-approved schema successor change bytes.",
      };
    }),
  };
}

async function providerQueue(successorCases, repositories) {
  const queue = [];
  for (const [index, benchmarkCase] of successorCases.entries()) {
    const oracle = GATE2_SCHEMA_SUCCESSOR_ORACLES[index];
    const repository = repositories.get(benchmarkCase.repositoryId);
    assertCondition(oracle !== undefined && repository !== undefined, "provider binding missing");
    queue.push(
      {
        caseId: benchmarkCase.id,
        stage: "plan",
        response: planResponse(benchmarkCase, repository, oracle),
        inputTokens: 50,
        outputTokens: 20,
      },
      {
        caseId: benchmarkCase.id,
        stage: "patch",
        response: await patchResponse(benchmarkCase, repository, oracle),
        inputTokens: 100,
        outputTokens: 60,
      },
    );
  }
  return queue;
}

async function startLoopbackProvider(initialQueue) {
  const queue = [...initialQueue];
  const requests = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunkValue of request) {
        const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
        bytes += chunk.length;
        assertCondition(bytes <= MAX_PROVIDER_REQUEST_BYTES, "provider request exceeded ceiling");
        chunks.push(chunk);
      }
      const next = queue.shift();
      assertCondition(next !== undefined, "deterministic provider queue exhausted");
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requests.push({
        caseId: next.caseId,
        stage: next.stage,
        method: request.method ?? "",
        url: request.url ?? "",
        authorization: request.headers.authorization ?? null,
        body,
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          model: body.model,
          message: { content: JSON.stringify(next.response) },
          done: true,
          done_reason: "stop",
          prompt_eval_count: next.inputTokens,
          eval_count: next.outputTokens,
        }),
      );
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ error: error instanceof Error ? error.message : "provider failure" }),
      );
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assertCondition(address !== null && typeof address !== "string", "provider did not bind");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/`,
    requests,
    remaining: () => queue.length,
    async close() {
      const completion = new Promise((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
      server.closeAllConnections();
      await completion;
    },
  };
}

function validateProviderRequests(requests, benchmarkCase) {
  assertCondition(requests.length === 2, `${benchmarkCase.id} provider count changed`);
  const instructionDigests = [];
  const requestDigests = [];
  for (const [index, request] of requests.entries()) {
    const body = request.body;
    assertCondition(
      request.caseId === benchmarkCase.id &&
        request.stage === (index === 0 ? "plan" : "patch") &&
        request.method === "POST" &&
        request.url === "/api/chat" &&
        request.authorization === null &&
        body.model === GATE2_SCHEMA_SUCCESSOR_PROVIDER.model &&
        body.stream === false &&
        body.think === false &&
        typeof body.format === "object" &&
        Array.isArray(body.messages) &&
        body.messages.length === 2 &&
        body.messages[0]?.role === "system" &&
        typeof body.messages[0]?.content === "string" &&
        body.messages[1]?.role === "user" &&
        typeof body.messages[1]?.content === "string",
      `${benchmarkCase.id} did not use the production structured Ollama contract`,
    );
    instructionDigests.push(sha256(body.messages[0].content));
    requestDigests.push(sha256(JSON.stringify(body)));
  }
  assertCondition(
    JSON.stringify(instructionDigests) ===
      JSON.stringify(GATE2_SCHEMA_SUCCESSOR_PROVIDER.instructionDigests),
    `${benchmarkCase.id} production prompt revision changed`,
  );
  return { instructionDigests, requestDigests };
}

async function runBaselineChecks(oracle, source, baseCommit, caseRoot) {
  const stateRoot = path.join(caseRoot, "baseline-state");
  const controlHome = path.join(caseRoot, "baseline-home");
  const runsRoot = path.join(caseRoot, "baseline-runs");
  await Promise.all(
    [stateRoot, controlHome, runsRoot].map((entry) => mkdir(entry, { mode: 0o700 })),
  );
  const runner = new DockerSandboxRunner(stateRoot, new GitController(controlHome, runsRoot));
  return runner.runChecks({
    runId: randomUUID(),
    worktreePath: source,
    baseCommit,
    targets: [],
    checks: [oracle.check],
    sandbox: { image: PYTHON_IMAGE, ...DEFAULT_SANDBOX_LIMITS },
    ceiling: DEFAULT_CEILING,
  });
}

async function evaluateCase({
  benchmarkCase,
  repository,
  oracle,
  providerServer,
  temporaryRoot,
  fetchEffects,
}) {
  assertCondition(
    benchmarkCase.expectedOutcome.scenarioEvaluatorId === oracle.scenarioEvaluatorId,
    `${benchmarkCase.id} evaluator identity changed`,
  );
  const original = within(root, repository.fixturePath, `${benchmarkCase.id} fixture`);
  const taskPath = within(root, benchmarkCase.task.path, `${benchmarkCase.id} task`);
  const originalBefore = await snapshotFiles(original);
  assertCondition(
    JSON.stringify(originalBefore) === JSON.stringify(repository.files),
    `${benchmarkCase.id} fixture inventory changed`,
  );
  const taskBytes = await readRegularFile(taskPath, `${benchmarkCase.id} task`);
  assertCondition(
    sha256(taskBytes) === benchmarkCase.task.sha256,
    `${benchmarkCase.id} task digest changed`,
  );

  const caseRoot = path.join(temporaryRoot, benchmarkCase.id);
  const source = path.join(caseRoot, "source");
  const gitHome = path.join(caseRoot, "git-home");
  await mkdir(caseRoot);
  await mkdir(gitHome, { mode: 0o700 });
  await cp(original, source, { recursive: true, dereference: false, errorOnExist: true });
  git(source, gitHome, ["init", "--quiet", "--initial-branch=main"]);
  git(source, gitHome, ["add", "--all"]);
  git(source, gitHome, ["commit", "--quiet", "--no-gpg-sign", "-m", "fixture baseline"]);
  const baseCommit = git(source, gitHome, ["rev-parse", "HEAD"]);
  const treeSha1 = git(source, gitHome, ["rev-parse", "HEAD^{tree}"]);
  const sourceBefore = await snapshotFiles(source);
  const sourceGitBefore = await snapshotFiles(path.join(source, ".git"), "", false);

  const retrievalHome = path.join(caseRoot, "retrieval-home");
  const retrievalRuns = path.join(caseRoot, "retrieval-runs");
  await Promise.all([retrievalHome, retrievalRuns].map((entry) => mkdir(entry, { mode: 0o700 })));
  const retrieval = await retrieveReadOnlyContextV3(
    new GitController(retrievalHome, retrievalRuns),
    source,
    baseCommit,
    taskBytes.toString("utf8"),
    {
      maxFiles: MAX_CONTEXT_FILES_PER_CASE,
      maxTotalBytes: 64 * 1024,
      maxScanBytes: 1024 * 1024,
    },
  );
  const selectedContext = retrieval.entries
    .map((entry) => ({ path: entry.path, sha256: entry.sha256 }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const digestByPath = new Map(repository.files.map((entry) => [entry.path, entry.sha256]));
  const expectedPathSet = new Set(benchmarkCase.expectedContextPaths);
  const provenance = selectedContext.filter(
    (entry) => digestByPath.get(entry.path) === entry.sha256,
  );
  const matched = provenance.filter((entry) => expectedPathSet.has(entry.path));
  const recall = matched.length / benchmarkCase.expectedContextPaths.length;
  const precision = matched.length / selectedContext.length;
  const digestProvenanceCoverage = provenance.length / selectedContext.length;
  assertCondition(
    selectedContext.length > 0 && matched.length > 0 && digestProvenanceCoverage === 1,
    `${benchmarkCase.id} retrieval evidence is incomplete: ${JSON.stringify({
      expectedContextPaths: benchmarkCase.expectedContextPaths,
      selectedContext,
      recall,
      precision,
      digestProvenanceCoverage,
    })}`,
  );

  const baselineChecks = await runBaselineChecks(oracle, source, baseCommit, caseRoot);
  const baselineOutcome = baselineChecks.every((entry) => entry.outcome === "passed")
    ? "passed"
    : "failed";
  assertCondition(
    baselineOutcome === oracle.baselineOutcome &&
      baselineChecks.length === 1 &&
      baselineChecks[0]?.truncated === false,
    `${benchmarkCase.id} baseline outcome changed`,
  );

  const requestStart = providerServer.requests.length;
  const loopbackStart = fetchEffects.loopbackProviderRequests;
  let gatewayInstances = 0;
  const stateRoot = path.join(caseRoot, "state");
  await mkdir(stateRoot, { mode: 0o700 });
  const gatewayFactory = (config) => {
    assertCondition(
      config.kind === "ollama" &&
        new URL(config.baseUrl).origin === new URL(providerServer.baseUrl).origin &&
        config.capabilities.locality === "loopback",
      `${benchmarkCase.id} requested an unauthorized gateway`,
    );
    gatewayInstances += 1;
    return new OllamaGateway(config);
  };
  let runtime = await createIcarusRuntime(stateRoot, { gatewayFactory });
  const projectName = `gate2-${benchmarkCase.id}`;
  await runtime.service.registerRepository("fixture", source);
  runtime.service.createProject({
    name: projectName,
    repositoryName: "fixture",
    baseRef: "main",
    checks: [oracle.check],
    sandbox: { image: PYTHON_IMAGE, ...DEFAULT_SANDBOX_LIMITS },
    ceiling: DEFAULT_CEILING,
  });
  const providerConfig = createProviderConfig({
    kind: "ollama",
    model: GATE2_SCHEMA_SUCCESSOR_PROVIDER.model,
    baseUrl: providerServer.baseUrl,
    inputUsdPerMillionTokens: 0,
    outputUsdPerMillionTokens: 0,
  });
  const expectedChangedPaths = benchmarkCase.expectedOutcome.expectedChangedPaths;
  const operatorSelectedTargets = operatorTargets(benchmarkCase, repository);
  const planned = await runtime.service.planRun({
    projectName,
    task: taskBytes.toString("utf8"),
    targets: operatorSelectedTargets,
    provider: providerConfig,
  });
  assertCondition(
    planned.state === "awaiting_approval" &&
      planned.planSha256 !== null &&
      JSON.stringify(planned.plan?.targets) === JSON.stringify(expectedChangedPaths) &&
      JSON.stringify(planned.plan?.checkIds) === JSON.stringify([oracle.check.id]),
    `${benchmarkCase.id} first plan did not reach the exact approval boundary: ${JSON.stringify({
      state: planned.state,
      planSha256: planned.planSha256,
      plan: planned.plan,
      operatorSelectedTargets,
    })}`,
  );
  const reviewed = await runtime.service.approvePlan(
    planned.id,
    planned.planSha256,
    "gate2-schema-successor-fixture-operator",
  );
  assertCondition(
    reviewed.state === "awaiting_review" &&
      reviewed.worktreePath !== null &&
      reviewed.verification?.outcome === "passed" &&
      JSON.stringify(reviewed.verification.changedPaths) === JSON.stringify(expectedChangedPaths),
    `${benchmarkCase.id} did not produce exact passing private-workspace evidence: ${JSON.stringify(
      {
        state: reviewed.state,
        hasWorktree: reviewed.worktreePath !== null,
        verification: reviewed.verification,
      },
    )}`,
  );
  const finalFiles = [];
  for (const file of oracle.approvedFiles) {
    const bytes = await readRegularFile(
      within(reviewed.worktreePath, file.path, "approved worktree file"),
      "approved worktree file",
    );
    assertCondition(
      bytes.equals(Buffer.from(file.content)) && sha256(bytes) === file.sha256,
      `${benchmarkCase.id} approved bytes changed: ${file.path}`,
    );
    finalFiles.push({ path: file.path, sha256: sha256(bytes) });
  }
  const completed = await runtime.service.review(
    planned.id,
    "approve",
    reviewed.verification.diffSha256,
    "gate2-schema-successor-fixture-operator",
  );
  assertCondition(
    completed.state === "completed" &&
      completed.patchSet !== null &&
      completed.verification?.outcome === "passed" &&
      completed.diff !== null,
    `${benchmarkCase.id} did not complete local review`,
  );
  runtime.close();
  runtime = await createIcarusRuntime(stateRoot, { gatewayFactory });
  const recovered = runtime.service.getRun(completed.id);
  const durableRunRecovered =
    recovered.state === "completed" &&
    recovered.planSha256 === completed.planSha256 &&
    recovered.verification?.diffSha256 === completed.verification?.diffSha256;
  assertCondition(durableRunRecovered, `${benchmarkCase.id} durable run did not reopen`);
  runtime.close();

  const caseRequests = providerServer.requests.slice(requestStart);
  const providerEvidence = validateProviderRequests(caseRequests, benchmarkCase);
  assertCondition(
    providerServer.requests.length - requestStart === 2 &&
      fetchEffects.loopbackProviderRequests - loopbackStart === 2 &&
      gatewayInstances === 2 &&
      completed.usage.toolCalls > 0 &&
      completed.usage.toolCalls <= DEFAULT_CEILING.maxToolCalls &&
      completed.usage.inputTokens === oracle.inputTokens &&
      completed.usage.outputTokens === oracle.outputTokens &&
      completed.usage.estimatedCostUsd === 0 &&
      completed.usage.reservedCostUsd === 0,
    `${benchmarkCase.id} provider usage or effect accounting changed: ${JSON.stringify({
      requests: providerServer.requests.length - requestStart,
      loopbackRequests: fetchEffects.loopbackProviderRequests - loopbackStart,
      gatewayInstances,
      usage: completed.usage,
    })}`,
  );

  const sourceAfter = await snapshotFiles(source);
  const sourceGitAfter = await snapshotFiles(path.join(source, ".git"), "", false);
  const originalAfter = await snapshotFiles(original);
  const sourceCheckoutUnchanged = JSON.stringify(sourceAfter) === JSON.stringify(sourceBefore);
  const sourceGitDirectoryUnchanged =
    JSON.stringify(sourceGitAfter) === JSON.stringify(sourceGitBefore);
  assertCondition(
    sourceCheckoutUnchanged &&
      sourceGitDirectoryUnchanged &&
      JSON.stringify(originalAfter) === JSON.stringify(originalBefore),
    `${benchmarkCase.id} changed source or fixture state`,
  );

  const observation = {
    caseId: benchmarkCase.id,
    repositoryId: benchmarkCase.repositoryId,
    scenarioEvaluatorId: benchmarkCase.expectedOutcome.scenarioEvaluatorId,
    repositoryRevisionSha256: repository.revisionSha256,
    taskSha256: benchmarkCase.task.sha256,
    baseCommit,
    treeSha1,
    retrievalDigestSha256: retrieval.digestSha256,
    repositoryDigestSha256: retrieval.repositoryDigestSha256,
    provider: {
      ...GATE2_SCHEMA_SUCCESSOR_PROVIDER,
      loopbackRequests: caseRequests.length,
      instructionDigests: providerEvidence.instructionDigests,
      requestDigests: providerEvidence.requestDigests,
    },
    selectedContext,
    retrievalMetrics: { recall, precision, digestProvenanceCoverage },
    targetAuthority: "operator_selected_existing_anchor_plus_expected_changed_paths",
    plan: {
      firstPassAccepted: true,
      operatorSelectedTargets,
      approvedTargets: completed.plan?.targets,
      checkIds: completed.plan?.checkIds,
      planSha256: completed.planSha256,
      autonomousTargetDiscoveryMeasured: false,
    },
    baseline: {
      outcome: baselineOutcome,
      checks: summarizeChecks(baselineChecks),
    },
    mutation: {
      runId: completed.id,
      state: completed.state,
      patchSetSha256: sha256(stableJson(completed.patchSet)),
      diffSha256: completed.verification.diffSha256,
      checkpointSha256: completed.verification.checkpointSha256,
      changedPaths: completed.verification.changedPaths,
      checks: summarizeChecks(completed.verification.checks),
      finalFiles,
      privateWorkspaceMutated: true,
    },
    usage: {
      toolCalls: completed.usage.toolCalls,
      inputTokens: completed.usage.inputTokens,
      outputTokens: completed.usage.outputTokens,
      estimatedCostUsd: completed.usage.estimatedCostUsd,
      reservedCostUsd: completed.usage.reservedCostUsd,
    },
    sourceCheckoutUnchanged,
    sourceGitDirectoryUnchanged,
    durableRunRecovered,
    scenarioEvidenceSha256: "",
  };
  observation.scenarioEvidenceSha256 = computeGate2SchemaSuccessorEvidenceDigest(observation);
  return observation;
}

async function prepareReportDestination() {
  await mkdir(reportDirectory, { recursive: true, mode: 0o700 });
  const directory = await lstat(reportDirectory);
  const currentUid = process.getuid?.();
  assertCondition(
    directory.isDirectory() &&
      !directory.isSymbolicLink() &&
      currentUid !== undefined &&
      directory.uid === currentUid &&
      (directory.mode & 0o077) === 0 &&
      (await realpath(reportDirectory)) === reportDirectory,
    "Gate 2 report directory must be private, owned, and canonical",
  );
  const existing = await lstat(reportPath).catch((error) => {
    if (hasCode(error, "ENOENT")) return null;
    throw error;
  });
  if (existing !== null) {
    assertCondition(
      existing.isFile() &&
        !existing.isSymbolicLink() &&
        existing.nlink === 1 &&
        existing.uid === currentUid,
      "existing Gate 2 schema successor report is unsafe",
    );
    await unlink(reportPath);
  }
}

async function persistReport(report, manifest, manifestSha256) {
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  validateGate2SchemaSuccessorCohortResult(report, manifest, manifestSha256);
  const temporaryPath = path.join(
    reportDirectory,
    `.gate2-schema-successor-cohort-${process.pid}-${randomUUID()}`,
  );
  let handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
  await rename(temporaryPath, reportPath);
  const persisted = await readFile(reportPath);
  assertCondition(
    persisted.equals(Buffer.from(serialized)),
    "persisted Gate 2 schema successor report changed bytes",
  );
  parseAndValidateGate2SchemaSuccessorCohortResult(
    persisted.toString("utf8"),
    manifest,
    manifestSha256,
  );
}

async function main() {
  assertCondition(
    process.argv.length === 2,
    "usage: node scripts/gate2-schema-successor-cohort.mjs",
  );
  assertCondition((await realpath(root)) === root, "Gate 2 repository root must be canonical");
  await prepareReportDestination();
  const loaded = await loadGate2BenchmarkContract(manifestPath, root);
  assertCondition(
    loaded.manifest.schemaVersion === 2 &&
      loaded.predecessorManifestSha256 === loaded.manifest.supersedes?.manifestSha256,
    "schema successor manifest lineage was not verified",
  );
  const includedCaseIds = new Set(GATE2_SCHEMA_SUCCESSOR_ORACLES.map((entry) => entry.caseId));
  const successorCases = loaded.manifest.cases.filter((entry) => includedCaseIds.has(entry.id));
  assertCondition(
    JSON.stringify(successorCases.map((entry) => entry.id)) ===
      JSON.stringify(GATE2_SCHEMA_SUCCESSOR_MANIFEST_CASE_IDS),
    "manifest schema successor cohort changed from the evaluator registry",
  );
  const repositories = new Map(
    loaded.manifest.repositories.map((repository) => [repository.id, repository]),
  );
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "icarus-gate2-schema-successor-"));
  const providerServer = await startLoopbackProvider(
    await providerQueue(successorCases, repositories),
  );
  const fetchEffects = { loopbackProviderRequests: 0, externalNetworkRequests: 0 };
  const allowedOrigin = new URL(providerServer.baseUrl).origin;
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const target = new URL(input instanceof Request ? input.url : input);
    if (
      target.protocol !== "http:" ||
      target.hostname !== "127.0.0.1" ||
      target.origin !== allowedOrigin
    ) {
      fetchEffects.externalNetworkRequests += 1;
      throw new Error(`Gate 2 schema successor blocked non-loopback fetch: ${target.origin}`);
    }
    fetchEffects.loopbackProviderRequests += 1;
    return nativeFetch(input, init);
  };
  try {
    const observations = [];
    for (const [index, benchmarkCase] of successorCases.entries()) {
      const repository = repositories.get(benchmarkCase.repositoryId);
      const oracle = GATE2_SCHEMA_SUCCESSOR_ORACLES[index];
      assertCondition(repository !== undefined && oracle !== undefined, "cohort binding missing");
      observations.push(
        await evaluateCase({
          benchmarkCase,
          repository,
          oracle,
          providerServer,
          temporaryRoot,
          fetchEffects,
        }),
      );
    }
    assertCondition(
      providerServer.requests.length === 4 &&
        providerServer.remaining() === 0 &&
        fetchEffects.loopbackProviderRequests === 4 &&
        fetchEffects.externalNetworkRequests === 0,
      "provider effect totals changed",
    );
    const macroRecall =
      observations.reduce((sum, entry) => sum + entry.retrievalMetrics.recall, 0) /
      observations.length;
    const macroPrecision =
      observations.reduce((sum, entry) => sum + entry.retrievalMetrics.precision, 0) /
      observations.length;
    const privateWorkspaceMutations = observations.filter(
      (entry) => entry.mutation.privateWorkspaceMutated,
    ).length;
    const sandboxCheckExecutions = observations.reduce(
      (count, entry) => count + entry.baseline.checks.length + entry.mutation.checks.length,
      0,
    );
    const icarusRegisteredCheckExecutions = observations.reduce(
      (count, entry) => count + entry.mutation.checks.length,
      0,
    );
    const runtimeReopens = observations.filter((entry) => entry.durableRunRecovered).length;
    const offlineInMemoryDatabaseChecks = countOfflineInMemoryDatabaseChecks(observations);
    assertCondition(
      privateWorkspaceMutations === observations.length &&
        sandboxCheckExecutions === observations.length * 2 &&
        icarusRegisteredCheckExecutions === observations.length &&
        runtimeReopens === observations.length &&
        offlineInMemoryDatabaseChecks === observations.length * 2,
      "observed mutation, check, or reopen effect totals changed",
    );
    const report = {
      schemaVersion: 1,
      benchmarkId: loaded.manifest.benchmarkId,
      benchmarkRevision: loaded.manifest.benchmarkRevision,
      manifestSha256: loaded.manifestSha256,
      cohortClass: "schema_successor",
      evaluatorRevision: "deterministic-production-lifecycle-v1",
      generatedAt: new Date().toISOString(),
      passed: true,
      counts: {
        manifestCases: loaded.manifest.cases.length,
        cohortCases: observations.length,
        executedCases: observations.length,
        passedCases: observations.length,
        failedCases: 0,
        unexecutedCases: loaded.manifest.cases.length - observations.length,
      },
      retrievalAggregate: {
        macroRecall,
        macroPrecision,
        digestProvenanceCoverage: 1,
      },
      planAggregate: {
        firstPassAcceptedCases: observations.length,
        firstPassAcceptanceRate: 1,
        autonomousTargetDiscoveryMeasured: false,
        targetAuthority: "operator_selected_existing_anchor_plus_expected_changed_paths",
      },
      effects: {
        providerCalls: providerServer.requests.length,
        loopbackProviderRequests: fetchEffects.loopbackProviderRequests,
        externalNetworkRequests: 0,
        remoteMutations: 0,
        sourceCheckoutMutations: 0,
        privateWorkspaceMutations,
        sandboxCheckExecutions,
        icarusRegisteredCheckExecutions,
        liveDatabaseConnections: 0,
        offlineInMemoryDatabaseChecks,
        temporaryGitFixtureSetup: true,
        runtimeReopens,
      },
      effectEvidence: {
        providerCalls: "observed",
        loopbackProviderRequests: "observed",
        externalNetworkRequests: "design-assertion",
        remoteMutations: "design-assertion",
        sourceCheckoutMutations: "observed",
        privateWorkspaceMutations: "observed",
        sandboxCheckExecutions: "observed",
        icarusRegisteredCheckExecutions: "observed",
        liveDatabaseConnections: "design-assertion",
        offlineInMemoryDatabaseChecks: "observed",
        temporaryGitFixtureSetup: "observed",
        runtimeReopens: "observed",
      },
      observations,
      limitations: GATE2_SCHEMA_SUCCESSOR_COHORT_LIMITATIONS,
      assessment: "deterministic_schema_successor_cohort_passed_gate2_incomplete",
    };
    await persistReport(report, loaded.manifest, loaded.manifestSha256);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    globalThis.fetch = nativeFetch;
    await providerServer.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

await main().catch((error) => {
  process.stderr.write(
    `Gate 2 schema successor cohort failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
