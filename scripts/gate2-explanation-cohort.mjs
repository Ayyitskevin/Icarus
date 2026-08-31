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

import { explainCodebaseV2, retrieveReadOnlyContextV3 } from "../packages/core/dist/index.js";
import { GitController } from "../packages/core/dist/git.js";
import { createProviderConfig } from "../packages/core/dist/provider.js";
import { createGateway } from "../packages/core/dist/providers.js";
import { loadGate2BenchmarkContract } from "./gate2-benchmark-contract.mjs";
import {
  computeGate2ExplanationEvidenceDigest,
  GATE2_EXPLANATION_COHORT_LIMITATIONS,
  GATE2_EXPLANATION_ORACLES,
  GATE2_EXPLANATION_PROVIDER,
  validateGate2ExplanationCohortResult,
} from "./gate2-explanation-cohort-contract.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(scriptPath), "..");
const manifestPath = path.join(root, "fixtures/evals/gate2/manifest.v1.json");
const reportDirectory = path.join(root, ".local");
const reportPath = path.join(reportDirectory, "gate2-explanation-cohort-report.json");
const MAX_PROVIDER_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_CONTEXT_FILES_PER_CASE = 8;
process.umask(0o077);

function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
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

async function snapshotFiles(directory, prefix = "") {
  const result = [];
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (prefix === "" && entry.name === ".git") continue;
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    const absolute = within(directory, entry.name, "snapshot path");
    const metadata = await lstat(absolute);
    assertCondition(!metadata.isSymbolicLink(), `fixture path is symbolic: ${relative}`);
    if (metadata.isDirectory()) {
      result.push(...(await snapshotFiles(absolute, relative)));
    } else {
      assertCondition(
        metadata.isFile() && metadata.nlink === 1,
        `fixture path is special or multiply linked: ${relative}`,
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

async function gitFingerprint(repository, controlHome) {
  const gitDirectory = path.resolve(
    repository,
    git(repository, controlHome, ["rev-parse", "--git-dir"]),
  );
  return {
    head: git(repository, controlHome, ["rev-parse", "HEAD"]),
    status: git(repository, controlHome, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]),
    refs: git(repository, controlHome, ["for-each-ref", "--format=%(refname) %(objectname)"]),
    config: git(repository, controlHome, ["config", "--local", "--null", "--list"]),
    indexSha256: sha256(await readFile(path.join(gitDirectory, "index"))),
  };
}

async function startLoopbackProvider(oracles) {
  const queue = oracles.map((oracle) => ({
    caseId: oracle.caseId,
    response: oracle.response,
    inputTokens: oracle.inputTokens,
    outputTokens: oracle.outputTokens,
  }));
  const requests = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunkValue of request) {
        const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
        bytes += chunk.length;
        assertCondition(
          bytes <= MAX_PROVIDER_REQUEST_BYTES,
          "provider request exceeded byte ceiling",
        );
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const next = queue.shift();
      assertCondition(next !== undefined, "deterministic provider queue exhausted");
      requests.push({
        caseId: next.caseId,
        method: request.method ?? "",
        url: request.url ?? "",
        body,
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          message: { content: JSON.stringify(next.response) },
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
  assertCondition(
    address !== null && typeof address !== "string",
    "loopback provider did not expose an address",
  );
  return {
    baseUrl: `http://127.0.0.1:${address.port}/`,
    requests,
    remaining() {
      return queue.length;
    },
    async close() {
      const completion = new Promise((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
      server.closeAllConnections();
      await completion;
    },
  };
}

function numberedContent(content) {
  return content
    .split("\n")
    .map((line, index) => `${index + 1}: ${line}`)
    .join("\n");
}

function assertProviderRequest(request, caseId, task, retrieval) {
  assertCondition(
    request !== undefined && request.caseId === caseId,
    "provider request order changed",
  );
  assertCondition(
    request.method === "POST" &&
      request.url === "/api/chat" &&
      request.body.model === GATE2_EXPLANATION_PROVIDER.model &&
      request.body.stream === false &&
      request.body.think === false &&
      typeof request.body.format === "object" &&
      Array.isArray(request.body.messages) &&
      request.body.messages.length === 2 &&
      request.body.messages[0]?.role === "system" &&
      typeof request.body.messages[0]?.content === "string" &&
      request.body.messages[1]?.role === "user" &&
      typeof request.body.messages[1]?.content === "string" &&
      request.body.options?.num_predict === 1_024,
    `case ${caseId} did not use the production structured Ollama request contract`,
  );
  const providerInput = JSON.parse(request.body.messages[1].content);
  const expectedInput = {
    task,
    sources: retrieval.entries.map((entry) => ({
      path: entry.path,
      sha256: entry.sha256,
      content: numberedContent(entry.content),
    })),
  };
  assertCondition(
    JSON.stringify(providerInput) === JSON.stringify(expectedInput),
    `case ${caseId} provider input was not bound to the retrieved source evidence`,
  );
}

async function evaluateCase({
  benchmarkCase,
  repository,
  oracle,
  provider,
  providerRequests,
  temporaryRoot,
}) {
  assertCondition(
    benchmarkCase.expectedOutcome.scenarioEvaluatorId === oracle.scenarioEvaluatorId,
    `case ${benchmarkCase.id} evaluator identity changed`,
  );
  const source = within(root, repository.fixturePath, `case ${benchmarkCase.id} fixture`);
  const taskPath = within(root, benchmarkCase.task.path, `case ${benchmarkCase.id} task`);
  const sourceMetadata = await lstat(source);
  assertCondition(
    sourceMetadata.isDirectory() &&
      !sourceMetadata.isSymbolicLink() &&
      (await realpath(source)) === source,
    `case ${benchmarkCase.id} fixture must be one canonical directory`,
  );
  const sourceBefore = await snapshotFiles(source);
  assertCondition(
    JSON.stringify(sourceBefore) === JSON.stringify(repository.files),
    `case ${benchmarkCase.id} fixture inventory changed`,
  );
  const taskBytes = await readRegularFile(taskPath, `case ${benchmarkCase.id} task`);
  assertCondition(
    sha256(taskBytes) === benchmarkCase.task.sha256,
    `case ${benchmarkCase.id} task digest changed`,
  );

  const caseRoot = path.join(temporaryRoot, benchmarkCase.id);
  const workspace = path.join(caseRoot, "repository");
  const controlHome = path.join(caseRoot, "control-home");
  const runsRoot = path.join(caseRoot, "retrieval-runs");
  await mkdir(caseRoot);
  await Promise.all([mkdir(controlHome), mkdir(runsRoot)]);
  await cp(source, workspace, { recursive: true, dereference: false, errorOnExist: true });
  git(workspace, controlHome, ["init", "--quiet", "--initial-branch=main"]);
  git(workspace, controlHome, ["add", "--all"]);
  git(workspace, controlHome, ["commit", "--quiet", "--no-gpg-sign", "-m", "fixture baseline"]);
  const baseCommit = git(workspace, controlHome, ["rev-parse", "HEAD"]);
  const treeSha1 = git(workspace, controlHome, ["rev-parse", "HEAD^{tree}"]);
  const workspaceBefore = {
    files: await snapshotFiles(workspace),
    git: await gitFingerprint(workspace, controlHome),
  };

  const controller = new GitController(controlHome, runsRoot, "/usr/bin/git");
  const task = taskBytes.toString("utf8");
  const retrieval = await retrieveReadOnlyContextV3(controller, workspace, baseCommit, task, {
    maxFiles: MAX_CONTEXT_FILES_PER_CASE,
    maxTotalBytes: 64 * 1024,
    maxScanBytes: 1024 * 1024,
  });
  const selectedContext = retrieval.entries
    .map((entry) => ({ path: entry.path, sha256: entry.sha256 }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const selectedPaths = selectedContext.map((entry) => entry.path);
  const expectedPathSet = new Set(benchmarkCase.expectedContextPaths);
  assertCondition(
    benchmarkCase.expectedContextPaths.every((expectedPath) =>
      selectedPaths.includes(expectedPath),
    ),
    `case ${benchmarkCase.id} did not retrieve every expected path: ${JSON.stringify(retrieval.entries.map(({ path: entryPath, score, matchedTerms }) => ({ path: entryPath, score, matchedTerms })))}`,
  );

  const explanation = await explainCodebaseV2(provider, retrieval, task);
  assertCondition(
    explanation.summary === oracle.response.summary &&
      JSON.stringify(explanation.claims) === JSON.stringify(oracle.response.claims),
    `case ${benchmarkCase.id} explanation changed from its frozen evaluator oracle`,
  );
  assertCondition(
    explanation.baseCommit === baseCommit &&
      explanation.taskSha256 === benchmarkCase.task.sha256 &&
      explanation.retrievalDigestSha256 === retrieval.digestSha256 &&
      explanation.usage.inputTokens === oracle.inputTokens &&
      explanation.usage.outputTokens === oracle.outputTokens &&
      explanation.usage.estimatedCostUsd === 0,
    `case ${benchmarkCase.id} explanation provenance or accounting changed`,
  );

  const sourceAfter = await snapshotFiles(source);
  const workspaceAfter = {
    files: await snapshotFiles(workspace),
    git: await gitFingerprint(workspace, controlHome),
  };
  const sourceCheckoutUnchanged = JSON.stringify(sourceAfter) === JSON.stringify(sourceBefore);
  const fixtureWorkspaceUnchanged =
    JSON.stringify(workspaceAfter) === JSON.stringify(workspaceBefore);
  assertCondition(sourceCheckoutUnchanged, `case ${benchmarkCase.id} changed its source fixture`);
  assertCondition(fixtureWorkspaceUnchanged, `case ${benchmarkCase.id} changed its Git workspace`);

  const request = providerRequests.at(-1);
  assertProviderRequest(request, benchmarkCase.id, task, retrieval);
  const digestByPath = new Map(repository.files.map((entry) => [entry.path, entry.sha256]));
  const provenanceMatchedPaths = selectedContext.filter(
    (entry) => digestByPath.get(entry.path) === entry.sha256,
  );
  const matchedExpectedPaths = provenanceMatchedPaths.filter((entry) =>
    expectedPathSet.has(entry.path),
  );
  const recall = matchedExpectedPaths.length / benchmarkCase.expectedContextPaths.length;
  const precision =
    selectedContext.length === 0 ? 0 : matchedExpectedPaths.length / selectedContext.length;
  const digestProvenanceCoverage =
    selectedContext.length === 0 ? 0 : provenanceMatchedPaths.length / selectedContext.length;
  assertCondition(
    recall === 1 && precision >= 0.6 && digestProvenanceCoverage === 1,
    `case ${benchmarkCase.id} retrieval quality or provenance was incomplete`,
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
    explanationDigestSha256: explanation.digestSha256,
    provider: GATE2_EXPLANATION_PROVIDER,
    selectedContext,
    retrievalMetrics: { recall, precision, digestProvenanceCoverage },
    outcome: { summary: explanation.summary, claims: explanation.claims },
    usage: {
      inputTokens: explanation.usage.inputTokens,
      outputTokens: explanation.usage.outputTokens,
      estimatedCostUsd: explanation.usage.estimatedCostUsd,
      actualBilledUsd: null,
      latencyMs: explanation.usage.latencyMs,
    },
    sourceCheckoutUnchanged,
    fixtureWorkspaceUnchanged,
    scenarioEvidenceSha256: "",
  };
  observation.scenarioEvidenceSha256 = computeGate2ExplanationEvidenceDigest(observation);
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
      (directory.mode & 0o077) === 0,
    "Gate 2 report directory must be private, owned, and non-symbolic",
  );
  assertCondition(
    (await realpath(reportDirectory)) === reportDirectory,
    "Gate 2 report directory changed identity",
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
      "existing Gate 2 explanation cohort report is unsafe",
    );
    await unlink(reportPath);
  }
}

async function persistReport(report, manifest, manifestSha256) {
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  validateGate2ExplanationCohortResult(report, manifest, manifestSha256);
  const temporaryPath = path.join(
    reportDirectory,
    `.gate2-explanation-cohort-${process.pid}-${randomUUID()}`,
  );
  let handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch((cleanupError) => {
      if (!hasCode(cleanupError, "ENOENT")) throw cleanupError;
    });
    throw error;
  }
  await rename(temporaryPath, reportPath);
  const persisted = await readFile(reportPath);
  assertCondition(
    persisted.equals(Buffer.from(serialized)),
    "persisted Gate 2 explanation cohort report changed bytes",
  );
  validateGate2ExplanationCohortResult(
    JSON.parse(persisted.toString("utf8")),
    manifest,
    manifestSha256,
  );
}

async function main() {
  assertCondition(process.argv.length === 2, "usage: node scripts/gate2-explanation-cohort.mjs");
  assertCondition((await realpath(root)) === root, "Gate 2 repository root must be canonical");
  await prepareReportDestination();
  const loaded = await loadGate2BenchmarkContract(manifestPath, root);
  const explanationCases = loaded.manifest.cases.filter((entry) => entry.class === "explanation");
  assertCondition(
    JSON.stringify(explanationCases.map((entry) => entry.id)) ===
      JSON.stringify(GATE2_EXPLANATION_ORACLES.map((entry) => entry.caseId)),
    "manifest explanation cohort changed from the evaluator registry",
  );
  const repositories = new Map(
    loaded.manifest.repositories.map((repository) => [repository.id, repository]),
  );
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "icarus-gate2-explanation-"));
  const providerServer = await startLoopbackProvider(GATE2_EXPLANATION_ORACLES);
  try {
    const providerConfig = createProviderConfig({
      kind: "ollama",
      model: GATE2_EXPLANATION_PROVIDER.model,
      baseUrl: providerServer.baseUrl,
      inputUsdPerMillionTokens: 0,
      outputUsdPerMillionTokens: 0,
    });
    const gateway = createGateway(providerConfig, {});
    const observations = [];
    for (const [index, benchmarkCase] of explanationCases.entries()) {
      const repository = repositories.get(benchmarkCase.repositoryId);
      const oracle = GATE2_EXPLANATION_ORACLES[index];
      assertCondition(repository !== undefined && oracle !== undefined, "cohort binding missing");
      observations.push(
        await evaluateCase({
          benchmarkCase,
          repository,
          oracle,
          provider: gateway,
          providerRequests: providerServer.requests,
          temporaryRoot,
        }),
      );
    }
    assertCondition(
      providerServer.requests.length === 5 && providerServer.remaining() === 0,
      "deterministic provider did not execute exactly five requests",
    );
    const report = {
      schemaVersion: 1,
      benchmarkId: loaded.manifest.benchmarkId,
      benchmarkRevision: loaded.manifest.benchmarkRevision,
      manifestSha256: loaded.manifestSha256,
      cohortClass: "explanation",
      evaluatorRevision: "deterministic-loopback-v1",
      generatedAt: new Date().toISOString(),
      passed: true,
      counts: {
        manifestCases: loaded.manifest.cases.length,
        cohortCases: explanationCases.length,
        executedCases: observations.length,
        passedCases: observations.length,
        failedCases: 0,
        unexecutedCases: loaded.manifest.cases.length - observations.length,
      },
      effects: {
        providerCalls: providerServer.requests.length,
        loopbackProviderRequests: providerServer.requests.length,
        externalNetworkRequests: 0,
        remoteMutations: 0,
        sourceCheckoutMutations: 0,
        repositoryCodeExecutions: 0,
        icarusRegisteredCommands: 0,
        temporaryGitFixtureSetup: true,
      },
      effectEvidence: {
        providerCalls: "observed",
        loopbackProviderRequests: "observed",
        externalNetworkRequests: "design-assertion",
        remoteMutations: "design-assertion",
        sourceCheckoutMutations: "observed",
        repositoryCodeExecutions: "design-assertion",
        icarusRegisteredCommands: "design-assertion",
        temporaryGitFixtureSetup: "observed",
      },
      observations,
      limitations: GATE2_EXPLANATION_COHORT_LIMITATIONS,
      assessment: "deterministic_explanation_cohort_passed_gate2_incomplete",
    };
    await persistReport(report, loaded.manifest, loaded.manifestSha256);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await providerServer.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

await main().catch((error) => {
  process.stderr.write(
    `Gate 2 explanation cohort failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
