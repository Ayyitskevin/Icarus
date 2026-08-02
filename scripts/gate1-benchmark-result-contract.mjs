import {
  GATE1_REQUIRED_STACKS,
  validateGate1BenchmarkManifest,
} from "./gate1-benchmark-contract.mjs";

export const GATE1_OFFLINE_REPORT_LIMITATIONS = Object.freeze([
  "Deterministic loopback model responses are not live model evidence.",
  "The React/Node case is a dependency-free JSX contract plus Node behavior fixture, not runnable React-application evidence.",
  "No browser same-tab reload or foreground-server process restart was executed; the benchmark reopens the production runtime and replays a harness-only recovery journal into the local controller.",
  "No operator repository-automation assessment was performed; a separately approved live profile must bind that evidence.",
  "No GitHub object, branch, draft pull request, or receipt effect was attempted.",
  "Credential-gated real-repository evidence remains required for Gate 1.",
  "The durable landing coordinator, GitHub gateway, and receipt runtime remain unimplemented.",
]);

export const GATE1_FAILURE_REPORT_LIMITATION =
  "The failed case's incomplete effects are unavailable; counters include completed cases only.";

const SUCCESS_REPORT_KEYS = Object.freeze([
  "schemaVersion",
  "benchmarkId",
  "benchmarkRevision",
  "manifestSha256",
  "assessment",
  "counts",
  "effects",
  "cases",
  "limitations",
]);
const FAILURE_REPORT_KEYS = Object.freeze([...SUCCESS_REPORT_KEYS, "failure"]);
const COUNTS_KEYS = Object.freeze(["contractPassed", "failed", "liveEvidenceNotRun"]);
const EFFECT_KEYS = Object.freeze([
  "paidProviderCalls",
  "credentialReads",
  "externalNetworkRequests",
  "remoteMutations",
  "loopbackHttpRequests",
  "gatewayInstances",
  "localRefWrites",
]);
const FAILURE_EFFECT_KEYS = Object.freeze(["status", ...EFFECT_KEYS]);
const CASE_KEYS = Object.freeze([
  "id",
  "stack",
  "assessment",
  "source",
  "taskSha256",
  "baselineChecks",
  "repair",
  "candidate",
  "draftPullRequest",
  "receipt",
  "effects",
]);
const SOURCE_KEYS = Object.freeze([
  "commitSha1",
  "treeSha1",
  "treeSha256",
  "unchanged",
  "gitFingerprintFields",
  "completeGitDirectorySnapshotUnchanged",
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
const REPAIR_KEYS = Object.freeze([
  "runId",
  "state",
  "planSha256",
  "diffSha256",
  "checkpointSha256",
  "changedPaths",
  "checks",
  "provider",
]);
const PROVIDER_KEYS = Object.freeze([
  "adapterVersion",
  "model",
  "loopbackRequests",
  "instructionDigests",
  "requestDigests",
]);
const CANDIDATE_KEYS = Object.freeze([
  "objectFormat",
  "baseCommitSha1",
  "baseTreeSha1",
  "candidateTreeSha1",
  "candidateCommitSha1",
  "candidateCommitPayloadSha256",
  "candidateObjectManifestSha256",
  "diffByteEqual",
  "headRef",
  "localRefOutcome",
  "updateRefExitCode",
  "recoveredAfter",
  "productionRuntimeReopened",
  "durableRunRecovered",
  "recoveryJournal",
  "duplicateReplayCode",
  "localRefWrites",
]);
const DRAFT_KEYS = Object.freeze(["status", "contractSchemaVersion", "remoteMutationPerformed"]);
const RECEIPT_KEYS = Object.freeze(["status", "schemaVersion", "runtimeRequiredForGate"]);
const FAILURE_KEYS = Object.freeze(["stage", "caseId", "code", "messageSha256"]);

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const RUN_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/u;

function fail(message) {
  throw new Error(`Gate 1 benchmark report ${message}`);
}

function assertDataRecord(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(`${label} must be a plain object`);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) {
    fail(`${label} must not contain symbol keys`);
  }
  for (const key of ownKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      fail(`${label} must contain only enumerable data properties`);
    }
  }
  return value;
}

function assertPlainRecord(value, label, expectedKeys) {
  const record = assertDataRecord(value, label);
  const ownKeys = Reflect.ownKeys(record);
  const actual = ownKeys.map(String).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} must contain exactly: ${expectedKeys.join(", ")}`);
  }
  return record;
}

function assertArray(value, label, length) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail(`${label} must be an array`);
  }
  if (value.length !== length) fail(`${label} must contain exactly ${length} entries`);
  const keys = Object.keys(value);
  const ownKeys = Reflect.ownKeys(value);
  if (
    keys.length !== value.length ||
    keys.some((key, index) => key !== String(index)) ||
    ownKeys.length !== value.length + 1 ||
    ownKeys.some((key) => typeof key !== "string" || (key !== "length" && !/^\d+$/u.test(key)))
  ) {
    fail(`${label} must be a dense JSON array without extra properties`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      fail(`${label} must contain only enumerable data entries`);
    }
  }
  return value;
}

function assertLiteral(value, expected, label) {
  if (!Object.is(value, expected)) fail(`${label} must equal ${JSON.stringify(expected)}`);
}

function assertInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || Object.is(value, -0) || value < minimum || value > maximum) {
    fail(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
}

function assertSha256(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    fail(`${label} must be a lowercase SHA-256`);
  }
}

function assertExactArray(value, expected, label) {
  const array = assertArray(value, label, expected.length);
  for (let index = 0; index < expected.length; index += 1) {
    assertLiteral(array[index], expected[index], `${label}[${index}]`);
  }
}

function validateEffects(value, expected, label, failure) {
  const effects = assertPlainRecord(value, label, failure ? FAILURE_EFFECT_KEYS : EFFECT_KEYS);
  if (failure) assertLiteral(effects.status, "partial_completed_cases_only", `${label}.status`);
  for (const key of EFFECT_KEYS) {
    assertLiteral(effects[key], expected[key], `${label}.${key}`);
  }
}

function validateCheck(value, expectedCheck, expectedOutcome, maximumOutputBytes, label) {
  const check = assertPlainRecord(value, label, CHECK_KEYS);
  assertLiteral(check.checkId, expectedCheck.id, `${label}.checkId`);
  assertExactArray(check.argv, expectedCheck.argv, `${label}.argv`);
  assertLiteral(check.signal, null, `${label}.signal`);
  assertLiteral(check.truncated, false, `${label}.truncated`);
  assertInteger(check.stdoutBytes, `${label}.stdoutBytes`, 0, maximumOutputBytes);
  assertInteger(check.stderrBytes, `${label}.stderrBytes`, 0, maximumOutputBytes);
  assertSha256(check.stdoutSha256, `${label}.stdoutSha256`);
  assertSha256(check.stderrSha256, `${label}.stderrSha256`);
  if (expectedOutcome === null) {
    if (check.outcome !== "passed" && check.outcome !== "failed") {
      fail(`${label}.outcome must be passed or failed`);
    }
  } else {
    assertLiteral(check.outcome, expectedOutcome, `${label}.outcome`);
  }
  if (check.outcome === "passed") {
    assertLiteral(check.exitCode, 0, `${label}.exitCode`);
  } else {
    assertInteger(check.exitCode, `${label}.exitCode`, 1, 255);
  }
}

function expectedCaseEffects(benchmarkCase) {
  return {
    paidProviderCalls: 0,
    credentialReads: benchmarkCase.restartRecovery.expectedCredentialReads,
    externalNetworkRequests: benchmarkCase.restartRecovery.expectedExternalNetworkRequests,
    remoteMutations: benchmarkCase.restartRecovery.expectedRemoteMutations,
    loopbackHttpRequests: benchmarkCase.modelAdapter.expectedRequests,
    gatewayInstances: benchmarkCase.modelAdapter.expectedRequests,
    localRefWrites: benchmarkCase.restartRecovery.expectedLocalRefWrites,
  };
}

function addEffects(total, addition) {
  for (const key of EFFECT_KEYS) total[key] += addition[key];
}

function expectedAggregateEffects(cases) {
  const effects = Object.fromEntries(EFFECT_KEYS.map((key) => [key, 0]));
  for (const benchmarkCase of cases) addEffects(effects, expectedCaseEffects(benchmarkCase));
  return effects;
}

function validateCaseResult(value, benchmarkCase, label) {
  const result = assertPlainRecord(value, label, CASE_KEYS);
  assertLiteral(result.id, benchmarkCase.id, `${label}.id`);
  assertLiteral(result.stack, benchmarkCase.stack, `${label}.stack`);
  assertLiteral(
    result.assessment,
    "contract_passed_gate1_live_evidence_not_run",
    `${label}.assessment`,
  );

  const source = assertPlainRecord(result.source, `${label}.source`, SOURCE_KEYS);
  assertLiteral(
    source.commitSha1,
    benchmarkCase.repository.sourceRevision.commitSha1,
    `${label}.source.commitSha1`,
  );
  assertLiteral(
    source.treeSha1,
    benchmarkCase.repository.sourceRevision.treeSha1,
    `${label}.source.treeSha1`,
  );
  assertLiteral(
    source.treeSha256,
    benchmarkCase.repository.treeSha256,
    `${label}.source.treeSha256`,
  );
  assertLiteral(source.unchanged, true, `${label}.source.unchanged`);
  assertExactArray(
    source.gitFingerprintFields,
    benchmarkCase.sourceImmutability.gitFingerprintFields,
    `${label}.source.gitFingerprintFields`,
  );
  assertLiteral(
    source.completeGitDirectorySnapshotUnchanged,
    true,
    `${label}.source.completeGitDirectorySnapshotUnchanged`,
  );
  assertLiteral(result.taskSha256, benchmarkCase.task.sha256, `${label}.taskSha256`);

  const baselineChecks = assertArray(
    result.baselineChecks,
    `${label}.baselineChecks`,
    benchmarkCase.checks.length,
  );
  for (let index = 0; index < baselineChecks.length; index += 1) {
    validateCheck(
      baselineChecks[index],
      benchmarkCase.checks[index],
      null,
      benchmarkCase.budgets.maxCommandOutputBytes,
      `${label}.baselineChecks[${index}]`,
    );
  }
  if (!baselineChecks.some((check) => check.outcome === "failed")) {
    fail(`${label}.baselineChecks must reproduce at least one failure`);
  }

  const repair = assertPlainRecord(result.repair, `${label}.repair`, REPAIR_KEYS);
  if (typeof repair.runId !== "string" || !RUN_ID_PATTERN.test(repair.runId)) {
    fail(`${label}.repair.runId must be a canonical UUID`);
  }
  assertLiteral(repair.state, "completed", `${label}.repair.state`);
  assertSha256(repair.planSha256, `${label}.repair.planSha256`);
  assertSha256(repair.diffSha256, `${label}.repair.diffSha256`);
  assertSha256(repair.checkpointSha256, `${label}.repair.checkpointSha256`);
  assertExactArray(
    repair.changedPaths,
    benchmarkCase.expectedChangedPaths,
    `${label}.repair.changedPaths`,
  );
  const repairChecks = assertArray(
    repair.checks,
    `${label}.repair.checks`,
    benchmarkCase.checks.length,
  );
  for (let index = 0; index < repairChecks.length; index += 1) {
    validateCheck(
      repairChecks[index],
      benchmarkCase.checks[index],
      "passed",
      benchmarkCase.budgets.maxCommandOutputBytes,
      `${label}.repair.checks[${index}]`,
    );
  }

  const provider = assertPlainRecord(repair.provider, `${label}.repair.provider`, PROVIDER_KEYS);
  assertLiteral(
    provider.adapterVersion,
    benchmarkCase.modelAdapter.adapterVersion,
    `${label}.repair.provider.adapterVersion`,
  );
  assertLiteral(provider.model, benchmarkCase.modelAdapter.model, `${label}.repair.provider.model`);
  assertLiteral(
    provider.loopbackRequests,
    benchmarkCase.modelAdapter.expectedRequests,
    `${label}.repair.provider.loopbackRequests`,
  );
  assertExactArray(
    provider.instructionDigests,
    [benchmarkCase.prompt.planInstructionsSha256, benchmarkCase.prompt.editInstructionsSha256],
    `${label}.repair.provider.instructionDigests`,
  );
  const requestDigests = assertArray(
    provider.requestDigests,
    `${label}.repair.provider.requestDigests`,
    benchmarkCase.modelAdapter.expectedRequests,
  );
  for (let index = 0; index < requestDigests.length; index += 1) {
    assertSha256(requestDigests[index], `${label}.repair.provider.requestDigests[${index}]`);
  }

  const candidate = assertPlainRecord(result.candidate, `${label}.candidate`, CANDIDATE_KEYS);
  for (const field of [
    "objectFormat",
    "baseCommitSha1",
    "baseTreeSha1",
    "candidateTreeSha1",
    "candidateCommitSha1",
    "candidateCommitPayloadSha256",
    "candidateObjectManifestSha256",
  ]) {
    assertLiteral(candidate[field], benchmarkCase.candidate[field], `${label}.candidate.${field}`);
  }
  assertLiteral(candidate.diffByteEqual, true, `${label}.candidate.diffByteEqual`);
  assertLiteral(
    candidate.headRef,
    `refs/heads/icarus/${repair.runId}`,
    `${label}.candidate.headRef`,
  );
  assertLiteral(
    candidate.localRefOutcome,
    benchmarkCase.restartRecovery.expectedLocalRefOutcome,
    `${label}.candidate.localRefOutcome`,
  );
  assertLiteral(candidate.updateRefExitCode, 0, `${label}.candidate.updateRefExitCode`);
  assertLiteral(
    candidate.recoveredAfter,
    benchmarkCase.restartRecovery.injectionPoint,
    `${label}.candidate.recoveredAfter`,
  );
  assertLiteral(
    candidate.productionRuntimeReopened,
    true,
    `${label}.candidate.productionRuntimeReopened`,
  );
  assertLiteral(candidate.durableRunRecovered, true, `${label}.candidate.durableRunRecovered`);
  assertLiteral(
    candidate.recoveryJournal,
    "benchmark_harness_only",
    `${label}.candidate.recoveryJournal`,
  );
  assertLiteral(
    candidate.duplicateReplayCode,
    "LANDING_LOCAL_REF_CONFLICT",
    `${label}.candidate.duplicateReplayCode`,
  );
  assertLiteral(
    candidate.localRefWrites,
    benchmarkCase.restartRecovery.expectedLocalRefWrites,
    `${label}.candidate.localRefWrites`,
  );

  const draft = assertPlainRecord(result.draftPullRequest, `${label}.draftPullRequest`, DRAFT_KEYS);
  assertLiteral(draft.status, "not_executed_contract_only", `${label}.draftPullRequest.status`);
  assertLiteral(
    draft.contractSchemaVersion,
    benchmarkCase.draftPullRequestEvidence.schemaVersion,
    `${label}.draftPullRequest.contractSchemaVersion`,
  );
  assertLiteral(
    draft.remoteMutationPerformed,
    false,
    `${label}.draftPullRequest.remoteMutationPerformed`,
  );

  const receipt = assertPlainRecord(result.receipt, `${label}.receipt`, RECEIPT_KEYS);
  assertLiteral(receipt.status, "not_executed_contract_only", `${label}.receipt.status`);
  assertLiteral(
    receipt.schemaVersion,
    benchmarkCase.receiptEvidence.schemaVersion,
    `${label}.receipt.schemaVersion`,
  );
  assertLiteral(receipt.runtimeRequiredForGate, true, `${label}.receipt.runtimeRequiredForGate`);
  validateEffects(result.effects, expectedCaseEffects(benchmarkCase), `${label}.effects`, false);
}

function validateFailure(value, manifest, completedCount, label) {
  const failure = assertPlainRecord(value, label, FAILURE_KEYS);
  const validStages = new Set([
    "manifest_or_fixture_preflight",
    "case_execution",
    "aggregate_verification",
  ]);
  if (!validStages.has(failure.stage)) fail(`${label}.stage is invalid`);
  if (
    failure.code !== null &&
    (typeof failure.code !== "string" || !ERROR_CODE_PATTERN.test(failure.code))
  ) {
    fail(`${label}.code must be null or a bounded uppercase error code`);
  }
  assertSha256(failure.messageSha256, `${label}.messageSha256`);

  if (failure.stage === "manifest_or_fixture_preflight") {
    if (manifest !== null) fail(`${label}.stage requires an unvalidated manifest`);
    assertLiteral(completedCount, 0, "counts.contractPassed");
    assertLiteral(failure.caseId, null, `${label}.caseId`);
    return;
  }
  if (manifest === null) fail(`${label}.stage requires a validated manifest`);
  if (failure.stage === "case_execution") {
    if (completedCount >= manifest.cases.length) {
      fail(`${label}.stage cannot follow every completed case`);
    }
    assertLiteral(failure.caseId, manifest.cases[completedCount].id, `${label}.caseId`);
    return;
  }
  assertLiteral(completedCount, manifest.cases.length, "counts.contractPassed");
  assertLiteral(failure.caseId, null, `${label}.caseId`);
}

/**
 * Validate a generated Gate 1 report as a closed schema-v1 success or failure
 * record. The optional manifest is null only when input preflight failed before
 * the committed manifest could be validated.
 */
export function validateGate1BenchmarkReport(value, manifest, expectedManifestSha256) {
  if (manifest !== null) validateGate1BenchmarkManifest(manifest);
  if (expectedManifestSha256 !== null) assertSha256(expectedManifestSha256, "manifest digest");
  const initial = assertDataRecord(value, "root");
  const failed = initial.assessment === "offline_contract_failed_gate1_incomplete";
  const passed = initial.assessment === "offline_contract_passed_gate1_incomplete";
  if (!failed && !passed) fail("assessment is invalid");
  if (passed && (manifest === null || expectedManifestSha256 === null)) {
    fail("success requires a validated manifest and non-null manifest digest");
  }
  if (manifest !== null && expectedManifestSha256 === null) {
    fail("a validated manifest requires a non-null manifest digest");
  }
  const report = assertPlainRecord(
    value,
    "root",
    failed ? FAILURE_REPORT_KEYS : SUCCESS_REPORT_KEYS,
  );

  assertLiteral(report.schemaVersion, 1, "schemaVersion");
  assertLiteral(
    report.benchmarkId,
    manifest?.benchmarkId ?? "gate1-verified-change",
    "benchmarkId",
  );
  assertLiteral(
    report.benchmarkRevision,
    manifest?.benchmarkRevision ?? "gate1-three-repository-repair-v1",
    "benchmarkRevision",
  );
  assertLiteral(report.manifestSha256, expectedManifestSha256, "manifestSha256");

  const counts = assertPlainRecord(report.counts, "counts", COUNTS_KEYS);
  const requiredCount = manifest?.releaseGate.requiredCaseCount ?? GATE1_REQUIRED_STACKS.length;
  assertInteger(counts.contractPassed, "counts.contractPassed", 0, requiredCount);
  assertLiteral(counts.failed, failed ? 1 : 0, "counts.failed");
  assertLiteral(counts.liveEvidenceNotRun, requiredCount, "counts.liveEvidenceNotRun");
  if (passed) assertLiteral(counts.contractPassed, requiredCount, "counts.contractPassed");
  if (manifest === null && counts.contractPassed !== 0) {
    fail("counts.contractPassed requires a validated manifest");
  }

  const cases = assertArray(report.cases, "cases", counts.contractPassed);
  if (manifest !== null) {
    for (let index = 0; index < cases.length; index += 1) {
      validateCaseResult(cases[index], manifest.cases[index], `cases[${index}]`);
    }
  }
  const benchmarkCases = manifest === null ? [] : manifest.cases.slice(0, cases.length);
  validateEffects(report.effects, expectedAggregateEffects(benchmarkCases), "effects", failed);
  assertExactArray(
    report.limitations,
    failed
      ? [...GATE1_OFFLINE_REPORT_LIMITATIONS, GATE1_FAILURE_REPORT_LIMITATION]
      : GATE1_OFFLINE_REPORT_LIMITATIONS,
    "limitations",
  );
  if (failed) validateFailure(report.failure, manifest, counts.contractPassed, "failure");
  return report;
}
