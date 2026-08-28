import { createHash } from "node:crypto";

import {
  parseStrictGate2Json,
  validateGate2BenchmarkManifest,
} from "./gate2-benchmark-contract.mjs";

const RESULT_KEYS = Object.freeze([
  "schemaVersion",
  "benchmarkId",
  "benchmarkRevision",
  "manifestSha256",
  "cohortClass",
  "evaluatorRevision",
  "generatedAt",
  "passed",
  "counts",
  "retrievalAggregate",
  "planAggregate",
  "effects",
  "effectEvidence",
  "observations",
  "limitations",
  "assessment",
]);
const COUNT_KEYS = Object.freeze([
  "manifestCases",
  "cohortCases",
  "executedCases",
  "passedCases",
  "failedCases",
  "unexecutedCases",
]);
const RETRIEVAL_KEYS = Object.freeze(["macroRecall", "macroPrecision", "digestProvenanceCoverage"]);
const PLAN_AGGREGATE_KEYS = Object.freeze([
  "firstPassAcceptedCases",
  "firstPassAcceptanceRate",
  "autonomousTargetDiscoveryMeasured",
  "targetAuthority",
]);
const EFFECT_KEYS = Object.freeze([
  "providerCalls",
  "loopbackProviderRequests",
  "externalNetworkRequests",
  "remoteMutations",
  "sourceCheckoutMutations",
  "privateWorkspaceMutations",
  "sandboxCheckExecutions",
  "icarusRegisteredCheckExecutions",
  "liveDatabaseConnections",
  "offlineInMemoryDatabaseChecks",
  "temporaryGitFixtureSetup",
  "runtimeReopens",
]);
const OBSERVATION_KEYS = Object.freeze([
  "caseId",
  "repositoryId",
  "scenarioEvaluatorId",
  "repositoryRevisionSha256",
  "taskSha256",
  "baseCommit",
  "treeSha1",
  "retrievalDigestSha256",
  "repositoryDigestSha256",
  "provider",
  "selectedContext",
  "retrievalMetrics",
  "targetAuthority",
  "plan",
  "baseline",
  "mutation",
  "usage",
  "sourceCheckoutUnchanged",
  "sourceGitDirectoryUnchanged",
  "durableRunRecovered",
  "scenarioEvidenceSha256",
]);
const PROVIDER_KEYS = Object.freeze([
  "kind",
  "model",
  "adapterVersion",
  "transport",
  "instructionDigests",
  "loopbackRequests",
  "requestDigests",
]);
const CONTEXT_KEYS = Object.freeze(["path", "sha256"]);
const RETRIEVAL_METRIC_KEYS = Object.freeze(["recall", "precision", "digestProvenanceCoverage"]);
const PLAN_KEYS = Object.freeze([
  "firstPassAccepted",
  "operatorSelectedTargets",
  "approvedTargets",
  "checkIds",
  "planSha256",
  "autonomousTargetDiscoveryMeasured",
]);
const BASELINE_KEYS = Object.freeze(["outcome", "checks"]);
const MUTATION_KEYS = Object.freeze([
  "runId",
  "state",
  "patchSetSha256",
  "diffSha256",
  "checkpointSha256",
  "changedPaths",
  "checks",
  "finalFiles",
  "privateWorkspaceMutated",
]);
const CHECK_KEYS = Object.freeze([
  "checkId",
  "argv",
  "exitCode",
  "signal",
  "stdoutBytes",
  "stdoutSha256",
  "stderrBytes",
  "stderrSha256",
  "truncated",
  "outcome",
]);
const FINAL_FILE_KEYS = Object.freeze(["path", "sha256"]);
const USAGE_KEYS = Object.freeze([
  "toolCalls",
  "inputTokens",
  "outputTokens",
  "estimatedCostUsd",
  "reservedCostUsd",
]);
const TARGET_AUTHORITY = "operator_selected_expected_changed_paths";
const HEX_40 = /^[0-9a-f]{40}$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_CONTEXT_FILES_PER_CASE = 8;

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value)) deepFreeze(entry);
  }
  return value;
}

export const GATE2_REPAIR_B_PROVIDER = deepFreeze({
  kind: "ollama",
  model: "icarus-gate2-deterministic-repair-fixture",
  adapterVersion: "production-ollama-plan-patchset-v1",
  transport: "loopback-http",
  instructionDigests: [
    "eecd9bcebee8bbdea74b6d2eee555bc599532c4e5f315e0506d767af155f6a8a",
    "1b1d68633c2af6fe5b7de4a2ae20327662cd3637d398ac5fe89e4b197ca491e9",
  ],
});

export const GATE2_REPAIR_B_COHORT_LIMITATIONS = Object.freeze([
  "deterministic-loopback-responses-measure-contract-integration-not-live-model-repair-quality",
  "four-repair-cases-do-not-complete-thirty-task-gate2-benchmark",
  "operator-selected-target-authority-does-not-measure-autonomous-target-discovery",
  "exact-byte-oracles-measure-these-scenarios-not-general-repair-correctness",
  "this-cohort-excludes-the-protected-schema-migration-repair",
  "evidence-digests-prove-self-consistency-not-runner-authenticity",
  "partial-cohort-accounting-cannot-be-added-as-a-full-suite-result",
]);

const publicPathContainmentCheck = [
  "import tempfile",
  "from pathlib import Path",
  "from src.files import read_public",
  "temporary=tempfile.TemporaryDirectory()",
  "base=Path(temporary.name)",
  'public=base/"public"',
  "public.mkdir()",
  '(public/"hello.txt").write_text("hello",encoding="utf8")',
  '(base/"secret.txt").write_text("secret",encoding="utf8")',
  'assert read_public(public,"hello.txt")=="hello"',
  'exec(\'for candidate in ("../secret.txt",str(base/"secret.txt")):\\n try:\\n  read_public(public,candidate)\\n except ValueError:\\n  pass\\n else:\\n  raise AssertionError("containment bypass")\')',
  "temporary.cleanup()",
].join("; ");

export const GATE2_REPAIR_B_ORACLES = deepFreeze([
  {
    caseId: "repair-basic-greeting",
    scenarioEvaluatorId: "repair-basic-greeting-evaluator",
    baselineOutcome: "failed",
    inputTokens: 150,
    outputTokens: 80,
    check: {
      id: "basic-greeting",
      name: "One-line greeting",
      argv: ["python", "checks/verify.py"],
    },
    approvedFiles: [
      {
        op: "modify",
        path: "src/greeting.txt",
        sha256: "f0853d03e87f2ceb778126a028fe213cddd8381ac9b9378615ec49796958f721",
        content: "Hello, Icarus!\n",
      },
    ],
  },
  {
    caseId: "repair-cart-off-by-one",
    scenarioEvaluatorId: "repair-cart-off-by-one-evaluator",
    baselineOutcome: "failed",
    inputTokens: 150,
    outputTokens: 80,
    check: {
      id: "cart-subtotal",
      name: "Cart subtotal",
      argv: ["python", "checks/verify.py"],
    },
    approvedFiles: [
      {
        op: "modify",
        path: "src/cart.py",
        sha256: "d8d7afc8d75979072695ea76715abaf84faf7cd8b62db50f5f17fce21b59fdae",
        content:
          'def subtotal(cents: list[int]) -> int:\n    """Return the cart subtotal in cents."""\n    return sum(cents)\n',
      },
    ],
  },
  {
    caseId: "repair-parser-false",
    scenarioEvaluatorId: "repair-parser-false-evaluator",
    baselineOutcome: "failed",
    inputTokens: 150,
    outputTokens: 80,
    check: {
      id: "parser-explicit-false",
      name: "Explicit boolean parser",
      argv: ["python", "checks/verify.py"],
    },
    approvedFiles: [
      {
        op: "modify",
        path: "src/parser.py",
        sha256: "29940d4546fa5e393e1ff249e37e9745da65ad753a1f1d347d52a826d389d29a",
        content:
          'def parse_enabled(value: str) -> bool:\n    normalized = value.strip().lower()\n    if normalized == "true":\n        return True\n    if normalized == "false":\n        return False\n    raise ValueError(f"unsupported boolean value: {value}")\n',
      },
    ],
  },
  {
    caseId: "repair-public-path-containment",
    scenarioEvaluatorId: "repair-public-path-containment-evaluator",
    baselineOutcome: "failed",
    inputTokens: 150,
    outputTokens: 80,
    check: {
      id: "public-path-containment",
      name: "Public path containment",
      argv: ["python", "-c", publicPathContainmentCheck],
    },
    approvedFiles: [
      {
        op: "modify",
        path: "src/files.py",
        sha256: "453e2c34ac26b8a2f09e685c8d6e9b116b7b4142f07462d23b657c35b911ef15",
        content:
          'from pathlib import Path\n\n\ndef read_public(root: Path, user_path: str) -> str:\n    requested = Path(user_path)\n    if requested.is_absolute():\n        raise ValueError("public path must be relative")\n    public_root = root.resolve()\n    candidate = (public_root / requested).resolve()\n    try:\n        candidate.relative_to(public_root)\n    except ValueError:\n        raise ValueError("public path escapes root") from None\n    return candidate.read_text(encoding="utf8")\n',
      },
    ],
  },
]);

function fail(message) {
  throw new Error(`Gate 2 repair cohort B: ${message}`);
}

function exactRecord(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string")
  ) {
    fail(`${label} must be a plain string-keyed record`);
  }
  if (JSON.stringify(Object.keys(value)) !== JSON.stringify(keys)) {
    fail(`${label} must contain exactly: ${keys.join(", ")}`);
  }
  return value;
}

function exactArray(value, length, label) {
  if (!Array.isArray(value) || value.length !== length) {
    fail(`${label} must contain exactly ${length} entries`);
  }
  return value;
}

function literal(value, expected, label) {
  if (value !== expected) fail(`${label} must equal ${JSON.stringify(expected)}`);
  return value;
}

function digest(value, label) {
  if (typeof value !== "string" || !HEX_64.test(value)) fail(`${label} must be SHA-256`);
  return value;
}

function safePath(value, label) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 240 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    fail(`${label} must be a repository-relative POSIX path`);
  }
  return value;
}

function nonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} must be a nonnegative integer`);
  return value;
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function computeGate2RepairBEvidenceDigest(observationInput) {
  if (
    observationInput === null ||
    typeof observationInput !== "object" ||
    Array.isArray(observationInput)
  ) {
    fail("observation evidence must be an object");
  }
  const { scenarioEvidenceSha256: _evidence, ...unsigned } = observationInput;
  return sha256(stableJson(unsigned));
}

function validateCheck(value, expected, expectedOutcome, label) {
  const check = exactRecord(value, CHECK_KEYS, label);
  literal(check.checkId, expected.id, `${label}.checkId`);
  literal(JSON.stringify(check.argv), JSON.stringify(expected.argv), `${label}.argv`);
  if (expectedOutcome === "passed") {
    literal(check.exitCode, 0, `${label}.exitCode`);
  } else if (!Number.isSafeInteger(check.exitCode) || check.exitCode === 0) {
    fail(`${label}.exitCode must show failure`);
  }
  literal(check.signal, null, `${label}.signal`);
  nonnegativeInteger(check.stdoutBytes, `${label}.stdoutBytes`);
  digest(check.stdoutSha256, `${label}.stdoutSha256`);
  nonnegativeInteger(check.stderrBytes, `${label}.stderrBytes`);
  digest(check.stderrSha256, `${label}.stderrSha256`);
  literal(check.truncated, false, `${label}.truncated`);
  literal(check.outcome, expectedOutcome, `${label}.outcome`);
}

function validateOracle(oracle, benchmarkCase, repository, label) {
  literal(oracle.scenarioEvaluatorId, benchmarkCase.expectedOutcome.scenarioEvaluatorId, label);
  const expectedPaths = benchmarkCase.expectedOutcome.expectedChangedPaths;
  literal(
    JSON.stringify(oracle.approvedFiles.map((file) => file.path)),
    JSON.stringify(expectedPaths),
    `${label}.approved paths`,
  );
  const sourceDigests = new Map(repository.files.map((file) => [file.path, file.sha256]));
  for (const [index, file] of oracle.approvedFiles.entries()) {
    safePath(file.path, `${label}.approvedFiles[${index}].path`);
    literal(sha256(file.content), file.sha256, `${label}.approvedFiles[${index}].sha256`);
    literal(file.op, "modify", `${label}.approvedFiles[${index}].op`);
    if (!sourceDigests.has(file.path)) fail(`${label} modifies an absent path`);
  }
}

export function validateGate2RepairBCohortResult(value, manifestInput, manifestSha256) {
  const manifest = validateGate2BenchmarkManifest(manifestInput);
  const result = exactRecord(value, RESULT_KEYS, "result");
  literal(result.schemaVersion, 1, "schemaVersion");
  literal(result.benchmarkId, manifest.benchmarkId, "benchmarkId");
  literal(result.benchmarkRevision, manifest.benchmarkRevision, "benchmarkRevision");
  literal(result.manifestSha256, digest(manifestSha256, "manifest digest"), "manifestSha256");
  literal(result.cohortClass, "repair", "cohortClass");
  literal(result.evaluatorRevision, "deterministic-production-lifecycle-v1", "evaluatorRevision");
  if (
    typeof result.generatedAt !== "string" ||
    Number.isNaN(Date.parse(result.generatedAt)) ||
    new Date(result.generatedAt).toISOString() !== result.generatedAt
  ) {
    fail("generatedAt must be a canonical ISO timestamp");
  }
  literal(result.passed, true, "passed");

  const repairCaseIds = new Set(GATE2_REPAIR_B_ORACLES.map((entry) => entry.caseId));
  const repairCases = manifest.cases.filter((entry) => repairCaseIds.has(entry.id));
  literal(
    JSON.stringify(repairCases.map((entry) => entry.id)),
    JSON.stringify(GATE2_REPAIR_B_ORACLES.map((entry) => entry.caseId)),
    "manifest repair cohort B",
  );
  const cohortCases = repairCases.length;
  const counts = exactRecord(result.counts, COUNT_KEYS, "counts");
  const expectedCounts = [
    manifest.cases.length,
    cohortCases,
    cohortCases,
    cohortCases,
    0,
    manifest.cases.length - cohortCases,
  ];
  for (const [index, key] of COUNT_KEYS.entries()) {
    literal(counts[key], expectedCounts[index], `counts.${key}`);
  }

  const retrievalAggregate = exactRecord(
    result.retrievalAggregate,
    RETRIEVAL_KEYS,
    "retrievalAggregate",
  );
  const planAggregate = exactRecord(result.planAggregate, PLAN_AGGREGATE_KEYS, "planAggregate");
  literal(
    planAggregate.firstPassAcceptedCases,
    cohortCases,
    "planAggregate.firstPassAcceptedCases",
  );
  literal(planAggregate.firstPassAcceptanceRate, 1, "planAggregate.firstPassAcceptanceRate");
  literal(
    planAggregate.autonomousTargetDiscoveryMeasured,
    false,
    "planAggregate.autonomousTargetDiscoveryMeasured",
  );
  literal(planAggregate.targetAuthority, TARGET_AUTHORITY, "planAggregate.targetAuthority");

  const effects = exactRecord(result.effects, EFFECT_KEYS, "effects");
  const expectedEffects = [8, 8, 0, 0, 0, 4, 8, 4, 0, 0, true, 4];
  for (const [index, key] of EFFECT_KEYS.entries()) {
    literal(effects[key], expectedEffects[index], `effects.${key}`);
  }
  const effectEvidence = exactRecord(result.effectEvidence, EFFECT_KEYS, "effectEvidence");
  const expectedEvidence = [
    "observed",
    "observed",
    "design-assertion",
    "design-assertion",
    "observed",
    "observed",
    "observed",
    "observed",
    "design-assertion",
    "design-assertion",
    "observed",
    "observed",
  ];
  for (const [index, key] of EFFECT_KEYS.entries()) {
    literal(effectEvidence[key], expectedEvidence[index], `effectEvidence.${key}`);
  }

  const repositories = new Map(manifest.repositories.map((entry) => [entry.id, entry]));
  const observations = exactArray(result.observations, cohortCases, "observations");
  const recalls = [];
  const precisions = [];
  for (const [index, observationValue] of observations.entries()) {
    const benchmarkCase = repairCases[index];
    const oracle = GATE2_REPAIR_B_ORACLES[index];
    if (benchmarkCase === undefined || oracle === undefined) fail("repair cohort B index missing");
    const repository = repositories.get(benchmarkCase.repositoryId);
    if (repository === undefined) fail(`repository missing for ${benchmarkCase.id}`);
    validateOracle(oracle, benchmarkCase, repository, `oracle[${index}]`);

    const observation = exactRecord(observationValue, OBSERVATION_KEYS, `observations[${index}]`);
    literal(observation.caseId, benchmarkCase.id, `observations[${index}].caseId`);
    literal(
      observation.repositoryId,
      benchmarkCase.repositoryId,
      `observations[${index}].repositoryId`,
    );
    literal(
      observation.scenarioEvaluatorId,
      oracle.scenarioEvaluatorId,
      `observations[${index}].scenarioEvaluatorId`,
    );
    literal(
      observation.repositoryRevisionSha256,
      repository.revisionSha256,
      `observations[${index}].repositoryRevisionSha256`,
    );
    literal(observation.taskSha256, benchmarkCase.task.sha256, `observations[${index}].taskSha256`);
    if (!HEX_40.test(observation.baseCommit) || !HEX_40.test(observation.treeSha1)) {
      fail(`observations[${index}] Git identities must be SHA-1`);
    }
    digest(observation.retrievalDigestSha256, `observations[${index}].retrievalDigestSha256`);
    digest(observation.repositoryDigestSha256, `observations[${index}].repositoryDigestSha256`);

    const provider = exactRecord(
      observation.provider,
      PROVIDER_KEYS,
      `observations[${index}].provider`,
    );
    for (const key of ["kind", "model", "adapterVersion", "transport"]) {
      literal(
        provider[key],
        GATE2_REPAIR_B_PROVIDER[key],
        `observations[${index}].provider.${key}`,
      );
    }
    literal(
      JSON.stringify(provider.instructionDigests),
      JSON.stringify(GATE2_REPAIR_B_PROVIDER.instructionDigests),
      `observations[${index}].provider.instructionDigests`,
    );
    literal(provider.loopbackRequests, 2, `observations[${index}].provider.loopbackRequests`);
    const requestDigests = exactArray(
      provider.requestDigests,
      2,
      `observations[${index}].provider.requestDigests`,
    );
    for (const [requestIndex, entry] of requestDigests.entries()) {
      digest(entry, `observations[${index}].provider.requestDigests[${requestIndex}]`);
    }

    const digestByPath = new Map(repository.files.map((entry) => [entry.path, entry.sha256]));
    if (
      !Array.isArray(observation.selectedContext) ||
      observation.selectedContext.length < benchmarkCase.expectedContextPaths.length ||
      observation.selectedContext.length > MAX_CONTEXT_FILES_PER_CASE
    ) {
      fail(`observations[${index}].selectedContext has invalid cardinality`);
    }
    const selectedPaths = new Set();
    for (const [contextIndex, contextValue] of observation.selectedContext.entries()) {
      const context = exactRecord(
        contextValue,
        CONTEXT_KEYS,
        `observations[${index}].selectedContext[${contextIndex}]`,
      );
      const contextPath = safePath(
        context.path,
        `observations[${index}].selectedContext[${contextIndex}].path`,
      );
      if (selectedPaths.has(contextPath)) fail(`observations[${index}] repeats context path`);
      literal(
        context.sha256,
        digestByPath.get(contextPath),
        `observations[${index}].selectedContext[${contextIndex}].sha256`,
      );
      selectedPaths.add(contextPath);
    }
    const matched = benchmarkCase.expectedContextPaths.filter((entry) => selectedPaths.has(entry));
    const expectedRecall = matched.length / benchmarkCase.expectedContextPaths.length;
    const expectedPrecision = matched.length / observation.selectedContext.length;
    const metrics = exactRecord(
      observation.retrievalMetrics,
      RETRIEVAL_METRIC_KEYS,
      `observations[${index}].retrievalMetrics`,
    );
    literal(metrics.recall, expectedRecall, `observations[${index}].retrievalMetrics.recall`);
    literal(
      metrics.precision,
      expectedPrecision,
      `observations[${index}].retrievalMetrics.precision`,
    );
    literal(
      metrics.digestProvenanceCoverage,
      1,
      `observations[${index}].retrievalMetrics.digestProvenanceCoverage`,
    );
    if (expectedRecall !== 1) fail(`observations[${index}] omitted expected context`);
    recalls.push(expectedRecall);
    precisions.push(expectedPrecision);

    literal(
      observation.targetAuthority,
      TARGET_AUTHORITY,
      `observations[${index}].targetAuthority`,
    );
    const plan = exactRecord(observation.plan, PLAN_KEYS, `observations[${index}].plan`);
    literal(plan.firstPassAccepted, true, `observations[${index}].plan.firstPassAccepted`);
    const expectedChangedPaths = benchmarkCase.expectedOutcome.expectedChangedPaths;
    const expectedOperatorTargets = [...expectedChangedPaths].sort((left, right) =>
      left.localeCompare(right),
    );
    literal(
      JSON.stringify(plan.operatorSelectedTargets),
      JSON.stringify(expectedOperatorTargets),
      `observations[${index}].plan.operatorSelectedTargets`,
    );
    literal(
      JSON.stringify(plan.approvedTargets),
      JSON.stringify(expectedChangedPaths),
      `observations[${index}].plan.approvedTargets`,
    );
    literal(
      JSON.stringify(plan.checkIds),
      JSON.stringify([oracle.check.id]),
      `observations[${index}].plan.checkIds`,
    );
    digest(plan.planSha256, `observations[${index}].plan.planSha256`);
    literal(
      plan.autonomousTargetDiscoveryMeasured,
      false,
      `observations[${index}].plan.autonomousTargetDiscoveryMeasured`,
    );

    const baseline = exactRecord(
      observation.baseline,
      BASELINE_KEYS,
      `observations[${index}].baseline`,
    );
    literal(baseline.outcome, oracle.baselineOutcome, `observations[${index}].baseline.outcome`);
    const baselineChecks = exactArray(baseline.checks, 1, `observations[${index}].baseline.checks`);
    validateCheck(
      baselineChecks[0],
      oracle.check,
      oracle.baselineOutcome,
      `observations[${index}].baseline.checks[0]`,
    );

    const mutation = exactRecord(
      observation.mutation,
      MUTATION_KEYS,
      `observations[${index}].mutation`,
    );
    if (typeof mutation.runId !== "string" || !UUID.test(mutation.runId)) {
      fail(`observations[${index}].mutation.runId must be UUID`);
    }
    literal(mutation.state, "completed", `observations[${index}].mutation.state`);
    for (const key of ["patchSetSha256", "diffSha256", "checkpointSha256"]) {
      digest(mutation[key], `observations[${index}].mutation.${key}`);
    }
    literal(
      JSON.stringify(mutation.changedPaths),
      JSON.stringify(expectedChangedPaths),
      `observations[${index}].mutation.changedPaths`,
    );
    const mutationChecks = exactArray(mutation.checks, 1, `observations[${index}].mutation.checks`);
    validateCheck(
      mutationChecks[0],
      oracle.check,
      "passed",
      `observations[${index}].mutation.checks[0]`,
    );
    const finalFiles = exactArray(
      mutation.finalFiles,
      oracle.approvedFiles.length,
      `observations[${index}].mutation.finalFiles`,
    );
    for (const [fileIndex, fileValue] of finalFiles.entries()) {
      const file = exactRecord(
        fileValue,
        FINAL_FILE_KEYS,
        `observations[${index}].mutation.finalFiles[${fileIndex}]`,
      );
      literal(file.path, oracle.approvedFiles[fileIndex]?.path, `finalFiles[${fileIndex}].path`);
      literal(
        file.sha256,
        oracle.approvedFiles[fileIndex]?.sha256,
        `finalFiles[${fileIndex}].sha256`,
      );
    }
    literal(
      mutation.privateWorkspaceMutated,
      true,
      `observations[${index}].mutation.privateWorkspaceMutated`,
    );

    const usage = exactRecord(observation.usage, USAGE_KEYS, `observations[${index}].usage`);
    nonnegativeInteger(usage.toolCalls, `observations[${index}].usage.toolCalls`);
    if (usage.toolCalls < 1 || usage.toolCalls > 40) {
      fail(`observations[${index}].usage.toolCalls exceeds the production ceiling`);
    }
    literal(usage.inputTokens, oracle.inputTokens, `observations[${index}].usage.inputTokens`);
    literal(usage.outputTokens, oracle.outputTokens, `observations[${index}].usage.outputTokens`);
    literal(usage.estimatedCostUsd, 0, `observations[${index}].usage.estimatedCostUsd`);
    literal(usage.reservedCostUsd, 0, `observations[${index}].usage.reservedCostUsd`);
    literal(
      observation.sourceCheckoutUnchanged,
      true,
      `observations[${index}].sourceCheckoutUnchanged`,
    );
    literal(
      observation.sourceGitDirectoryUnchanged,
      true,
      `observations[${index}].sourceGitDirectoryUnchanged`,
    );
    literal(observation.durableRunRecovered, true, `observations[${index}].durableRunRecovered`);
    literal(
      observation.scenarioEvidenceSha256,
      computeGate2RepairBEvidenceDigest(observation),
      `observations[${index}].scenarioEvidenceSha256`,
    );
  }

  const macroRecall = recalls.reduce((sum, entry) => sum + entry, 0) / recalls.length;
  const macroPrecision = precisions.reduce((sum, entry) => sum + entry, 0) / precisions.length;
  literal(retrievalAggregate.macroRecall, macroRecall, "retrievalAggregate.macroRecall");
  literal(retrievalAggregate.macroPrecision, macroPrecision, "retrievalAggregate.macroPrecision");
  literal(
    retrievalAggregate.digestProvenanceCoverage,
    1,
    "retrievalAggregate.digestProvenanceCoverage",
  );
  if (
    macroRecall < manifest.thresholds.minimumMacroRetrievalRecall ||
    macroPrecision < manifest.thresholds.minimumMacroRetrievalPrecision ||
    planAggregate.firstPassAcceptanceRate < manifest.thresholds.minimumFirstPassPlanAcceptance
  ) {
    fail("repair cohort B does not satisfy manifest retrieval or plan thresholds");
  }
  literal(
    JSON.stringify(result.limitations),
    JSON.stringify(GATE2_REPAIR_B_COHORT_LIMITATIONS),
    "limitations",
  );
  literal(result.assessment, "deterministic_repair_cohort_b_passed_gate2_incomplete", "assessment");
  return value;
}

export function parseAndValidateGate2RepairBCohortResult(source, manifest, manifestSha256) {
  return validateGate2RepairBCohortResult(parseStrictGate2Json(source), manifest, manifestSha256);
}
