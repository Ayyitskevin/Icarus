import { createHash } from "node:crypto";

const TOP_LEVEL_KEYS = Object.freeze([
  "schemaVersion",
  "benchmarkId",
  "benchmarkRevision",
  "digestEncoding",
  "resultSchemaVersion",
  "executionBoundary",
  "releaseGate",
  "cases",
]);

export const GATE1_REQUIRED_STACKS = Object.freeze([
  "typescript-library",
  "python-cli",
  "react-node",
]);

export const GATE1_DERIVATIVE_GITHUB_EVENTS = Object.freeze(["create", "pull_request.opened"]);

export const GATE1_DERIVATIVE_EFFECTS = Object.freeze([
  "actions",
  "webhooks",
  "bots",
  "notifications",
  "deployments",
]);

export const GATE1_DERIVATIVE_ALLOWED_DISPOSITIONS = Object.freeze([
  "inert-repository",
  "operator-approved",
]);

export const GATE1_RELEASE_SUCCESS_CONDITIONS = Object.freeze([
  "registered_checks_pass",
  "expected_changed_paths_exact",
  "source_checkout_unchanged",
  "same_tab_reload_and_process_restart_recovery",
  "candidate_commit_and_absent_only_branch_exact",
  "reviewable_real_draft_pull_request",
  "matching_immutable_receipt",
  "separately_approved_external_mutations",
]);

export const GATE1_RELEASE_FAILURE_CONDITIONS = Object.freeze([
  "any_case_fails",
  "check_set_partial_or_truncated",
  "changed_paths_differ",
  "source_checkout_changes",
  "recovery_duplicates_or_loses_effect",
  "candidate_or_branch_identity_differs",
  "draft_pull_request_not_reviewable_or_not_real",
  "receipt_missing_or_mismatched",
  "mocked_or_synthetic_evidence_used_for_gate_claim",
  "credential_or_unapproved_external_effect_observed",
]);

export const GATE1_CASE_CI_SUCCESS_CONDITIONS = Object.freeze([
  "fixture_contract_valid",
  "source_revision_exact",
  "baseline_check_failure_reproduced",
  "deterministic_repair_completed",
  "registered_checks_pass",
  "expected_changed_paths_exact",
  "source_checkout_unchanged",
  "candidate_commit_exact",
  "absent_only_local_ref_created_after_runtime_reopen",
  "draft_pr_and_receipt_contracts_validated",
  "zero_credentials_external_network_remote_mutations",
]);

export const GATE1_CASE_RELEASE_SUCCESS_CONDITIONS = Object.freeze([
  "exact_model_prompt_and_budgets_recorded",
  "task_to_reviewed_candidate_completed",
  "registered_checks_pass",
  "expected_changed_paths_exact",
  "source_checkout_unchanged",
  "same_tab_reload_and_process_restart_recovery",
  "candidate_commit_and_branch_exact",
  "reviewable_real_draft_pull_request",
  "matching_immutable_receipt",
  "separate_approval_for_each_external_mutation",
]);

export const GATE1_CASE_FAILURE_CONDITIONS = Object.freeze([
  "manifest_or_fixture_digest_mismatch",
  "baseline_not_reproduced",
  "provider_or_prompt_identity_mismatch",
  "registered_check_missing_failed_unavailable_cancelled_or_truncated",
  "changed_paths_mismatch",
  "source_checkout_or_git_metadata_changed",
  "recovery_missing_or_duplicate_effect",
  "candidate_or_branch_identity_mismatch",
  "draft_pr_or_receipt_not_real_exact_and_reviewable",
  "credential_external_network_or_remote_mutation_in_ci",
  "mocked_evidence_used_for_gate_claim",
]);

export const GATE1_RECEIPT_REQUIRED_FIELDS = Object.freeze([
  "version",
  "landingId",
  "runId",
  "projectId",
  "provider",
  "owner",
  "repository",
  "baseRef",
  "baseCommitSha1",
  "headRef",
  "candidateTreeSha1",
  "candidateCommitSha1",
  "pullRequestNumber",
  "reconstructedPullRequestUrl",
  "draft",
  "landingSha256",
  "profileSha256",
  "planSha256",
  "diffSha256",
  "checkpointSha256",
  "verificationSha256",
  "reviewDecisionSha256",
  "changedPathsSha256",
  "localRefOutcome",
  "remoteObjectOutcome",
  "remoteRefOutcome",
  "pullRequestOutcome",
  "completedAt",
]);

export const GATE1_RECEIPT_FORBIDDEN_FIELDS = Object.freeze([
  "credential",
  "credentialRef",
  "cachePath",
  "worktreePath",
  "sourcePath",
  "commitMessage",
  "pullRequestTitle",
  "pullRequestBody",
  "task",
  "diff",
  "checkpoint",
  "providerOutput",
  "responseHeaders",
  "environment",
]);

export const GATE1_DRAFT_PULL_REQUEST_IDENTITY_FIELDS = Object.freeze([
  "owner",
  "repository",
  "pullRequestNumber",
  "reconstructedPullRequestUrl",
  "draft",
  "baseRef",
  "headRef",
  "candidateCommitSha1",
]);

const SOURCE_GIT_FINGERPRINT_FIELDS = Object.freeze([
  "head",
  "status",
  "refs",
  "config",
  "index",
  "worktrees",
]);

const EXPECTED_CHECKS_BY_STACK = Object.freeze({
  "typescript-library": Object.freeze([
    Object.freeze({
      id: "typescript-tests",
      name: "TypeScript clamp tests",
      argv: Object.freeze(["node", "--test", "tests/clamp.test.ts"]),
    }),
  ]),
  "python-cli": Object.freeze([
    Object.freeze({
      id: "python-tests",
      name: "Python word-count tests",
      argv: Object.freeze(["python", "-m", "unittest", "discover", "-s", "tests", "-v"]),
    }),
  ]),
  "react-node": Object.freeze([
    Object.freeze({
      id: "node-tests",
      name: "React/Node status tests",
      argv: Object.freeze(["node", "--test", "tests/status.test.mjs"]),
    }),
    Object.freeze({
      id: "component-contract",
      name: "React component contract",
      argv: Object.freeze(["node", "checks/component-contract.mjs"]),
    }),
  ]),
});

const EXECUTION_BOUNDARY_KEYS = Object.freeze([
  "mode",
  "manifestResultSeparation",
  "resultPath",
  "paidProviderCalls",
  "credentialReads",
  "externalNetworkRequests",
  "remoteMutations",
  "mockedEvidenceCompletesGate",
]);
const RELEASE_GATE_KEYS = Object.freeze([
  "requiredCaseCount",
  "requiredSuccessCount",
  "requiredStacks",
  "objectFormat",
  "credentialGatedRealGitHubEvidenceRequired",
  "successConditions",
  "failureConditions",
]);
const CASE_KEYS = Object.freeze([
  "id",
  "stack",
  "repository",
  "task",
  "prompt",
  "modelAdapter",
  "selectedPaths",
  "allowedChangedPaths",
  "expectedChangedPaths",
  "expectedChanges",
  "checks",
  "sandbox",
  "budgets",
  "sourceImmutability",
  "restartRecovery",
  "candidate",
  "draftPullRequestEvidence",
  "receiptEvidence",
  "acceptance",
]);
const REPOSITORY_KEYS = Object.freeze([
  "fixturePath",
  "githubOwner",
  "githubRepository",
  "baseBranch",
  "sourceRevision",
  "files",
  "treeSha256",
  "derivativeEffects",
]);
const SOURCE_REVISION_KEYS = Object.freeze(["objectFormat", "commitSha1", "treeSha1"]);
const REPOSITORY_FILE_KEYS = Object.freeze(["path", "sha256"]);
const DERIVATIVE_EFFECT_KEYS = Object.freeze([
  "evidenceMode",
  "githubEvents",
  "mayTrigger",
  "liveAssessmentRequired",
  "allowedDispositions",
  "assessmentSha256",
  "disclosureSha256",
]);
const TASK_KEYS = Object.freeze(["path", "encoding", "sha256"]);
const PROMPT_KEYS = Object.freeze([
  "planRevision",
  "planInstructionsSha256",
  "editRevision",
  "editInstructionsSha256",
]);
const MODEL_ADAPTER_KEYS = Object.freeze([
  "provider",
  "model",
  "adapterVersion",
  "transport",
  "inputUsdPerMillionTokens",
  "outputUsdPerMillionTokens",
  "expectedRequests",
  "paid",
  "credentials",
]);
const EXPECTED_CHANGE_KEYS = Object.freeze([
  "path",
  "operation",
  "expectedFixturePath",
  "baselineSha256",
  "approvedSha256",
]);
const CHECK_KEYS = Object.freeze(["id", "name", "argv"]);
const SANDBOX_KEYS = Object.freeze(["image", "cpus", "memoryMb", "pids", "tmpfsMb"]);
const BUDGET_KEYS = Object.freeze([
  "maxProviderCalls",
  "maxRemoteMutations",
  "maxToolCalls",
  "maxActiveRuntimeMs",
  "maxContextBytes",
  "maxOutputTokensPerCall",
  "maxTotalTokens",
  "maxCostUsd",
  "maxFilesChanged",
  "maxFileBytes",
  "maxDiffBytes",
  "maxCommandOutputBytes",
  "maxRawCommandOutputBytes",
  "providerTimeoutMs",
  "commandTimeoutMs",
]);
const SOURCE_IMMUTABILITY_KEYS = Object.freeze([
  "required",
  "contentSnapshot",
  "gitFingerprintFields",
  "gitDirectorySnapshot",
  "sourceWritesAllowed",
]);
const RESTART_RECOVERY_KEYS = Object.freeze([
  "sameProcessReload",
  "serverProcessRestart",
  "durableRecovery",
  "injectionPoint",
  "expectedLocalRefOutcome",
  "expectedLocalRefWrites",
  "expectedCredentialReads",
  "expectedExternalNetworkRequests",
  "expectedRemoteMutations",
]);
const CANDIDATE_KEYS = Object.freeze([
  "objectFormat",
  "branchNamespace",
  "headRefTemplate",
  "absentOnly",
  "forceAllowed",
  "deleteAllowed",
  "commitIdentity",
  "commitEpochSeconds",
  "commitIso8601",
  "commitMessage",
  "baseCommitSha1",
  "baseTreeSha1",
  "candidateTreeSha1",
  "candidateCommitSha1",
  "candidateCommitPayloadSha256",
  "candidateObjectManifestSha256",
]);
const COMMIT_IDENTITY_KEYS = Object.freeze(["name", "email"]);
const DRAFT_PULL_REQUEST_EVIDENCE_KEYS = Object.freeze([
  "schemaVersion",
  "evidenceMode",
  "provider",
  "owner",
  "repository",
  "baseRef",
  "headRefTemplate",
  "expectedBaseCommitSha1",
  "expectedCandidateCommitSha1",
  "requiredState",
  "draft",
  "maintainerCanModify",
  "markerCount",
  "identityFields",
  "remoteMutationAllowed",
]);
const RECEIPT_EVIDENCE_KEYS = Object.freeze([
  "schemaVersion",
  "contractVersion",
  "requiredFields",
  "forbiddenFields",
  "runtimeRequiredForGate",
  "syntheticReceiptCompletesGate",
]);
const ACCEPTANCE_KEYS = Object.freeze([
  "ciSuccessConditions",
  "releaseSuccessConditions",
  "failureConditions",
]);

const SHA1_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const GITHUB_OWNER_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;
const GITHUB_REPOSITORY_PATTERN = /^[a-z0-9._-]{1,100}$/;
const DIGEST_IMAGE_PATTERN = /^[a-z0-9][a-z0-9._/-]*(?::[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}$/;
const ENCODED_PATH_PATTERN = /%(?:2e|2f|5c)/i;
const CONTROL_PATTERN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

const MAX_PATH_BYTES = 1_024;
const MAX_CASE_ID_BYTES = 128;
const MAX_REVISION_BYTES = 256;
const MAX_REPOSITORY_FILES = 512;
const MAX_CHANGED_PATHS = 8;
const MAX_CHECKS = 16;
const MAX_ARGV_ITEMS = 64;
const MAX_CHECK_ID_BYTES = 128;
const MAX_CHECK_NAME_BYTES = 256;
const MAX_CHECK_ARG_BYTES = 4_096;

const SUN_BUDGET_MAXIMUMS = Object.freeze({
  maxToolCalls: 40,
  maxActiveRuntimeMs: 1_200_000,
  maxContextBytes: 196_608,
  maxOutputTokensPerCall: 8_192,
  maxTotalTokens: 100_000,
  maxFilesChanged: 8,
  maxFileBytes: 262_144,
  maxDiffBytes: 262_144,
  maxCommandOutputBytes: 262_144,
  maxRawCommandOutputBytes: 8_388_608,
  providerTimeoutMs: 300_000,
  commandTimeoutMs: 300_000,
});

function fail(message) {
  throw new Error(`Gate 1 benchmark manifest ${message}`);
}

function sha256Utf8(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertPlainRecord(value, label, expectedKeys) {
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
  const actualKeys = ownKeys.map(String).sort();
  const closedKeys = [...expectedKeys].sort();
  if (
    actualKeys.length !== closedKeys.length ||
    actualKeys.some((key, index) => key !== closedKeys[index])
  ) {
    fail(`${label} must contain exactly: ${expectedKeys.join(", ")}`);
  }
  return value;
}

function assertArray(value, label, minimum, maximum) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length < minimum ||
    value.length > maximum
  ) {
    fail(`${label} must contain ${minimum}..${maximum} entries`);
  }
  const keys = Object.keys(value);
  const ownKeys = Reflect.ownKeys(value);
  if (
    keys.length !== value.length ||
    keys.some((key, index) => key !== String(index)) ||
    ownKeys.length !== value.length + 1 ||
    ownKeys.some((key) => typeof key !== "string" || (key !== "length" && !/^\d+$/.test(key)))
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
  if (!Object.is(value, expected)) {
    fail(`${label} must equal ${JSON.stringify(expected)}`);
  }
  return value;
}

function assertBoundedString(value, label, minimumBytes, maximumBytes) {
  if (typeof value !== "string") fail(`${label} must be a string`);
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < minimumBytes || bytes > maximumBytes) {
    fail(`${label} must be ${minimumBytes}..${maximumBytes} UTF-8 bytes`);
  }
  if (!isWellFormedUnicode(value) || CONTROL_PATTERN.test(value)) {
    fail(`${label} must be well-formed text without control characters`);
  }
  return value;
}

function isWellFormedUnicode(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function assertSafeInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || Object.is(value, -0) || value < minimum || value > maximum) {
    fail(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function assertSha1(value, label) {
  if (typeof value !== "string" || !SHA1_PATTERN.test(value) || /^0{40}$/.test(value)) {
    fail(`${label} must be a lowercase SHA-1`);
  }
  return value;
}

function assertSha256(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    fail(`${label} must be a lowercase SHA-256`);
  }
  return value;
}

function assertSafeId(value, label) {
  const id = assertBoundedString(value, label, 1, MAX_CASE_ID_BYTES);
  if (!SAFE_ID_PATTERN.test(id)) fail(`${label} must be a canonical lowercase identifier`);
  return id;
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function assertSortedUnique(values, label, project = (entry) => entry) {
  for (let index = 1; index < values.length; index += 1) {
    if (compareUtf8(project(values[index - 1]), project(values[index])) >= 0) {
      fail(`${label} must be UTF-8 byte-sorted and duplicate-free`);
    }
  }
}

function assertExactStringArray(value, expected, label) {
  const array = assertArray(value, label, expected.length, expected.length);
  for (let index = 0; index < expected.length; index += 1) {
    assertLiteral(array[index], expected[index], `${label}[${index}]`);
  }
  return array;
}

function assertCanonicalPath(value, label, denyProtected = false) {
  const candidate = assertBoundedString(value, label, 1, MAX_PATH_BYTES);
  if (candidate.normalize("NFC") !== candidate) fail(`${label} must use NFC normalization`);
  if (
    candidate.startsWith("/") ||
    candidate.startsWith("//") ||
    /^[A-Za-z]:/.test(candidate) ||
    candidate.includes("\\")
  ) {
    fail(`${label} must be a repository-relative forward-slash path`);
  }
  if (ENCODED_PATH_PATTERN.test(candidate)) fail(`${label} contains encoded path traversal`);
  const components = candidate.split("/");
  if (
    components.some(
      (component) =>
        component === "" ||
        component === "." ||
        component === ".." ||
        CONTROL_PATTERN.test(component),
    )
  ) {
    fail(`${label} contains an unsafe path component`);
  }
  if (denyProtected && isProtectedTarget(candidate)) fail(`${label} is a protected path`);
  return candidate;
}

function isProtectedTarget(value) {
  const lower = value.toLowerCase();
  const components = lower.split("/");
  const basename = components.at(-1) ?? "";
  return (
    components.includes(".git") ||
    components.includes(".icarus") ||
    components.includes("migrations") ||
    lower.startsWith(".github/workflows/") ||
    basename === "agents.md" ||
    basename === ".gitattributes" ||
    basename === "dockerfile" ||
    basename === "package.json" ||
    basename.endsWith("lock.json") ||
    basename.endsWith("lock.yaml") ||
    basename.endsWith(".lock") ||
    basename.endsWith(".pem") ||
    basename.endsWith(".key") ||
    basename === ".env" ||
    basename.startsWith(".env.") ||
    components.includes("credentials") ||
    components.includes("secrets")
  );
}

function assertGate1FixturePath(value, label, subdirectory) {
  const fixturePath = assertCanonicalPath(value, label);
  const requiredPrefix = `fixtures/evals/gate1/${subdirectory}/`;
  if (!fixturePath.startsWith(requiredPrefix)) {
    fail(`${label} must remain beneath ${requiredPrefix.slice(0, -1)}`);
  }
  return fixturePath;
}

function validateExecutionBoundary(value) {
  const boundary = assertPlainRecord(value, "executionBoundary", EXECUTION_BOUNDARY_KEYS);
  assertLiteral(boundary.mode, "deterministic_fixture", "executionBoundary.mode");
  assertLiteral(
    boundary.manifestResultSeparation,
    "committed-input-generated-result",
    "executionBoundary.manifestResultSeparation",
  );
  assertLiteral(
    boundary.resultPath,
    ".local/gate1-benchmark-report.json",
    "executionBoundary.resultPath",
  );
  assertLiteral(boundary.paidProviderCalls, 0, "executionBoundary.paidProviderCalls");
  assertLiteral(boundary.credentialReads, 0, "executionBoundary.credentialReads");
  assertLiteral(boundary.externalNetworkRequests, 0, "executionBoundary.externalNetworkRequests");
  assertLiteral(boundary.remoteMutations, 0, "executionBoundary.remoteMutations");
  assertLiteral(
    boundary.mockedEvidenceCompletesGate,
    false,
    "executionBoundary.mockedEvidenceCompletesGate",
  );
}

function validateReleaseGate(value) {
  const gate = assertPlainRecord(value, "releaseGate", RELEASE_GATE_KEYS);
  assertLiteral(gate.requiredCaseCount, 3, "releaseGate.requiredCaseCount");
  assertLiteral(gate.requiredSuccessCount, 3, "releaseGate.requiredSuccessCount");
  assertExactStringArray(gate.requiredStacks, GATE1_REQUIRED_STACKS, "releaseGate.requiredStacks");
  assertLiteral(gate.objectFormat, "sha1", "releaseGate.objectFormat");
  assertLiteral(
    gate.credentialGatedRealGitHubEvidenceRequired,
    true,
    "releaseGate.credentialGatedRealGitHubEvidenceRequired",
  );
  assertExactStringArray(
    gate.successConditions,
    GATE1_RELEASE_SUCCESS_CONDITIONS,
    "releaseGate.successConditions",
  );
  assertExactStringArray(
    gate.failureConditions,
    GATE1_RELEASE_FAILURE_CONDITIONS,
    "releaseGate.failureConditions",
  );
}

function validateRepository(value, caseId, label) {
  const repository = assertPlainRecord(value, label, REPOSITORY_KEYS);
  const fixturePath = assertGate1FixturePath(
    repository.fixturePath,
    `${label}.fixturePath`,
    "repos",
  );
  const owner = assertBoundedString(repository.githubOwner, `${label}.githubOwner`, 1, 39);
  if (!GITHUB_OWNER_PATTERN.test(owner)) fail(`${label}.githubOwner is invalid`);
  const name = assertBoundedString(
    repository.githubRepository,
    `${label}.githubRepository`,
    1,
    100,
  );
  if (!GITHUB_REPOSITORY_PATTERN.test(name)) fail(`${label}.githubRepository is invalid`);
  assertLiteral(repository.baseBranch, "main", `${label}.baseBranch`);

  const revision = assertPlainRecord(
    repository.sourceRevision,
    `${label}.sourceRevision`,
    SOURCE_REVISION_KEYS,
  );
  assertLiteral(revision.objectFormat, "sha1", `${label}.sourceRevision.objectFormat`);
  const commitSha1 = assertSha1(revision.commitSha1, `${label}.sourceRevision.commitSha1`);
  const treeSha1 = assertSha1(revision.treeSha1, `${label}.sourceRevision.treeSha1`);

  const files = assertArray(repository.files, `${label}.files`, 1, MAX_REPOSITORY_FILES);
  const validatedFiles = files.map((entry, index) => {
    const file = assertPlainRecord(entry, `${label}.files[${index}]`, REPOSITORY_FILE_KEYS);
    const filePath = assertCanonicalPath(file.path, `${label}.files[${index}].path`);
    if (filePath.split("/").includes(".git") || filePath.split("/").at(-1) === ".gitattributes") {
      fail(`${label}.files[${index}].path contains forbidden Git control metadata`);
    }
    return {
      path: filePath,
      sha256: assertSha256(file.sha256, `${label}.files[${index}].sha256`),
    };
  });
  assertSortedUnique(validatedFiles, `${label}.files`, (file) => file.path);
  const treeSha256 = assertSha256(repository.treeSha256, `${label}.treeSha256`);
  const expectedTreeSha256 = sha256Utf8(
    JSON.stringify(validatedFiles.map((file) => [file.path, file.sha256])),
  );
  if (treeSha256 !== expectedTreeSha256) {
    fail(`${label}.treeSha256 must bind the sorted regular-file inventory`);
  }

  const derivative = assertPlainRecord(
    repository.derivativeEffects,
    `${label}.derivativeEffects`,
    DERIVATIVE_EFFECT_KEYS,
  );
  assertLiteral(
    derivative.evidenceMode,
    "contract-only-unassessed",
    `${label}.derivativeEffects.evidenceMode`,
  );
  assertExactStringArray(
    derivative.githubEvents,
    GATE1_DERIVATIVE_GITHUB_EVENTS,
    `${label}.derivativeEffects.githubEvents`,
  );
  assertExactStringArray(
    derivative.mayTrigger,
    GATE1_DERIVATIVE_EFFECTS,
    `${label}.derivativeEffects.mayTrigger`,
  );
  assertLiteral(
    derivative.liveAssessmentRequired,
    true,
    `${label}.derivativeEffects.liveAssessmentRequired`,
  );
  assertExactStringArray(
    derivative.allowedDispositions,
    GATE1_DERIVATIVE_ALLOWED_DISPOSITIONS,
    `${label}.derivativeEffects.allowedDispositions`,
  );
  assertLiteral(derivative.assessmentSha256, null, `${label}.derivativeEffects.assessmentSha256`);
  const disclosureSha256 = assertSha256(
    derivative.disclosureSha256,
    `${label}.derivativeEffects.disclosureSha256`,
  );
  const expectedDisclosureSha256 = sha256Utf8(
    JSON.stringify({
      caseId,
      evidenceMode: derivative.evidenceMode,
      githubEvents: derivative.githubEvents,
      mayTrigger: derivative.mayTrigger,
      liveAssessmentRequired: derivative.liveAssessmentRequired,
      allowedDispositions: derivative.allowedDispositions,
      assessmentSha256: derivative.assessmentSha256,
    }),
  );
  if (disclosureSha256 !== expectedDisclosureSha256) {
    fail(`${label}.derivativeEffects.disclosureSha256 does not bind the unassessed disclosure`);
  }

  return {
    fixturePath,
    githubIdentity: `${owner}/${name}`,
    githubOwner: owner,
    githubRepository: name,
    commitSha1,
    treeSha1,
    files: validatedFiles,
  };
}

function validateTask(value, label) {
  const task = assertPlainRecord(value, label, TASK_KEYS);
  const taskPath = assertGate1FixturePath(task.path, `${label}.path`, "tasks");
  if (!taskPath.endsWith(".md")) fail(`${label}.path must identify a Markdown task fixture`);
  assertLiteral(task.encoding, "raw-utf8", `${label}.encoding`);
  assertSha256(task.sha256, `${label}.sha256`);
  return taskPath;
}

function validatePrompt(value, label) {
  const prompt = assertPlainRecord(value, label, PROMPT_KEYS);
  const planRevision = assertBoundedString(
    prompt.planRevision,
    `${label}.planRevision`,
    1,
    MAX_REVISION_BYTES,
  );
  if (!SAFE_ID_PATTERN.test(planRevision)) fail(`${label}.planRevision is not canonical`);
  assertSha256(prompt.planInstructionsSha256, `${label}.planInstructionsSha256`);
  const editRevision = assertBoundedString(
    prompt.editRevision,
    `${label}.editRevision`,
    1,
    MAX_REVISION_BYTES,
  );
  if (!SAFE_ID_PATTERN.test(editRevision)) fail(`${label}.editRevision is not canonical`);
  assertSha256(prompt.editInstructionsSha256, `${label}.editInstructionsSha256`);
}

function validateModelAdapter(value, label) {
  const adapter = assertPlainRecord(value, label, MODEL_ADAPTER_KEYS);
  assertLiteral(adapter.provider, "ollama", `${label}.provider`);
  assertLiteral(adapter.model, "icarus-gate1-fixture-model-v1", `${label}.model`);
  assertLiteral(adapter.adapterVersion, "production-ollama-api-chat-v1", `${label}.adapterVersion`);
  assertLiteral(adapter.transport, "deterministic-loopback-http", `${label}.transport`);
  assertLiteral(adapter.inputUsdPerMillionTokens, 0, `${label}.inputUsdPerMillionTokens`);
  assertLiteral(adapter.outputUsdPerMillionTokens, 0, `${label}.outputUsdPerMillionTokens`);
  assertLiteral(adapter.expectedRequests, 2, `${label}.expectedRequests`);
  assertLiteral(adapter.paid, false, `${label}.paid`);
  assertLiteral(adapter.credentials, false, `${label}.credentials`);
}

function validateChangedPaths(value, label) {
  const paths = assertArray(value, label, 1, MAX_CHANGED_PATHS).map((entry, index) =>
    assertCanonicalPath(entry, `${label}[${index}]`, true),
  );
  assertSortedUnique(paths, label);
  return paths;
}

function validateExpectedChanges(value, expectedPaths, repositoryFiles, stack, label) {
  const changes = assertArray(value, label, expectedPaths.length, expectedPaths.length);
  const baselineByPath = new Map(repositoryFiles.map((file) => [file.path, file.sha256]));
  const expectedFixturePaths = new Set();
  for (let index = 0; index < changes.length; index += 1) {
    const change = assertPlainRecord(changes[index], `${label}[${index}]`, EXPECTED_CHANGE_KEYS);
    const changePath = assertCanonicalPath(change.path, `${label}[${index}].path`, true);
    assertLiteral(changePath, expectedPaths[index], `${label}[${index}].path`);
    assertLiteral(change.operation, "modify", `${label}[${index}].operation`);
    const expectedFixturePath = assertGate1FixturePath(
      change.expectedFixturePath,
      `${label}[${index}].expectedFixturePath`,
      "expected",
    );
    assertLiteral(
      expectedFixturePath,
      `fixtures/evals/gate1/expected/${stack}/${changePath}`,
      `${label}[${index}].expectedFixturePath`,
    );
    if (expectedFixturePaths.has(expectedFixturePath)) {
      fail(`${label}.expectedFixturePath values must be unique`);
    }
    expectedFixturePaths.add(expectedFixturePath);
    const baselineSha256 = assertSha256(change.baselineSha256, `${label}[${index}].baselineSha256`);
    const approvedSha256 = assertSha256(change.approvedSha256, `${label}[${index}].approvedSha256`);
    if (baselineByPath.get(changePath) !== baselineSha256) {
      fail(`${label}[${index}].baselineSha256 must match the repository inventory`);
    }
    if (approvedSha256 === baselineSha256) {
      fail(`${label}[${index}] must pin changed approved bytes`);
    }
  }
}

function validateChecks(value, stack, label) {
  const checks = assertArray(value, label, 1, MAX_CHECKS);
  const ids = new Set();
  const names = new Set();
  const commands = new Set();
  for (let index = 0; index < checks.length; index += 1) {
    const check = assertPlainRecord(checks[index], `${label}[${index}]`, CHECK_KEYS);
    const id = assertBoundedString(check.id, `${label}[${index}].id`, 1, MAX_CHECK_ID_BYTES);
    if (!SAFE_ID_PATTERN.test(id)) fail(`${label}[${index}].id is not canonical`);
    const name = assertBoundedString(
      check.name,
      `${label}[${index}].name`,
      1,
      MAX_CHECK_NAME_BYTES,
    );
    if (ids.has(id) || names.has(name)) fail(`${label} contains a duplicate check identity`);
    ids.add(id);
    names.add(name);

    const argv = assertArray(check.argv, `${label}[${index}].argv`, 1, MAX_ARGV_ITEMS).map(
      (argument, argumentIndex) =>
        assertBoundedString(
          argument,
          `${label}[${index}].argv[${argumentIndex}]`,
          1,
          MAX_CHECK_ARG_BYTES,
        ),
    );
    assertSafeCheckCommand(argv, `${label}[${index}].argv`);
    const command = JSON.stringify(argv);
    if (commands.has(command)) fail(`${label} contains a duplicate argv vector`);
    commands.add(command);
  }
  const expected = EXPECTED_CHECKS_BY_STACK[stack];
  if (
    expected === undefined ||
    checks.length !== expected.length ||
    checks.some(
      (check, index) =>
        check.id !== expected[index].id ||
        check.name !== expected[index].name ||
        JSON.stringify(check.argv) !== JSON.stringify(expected[index].argv),
    )
  ) {
    fail(`${label} must match the exact ordered ${stack} registered check profiles`);
  }
}

function assertSafeCheckCommand(argv, label) {
  const executable = argv[0].split("/").at(-1).toLowerCase();
  const forbiddenExecutables = new Set([
    "sh",
    "bash",
    "dash",
    "zsh",
    "ksh",
    "fish",
    "cmd",
    "cmd.exe",
    "powershell",
    "powershell.exe",
    "pwsh",
    "npm",
    "pnpm",
    "npx",
  ]);
  if (forbiddenExecutables.has(executable)) {
    fail(`${label} uses a forbidden shell or package wrapper`);
  }
  const argumentsAfterExecutable = argv.slice(1);
  if (
    (executable === "node" || executable === "nodejs") &&
    argumentsAfterExecutable.some((argument) => argument === "-e" || argument.startsWith("--eval"))
  ) {
    fail(`${label} uses a forbidden Node.js evaluator`);
  }
  if (/^python(?:\d+(?:\.\d+)*)?$/.test(executable) && argumentsAfterExecutable.includes("-c")) {
    fail(`${label} uses a forbidden Python evaluator`);
  }
}

function validateSandbox(value, label) {
  const sandbox = assertPlainRecord(value, label, SANDBOX_KEYS);
  if (
    typeof sandbox.image !== "string" ||
    Buffer.byteLength(sandbox.image, "utf8") > 512 ||
    !DIGEST_IMAGE_PATTERN.test(sandbox.image)
  ) {
    fail(`${label}.image must contain an immutable lowercase sha256 digest`);
  }
  if (
    typeof sandbox.cpus !== "number" ||
    !Number.isFinite(sandbox.cpus) ||
    sandbox.cpus <= 0 ||
    sandbox.cpus > 4
  ) {
    fail(`${label}.cpus must be finite and no greater than 4`);
  }
  assertSafeInteger(sandbox.memoryMb, `${label}.memoryMb`, 128, 4_096);
  assertSafeInteger(sandbox.pids, `${label}.pids`, 16, 512);
  assertSafeInteger(sandbox.tmpfsMb, `${label}.tmpfsMb`, 16, 2_048);
}

function validateBudgets(value, expectedPathCount, label) {
  const budgets = assertPlainRecord(value, label, BUDGET_KEYS);
  assertLiteral(budgets.maxProviderCalls, 2, `${label}.maxProviderCalls`);
  assertLiteral(budgets.maxRemoteMutations, 0, `${label}.maxRemoteMutations`);
  for (const [key, maximum] of Object.entries(SUN_BUDGET_MAXIMUMS)) {
    assertSafeInteger(budgets[key], `${label}.${key}`, 1, maximum);
  }
  assertLiteral(budgets.maxCostUsd, 0, `${label}.maxCostUsd`);
  assertLiteral(budgets.maxFilesChanged, expectedPathCount, `${label}.maxFilesChanged`);
  if (budgets.maxOutputTokensPerCall > budgets.maxTotalTokens) {
    fail(`${label}.maxOutputTokensPerCall exceeds maxTotalTokens`);
  }
  if (budgets.maxCommandOutputBytes > budgets.maxRawCommandOutputBytes) {
    fail(`${label}.maxCommandOutputBytes exceeds maxRawCommandOutputBytes`);
  }
}

function validateSourceImmutability(value, label) {
  const contract = assertPlainRecord(value, label, SOURCE_IMMUTABILITY_KEYS);
  assertLiteral(contract.required, true, `${label}.required`);
  assertLiteral(
    contract.contentSnapshot,
    "byte-exact-tree-and-git-metadata",
    `${label}.contentSnapshot`,
  );
  assertExactStringArray(
    contract.gitFingerprintFields,
    SOURCE_GIT_FINGERPRINT_FIELDS,
    `${label}.gitFingerprintFields`,
  );
  assertLiteral(
    contract.gitDirectorySnapshot,
    "complete-types-modes-and-file-bytes",
    `${label}.gitDirectorySnapshot`,
  );
  assertLiteral(contract.sourceWritesAllowed, 0, `${label}.sourceWritesAllowed`);
}

function validateRestartRecovery(value, label) {
  const recovery = assertPlainRecord(value, label, RESTART_RECOVERY_KEYS);
  assertLiteral(
    recovery.sameProcessReload,
    "retains-current-session-authority",
    `${label}.sameProcessReload`,
  );
  assertLiteral(
    recovery.serverProcessRestart,
    "rotate-origin-and-token",
    `${label}.serverProcessRestart`,
  );
  assertLiteral(
    recovery.durableRecovery,
    "fresh-launch-resumes-persisted-candidate",
    `${label}.durableRecovery`,
  );
  assertLiteral(
    recovery.injectionPoint,
    "candidate-commit-prepared-before-local-ref",
    `${label}.injectionPoint`,
  );
  assertLiteral(recovery.expectedLocalRefOutcome, "created", `${label}.expectedLocalRefOutcome`);
  assertLiteral(recovery.expectedLocalRefWrites, 1, `${label}.expectedLocalRefWrites`);
  assertLiteral(recovery.expectedCredentialReads, 0, `${label}.expectedCredentialReads`);
  assertLiteral(
    recovery.expectedExternalNetworkRequests,
    0,
    `${label}.expectedExternalNetworkRequests`,
  );
  assertLiteral(recovery.expectedRemoteMutations, 0, `${label}.expectedRemoteMutations`);
}

function validateCandidate(value, repository, label) {
  const candidate = assertPlainRecord(value, label, CANDIDATE_KEYS);
  assertLiteral(candidate.objectFormat, "sha1", `${label}.objectFormat`);
  assertLiteral(candidate.branchNamespace, "icarus/", `${label}.branchNamespace`);
  assertLiteral(candidate.headRefTemplate, "refs/heads/icarus/{runId}", `${label}.headRefTemplate`);
  assertLiteral(candidate.absentOnly, true, `${label}.absentOnly`);
  assertLiteral(candidate.forceAllowed, false, `${label}.forceAllowed`);
  assertLiteral(candidate.deleteAllowed, false, `${label}.deleteAllowed`);

  const identity = assertPlainRecord(
    candidate.commitIdentity,
    `${label}.commitIdentity`,
    COMMIT_IDENTITY_KEYS,
  );
  assertLiteral(identity.name, "Icarus Gate 1 Benchmark", `${label}.commitIdentity.name`);
  assertLiteral(identity.email, "icarus-gate1@example.invalid", `${label}.commitIdentity.email`);
  assertLiteral(candidate.commitEpochSeconds, 1_704_067_200, `${label}.commitEpochSeconds`);
  assertLiteral(candidate.commitIso8601, "2024-01-01T00:00:00Z", `${label}.commitIso8601`);
  if (new Date(candidate.commitEpochSeconds * 1_000).toISOString() !== "2024-01-01T00:00:00.000Z") {
    fail(`${label}.commitIso8601 does not match commitEpochSeconds`);
  }
  assertLiteral(
    candidate.commitMessage,
    "Icarus Gate 1 deterministic repair\n",
    `${label}.commitMessage`,
  );
  const baseCommitSha1 = assertSha1(candidate.baseCommitSha1, `${label}.baseCommitSha1`);
  const baseTreeSha1 = assertSha1(candidate.baseTreeSha1, `${label}.baseTreeSha1`);
  const candidateTreeSha1 = assertSha1(candidate.candidateTreeSha1, `${label}.candidateTreeSha1`);
  const candidateCommitSha1 = assertSha1(
    candidate.candidateCommitSha1,
    `${label}.candidateCommitSha1`,
  );
  assertSha256(candidate.candidateCommitPayloadSha256, `${label}.candidateCommitPayloadSha256`);
  assertSha256(candidate.candidateObjectManifestSha256, `${label}.candidateObjectManifestSha256`);
  if (baseCommitSha1 !== repository.commitSha1 || baseTreeSha1 !== repository.treeSha1) {
    fail(`${label} base identity must equal repository.sourceRevision`);
  }
  if (candidateTreeSha1 === baseTreeSha1 || candidateCommitSha1 === baseCommitSha1) {
    fail(`${label} must pin a changed candidate tree and commit`);
  }
  return { candidateCommitSha1 };
}

function validateDraftPullRequestEvidence(value, repository, candidate, label) {
  const evidence = assertPlainRecord(value, label, DRAFT_PULL_REQUEST_EVIDENCE_KEYS);
  assertLiteral(evidence.schemaVersion, 1, `${label}.schemaVersion`);
  assertLiteral(evidence.evidenceMode, "contract-only", `${label}.evidenceMode`);
  assertLiteral(evidence.provider, "github", `${label}.provider`);
  assertLiteral(evidence.owner, repository.githubOwner, `${label}.owner`);
  assertLiteral(evidence.repository, repository.githubRepository, `${label}.repository`);
  assertLiteral(evidence.baseRef, "refs/heads/main", `${label}.baseRef`);
  assertLiteral(evidence.headRefTemplate, "refs/heads/icarus/{runId}", `${label}.headRefTemplate`);
  assertLiteral(
    evidence.expectedBaseCommitSha1,
    repository.commitSha1,
    `${label}.expectedBaseCommitSha1`,
  );
  assertLiteral(
    evidence.expectedCandidateCommitSha1,
    candidate.candidateCommitSha1,
    `${label}.expectedCandidateCommitSha1`,
  );
  assertLiteral(evidence.requiredState, "open", `${label}.requiredState`);
  assertLiteral(evidence.draft, true, `${label}.draft`);
  assertLiteral(evidence.maintainerCanModify, false, `${label}.maintainerCanModify`);
  assertLiteral(evidence.markerCount, 1, `${label}.markerCount`);
  assertExactStringArray(
    evidence.identityFields,
    GATE1_DRAFT_PULL_REQUEST_IDENTITY_FIELDS,
    `${label}.identityFields`,
  );
  assertLiteral(evidence.remoteMutationAllowed, false, `${label}.remoteMutationAllowed`);
}

function validateReceiptEvidence(value, label) {
  const evidence = assertPlainRecord(value, label, RECEIPT_EVIDENCE_KEYS);
  assertLiteral(evidence.schemaVersion, 1, `${label}.schemaVersion`);
  assertLiteral(
    evidence.contractVersion,
    "adr-0027-landing-receipt-v1",
    `${label}.contractVersion`,
  );
  assertExactStringArray(
    evidence.requiredFields,
    GATE1_RECEIPT_REQUIRED_FIELDS,
    `${label}.requiredFields`,
  );
  assertExactStringArray(
    evidence.forbiddenFields,
    GATE1_RECEIPT_FORBIDDEN_FIELDS,
    `${label}.forbiddenFields`,
  );
  assertLiteral(evidence.runtimeRequiredForGate, true, `${label}.runtimeRequiredForGate`);
  assertLiteral(
    evidence.syntheticReceiptCompletesGate,
    false,
    `${label}.syntheticReceiptCompletesGate`,
  );
}

function validateAcceptance(value, label) {
  const acceptance = assertPlainRecord(value, label, ACCEPTANCE_KEYS);
  assertExactStringArray(
    acceptance.ciSuccessConditions,
    GATE1_CASE_CI_SUCCESS_CONDITIONS,
    `${label}.ciSuccessConditions`,
  );
  assertExactStringArray(
    acceptance.releaseSuccessConditions,
    GATE1_CASE_RELEASE_SUCCESS_CONDITIONS,
    `${label}.releaseSuccessConditions`,
  );
  assertExactStringArray(
    acceptance.failureConditions,
    GATE1_CASE_FAILURE_CONDITIONS,
    `${label}.failureConditions`,
  );
}

function validateCase(value, index) {
  const label = `cases[${index}]`;
  const benchmarkCase = assertPlainRecord(value, label, CASE_KEYS);
  const id = assertSafeId(benchmarkCase.id, `${label}.id`);
  assertLiteral(benchmarkCase.stack, GATE1_REQUIRED_STACKS[index], `${label}.stack`);
  const repository = validateRepository(benchmarkCase.repository, id, `${label}.repository`);
  const taskPath = validateTask(benchmarkCase.task, `${label}.task`);
  assertLiteral(
    repository.fixturePath,
    `fixtures/evals/gate1/repos/${benchmarkCase.stack}`,
    `${label}.repository.fixturePath`,
  );
  assertLiteral(
    taskPath,
    `fixtures/evals/gate1/tasks/${benchmarkCase.stack}.md`,
    `${label}.task.path`,
  );
  validatePrompt(benchmarkCase.prompt, `${label}.prompt`);
  validateModelAdapter(benchmarkCase.modelAdapter, `${label}.modelAdapter`);

  const selectedPaths = validateChangedPaths(benchmarkCase.selectedPaths, `${label}.selectedPaths`);
  const allowedChangedPaths = validateChangedPaths(
    benchmarkCase.allowedChangedPaths,
    `${label}.allowedChangedPaths`,
  );
  const expectedChangedPaths = validateChangedPaths(
    benchmarkCase.expectedChangedPaths,
    `${label}.expectedChangedPaths`,
  );
  const canonicalPaths = JSON.stringify(selectedPaths);
  if (
    JSON.stringify(allowedChangedPaths) !== canonicalPaths ||
    JSON.stringify(expectedChangedPaths) !== canonicalPaths
  ) {
    fail(`${label} selected, allowed, and expected path arrays must be byte-exact`);
  }
  for (const path of selectedPaths) {
    if (!repository.files.some((file) => file.path === path)) {
      fail(`${label}.selectedPaths contains a path absent from repository.files`);
    }
  }
  validateExpectedChanges(
    benchmarkCase.expectedChanges,
    expectedChangedPaths,
    repository.files,
    benchmarkCase.stack,
    `${label}.expectedChanges`,
  );
  validateChecks(benchmarkCase.checks, benchmarkCase.stack, `${label}.checks`);
  validateSandbox(benchmarkCase.sandbox, `${label}.sandbox`);
  validateBudgets(benchmarkCase.budgets, expectedChangedPaths.length, `${label}.budgets`);
  validateSourceImmutability(benchmarkCase.sourceImmutability, `${label}.sourceImmutability`);
  validateRestartRecovery(benchmarkCase.restartRecovery, `${label}.restartRecovery`);
  const candidate = validateCandidate(benchmarkCase.candidate, repository, `${label}.candidate`);
  validateDraftPullRequestEvidence(
    benchmarkCase.draftPullRequestEvidence,
    repository,
    candidate,
    `${label}.draftPullRequestEvidence`,
  );
  validateReceiptEvidence(benchmarkCase.receiptEvidence, `${label}.receiptEvidence`);
  validateAcceptance(benchmarkCase.acceptance, `${label}.acceptance`);

  return {
    id,
    stack: benchmarkCase.stack,
    fixturePath: repository.fixturePath,
    githubIdentity: repository.githubIdentity,
    taskPath,
  };
}

/**
 * Validate the committed Gate 1 benchmark input contract without reading files,
 * resolving credentials, invoking Git, or performing network or remote effects.
 */
export function validateGate1BenchmarkManifest(value) {
  const manifest = assertPlainRecord(value, "root", TOP_LEVEL_KEYS);
  assertLiteral(manifest.schemaVersion, 1, "schemaVersion");
  assertLiteral(manifest.benchmarkId, "gate1-verified-change", "benchmarkId");
  assertLiteral(
    manifest.benchmarkRevision,
    "gate1-three-repository-repair-v1",
    "benchmarkRevision",
  );
  assertLiteral(manifest.digestEncoding, "raw-bytes-sha256-lowercase-hex", "digestEncoding");
  assertLiteral(manifest.resultSchemaVersion, 1, "resultSchemaVersion");
  validateExecutionBoundary(manifest.executionBoundary);
  validateReleaseGate(manifest.releaseGate);

  const cases = assertArray(manifest.cases, "cases", 3, 3).map((entry, index) =>
    validateCase(entry, index),
  );
  for (const [field, label] of [
    ["id", "case IDs"],
    ["stack", "case stacks"],
    ["fixturePath", "repository fixture paths"],
    ["githubIdentity", "GitHub repository identities"],
    ["taskPath", "task fixture paths"],
  ]) {
    const values = cases.map((entry) => entry[field]);
    if (new Set(values).size !== cases.length) fail(`${label} must be unique`);
  }

  return manifest;
}
