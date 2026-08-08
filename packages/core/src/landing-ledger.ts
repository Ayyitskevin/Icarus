/**
 * Durable Git landing ledger (ADR 0027, Packet 3 local-landing slice).
 *
 * The accepted DDL deliberately has no transaction/batch identifier. Writer
 * methods below therefore make their source rows and ordered events atomic;
 * the reader validates those rows, event correlation, and state replay, but
 * never claims it can reconstruct historical transaction grouping.
 */
import type Database from "better-sqlite3";

import { sha256 } from "./digest.js";
import { IcarusError } from "./errors.js";
import { validateGitHubPreflightHttpHistoryV1 } from "./landing-http-history.js";
import {
  type PersistedGitHubPreflightEvidenceV1,
  validatePersistedGitHubPreflightOperationV1,
} from "./landing-preflight-persistence.js";
import {
  assertGitInstant,
  assertInstant,
  assertLandingCredentialEnvironmentAllowed,
  assertLandingDigestTextBindingsV1,
  assertSafeCode,
  assertSha1,
  assertSha256,
  assertUuid,
  type CandidateReadyValueV1,
  canonicalizeCommitMessage,
  canonicalizePullRequestBodyPrefix,
  canonicalizePullRequestTitle,
  canonicalLandingJson,
  commitEpochToGitInstant,
  DERIVATIVE_EFFECTS,
  DERIVATIVE_GITHUB_EVENTS,
  DIRECT_ICARUS_EFFECTS,
  decodeCanonicalLandingJson,
  decodeChangedPathsDigestV1,
  decodeGitHubLandingProfileV1,
  decodeLandingDecisionV1,
  decodeLandingDigestV1,
  decodeLandingEventPayloadV1,
  decodeLandingHttpRequestV1,
  decodeLandingHttpResultV1,
  decodeLandingOperationObservationV1,
  decodeLandingOperationRequestV1,
  decodeLandingOperationResultV1,
  decodeLocalRefFactV1,
  decodeReviewDecisionDigestV1,
  digestLandingRecord,
  GITHUB_API_VERSION,
  type GitHubLandingProfileV1,
  type LandingDecisionV1,
  type LandingDigestV1,
  type LandingEventPayloadV1,
  type LandingHttpRequestV1,
  type LandingHttpResultV1,
  type LandingOperationObservationV1,
  type LandingOperationRequestV1,
  type LandingOperationResultV1,
  type LandingStateChangedEventV1,
  type LocalRefFactV1,
  type LocalRefReadyValueV1,
  type ReconcileValueV1,
  type ReconciliationRequiredValueV1,
  renderPullRequestBodyV1,
} from "./landing-records.js";
import {
  assertLandingStateResumePair,
  assertLandingTransition,
  canStartLandingOperation,
  isLandingOperationKindV1,
  isLandingResumeStateV1,
  isLandingStateV1,
  type LandingOperationKindV1,
  type LandingResumeStateV1,
  type LandingStateV1,
} from "./landing-state.js";
import { assertOperatorActor } from "./policy.js";
import type { CheckpointFile } from "./types.js";

type Row = Record<string, unknown>;
type JsonRecord = Record<string, unknown>;

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const PACKET3_STATES: ReadonlySet<LandingStateV1> = new Set([
  "preparing_candidate",
  "awaiting_approval",
  "approved",
  "creating_local_ref",
  "local_ready",
  "reconciliation_required",
  "rejected",
  "abandoned",
  "failed",
]);
const LOADER_OPERATION_KINDS: ReadonlySet<LandingOperationKindV1> = new Set([
  "candidate.prepare",
  "local_ref.create",
  "github.preflight",
  "landing.reconcile",
]);
const LANDING_LOADER_MAX_ATTEMPTS = 8;
const LANDING_LOADER_MAX_EVENTS = 128;
const LANDING_LOADER_JSON_MAX_BYTES = 64 * 1024;
const LANDING_LOADER_ID_MAX_BYTES = 64;
const LANDING_LOADER_KIND_MAX_BYTES = 128;
const LANDING_LOADER_STATUS_MAX_BYTES = 16;
const LANDING_LOADER_DIGEST_MAX_BYTES = 64;
const LANDING_LOADER_ERROR_MAX_BYTES = 128;
const LANDING_LOADER_TIMESTAMP_MAX_BYTES = 64;
const LANDING_COORDINATOR_TAKEOVER = "LANDING_COORDINATOR_TAKEOVER";
const GITHUB_OUTCOME_AMBIGUOUS = "GITHUB_OUTCOME_AMBIGUOUS";
const ABSENT_LOCAL_REF_FACT_SHA256 = digestLandingRecord({
  schemaVersion: 1,
  state: "absent",
  objectSha1: null,
  symbolicTargetSha256: null,
});

function invalid(message: string, details: Readonly<Record<string, unknown>> = {}): never {
  throw new IcarusError("LANDING_RECORD_INVALID", message, details);
}

function expectRow(value: unknown, field: string): Row {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(field + " row is missing");
  }
  return value as Row;
}

function exactDataRecord(value: unknown, keys: readonly string[], field: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(`${field} must be an object`);
  }
  let prototype: object | null;
  let ownKeys: (string | symbol)[];
  try {
    prototype = Object.getPrototypeOf(value);
    ownKeys = Reflect.ownKeys(value);
  } catch {
    return invalid(`${field} cannot expose a stable own-key set`);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    invalid(`${field} must be a plain object`);
  }
  const actual: string[] = [];
  for (const key of ownKeys) {
    if (typeof key !== "string") invalid(`${field} cannot contain symbol members`);
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    } catch {
      return invalid(`${field} cannot expose stable own-property descriptors`);
    }
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      invalid(`${field} members must be enumerable own data properties`);
    }
    actual.push(key);
  }
  actual.sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || !actual.every((key, index) => key === expected[index])) {
    invalid(`${field} does not have the exact expected members`);
  }
  return value as JsonRecord;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string") invalid(field + " is not text");
  return value;
}

function nullableText(value: unknown, field: string): string | null {
  return value === null ? null : text(value, field);
}

function integer(value: unknown, field: string, minimum = 0, maximum = MAX_SAFE): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    invalid(field + " is not a bounded safe integer");
  }
  return value;
}

function oneOf<const T extends readonly string[]>(
  value: unknown,
  values: T,
  field: string,
): T[number] {
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
    invalid(field + " has an unsupported value");
  }
  return value as T[number];
}

function decodeCanonical<T>(encoded: unknown, field: string, decode: (value: unknown) => T): T {
  return decodeCanonicalLandingJson(text(encoded, field), decode);
}

function requireDigest(encoded: string, expected: unknown, field: string): string {
  const digest = assertSha256(expected, field);
  if (sha256(encoded) !== digest) invalid(field + " does not match canonical bytes");
  return digest;
}

function runImmediate<T>(transaction: { immediate(): T }): T {
  try {
    return transaction.immediate();
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof (error as { readonly code?: unknown }).code === "string" &&
      (error as { readonly code: string }).code.startsWith("SQLITE_BUSY")
    ) {
      throw new IcarusError("RUN_BUSY", "Another process is updating landing state");
    }
    throw error;
  }
}

export interface LandingProfileRecordV1 {
  readonly projectId: string;
  readonly profile: GitHubLandingProfileV1;
  readonly profileSha256: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface LandingEligibilityV1 {
  readonly runId: string;
  readonly projectId: string;
  readonly profile: GitHubLandingProfileV1;
  readonly profileSha256: string;
  readonly cachePath: string;
  readonly baseCommitSha1: string;
  readonly planSha256: string;
  readonly reviewedDiff: string;
  readonly diffSha256: string;
  readonly checkpointSha256: string;
  readonly checkpointFiles: readonly CheckpointFile[];
  readonly verificationSha256: string;
  readonly reviewDecisionId: string;
  readonly reviewDecisionSha256: string;
  readonly changedPaths: readonly string[];
  readonly changedPathsSha256: string;
}

export interface CreateLandingInputV1 {
  readonly runId: string;
  readonly baseTreeSha1: string;
  readonly commitMessage: string;
  readonly commitEpochSeconds: number;
  readonly commitIso8601: string;
  readonly pullRequestTitle: string;
  readonly pullRequestBodyPrefix: string;
}

export interface CandidateSettlementInputV1 {
  readonly candidateTreeSha1: string;
  readonly candidateCommitSha1: string;
  readonly candidateCommitPayloadSha256: string;
  readonly candidateObjectManifestSha256: string;
  readonly candidateCredentialAuditSha256: string;
  readonly landingDigest: LandingDigestV1;
  readonly pullRequestBodySha256: string;
}

export type LandingDecisionRecordV1 = LandingDecisionV1;

export interface LandingAttemptRecordV1 {
  readonly landingId: string;
  readonly ordinal: number;
  readonly status: "started" | "completed" | "failed" | "interrupted";
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly errorCode: string | null;
}

export interface LandingOperationRecordV1 {
  readonly id: string;
  readonly landingId: string;
  readonly coordinatorAttempt: number;
  readonly kind:
    | "candidate.prepare"
    | "local_ref.create"
    | "github.preflight"
    | "landing.reconcile";
  readonly kindAttempt: number;
  readonly status: "started" | "completed" | "failed" | "interrupted";
  readonly requestSha256: string;
  readonly request: LandingOperationRequestV1;
  readonly observationSha256: string | null;
  readonly observation: LandingOperationObservationV1 | null;
  readonly resultSha256: string | null;
  readonly result: LandingOperationResultV1 | null;
  readonly errorCode: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

export interface LandingEventRecordV1 {
  readonly sequence: number;
  readonly landingId: string;
  readonly type:
    | "landing.attempt.started"
    | "landing.attempt.settled"
    | "landing.operation.started"
    | "landing.operation.settled"
    | "landing.github.request.admitted"
    | "landing.github.request.settled"
    | "landing.state.changed"
    | "landing.decision.recorded";
  readonly payload: LandingEventPayloadV1;
  readonly createdAt: string;
}

export interface LandingRecordV1 {
  readonly id: string;
  readonly runId: string;
  readonly projectId: string;
  readonly policyVersion: 1;
  readonly state: LandingStateV1;
  readonly resumeState: LandingResumeStateV1 | null;
  readonly profile: GitHubLandingProfileV1;
  readonly profileSha256: string;
  readonly baseCommitSha1: string;
  readonly baseTreeSha1: string;
  readonly planSha256: string;
  readonly diffSha256: string;
  readonly checkpointSha256: string;
  readonly verificationSha256: string;
  readonly reviewDecisionId: string;
  readonly reviewDecisionSha256: string;
  readonly changedPaths: readonly string[];
  readonly changedPathsSha256: string;
  readonly credentialAuditSha256: string | null;
  readonly headRef: string;
  readonly commitMessage: string;
  readonly commitMessageSha256: string;
  readonly commitEpochSeconds: number;
  readonly commitIso8601: string;
  readonly pullRequestTitle: string;
  readonly pullRequestTitleSha256: string;
  readonly pullRequestBodyPrefix: string;
  readonly pullRequestBodyPrefixSha256: string;
  readonly pullRequestBodySha256: string | null;
  readonly candidateTreeSha1: string | null;
  readonly candidateCommitSha1: string | null;
  readonly candidateCommitPayloadSha256: string | null;
  readonly landingSha256: string | null;
  readonly errorCode: string | null;
  readonly attemptCount: number;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface LandingStatusV1 {
  readonly landing: LandingRecordV1;
  readonly decision: LandingDecisionRecordV1 | null;
  readonly attempts: readonly LandingAttemptRecordV1[];
  readonly operations: readonly LandingOperationRecordV1[];
  readonly events: readonly LandingEventRecordV1[];
  readonly revision: number;
}

export interface LandingResumeAdmissionV1 {
  readonly status: LandingStatusV1;
  readonly attemptOrdinal: number | null;
  readonly operationId: string | null;
  readonly attemptLimitReached: boolean;
}

export interface LandingOperationAdmissionV1 {
  readonly status: LandingStatusV1;
  readonly operationId: string;
}

export interface LandingGitHubPreflightRequestAdmissionV1 {
  readonly status: LandingStatusV1;
  readonly request: LandingHttpRequestV1 & {
    readonly operationKind: "github.preflight";
    readonly method: "GET";
  };
  readonly requestSha256: string;
}

export interface LandingGitHubAdmittedRequestClaimV1 {
  readonly request: LandingHttpRequestV1 & {
    readonly operationKind: "github.preflight";
    readonly method: "GET";
  };
  readonly landingSha256: string;
}

export interface LandingGitHubPreflightSettlementInputV1 {
  readonly request: LandingHttpRequestV1 & {
    readonly operationKind: "github.preflight";
    readonly method: "GET";
  };
  readonly requestSha256: string;
  readonly result: LandingHttpResultV1;
  readonly resultSha256: string;
}

export interface LocalRefSettlementInputV1 {
  /** Exact bounded execution outcome; the store derives created vs reconciled. */
  readonly outcome: "succeeded" | "failed" | "ambiguous";
  readonly errorCode: string | null;
  /** Exact replay of the durable pre-effect observation, or null if it was rejected before persistence. */
  readonly observedFact: LocalRefFactV1 | null;
  /** Fresh post-effect fact. Required for a successful created/reconciled settlement. */
  readonly postEffectFact: LocalRefFactV1 | null;
}

export interface LocalRefReconciliationSettlementInputV1 {
  readonly outcome: "local_ready" | "retry_approved" | "reconciliation_required";
  readonly errorCode: string | null;
  readonly fact: LocalRefFactV1 | null;
}

export interface LandingRunProjectionV1 {
  readonly landingId: string;
  readonly state: LandingStateV1;
  readonly resumeState: LandingResumeStateV1 | null;
  readonly version: number;
  readonly landingSha256: string | null;
  readonly candidateCommitSha1: string | null;
  readonly pullRequestTitle: string;
  readonly pullRequestBody: string | null;
  readonly derivativeEffects: GitHubLandingProfileV1["derivativeEffects"];
  readonly decision: {
    readonly actor: string;
    readonly decision: "approve" | "reject";
    readonly createdAt: string;
  } | null;
  readonly errorCode: string | null;
  readonly updatedAt: string;
}

export interface LandingRunProjectionSnapshotV1 {
  readonly landing: LandingRunProjectionV1 | null;
  readonly landingRevision: number;
}

function decodeProfileRow(entry: unknown): LandingProfileRecordV1 {
  const value = expectRow(entry, "landing profile");
  const projectId = assertUuid(value.project_id, "landing_profiles.project_id");
  const profile: GitHubLandingProfileV1 = {
    version: integer(value.profile_version, "landing_profiles.profile_version", 1, 1) as 1,
    provider:
      text(value.provider, "landing_profiles.provider") === "github"
        ? "github"
        : invalid("Landing profile provider is invalid"),
    owner: text(value.owner, "landing_profiles.owner"),
    repository: text(value.repository, "landing_profiles.repository"),
    baseBranch: text(value.base_branch, "landing_profiles.base_branch"),
    branchNamespace:
      text(value.branch_namespace, "landing_profiles.branch_namespace") === "icarus/"
        ? "icarus/"
        : invalid("Landing profile namespace is invalid"),
    credentialRef: {
      kind: "environment",
      name: text(value.credential_env, "landing_profiles.credential_env"),
    },
    expectedActor: text(value.expected_actor, "landing_profiles.expected_actor"),
    commitIdentity: {
      name: text(value.commit_name, "landing_profiles.commit_name"),
      email: text(value.commit_email, "landing_profiles.commit_email"),
    },
    derivativeEffects: {
      version: 1,
      disposition: oneOf(
        value.derivative_effects_disposition,
        ["inert-repository", "operator-approved"] as const,
        "landing_profiles.derivative_effects_disposition",
      ),
      evidenceSha256: assertSha256(
        value.derivative_effects_evidence_sha256,
        "landing_profiles.derivative_effects_evidence_sha256",
      ),
    },
  };
  const decoded = decodeGitHubLandingProfileV1(profile);
  const profileSha256 = assertSha256(value.profile_sha256, "landing_profiles.profile_sha256");
  if (digestLandingRecord(decoded) !== profileSha256) {
    invalid("Landing profile digest does not match its SQL projection");
  }
  return {
    projectId,
    profile: decoded,
    profileSha256,
    createdAt: assertInstant(value.created_at, "landing_profiles.created_at"),
    updatedAt: assertInstant(value.updated_at, "landing_profiles.updated_at"),
  };
}

function decodeLandingRow(entry: unknown): LandingRecordV1 {
  const value = expectRow(entry, "landing");
  const id = assertUuid(value.id, "landings.id");
  const runId = assertUuid(value.run_id, "landings.run_id");
  const projectId = assertUuid(value.project_id, "landings.project_id");
  const stateValue = text(value.state, "landings.state");
  if (!isLandingStateV1(stateValue) || !PACKET3_STATES.has(stateValue)) {
    invalid("Landing state is outside the implemented local-landing slice");
  }
  const resumeValue = nullableText(value.resume_state, "landings.resume_state");
  if (resumeValue !== null && !isLandingResumeStateV1(resumeValue)) {
    invalid("Landing resume state is invalid");
  }
  assertLandingStateResumePair(stateValue, resumeValue);
  const profileEncoded = text(value.profile_json, "landings.profile_json");
  const profile = decodeCanonical(
    profileEncoded,
    "landings.profile_json",
    decodeGitHubLandingProfileV1,
  );
  const profileSha256 = requireDigest(
    profileEncoded,
    value.profile_sha256,
    "landings.profile_sha256",
  );
  const changedPathsEncoded = text(value.changed_paths_json, "landings.changed_paths_json");
  const changedPathsRecord = decodeCanonical(
    changedPathsEncoded,
    "landings.changed_paths_json",
    decodeChangedPathsDigestV1,
  );
  const changedPathsSha256 = requireDigest(
    changedPathsEncoded,
    value.changed_paths_sha256,
    "landings.changed_paths_sha256",
  );
  const commitMessage = text(value.commit_message, "landings.commit_message");
  const pullRequestTitle = text(value.pull_request_title, "landings.pull_request_title");
  const pullRequestBodyPrefix = text(
    value.pull_request_body_prefix,
    "landings.pull_request_body_prefix",
  );
  if (
    canonicalizeCommitMessage(commitMessage) !== commitMessage ||
    canonicalizePullRequestTitle(pullRequestTitle) !== pullRequestTitle ||
    canonicalizePullRequestBodyPrefix(pullRequestBodyPrefix) !== pullRequestBodyPrefix
  ) {
    invalid("Persisted landing text is not canonical");
  }
  const commitEpochSeconds = integer(
    value.commit_epoch_seconds,
    "landings.commit_epoch_seconds",
    0,
    253_402_300_799,
  );
  const commitIso8601 = assertGitInstant(value.commit_iso8601, "landings.commit_iso8601");
  if (commitEpochToGitInstant(commitEpochSeconds) !== commitIso8601) {
    invalid("Landing commit epoch and instant disagree");
  }
  const candidateTreeSha1 =
    value.candidate_tree_sha1 === null
      ? null
      : assertSha1(value.candidate_tree_sha1, "landings.candidate_tree_sha1");
  const candidateCommitSha1 =
    value.candidate_commit_sha1 === null
      ? null
      : assertSha1(value.candidate_commit_sha1, "landings.candidate_commit_sha1");
  const candidateCommitPayloadSha256 =
    value.candidate_commit_payload_sha256 === null
      ? null
      : assertSha256(
          value.candidate_commit_payload_sha256,
          "landings.candidate_commit_payload_sha256",
        );
  const credentialAuditSha256 =
    value.credential_audit_sha256 === null
      ? null
      : assertSha256(value.credential_audit_sha256, "landings.credential_audit_sha256");
  const pullRequestBodySha256 =
    value.pull_request_body_sha256 === null
      ? null
      : assertSha256(value.pull_request_body_sha256, "landings.pull_request_body_sha256");
  const landingSha256 =
    value.landing_sha256 === null
      ? null
      : assertSha256(value.landing_sha256, "landings.landing_sha256");
  const candidatePresence = [
    candidateTreeSha1,
    candidateCommitSha1,
    candidateCommitPayloadSha256,
    credentialAuditSha256,
    pullRequestBodySha256,
    landingSha256,
  ].map((entry) => entry !== null);
  if (candidatePresence.some(Boolean) && !candidatePresence.every(Boolean)) {
    invalid("Landing candidate settlement columns are only partially present");
  }
  const candidateRequiredStates: ReadonlySet<LandingStateV1> = new Set([
    "awaiting_approval",
    "approved",
    "creating_local_ref",
    "local_ready",
    "reconciliation_required",
    "rejected",
  ]);
  if (
    (stateValue === "preparing_candidate" && candidatePresence.some(Boolean)) ||
    (candidateRequiredStates.has(stateValue) && !candidatePresence.every(Boolean)) ||
    (stateValue === "failed" &&
      ((resumeValue === "preparing_candidate" && candidatePresence.some(Boolean)) ||
        ((resumeValue === "approved" || resumeValue === "local_ready") &&
          !candidatePresence.every(Boolean))))
  ) {
    invalid("Landing state and candidate settlement columns disagree");
  }
  const errorCode =
    value.error_code === null ? null : assertSafeCode(value.error_code, "landings.error_code");
  if (
    ((stateValue === "failed" || stateValue === "reconciliation_required") && errorCode === null) ||
    (!(stateValue === "failed" || stateValue === "reconciliation_required") && errorCode !== null)
  ) {
    invalid("Landing state and error code disagree");
  }
  const headRef = text(value.head_ref, "landings.head_ref");
  if (headRef !== "refs/heads/icarus/" + runId) {
    invalid("Landing head ref does not bind the run identity");
  }
  return {
    id,
    runId,
    projectId,
    policyVersion: integer(value.policy_version, "landings.policy_version", 1, 1) as 1,
    state: stateValue,
    resumeState: resumeValue,
    profile,
    profileSha256,
    baseCommitSha1: assertSha1(value.base_commit_sha1, "landings.base_commit_sha1"),
    baseTreeSha1: assertSha1(value.base_tree_sha1, "landings.base_tree_sha1"),
    planSha256: assertSha256(value.plan_sha256, "landings.plan_sha256"),
    diffSha256: assertSha256(value.diff_sha256, "landings.diff_sha256"),
    checkpointSha256: assertSha256(value.checkpoint_sha256, "landings.checkpoint_sha256"),
    verificationSha256: assertSha256(value.verification_sha256, "landings.verification_sha256"),
    reviewDecisionId: assertUuid(value.review_decision_id, "landings.review_decision_id"),
    reviewDecisionSha256: assertSha256(
      value.review_decision_sha256,
      "landings.review_decision_sha256",
    ),
    changedPaths: changedPathsRecord.paths,
    changedPathsSha256,
    credentialAuditSha256,
    headRef,
    commitMessage,
    commitMessageSha256: requireDigest(
      commitMessage,
      value.commit_message_sha256,
      "landings.commit_message_sha256",
    ),
    commitEpochSeconds,
    commitIso8601,
    pullRequestTitle,
    pullRequestTitleSha256: requireDigest(
      pullRequestTitle,
      value.pull_request_title_sha256,
      "landings.pull_request_title_sha256",
    ),
    pullRequestBodyPrefix,
    pullRequestBodyPrefixSha256: requireDigest(
      pullRequestBodyPrefix,
      value.pull_request_body_prefix_sha256,
      "landings.pull_request_body_prefix_sha256",
    ),
    pullRequestBodySha256,
    candidateTreeSha1,
    candidateCommitSha1,
    candidateCommitPayloadSha256,
    landingSha256,
    errorCode,
    attemptCount: integer(value.attempt_count, "landings.attempt_count", 0, 8),
    version: integer(value.version, "landings.version"),
    createdAt: assertInstant(value.created_at, "landings.created_at"),
    updatedAt: assertInstant(value.updated_at, "landings.updated_at"),
  };
}

function decodeDecisionRow(entry: unknown, landing: LandingRecordV1): LandingDecisionRecordV1 {
  const value = expectRow(entry, "landing decision");
  const record = decodeLandingDecisionV1({
    id: assertUuid(value.id, "landing_decisions.id"),
    landingId: assertUuid(value.landing_id, "landing_decisions.landing_id"),
    landingSha256: assertSha256(value.landing_sha256, "landing_decisions.landing_sha256"),
    actor: text(value.actor, "landing_decisions.actor"),
    decision: oneOf(value.decision, ["approve", "reject"] as const, "landing_decisions.decision"),
    createdAt: assertInstant(value.created_at, "landing_decisions.created_at"),
  });
  if (record.landingId !== landing.id || record.landingSha256 !== landing.landingSha256) {
    invalid("Landing decision does not bind its landing digest");
  }
  return record;
}

function decodeAttemptRow(entry: unknown, landingId: string): LandingAttemptRecordV1 {
  const value = expectRow(entry, "landing attempt");
  const status = oneOf(
    value.status,
    ["started", "completed", "failed", "interrupted"] as const,
    "landing_attempts.status",
  );
  const finishedAt =
    value.finished_at === null
      ? null
      : assertInstant(value.finished_at, "landing_attempts.finished_at");
  const errorCode =
    value.error_code === null
      ? null
      : assertSafeCode(value.error_code, "landing_attempts.error_code");
  if (
    (status === "started" && (finishedAt !== null || errorCode !== null)) ||
    (status === "completed" && (finishedAt === null || errorCode !== null)) ||
    ((status === "failed" || status === "interrupted") &&
      (finishedAt === null || errorCode === null))
  ) {
    invalid("Landing attempt settlement columns disagree");
  }
  const record: LandingAttemptRecordV1 = {
    landingId: assertUuid(value.landing_id, "landing_attempts.landing_id"),
    ordinal: integer(value.ordinal, "landing_attempts.ordinal", 1, 8),
    status,
    startedAt: assertInstant(value.started_at, "landing_attempts.started_at"),
    finishedAt,
    errorCode,
  };
  if (record.landingId !== landingId) invalid("Landing attempt belongs to another landing");
  return record;
}

function decodeOperationRow(entry: unknown, landing: LandingRecordV1): LandingOperationRecordV1 {
  const value = expectRow(entry, "landing operation");
  const kindValue = text(value.kind, "landing_operations.kind");
  if (!isLandingOperationKindV1(kindValue) || !LOADER_OPERATION_KINDS.has(kindValue)) {
    invalid("Landing operation is outside the implemented local-landing slice");
  }
  const requestEncoded = text(value.request_json, "landing_operations.request_json");
  const request = decodeCanonical(
    requestEncoded,
    "landing_operations.request_json",
    decodeLandingOperationRequestV1,
  );
  const requestSha256 = requireDigest(
    requestEncoded,
    value.request_sha256,
    "landing_operations.request_sha256",
  );
  const status = oneOf(
    value.status,
    ["started", "completed", "failed", "interrupted"] as const,
    "landing_operations.status",
  );
  const observation =
    value.observation_json === null
      ? null
      : decodeCanonical(
          value.observation_json,
          "landing_operations.observation_json",
          decodeLandingOperationObservationV1,
        );
  const observationSha256 =
    observation === null
      ? value.observation_sha256 === null
        ? null
        : invalid("Landing observation digest exists without bytes")
      : requireDigest(
          text(value.observation_json, "landing_operations.observation_json"),
          value.observation_sha256,
          "landing_operations.observation_sha256",
        );
  const result =
    value.result_json === null
      ? null
      : decodeCanonical(
          value.result_json,
          "landing_operations.result_json",
          decodeLandingOperationResultV1,
        );
  const resultSha256 =
    result === null
      ? value.result_sha256 === null
        ? null
        : invalid("Landing result digest exists without bytes")
      : requireDigest(
          text(value.result_json, "landing_operations.result_json"),
          value.result_sha256,
          "landing_operations.result_sha256",
        );
  const errorCode =
    value.error_code === null
      ? null
      : assertSafeCode(value.error_code, "landing_operations.error_code");
  const finishedAt =
    value.finished_at === null
      ? null
      : assertInstant(value.finished_at, "landing_operations.finished_at");
  if (
    (status === "started" &&
      (result !== null || resultSha256 !== null || errorCode !== null || finishedAt !== null)) ||
    (status === "completed" &&
      (result?.outcome !== "completed" || errorCode !== null || finishedAt === null)) ||
    (status === "failed" &&
      (result?.outcome !== "failed" || result.errorCode !== errorCode || finishedAt === null)) ||
    (status === "interrupted" &&
      (result === null ||
        (result.outcome !== "interrupted" && result.outcome !== "reconciliation_required") ||
        result.errorCode !== errorCode ||
        finishedAt === null))
  ) {
    invalid("Landing operation settlement columns disagree");
  }
  const expectedEvidence = observation?.facts ?? [];
  if (
    result !== null &&
    request.kind !== "github.preflight" &&
    (result.evidence.length !== expectedEvidence.length ||
      !result.evidence.every(
        (fact, index) =>
          fact.requestId === expectedEvidence[index]?.requestId &&
          fact.resultSha256 === expectedEvidence[index]?.resultSha256,
      ))
  ) {
    invalid("Landing operation result evidence does not match its observation");
  }
  if (
    (request.kind === "candidate.prepare" && observation !== null) ||
    (observation !== null &&
      (observation.operationId !== request.operationId ||
        observation.kind !== request.kind ||
        (request.kind === "local_ref.create" &&
          (observation.phase !== "pre_effect" ||
            observation.facts.length !== 1 ||
            observation.facts[0]?.fact !== "local_ref" ||
            observation.facts[0].requestId !== null)) ||
        (request.kind === "landing.reconcile" &&
          (observation.phase !== "reconciliation" ||
            observation.facts.length !== 2 ||
            observation.facts[0]?.fact !== "subject_operation" ||
            observation.facts[0].requestId !== null ||
            observation.facts[1]?.fact !== "local_ref" ||
            observation.facts[1].requestId !== null))))
  ) {
    invalid("Landing observation does not match its local operation request");
  }
  if (
    result !== null &&
    (result.operationId !== request.operationId || result.kind !== request.kind)
  ) {
    invalid("Landing operation result does not match its request");
  }
  const record: LandingOperationRecordV1 = {
    id: assertUuid(value.id, "landing_operations.id"),
    landingId: assertUuid(value.landing_id, "landing_operations.landing_id"),
    coordinatorAttempt: integer(
      value.coordinator_attempt,
      "landing_operations.coordinator_attempt",
      1,
      8,
    ),
    kind: kindValue as LandingOperationRecordV1["kind"],
    kindAttempt: integer(value.kind_attempt, "landing_operations.kind_attempt", 1, 9),
    status,
    requestSha256,
    request,
    observationSha256,
    observation,
    resultSha256,
    result,
    errorCode,
    startedAt: assertInstant(value.started_at, "landing_operations.started_at"),
    finishedAt,
  };
  if (
    record.id !== request.operationId ||
    record.landingId !== landing.id ||
    request.landingId !== landing.id ||
    record.coordinatorAttempt !== request.coordinatorAttempt ||
    record.kind !== request.kind ||
    record.kindAttempt !== request.kindAttempt
  ) {
    invalid("Landing operation SQL columns and request disagree");
  }
  return record;
}

function decodeEventRow(
  entry: unknown,
  landingId: string,
  expectedSequence: number,
): LandingEventRecordV1 {
  const value = expectRow(entry, "landing event");
  const type = oneOf(
    value.type,
    [
      "landing.attempt.started",
      "landing.attempt.settled",
      "landing.operation.started",
      "landing.operation.settled",
      "landing.github.request.admitted",
      "landing.github.request.settled",
      "landing.state.changed",
      "landing.decision.recorded",
    ] as const,
    "landing_events.type",
  );
  const payload = decodeCanonical(value.payload_json, "landing_events.payload_json", (decoded) =>
    decodeLandingEventPayloadV1(type, decoded),
  );
  const event: LandingEventRecordV1 = {
    sequence: integer(value.sequence, "landing_events.sequence", 1),
    landingId: assertUuid(value.landing_id, "landing_events.landing_id"),
    type,
    payload,
    createdAt: assertInstant(value.created_at, "landing_events.created_at"),
  };
  if (
    event.sequence !== expectedSequence ||
    event.landingId !== landingId ||
    payload.landingId !== landingId
  ) {
    invalid("Landing event sequence or identity is invalid");
  }
  return event;
}

function eventMatches(event: LandingEventRecordV1, expected: JsonRecord): boolean {
  return canonicalLandingJson(event.payload) === canonicalLandingJson(expected);
}

function localReconciliationSubject(status: LandingStatusV1): LandingOperationRecordV1 {
  const subjects = status.operations.filter(
    (operation) =>
      operation.kind === "local_ref.create" &&
      operation.status === "interrupted" &&
      operation.result?.outcome === "reconciliation_required" &&
      operation.result.value !== null &&
      "subjectOperationId" in operation.result.value &&
      operation.result.value.subjectOperationId === operation.id,
  );
  const subject = subjects.at(-1);
  if (subject === undefined || subject.resultSha256 === null) {
    invalid("Landing does not have a current unresolved local-ref subject");
  }
  const chain = status.operations.filter(
    (operation) =>
      operation.kind === "landing.reconcile" &&
      operation.coordinatorAttempt > subject.coordinatorAttempt,
  );
  for (const [index, link] of chain.entries()) {
    const request = link.request.input as { readonly subjectOperationId: string };
    const value = link.result?.value;
    if (
      request.subjectOperationId !== subject.id ||
      (value !== null &&
        value !== undefined &&
        "subjectOperationId" in value &&
        value.subjectOperationId !== subject.id)
    ) {
      invalid("Local-ref reconciliation chain changed its original subject");
    }
    if (
      (link.status === "interrupted" && link.result?.outcome !== "reconciliation_required") ||
      (link.status === "started" && index !== chain.length - 1) ||
      !(link.status === "interrupted" || link.status === "started")
    ) {
      invalid("Current local-ref reconciliation chain already terminated or is broken");
    }
  }
  return subject;
}

function hasAbsentLocalRefIntent(operation: LandingOperationRecordV1): boolean {
  return (
    operation.observation?.facts.length === 1 &&
    operation.observation.facts[0]?.fact === "local_ref" &&
    operation.observation.facts[0].requestId === null &&
    operation.observation.facts[0].resultSha256 === ABSENT_LOCAL_REF_FACT_SHA256
  );
}

function directLocalRefFactSha256(candidateCommitSha1: string): string {
  return digestLandingRecord({
    schemaVersion: 1,
    state: "direct",
    objectSha1: candidateCommitSha1,
    symbolicTargetSha256: null,
  });
}

function validatePacket3OperationSettlement(
  operation: LandingOperationRecordV1,
  landing: LandingRecordV1,
  operations: readonly LandingOperationRecordV1[],
): void {
  const result = operation.result;
  if (result === null) return;
  if (operation.kind === "candidate.prepare") {
    if (result.outcome === "reconciliation_required") {
      invalid("Candidate preparation cannot create a reconciliation subject");
    }
    return;
  }
  if (operation.kind === "github.preflight") {
    return;
  }
  if (operation.kind === "local_ref.create") {
    if (result.outcome === "interrupted") {
      invalid("Local-ref effect interruption must create a reconciliation subject");
    }
    if (result.outcome === "completed") {
      const value = result.value as LocalRefReadyValueV1;
      if (
        value.headRef !== landing.headRef ||
        value.candidateCommitSha1 !== landing.candidateCommitSha1 ||
        !hasAbsentLocalRefIntent(operation)
      ) {
        invalid("Completed local-ref result lacks its exact landing and absence proof");
      }
    } else if (result.outcome === "reconciliation_required") {
      const value = result.value as ReconciliationRequiredValueV1;
      if (value.subjectOperationId !== operation.id || value.remoteResidue !== "none") {
        invalid("Local-ref reconciliation subject does not self-bind");
      }
    }
    return;
  }
  if (!(result.outcome === "completed" || result.outcome === "reconciliation_required")) {
    invalid("Local-ref reconciliation has an illegal settlement outcome");
  }
  const request = operation.request.input as { readonly subjectOperationId: string };
  const subject = operations.find((entry) => entry.id === request.subjectOperationId);
  if (subject === undefined) invalid("Local-ref reconciliation subject is missing");
  if (result.outcome === "reconciliation_required") {
    const value = result.value as ReconciliationRequiredValueV1;
    if (value.subjectOperationId !== subject.id || value.remoteResidue !== "none") {
      invalid("Unresolved local-ref reconciliation changed its subject or residue");
    }
    // The accepted DDL has no transaction/batch ID. A decisive observation can
    // legitimately belong to a crashed reconciliation that takeover interrupted,
    // and its event adjacency is indistinguishable from ordinary settle+resume.
    // Keep this load-time superset; the ordinary settlement API remains stricter.
    return;
  }
  const value = result.value as ReconcileValueV1;
  const freshFact = operation.observation?.facts[1];
  if (value.subjectOperationId !== subject.id || value.remoteResidue !== "none") {
    invalid("Completed local-ref reconciliation changed its subject or residue");
  }
  if (result.boundary === "subject_settled") {
    const stageValue = value.stageValue as LocalRefReadyValueV1 | null;
    if (
      value.nextState !== "local_ready" ||
      stageValue === null ||
      stageValue.headRef !== landing.headRef ||
      stageValue.candidateCommitSha1 !== landing.candidateCommitSha1 ||
      stageValue.localRefOutcome !== "reconciled" ||
      stageValue.updateRefExitCode !== null ||
      !hasAbsentLocalRefIntent(subject) ||
      freshFact?.fact !== "local_ref" ||
      freshFact.requestId !== null ||
      freshFact.resultSha256 !== directLocalRefFactSha256(landing.candidateCommitSha1 ?? "")
    ) {
      invalid("Local-ref subject settlement lacks exact reconciled stage proof");
    }
  } else if (
    result.boundary !== "retry_stage_proven" ||
    value.nextState !== "approved" ||
    value.stageValue !== null ||
    freshFact?.fact !== "local_ref" ||
    freshFact.requestId !== null ||
    freshFact.resultSha256 !== ABSENT_LOCAL_REF_FACT_SHA256
  ) {
    invalid("Local-ref retry-stage reconciliation has an illegal closed mapping");
  }
}

interface OperationStartAuthorityV1 {
  readonly state: LandingStateV1;
  readonly version: number;
}

function validatePersistedPreflightAggregates(
  status: LandingStatusV1,
  rawOperationRows: readonly unknown[],
  rawHttpRows: readonly unknown[],
  rawEventRows: readonly unknown[],
  operationStartAuthority: ReadonlyMap<string, OperationStartAuthorityV1>,
): number {
  const preflights = status.operations.filter((operation) => operation.kind === "github.preflight");
  const preflightsById = new Map(preflights.map((operation) => [operation.id, operation]));
  const rawOperationRowsById = new Map<string, unknown>();
  for (const rawOperationRow of rawOperationRows) {
    const row = expectRow(rawOperationRow, "landing operation");
    const operationId = assertUuid(row.id, "landing_operations.id");
    if (rawOperationRowsById.has(operationId)) {
      invalid("Landing operation query contains a duplicate identity");
    }
    rawOperationRowsById.set(operationId, rawOperationRow);
  }
  if (rawOperationRowsById.size !== status.operations.length) {
    invalid("Landing operation rows and decoded operations are not bijective");
  }

  const httpRowsByOperation = new Map<string, unknown[]>();
  for (const rawHttpRow of rawHttpRows) {
    const row = expectRow(rawHttpRow, "landing HTTP request");
    const operationId = assertUuid(row.operation_id, "landing_http_requests.operation_id");
    if (!preflightsById.has(operationId)) {
      invalid("Landing HTTP request belongs to an unsupported operation");
    }
    const owned = httpRowsByOperation.get(operationId) ?? [];
    owned.push(rawHttpRow);
    httpRowsByOperation.set(operationId, owned);
  }

  const requestEventsByOperation = new Map<string, unknown[]>();
  const operationEventsByOperation = new Map<string, unknown[]>();
  let requestEventCount = 0;
  for (const [index, event] of status.events.entries()) {
    const rawEvent = rawEventRows[index];
    if (rawEvent === undefined) invalid("Landing event query lost a source row");
    if (
      event.type === "landing.github.request.admitted" ||
      event.type === "landing.github.request.settled"
    ) {
      const operationId = (event.payload as { readonly operationId: string }).operationId;
      if (!preflightsById.has(operationId)) {
        invalid("Landing GitHub request event belongs to an unsupported operation");
      }
      const owned = requestEventsByOperation.get(operationId) ?? [];
      owned.push(rawEvent);
      requestEventsByOperation.set(operationId, owned);
      requestEventCount += 1;
    } else if (
      event.type === "landing.operation.started" ||
      event.type === "landing.operation.settled"
    ) {
      const operationId = (event.payload as { readonly operationId: string }).operationId;
      if (preflightsById.has(operationId)) {
        const owned = operationEventsByOperation.get(operationId) ?? [];
        owned.push(rawEvent);
        operationEventsByOperation.set(operationId, owned);
      }
    }
  }
  if (rawEventRows.length !== status.events.length) {
    invalid("Landing event rows and decoded events are not bijective");
  }

  if (preflights.length === 0) {
    if (rawHttpRows.length !== 0 || requestEventCount !== 0) {
      invalid("Local landing contains remote request evidence without a supported preflight");
    }
    return 0;
  }
  const authority = reconstructLandingDigest(status);
  if (authority === null) {
    invalid("GitHub preflight has no reconstructed immutable landing authority");
  }

  for (const operation of preflights) {
    const attempt = status.attempts[operation.coordinatorAttempt - 1];
    const operationStart = operationStartAuthority.get(operation.id);
    const rawOperationRow = rawOperationRowsById.get(operation.id);
    if (attempt === undefined || operationStart === undefined || rawOperationRow === undefined) {
      invalid("GitHub preflight is missing its attempt, start authority, or source row");
    }
    const evidence = validatePersistedGitHubPreflightOperationV1({
      landing: authority.record,
      landingSha256: authority.sha256,
      operationStartState: operationStart.state,
      operationStartVersion: operationStart.version,
      operationRow: rawOperationRow,
      // This loader rejects a second operation in the attempt, so the sole
      // preflight HTTP grammar starts a fresh coordinator-wide ordinal prefix.
      previousRequestOrdinal: 0,
      httpRows: httpRowsByOperation.get(operation.id) ?? [],
      requestEvents: requestEventsByOperation.get(operation.id) ?? [],
      operationEvents: operationEventsByOperation.get(operation.id) ?? [],
    });
    const operationSettledEvent = status.events.find(
      (event) =>
        event.type === "landing.operation.settled" &&
        (event.payload as { readonly operationId: string }).operationId === operation.id,
    );
    const attemptSettledEvent = status.events.find(
      (event) =>
        event.type === "landing.attempt.settled" &&
        (event.payload as { readonly coordinatorAttempt: number }).coordinatorAttempt ===
          operation.coordinatorAttempt,
    );
    if (
      ((evidence.status === "next_request" || evidence.status === "admitted") &&
        (operation.status !== "started" || attempt.status !== "started")) ||
      (evidence.status === "complete" &&
        (operation.status !== "completed" ||
          !(
            (attempt.status === "started" && attempt.errorCode === null) ||
            (attempt.status === "interrupted" && attempt.errorCode === LANDING_COORDINATOR_TAKEOVER)
          ))) ||
      (evidence.status === "terminal" &&
        evidence.operationOutcome === "failed" &&
        (operation.status !== "failed" ||
          attempt.status !== "failed" ||
          attempt.errorCode !== evidence.errorCode)) ||
      (evidence.status === "terminal" &&
        evidence.operationOutcome === "interrupted" &&
        (operation.status !== "interrupted" ||
          attempt.status !== "interrupted" ||
          attempt.errorCode !== evidence.errorCode)) ||
      (evidence.status === "takeover" &&
        (operation.status !== "interrupted" ||
          operation.errorCode !== LANDING_COORDINATOR_TAKEOVER ||
          attempt.status !== "interrupted" ||
          attempt.errorCode !== LANDING_COORDINATOR_TAKEOVER))
    ) {
      invalid("GitHub preflight evidence disagrees with its owning attempt topology");
    }
    if (evidence.status === "terminal" && evidence.operationOutcome === "failed") {
      const stateEvent =
        attemptSettledEvent === undefined ? undefined : status.events[attemptSettledEvent.sequence];
      if (
        operationSettledEvent === undefined ||
        attemptSettledEvent === undefined ||
        attemptSettledEvent.sequence !== operationSettledEvent.sequence + 1 ||
        stateEvent === undefined ||
        stateEvent.sequence !== attemptSettledEvent.sequence + 1 ||
        stateEvent.type !== "landing.state.changed" ||
        !eventMatches(stateEvent, {
          schemaVersion: 1,
          landingId: status.landing.id,
          from: "local_ready",
          to: "failed",
          version: operationStart.version + 1,
          operationId: operation.id,
        })
      ) {
        invalid("Failed GitHub preflight lacks its exact terminal state-event suffix");
      }
    } else if (
      (evidence.status === "terminal" || evidence.status === "takeover") &&
      evidence.operationOutcome === "interrupted" &&
      status.events.some(
        (event) =>
          event.type === "landing.state.changed" &&
          (event.payload as LandingStateChangedEventV1).operationId === operation.id,
      )
    ) {
      invalid("Ambiguous GitHub preflight cannot emit a self state transition");
    }
  }
  return requestEventCount;
}

function validateAggregate(
  status: LandingStatusV1,
  rawOperationRows: readonly unknown[],
  rawHttpRows: readonly unknown[],
  rawEventRows: readonly unknown[],
): void {
  const { landing, decision, attempts, operations, events } = status;
  if (
    attempts.length === 0 ||
    attempts.length !== landing.attemptCount ||
    !attempts.every((attempt, index) => attempt.ordinal === index + 1)
  ) {
    invalid("Landing attempt ordinals are not contiguous");
  }
  if (attempts.filter((attempt) => attempt.status === "started").length > 1) {
    invalid("Landing has more than one started attempt");
  }
  const kindOrdinals = new Map<string, number>();
  const operationsByAttempt = new Map<number, LandingOperationRecordV1[]>();
  for (const operation of operations) {
    const expectedKindAttempt = (kindOrdinals.get(operation.kind) ?? 0) + 1;
    if (operation.kindAttempt !== expectedKindAttempt) {
      invalid("Landing operation kind attempts are not contiguous");
    }
    kindOrdinals.set(operation.kind, expectedKindAttempt);
    const attempt = attempts[operation.coordinatorAttempt - 1];
    if (attempt === undefined || attempt.landingId !== landing.id) {
      invalid("Landing operation references a missing coordinator attempt");
    }
    const owned = operationsByAttempt.get(operation.coordinatorAttempt) ?? [];
    owned.push(operation);
    operationsByAttempt.set(operation.coordinatorAttempt, owned);
    if (operation.kind === "github.preflight") {
      const topologyMatches =
        ((operation.status === "started" || operation.status === "completed") &&
          attempt.status === "started" &&
          operation.errorCode === null &&
          attempt.errorCode === null) ||
        (operation.status === "completed" &&
          operation.errorCode === null &&
          attempt.status === "interrupted" &&
          attempt.errorCode === LANDING_COORDINATOR_TAKEOVER) ||
        (operation.status === "failed" &&
          attempt.status === "failed" &&
          operation.errorCode === attempt.errorCode) ||
        (operation.status === "interrupted" &&
          attempt.status === "interrupted" &&
          operation.errorCode === attempt.errorCode);
      if (!topologyMatches) {
        invalid("GitHub preflight and coordinator attempt settlements disagree");
      }
    } else if (operation.status !== attempt.status || operation.errorCode !== attempt.errorCode) {
      invalid("Landing operation and coordinator attempt settlements disagree");
    }
    if (operation.request.expectedVersion > landing.version) {
      invalid("Landing operation expects a future landing version");
    }
    if (!canStartLandingOperation(operation.kind, operation.request.expectedState)) {
      invalid("Landing operation request has an illegal expected state");
    }
    validatePacket3OperationSettlement(operation, landing, operations);
    if (operation.kind === "candidate.prepare") {
      const input = operation.request.input as LandingOperationRequestV1["input"] & {
        readonly profileSha256: string;
        readonly baseCommitSha1: string;
        readonly baseTreeSha1: string;
        readonly planSha256: string;
        readonly diffSha256: string;
        readonly checkpointSha256: string;
        readonly verificationSha256: string;
        readonly reviewDecisionSha256: string;
        readonly changedPathsSha256: string;
        readonly headRef: string;
        readonly commitMessageSha256: string;
        readonly commitEpochSeconds: number;
        readonly commitIso8601: string;
        readonly pullRequestTitleSha256: string;
        readonly pullRequestBodyPrefixSha256: string;
      };
      if (
        input.profileSha256 !== landing.profileSha256 ||
        input.baseCommitSha1 !== landing.baseCommitSha1 ||
        input.baseTreeSha1 !== landing.baseTreeSha1 ||
        input.planSha256 !== landing.planSha256 ||
        input.diffSha256 !== landing.diffSha256 ||
        input.checkpointSha256 !== landing.checkpointSha256 ||
        input.verificationSha256 !== landing.verificationSha256 ||
        input.reviewDecisionSha256 !== landing.reviewDecisionSha256 ||
        input.changedPathsSha256 !== landing.changedPathsSha256 ||
        input.headRef !== landing.headRef ||
        input.commitMessageSha256 !== landing.commitMessageSha256 ||
        input.commitEpochSeconds !== landing.commitEpochSeconds ||
        input.commitIso8601 !== landing.commitIso8601 ||
        input.pullRequestTitleSha256 !== landing.pullRequestTitleSha256 ||
        input.pullRequestBodyPrefixSha256 !== landing.pullRequestBodyPrefixSha256
      ) {
        invalid("Candidate operation does not bind the immutable landing snapshot");
      }
    } else if (operation.kind === "local_ref.create") {
      const input = operation.request.input as {
        readonly landingSha256: string;
        readonly headRef: string;
        readonly candidateCommitSha1: string;
      };
      if (
        input.landingSha256 !== landing.landingSha256 ||
        input.headRef !== landing.headRef ||
        input.candidateCommitSha1 !== landing.candidateCommitSha1
      ) {
        invalid("Local-ref operation does not bind the approved landing");
      }
    } else if (operation.kind === "github.preflight") {
      // Exact immutable binding and result evidence are delegated to the pure
      // persisted-preflight aggregate validator after chronological replay.
    } else {
      const input = operation.request.input as {
        readonly landingSha256: string;
        readonly resumeState: string;
        readonly subjectOperationId: string;
        readonly subjectRequestSha256: string;
        readonly subjectResultSha256: string;
      };
      const subject = operations.find((candidate) => candidate.id === input.subjectOperationId);
      if (
        input.landingSha256 !== landing.landingSha256 ||
        input.resumeState !== "approved" ||
        subject?.kind !== "local_ref.create" ||
        subject.status !== "interrupted" ||
        subject.coordinatorAttempt >= operation.coordinatorAttempt ||
        subject.requestSha256 !== input.subjectRequestSha256 ||
        subject.resultSha256 !== input.subjectResultSha256
      ) {
        invalid("Local-ref reconciliation does not bind its settled original subject");
      }
      const resultValue = operation.result?.value;
      if (
        resultValue !== null &&
        resultValue !== undefined &&
        "subjectOperationId" in resultValue &&
        resultValue.subjectOperationId !== subject.id
      ) {
        invalid("Local-ref reconciliation result changed its original subject");
      }
      if (operation.observation !== null) {
        const subjectProjection = {
          schemaVersion: 1,
          operationId: subject.id,
          landingId: subject.landingId,
          coordinatorAttempt: subject.coordinatorAttempt,
          kind: subject.kind,
          kindAttempt: subject.kindAttempt,
          status: subject.status,
          requestSha256: subject.requestSha256,
          observationSha256: subject.observationSha256,
          resultSha256: subject.resultSha256,
          errorCode: subject.errorCode,
        };
        if (
          operation.observation.facts[0]?.fact !== "subject_operation" ||
          operation.observation.facts[0].resultSha256 !== digestLandingRecord(subjectProjection)
        ) {
          invalid("Reconciliation observation does not hash its settled subject projection");
        }
      }
    }
    if (
      operation.result?.kind === "candidate.prepare" &&
      operation.result.outcome === "completed"
    ) {
      const candidate = operation.result.value as CandidateReadyValueV1;
      if (
        candidate.candidateTreeSha1 !== landing.candidateTreeSha1 ||
        candidate.candidateCommitSha1 !== landing.candidateCommitSha1 ||
        candidate.candidateCommitPayloadSha256 !== landing.candidateCommitPayloadSha256 ||
        candidate.candidateCredentialAuditSha256 !== landing.credentialAuditSha256
      ) {
        invalid("Candidate result and landing settlement columns disagree");
      }
    }
  }
  if (operations.filter((operation) => operation.status === "started").length > 1) {
    invalid("Landing has more than one started operation");
  }
  for (const attempt of attempts) {
    const owned = operationsByAttempt.get(attempt.ordinal) ?? [];
    if (
      owned.length > 1 ||
      ((attempt.status === "completed" || attempt.status === "failed") && owned.length !== 1)
    ) {
      invalid("Landing attempt has an impossible local/preflight operation cardinality");
    }
  }
  const startedAttempt = attempts.find((attempt) => attempt.status === "started");
  const startedOperation = operations.find((operation) => operation.status === "started");
  const startedAttemptOwned =
    startedAttempt === undefined ? [] : (operationsByAttempt.get(startedAttempt.ordinal) ?? []);
  const completedPreflightBoundary =
    startedAttemptOwned.length === 1 &&
    startedAttemptOwned[0]?.kind === "github.preflight" &&
    startedAttemptOwned[0].status === "completed";
  const localReadyAttemptCrashBoundary =
    startedAttemptOwned.length === 0 && landing.state === "local_ready";
  if (
    (startedOperation !== undefined && startedAttempt === undefined) ||
    (startedOperation !== undefined &&
      ((startedOperation.kind === "candidate.prepare" && landing.state !== "preparing_candidate") ||
        (startedOperation.kind === "local_ref.create" && landing.state !== "creating_local_ref") ||
        (startedOperation.kind === "github.preflight" && landing.state !== "local_ready") ||
        (startedOperation.kind === "landing.reconcile" &&
          landing.state !== "reconciliation_required"))) ||
    (startedAttempt !== undefined &&
      startedOperation === undefined &&
      !(
        landing.state === "preparing_candidate" ||
        landing.state === "approved" ||
        (landing.state === "local_ready" &&
          (completedPreflightBoundary || localReadyAttemptCrashBoundary))
      )) ||
    (startedAttempt === undefined && landing.state === "creating_local_ref")
  ) {
    invalid("Landing active attempt/operation does not match its current state");
  }
  if (
    (decision === null &&
      !(
        landing.state === "preparing_candidate" ||
        landing.state === "awaiting_approval" ||
        landing.state === "abandoned" ||
        (landing.state === "failed" && landing.resumeState === "preparing_candidate")
      )) ||
    (decision?.decision === "reject" && landing.state !== "rejected") ||
    (decision?.decision === "approve" &&
      !(
        landing.state === "approved" ||
        landing.state === "creating_local_ref" ||
        landing.state === "local_ready" ||
        landing.state === "reconciliation_required" ||
        (landing.state === "failed" &&
          (landing.resumeState === "approved" || landing.resumeState === "local_ready"))
      ))
  ) {
    invalid("Landing decision and current state are inconsistent");
  }
  if (landing.state === "reconciliation_required") {
    localReconciliationSubject(status);
  }
  if (
    landing.state === "local_ready" ||
    (landing.state === "failed" && landing.resumeState === "local_ready")
  ) {
    const readyProofs = operations.filter((operation) => {
      if (operation.status !== "completed" || operation.result?.outcome !== "completed") {
        return false;
      }
      if (operation.kind === "local_ref.create") {
        const value = operation.result.value;
        return (
          value !== null &&
          "candidateCommitSha1" in value &&
          value.candidateCommitSha1 === landing.candidateCommitSha1
        );
      }
      if (operation.kind === "landing.reconcile") {
        const value = operation.result.value;
        return value !== null && "nextState" in value && value.nextState === "local_ready";
      }
      return false;
    });
    if (readyProofs.length !== 1) invalid("Local-ready landing lacks one exact stage proof");
  }

  const eventsByType = new Map<string, LandingEventRecordV1[]>();
  const attemptStartEvents = new Map<number, LandingEventRecordV1>();
  const attemptSettleEvents = new Map<number, LandingEventRecordV1>();
  const operationStartEvents = new Map<string, LandingEventRecordV1>();
  const operationSettleEvents = new Map<string, LandingEventRecordV1>();
  for (const event of events) {
    const group = eventsByType.get(event.type) ?? [];
    group.push(event);
    eventsByType.set(event.type, group);
  }
  for (const attempt of attempts) {
    const started = (eventsByType.get("landing.attempt.started") ?? []).filter((event) =>
      eventMatches(event, {
        schemaVersion: 1,
        landingId: landing.id,
        coordinatorAttempt: attempt.ordinal,
      }),
    );
    if (started.length !== 1) invalid("Landing attempt has missing or duplicate start events");
    const startedEvent = started[0];
    if (startedEvent === undefined) invalid("Landing attempt start event is missing");
    attemptStartEvents.set(attempt.ordinal, startedEvent);
    if (attempt.status !== "started") {
      const outcome =
        attempt.status === "completed"
          ? "completed"
          : attempt.status === "failed"
            ? "failed"
            : "interrupted";
      const settled = (eventsByType.get("landing.attempt.settled") ?? []).filter((event) =>
        eventMatches(event, {
          schemaVersion: 1,
          landingId: landing.id,
          coordinatorAttempt: attempt.ordinal,
          outcome,
          errorCode: attempt.errorCode,
        }),
      );
      const settledEvent = settled[0];
      if (
        startedEvent === undefined ||
        settledEvent === undefined ||
        settled.length !== 1 ||
        settledEvent.sequence <= startedEvent.sequence
      ) {
        invalid("Landing attempt settlement event is missing or reordered");
      }
      attemptSettleEvents.set(attempt.ordinal, settledEvent);
    }
  }
  for (const operation of operations) {
    const started = (eventsByType.get("landing.operation.started") ?? []).filter((event) =>
      eventMatches(event, {
        schemaVersion: 1,
        landingId: landing.id,
        operationId: operation.id,
        coordinatorAttempt: operation.coordinatorAttempt,
        kind: operation.kind,
        kindAttempt: operation.kindAttempt,
        requestSha256: operation.requestSha256,
      }),
    );
    if (started.length !== 1) invalid("Landing operation has missing or duplicate start events");
    const startedEvent = started[0];
    if (startedEvent === undefined) invalid("Landing operation start event is missing");
    operationStartEvents.set(operation.id, startedEvent);
    if (operation.status !== "started") {
      if (operation.result === null || operation.resultSha256 === null) {
        invalid("Settled landing operation is missing its result");
      }
      const settled = (eventsByType.get("landing.operation.settled") ?? []).filter((event) =>
        eventMatches(event, {
          schemaVersion: 1,
          landingId: landing.id,
          operationId: operation.id,
          coordinatorAttempt: operation.coordinatorAttempt,
          kind: operation.kind,
          outcome: operation.result?.outcome,
          resultSha256: operation.resultSha256,
          errorCode: operation.errorCode,
        }),
      );
      const settledEvent = settled[0];
      if (
        startedEvent === undefined ||
        settledEvent === undefined ||
        settled.length !== 1 ||
        settledEvent.sequence <= startedEvent.sequence
      ) {
        invalid("Landing operation settlement event is missing or reordered");
      }
      operationSettleEvents.set(operation.id, settledEvent);
    }
  }
  let decisionEvent: LandingEventRecordV1 | null = null;
  if (decision !== null) {
    const matches = (eventsByType.get("landing.decision.recorded") ?? []).filter((event) =>
      eventMatches(event, {
        schemaVersion: 1,
        landingId: landing.id,
        decisionId: decision.id,
        landingSha256: decision.landingSha256,
        decision: decision.decision,
        actor: decision.actor,
      }),
    );
    if (matches.length !== 1) invalid("Landing decision event is missing or duplicated");
    decisionEvent = matches[0] ?? null;
  } else if ((eventsByType.get("landing.decision.recorded") ?? []).length !== 0) {
    invalid("Landing decision event has no source row");
  }

  for (const operation of operations) {
    const attemptStarted = attemptStartEvents.get(operation.coordinatorAttempt);
    const operationStarted = operationStartEvents.get(operation.id);
    if (
      attemptStarted === undefined ||
      operationStarted === undefined ||
      operationStarted.sequence <= attemptStarted.sequence
    ) {
      invalid("Landing operation started before its coordinator attempt");
    }
    const operationSettled = operationSettleEvents.get(operation.id);
    const attemptSettled = attemptSettleEvents.get(operation.coordinatorAttempt);
    const isCompletedPreflightBoundary =
      operation.kind === "github.preflight" &&
      operation.status === "completed" &&
      attempts[operation.coordinatorAttempt - 1]?.status === "started";
    if (
      operation.status !== "started" &&
      (operationSettled === undefined ||
        (!isCompletedPreflightBoundary &&
          (attemptSettled === undefined ||
            attemptSettled.sequence !== operationSettled.sequence + 1)))
    ) {
      invalid("Landing operation and attempt settlements are not in exact source order");
    }
    if (isCompletedPreflightBoundary && attemptSettled !== undefined) {
      invalid("Completed GitHub preflight cannot settle its still-active attempt");
    }
    if (
      operation.kind === "landing.reconcile" &&
      operationStarted.sequence !== attemptStarted.sequence + 1
    ) {
      invalid("Landing reconciliation admission is not atomic in event order");
    }
  }

  let replayedState: LandingStateV1 = "preparing_candidate";
  let replayedResumeState: LandingResumeStateV1 | null = null;
  let replayedVersion = 0;
  let replayedErrorCode: string | null = null;
  let nextAttemptOrdinal = 1;
  let activeAttemptOrdinal: number | null = null;
  const replayedKindAttempts = new Map<LandingOperationKindV1, number>();
  const operationStartAuthority = new Map<string, OperationStartAuthorityV1>();
  for (const [index, event] of events.entries()) {
    if (event.type === "landing.attempt.started") {
      const ordinal = (event.payload as { readonly coordinatorAttempt: number }).coordinatorAttempt;
      const initialAttempt = ordinal === 1;
      const allowedAdmissionState =
        replayedState === "preparing_candidate" ||
        replayedState === "approved" ||
        replayedState === "local_ready" ||
        replayedState === "failed" ||
        replayedState === "reconciliation_required";
      if (
        ordinal !== nextAttemptOrdinal ||
        activeAttemptOrdinal !== null ||
        (initialAttempt && index !== 0) ||
        (!initialAttempt && !allowedAdmissionState)
      ) {
        invalid("Landing attempt start events are reordered");
      }
      const nextEvent = events[index + 1];
      if (replayedState === "failed") {
        const nextPayload =
          nextEvent?.type === "landing.state.changed"
            ? (nextEvent.payload as LandingStateChangedEventV1)
            : null;
        if (
          nextPayload === null ||
          nextPayload.from !== "failed" ||
          nextPayload.to !== replayedResumeState ||
          nextPayload.operationId !== null
        ) {
          invalid("Failed landing attempt admission lacks its atomic resume transition");
        }
      } else if (replayedState === "local_ready") {
        const nextOperation =
          nextEvent?.type === "landing.operation.started"
            ? (nextEvent.payload as {
                readonly coordinatorAttempt: number;
                readonly kind: LandingOperationKindV1;
              })
            : null;
        const nextTakeover =
          nextEvent?.type === "landing.attempt.settled"
            ? (nextEvent.payload as {
                readonly coordinatorAttempt: number;
                readonly outcome: string;
                readonly errorCode: string | null;
              })
            : null;
        const startsPreflight =
          nextOperation?.coordinatorAttempt === ordinal &&
          nextOperation.kind === "github.preflight";
        const closesZeroOperationTakeover =
          nextTakeover?.coordinatorAttempt === ordinal &&
          nextTakeover.outcome === "interrupted" &&
          nextTakeover.errorCode === LANDING_COORDINATOR_TAKEOVER;
        if (nextEvent !== undefined && !startsPreflight && !closesZeroOperationTakeover) {
          invalid("Local-ready attempt admission lacks its bounded preflight intent");
        }
      } else if (replayedState === "reconciliation_required") {
        const nextPayload =
          nextEvent?.type === "landing.operation.started"
            ? (nextEvent.payload as {
                readonly coordinatorAttempt: number;
                readonly kind: LandingOperationKindV1;
              })
            : null;
        if (
          nextPayload === null ||
          nextPayload.coordinatorAttempt !== ordinal ||
          nextPayload.kind !== "landing.reconcile"
        ) {
          invalid("Reconciliation attempt admission lacks its atomic operation intent");
        }
      }
      nextAttemptOrdinal += 1;
      activeAttemptOrdinal = ordinal;
      continue;
    }
    if (event.type === "landing.attempt.settled") {
      const payload = event.payload as {
        readonly coordinatorAttempt: number;
        readonly outcome: string;
        readonly errorCode: string | null;
      };
      const ordinal = payload.coordinatorAttempt;
      if (activeAttemptOrdinal !== ordinal) {
        invalid("Landing attempt settlement does not close the active attempt");
      }
      if (payload.outcome === "interrupted" && payload.errorCode === LANDING_COORDINATOR_TAKEOVER) {
        const successor = attempts[ordinal];
        const transitionOffset = replayedState === "creating_local_ref" ? 1 : 0;
        const transitionEvent = transitionOffset === 1 ? events[index + 1] : undefined;
        if (transitionOffset === 1 && transitionEvent?.type !== "landing.state.changed") {
          invalid("Effect takeover omitted its required reconciliation state transition");
        }
        const nextEvent = events[index + transitionOffset + 1];
        const nextPayload =
          nextEvent?.type === "landing.attempt.started"
            ? (nextEvent.payload as { readonly coordinatorAttempt: number })
            : null;
        if (
          (ordinal < 8 &&
            (successor?.ordinal !== ordinal + 1 ||
              nextPayload?.coordinatorAttempt !== ordinal + 1)) ||
          (ordinal === 8 && (successor !== undefined || nextEvent !== undefined))
        ) {
          invalid("Landing takeover lacks its exact atomic replacement-attempt boundary");
        }
      }
      activeAttemptOrdinal = null;
      continue;
    }
    if (event.type === "landing.operation.started") {
      const payload = event.payload as {
        readonly operationId: string;
        readonly kind: LandingOperationKindV1;
        readonly kindAttempt: number;
      };
      const operation = operations.find((entry) => entry.id === payload.operationId);
      const expectedKindAttempt = (replayedKindAttempts.get(payload.kind) ?? 0) + 1;
      if (
        operation === undefined ||
        operation.coordinatorAttempt !== activeAttemptOrdinal ||
        payload.kindAttempt !== expectedKindAttempt ||
        operation.request.expectedState !== replayedState ||
        operation.request.expectedVersion !== replayedVersion
      ) {
        invalid("Landing operation start does not match chronological state authority");
      }
      operationStartAuthority.set(operation.id, {
        state: replayedState,
        version: replayedVersion,
      });
      replayedKindAttempts.set(payload.kind, expectedKindAttempt);
      continue;
    }
    if (event.type === "landing.operation.settled") {
      const operationId = (event.payload as { readonly operationId: string }).operationId;
      const operation = operations.find((entry) => entry.id === operationId);
      if (operation === undefined || operation.coordinatorAttempt !== activeAttemptOrdinal) {
        invalid("Landing operation settlement does not belong to the active attempt");
      }
      continue;
    }
    if (event.type === "landing.decision.recorded" && activeAttemptOrdinal !== null) {
      invalid("Landing decision was recorded while a coordinator attempt remained active");
    }
    if (event.type !== "landing.state.changed") continue;
    const payload = event.payload as LandingStateChangedEventV1;
    const { from, to, version } = payload;
    if (
      !isLandingStateV1(from) ||
      !isLandingStateV1(to) ||
      from !== replayedState ||
      version !== replayedVersion + 1 ||
      from === to
    ) {
      invalid("Landing state event replay is inconsistent");
    }
    assertLandingTransition(from, to);

    const owner =
      payload.operationId === null
        ? null
        : operations.find((operation) => operation.id === payload.operationId);
    const ownerSettled =
      owner === null || owner === undefined ? undefined : operationSettleEvents.get(owner.id);
    const ownerAttemptSettled =
      owner === null || owner === undefined
        ? undefined
        : attemptSettleEvents.get(owner.coordinatorAttempt);
    const isSettlementOwned =
      owner !== null &&
      owner !== undefined &&
      ownerSettled?.sequence === event.sequence - 2 &&
      ownerAttemptSettled?.sequence === event.sequence - 1;
    const previous = events[index - 1];
    const transition = from + "->" + to;
    if (transition === "preparing_candidate->awaiting_approval") {
      if (
        owner?.kind !== "candidate.prepare" ||
        owner.result?.outcome !== "completed" ||
        !isSettlementOwned
      ) {
        invalid("Candidate-ready transition has the wrong operation owner");
      }
    } else if (transition === "preparing_candidate->failed") {
      if (
        owner?.kind !== "candidate.prepare" ||
        owner.result?.outcome !== "failed" ||
        !isSettlementOwned
      ) {
        invalid("Candidate failure transition has the wrong operation owner");
      }
      replayedResumeState = "preparing_candidate";
    } else if (
      transition === "awaiting_approval->approved" ||
      transition === "awaiting_approval->rejected"
    ) {
      if (
        payload.operationId !== null ||
        decisionEvent?.sequence !== event.sequence - 1 ||
        decision?.decision !== (to === "approved" ? "approve" : "reject")
      ) {
        invalid("Landing decision and state events are not in exact source order");
      }
    } else if (transition === "approved->creating_local_ref") {
      if (
        owner?.kind !== "local_ref.create" ||
        operationStartEvents.get(owner.id)?.sequence !== event.sequence - 1
      ) {
        invalid("Local-ref action transition has the wrong started operation");
      }
    } else if (
      transition === "creating_local_ref->local_ready" ||
      transition === "creating_local_ref->failed" ||
      transition === "creating_local_ref->reconciliation_required"
    ) {
      const expectedOutcome =
        to === "local_ready" ? "completed" : to === "failed" ? "failed" : "reconciliation_required";
      if (
        owner?.kind !== "local_ref.create" ||
        owner.result?.outcome !== expectedOutcome ||
        !isSettlementOwned
      ) {
        invalid("Local-ref settlement transition has the wrong operation owner");
      }
      replayedResumeState = to === "failed" || to === "reconciliation_required" ? "approved" : null;
    } else if (
      transition === "reconciliation_required->approved" ||
      transition === "reconciliation_required->local_ready"
    ) {
      const value = owner?.result?.value as ReconcileValueV1 | null | undefined;
      if (
        owner?.kind !== "landing.reconcile" ||
        owner.result?.outcome !== "completed" ||
        value === null ||
        value === undefined ||
        value.nextState !== to ||
        !isSettlementOwned
      ) {
        invalid("Reconciliation transition has the wrong operation owner");
      }
      replayedResumeState = null;
    } else if (transition === "local_ready->failed") {
      if (
        owner?.kind !== "github.preflight" ||
        owner.result?.outcome !== "failed" ||
        !isSettlementOwned
      ) {
        invalid("Preflight failure transition has the wrong operation owner");
      }
      replayedResumeState = "local_ready";
    } else if (
      transition === "failed->preparing_candidate" ||
      transition === "failed->approved" ||
      transition === "failed->local_ready"
    ) {
      if (
        payload.operationId !== null ||
        replayedResumeState !== to ||
        previous?.type !== "landing.attempt.started" ||
        previous.sequence !== event.sequence - 1
      ) {
        invalid("Failed-state resume events are not in exact source order");
      }
      replayedResumeState = null;
    } else if (
      transition === "preparing_candidate->abandoned" ||
      transition === "awaiting_approval->abandoned" ||
      transition === "failed->abandoned"
    ) {
      if (payload.operationId !== null || activeAttemptOrdinal !== null) {
        invalid("Landing abandonment cannot name an operation owner");
      }
      replayedResumeState = null;
    } else {
      invalid("Landing event stream contains an unsupported local/preflight transition");
    }
    replayedErrorCode =
      to === "failed" || to === "reconciliation_required"
        ? (owner?.errorCode ?? invalid("Landing error transition has no operation error owner"))
        : null;
    replayedState = to;
    replayedVersion = version;
  }
  if (
    replayedState !== landing.state ||
    replayedResumeState !== landing.resumeState ||
    replayedVersion !== landing.version ||
    replayedErrorCode !== landing.errorCode ||
    activeAttemptOrdinal !== (startedAttempt?.ordinal ?? null)
  ) {
    invalid("Landing state/version/error differs from its event replay");
  }
  const preflightRequestEventCount = validatePersistedPreflightAggregates(
    status,
    rawOperationRows,
    rawHttpRows,
    rawEventRows,
    operationStartAuthority,
  );
  const expectedEventCount =
    attempts.length +
    attempts.filter((attempt) => attempt.status !== "started").length +
    operations.length +
    operations.filter((operation) => operation.status !== "started").length +
    preflightRequestEventCount +
    (decision === null ? 0 : 1) +
    landing.version;
  if (events.length !== expectedEventCount) {
    invalid("Landing event stream contains an omitted or extra source event");
  }
}

function reconstructLandingDigest(status: LandingStatusV1): {
  readonly record: LandingDigestV1;
  readonly sha256: string;
  readonly candidate: CandidateReadyValueV1;
} | null {
  const { landing, operations } = status;
  const candidates = operations.filter(
    (operation) =>
      operation.kind === "candidate.prepare" &&
      operation.status === "completed" &&
      operation.result?.outcome === "completed",
  );
  if (landing.landingSha256 === null) {
    if (candidates.length !== 0) invalid("Candidate result exists before landing settlement");
    return null;
  }
  if (
    candidates.length !== 1 ||
    landing.credentialAuditSha256 === null ||
    landing.candidateTreeSha1 === null ||
    landing.candidateCommitSha1 === null ||
    landing.candidateCommitPayloadSha256 === null ||
    landing.pullRequestBodySha256 === null
  ) {
    invalid("Settled landing is missing one exact candidate result");
  }
  const candidate = candidates[0]?.result?.value as CandidateReadyValueV1 | undefined;
  if (candidate === undefined) invalid("Candidate result value is missing");
  const record = decodeLandingDigestV1({
    schemaVersion: 1,
    policyVersion: 1,
    githubApiVersion: GITHUB_API_VERSION,
    landingId: landing.id,
    runId: landing.runId,
    projectId: landing.projectId,
    baseCommitSha1: landing.baseCommitSha1,
    baseTreeSha1: landing.baseTreeSha1,
    planSha256: landing.planSha256,
    diffSha256: landing.diffSha256,
    checkpointSha256: landing.checkpointSha256,
    verificationSha256: landing.verificationSha256,
    reviewDecisionId: landing.reviewDecisionId,
    reviewDecisionSha256: landing.reviewDecisionSha256,
    changedPaths: landing.changedPaths,
    changedPathsSha256: landing.changedPathsSha256,
    candidateCredentialAuditSha256: landing.credentialAuditSha256,
    profileVersion: 1,
    profileSha256: landing.profileSha256,
    profile: landing.profile,
    objectFormat: "sha1",
    candidateParentSha1: landing.baseCommitSha1,
    candidateTreeSha1: landing.candidateTreeSha1,
    candidateCommitSha1: landing.candidateCommitSha1,
    candidateCommitPayloadSha256: landing.candidateCommitPayloadSha256,
    candidateObjectManifestSha256: candidate.candidateObjectManifestSha256,
    commitMessageSha256: landing.commitMessageSha256,
    commitAuthor: landing.profile.commitIdentity,
    commitCommitter: landing.profile.commitIdentity,
    commitEpochSeconds: landing.commitEpochSeconds,
    commitIso8601: landing.commitIso8601,
    baseRef: "refs/heads/" + landing.profile.baseBranch,
    expectedRemoteBaseSha1: landing.baseCommitSha1,
    headRef: landing.headRef,
    pullRequestTitleSha256: landing.pullRequestTitleSha256,
    pullRequestBodyPrefixSha256: landing.pullRequestBodyPrefixSha256,
    pullRequestMarkerVersion: 1,
    draft: true,
    maintainerCanModify: false,
    directIcarusEffects: DIRECT_ICARUS_EFFECTS,
    derivativeEffectDisclosure: {
      version: 1,
      githubEvents: DERIVATIVE_GITHUB_EVENTS,
      mayTrigger: DERIVATIVE_EFFECTS,
      disposition: landing.profile.derivativeEffects.disposition,
      evidenceSha256: landing.profile.derivativeEffects.evidenceSha256,
    },
  });
  const authoritySha256 = digestLandingRecord(record);
  if (authoritySha256 !== landing.landingSha256) {
    invalid("Landing authority digest does not match its reconstructed record");
  }
  assertLandingDigestTextBindingsV1(record, {
    commitMessage: landing.commitMessage,
    pullRequestTitle: landing.pullRequestTitle,
    pullRequestBodyPrefix: landing.pullRequestBodyPrefix,
  });
  const body = renderPullRequestBodyV1({
    landing: record,
    landingSha256: authoritySha256,
    bodyPrefix: landing.pullRequestBodyPrefix,
  });
  if (sha256(body) !== landing.pullRequestBodySha256) {
    invalid("Landing pull-request body digest does not match the derived body");
  }
  return { record, sha256: authoritySha256, candidate };
}

export class LandingLedger {
  readonly #database: Database.Database;
  readonly #now: () => string;
  readonly #id: () => string;
  readonly #eligibilitySource: (runId: string) => LandingEligibilityV1;
  readonly #evidenceSource: (runId: string) => LandingEligibilityV1;

  constructor(input: {
    readonly database: Database.Database;
    readonly now: () => string;
    readonly id: () => string;
    readonly eligibilitySource: (runId: string) => LandingEligibilityV1;
    readonly evidenceSource: (runId: string) => LandingEligibilityV1;
  }) {
    this.#database = input.database;
    this.#now = input.now;
    this.#id = input.id;
    this.#eligibilitySource = input.eligibilitySource;
    this.#evidenceSource = input.evidenceSource;
  }

  #timestamp(): string {
    return assertInstant(this.#now(), "landing timestamp");
  }

  #identifier(): string {
    return assertUuid(this.#id(), "landing generated id");
  }

  #mutableStatus(landingId: string): LandingStatusV1 {
    const status = this.getStatus(landingId);
    this.#assertMutableRun(status);
    return status;
  }

  #assertMutableRun(status: LandingStatusV1): void {
    const runEntry = this.#database
      .prepare("SELECT project_id, state FROM runs WHERE id = ?")
      .get(status.landing.runId);
    const run = expectRow(runEntry, "landing run authority");
    if (
      text(run.project_id, "runs.project_id") !== status.landing.projectId ||
      text(run.state, "runs.state") !== "completed"
    ) {
      throw new IcarusError(
        "LANDING_NOT_ELIGIBLE",
        "Landing mutation requires its completed authoritative run",
      );
    }
  }

  #assertImmutableEvidence(status: LandingStatusV1): void {
    const evidence = this.#evidenceSource(status.landing.runId);
    const landing = status.landing;
    if (
      evidence.runId !== landing.runId ||
      evidence.projectId !== landing.projectId ||
      evidence.baseCommitSha1 !== landing.baseCommitSha1 ||
      evidence.planSha256 !== landing.planSha256 ||
      evidence.diffSha256 !== landing.diffSha256 ||
      evidence.checkpointSha256 !== landing.checkpointSha256 ||
      evidence.verificationSha256 !== landing.verificationSha256 ||
      evidence.reviewDecisionId !== landing.reviewDecisionId ||
      evidence.reviewDecisionSha256 !== landing.reviewDecisionSha256 ||
      evidence.changedPathsSha256 !== landing.changedPathsSha256 ||
      canonicalLandingJson(evidence.changedPaths) !== canonicalLandingJson(landing.changedPaths)
    ) {
      throw new IcarusError(
        "LANDING_NOT_ELIGIBLE",
        "Landing immutable run evidence no longer matches its snapshot",
      );
    }
  }

  getProfile(projectId: string): LandingProfileRecordV1 | null {
    assertUuid(projectId, "projectId");
    const entry = this.#database
      .prepare("SELECT * FROM landing_profiles WHERE project_id = ?")
      .get(projectId);
    return entry === undefined ? null : decodeProfileRow(entry);
  }

  setProfile(
    projectId: string,
    profileInput: GitHubLandingProfileV1,
    allowedCredentialEnvironmentNames: ReadonlySet<string>,
  ): LandingProfileRecordV1 {
    const canonicalProjectId = assertUuid(projectId, "projectId");
    const profile = decodeGitHubLandingProfileV1(profileInput);
    assertLandingCredentialEnvironmentAllowed(profile, allowedCredentialEnvironmentNames);
    const profileSha256 = digestLandingRecord(profile);
    const transaction = this.#database.transaction((): LandingProfileRecordV1 => {
      if (
        this.#database.prepare("SELECT 1 FROM projects WHERE id = ?").get(canonicalProjectId) ===
        undefined
      ) {
        throw new IcarusError("NOT_FOUND", "Project was not found");
      }
      const now = this.#timestamp();
      this.#database
        .prepare(
          "INSERT INTO landing_profiles " +
            "(project_id, profile_version, provider, owner, repository, base_branch, " +
            "branch_namespace, credential_env, expected_actor, commit_name, commit_email, " +
            "derivative_effects_disposition, derivative_effects_evidence_sha256, " +
            "profile_sha256, created_at, updated_at) " +
            "VALUES (?, 1, 'github', ?, ?, ?, 'icarus/', ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
            "ON CONFLICT(project_id) DO UPDATE SET " +
            "profile_version=excluded.profile_version, provider=excluded.provider, " +
            "owner=excluded.owner, repository=excluded.repository, " +
            "base_branch=excluded.base_branch, branch_namespace=excluded.branch_namespace, " +
            "credential_env=excluded.credential_env, expected_actor=excluded.expected_actor, " +
            "commit_name=excluded.commit_name, commit_email=excluded.commit_email, " +
            "derivative_effects_disposition=excluded.derivative_effects_disposition, " +
            "derivative_effects_evidence_sha256=excluded.derivative_effects_evidence_sha256, " +
            "profile_sha256=excluded.profile_sha256, updated_at=excluded.updated_at",
        )
        .run(
          canonicalProjectId,
          profile.owner,
          profile.repository,
          profile.baseBranch,
          profile.credentialRef.name,
          profile.expectedActor,
          profile.commitIdentity.name,
          profile.commitIdentity.email,
          profile.derivativeEffects.disposition,
          profile.derivativeEffects.evidenceSha256,
          profileSha256,
          now,
          now,
        );
      const stored = this.getProfile(canonicalProjectId);
      if (stored === null) invalid("Landing profile write did not persist");
      return stored;
    });
    return runImmediate(transaction);
  }

  getStatus(landingId: string): LandingStatusV1 {
    const canonicalLandingId = assertUuid(landingId, "landingId");
    const transaction = this.#database.transaction(() => this.#loadStatus(canonicalLandingId));
    return transaction();
  }

  #assertBoundedLandingHistoryText(canonicalLandingId: string): void {
    const invalidAttempt = this.#database
      .prepare(
        `SELECT 1 FROM landing_attempts WHERE landing_id = ? AND (
          typeof(landing_id) <> 'text' OR octet_length(landing_id) > ${LANDING_LOADER_ID_MAX_BYTES} OR
          typeof(status) <> 'text' OR octet_length(status) > ${LANDING_LOADER_STATUS_MAX_BYTES} OR
          typeof(started_at) <> 'text' OR
          octet_length(started_at) > ${LANDING_LOADER_TIMESTAMP_MAX_BYTES} OR
          (finished_at IS NOT NULL AND (
            typeof(finished_at) <> 'text' OR
            octet_length(finished_at) > ${LANDING_LOADER_TIMESTAMP_MAX_BYTES}
          )) OR
          (error_code IS NOT NULL AND (
            typeof(error_code) <> 'text' OR
            octet_length(error_code) > ${LANDING_LOADER_ERROR_MAX_BYTES}
          ))
        ) LIMIT 1`,
      )
      .get(canonicalLandingId);
    if (invalidAttempt !== undefined) {
      invalid("Landing attempt history contains an unbounded or non-text member");
    }

    const invalidOperation = this.#database
      .prepare(
        `SELECT 1 FROM landing_operations WHERE landing_id = ? AND (
          typeof(id) <> 'text' OR octet_length(id) > ${LANDING_LOADER_ID_MAX_BYTES} OR
          typeof(landing_id) <> 'text' OR octet_length(landing_id) > ${LANDING_LOADER_ID_MAX_BYTES} OR
          typeof(kind) <> 'text' OR octet_length(kind) > ${LANDING_LOADER_KIND_MAX_BYTES} OR
          typeof(status) <> 'text' OR octet_length(status) > ${LANDING_LOADER_STATUS_MAX_BYTES} OR
          typeof(request_sha256) <> 'text' OR octet_length(request_sha256) > ${LANDING_LOADER_DIGEST_MAX_BYTES} OR
          typeof(request_json) <> 'text' OR octet_length(request_json) > ${LANDING_LOADER_JSON_MAX_BYTES} OR
          (observation_sha256 IS NOT NULL AND (
            typeof(observation_sha256) <> 'text' OR
            octet_length(observation_sha256) > ${LANDING_LOADER_DIGEST_MAX_BYTES}
          )) OR
          (observation_json IS NOT NULL AND (
            typeof(observation_json) <> 'text' OR
            octet_length(observation_json) > ${LANDING_LOADER_JSON_MAX_BYTES}
          )) OR
          (result_sha256 IS NOT NULL AND (
            typeof(result_sha256) <> 'text' OR
            octet_length(result_sha256) > ${LANDING_LOADER_DIGEST_MAX_BYTES}
          )) OR
          (result_json IS NOT NULL AND (
            typeof(result_json) <> 'text' OR
            octet_length(result_json) > ${LANDING_LOADER_JSON_MAX_BYTES}
          )) OR
          (error_code IS NOT NULL AND (
            typeof(error_code) <> 'text' OR
            octet_length(error_code) > ${LANDING_LOADER_ERROR_MAX_BYTES}
          )) OR
          typeof(started_at) <> 'text' OR
          octet_length(started_at) > ${LANDING_LOADER_TIMESTAMP_MAX_BYTES} OR
          (finished_at IS NOT NULL AND (
            typeof(finished_at) <> 'text' OR
            octet_length(finished_at) > ${LANDING_LOADER_TIMESTAMP_MAX_BYTES}
          ))
        ) LIMIT 1`,
      )
      .get(canonicalLandingId);
    if (invalidOperation !== undefined) {
      invalid("Landing operation history contains an unbounded or non-text member");
    }

    const invalidHttpRequest = this.#database
      .prepare(
        `SELECT 1 FROM landing_http_requests WHERE landing_id = ? AND (
          typeof(id) <> 'text' OR octet_length(id) > ${LANDING_LOADER_ID_MAX_BYTES} OR
          typeof(landing_id) <> 'text' OR octet_length(landing_id) > ${LANDING_LOADER_ID_MAX_BYTES} OR
          typeof(operation_id) <> 'text' OR octet_length(operation_id) > ${LANDING_LOADER_ID_MAX_BYTES} OR
          typeof(operation_kind) <> 'text' OR
          octet_length(operation_kind) > ${LANDING_LOADER_KIND_MAX_BYTES} OR
          typeof(kind) <> 'text' OR octet_length(kind) > ${LANDING_LOADER_KIND_MAX_BYTES} OR
          typeof(method) <> 'text' OR octet_length(method) > ${LANDING_LOADER_STATUS_MAX_BYTES} OR
          typeof(request_sha256) <> 'text' OR octet_length(request_sha256) > ${LANDING_LOADER_DIGEST_MAX_BYTES} OR
          typeof(request_json) <> 'text' OR octet_length(request_json) > ${LANDING_LOADER_JSON_MAX_BYTES} OR
          typeof(status) <> 'text' OR octet_length(status) > ${LANDING_LOADER_STATUS_MAX_BYTES} OR
          (outcome IS NOT NULL AND (
            typeof(outcome) <> 'text' OR
            octet_length(outcome) > ${LANDING_LOADER_STATUS_MAX_BYTES}
          )) OR
          (result_sha256 IS NOT NULL AND (
            typeof(result_sha256) <> 'text' OR
            octet_length(result_sha256) > ${LANDING_LOADER_DIGEST_MAX_BYTES}
          )) OR
          (result_json IS NOT NULL AND (
            typeof(result_json) <> 'text' OR
            octet_length(result_json) > ${LANDING_LOADER_JSON_MAX_BYTES}
          )) OR
          (error_code IS NOT NULL AND (
            typeof(error_code) <> 'text' OR
            octet_length(error_code) > ${LANDING_LOADER_ERROR_MAX_BYTES}
          )) OR
          typeof(admitted_at) <> 'text' OR
          octet_length(admitted_at) > ${LANDING_LOADER_TIMESTAMP_MAX_BYTES} OR
          (settled_at IS NOT NULL AND (
            typeof(settled_at) <> 'text' OR
            octet_length(settled_at) > ${LANDING_LOADER_TIMESTAMP_MAX_BYTES}
          ))
        ) LIMIT 1`,
      )
      .get(canonicalLandingId);
    if (invalidHttpRequest !== undefined) {
      invalid("Landing HTTP history contains an unbounded or non-text member");
    }

    const invalidEvent = this.#database
      .prepare(
        `SELECT 1 FROM landing_events WHERE landing_id = ? AND (
          typeof(landing_id) <> 'text' OR octet_length(landing_id) > ${LANDING_LOADER_ID_MAX_BYTES} OR
          typeof(type) <> 'text' OR octet_length(type) > ${LANDING_LOADER_KIND_MAX_BYTES} OR
          typeof(payload_json) <> 'text' OR
          octet_length(payload_json) > ${LANDING_LOADER_JSON_MAX_BYTES} OR
          typeof(created_at) <> 'text' OR
          octet_length(created_at) > ${LANDING_LOADER_TIMESTAMP_MAX_BYTES}
        ) LIMIT 1`,
      )
      .get(canonicalLandingId);
    if (invalidEvent !== undefined) {
      invalid("Landing event history contains an unbounded or non-text member");
    }
  }

  #loadStatus(canonicalLandingId: string): LandingStatusV1 {
    const landingEntry = this.#database
      .prepare("SELECT * FROM landings WHERE id = ?")
      .get(canonicalLandingId);
    if (landingEntry === undefined) throw new IcarusError("NOT_FOUND", "Landing was not found");
    const landing = decodeLandingRow(landingEntry);
    const runIdentity = this.#database
      .prepare("SELECT project_id FROM runs WHERE id = ?")
      .get(landing.runId);
    if (
      runIdentity === undefined ||
      text(expectRow(runIdentity, "landing run").project_id, "runs.project_id") !==
        landing.projectId
    ) {
      invalid("Landing run/project identity is invalid");
    }
    const approvalEntry = this.#database
      .prepare(
        "SELECT id, run_id, kind, digest, actor, decision, created_at " +
          "FROM approvals WHERE id = ?",
      )
      .get(landing.reviewDecisionId);
    if (approvalEntry === undefined) invalid("Landing review decision source is missing");
    const approval = expectRow(approvalEntry, "landing review approval");
    const reviewDigestRecord = decodeReviewDecisionDigestV1({
      schemaVersion: 1,
      id: assertUuid(approval.id, "approvals.id"),
      runId: assertUuid(approval.run_id, "approvals.run_id"),
      kind: text(approval.kind, "approvals.kind"),
      digest: assertSha256(approval.digest, "approvals.digest"),
      actor: text(approval.actor, "approvals.actor"),
      decision: text(approval.decision, "approvals.decision"),
      createdAt: assertInstant(approval.created_at, "approvals.created_at"),
    });
    if (
      reviewDigestRecord.runId !== landing.runId ||
      reviewDigestRecord.kind !== "review" ||
      reviewDigestRecord.decision !== "approve" ||
      reviewDigestRecord.digest !== landing.diffSha256 ||
      digestLandingRecord(reviewDigestRecord) !== landing.reviewDecisionSha256
    ) {
      invalid("Landing review decision snapshot no longer matches its source");
    }
    const decisionEntry = this.#database
      .prepare("SELECT * FROM landing_decisions WHERE landing_id = ?")
      .get(canonicalLandingId);
    const decision = decisionEntry === undefined ? null : decodeDecisionRow(decisionEntry, landing);
    const attemptSentinelRows = this.#database
      .prepare("SELECT 1 FROM landing_attempts WHERE landing_id = ? ORDER BY ordinal LIMIT ?")
      .all(canonicalLandingId, LANDING_LOADER_MAX_ATTEMPTS + 1) as unknown[];
    if (attemptSentinelRows.length > LANDING_LOADER_MAX_ATTEMPTS) {
      invalid("Landing attempt history exceeds its fixed loader bound");
    }
    const maximumHttpRows = attemptSentinelRows.length * 3;
    const operationSentinelRows = this.#database
      .prepare("SELECT 1 FROM landing_operations WHERE landing_id = ? LIMIT ?")
      .all(canonicalLandingId, attemptSentinelRows.length + 1) as unknown[];
    if (operationSentinelRows.length > attemptSentinelRows.length) {
      invalid("Landing operation history exceeds its attempt-bound loader slice");
    }
    const httpSentinelRows = this.#database
      .prepare("SELECT 1 FROM landing_http_requests WHERE landing_id = ? LIMIT ?")
      .all(canonicalLandingId, maximumHttpRows + 1) as unknown[];
    if (httpSentinelRows.length > maximumHttpRows) {
      invalid("Landing HTTP request history exceeds the bounded preflight loader slice");
    }
    const eventSentinelRows = this.#database
      .prepare("SELECT 1 FROM landing_events WHERE landing_id = ? LIMIT ?")
      .all(canonicalLandingId, LANDING_LOADER_MAX_EVENTS + 1) as unknown[];
    if (eventSentinelRows.length > LANDING_LOADER_MAX_EVENTS) {
      invalid("Landing event history exceeds its fixed loader bound");
    }
    this.#assertBoundedLandingHistoryText(canonicalLandingId);
    const attemptRows = this.#database
      .prepare("SELECT * FROM landing_attempts WHERE landing_id = ? ORDER BY ordinal LIMIT ?")
      .all(canonicalLandingId, LANDING_LOADER_MAX_ATTEMPTS) as unknown[];
    const attempts = attemptRows.map((entry) => decodeAttemptRow(entry, canonicalLandingId));
    const operationRows = this.#database
      .prepare(
        "SELECT * FROM landing_operations " +
          "WHERE landing_id = ? ORDER BY coordinator_attempt, rowid LIMIT ?",
      )
      .all(canonicalLandingId, attempts.length) as unknown[];
    const operations = operationRows.map((entry) => decodeOperationRow(entry, landing));
    const httpRows = this.#database
      .prepare(
        "SELECT * FROM landing_http_requests " +
          "WHERE landing_id = ? ORDER BY coordinator_attempt, request_ordinal LIMIT ?",
      )
      .all(canonicalLandingId, maximumHttpRows) as unknown[];
    const eventRows = this.#database
      .prepare("SELECT * FROM landing_events WHERE landing_id = ? ORDER BY sequence LIMIT ?")
      .all(canonicalLandingId, LANDING_LOADER_MAX_EVENTS) as unknown[];
    const events = eventRows.map((entry, index) =>
      decodeEventRow(entry, canonicalLandingId, index + 1),
    );
    if (
      this.#database
        .prepare("SELECT 1 FROM landing_receipts WHERE landing_id = ? LIMIT 1")
        .get(canonicalLandingId) !== undefined
    ) {
      invalid("Local/preflight landing cannot contain a remote receipt");
    }
    const status: LandingStatusV1 = {
      landing,
      decision,
      attempts,
      operations,
      events,
      revision: events.at(-1)?.sequence ?? 0,
    };
    validateAggregate(status, operationRows, httpRows, eventRows);
    reconstructLandingDigest(status);
    return status;
  }

  getStatusForRun(runId: string): LandingStatusV1 | null {
    const canonicalRunId = assertUuid(runId, "runId");
    const transaction = this.#database.transaction(() => {
      const entry = this.#database
        .prepare("SELECT id FROM landings WHERE run_id = ?")
        .get(canonicalRunId);
      return entry === undefined
        ? null
        : this.#loadStatus(assertUuid(expectRow(entry, "run landing").id, "landings.id"));
    });
    return transaction();
  }

  getRunProjection(runId: string): LandingRunProjectionSnapshotV1 {
    const transaction = this.#database.transaction((): LandingRunProjectionSnapshotV1 => {
      const status = this.getStatusForRun(runId);
      if (status === null) return { landing: null, landingRevision: 0 };
      const reconstructed = reconstructLandingDigest(status);
      const body =
        reconstructed === null
          ? null
          : renderPullRequestBodyV1({
              landing: reconstructed.record,
              landingSha256: reconstructed.sha256,
              bodyPrefix: status.landing.pullRequestBodyPrefix,
            });
      return {
        landing: {
          landingId: status.landing.id,
          state: status.landing.state,
          resumeState: status.landing.resumeState,
          version: status.landing.version,
          landingSha256: status.landing.landingSha256,
          candidateCommitSha1: status.landing.candidateCommitSha1,
          pullRequestTitle: status.landing.pullRequestTitle,
          pullRequestBody: body,
          derivativeEffects: status.landing.profile.derivativeEffects,
          decision:
            status.decision === null
              ? null
              : {
                  actor: status.decision.actor,
                  decision: status.decision.decision,
                  createdAt: status.decision.createdAt,
                },
          errorCode: status.landing.errorCode,
          updatedAt: status.landing.updatedAt,
        },
        landingRevision: status.revision,
      };
    });
    return transaction();
  }

  #appendEvent(landingId: string, type: LandingEventRecordV1["type"], payload: unknown): number {
    const decoded = decodeLandingEventPayloadV1(type, payload);
    if (decoded.landingId !== landingId)
      invalid("Landing event payload belongs to another landing");
    const next = integer(
      expectRow(
        this.#database
          .prepare(
            "SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence " +
              "FROM landing_events WHERE landing_id = ?",
          )
          .get(landingId),
        "landing event sequence",
      ).next_sequence,
      "landing event sequence",
      1,
    );
    this.#database
      .prepare(
        "INSERT INTO landing_events " +
          "(landing_id, sequence, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(landingId, next, type, canonicalLandingJson(decoded), this.#timestamp());
    return next;
  }

  create(
    input: CreateLandingInputV1,
    allowedCredentialEnvironmentNames: ReadonlySet<string>,
  ): LandingStatusV1 {
    const runId = assertUuid(input.runId, "runId");
    const baseTreeSha1 = assertSha1(input.baseTreeSha1, "baseTreeSha1");
    const commitMessage = canonicalizeCommitMessage(input.commitMessage);
    const pullRequestTitle = canonicalizePullRequestTitle(input.pullRequestTitle);
    const pullRequestBodyPrefix = canonicalizePullRequestBodyPrefix(input.pullRequestBodyPrefix);
    if (
      commitMessage !== input.commitMessage ||
      pullRequestTitle !== input.pullRequestTitle ||
      pullRequestBodyPrefix !== input.pullRequestBodyPrefix
    ) {
      throw new IcarusError("LANDING_RECORD_INVALID", "Landing text input is not canonical");
    }
    const commitEpochSeconds = integer(
      input.commitEpochSeconds,
      "commitEpochSeconds",
      0,
      253_402_300_799,
    );
    const commitIso8601 = assertGitInstant(input.commitIso8601, "commitIso8601");
    if (commitEpochToGitInstant(commitEpochSeconds) !== commitIso8601) {
      throw new IcarusError("LANDING_RECORD_INVALID", "Commit epoch and instant disagree");
    }
    let landingId = "";
    const transaction = this.#database.transaction(() => {
      const eligibility = this.#eligibilitySource(runId);
      assertLandingCredentialEnvironmentAllowed(
        eligibility.profile,
        allowedCredentialEnvironmentNames,
      );
      if (
        this.#database.prepare("SELECT 1 FROM landings WHERE run_id = ?").get(runId) !== undefined
      ) {
        throw new IcarusError("LANDING_ALREADY_EXISTS", "Run already has a landing");
      }
      landingId = this.#identifier();
      const now = this.#timestamp();
      const headRef = "refs/heads/icarus/" + runId;
      const profileJson = canonicalLandingJson(eligibility.profile);
      const changedPathsJson = canonicalLandingJson({
        schemaVersion: 1,
        paths: eligibility.changedPaths,
      });
      this.#database
        .prepare(
          "INSERT INTO landings (" +
            "id, run_id, project_id, policy_version, state, resume_state, profile_json, " +
            "profile_sha256, base_commit_sha1, base_tree_sha1, plan_sha256, diff_sha256, " +
            "checkpoint_sha256, verification_sha256, review_decision_id, " +
            "review_decision_sha256, changed_paths_json, changed_paths_sha256, " +
            "credential_audit_sha256, head_ref, commit_message, commit_message_sha256, " +
            "commit_epoch_seconds, commit_iso8601, pull_request_title, " +
            "pull_request_title_sha256, pull_request_body_prefix, " +
            "pull_request_body_prefix_sha256, pull_request_body_sha256, " +
            "candidate_tree_sha1, candidate_commit_sha1, candidate_commit_payload_sha256, " +
            "landing_sha256, error_code, attempt_count, version, created_at, updated_at" +
            ") VALUES (?, ?, ?, 1, 'preparing_candidate', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, " +
            "?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, 1, 0, ?, ?)",
        )
        .run(
          landingId,
          runId,
          eligibility.projectId,
          profileJson,
          eligibility.profileSha256,
          eligibility.baseCommitSha1,
          baseTreeSha1,
          eligibility.planSha256,
          eligibility.diffSha256,
          eligibility.checkpointSha256,
          eligibility.verificationSha256,
          eligibility.reviewDecisionId,
          eligibility.reviewDecisionSha256,
          changedPathsJson,
          eligibility.changedPathsSha256,
          headRef,
          commitMessage,
          sha256(commitMessage),
          commitEpochSeconds,
          commitIso8601,
          pullRequestTitle,
          sha256(pullRequestTitle),
          pullRequestBodyPrefix,
          sha256(pullRequestBodyPrefix),
          now,
          now,
        );
      this.#database
        .prepare(
          "INSERT INTO landing_attempts " +
            "(landing_id, ordinal, status, started_at, finished_at, error_code) " +
            "VALUES (?, 1, 'started', ?, NULL, NULL)",
        )
        .run(landingId, now);
      this.#appendEvent(landingId, "landing.attempt.started", {
        schemaVersion: 1,
        landingId,
        coordinatorAttempt: 1,
      });
    });
    runImmediate(transaction);
    return this.getStatus(landingId);
  }

  #startedAttempt(status: LandingStatusV1): LandingAttemptRecordV1 {
    const started = status.attempts.filter((attempt) => attempt.status === "started");
    if (started.length !== 1 || started[0] === undefined) {
      throw new IcarusError("LANDING_NOT_ADMITTED", "Landing has no active coordinator attempt");
    }
    return started[0];
  }

  #startOperation(
    status: LandingStatusV1,
    kind: "candidate.prepare" | "local_ref.create" | "github.preflight" | "landing.reconcile",
    input: LandingOperationRequestV1["input"],
  ): string {
    const attempt = this.#startedAttempt(status);
    if (status.operations.some((operation) => operation.status === "started")) {
      throw new IcarusError("LANDING_OPERATION_IN_PROGRESS", "Landing operation is already active");
    }
    const kindAttempt = status.operations.filter((operation) => operation.kind === kind).length + 1;
    if (kindAttempt > 9) {
      throw new IcarusError("LANDING_OPERATION_LIMIT", "Landing operation kind limit reached");
    }
    const operationId = this.#identifier();
    const request = decodeLandingOperationRequestV1({
      schemaVersion: 1,
      operationId,
      landingId: status.landing.id,
      coordinatorAttempt: attempt.ordinal,
      kindAttempt,
      kind,
      expectedState: status.landing.state,
      expectedVersion: status.landing.version,
      input,
    });
    const requestJson = canonicalLandingJson(request);
    const requestSha256 = sha256(requestJson);
    this.#database
      .prepare(
        "INSERT INTO landing_operations " +
          "(id, landing_id, coordinator_attempt, kind, kind_attempt, status, request_sha256, " +
          "request_json, observation_sha256, observation_json, result_sha256, result_json, " +
          "error_code, started_at, finished_at) " +
          "VALUES (?, ?, ?, ?, ?, 'started', ?, ?, NULL, NULL, NULL, NULL, NULL, ?, NULL)",
      )
      .run(
        operationId,
        status.landing.id,
        attempt.ordinal,
        kind,
        kindAttempt,
        requestSha256,
        requestJson,
        this.#timestamp(),
      );
    this.#appendEvent(status.landing.id, "landing.operation.started", {
      schemaVersion: 1,
      landingId: status.landing.id,
      operationId,
      coordinatorAttempt: attempt.ordinal,
      kind,
      kindAttempt,
      requestSha256,
    });
    return operationId;
  }

  startCandidate(landingId: string): LandingOperationAdmissionV1 {
    let operationId = "";
    const transaction = this.#database.transaction(() => {
      const status = this.#mutableStatus(landingId);
      if (status.landing.state !== "preparing_candidate") {
        throw new IcarusError("INVALID_LANDING_STATE", "Landing is not preparing its candidate");
      }
      operationId = this.#startOperation(status, "candidate.prepare", {
        profileSha256: status.landing.profileSha256,
        baseCommitSha1: status.landing.baseCommitSha1,
        baseTreeSha1: status.landing.baseTreeSha1,
        planSha256: status.landing.planSha256,
        diffSha256: status.landing.diffSha256,
        checkpointSha256: status.landing.checkpointSha256,
        verificationSha256: status.landing.verificationSha256,
        reviewDecisionSha256: status.landing.reviewDecisionSha256,
        changedPathsSha256: status.landing.changedPathsSha256,
        headRef: status.landing.headRef,
        commitMessageSha256: status.landing.commitMessageSha256,
        commitEpochSeconds: status.landing.commitEpochSeconds,
        commitIso8601: status.landing.commitIso8601,
        pullRequestTitleSha256: status.landing.pullRequestTitleSha256,
        pullRequestBodyPrefixSha256: status.landing.pullRequestBodyPrefixSha256,
      });
    });
    runImmediate(transaction);
    return { status: this.getStatus(landingId), operationId };
  }

  #startedOperation(
    status: LandingStatusV1,
    kind?: LandingOperationRecordV1["kind"],
  ): LandingOperationRecordV1 {
    const started = status.operations.filter(
      (operation) =>
        operation.status === "started" && (kind === undefined || operation.kind === kind),
    );
    if (started.length !== 1 || started[0] === undefined) {
      throw new IcarusError("LANDING_NOT_ADMITTED", "Landing has no matching active operation");
    }
    return started[0];
  }

  #settleOperation(
    operation: LandingOperationRecordV1,
    input: LandingOperationResultV1,
  ): LandingOperationResultV1 {
    const result = decodeLandingOperationResultV1(input);
    if (result.operationId !== operation.id || result.kind !== operation.kind) {
      invalid("Landing operation settlement does not bind its admitted request");
    }
    const observationFacts = operation.observation?.facts ?? [];
    if (
      result.evidence.length !== observationFacts.length ||
      !result.evidence.every(
        (entry, index) =>
          entry.requestId === observationFacts[index]?.requestId &&
          entry.resultSha256 === observationFacts[index]?.resultSha256,
      )
    ) {
      invalid("Landing operation settlement evidence does not replay its observation");
    }
    const rowStatus =
      result.outcome === "completed"
        ? "completed"
        : result.outcome === "failed"
          ? "failed"
          : "interrupted";
    const resultJson = canonicalLandingJson(result);
    const resultSha256 = sha256(resultJson);
    const update = this.#database
      .prepare(
        "UPDATE landing_operations SET status = ?, result_sha256 = ?, result_json = ?, " +
          "error_code = ?, finished_at = ? WHERE id = ? AND landing_id = ? AND status = 'started'",
      )
      .run(
        rowStatus,
        resultSha256,
        resultJson,
        result.errorCode,
        this.#timestamp(),
        operation.id,
        operation.landingId,
      );
    if (update.changes !== 1) {
      throw new IcarusError("LANDING_CONFLICT", "Landing operation admission changed");
    }
    this.#appendEvent(operation.landingId, "landing.operation.settled", {
      schemaVersion: 1,
      landingId: operation.landingId,
      operationId: operation.id,
      coordinatorAttempt: operation.coordinatorAttempt,
      kind: operation.kind,
      outcome: result.outcome,
      resultSha256,
      errorCode: result.errorCode,
    });
    return result;
  }

  #settleAttempt(
    attempt: LandingAttemptRecordV1,
    outcome: "completed" | "failed" | "interrupted",
    errorCode: string | null,
  ): void {
    const canonicalError =
      outcome === "completed"
        ? errorCode === null
          ? null
          : invalid("Completed landing attempt cannot have an error")
        : assertSafeCode(errorCode, "landing attempt errorCode");
    const update = this.#database
      .prepare(
        "UPDATE landing_attempts SET status = ?, finished_at = ?, error_code = ? " +
          "WHERE landing_id = ? AND ordinal = ? AND status = 'started'",
      )
      .run(outcome, this.#timestamp(), canonicalError, attempt.landingId, attempt.ordinal);
    if (update.changes !== 1) {
      throw new IcarusError("LANDING_CONFLICT", "Landing attempt admission changed");
    }
    this.#appendEvent(attempt.landingId, "landing.attempt.settled", {
      schemaVersion: 1,
      landingId: attempt.landingId,
      coordinatorAttempt: attempt.ordinal,
      outcome,
      errorCode: canonicalError,
    });
  }

  #transition(
    landing: LandingRecordV1,
    to: LandingStateV1,
    resumeState: LandingResumeStateV1 | null,
    errorCode: string | null,
    operationId: string | null,
  ): void {
    assertLandingTransition(landing.state, to);
    assertLandingStateResumePair(to, resumeState);
    const canonicalError =
      errorCode === null ? null : assertSafeCode(errorCode, "landing transition errorCode");
    const version = landing.version + 1;
    const update = this.#database
      .prepare(
        "UPDATE landings SET state = ?, resume_state = ?, error_code = ?, version = ?, " +
          "updated_at = ? WHERE id = ? AND state = ? AND version = ?",
      )
      .run(
        to,
        resumeState,
        canonicalError,
        version,
        this.#timestamp(),
        landing.id,
        landing.state,
        landing.version,
      );
    if (update.changes !== 1) {
      throw new IcarusError("LANDING_CONFLICT", "Landing state changed concurrently");
    }
    this.#appendEvent(landing.id, "landing.state.changed", {
      schemaVersion: 1,
      landingId: landing.id,
      from: landing.state,
      to,
      version,
      operationId,
    });
  }

  settleCandidate(landingId: string, input: CandidateSettlementInputV1): LandingStatusV1 {
    const candidateTreeSha1 = assertSha1(input.candidateTreeSha1, "candidateTreeSha1");
    const candidateCommitSha1 = assertSha1(input.candidateCommitSha1, "candidateCommitSha1");
    const candidateCommitPayloadSha256 = assertSha256(
      input.candidateCommitPayloadSha256,
      "candidateCommitPayloadSha256",
    );
    const candidateObjectManifestSha256 = assertSha256(
      input.candidateObjectManifestSha256,
      "candidateObjectManifestSha256",
    );
    const candidateCredentialAuditSha256 = assertSha256(
      input.candidateCredentialAuditSha256,
      "candidateCredentialAuditSha256",
    );
    const pullRequestBodySha256 = assertSha256(
      input.pullRequestBodySha256,
      "pullRequestBodySha256",
    );
    const authority = decodeLandingDigestV1(input.landingDigest);
    const authoritySha256 = digestLandingRecord(authority);
    const transaction = this.#database.transaction(() => {
      const status = this.#mutableStatus(landingId);
      if (status.landing.state !== "preparing_candidate") {
        throw new IcarusError("INVALID_LANDING_STATE", "Landing is not preparing its candidate");
      }
      const operation = this.#startedOperation(status, "candidate.prepare");
      const attempt = this.#startedAttempt(status);
      if (operation.coordinatorAttempt !== attempt.ordinal) {
        invalid("Candidate operation and coordinator attempt disagree");
      }
      const result = decodeLandingOperationResultV1({
        schemaVersion: 1,
        operationId: operation.id,
        kind: "candidate.prepare",
        outcome: "completed",
        boundary: "candidate_ready",
        evidence: [],
        value: {
          candidateTreeSha1,
          candidateCommitSha1,
          candidateCommitPayloadSha256,
          candidateObjectManifestSha256,
          candidateCredentialAuditSha256,
          diffByteEqual: true,
        },
        errorCode: null,
      });
      const projected: LandingStatusV1 = {
        ...status,
        landing: {
          ...status.landing,
          state: "awaiting_approval",
          credentialAuditSha256: candidateCredentialAuditSha256,
          pullRequestBodySha256,
          candidateTreeSha1,
          candidateCommitSha1,
          candidateCommitPayloadSha256,
          landingSha256: authoritySha256,
        },
        operations: status.operations.map((entry) =>
          entry.id === operation.id
            ? { ...entry, status: "completed", result, resultSha256: digestLandingRecord(result) }
            : entry,
        ),
      };
      const reconstructed = reconstructLandingDigest(projected);
      if (
        reconstructed === null ||
        reconstructed.sha256 !== authoritySha256 ||
        canonicalLandingJson(reconstructed.record) !== canonicalLandingJson(authority)
      ) {
        invalid("Candidate settlement does not reconstruct the supplied landing authority");
      }
      this.#settleOperation(operation, result);
      this.#settleAttempt(attempt, "completed", null);
      const candidateUpdate = this.#database
        .prepare(
          "UPDATE landings SET credential_audit_sha256 = ?, pull_request_body_sha256 = ?, " +
            "candidate_tree_sha1 = ?, candidate_commit_sha1 = ?, " +
            "candidate_commit_payload_sha256 = ?, landing_sha256 = ? " +
            "WHERE id = ? AND state = 'preparing_candidate' AND version = ?",
        )
        .run(
          candidateCredentialAuditSha256,
          pullRequestBodySha256,
          candidateTreeSha1,
          candidateCommitSha1,
          candidateCommitPayloadSha256,
          authoritySha256,
          status.landing.id,
          status.landing.version,
        );
      if (candidateUpdate.changes !== 1) {
        throw new IcarusError("LANDING_CONFLICT", "Landing candidate changed concurrently");
      }
      this.#transition(status.landing, "awaiting_approval", null, null, operation.id);
    });
    runImmediate(transaction);
    return this.getStatus(landingId);
  }

  settleCandidateFailure(
    landingId: string,
    errorCodeInput: string,
    outcome: "failed" | "interrupted",
  ): LandingStatusV1 {
    const errorCode = assertSafeCode(errorCodeInput, "candidate errorCode");
    const transaction = this.#database.transaction(() => {
      const status = this.#mutableStatus(landingId);
      if (status.landing.state !== "preparing_candidate") {
        throw new IcarusError("INVALID_LANDING_STATE", "Landing is not preparing its candidate");
      }
      const operation = this.#startedOperation(status, "candidate.prepare");
      const attempt = this.#startedAttempt(status);
      this.#settleOperation(operation, {
        schemaVersion: 1,
        operationId: operation.id,
        kind: operation.kind,
        outcome,
        boundary: outcome === "failed" ? "operation_failed" : "operation_interrupted",
        evidence: [],
        value: null,
        errorCode,
      });
      this.#settleAttempt(attempt, outcome, errorCode);
      if (outcome === "failed") {
        this.#transition(status.landing, "failed", "preparing_candidate", errorCode, operation.id);
      }
    });
    runImmediate(transaction);
    return this.getStatus(landingId);
  }

  recordDecision(
    landingId: string,
    landingSha256Input: string,
    actorInput: string,
    decisionInput: "approve" | "reject",
  ): LandingStatusV1 {
    const canonicalLandingId = assertUuid(landingId, "landingId");
    const landingSha256 = assertSha256(landingSha256Input, "landingSha256");
    assertOperatorActor(actorInput, "INVALID_ACTOR");
    if (!(decisionInput === "approve" || decisionInput === "reject")) {
      invalid("Landing decision is unsupported");
    }
    const actor = actorInput;
    const transaction = this.#database.transaction(() => {
      const status = this.getStatus(canonicalLandingId);
      if (status.decision !== null) {
        if (
          status.decision.landingSha256 === landingSha256 &&
          status.decision.actor === actor &&
          status.decision.decision === decisionInput
        ) {
          return;
        }
        throw new IcarusError(
          "LANDING_DECISION_CONFLICT",
          "Landing already has a different durable decision",
        );
      }
      this.#assertMutableRun(status);
      this.#assertImmutableEvidence(status);
      if (status.landing.state !== "awaiting_approval") {
        throw new IcarusError("INVALID_LANDING_STATE", "Landing is not awaiting approval");
      }
      if (status.landing.landingSha256 !== landingSha256) {
        throw new IcarusError(
          "LANDING_DECISION_CONFLICT",
          "Landing decision digest is stale or belongs to another landing",
        );
      }
      if (reconstructLandingDigest(status)?.sha256 !== landingSha256) {
        invalid("Landing authority cannot be reconstructed for decision admission");
      }
      const record = decodeLandingDecisionV1({
        id: this.#identifier(),
        landingId: canonicalLandingId,
        landingSha256,
        actor,
        decision: decisionInput,
        createdAt: this.#timestamp(),
      });
      this.#database
        .prepare(
          "INSERT INTO landing_decisions " +
            "(id, landing_id, landing_sha256, actor, decision, created_at) " +
            "VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          record.id,
          record.landingId,
          record.landingSha256,
          record.actor,
          record.decision,
          record.createdAt,
        );
      this.#appendEvent(canonicalLandingId, "landing.decision.recorded", {
        schemaVersion: 1,
        landingId: canonicalLandingId,
        decisionId: record.id,
        landingSha256,
        decision: decisionInput,
        actor,
      });
      this.#transition(
        status.landing,
        decisionInput === "approve" ? "approved" : "rejected",
        null,
        null,
        null,
      );
    });
    runImmediate(transaction);
    return this.getStatus(canonicalLandingId);
  }

  startLocalRef(landingId: string): LandingOperationAdmissionV1 {
    let operationId = "";
    const transaction = this.#database.transaction(() => {
      const status = this.#mutableStatus(landingId);
      if (status.landing.state !== "approved" || status.decision?.decision !== "approve") {
        throw new IcarusError(
          "INVALID_LANDING_STATE",
          "Landing is not approved for local delivery",
        );
      }
      if (
        status.landing.landingSha256 === null ||
        status.landing.candidateCommitSha1 === null ||
        reconstructLandingDigest(status)?.sha256 !== status.landing.landingSha256
      ) {
        invalid("Approved landing authority is incomplete");
      }
      operationId = this.#startOperation(status, "local_ref.create", {
        landingSha256: status.landing.landingSha256,
        headRef: status.landing.headRef,
        candidateCommitSha1: status.landing.candidateCommitSha1,
      });
      this.#transition(status.landing, "creating_local_ref", null, null, operationId);
    });
    runImmediate(transaction);
    return { status: this.getStatus(landingId), operationId };
  }

  recordLocalRefObservation(
    landingId: string,
    operationIdInput: string,
    factInput: LocalRefFactV1,
  ): LandingStatusV1 {
    const operationId = assertUuid(operationIdInput, "operationId");
    const fact = decodeLocalRefFactV1(factInput);
    const factSha256 = digestLandingRecord(fact);
    const transaction = this.#database.transaction(() => {
      const status = this.#mutableStatus(landingId);
      const operation = status.operations.find((entry) => entry.id === operationId);
      if (
        operation === undefined ||
        operation.status !== "started" ||
        !(operation.kind === "local_ref.create" || operation.kind === "landing.reconcile")
      ) {
        throw new IcarusError(
          "LANDING_NOT_ADMITTED",
          "Local-ref observation has no active operation",
        );
      }
      let facts: LandingOperationObservationV1["facts"];
      if (operation.kind === "local_ref.create") {
        facts = [{ fact: "local_ref", requestId: null, resultSha256: factSha256 }];
      } else {
        const reconcileInput = operation.request.input as {
          readonly subjectOperationId: string;
        };
        const subject = status.operations.find(
          (entry) => entry.id === reconcileInput.subjectOperationId,
        );
        if (
          subject === undefined ||
          subject.status !== "interrupted" ||
          subject.resultSha256 === null
        ) {
          invalid("Local-ref reconciliation subject is not durably interrupted");
        }
        const subjectProjection = {
          schemaVersion: 1,
          operationId: subject.id,
          landingId: subject.landingId,
          coordinatorAttempt: subject.coordinatorAttempt,
          kind: subject.kind,
          kindAttempt: subject.kindAttempt,
          status: subject.status,
          requestSha256: subject.requestSha256,
          observationSha256: subject.observationSha256,
          resultSha256: subject.resultSha256,
          errorCode: subject.errorCode,
        };
        facts = [
          {
            fact: "subject_operation",
            requestId: null,
            resultSha256: digestLandingRecord(subjectProjection),
          },
          { fact: "local_ref", requestId: null, resultSha256: factSha256 },
        ];
      }
      const observation = decodeLandingOperationObservationV1({
        schemaVersion: 1,
        operationId,
        kind: operation.kind,
        phase: operation.kind === "landing.reconcile" ? "reconciliation" : "pre_effect",
        facts,
      });
      const observationJson = canonicalLandingJson(observation);
      const observationSha256 = sha256(observationJson);
      if (operation.observation !== null) {
        if (
          operation.observationSha256 === observationSha256 &&
          canonicalLandingJson(operation.observation) === observationJson
        ) {
          return;
        }
        throw new IcarusError(
          "LANDING_OBSERVATION_CONFLICT",
          "Operation already has a different durable observation",
        );
      }
      const update = this.#database
        .prepare(
          "UPDATE landing_operations SET observation_sha256 = ?, observation_json = ? " +
            "WHERE id = ? AND landing_id = ? AND status = 'started' " +
            "AND observation_sha256 IS NULL AND observation_json IS NULL",
        )
        .run(observationSha256, observationJson, operation.id, operation.landingId);
      if (update.changes !== 1) {
        throw new IcarusError("LANDING_CONFLICT", "Landing observation changed concurrently");
      }
    });
    runImmediate(transaction);
    return this.getStatus(landingId);
  }

  #assertObservationFact(
    operation: LandingOperationRecordV1,
    factInput: LocalRefFactV1 | null,
    factIndex: number,
  ): LocalRefFactV1 | null {
    const expected = operation.observation?.facts[factIndex];
    if (factInput === null) {
      if (expected !== undefined) invalid("Durable local-ref observation bytes were omitted");
      return null;
    }
    const fact = decodeLocalRefFactV1(factInput);
    if (
      expected === undefined ||
      expected.fact !== "local_ref" ||
      expected.resultSha256 !== digestLandingRecord(fact)
    ) {
      invalid("Local-ref fact does not replay the durable observation digest");
    }
    return fact;
  }

  settleLocalRef(landingId: string, input: LocalRefSettlementInputV1): LandingStatusV1 {
    if (
      !(
        input.outcome === "succeeded" ||
        input.outcome === "failed" ||
        input.outcome === "ambiguous"
      )
    ) {
      invalid("Local-ref execution outcome is unsupported");
    }
    const transaction = this.#database.transaction(() => {
      const status = this.#mutableStatus(landingId);
      if (status.landing.state !== "creating_local_ref") {
        throw new IcarusError("INVALID_LANDING_STATE", "Landing is not creating its local ref");
      }
      const operation = this.#startedOperation(status, "local_ref.create");
      const attempt = this.#startedAttempt(status);
      const observedFact = this.#assertObservationFact(operation, input.observedFact, 0);
      const postEffectFact =
        input.postEffectFact === null ? null : decodeLocalRefFactV1(input.postEffectFact);
      const evidence =
        operation.observation?.facts.map(({ requestId, resultSha256 }) => ({
          requestId,
          resultSha256,
        })) ?? [];
      const exactPostEffect =
        postEffectFact?.state === "direct" &&
        postEffectFact.objectSha1 === status.landing.candidateCommitSha1;
      if (input.outcome === "succeeded" || input.outcome === "ambiguous") {
        const executionError =
          input.outcome === "succeeded"
            ? input.errorCode === null
              ? null
              : invalid("Successful local-ref execution has an error")
            : assertSafeCode(input.errorCode, "ambiguous local-ref errorCode");
        if (observedFact?.state !== "absent") {
          invalid("Executed local-ref mutation lacks durable prior absence");
        }
        if (!exactPostEffect) {
          const errorCode = executionError ?? "LANDING_LOCAL_REF_POST_EFFECT_UNPROVEN";
          this.#settleOperation(operation, {
            schemaVersion: 1,
            operationId: operation.id,
            kind: operation.kind,
            outcome: "reconciliation_required",
            boundary: "reconciliation_required",
            evidence,
            value: { subjectOperationId: operation.id, remoteResidue: "none" },
            errorCode,
          });
          this.#settleAttempt(attempt, "interrupted", errorCode);
          this.#transition(
            status.landing,
            "reconciliation_required",
            "approved",
            errorCode,
            operation.id,
          );
          return;
        }
        const localRefOutcome = input.outcome === "succeeded" ? "created" : "reconciled";
        this.#settleOperation(operation, {
          schemaVersion: 1,
          operationId: operation.id,
          kind: operation.kind,
          outcome: "completed",
          boundary: "local_ref_ready",
          evidence,
          value: {
            headRef: status.landing.headRef,
            candidateCommitSha1: status.landing.candidateCommitSha1,
            localRefOutcome,
            updateRefExitCode: localRefOutcome === "created" ? 0 : null,
          },
          errorCode: null,
        });
        this.#settleAttempt(attempt, "completed", null);
        this.#transition(status.landing, "local_ready", null, null, operation.id);
        return;
      }
      const errorCode = assertSafeCode(input.errorCode, "local-ref errorCode");
      this.#settleOperation(operation, {
        schemaVersion: 1,
        operationId: operation.id,
        kind: operation.kind,
        outcome: "failed",
        boundary: "operation_failed",
        evidence,
        value: null,
        errorCode,
      });
      this.#settleAttempt(attempt, "failed", errorCode);
      this.#transition(status.landing, "failed", "approved", errorCode, operation.id);
    });
    runImmediate(transaction);
    return this.getStatus(landingId);
  }

  #startAttempt(status: LandingStatusV1): LandingAttemptRecordV1 {
    const ordinal = status.attempts.length + 1;
    if (ordinal > 8) {
      throw new IcarusError("LANDING_ATTEMPT_LIMIT", "Landing coordinator attempt limit reached");
    }
    const now = this.#timestamp();
    const update = this.#database
      .prepare(
        "UPDATE landings SET attempt_count = ?, updated_at = ? " +
          "WHERE id = ? AND attempt_count = ?",
      )
      .run(ordinal, now, status.landing.id, status.landing.attemptCount);
    if (update.changes !== 1) {
      throw new IcarusError("LANDING_CONFLICT", "Landing attempt count changed concurrently");
    }
    this.#database
      .prepare(
        "INSERT INTO landing_attempts " +
          "(landing_id, ordinal, status, started_at, finished_at, error_code) " +
          "VALUES (?, ?, 'started', ?, NULL, NULL)",
      )
      .run(status.landing.id, ordinal, now);
    this.#appendEvent(status.landing.id, "landing.attempt.started", {
      schemaVersion: 1,
      landingId: status.landing.id,
      coordinatorAttempt: ordinal,
    });
    return {
      landingId: status.landing.id,
      ordinal,
      status: "started",
      startedAt: now,
      finishedAt: null,
      errorCode: null,
    };
  }

  #localReconciliationSubject(status: LandingStatusV1): LandingOperationRecordV1 {
    return localReconciliationSubject(status);
  }

  startGitHubPreflight(
    expectedRunId: string,
    landingId: string,
    replayOperationId: string | null,
  ): LandingOperationAdmissionV1 {
    const canonicalRunId = assertUuid(expectedRunId, "runId");
    const canonicalLandingId = assertUuid(landingId, "landingId");
    const canonicalReplayOperationId =
      replayOperationId === null ? null : assertUuid(replayOperationId, "replayOperationId");
    const transaction = this.#database.transaction((): LandingOperationAdmissionV1 => {
      const status = this.#mutableStatus(canonicalLandingId);
      if (status.landing.runId !== canonicalRunId) {
        throw new IcarusError(
          "RUN_LEASE_MISMATCH",
          "GitHub preflight belongs to another run lease",
        );
      }
      if (
        status.landing.state !== "local_ready" ||
        status.decision?.decision !== "approve" ||
        status.landing.landingSha256 === null
      ) {
        throw new IcarusError(
          "INVALID_LANDING_STATE",
          "Landing is not locally ready for GitHub preflight",
        );
      }
      this.#assertImmutableEvidence(status);
      const attempt = this.#startedAttempt(status);
      const owned = status.operations.filter(
        (operation) => operation.coordinatorAttempt === attempt.ordinal,
      );
      if (
        owned.length === 1 &&
        owned[0]?.kind === "github.preflight" &&
        owned[0].status === "started" &&
        owned[0].id === canonicalReplayOperationId
      ) {
        return { status, operationId: owned[0].id };
      }
      if (owned.length !== 0) {
        throw new IcarusError(
          "LANDING_COORDINATOR_TAKEOVER_REQUIRED",
          "The active landing attempt belongs to an earlier coordinator lease",
        );
      }
      if (canonicalReplayOperationId !== null) {
        throw new IcarusError(
          "LANDING_NOT_ADMITTED",
          "The registered GitHub preflight operation is no longer active",
        );
      }
      const authority = reconstructLandingDigest(status);
      if (authority === null || authority.sha256 !== status.landing.landingSha256) {
        invalid("Local-ready landing has no exact immutable GitHub authority");
      }
      const operationId = this.#startOperation(status, "github.preflight", {
        landingSha256: authority.sha256,
        profileSha256: authority.record.profileSha256,
        baseRef: authority.record.baseRef,
        expectedRemoteBaseSha1: authority.record.expectedRemoteBaseSha1,
        headRef: authority.record.headRef,
        candidateCommitSha1: authority.record.candidateCommitSha1,
        includePullRequestAbsence: false,
      });
      return { status: this.#loadStatus(canonicalLandingId), operationId };
    });
    return runImmediate(transaction);
  }

  #preflightEvidence(
    status: LandingStatusV1,
    operation: LandingOperationRecordV1,
  ): PersistedGitHubPreflightEvidenceV1 {
    if (operation.kind !== "github.preflight") {
      invalid("GitHub preflight evidence requires a preflight operation");
    }
    const authority = reconstructLandingDigest(status);
    if (authority === null || authority.sha256 !== status.landing.landingSha256) {
      invalid("GitHub preflight has no exact immutable landing authority");
    }
    const rawOperationRow = this.#database
      .prepare("SELECT * FROM landing_operations WHERE id = ? AND landing_id = ?")
      .get(operation.id, operation.landingId);
    if (rawOperationRow === undefined) invalid("GitHub preflight operation source row is missing");
    const httpRows = this.#preflightHttpRows(operation);
    const rawEventRows = this.#database
      .prepare("SELECT * FROM landing_events WHERE landing_id = ? ORDER BY sequence LIMIT ?")
      .all(operation.landingId, LANDING_LOADER_MAX_EVENTS) as unknown[];
    if (rawEventRows.length !== status.events.length) {
      invalid("GitHub preflight event query is incomplete");
    }
    const operationEvents: unknown[] = [];
    const requestEvents: unknown[] = [];
    for (const [index, event] of status.events.entries()) {
      const rawEvent = rawEventRows[index];
      if (rawEvent === undefined) invalid("GitHub preflight event source row disappeared");
      if (
        (event.type === "landing.operation.started" ||
          event.type === "landing.operation.settled") &&
        (event.payload as { readonly operationId: string }).operationId === operation.id
      ) {
        operationEvents.push(rawEvent);
      } else if (
        (event.type === "landing.github.request.admitted" ||
          event.type === "landing.github.request.settled") &&
        (event.payload as { readonly operationId: string }).operationId === operation.id
      ) {
        requestEvents.push(rawEvent);
      }
    }
    return validatePersistedGitHubPreflightOperationV1({
      landing: authority.record,
      landingSha256: authority.sha256,
      operationStartState: operation.request.expectedState,
      operationStartVersion: operation.request.expectedVersion,
      operationRow: rawOperationRow,
      // The current loader admits exactly one operation per attempt, so this
      // local-ready preflight owns request ordinals beginning at one.
      previousRequestOrdinal: 0,
      httpRows,
      requestEvents,
      operationEvents,
    });
  }

  admitNextGitHubPreflightRequest(
    expectedRunId: string,
    landingId: string,
    operationId: string,
  ): LandingGitHubPreflightRequestAdmissionV1 {
    const canonicalRunId = assertUuid(expectedRunId, "runId");
    const canonicalLandingId = assertUuid(landingId, "landingId");
    const canonicalOperationId = assertUuid(operationId, "operationId");
    const transaction = this.#database.transaction((): LandingGitHubPreflightRequestAdmissionV1 => {
      const status = this.#mutableStatus(canonicalLandingId);
      if (status.landing.runId !== canonicalRunId) {
        throw new IcarusError(
          "RUN_LEASE_MISMATCH",
          "GitHub preflight admission belongs to another run lease",
        );
      }
      if (status.landing.state !== "local_ready") {
        throw new IcarusError(
          "INVALID_LANDING_STATE",
          "Landing is not locally ready for GitHub preflight admission",
        );
      }
      this.#assertImmutableEvidence(status);
      const operation = this.#startedOperation(status, "github.preflight");
      const attempt = this.#startedAttempt(status);
      if (
        operation.id !== canonicalOperationId ||
        operation.coordinatorAttempt !== attempt.ordinal
      ) {
        throw new IcarusError(
          "LANDING_NOT_ADMITTED",
          "GitHub preflight operation does not own the active attempt",
        );
      }
      const evidence = this.#preflightEvidence(status, operation);
      if (evidence.status === "admitted") {
        if (evidence.request.method !== "GET") {
          invalid("Admitted GitHub preflight request is not a GET");
        }
        return {
          status,
          request: evidence.request as LandingGitHubPreflightRequestAdmissionV1["request"],
          requestSha256: evidence.requestSha256,
        };
      }
      if (evidence.status !== "next_request") {
        throw new IcarusError(
          "LANDING_NOT_ADMITTED",
          "GitHub preflight has no next request to admit",
        );
      }
      const request = decodeLandingHttpRequestV1({
        ...evidence.nextRequest,
        requestId: this.#identifier(),
      });
      if (request.operationKind !== "github.preflight" || request.method !== "GET") {
        invalid("Derived GitHub preflight request crosses its fixed request grammar");
      }
      const requestJson = canonicalLandingJson(request);
      const requestSha256 = sha256(requestJson);
      const admittedAt = this.#timestamp();
      this.#database
        .prepare(
          "INSERT INTO landing_http_requests " +
            "(id, landing_id, operation_id, coordinator_attempt, operation_kind, " +
            "request_ordinal, kind, method, request_sha256, request_json, status, outcome, " +
            "http_status, result_sha256, result_json, error_code, admitted_at, settled_at) " +
            "VALUES (?, ?, ?, ?, 'github.preflight', ?, ?, 'GET', ?, ?, 'admitted', " +
            "NULL, NULL, NULL, NULL, NULL, ?, NULL)",
        )
        .run(
          request.requestId,
          request.landingId,
          request.operationId,
          request.coordinatorAttempt,
          request.requestOrdinal,
          request.kind,
          requestSha256,
          requestJson,
          admittedAt,
        );
      this.#appendEvent(canonicalLandingId, "landing.github.request.admitted", {
        schemaVersion: 1,
        landingId: canonicalLandingId,
        operationId: operation.id,
        requestId: request.requestId,
        coordinatorAttempt: operation.coordinatorAttempt,
        operationKind: "github.preflight",
        requestOrdinal: request.requestOrdinal,
        kind: request.kind,
        requestSha256,
      });
      return {
        status: this.#loadStatus(canonicalLandingId),
        request: request as LandingGitHubPreflightRequestAdmissionV1["request"],
        requestSha256,
      };
    });
    return runImmediate(transaction);
  }

  claimAdmittedGitHubPreflightRequest(
    expectedRunId: string,
    requestId: string,
  ): LandingGitHubAdmittedRequestClaimV1 {
    const canonicalRunId = assertUuid(expectedRunId, "runId");
    const canonicalRequestId = assertUuid(requestId, "requestId");
    const transaction = this.#database.transaction((): LandingGitHubAdmittedRequestClaimV1 => {
      const identityPreflight = this.#database
        .prepare(
          "SELECT typeof(landing_id) AS landing_id_type, " +
            "CASE WHEN typeof(landing_id) = 'text' THEN octet_length(landing_id) " +
            "ELSE NULL END AS landing_id_bytes " +
            "FROM landing_http_requests WHERE id = ?",
        )
        .get(canonicalRequestId);
      if (identityPreflight === undefined) {
        throw new IcarusError(
          "GITHUB_ADMITTED_REQUEST_UNAVAILABLE",
          "Admitted GitHub request is unavailable",
        );
      }
      const identityShape = expectRow(identityPreflight, "landing HTTP request identity preflight");
      if (text(identityShape.landing_id_type, "landing_http_requests.landing_id type") !== "text") {
        invalid("landing_http_requests.landing_id is not bounded text");
      }
      integer(
        identityShape.landing_id_bytes,
        "landing_http_requests.landing_id bytes",
        0,
        LANDING_LOADER_ID_MAX_BYTES,
      );
      const identity = this.#database
        .prepare(
          "SELECT landing_id FROM landing_http_requests WHERE id = ? " +
            "AND typeof(landing_id) = 'text' AND octet_length(landing_id) <= ?",
        )
        .get(canonicalRequestId, LANDING_LOADER_ID_MAX_BYTES);
      if (identity === undefined) {
        invalid("Bounded GitHub request identity disappeared during claim");
      }
      const landingId = assertUuid(
        expectRow(identity, "landing HTTP request identity").landing_id,
        "landing_http_requests.landing_id",
      );
      const status = this.#mutableStatus(landingId);
      if (status.landing.runId !== canonicalRunId) {
        throw new IcarusError("RUN_LEASE_MISMATCH", "GitHub request belongs to another run lease");
      }
      this.#assertImmutableEvidence(status);
      const operation = this.#startedOperation(status, "github.preflight");
      const attempt = this.#startedAttempt(status);
      if (operation.coordinatorAttempt !== attempt.ordinal) {
        invalid("Admitted GitHub preflight request crosses its active attempt");
      }
      const evidence = this.#preflightEvidence(status, operation);
      if (
        evidence.status !== "admitted" ||
        evidence.request.requestId !== canonicalRequestId ||
        evidence.request.method !== "GET" ||
        status.landing.landingSha256 === null
      ) {
        throw new IcarusError(
          "GITHUB_ADMITTED_REQUEST_UNAVAILABLE",
          "Admitted GitHub request is unavailable",
        );
      }
      return {
        request: evidence.request as LandingGitHubAdmittedRequestClaimV1["request"],
        landingSha256: status.landing.landingSha256,
      };
    });
    return runImmediate(transaction);
  }

  #writePreflightOperationSettlement(
    operation: LandingOperationRecordV1,
    resultInput: LandingOperationResultV1,
    observationInput: LandingOperationObservationV1 | null,
    finishedAt: string,
  ): void {
    const result = decodeLandingOperationResultV1(resultInput);
    const observation =
      observationInput === null ? null : decodeLandingOperationObservationV1(observationInput);
    if (
      operation.kind !== "github.preflight" ||
      result.operationId !== operation.id ||
      result.kind !== "github.preflight" ||
      (result.outcome === "completed") !== (observation !== null) ||
      (observation !== null &&
        (observation.operationId !== operation.id || observation.kind !== "github.preflight"))
    ) {
      invalid("GitHub preflight settlement does not bind its active operation");
    }
    if (finishedAt < operation.startedAt) {
      invalid("GitHub preflight operation settlement precedes its admission");
    }
    const rowStatus =
      result.outcome === "completed"
        ? "completed"
        : result.outcome === "failed"
          ? "failed"
          : "interrupted";
    const observationJson = observation === null ? null : canonicalLandingJson(observation);
    const observationSha256 = observationJson === null ? null : sha256(observationJson);
    const resultJson = canonicalLandingJson(result);
    const resultSha256 = sha256(resultJson);
    const update = this.#database
      .prepare(
        "UPDATE landing_operations SET status = ?, observation_sha256 = ?, " +
          "observation_json = ?, result_sha256 = ?, result_json = ?, error_code = ?, " +
          "finished_at = ? WHERE id = ? AND landing_id = ? AND coordinator_attempt = ? " +
          "AND kind = 'github.preflight' AND kind_attempt = ? AND request_sha256 = ? " +
          "AND request_json = ? AND status = 'started' AND observation_sha256 IS NULL " +
          "AND observation_json IS NULL AND result_sha256 IS NULL AND result_json IS NULL " +
          "AND error_code IS NULL AND finished_at IS NULL",
      )
      .run(
        rowStatus,
        observationSha256,
        observationJson,
        resultSha256,
        resultJson,
        result.errorCode,
        finishedAt,
        operation.id,
        operation.landingId,
        operation.coordinatorAttempt,
        operation.kindAttempt,
        operation.requestSha256,
        canonicalLandingJson(operation.request),
      );
    if (update.changes !== 1) {
      throw new IcarusError("LANDING_CONFLICT", "GitHub preflight operation changed concurrently");
    }
    this.#appendEvent(operation.landingId, "landing.operation.settled", {
      schemaVersion: 1,
      landingId: operation.landingId,
      operationId: operation.id,
      coordinatorAttempt: operation.coordinatorAttempt,
      kind: "github.preflight",
      outcome: result.outcome,
      resultSha256,
      errorCode: result.errorCode,
    });
  }

  settleGitHubPreflightRequest(
    expectedRunId: string,
    landingId: string,
    operationId: string,
    input: LandingGitHubPreflightSettlementInputV1,
  ): LandingStatusV1 {
    const canonicalRunId = assertUuid(expectedRunId, "runId");
    const canonicalLandingId = assertUuid(landingId, "landingId");
    const canonicalOperationId = assertUuid(operationId, "operationId");
    const rawInput = exactDataRecord(
      input,
      ["request", "requestSha256", "result", "resultSha256"],
      "githubPreflightSettlement",
    );
    const request = decodeLandingHttpRequestV1(rawInput.request);
    const requestSha256 = assertSha256(
      rawInput.requestSha256,
      "githubPreflightSettlement.requestSha256",
    );
    const result = decodeLandingHttpResultV1(rawInput.result);
    const resultSha256 = assertSha256(
      rawInput.resultSha256,
      "githubPreflightSettlement.resultSha256",
    );
    if (
      request.operationKind !== "github.preflight" ||
      request.method !== "GET" ||
      request.landingId !== canonicalLandingId ||
      request.operationId !== canonicalOperationId ||
      requestSha256 !== digestLandingRecord(request) ||
      result.requestId !== request.requestId ||
      result.kind !== request.kind ||
      resultSha256 !== digestLandingRecord(result)
    ) {
      invalid("GitHub preflight settlement changed its admitted request or result digest");
    }
    const requestJson = canonicalLandingJson(request);
    const resultJson = canonicalLandingJson(result);
    const transaction = this.#database.transaction((): LandingStatusV1 => {
      const status = this.#mutableStatus(canonicalLandingId);
      if (status.landing.runId !== canonicalRunId) {
        throw new IcarusError(
          "RUN_LEASE_MISMATCH",
          "GitHub preflight settlement belongs to another run lease",
        );
      }
      const rowValue = this.#database
        .prepare("SELECT * FROM landing_http_requests WHERE id = ? AND landing_id = ?")
        .get(request.requestId, canonicalLandingId);
      if (rowValue === undefined) {
        throw new IcarusError(
          "GITHUB_ADMITTED_REQUEST_UNAVAILABLE",
          "Admitted GitHub request is unavailable",
        );
      }
      const row = expectRow(rowValue, "landing HTTP request");
      if (
        text(row.request_json, "landing_http_requests.request_json") !== requestJson ||
        assertSha256(row.request_sha256, "landing_http_requests.request_sha256") !== requestSha256
      ) {
        throw new IcarusError("LANDING_CONFLICT", "GitHub request admission changed");
      }
      if (row.status === "settled") {
        if (
          text(row.result_json, "landing_http_requests.result_json") !== resultJson ||
          assertSha256(row.result_sha256, "landing_http_requests.result_sha256") !== resultSha256
        ) {
          throw new IcarusError("LANDING_CONFLICT", "GitHub request settled differently");
        }
        return status;
      }
      if (row.status !== "admitted") {
        invalid("GitHub preflight request has an unsupported durable status");
      }
      const operation = this.#startedOperation(status, "github.preflight");
      const attempt = this.#startedAttempt(status);
      if (
        operation.id !== canonicalOperationId ||
        operation.coordinatorAttempt !== attempt.ordinal
      ) {
        throw new IcarusError(
          "LANDING_NOT_ADMITTED",
          "GitHub preflight settlement does not own the active attempt",
        );
      }
      const evidence = this.#preflightEvidence(status, operation);
      if (
        evidence.status !== "admitted" ||
        evidence.request.requestId !== request.requestId ||
        evidence.requestSha256 !== requestSha256
      ) {
        throw new IcarusError(
          "GITHUB_ADMITTED_REQUEST_UNAVAILABLE",
          "Admitted GitHub request is unavailable",
        );
      }
      const settledAt = this.#timestamp();
      const admittedAt = assertInstant(row.admitted_at, "landing_http_requests.admitted_at");
      if (settledAt < admittedAt) {
        invalid("GitHub request settlement precedes its admission");
      }
      const update = this.#database
        .prepare(
          "UPDATE landing_http_requests SET status = 'settled', outcome = ?, http_status = ?, " +
            "result_sha256 = ?, result_json = ?, error_code = ?, settled_at = ? " +
            "WHERE id = ? AND landing_id = ? AND operation_id = ? AND coordinator_attempt = ? " +
            "AND operation_kind = 'github.preflight' AND request_ordinal = ? AND kind = ? " +
            "AND method = 'GET' AND request_sha256 = ? AND request_json = ? " +
            "AND status = 'admitted' AND outcome IS NULL AND http_status IS NULL " +
            "AND result_sha256 IS NULL AND result_json IS NULL AND error_code IS NULL " +
            "AND settled_at IS NULL",
        )
        .run(
          result.outcome,
          result.httpStatus,
          resultSha256,
          resultJson,
          result.errorCode,
          settledAt,
          request.requestId,
          request.landingId,
          request.operationId,
          request.coordinatorAttempt,
          request.requestOrdinal,
          request.kind,
          requestSha256,
          requestJson,
        );
      if (update.changes !== 1) {
        throw new IcarusError("LANDING_CONFLICT", "GitHub request admission changed concurrently");
      }
      this.#appendEvent(canonicalLandingId, "landing.github.request.settled", {
        schemaVersion: 1,
        landingId: canonicalLandingId,
        operationId: operation.id,
        requestId: request.requestId,
        coordinatorAttempt: operation.coordinatorAttempt,
        operationKind: "github.preflight",
        requestOrdinal: request.requestOrdinal,
        kind: request.kind,
        outcome: result.outcome,
        resultSha256,
        errorCode: result.errorCode,
      });

      const settledPrefix = evidence.exchanges.slice(0, -1).map((exchange) => {
        if (exchange.status !== "settled") {
          return invalid("GitHub preflight contains a non-tail admitted request");
        }
        return {
          request: exchange.request,
          requestSha256: exchange.requestSha256,
          result: exchange.result,
          resultSha256: exchange.resultSha256,
        };
      });
      const currentExchange = { request, requestSha256, result, resultSha256 };
      if (result.outcome === "succeeded") {
        const authority = reconstructLandingDigest(status);
        if (authority === null || authority.sha256 !== status.landing.landingSha256) {
          invalid("GitHub preflight settlement lost immutable landing authority");
        }
        const history = validateGitHubPreflightHttpHistoryV1({
          landing: authority.record,
          landingSha256: authority.sha256,
          operation: operation.request,
          operationRequestSha256: operation.requestSha256,
          previousRequestOrdinal: 0,
          exchanges: [...settledPrefix, currentExchange],
        });
        if (history.status === "complete") {
          this.#writePreflightOperationSettlement(
            operation,
            history.operationResult,
            history.observation,
            settledAt,
          );
        }
      } else {
        const operationOutcome = result.outcome === "failed" ? "failed" : "interrupted";
        const operationResult = decodeLandingOperationResultV1({
          schemaVersion: 1,
          operationId: operation.id,
          kind: "github.preflight",
          outcome: operationOutcome,
          boundary: operationOutcome === "failed" ? "operation_failed" : "operation_interrupted",
          evidence: [...settledPrefix, currentExchange].map((exchange) => ({
            requestId: exchange.request.requestId,
            resultSha256: exchange.resultSha256,
          })),
          value: null,
          errorCode: result.errorCode,
        });
        this.#writePreflightOperationSettlement(operation, operationResult, null, settledAt);
        this.#settleAttempt(attempt, operationOutcome, result.errorCode);
        if (operationOutcome === "failed") {
          this.#transition(status.landing, "failed", "local_ready", result.errorCode, operation.id);
        }
      }
      return this.#loadStatus(canonicalLandingId);
    });
    return runImmediate(transaction);
  }

  #startReconciliation(status: LandingStatusV1): string {
    if (
      status.landing.state !== "reconciliation_required" ||
      status.landing.resumeState !== "approved" ||
      status.landing.landingSha256 === null
    ) {
      throw new IcarusError(
        "INVALID_LANDING_STATE",
        "Landing is not awaiting local-ref reconciliation",
      );
    }
    const subject = this.#localReconciliationSubject(status);
    if (subject.resultSha256 === null) invalid("Reconciliation subject result digest is missing");
    return this.#startOperation(status, "landing.reconcile", {
      landingSha256: status.landing.landingSha256,
      resumeState: "approved",
      subjectOperationId: subject.id,
      subjectRequestSha256: subject.requestSha256,
      subjectResultSha256: subject.resultSha256,
    });
  }

  #preflightHttpRows(operation: LandingOperationRecordV1): readonly Row[] {
    const rows = this.#database
      .prepare(
        "SELECT * FROM landing_http_requests " +
          "WHERE landing_id = ? AND operation_id = ? ORDER BY request_ordinal LIMIT 4",
      )
      .all(operation.landingId, operation.id) as unknown[];
    if (rows.length > 3) {
      invalid("GitHub preflight takeover exceeds its bounded HTTP history");
    }
    return rows.map((row) => expectRow(row, "landing HTTP request"));
  }

  #preflightTakeoverEvidence(
    operation: LandingOperationRecordV1,
  ): LandingOperationResultV1["evidence"] {
    let rows = this.#preflightHttpRows(operation);
    const admitted = rows
      .map((row, index) =>
        oneOf(row.status, ["admitted", "settled"] as const, "landing_http_requests.status") ===
        "admitted"
          ? index
          : null,
      )
      .filter((index): index is number => index !== null);
    if (admitted.length > 1 || (admitted.length === 1 && admitted[0] !== rows.length - 1)) {
      invalid("GitHub preflight takeover has a non-trailing admitted request");
    }
    const admittedIndex = admitted[0];
    if (admittedIndex !== undefined) {
      const row = rows[admittedIndex];
      if (row === undefined) invalid("GitHub preflight admitted request disappeared");
      const requestJson = text(row.request_json, "landing_http_requests.request_json");
      const request = decodeCanonicalLandingJson(requestJson, decodeLandingHttpRequestV1);
      const requestSha256 = requireDigest(
        requestJson,
        row.request_sha256,
        "landing_http_requests.request_sha256",
      );
      if (
        request.landingId !== operation.landingId ||
        request.operationId !== operation.id ||
        request.coordinatorAttempt !== operation.coordinatorAttempt ||
        request.operationKind !== "github.preflight" ||
        request.method !== "GET" ||
        assertUuid(row.id, "landing_http_requests.id") !== request.requestId
      ) {
        invalid("GitHub preflight admitted request crosses its takeover operation");
      }
      const result = decodeLandingHttpResultV1({
        schemaVersion: 1,
        requestId: request.requestId,
        kind: request.kind,
        outcome: "ambiguous",
        httpStatus: null,
        projection: null,
        errorCode: GITHUB_OUTCOME_AMBIGUOUS,
      });
      const resultJson = canonicalLandingJson(result);
      const resultSha256 = sha256(resultJson);
      const settledAt = this.#timestamp();
      const update = this.#database
        .prepare(
          "UPDATE landing_http_requests SET status = 'settled', outcome = 'ambiguous', " +
            "http_status = NULL, result_sha256 = ?, result_json = ?, error_code = ?, settled_at = ? " +
            "WHERE id = ? AND landing_id = ? AND operation_id = ? AND coordinator_attempt = ? " +
            "AND operation_kind = 'github.preflight' AND request_ordinal = ? " +
            "AND kind = ? AND method = 'GET' AND request_sha256 = ? AND request_json = ? " +
            "AND status = 'admitted' " +
            "AND outcome IS NULL AND http_status IS NULL AND result_sha256 IS NULL " +
            "AND result_json IS NULL AND error_code IS NULL AND settled_at IS NULL",
        )
        .run(
          resultSha256,
          resultJson,
          GITHUB_OUTCOME_AMBIGUOUS,
          settledAt,
          request.requestId,
          operation.landingId,
          operation.id,
          operation.coordinatorAttempt,
          request.requestOrdinal,
          request.kind,
          requestSha256,
          requestJson,
        );
      if (update.changes !== 1) {
        throw new IcarusError(
          "LANDING_CONFLICT",
          "GitHub preflight request admission changed during takeover",
        );
      }
      this.#appendEvent(operation.landingId, "landing.github.request.settled", {
        schemaVersion: 1,
        landingId: operation.landingId,
        operationId: operation.id,
        requestId: request.requestId,
        coordinatorAttempt: operation.coordinatorAttempt,
        operationKind: "github.preflight",
        requestOrdinal: request.requestOrdinal,
        kind: request.kind,
        outcome: "ambiguous",
        resultSha256,
        errorCode: GITHUB_OUTCOME_AMBIGUOUS,
      });
      rows = this.#preflightHttpRows(operation);
    }

    return rows.map((row) => {
      if (row.status !== "settled") {
        invalid("GitHub preflight takeover left an admitted request unsettled");
      }
      const request = decodeCanonicalLandingJson(
        text(row.request_json, "landing_http_requests.request_json"),
        decodeLandingHttpRequestV1,
      );
      const resultJson = text(row.result_json, "landing_http_requests.result_json");
      const result = decodeCanonicalLandingJson(resultJson, decodeLandingHttpResultV1);
      const resultSha256 = requireDigest(
        resultJson,
        row.result_sha256,
        "landing_http_requests.result_sha256",
      );
      const httpStatus =
        row.http_status === null
          ? null
          : integer(row.http_status, "landing_http_requests.http_status", 100, 599);
      if (
        request.landingId !== operation.landingId ||
        request.operationId !== operation.id ||
        request.coordinatorAttempt !== operation.coordinatorAttempt ||
        request.operationKind !== "github.preflight" ||
        request.method !== "GET" ||
        assertUuid(row.id, "landing_http_requests.id") !== request.requestId ||
        result.requestId !== request.requestId ||
        result.kind !== request.kind ||
        row.outcome !== result.outcome ||
        httpStatus !== result.httpStatus ||
        nullableText(row.error_code, "landing_http_requests.error_code") !== result.errorCode
      ) {
        invalid("GitHub preflight takeover evidence does not replay its settled HTTP row");
      }
      return { requestId: request.requestId, resultSha256 };
    });
  }

  #settlePreflightTakeoverOperation(
    operation: LandingOperationRecordV1,
    evidence: LandingOperationResultV1["evidence"],
  ): void {
    const result = decodeLandingOperationResultV1({
      schemaVersion: 1,
      operationId: operation.id,
      kind: "github.preflight",
      outcome: "interrupted",
      boundary: "operation_interrupted",
      evidence,
      value: null,
      errorCode: LANDING_COORDINATOR_TAKEOVER,
    });
    const resultJson = canonicalLandingJson(result);
    const resultSha256 = sha256(resultJson);
    const update = this.#database
      .prepare(
        "UPDATE landing_operations SET status = 'interrupted', result_sha256 = ?, " +
          "result_json = ?, error_code = ?, finished_at = ? " +
          "WHERE id = ? AND landing_id = ? AND coordinator_attempt = ? " +
          "AND kind = 'github.preflight' AND kind_attempt = ? " +
          "AND request_sha256 = ? AND request_json = ? AND status = 'started' " +
          "AND observation_sha256 IS NULL AND observation_json IS NULL " +
          "AND result_sha256 IS NULL AND result_json IS NULL AND error_code IS NULL " +
          "AND finished_at IS NULL",
      )
      .run(
        resultSha256,
        resultJson,
        LANDING_COORDINATOR_TAKEOVER,
        this.#timestamp(),
        operation.id,
        operation.landingId,
        operation.coordinatorAttempt,
        operation.kindAttempt,
        operation.requestSha256,
        canonicalLandingJson(operation.request),
      );
    if (update.changes !== 1) {
      throw new IcarusError(
        "LANDING_CONFLICT",
        "GitHub preflight operation changed during takeover",
      );
    }
    this.#appendEvent(operation.landingId, "landing.operation.settled", {
      schemaVersion: 1,
      landingId: operation.landingId,
      operationId: operation.id,
      coordinatorAttempt: operation.coordinatorAttempt,
      kind: "github.preflight",
      outcome: "interrupted",
      resultSha256,
      errorCode: LANDING_COORDINATOR_TAKEOVER,
    });
  }

  admitResume(landingId: string): LandingResumeAdmissionV1 {
    let attemptOrdinal: number | null = null;
    let operationId: string | null = null;
    let attemptLimitReached = false;
    const transaction = this.#database.transaction(() => {
      const status = this.#mutableStatus(landingId);
      const activeAttempt = status.attempts.find((attempt) => attempt.status === "started");
      if (activeAttempt !== undefined) {
        const activeOperations = status.operations.filter(
          (operation) => operation.coordinatorAttempt === activeAttempt.ordinal,
        );
        if (activeOperations.length > 1) {
          invalid("Orphaned landing attempt owns more than one operation");
        }
        const activeOperation = activeOperations[0];
        const expectedActiveKind =
          status.landing.state === "preparing_candidate"
            ? "candidate.prepare"
            : status.landing.state === "creating_local_ref"
              ? "local_ref.create"
              : status.landing.state === "reconciliation_required"
                ? "landing.reconcile"
                : status.landing.state === "local_ready"
                  ? "github.preflight"
                  : null;
        if (
          (activeOperation === undefined &&
            !(
              status.landing.state === "preparing_candidate" ||
              status.landing.state === "approved" ||
              status.landing.state === "local_ready"
            )) ||
          (activeOperation !== undefined &&
            (activeOperation.kind !== expectedActiveKind ||
              !(
                activeOperation.status === "started" ||
                (activeOperation.kind === "github.preflight" &&
                  activeOperation.status === "completed")
              )))
        ) {
          invalid("Orphaned landing attempt does not match its current state");
        }
        let settledTakeoverResult: LandingOperationResultV1 | null = null;
        if (activeOperation !== undefined) {
          if (activeOperation.kind === "github.preflight") {
            if (activeOperation.status === "started") {
              const evidence = this.#preflightTakeoverEvidence(activeOperation);
              this.#settlePreflightTakeoverOperation(activeOperation, evidence);
            }
          } else {
            const evidence =
              activeOperation.observation?.facts.map(({ requestId, resultSha256 }) => ({
                requestId,
                resultSha256,
              })) ?? [];
            if (activeOperation.kind === "local_ref.create") {
              settledTakeoverResult = this.#settleOperation(activeOperation, {
                schemaVersion: 1,
                operationId: activeOperation.id,
                kind: activeOperation.kind,
                outcome: "reconciliation_required",
                boundary: "reconciliation_required",
                evidence,
                value: { subjectOperationId: activeOperation.id, remoteResidue: "none" },
                errorCode: LANDING_COORDINATOR_TAKEOVER,
              });
            } else if (activeOperation.kind === "landing.reconcile") {
              const subject = this.#localReconciliationSubject(status);
              settledTakeoverResult = this.#settleOperation(activeOperation, {
                schemaVersion: 1,
                operationId: activeOperation.id,
                kind: activeOperation.kind,
                outcome: "reconciliation_required",
                boundary: "reconciliation_required",
                evidence,
                value: { subjectOperationId: subject.id, remoteResidue: "none" },
                errorCode: LANDING_COORDINATOR_TAKEOVER,
              });
            } else {
              this.#settleOperation(activeOperation, {
                schemaVersion: 1,
                operationId: activeOperation.id,
                kind: activeOperation.kind,
                outcome: "interrupted",
                boundary: "operation_interrupted",
                evidence,
                value: null,
                errorCode: LANDING_COORDINATOR_TAKEOVER,
              });
            }
          }
        }
        this.#settleAttempt(activeAttempt, "interrupted", LANDING_COORDINATOR_TAKEOVER);
        if (activeOperation?.kind === "local_ref.create") {
          this.#transition(
            status.landing,
            "reconciliation_required",
            "approved",
            LANDING_COORDINATOR_TAKEOVER,
            activeOperation.id,
          );
        }
        if (activeAttempt.ordinal >= 8) {
          attemptLimitReached = true;
          return;
        }
        const attempt = this.#startAttempt(status);
        attemptOrdinal = attempt.ordinal;
        if (
          activeOperation?.kind === "local_ref.create" ||
          activeOperation?.kind === "landing.reconcile"
        ) {
          if (settledTakeoverResult === null) {
            invalid("Landing reconciliation takeover lost its settled operation result");
          }
          const settledOperation: LandingOperationRecordV1 = {
            ...activeOperation,
            status: "interrupted",
            resultSha256: digestLandingRecord(settledTakeoverResult),
            result: settledTakeoverResult,
            errorCode: LANDING_COORDINATOR_TAKEOVER,
            finishedAt: activeOperation.startedAt,
          };
          const reconciliationStatus: LandingStatusV1 = {
            ...status,
            landing: {
              ...status.landing,
              state:
                activeOperation.kind === "local_ref.create"
                  ? "reconciliation_required"
                  : status.landing.state,
              resumeState:
                activeOperation.kind === "local_ref.create"
                  ? "approved"
                  : status.landing.resumeState,
              errorCode:
                activeOperation.kind === "local_ref.create"
                  ? LANDING_COORDINATOR_TAKEOVER
                  : status.landing.errorCode,
              attemptCount: attempt.ordinal,
              version:
                activeOperation.kind === "local_ref.create"
                  ? status.landing.version + 1
                  : status.landing.version,
            },
            attempts: [
              ...status.attempts.map((entry) =>
                entry.ordinal === activeAttempt.ordinal
                  ? {
                      ...entry,
                      status: "interrupted" as const,
                      finishedAt: entry.startedAt,
                      errorCode: LANDING_COORDINATOR_TAKEOVER,
                    }
                  : entry,
              ),
              attempt,
            ],
            operations: status.operations.map((entry) =>
              entry.id === settledOperation.id ? settledOperation : entry,
            ),
          };
          operationId = this.#startReconciliation(reconciliationStatus);
        }
        return;
      }

      if (status.landing.state === "failed") {
        if (status.landing.resumeState === null) invalid("Failed landing has no resume state");
        if (status.landing.attemptCount >= 8) {
          attemptLimitReached = true;
          return;
        }
        const attempt = this.#startAttempt(status);
        attemptOrdinal = attempt.ordinal;
        this.#transition(status.landing, status.landing.resumeState, null, null, null);
        return;
      }
      const resumable =
        status.landing.state === "preparing_candidate" ||
        status.landing.state === "approved" ||
        status.landing.state === "local_ready" ||
        status.landing.state === "reconciliation_required";
      if (!resumable) return;
      if (status.attempts.some((attempt) => attempt.status === "started")) {
        invalid("Landing resume found an unconsumed active attempt");
      }
      if (status.landing.attemptCount >= 8) {
        attemptLimitReached = true;
        return;
      }
      const attempt = this.#startAttempt(status);
      attemptOrdinal = attempt.ordinal;
      if (status.landing.state === "reconciliation_required") {
        operationId = this.#startReconciliation({
          ...status,
          landing: { ...status.landing, attemptCount: attempt.ordinal },
          attempts: [...status.attempts, attempt],
        });
      }
    });
    runImmediate(transaction);
    if (attemptLimitReached) {
      throw new IcarusError("LANDING_ATTEMPT_LIMIT", "Landing coordinator attempt limit reached");
    }
    return {
      status: this.getStatus(landingId),
      attemptOrdinal,
      operationId,
      attemptLimitReached: false,
    };
  }

  settleLocalRefReconciliation(
    landingId: string,
    input: LocalRefReconciliationSettlementInputV1,
  ): LandingStatusV1 {
    if (
      !(
        input.outcome === "local_ready" ||
        input.outcome === "retry_approved" ||
        input.outcome === "reconciliation_required"
      )
    ) {
      invalid("Local-ref reconciliation outcome is unsupported");
    }
    const transaction = this.#database.transaction(() => {
      const status = this.#mutableStatus(landingId);
      if (
        status.landing.state !== "reconciliation_required" ||
        status.landing.resumeState !== "approved"
      ) {
        throw new IcarusError("INVALID_LANDING_STATE", "Landing is not reconciling a local ref");
      }
      const operation = this.#startedOperation(status, "landing.reconcile");
      const attempt = this.#startedAttempt(status);
      const fact = this.#assertObservationFact(operation, input.fact, 1);
      const subject = this.#localReconciliationSubject(status);
      const evidence =
        operation.observation?.facts.map(({ requestId, resultSha256 }) => ({
          requestId,
          resultSha256,
        })) ?? [];
      if (input.outcome === "local_ready") {
        if (
          input.errorCode !== null ||
          fact?.state !== "direct" ||
          fact.objectSha1 !== status.landing.candidateCommitSha1 ||
          !hasAbsentLocalRefIntent(subject)
        ) {
          invalid("Local-ready reconciliation lacks exact candidate and prior-absence proof");
        }
        this.#settleOperation(operation, {
          schemaVersion: 1,
          operationId: operation.id,
          kind: operation.kind,
          outcome: "completed",
          boundary: "subject_settled",
          evidence,
          value: {
            subjectOperationId: subject.id,
            nextState: "local_ready",
            remoteResidue: "none",
            stageValue: {
              headRef: status.landing.headRef,
              candidateCommitSha1: status.landing.candidateCommitSha1,
              localRefOutcome: "reconciled",
              updateRefExitCode: null,
            },
          },
          errorCode: null,
        });
        this.#settleAttempt(attempt, "completed", null);
        this.#transition(status.landing, "local_ready", null, null, operation.id);
        return;
      }
      if (input.outcome === "retry_approved") {
        if (input.errorCode !== null || fact?.state !== "absent") {
          invalid("Approved retry reconciliation requires an absent local ref");
        }
        this.#settleOperation(operation, {
          schemaVersion: 1,
          operationId: operation.id,
          kind: operation.kind,
          outcome: "completed",
          boundary: "retry_stage_proven",
          evidence,
          value: {
            subjectOperationId: subject.id,
            nextState: "approved",
            remoteResidue: "none",
            stageValue: null,
          },
          errorCode: null,
        });
        this.#settleAttempt(attempt, "completed", null);
        this.#transition(status.landing, "approved", null, null, operation.id);
        return;
      }
      const errorCode = assertSafeCode(input.errorCode, "reconciliation errorCode");
      if (
        fact?.state === "absent" ||
        (fact?.state === "direct" &&
          fact.objectSha1 === status.landing.candidateCommitSha1 &&
          hasAbsentLocalRefIntent(subject))
      ) {
        invalid("Decisive reconciliation fact cannot remain unresolved");
      }
      this.#settleOperation(operation, {
        schemaVersion: 1,
        operationId: operation.id,
        kind: operation.kind,
        outcome: "reconciliation_required",
        boundary: "reconciliation_required",
        evidence,
        value: { subjectOperationId: subject.id, remoteResidue: "none" },
        errorCode,
      });
      this.#settleAttempt(attempt, "interrupted", errorCode);
    });
    runImmediate(transaction);
    return this.getStatus(landingId);
  }

  /**
   * Called inside the store's rollback-approval transaction. It either proves
   * there is no landing delivery intent, or atomically abandons the strictly
   * pre-delivery candidate slice. It deliberately does not open its own txn.
   */
  assertRollbackAllowedAndAbandon(runId: string): void {
    const status = this.getStatusForRun(runId);
    if (
      status === null ||
      status.landing.state === "abandoned" ||
      status.landing.state === "rejected"
    ) {
      return;
    }
    const hasDeliveryIntent =
      status.decision !== null ||
      status.operations.some((operation) => operation.kind !== "candidate.prepare");
    const preDeliveryState =
      status.landing.state === "preparing_candidate" ||
      status.landing.state === "awaiting_approval" ||
      (status.landing.state === "failed" && status.landing.resumeState === "preparing_candidate");
    if (hasDeliveryIntent || !preDeliveryState) {
      throw new IcarusError(
        "LANDING_ROLLBACK_CONFLICT",
        "Rollback cannot supersede durable landing delivery intent",
      );
    }
    const activeOperation = status.operations.find((operation) => operation.status === "started");
    const activeAttempt = status.attempts.find((attempt) => attempt.status === "started");
    if (activeOperation !== undefined) {
      if (activeOperation.kind !== "candidate.prepare") {
        throw new IcarusError(
          "LANDING_ROLLBACK_CONFLICT",
          "Rollback cannot supersede a delivery effect operation",
        );
      }
      this.#settleOperation(activeOperation, {
        schemaVersion: 1,
        operationId: activeOperation.id,
        kind: activeOperation.kind,
        outcome: "interrupted",
        boundary: "operation_interrupted",
        evidence: [],
        value: null,
        errorCode: "LANDING_ABANDONED_FOR_ROLLBACK",
      });
    }
    if (activeAttempt !== undefined) {
      this.#settleAttempt(activeAttempt, "interrupted", "LANDING_ABANDONED_FOR_ROLLBACK");
    }
    this.#transition(status.landing, "abandoned", null, null, null);
  }
}
