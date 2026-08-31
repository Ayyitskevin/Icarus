import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GitController } from "../packages/core/dist/git.js";
import { retrieveReadOnlyContextV1 } from "../packages/core/dist/index.js";
import { DEFAULT_CEILING, DEFAULT_SANDBOX_LIMITS } from "../packages/core/dist/policy.js";
import { DockerSandboxRunner } from "../packages/core/dist/sandbox.js";
import { loadGate2BenchmarkContract, parseStrictGate2Json } from "./gate2-benchmark-contract.mjs";
import {
  compareGate2BenchmarkResults,
  computeGate2BenchmarkAggregates,
  computeGate2ExecutionProfileDigest,
  GATE2_RESULT_LIMITATIONS,
  validateGate2BenchmarkResult,
} from "./gate2-benchmark-result-contract.mjs";
import {
  assessGate2FirstPassPlan,
  GATE2_LIVE_CANDIDATE_CONTRACT_REVISION,
  isGate2ProviderOutputComplete,
  parseAndValidateGate2LiveCandidate,
} from "./gate2-live-candidate-contract.mjs";
import {
  buildGate2LiveCandidateInput,
  buildGate2LiveInstructions,
  GATE2_LIVE_INSTRUCTION_POLICY,
  GATE2_LIVE_INSTRUCTION_POLICY_SHA256,
} from "./gate2-live-instruction-policy.mjs";
import {
  GATE2_LIVE_ROUTING_POLICY_SHA256,
  selectGate2LiveModel,
} from "./gate2-live-routing-policy.mjs";
import { parseGate2LiveVulcanConfig } from "./gate2-live-vulcan-config.mjs";
import { GATE2_REFACTOR_ORACLES } from "./gate2-refactor-cohort-contract.mjs";
import { GATE2_REPAIR_A_ORACLES } from "./gate2-repair-cohort-a-contract.mjs";
import { GATE2_REPAIR_B_ORACLES } from "./gate2-repair-cohort-b-contract.mjs";
import { GATE2_SCAFFOLD_A_ORACLES } from "./gate2-scaffold-cohort-a-contract.mjs";
import { GATE2_SCHEMA_SUCCESSOR_ORACLES } from "./gate2-schema-successor-cohort-contract.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(scriptPath), "..");
const manifestPath = path.join(root, "fixtures/evals/gate2/manifest.v2.json");
const profilePath = path.join(root, "fixtures/evals/gate2/live-profile.v2.json");
const evidenceRoot = path.join(root, ".local/gate2-live-v2");
const VULCAN_BASE_URL = "http://127.0.0.1:8140/v1/";
const VULCAN_ORIGIN = "http://127.0.0.1:8140";
const OLLAMA_ORIGIN = "http://127.0.0.1:11434";
const VULCAN_CONFIG_PATH = "/home/kevin-lee/deploy/vulcan-data/vulcan.toml";
const PYTHON_IMAGE =
  "python:3.12-slim@sha256:c3d81d25b3154142b0b42eb1e61300024426268edeb5b5a26dd7ddf64d9daf28";
const MAX_CONTEXT_FILES = 8;
const LIVE_EVIDENCE_RECORD_REVISION = 4;
const MODEL_PINS = Object.freeze({
  code: {
    providerModel: "qwen3.8:27b",
    digest: "22130167c4c20e20c7b71454612966ca8e8171e9b3cc8ab6ce8aa6cbfec79643",
  },
  "code-fast": {
    providerModel: "ornith-1.5:35b",
    digest: "9f3b89b2521908dd2e6f7a11fa368e62c8f89e1075f22604e4d1a76dd1240fcc",
  },
});
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

function rounded(value) {
  return Number(value.toFixed(12));
}

function within(base, relative, label) {
  const resolved = path.resolve(base, relative);
  assertCondition(
    resolved !== base && resolved.startsWith(`${base}${path.sep}`),
    `${label} escapes its root`,
  );
  return resolved;
}

function hasCode(error, code) {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function readRegularFile(filePath, label) {
  const metadata = await lstat(filePath);
  assertCondition(
    metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1,
    `${label} must be one non-linked regular file`,
  );
  return readFile(filePath);
}

async function snapshotFiles(directory, prefix = "", skipGit = true) {
  const current = prefix === "" ? directory : within(directory, prefix, "snapshot directory");
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const result = [];
  for (const entry of entries) {
    if (skipGit && prefix === "" && entry.name === ".git") continue;
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
        GIT_AUTHOR_NAME: "Icarus Gate 2 Live Eval",
        GIT_AUTHOR_EMAIL: "icarus-gate2@example.invalid",
        GIT_COMMITTER_NAME: "Icarus Gate 2 Live Eval",
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

function oracleRegistry() {
  const entries = [
    ...GATE2_REPAIR_A_ORACLES,
    ...GATE2_REPAIR_B_ORACLES,
    ...GATE2_REFACTOR_ORACLES,
    ...GATE2_SCAFFOLD_A_ORACLES,
    ...GATE2_SCHEMA_SUCCESSOR_ORACLES,
  ];
  const registry = new Map(entries.map((entry) => [entry.caseId, entry]));
  assertCondition(registry.size === 20, "mutation evaluator registry must contain 20 cases");
  return registry;
}

async function preflight(profile, nativeFetch) {
  const [healthResponse, modelsResponse, tagsResponse, configBytes] = await Promise.all([
    nativeFetch(`${VULCAN_ORIGIN}/healthz`),
    nativeFetch(`${VULCAN_ORIGIN}/v1/models`),
    nativeFetch(`${OLLAMA_ORIGIN}/api/tags`),
    readRegularFile(VULCAN_CONFIG_PATH, "Vulcan config"),
  ]);
  assertCondition(
    healthResponse.ok && modelsResponse.ok && tagsResponse.ok,
    "model preflight failed",
  );
  const health = await healthResponse.json();
  const models = await modelsResponse.json();
  const tags = await tagsResponse.json();
  assertCondition(health.status === "ok", "Vulcan is not healthy");
  const exposed = new Map(models.data.map((entry) => [entry.id, entry]));
  const installed = new Map(tags.models.map((entry) => [entry.name, entry]));
  const configured = parseGate2LiveVulcanConfig(configBytes.toString("utf8"), OLLAMA_ORIGIN);
  for (const model of profile.models) {
    const pin = MODEL_PINS[model.modelId];
    assertCondition(pin !== undefined, `profile model is not pinned: ${model.modelId}`);
    const exposedModel = exposed.get(model.modelId);
    const configuredModel = configured.mappings.get(model.modelId);
    const installedModel = installed.get(pin.providerModel);
    assertCondition(
      exposedModel?.availability === "available" &&
        exposedModel.provider === "local-ollama" &&
        configuredModel?.provider === "local-ollama" &&
        configuredModel.providerModel === pin.providerModel &&
        installedModel?.digest === pin.digest,
      `live model pin changed: ${model.modelId}`,
    );
  }
  return {
    checkedAt: new Date().toISOString(),
    vulcanHealthSha256: sha256(JSON.stringify(health)),
    vulcanModelsSha256: sha256(JSON.stringify(models)),
    vulcanConfigSha256: sha256(configBytes),
    ollamaTagsSha256: sha256(JSON.stringify(tags)),
    provider: configured.provider,
    models: Object.entries(MODEL_PINS).map(([modelId, pin]) => ({ modelId, ...pin })),
  };
}

/**
 * Attach the objective facts that distinguish "the model produced nothing" from
 * "the model produced something we did not keep".
 *
 * A bare contract message on an empty candidate reads as model silence.
 * `scaffold-cart-discount` recorded exactly that after billing 8192 output tokens
 * over 145 seconds, because the gateway of the day discarded the model's reasoning
 * before the harness ever saw it. Absence and loss must not serialize identically.
 * See docs/diagnoses/2026-08-30-gate2-zero-yield-thinking-displacement.md.
 *
 * Non-empty candidates keep the parser's message verbatim: this adds context only
 * where the record would otherwise be unreadable.
 */
export function describeGate2CandidateFailure(reason, generated) {
  if (generated.text.length !== 0) return reason;
  const reasoning =
    generated.thinkingChars === null || generated.thinkingChars === undefined
      ? "not measured"
      : `${generated.thinkingChars} characters`;
  return (
    `${reason} (provider returned 0 content characters in ` +
    `${generated.usage.outputTokens} output tokens, ` +
    `finishReason=${generated.finishReason}, reasoning=${reasoning})`
  );
}

async function callVulcanCandidate(
  modelId,
  benchmarkCase,
  task,
  repositoryPaths,
  retrieval,
  checkIds,
  budgets,
) {
  const requestInstructions = buildGate2LiveInstructions(
    benchmarkCase.class,
    benchmarkCase.expectedOutcome.kind,
  );
  const generation = GATE2_LIVE_INSTRUCTION_POLICY.generation;
  assertCondition(
    generation.maxTokens <= budgets.maxOutputTokens,
    "instruction policy exceeds the output-token budget",
  );
  const timeoutMs = budgets.maxRuntimeSeconds * 1_000;
  const startedAt = performance.now();
  let response;
  try {
    response = await fetch(`${VULCAN_BASE_URL}chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        model: modelId,
        messages: [
          {
            role: "system",
            content: requestInstructions,
          },
          {
            role: "user",
            content: buildGate2LiveCandidateInput({
              task,
              repositoryPaths,
              registeredCheckIds: checkIds,
              sources: retrieval.entries,
            }),
          },
        ],
        // Vulcan accepts temperature/max_tokens and rejects unknown request fields.
        // Source: https://github.com/Ayyitskevin/Vulcan/blob/c6223a6/src/vulcan/schemas.py
        // As of Vulcan c6223a6 the request also accepts a tri-state `think`, and the
        // response may carry `message.thinking`. This benchmark deliberately does NOT
        // send `think`: suppressing reasoning would change what the profile measures and
        // needs its own accepted ADR. It does now RECORD what reasoning cost, below.
        temperature: generation.temperature,
        max_tokens: generation.maxTokens,
        stream: false,
        seat: "icarus",
      }),
    });
  } catch (error) {
    if (error?.name !== "TimeoutError" && error?.name !== "AbortError") throw error;
    return {
      text: "",
      thinkingChars: 0,
      finishReason: "timeout",
      providerFailure: "request_timeout",
      usageBasis: "declared_budget_upper_bound",
      usage: {
        inputTokens: budgets.maxInputTokens,
        outputTokens: budgets.maxOutputTokens,
        estimatedCostUsd: null,
        latencyMs: timeoutMs,
      },
    };
  }
  const latencyMs = Math.round(performance.now() - startedAt);
  assertCondition(response.ok, `Vulcan candidate request failed with HTTP ${response.status}`);
  const body = await response.json();
  assertCondition(
    Array.isArray(body.choices) && body.choices.length === 1,
    "Vulcan candidate response did not contain exactly one choice",
  );
  const choice = body.choices[0];
  const inputTokens = body.usage?.prompt_tokens;
  const outputTokens = body.usage?.completion_tokens;
  assertCondition(
    Number.isSafeInteger(inputTokens) &&
      inputTokens >= 0 &&
      Number.isSafeInteger(outputTokens) &&
      outputTokens >= 0,
    "Vulcan candidate response omitted bounded usage",
  );
  // A missing or non-string `content` is a protocol violation, not an empty answer.
  // Coercing both to "" made a malformed response indistinguishable from a model that
  // genuinely returned nothing, and that ambiguity is exactly what made the 2026-08-28
  // zero-yield cases unreadable. See docs/diagnoses/2026-08-30-gate2-zero-yield-thinking-displacement.md
  assertCondition(
    typeof choice.message?.content === "string",
    "Vulcan candidate response omitted a string message.content",
  );
  // Reasoning text is billed in completion tokens. Retain only its size: enough to tell
  // "the model produced nothing" from "the model reasoned and returned nothing", without
  // copying model reasoning into published evidence.
  const thinkingChars =
    typeof choice.message?.thinking === "string" ? choice.message.thinking.length : 0;
  return {
    text: choice.message.content,
    thinkingChars,
    finishReason: typeof choice.finish_reason === "string" ? choice.finish_reason : "unknown",
    providerFailure: null,
    usageBasis: "provider_reported",
    usage: { inputTokens, outputTokens, estimatedCostUsd: null, latencyMs },
  };
}

async function runChecks(candidateRoot, baseCommit, oracle, caseRoot) {
  const stateRoot = path.join(caseRoot, "sandbox-state");
  const controlHome = path.join(caseRoot, "sandbox-home");
  const runsRoot = path.join(caseRoot, "sandbox-runs");
  await Promise.all(
    [stateRoot, controlHome, runsRoot].map((entry) =>
      mkdir(entry, { recursive: true, mode: 0o700 }),
    ),
  );
  const runner = new DockerSandboxRunner(stateRoot, new GitController(controlHome, runsRoot));
  return runner.runChecks({
    runId: randomUUID(),
    worktreePath: candidateRoot,
    baseCommit,
    targets: oracle.approvedFiles.map((entry) => entry.path),
    checks: [oracle.check],
    sandbox: { image: PYTHON_IMAGE, ...DEFAULT_SANDBOX_LIMITS },
    ceiling: DEFAULT_CEILING,
  });
}

async function writeCandidateFiles(candidateRoot, files) {
  for (const file of files) {
    const target = within(candidateRoot, file.path, "candidate file");
    const parent = path.dirname(target);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const existing = await lstat(target).catch((error) => {
      if (hasCode(error, "ENOENT")) return null;
      throw error;
    });
    if (existing !== null) {
      assertCondition(
        existing.isFile() && !existing.isSymbolicLink() && existing.nlink === 1,
        `candidate target is unsafe: ${file.path}`,
      );
    }
    await writeFile(target, file.content, { encoding: "utf8", mode: 0o600 });
  }
}

function changedPaths(before, after) {
  const beforeMap = new Map(before.map((entry) => [entry.path, entry.sha256]));
  const afterMap = new Map(after.map((entry) => [entry.path, entry.sha256]));
  return [...new Set([...beforeMap.keys(), ...afterMap.keys()])]
    .filter((entry) => beforeMap.get(entry) !== afterMap.get(entry))
    .sort((left, right) => left.localeCompare(right));
}

function summarizeChecks(checks) {
  return checks.map((check) => ({
    checkId: check.checkId,
    argv: check.argv,
    exitCode: check.exitCode,
    signal: check.signal,
    stdoutSha256: sha256(check.stdout),
    stderrSha256: sha256(check.stderr),
    truncated: check.truncated,
    outcome: check.outcome,
  }));
}

async function atomicWriteJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}`;
  let handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, filePath);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function estimatedCost(profile, modelId, inputTokens, outputTokens) {
  const model = profile.models.find((entry) => entry.modelId === modelId);
  assertCondition(model !== undefined, `profile model missing: ${modelId}`);
  return rounded(
    (inputTokens * model.inputUsdPerMillion + outputTokens * model.outputUsdPerMillion) / 1_000_000,
  );
}

async function evaluateCase({ benchmarkCase, repository, oracle, mode, profile, manifestSha256 }) {
  const modelId = selectGate2LiveModel(mode, benchmarkCase.class);
  const caseEvidencePath = path.join(
    evidenceRoot,
    profile.profileDigestSha256,
    mode,
    `${benchmarkCase.id}.json`,
  );
  const existing = await readFile(caseEvidencePath, "utf8").catch((error) => {
    if (hasCode(error, "ENOENT")) return null;
    throw error;
  });
  let existingRecord = null;
  let priorRecord = null;
  if (existing !== null) {
    const parsed = parseStrictGate2Json(existing);
    existingRecord = parsed;
    assertCondition(
      parsed.manifestSha256 === manifestSha256 &&
        parsed.executionProfileDigestSha256 === profile.profileDigestSha256 &&
        parsed.mode === mode &&
        parsed.caseId === benchmarkCase.id &&
        parsed.modelId === modelId,
      `stale live evidence exists for ${mode}/${benchmarkCase.id}`,
    );
    if (
      parsed.candidateContractRevision === GATE2_LIVE_CANDIDATE_CONTRACT_REVISION &&
      parsed.evidenceRecordRevision === LIVE_EVIDENCE_RECORD_REVISION &&
      parsed.instructionPolicySha256 === GATE2_LIVE_INSTRUCTION_POLICY_SHA256 &&
      parsed.routingPolicySha256 === GATE2_LIVE_ROUTING_POLICY_SHA256 &&
      parsed.evaluatorEvidence?.instructionPolicySha256 === GATE2_LIVE_INSTRUCTION_POLICY_SHA256 &&
      parsed.evaluatorEvidence?.routingPolicySha256 === GATE2_LIVE_ROUTING_POLICY_SHA256
    ) {
      return parsed;
    }
    if (parsed.instructionPolicySha256 === GATE2_LIVE_INSTRUCTION_POLICY_SHA256) {
      priorRecord = parsed;
    }
  }

  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), `icarus-gate2-live-${mode}-`));
  try {
    const original = within(root, repository.fixturePath, "fixture");
    const taskBytes = await readRegularFile(within(root, benchmarkCase.task.path, "task"), "task");
    assertCondition(sha256(taskBytes) === benchmarkCase.task.sha256, "task digest changed");
    const task = taskBytes.toString("utf8");
    const source = path.join(temporaryRoot, "source");
    const gitHome = path.join(temporaryRoot, "git-home");
    await mkdir(gitHome, { mode: 0o700 });
    await cp(original, source, { recursive: true, dereference: false, errorOnExist: true });
    git(source, gitHome, ["init", "--quiet", "--initial-branch=main"]);
    git(source, gitHome, ["add", "--all"]);
    git(source, gitHome, ["commit", "--quiet", "--no-gpg-sign", "-m", "fixture baseline"]);
    const baseCommit = git(source, gitHome, ["rev-parse", "HEAD"]);
    const sourceBefore = await snapshotFiles(source);
    assertCondition(
      JSON.stringify(sourceBefore) === JSON.stringify(repository.files),
      "fixture inventory changed",
    );

    const retrievalHome = path.join(temporaryRoot, "retrieval-home");
    const retrievalRuns = path.join(temporaryRoot, "retrieval-runs");
    await Promise.all([retrievalHome, retrievalRuns].map((entry) => mkdir(entry, { mode: 0o700 })));
    const retrieval = await retrieveReadOnlyContextV1(
      new GitController(retrievalHome, retrievalRuns),
      source,
      baseCommit,
      task,
      { maxFiles: MAX_CONTEXT_FILES, maxTotalBytes: 64 * 1024, maxScanBytes: 1024 * 1024 },
    );
    const retrievedContext = retrieval.entries
      .map((entry) => ({ path: entry.path, sha256: entry.sha256 }))
      .sort((left, right) => left.path.localeCompare(right.path));
    const checkIds = oracle === undefined ? [] : [oracle.check.id];
    const generated =
      priorRecord === null
        ? await callVulcanCandidate(
            modelId,
            benchmarkCase,
            task,
            repository.files.map((entry) => entry.path),
            retrieval,
            checkIds,
            profile.budgets,
          )
        : {
            text: priorRecord.rawCandidate,
            // Replayed from a record written before reasoning size was measured.
            thinkingChars: null,
            finishReason: priorRecord.finishReason ?? "legacy-stop",
            providerFailure: priorRecord.providerFailure ?? null,
            usageBasis: priorRecord.usageBasis ?? "provider_reported",
            usage: {
              inputTokens: priorRecord.observation.usage.inputTokens,
              outputTokens: priorRecord.observation.usage.outputTokens,
              estimatedCostUsd: priorRecord.observation.usage.estimatedCostUsd,
              latencyMs: priorRecord.observation.usage.latencyMs,
            },
          };
    assertCondition(
      generated.usage.inputTokens !== null && generated.usage.outputTokens !== null,
      `${benchmarkCase.id} provider omitted usage`,
    );

    let candidate = null;
    let candidateError = null;
    try {
      candidate = parseAndValidateGate2LiveCandidate(generated.text, {
        repositoryPaths: repository.files.map((entry) => entry.path),
        retrievedPaths: retrieval.entries.map((entry) => entry.path),
        checkIds,
        expectedKind: benchmarkCase.expectedOutcome.kind,
      });
    } catch (error) {
      candidateError = describeGate2CandidateFailure(
        error instanceof Error ? error.message : String(error),
        generated,
      );
    }
    const firstPassPlanAccepted =
      candidate !== null && assessGate2FirstPassPlan(candidate, benchmarkCase, checkIds);
    const providerOutputComplete = isGate2ProviderOutputComplete(generated.finishReason);
    let observedChangedPaths = [];
    let citations = [];
    let findingIds = [];
    let checks = [];
    let scenarioStatus = "failed";
    if (candidate !== null && benchmarkCase.expectedOutcome.kind === "read_only") {
      citations = candidate.answer.citations;
      findingIds = candidate.answer.findingIds;
      scenarioStatus =
        JSON.stringify(citations) ===
          JSON.stringify(benchmarkCase.expectedOutcome.expectedCitationPaths) &&
        JSON.stringify(findingIds) ===
          JSON.stringify(benchmarkCase.expectedOutcome.expectedFindingIds)
          ? "passed"
          : "failed";
    } else if (candidate !== null && firstPassPlanAccepted && oracle !== undefined) {
      const candidateRoot = path.join(temporaryRoot, "candidate");
      await cp(source, candidateRoot, { recursive: true, dereference: false, errorOnExist: true });
      const candidateBefore = await snapshotFiles(candidateRoot);
      await writeCandidateFiles(candidateRoot, candidate.answer.files);
      const candidateAfter = await snapshotFiles(candidateRoot);
      observedChangedPaths = changedPaths(candidateBefore, candidateAfter);
      checks = await runChecks(candidateRoot, baseCommit, oracle, temporaryRoot);
      scenarioStatus = checks.every((entry) => entry.outcome === "passed") ? "passed" : "failed";
    }
    if (!providerOutputComplete) scenarioStatus = "failed";
    const sourceAfter = await snapshotFiles(source);
    assertCondition(
      JSON.stringify(sourceAfter) === JSON.stringify(sourceBefore),
      `${benchmarkCase.id} source checkout changed`,
    );
    const evaluatorEvidence = {
      schemaVersion: 1,
      caseId: benchmarkCase.id,
      evaluatorId: benchmarkCase.expectedOutcome.scenarioEvaluatorId,
      candidateSha256: sha256(generated.text),
      instructionPolicySha256: GATE2_LIVE_INSTRUCTION_POLICY_SHA256,
      routingPolicySha256: GATE2_LIVE_ROUTING_POLICY_SHA256,
      finishReason: generated.finishReason,
      providerFailure: generated.providerFailure,
      usageBasis: generated.usageBasis,
      providerOutputComplete,
      firstPassPlanAccepted,
      changedPaths: observedChangedPaths,
      citations,
      findingIds,
      checks: summarizeChecks(checks),
      scenarioStatus,
      sourceCheckoutUnchanged: true,
    };
    const observation = {
      caseId: benchmarkCase.id,
      repositoryRevisionSha256: repository.revisionSha256,
      taskSha256: benchmarkCase.task.sha256,
      modelId,
      retrievedContext,
      firstPassPlanAccepted,
      changedPaths: observedChangedPaths,
      citations,
      findingIds,
      scenarioEvaluatorId: benchmarkCase.expectedOutcome.scenarioEvaluatorId,
      scenarioEvidenceSha256: sha256(stableJson(evaluatorEvidence)),
      scenarioStatus,
      usage: {
        inputTokens: generated.usage.inputTokens,
        outputTokens: generated.usage.outputTokens,
        estimatedCostUsd: estimatedCost(
          profile,
          modelId,
          generated.usage.inputTokens,
          generated.usage.outputTokens,
        ),
        actualBilledUsd: null,
        latencyMs: generated.usage.latencyMs,
      },
    };
    const record = {
      schemaVersion: 1,
      candidateContractRevision: GATE2_LIVE_CANDIDATE_CONTRACT_REVISION,
      evidenceRecordRevision: LIVE_EVIDENCE_RECORD_REVISION,
      instructionPolicySha256: GATE2_LIVE_INSTRUCTION_POLICY_SHA256,
      routingPolicySha256: GATE2_LIVE_ROUTING_POLICY_SHA256,
      manifestSha256,
      executionProfileDigestSha256: profile.profileDigestSha256,
      mode,
      caseId: benchmarkCase.id,
      modelId,
      generatedAt: new Date().toISOString(),
      finishReason: generated.finishReason,
      providerFailure: generated.providerFailure,
      usageBasis: generated.usageBasis,
      reassessedFromEvidenceSha256:
        priorRecord === null ? null : sha256(`${JSON.stringify(priorRecord, null, 2)}\n`),
      retrieval: {
        baseCommit,
        digestSha256: retrieval.digestSha256,
        repositoryDigestSha256: retrieval.repositoryDigestSha256,
      },
      rawCandidate: generated.text,
      candidate,
      candidateError,
      evaluatorEvidence,
      observation,
    };
    if (existingRecord !== null) {
      const priorRevision = Number.isSafeInteger(existingRecord.evidenceRecordRevision)
        ? existingRecord.evidenceRecordRevision
        : 0;
      const backupPath = path.join(
        path.dirname(caseEvidencePath),
        `${benchmarkCase.id}.evidence-record-v${priorRevision}.json`,
      );
      const backupExists = await lstat(backupPath).catch((error) => {
        if (hasCode(error, "ENOENT")) return null;
        throw error;
      });
      if (backupExists === null) await atomicWriteJson(backupPath, existingRecord);
    }
    await atomicWriteJson(caseEvidencePath, record);
    return record;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function parseArguments(argv, manifestCaseIds) {
  let mode = null;
  let selected = null;
  for (const argument of argv) {
    if (argument === "--mode=baseline" || argument === "--mode=routed") {
      mode = argument.slice("--mode=".length);
    } else if (argument.startsWith("--cases=")) {
      selected = argument
        .slice("--cases=".length)
        .split(",")
        .filter((entry) => entry.length > 0);
    } else {
      throw new Error(
        "usage: node scripts/gate2-live-benchmark.mjs --mode=baseline|routed [--cases=id,id]",
      );
    }
  }
  assertCondition(mode !== null, "--mode=baseline|routed is required");
  const caseIds = selected ?? manifestCaseIds;
  assertCondition(
    caseIds.length > 0 && new Set(caseIds).size === caseIds.length,
    "case selection is invalid",
  );
  for (const caseId of caseIds)
    assertCondition(manifestCaseIds.includes(caseId), `unknown case: ${caseId}`);
  return { mode, caseIds };
}

async function loadJson(filePath, label) {
  const bytes = await readRegularFile(filePath, label);
  return { bytes, value: parseStrictGate2Json(bytes.toString("utf8")) };
}

async function maybeWriteComparison(manifest, manifestSha256, profile) {
  const baselinePath = path.join(evidenceRoot, profile.profileDigestSha256, "baseline-result.json");
  const routedPath = path.join(evidenceRoot, profile.profileDigestSha256, "routed-result.json");
  const [baseline, routed] = await Promise.all(
    [baselinePath, routedPath].map((entry) =>
      readFile(entry, "utf8")
        .then((source) => parseStrictGate2Json(source))
        .catch((error) => {
          if (hasCode(error, "ENOENT")) return null;
          throw error;
        }),
    ),
  );
  if (baseline === null || routed === null) return null;
  const comparison = compareGate2BenchmarkResults(baseline, routed, manifest, manifestSha256);
  await atomicWriteJson(
    path.join(evidenceRoot, profile.profileDigestSha256, "comparison.json"),
    comparison,
  );
  return comparison;
}

async function main() {
  assertCondition((await realpath(root)) === root, "repository root must be canonical");
  const loaded = await loadGate2BenchmarkContract(manifestPath, root);
  const profileLoaded = await loadJson(profilePath, "Gate 2 live profile");
  const profile = profileLoaded.value;
  assertCondition(
    computeGate2ExecutionProfileDigest(profile) === profile.profileDigestSha256,
    "Gate 2 live profile digest is invalid",
  );
  const { mode, caseIds } = parseArguments(
    process.argv.slice(2),
    loaded.manifest.cases.map((entry) => entry.id),
  );
  const nativeFetch = globalThis.fetch;
  const preflightEvidence = await preflight(profile, nativeFetch);
  const allowedOrigins = new Set([VULCAN_ORIGIN, OLLAMA_ORIGIN]);
  globalThis.fetch = async (input, init) => {
    const target = new URL(input instanceof Request ? input.url : input);
    if (target.protocol !== "http:" || !allowedOrigins.has(target.origin)) {
      throw new Error(`Gate 2 live runner blocked non-loopback fetch: ${target.origin}`);
    }
    return nativeFetch(input, init);
  };
  try {
    await atomicWriteJson(path.join(evidenceRoot, profile.profileDigestSha256, "preflight.json"), {
      schemaVersion: 1,
      manifestSha256: loaded.manifestSha256,
      executionProfileDigestSha256: profile.profileDigestSha256,
      instructionPolicySha256: GATE2_LIVE_INSTRUCTION_POLICY_SHA256,
      routingPolicySha256: GATE2_LIVE_ROUTING_POLICY_SHA256,
      profileSha256: sha256(profileLoaded.bytes),
      ...preflightEvidence,
    });
    const repositories = new Map(
      loaded.manifest.repositories.map((repository) => [repository.id, repository]),
    );
    const oracles = oracleRegistry();
    const selectedSet = new Set(caseIds);
    const completed = [];
    for (const benchmarkCase of loaded.manifest.cases) {
      if (!selectedSet.has(benchmarkCase.id)) continue;
      const repository = repositories.get(benchmarkCase.repositoryId);
      assertCondition(repository !== undefined, `${benchmarkCase.id} repository is missing`);
      const oracle = oracles.get(benchmarkCase.id);
      assertCondition(
        (benchmarkCase.expectedOutcome.kind === "mutation") === (oracle !== undefined),
        `${benchmarkCase.id} evaluator registry disagrees with answer kind`,
      );
      const record = await evaluateCase({
        benchmarkCase,
        repository,
        oracle,
        mode,
        profile,
        manifestSha256: loaded.manifestSha256,
      });
      completed.push(record);
      process.stderr.write(
        `${mode} ${benchmarkCase.id}: ${record.observation.scenarioStatus}; plan=${record.observation.firstPassPlanAccepted}; model=${record.modelId}\n`,
      );
    }
    let result = null;
    let comparison = null;
    if (caseIds.length === loaded.manifest.cases.length) {
      const records = [];
      for (const benchmarkCase of loaded.manifest.cases) {
        const casePath = path.join(
          evidenceRoot,
          profile.profileDigestSha256,
          mode,
          `${benchmarkCase.id}.json`,
        );
        records.push(parseStrictGate2Json(await readFile(casePath, "utf8")));
      }
      const observations = records.map((record) => record.observation);
      result = {
        schemaVersion: 1,
        benchmarkId: loaded.manifest.benchmarkId,
        benchmarkRevision: loaded.manifest.benchmarkRevision,
        manifestSha256: loaded.manifestSha256,
        mode,
        executionProfile: profile,
        observations,
        aggregates: computeGate2BenchmarkAggregates(observations, loaded.manifest, profile),
        limitations: GATE2_RESULT_LIMITATIONS,
      };
      validateGate2BenchmarkResult(result, loaded.manifest, loaded.manifestSha256);
      await atomicWriteJson(
        path.join(evidenceRoot, profile.profileDigestSha256, `${mode}-result.json`),
        result,
      );
      comparison = await maybeWriteComparison(loaded.manifest, loaded.manifestSha256, profile);
    }
    process.stdout.write(
      `${JSON.stringify(
        {
          mode,
          requestedCases: caseIds.length,
          executedOrReusedCases: completed.length,
          profileDigestSha256: profile.profileDigestSha256,
          evidenceDirectory: path.join(evidenceRoot, profile.profileDigestSha256),
          aggregates: result?.aggregates ?? null,
          comparison,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    globalThis.fetch = nativeFetch;
  }
}

// Run only as a CLI. Importing this module for its exported helpers must not execute
// a benchmark run -- the same guard scripts/gate2-live-evidence-publish.mjs uses.
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === scriptPath) {
  await main().catch((error) => {
    process.stderr.write(
      `Gate 2 live benchmark failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
