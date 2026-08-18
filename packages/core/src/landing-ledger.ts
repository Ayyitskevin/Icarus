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
import {
  assertGitInstant,
  assertInstant,
  assertLandingCredentialEnvironmentAllowed,
  assertLandingDigestTextBindingsV1,
  assertSafeCode,
  assertSha1,
  assertSha256,
  assertUuid,
  type CandidateObjectManifestV1,
  type CandidateReadyValueV1,
  canonicalGitHubPostBodyV1,
  canonicalizeCommitMessage,
  canonicalizePullRequestBodyPrefix,
  canonicalizePullRequestTitle,
  canonicalLandingJson,
  commitEpochToGitInstant,
  DERIVATIVE_EFFECTS,
  DERIVATIVE_GITHUB_EVENTS,
  DIRECT_ICARUS_EFFECTS,
  decodeCanonicalLandingJson,
  decodeCanonicalLandingReceiptJsonV1,
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
  decodeLandingReceiptV1,
  decodeLocalRefFactV1,
  decodeReviewDecisionDigestV1,
  deriveCandidateObjectManifestV1,
  digestLandingRecord,
  type DraftPrExactValueV1,
  GITHUB_API_VERSION,
  type GitHubLandingProfileV1,
  type GitHubObjectsUploadInputV1,
  type GitHubPreflightInputV1,
  type GitHubPullRequestCreateInputV1,
  type GitHubRefCreateInputV1,
  type LandingDecisionV1,
  type LandingDigestV1,
  type LandingEventPayloadV1,
  type LandingHttpProjectionV1,
  type LandingHttpRequestV1,
  type LandingHttpResultV1,
  type LandingOperationObservationV1,
  type LandingOperationRequestV1,
  type LandingOperationResultV1,
  type LandingReceiptV1,
  type LandingReconcileInputV1,
  type LandingStateChangedEventV1,
  type LocalRefFactV1,
  type LocalRefReadyValueV1,
  type ObjectsExactValueV1,
  type PreflightExactValueV1,
  type PullRequestProjectionV1,
  type ReconcileValueV1,
  type ReconciliationRequiredValueV1,
  type RemoteRefReadyValueV1,
  reconstructPullRequestUrlV1,
  renderPullRequestBodyV1,
} from "./landing-records.js";
import {
  assertLandingStateResumePair,
  assertLandingTransition,
  canStartLandingOperation,
  isLandingHttpKindV1,
  isLandingOperationKindV1,
  isLandingResumeStateV1,
  isLandingStateV1,
  type LandingHttpKindV1,
  landingOperationActionState,
  type LandingOperationKindV1,
  landingOperationExpectedStates,
  type LandingResumeStateV1,
  type LandingStateV1,
} from "./landing-state.js";
import { assertOperatorActor } from "./policy.js";
import type { CheckpointFile } from "./types.js";

type Row = Record<string, unknown>;
type JsonRecord = Record<string, unknown>;

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
// S2b-ii-c admits the last runtime slice of Packet 4b: the draft pull request
// and the immutable receipt. Every landing state and operation kind is now
// reachable, and `landing_receipts` is writable exactly once per landing.
const PACKET3_STATES: ReadonlySet<LandingStateV1> = new Set([
  "preparing_candidate",
  "awaiting_approval",
  "approved",
  "creating_local_ref",
  "local_ready",
  "uploading_objects",
  "objects_ready",
  "creating_remote_ref",
  "remote_ready",
  "opening_draft_pr",
  "landed",
  "reconciliation_required",
  "rejected",
  "abandoned",
  "failed",
]);
const PACKET3_OPERATION_KINDS: ReadonlySet<LandingOperationKindV1> = new Set([
  "candidate.prepare",
  "local_ref.create",
  "github.preflight",
  "github.objects.upload",
  "github.ref.create",
  "github.pull_request.create",
  "landing.reconcile",
]);
const ABSENT_LOCAL_REF_FACT_SHA256 = digestLandingRecord({
  schemaVersion: 1,
  state: "absent",
  objectSha1: null,
  symbolicTargetSha256: null,
});

const HTTP_GET_KINDS: ReadonlySet<LandingHttpKindV1> = new Set([
  "github.actor.get",
  "github.base_ref.get",
  "github.head_ref.get",
  "github.pull_requests.get",
]);

/** ADR 0027's conservative per-attempt HTTPS charge: `2 * changedPaths + 32`. */
function httpRequestCharge(changedPathCount: number): number {
  return 2 * changedPathCount + 32;
}

function invalid(message: string, details: Readonly<Record<string, unknown>> = {}): never {
  throw new IcarusError("LANDING_RECORD_INVALID", message, details);
}

function expectRow(value: unknown, field: string): Row {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(field + " row is missing");
  }
  return value as Row;
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
    | "github.objects.upload"
    | "github.ref.create"
    | "github.pull_request.create"
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

export interface LandingHttpRequestRecordV1 {
  readonly id: string;
  readonly landingId: string;
  readonly operationId: string;
  readonly coordinatorAttempt: number;
  readonly operationKind:
    | "candidate.prepare"
    | "local_ref.create"
    | "github.preflight"
    | "github.objects.upload"
    | "github.ref.create"
    | "github.pull_request.create"
    | "landing.reconcile";
  readonly requestOrdinal: number;
  readonly kind: LandingHttpKindV1;
  readonly method: "GET" | "POST";
  readonly requestSha256: string;
  readonly request: LandingHttpRequestV1;
  readonly status: "admitted" | "settled";
  readonly outcome: "succeeded" | "failed" | "ambiguous" | null;
  readonly httpStatus: number | null;
  readonly resultSha256: string | null;
  readonly result: LandingHttpResultV1 | null;
  readonly errorCode: string | null;
  readonly admittedAt: string;
  readonly settledAt: string | null;
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
  readonly httpRequests: readonly LandingHttpRequestRecordV1[];
  readonly events: readonly LandingEventRecordV1[];
  /** The immutable receipt, present exactly when the landing is `landed`. */
  readonly receipt: LandingReceiptV1 | null;
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

export interface LandingHttpRequestAdmissionV1 {
  readonly status: LandingStatusV1;
  readonly requestId: string;
}

/** Coordinator-proposed settlement of one admitted HTTPS request. */
export interface LandingHttpSettlementInputV1 {
  readonly outcome: "succeeded" | "failed" | "ambiguous";
  readonly httpStatus: number | null;
  readonly projection: LandingHttpProjectionV1 | null;
  readonly errorCode: string | null;
}

/**
 * Coordinator-proposed settlement of the read-only preflight operation. A
 * completed outcome derives its exact value from the durable settled reads;
 * failed and interrupted outcomes carry the bounded host error code.
 * `closeAttempt` is true exactly when the coordinator chains no effect
 * operation into the attempt; a chained attempt stays open for it.
 */
export interface GithubPreflightSettlementInputV1 {
  readonly outcome: "completed" | "failed" | "interrupted";
  readonly errorCode: string | null;
  readonly closeAttempt: boolean;
}

/**
 * Coordinator-proposed settlement of one effect operation. The store re-derives
 * the outcome's legality, the stage value, and the remote residue from the
 * durable rows — none of them are caller-chosen.
 */
export interface GithubEffectSettlementInputV1 {
  readonly outcome: "completed" | "failed" | "reconciliation_required";
  readonly errorCode: string | null;
}

/** Coordinator-proposed settlement of one reconciliation operation. */
export interface GithubReconciliationSettlementInputV1 {
  readonly outcome: string;
  readonly errorCode: string | null;
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
    "uploading_objects",
    "objects_ready",
    "creating_remote_ref",
    "remote_ready",
    "opening_draft_pr",
    "landed",
    "reconciliation_required",
    "rejected",
  ]);
  if (
    (stateValue === "preparing_candidate" && candidatePresence.some(Boolean)) ||
    (candidateRequiredStates.has(stateValue) && !candidatePresence.every(Boolean)) ||
    (stateValue === "failed" &&
      ((resumeValue === "preparing_candidate" && candidatePresence.some(Boolean)) ||
        (resumeValue === "approved" && !candidatePresence.every(Boolean))))
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
  if (!isLandingOperationKindV1(kindValue) || !PACKET3_OPERATION_KINDS.has(kindValue)) {
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
  // The evidence rule has a row-local half and an aggregate half. Row-local:
  // evidence always starts with the observation facts, in order. The remainder
  // replays settled HTTPS results, which only `validateAggregate` can see.
  const observationFacts = observation?.facts ?? [];
  if (
    result !== null &&
    (result.evidence.length < observationFacts.length ||
      !observationFacts.every(
        (fact, index) =>
          result.evidence[index]?.requestId === fact.requestId &&
          result.evidence[index]?.resultSha256 === fact.resultSha256,
      ))
  ) {
    invalid("Landing operation result evidence does not replay its observation");
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
        (request.kind === "github.preflight" &&
          (observation.phase !== "pre_effect" ||
            observation.facts.some((fact) => fact.requestId === null) ||
            observation.facts.length !== preflightObservationFactNames(request).length ||
            !preflightObservationFactNames(request).every(
              (name, index) => observation.facts[index]?.fact === name,
            ))) ||
        (request.kind === "github.objects.upload" &&
          (observation.phase !== "pre_effect" ||
            observation.facts.length !== 1 ||
            observation.facts[0]?.fact !== "actor" ||
            observation.facts[0].requestId === null)) ||
        (request.kind === "github.ref.create" &&
          (observation.phase !== "pre_effect" ||
            observation.facts.length !== 3 ||
            observation.facts[0]?.fact !== "actor" ||
            observation.facts[1]?.fact !== "base_ref" ||
            observation.facts[2]?.fact !== "head_ref" ||
            observation.facts.some((fact) => fact.requestId === null))) ||
        (request.kind === "landing.reconcile" &&
          (observation.phase !== "reconciliation" ||
            observation.facts[0]?.fact !== "subject_operation" ||
            observation.facts[0].requestId !== null ||
            observation.facts
              .slice(1)
              .some(
                (fact) =>
                  (fact.fact === "local_ref" && fact.requestId !== null) ||
                  (fact.fact !== "local_ref" && fact.requestId === null),
              )))))
  ) {
    invalid("Landing observation does not match its operation request");
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
    kind: kindValue as
      | "candidate.prepare"
      | "local_ref.create"
      | "github.preflight"
      | "github.objects.upload"
      | "github.ref.create"
      | "github.pull_request.create"
      | "landing.reconcile",
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

function preflightInput(request: LandingOperationRequestV1): GitHubPreflightInputV1 {
  const input = request.input;
  if (request.kind !== "github.preflight" || !("includePullRequestAbsence" in input)) {
    invalid("Landing operation request is not a GitHub preflight");
  }
  return input;
}

/** The exact relative HTTP-kind grammar a preflight operation owns. */
function preflightHttpGrammar(request: LandingOperationRequestV1): readonly LandingHttpKindV1[] {
  return preflightInput(request).includePullRequestAbsence
    ? ["github.actor.get", "github.base_ref.get", "github.head_ref.get", "github.pull_requests.get"]
    : ["github.actor.get", "github.base_ref.get", "github.head_ref.get"];
}

function preflightObservationFactNames(
  request: LandingOperationRequestV1,
): readonly ("actor" | "base_ref" | "head_ref" | "pull_requests")[] {
  return preflightInput(request).includePullRequestAbsence
    ? ["actor", "base_ref", "head_ref", "pull_requests"]
    : ["actor", "base_ref", "head_ref"];
}

const FACT_NAME_BY_HTTP_GET_KIND = {
  "github.actor.get": "actor",
  "github.base_ref.get": "base_ref",
  "github.head_ref.get": "head_ref",
  "github.pull_requests.get": "pull_requests",
} as const;

/**
 * One grammar member's fully derived descriptor. Subjects and POST body
 * digests are recomputed from immutable landing records (and, for object
 * uploads, the re-derived candidate manifest), never from caller input — a
 * caller proposes only the HTTP kind, and any drift fails closed.
 */
interface HttpDescriptorV1 {
  readonly kind: LandingHttpKindV1;
  readonly method: "GET" | "POST";
  readonly subject: JsonRecord;
  readonly bodySha256: string | null;
}

const REMOTE_REF_HTTP_GRAMMAR = [
  "github.actor.get",
  "github.base_ref.get",
  "github.head_ref.get",
  "github.ref.post",
  "github.head_ref.get",
  "github.base_ref.get",
] as const satisfies readonly LandingHttpKindV1[];

function reconciliationSubjectKind(
  operation: LandingOperationRecordV1,
  operations: readonly LandingOperationRecordV1[],
):
  | "local_ref.create"
  | "github.objects.upload"
  | "github.ref.create"
  | "github.pull_request.create" {
  const input = operation.request.input;
  if (operation.kind !== "landing.reconcile" || !("subjectOperationId" in input)) {
    invalid("Landing operation request is not a reconciliation");
  }
  const subject = operations.find((entry) => entry.id === input.subjectOperationId);
  if (
    subject === undefined ||
    (subject.kind !== "local_ref.create" &&
      subject.kind !== "github.objects.upload" &&
      subject.kind !== "github.ref.create" &&
      subject.kind !== "github.pull_request.create")
  ) {
    invalid("Landing reconciliation subject is outside the implemented slice");
  }
  return subject.kind;
}

const PULL_REQUEST_HTTP_GRAMMAR = [
  "github.actor.get",
  "github.base_ref.get",
  "github.head_ref.get",
  "github.pull_requests.get",
  "github.pull_request.post",
  "github.base_ref.get",
  "github.head_ref.get",
  "github.pull_requests.get",
] as const satisfies readonly LandingHttpKindV1[];

const PULL_REQUEST_RECONCILE_GRAMMAR = [
  "github.actor.get",
  "github.base_ref.get",
  "github.head_ref.get",
  "github.pull_requests.get",
] as const satisfies readonly LandingHttpKindV1[];

/**
 * The exact relative HTTP-kind grammar one operation owns. Candidate and
 * local-ref operations admit no HTTP; object upload owns the actor read plus
 * one blob per non-deleted manifest path in canonical order, then the tree and
 * commit; remote-ref creation owns its three pre-effect reads, at most one
 * absent-only POST, and the fixed post-read suffix; draft-PR creation owns its
 * four pre-effect reads, at most one pull-request POST ever, and the fixed
 * post-read suffix; reconciliation is GET-only and derives from its subject
 * kind.
 */
function httpGrammarFor(
  operation: LandingOperationRecordV1,
  operations: readonly LandingOperationRecordV1[],
  manifest: CandidateObjectManifestV1 | null,
): readonly LandingHttpKindV1[] {
  switch (operation.kind) {
    case "github.preflight":
      return preflightHttpGrammar(operation.request);
    case "github.objects.upload": {
      if (manifest === null) {
        invalid("Object upload requires the derived candidate object manifest");
      }
      return [
        "github.actor.get",
        ...manifest.entries
          .filter((entry) => entry.op !== "delete")
          .map(() => "github.blob.post" as const),
        "github.tree.post",
        "github.commit.post",
      ];
    }
    case "github.ref.create":
      return REMOTE_REF_HTTP_GRAMMAR;
    case "github.pull_request.create":
      return PULL_REQUEST_HTTP_GRAMMAR;
    case "landing.reconcile": {
      const subjectKind = reconciliationSubjectKind(operation, operations);
      if (subjectKind === "github.ref.create") {
        return ["github.actor.get", "github.base_ref.get", "github.head_ref.get"];
      }
      return subjectKind === "github.pull_request.create"
        ? PULL_REQUEST_RECONCILE_GRAMMAR
        : [];
    }
    case "candidate.prepare":
    case "local_ref.create":
      return [];
  }
}

function httpGetDescriptor(kind: LandingHttpKindV1, landing: LandingRecordV1): HttpDescriptorV1 {
  const { profile } = landing;
  switch (kind) {
    case "github.actor.get":
      return {
        kind,
        method: "GET",
        subject: { expectedActor: profile.expectedActor },
        bodySha256: null,
      };
    case "github.base_ref.get":
      return {
        kind,
        method: "GET",
        subject: {
          owner: profile.owner,
          repository: profile.repository,
          baseRef: `refs/heads/${profile.baseBranch}`,
          expectedSha1: landing.baseCommitSha1,
        },
        bodySha256: null,
      };
    case "github.head_ref.get":
      return {
        kind,
        method: "GET",
        subject: {
          owner: profile.owner,
          repository: profile.repository,
          headRef: landing.headRef,
          expectedSha1:
            landing.candidateCommitSha1 ??
            invalid("Landing head-ref subject lacks its candidate commit"),
        },
        bodySha256: null,
      };
    case "github.pull_requests.get":
      return {
        kind,
        method: "GET",
        subject: {
          owner: profile.owner,
          repository: profile.repository,
          headOwner: profile.owner,
          headRef: `icarus/${landing.runId}`,
          baseBranch: profile.baseBranch,
          state: "all",
          page: 1,
          perPage: 100,
        },
        bodySha256: null,
      };
    default:
      return invalid("Landing HTTP descriptor kind is not a read");
  }
}

function httpDescriptorFor(
  kind: LandingHttpKindV1,
  position: number,
  landing: LandingRecordV1,
  manifest: CandidateObjectManifestV1 | null,
  checkpointFiles: readonly CheckpointFile[],
  pullRequestBody: string | null,
): HttpDescriptorV1 {
  if (HTTP_GET_KINDS.has(kind)) {
    return httpGetDescriptor(kind, landing);
  }
  if (kind === "github.pull_request.post") {
    if (pullRequestBody === null || landing.pullRequestBodySha256 === null) {
      invalid("Landing pull-request descriptor lacks its derived body");
    }
    const body = canonicalGitHubPostBodyV1("github.pull_request.post", {
      title: landing.pullRequestTitle,
      head: `${landing.profile.owner}:${landing.headRef.slice("refs/heads/".length)}`,
      base: landing.profile.baseBranch,
      body: pullRequestBody,
      draft: true,
      maintainer_can_modify: false,
    });
    return {
      kind,
      method: "POST",
      subject: {
        baseRef: `refs/heads/${landing.profile.baseBranch}`,
        expectedRemoteBaseSha1: landing.baseCommitSha1,
        headRef: landing.headRef,
        candidateCommitSha1: landing.candidateCommitSha1,
        pullRequestTitleSha256: landing.pullRequestTitleSha256,
        pullRequestBodySha256: landing.pullRequestBodySha256,
        draft: true,
        maintainerCanModify: false,
      },
      bodySha256: body.sha256,
    };
  }
  if (manifest === null) {
    invalid("Landing HTTP mutation descriptor requires the candidate object manifest");
  }
  switch (kind) {
    case "github.blob.post": {
      const nonDeleted = manifest.entries.filter((entry) => entry.op !== "delete");
      const entry = nonDeleted[position - 1];
      if (entry === undefined) {
        invalid("Landing blob grammar position has no manifest entry");
      }
      const file = checkpointFiles.find((candidate) => candidate.path === entry.path);
      if (file === undefined || file.approvedBase64 === null) {
        invalid("Landing blob descriptor lacks its checkpoint bytes");
      }
      const body = canonicalGitHubPostBodyV1("github.blob.post", {
        content: file.approvedBase64,
        encoding: "base64",
      });
      return {
        kind,
        method: "POST",
        subject: {
          pathSha256: sha256(Buffer.from(entry.path, "utf8")),
          contentBytes: entry.contentBytes ?? invalid("Blob manifest entry lacks its byte count"),
          contentSha256:
            entry.contentSha256 ?? invalid("Blob manifest entry lacks its content digest"),
          expectedBlobSha1: entry.blobSha1 ?? invalid("Blob manifest entry lacks its object name"),
        },
        bodySha256: body.sha256,
      };
    }
    case "github.tree.post": {
      const treeEntries = manifest.entries.map((entry) => ({
        path: entry.path,
        mode: "100644" as const,
        type: "blob" as const,
        sha: entry.blobSha1,
      }));
      const body = canonicalGitHubPostBodyV1("github.tree.post", {
        base_tree: landing.baseTreeSha1,
        tree: treeEntries,
      });
      return {
        kind,
        method: "POST",
        subject: {
          baseTreeSha1: landing.baseTreeSha1,
          entriesSha256: digestLandingRecord(treeEntries),
          expectedTreeSha1:
            landing.candidateTreeSha1 ?? invalid("Landing tree subject lacks its candidate tree"),
        },
        bodySha256: body.sha256,
      };
    }
    case "github.commit.post": {
      const party = {
        name: landing.profile.commitIdentity.name,
        email: landing.profile.commitIdentity.email,
        date: landing.commitIso8601,
      };
      const body = canonicalGitHubPostBodyV1("github.commit.post", {
        message: landing.commitMessage,
        tree:
          landing.candidateTreeSha1 ?? invalid("Landing commit subject lacks its candidate tree"),
        parents: [landing.baseCommitSha1],
        author: party,
        committer: party,
      });
      return {
        kind,
        method: "POST",
        subject: {
          candidateTreeSha1: landing.candidateTreeSha1,
          baseCommitSha1: landing.baseCommitSha1,
          candidateCommitPayloadSha256: landing.candidateCommitPayloadSha256,
          expectedCommitSha1: landing.candidateCommitSha1,
          commitIso8601: landing.commitIso8601,
        },
        bodySha256: body.sha256,
      };
    }
    case "github.ref.post": {
      const body = canonicalGitHubPostBodyV1("github.ref.post", {
        ref: landing.headRef,
        sha:
          landing.candidateCommitSha1 ?? invalid("Landing ref subject lacks its candidate commit"),
      });
      return {
        kind,
        method: "POST",
        subject: {
          baseRef: `refs/heads/${landing.profile.baseBranch}`,
          expectedRemoteBaseSha1: landing.baseCommitSha1,
          headRef: landing.headRef,
          candidateCommitSha1: landing.candidateCommitSha1,
        },
        bodySha256: body.sha256,
      };
    }
    default:
      return invalid("Landing HTTP descriptor kind is not derivable in this slice");
  }
}

function httpDescriptorsFor(
  operation: LandingOperationRecordV1,
  landing: LandingRecordV1,
  manifest: CandidateObjectManifestV1 | null,
  checkpointFiles: readonly CheckpointFile[],
  operations: readonly LandingOperationRecordV1[],
  pullRequestBody: string | null = null,
): readonly HttpDescriptorV1[] {
  const grammar = httpGrammarFor(operation, operations, manifest);
  return grammar.map((kind, index) =>
    httpDescriptorFor(kind, index, landing, manifest, checkpointFiles, pullRequestBody),
  );
}

/** Whether a settled request's projection restates the admitted subject. */
function httpProjectionRestatesSubject(
  request: LandingHttpRequestV1,
  projection: LandingHttpProjectionV1,
): boolean {
  const subject = request.subject;
  switch (request.kind) {
    case "github.actor.get":
      return projection.type === "actor" && projection.login === subject.expectedActor;
    case "github.base_ref.get":
      return projection.type === "ref" && projection.ref === subject.baseRef;
    case "github.head_ref.get":
      return projection.type === "ref" && projection.ref === subject.headRef;
    case "github.blob.post":
      return projection.type === "object" && projection.sha1 === subject.expectedBlobSha1;
    case "github.tree.post":
      return projection.type === "object" && projection.sha1 === subject.expectedTreeSha1;
    case "github.commit.post":
      return projection.type === "object" && projection.sha1 === subject.expectedCommitSha1;
    case "github.ref.post":
      return projection.type === "object" && projection.sha1 === subject.candidateCommitSha1;
    case "github.pull_requests.get":
      // The list projection carries no single subject value to restate; its
      // completeness discipline lives in the record decoder.
      return projection.type === "pull_request_list";
    case "github.pull_request.post": {
      if (projection.type !== "pull_request") return false;
      const headRef = typeof subject.headRef === "string" ? subject.headRef : "";
      const baseRef = typeof subject.baseRef === "string" ? subject.baseRef : "";
      return (
        projection.headSha1 === subject.candidateCommitSha1 &&
        projection.baseSha1 === subject.expectedRemoteBaseSha1 &&
        projection.headRef === headRef.slice("refs/heads/".length) &&
        projection.baseRef === baseRef.slice("refs/heads/".length) &&
        projection.titleSha256 === subject.pullRequestTitleSha256 &&
        projection.bodySha256 === subject.pullRequestBodySha256
      );
    }
  }
}

/** The settled interrupted subject projection a reconciliation fact hashes. */
function subjectOperationProjectionSha256(subject: LandingOperationRecordV1): string {
  if (
    subject.status !== "interrupted" ||
    subject.resultSha256 === null ||
    subject.errorCode === null
  ) {
    invalid("Landing reconciliation subject is not durably interrupted");
  }
  return digestLandingRecord({
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
  });
}

/**
 * The honest remote residue of a remote-ref result, derived from the freshest
 * durable head proof. A head read taken after the mutation row supersedes the
 * pre-mutation absence: a proven direct head is a `branch`, a proven absent
 * head is `none`. Without a post-mutation read, a succeeded POST proves the
 * branch, an admitted or ambiguous POST leaves visibility unresolved, and a
 * failed POST fell back to the pre-mutation proof. Never a caller choice.
 */
function remoteRefResidueFromRows(
  rows: readonly LandingHttpRequestRecordV1[],
): "none" | "branch" | "ambiguous" {
  const ordered = [...rows].sort((left, right) => left.requestOrdinal - right.requestOrdinal);
  const postIndex = ordered.findLastIndex((row) => row.kind === "github.ref.post");
  const post = postIndex === -1 ? undefined : ordered[postIndex];
  const headAfter = ordered.filter(
    (row, index) =>
      index > postIndex && row.kind === "github.head_ref.get" && row.status === "settled",
  );
  const freshHead = headAfter.at(-1)?.result?.projection;
  if (freshHead !== undefined && freshHead !== null) {
    return freshHead.type === "ref" && freshHead.state === "direct" ? "branch" : "none";
  }
  if (post !== undefined && post.outcome === "succeeded") {
    return "branch";
  }
  if (post !== undefined && (post.status === "admitted" || post.outcome === "ambiguous")) {
    // The mutation was dispatched (or may have been) and no later read proves
    // the head either way: visibility is unresolved.
    return "ambiguous";
  }
  const headRows = ordered.filter(
    (row) => row.kind === "github.head_ref.get" && row.status === "settled",
  );
  const projection = headRows.at(-1)?.result?.projection;
  if (projection === undefined || projection === null || projection.type !== "ref") {
    return "ambiguous";
  }
  return projection.state === "direct" ? "branch" : "none";
}

/**
 * Whether the interrupted upload subject's durable rows prove every immutable
 * object landed: all rows settled, every mutating POST succeeded with an
 * object projection (which already restated its admitted subject at
 * settlement), and the grammar's final commit write among them.
 */
function objectUploadRowsProveCompletion(
  subject: LandingOperationRecordV1,
  httpRequests: readonly LandingHttpRequestRecordV1[],
): boolean {
  const rows = httpRequests.filter((row) => row.operationId === subject.id);
  const posts = rows.filter((row) => row.method === "POST");
  const commit = rows.find((row) => row.kind === "github.commit.post");
  return (
    rows.length > 0 &&
    rows.every((row) => row.status === "settled") &&
    posts.length > 0 &&
    posts.every(
      (row) => row.outcome === "succeeded" && row.result?.projection?.type === "object",
    ) &&
    commit?.outcome === "succeeded"
  );
}

/**
 * Whether the interrupted remote-ref subject durably recorded the head's
 * absence before its mutation: the observation's head fact must reference the
 * subject's own settled absent-head read, so an exact head can never be
 * adopted from pre-existing provider state.
 */
function hasRemoteRefAbsentIntent(
  subject: LandingOperationRecordV1,
  httpRequests: readonly LandingHttpRequestRecordV1[],
): boolean {
  const fact = subject.observation?.facts.find((entry) => entry.fact === "head_ref");
  if (fact === undefined || fact.requestId === null) return false;
  const row = httpRequests.find(
    (entry) => entry.id === fact.requestId && entry.operationId === subject.id,
  );
  const projection = row?.result?.projection;
  return row?.status === "settled" && projection?.type === "ref" && projection.state === "absent";
}

/**
 * Whether the interrupted pull-request subject durably recorded the absence of
 * any matching pull request before its mutation: the observation's
 * pull-requests fact must reference the subject's own settled complete empty
 * list, so an exact pull request can never be adopted from pre-existing
 * provider state.
 */
function hasPullRequestAbsentIntent(
  subject: LandingOperationRecordV1,
  httpRequests: readonly LandingHttpRequestRecordV1[],
): boolean {
  const fact = subject.observation?.facts.find((entry) => entry.fact === "pull_requests");
  if (fact === undefined || fact.requestId === null) return false;
  const row = httpRequests.find(
    (entry) => entry.id === fact.requestId && entry.operationId === subject.id,
  );
  const projection = row?.result?.projection;
  return (
    row?.status === "settled" &&
    projection?.type === "pull_request_list" &&
    projection.complete &&
    projection.count === 0
  );
}

/**
 * The honest remote residue of a draft-PR subject, derived from the freshest
 * durable pull-request proofs. A settled list showing at least one matching
 * pull request proves `pull_request` residue regardless of completeness;
 * a complete empty list taken after the mutation proves none remains and the
 * residue falls back to the head branch. Without a post-mutation list, a
 * succeeded POST proves the pull request, an admitted or ambiguous POST
 * leaves visibility unresolved, and a failed POST fell back to the head
 * proof. Never a caller choice.
 */
function pullRequestResidueFromRows(
  rows: readonly LandingHttpRequestRecordV1[],
): "none" | "branch" | "pull_request" | "ambiguous" {
  const ordered = [...rows].sort((left, right) => left.requestOrdinal - right.requestOrdinal);
  const postIndex = ordered.findLastIndex((row) => row.kind === "github.pull_request.post");
  const post = postIndex === -1 ? undefined : ordered[postIndex];
  const listsAfter = ordered.filter(
    (row, index) =>
      index > postIndex &&
      row.kind === "github.pull_requests.get" &&
      row.status === "settled" &&
      row.outcome === "succeeded",
  );
  const freshList = listsAfter.at(-1)?.result?.projection;
  if (freshList !== undefined && freshList !== null && freshList.type === "pull_request_list") {
    if (freshList.count > 0) {
      return "pull_request";
    }
    if (freshList.complete) {
      // A complete empty list newer than any POST attempt proves no pull
      // request remains; the residue is whatever the head branch proves.
      return remoteRefResidueFromRows(ordered);
    }
  }
  if (post !== undefined && post.outcome === "succeeded") {
    return "pull_request";
  }
  if (post !== undefined && (post.status === "admitted" || post.outcome === "ambiguous")) {
    // The mutation was dispatched (or may have been) and no later list proves
    // the pull request either way: visibility is unresolved.
    return "ambiguous";
  }
  // No POST, or a definitively refused one: the residue is the head branch's.
  // A pull-request operation owns no `github.ref.post` row, so the remote-ref
  // residue derivation over these rows reduces to its head-read proof.
  return remoteRefResidueFromRows(ordered);
}

function decodeHttpRequestRow(
  entry: unknown,
  landing: LandingRecordV1,
): LandingHttpRequestRecordV1 {
  const value = expectRow(entry, "landing HTTP request");
  const requestEncoded = text(value.request_json, "landing_http_requests.request_json");
  const request = decodeCanonical(
    requestEncoded,
    "landing_http_requests.request_json",
    decodeLandingHttpRequestV1,
  );
  const requestSha256 = requireDigest(
    requestEncoded,
    value.request_sha256,
    "landing_http_requests.request_sha256",
  );
  if (!PACKET3_OPERATION_KINDS.has(request.operationKind)) {
    invalid("Landing HTTP request belongs to an operation outside the implemented slice");
  }
  const status = oneOf(
    value.status,
    ["admitted", "settled"] as const,
    "landing_http_requests.status",
  );
  const outcome =
    value.outcome === null
      ? null
      : oneOf(
          value.outcome,
          ["succeeded", "failed", "ambiguous"] as const,
          "landing_http_requests.outcome",
        );
  const httpStatus =
    value.http_status === null
      ? null
      : integer(value.http_status, "landing_http_requests.http_status", 100, 599);
  const result =
    value.result_json === null
      ? null
      : decodeCanonical(
          value.result_json,
          "landing_http_requests.result_json",
          decodeLandingHttpResultV1,
        );
  const resultSha256 =
    result === null
      ? value.result_sha256 === null
        ? null
        : invalid("Landing HTTP result digest exists without bytes")
      : requireDigest(
          text(value.result_json, "landing_http_requests.result_json"),
          value.result_sha256,
          "landing_http_requests.result_sha256",
        );
  const errorCode =
    value.error_code === null
      ? null
      : assertSafeCode(value.error_code, "landing_http_requests.error_code");
  const admittedAt = assertInstant(value.admitted_at, "landing_http_requests.admitted_at");
  const settledAt =
    value.settled_at === null
      ? null
      : assertInstant(value.settled_at, "landing_http_requests.settled_at");
  if (
    (status === "admitted" &&
      (outcome !== null ||
        httpStatus !== null ||
        result !== null ||
        resultSha256 !== null ||
        errorCode !== null ||
        settledAt !== null)) ||
    (status === "settled" &&
      (outcome === null || result === null || resultSha256 === null || settledAt === null))
  ) {
    invalid("Landing HTTP request settlement columns disagree");
  }
  if (
    (outcome === "succeeded" &&
      !(
        httpStatus !== null &&
        ((httpStatus >= 200 && httpStatus <= 299) ||
          (request.kind === "github.head_ref.get" && httpStatus === 404)) &&
        errorCode === null
      )) ||
    (outcome === "failed" && errorCode === null) ||
    (outcome === "ambiguous" && (httpStatus !== null || errorCode === null))
  ) {
    invalid("Landing HTTP request outcome columns disagree");
  }
  if (
    result !== null &&
    (result.requestId !== request.requestId ||
      result.kind !== request.kind ||
      result.outcome !== outcome ||
      result.httpStatus !== httpStatus ||
      result.errorCode !== errorCode)
  ) {
    invalid("Landing HTTP result does not match its request row");
  }
  const record: LandingHttpRequestRecordV1 = {
    id: assertUuid(value.id, "landing_http_requests.id"),
    landingId: assertUuid(value.landing_id, "landing_http_requests.landing_id"),
    operationId: assertUuid(value.operation_id, "landing_http_requests.operation_id"),
    coordinatorAttempt: integer(
      value.coordinator_attempt,
      "landing_http_requests.coordinator_attempt",
      1,
      8,
    ),
    operationKind: request.operationKind as
      | "candidate.prepare"
      | "local_ref.create"
      | "github.preflight"
      | "github.objects.upload"
      | "github.ref.create"
      | "github.pull_request.create"
      | "landing.reconcile",
    requestOrdinal: integer(value.request_ordinal, "landing_http_requests.request_ordinal", 1),
    kind: request.kind,
    method: oneOf(value.method, ["GET", "POST"] as const, "landing_http_requests.method"),
    requestSha256,
    request,
    status,
    outcome,
    httpStatus,
    resultSha256,
    result,
    errorCode,
    admittedAt,
    settledAt,
  };
  if (
    record.id !== request.requestId ||
    record.landingId !== request.landingId ||
    record.landingId !== landing.id ||
    record.operationId !== request.operationId ||
    record.coordinatorAttempt !== request.coordinatorAttempt ||
    record.operationKind !== request.operationKind ||
    record.requestOrdinal !== request.requestOrdinal ||
    record.kind !== request.kind ||
    record.method !== request.method
  ) {
    invalid("Landing HTTP request SQL columns and record disagree");
  }
  if (request.profileSha256 !== landing.profileSha256) {
    invalid("Landing HTTP request does not bind the landing profile");
  }
  return record;
}

/**
 * The current reconciliation subject, selected without caller input: the
 * newest atomically settled effect operation that named itself
 * `reconciliation_required`, followed by an unbroken chain of
 * subject-preserving reconciliation links. Remote effect kinds are subjects
 * exactly like the local ref; the caller-visible stage (resume state) pins
 * which subject kind is legal, enforced by every caller of this helper.
 */
function reconciliationSubject(status: LandingStatusV1): LandingOperationRecordV1 {
  const subjects = status.operations.filter(
    (operation) =>
      (operation.kind === "local_ref.create" ||
        operation.kind === "github.objects.upload" ||
        operation.kind === "github.ref.create" ||
        operation.kind === "github.pull_request.create") &&
      operation.status === "interrupted" &&
      operation.result?.outcome === "reconciliation_required" &&
      operation.result.value !== null &&
      "subjectOperationId" in operation.result.value &&
      operation.result.value.subjectOperationId === operation.id,
  );
  const subject = subjects.at(-1);
  if (subject === undefined || subject.resultSha256 === null) {
    invalid("Landing does not have a current unresolved reconciliation subject");
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
      invalid("Landing reconciliation chain changed its original subject");
    }
    if (
      (link.status === "interrupted" && link.result?.outcome !== "reconciliation_required") ||
      (link.status === "started" && index !== chain.length - 1) ||
      !(link.status === "interrupted" || link.status === "started")
    ) {
      invalid("Current landing reconciliation chain already terminated or is broken");
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
  status: LandingStatusV1,
): void {
  const { landing, operations, httpRequests } = status;
  const result = operation.result;
  if (result === null) return;
  if (operation.kind === "candidate.prepare") {
    if (result.outcome === "reconciliation_required") {
      invalid("Candidate preparation cannot create a reconciliation subject");
    }
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
  if (operation.kind === "github.preflight") {
    // Preflight is read-only and retry-safe: it can complete, fail, or be
    // interrupted, but it can never create a reconciliation subject (the
    // result decoder also refuses that shape; this is the aggregate-side
    // guard).
    if (result.outcome === "reconciliation_required") {
      invalid("Preflight cannot create a reconciliation subject");
    }
    if (result.outcome === "completed") {
      const input = preflightInput(operation.request);
      const value = result.value as PreflightExactValueV1;
      if (
        operation.observation === null ||
        value.actor !== landing.profile.expectedActor ||
        value.baseSha1 !== landing.baseCommitSha1 ||
        value.headState !==
          (operation.request.expectedState === "remote_ready" ? "exact" : "absent") ||
        value.pullRequestCount !== (input.includePullRequestAbsence ? 0 : null)
      ) {
        invalid("Completed preflight result does not prove the exact approved landing facts");
      }
    }
    return;
  }
  if (operation.kind === "github.objects.upload") {
    if (result.outcome === "interrupted") {
      invalid("Object-upload interruption must create a reconciliation subject");
    }
    if (result.outcome === "completed") {
      const input = operation.request.input as GitHubObjectsUploadInputV1;
      const value = result.value as ObjectsExactValueV1;
      if (
        operation.observation === null ||
        value.candidateObjectManifestSha256 !== input.candidateObjectManifestSha256 ||
        value.remoteObjectOutcome !== "created_or_exact"
      ) {
        invalid("Completed object-upload result does not bind its immutable manifest");
      }
    } else if (result.outcome === "reconciliation_required") {
      const value = result.value as ReconciliationRequiredValueV1;
      // Unreachable content-addressed objects are deliberately never residue.
      if (value.subjectOperationId !== operation.id || value.remoteResidue !== "none") {
        invalid("Object-upload reconciliation subject does not self-bind");
      }
    }
    return;
  }
  if (operation.kind === "github.ref.create") {
    if (result.outcome === "interrupted") {
      invalid("Remote-ref interruption must create a reconciliation subject");
    }
    if (result.outcome === "completed") {
      const value = result.value as RemoteRefReadyValueV1;
      const post = httpRequests.find(
        (row) => row.operationId === operation.id && row.kind === "github.ref.post",
      );
      if (
        operation.observation === null ||
        value.baseSha1 !== landing.baseCommitSha1 ||
        value.headSha1 !== landing.candidateCommitSha1 ||
        post === undefined ||
        post.status !== "settled" ||
        // `created` requires the one mutation row settled succeeded with the
        // exact projection; `reconciled` requires it settled ambiguous with
        // durable prior absence and intent. A failed mutation row can produce
        // neither.
        (value.remoteRefOutcome === "created"
          ? post.outcome !== "succeeded"
          : post.outcome !== "ambiguous")
      ) {
        invalid("Completed remote-ref result does not match its exact post evidence");
      }
    } else if (result.outcome === "reconciliation_required") {
      const value = result.value as ReconciliationRequiredValueV1;
      const rows = httpRequests.filter((row) => row.operationId === operation.id);
      if (
        value.subjectOperationId !== operation.id ||
        value.remoteResidue !== remoteRefResidueFromRows(rows)
      ) {
        invalid("Remote-ref reconciliation subject does not self-bind its residue");
      }
    }
    return;
  }
  if (operation.kind === "github.pull_request.create") {
    if (result.outcome === "interrupted") {
      invalid("Pull-request interruption must create a reconciliation subject");
    }
    if (result.outcome === "completed") {
      const value = result.value as DraftPrExactValueV1;
      const post = httpRequests.find(
        (row) => row.operationId === operation.id && row.kind === "github.pull_request.post",
      );
      if (
        operation.observation === null ||
        !pullRequestMatchesSubject(value, landing) ||
        post === undefined ||
        post.status !== "settled" ||
        // `created` requires the one mutation row settled succeeded with the
        // exact projection; `reconciled` requires it settled ambiguous with
        // durable prior absence and intent. A failed mutation row can produce
        // neither.
        (value.pullRequestOutcome === "created"
          ? post.outcome !== "succeeded"
          : post.outcome !== "ambiguous")
      ) {
        invalid("Completed pull-request result does not match its exact post evidence");
      }
    } else if (result.outcome === "reconciliation_required") {
      const value = result.value as ReconciliationRequiredValueV1;
      const rows = httpRequests.filter((row) => row.operationId === operation.id);
      if (
        value.subjectOperationId !== operation.id ||
        value.remoteResidue !== pullRequestResidueFromRows(rows)
      ) {
        invalid("Pull-request reconciliation subject does not self-bind its residue");
      }
    }
    return;
  }
  if (!(result.outcome === "completed" || result.outcome === "reconciliation_required")) {
    invalid("Landing reconciliation has an illegal settlement outcome");
  }
  const input = operation.request.input as LandingReconcileInputV1;
  const subject = operations.find((entry) => entry.id === input.subjectOperationId);
  if (subject === undefined) invalid("Landing reconciliation subject is missing");
  if (result.outcome === "reconciliation_required") {
    const value = result.value as ReconciliationRequiredValueV1;
    // Local-ref and object subjects never carry mutable remote residue; a ref
    // subject's residue derives from the freshest durable head proof and a
    // pull-request subject's from the freshest durable pull-request proofs.
    const expectedResidue =
      subject.kind === "github.ref.create"
        ? remoteRefResidueFromRows(httpRequests.filter((row) => row.operationId === operation.id))
        : subject.kind === "github.pull_request.create"
          ? pullRequestResidueFromRows(
              httpRequests.filter((row) => row.operationId === operation.id),
            )
          : "none";
    if (value.subjectOperationId !== subject.id || value.remoteResidue !== expectedResidue) {
      invalid("Unresolved reconciliation changed its subject or residue");
    }
    // The accepted DDL has no transaction/batch ID. A decisive observation can
    // legitimately belong to a crashed reconciliation that takeover interrupted,
    // and its event adjacency is indistinguishable from ordinary settle+resume.
    // Keep this load-time superset; the ordinary settlement API remains stricter.
    return;
  }
  const value = result.value as ReconcileValueV1;
  if (value.subjectOperationId !== subject.id) {
    invalid("Completed reconciliation changed its original subject");
  }
  if (subject.kind === "local_ref.create") {
    const freshFact = operation.observation?.facts[1];
    if (value.remoteResidue !== "none") {
      invalid("Completed local-ref reconciliation changed its residue");
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
    return;
  }
  if (subject.kind === "github.objects.upload") {
    const subjectInput = subject.request.input as GitHubObjectsUploadInputV1;
    if (value.remoteResidue !== "none") {
      invalid("Object reconciliation cannot claim mutable remote residue");
    }
    if (result.boundary === "subject_settled") {
      const stageValue = value.stageValue as ObjectsExactValueV1 | null;
      if (
        value.nextState !== "objects_ready" ||
        stageValue === null ||
        stageValue.candidateObjectManifestSha256 !== subjectInput.candidateObjectManifestSha256 ||
        stageValue.remoteObjectOutcome !== "created_or_exact" ||
        !objectUploadRowsProveCompletion(subject, httpRequests)
      ) {
        invalid("Object-upload subject settlement lacks the exact immutable-object proof");
      }
    } else if (
      result.boundary !== "retry_stage_proven" ||
      value.nextState !== "local_ready" ||
      value.stageValue !== null
    ) {
      invalid("Object-upload retry-stage reconciliation has an illegal closed mapping");
    }
    return;
  }
  // github.ref.create subjects: advance to remote_ready only on the exact
  // proven branch with an unchanged base; retry at objects_ready only when the
  // base is unchanged and the head is freshly absent.
  const reconcileRows = httpRequests.filter((row) => row.operationId === operation.id);
  const freshBase = reconcileRows.find(
    (row) => row.kind === "github.base_ref.get" && row.status === "settled",
  )?.result?.projection;
  const freshHead = reconcileRows.find(
    (row) => row.kind === "github.head_ref.get" && row.status === "settled",
  )?.result?.projection;
  if (subject.kind === "github.ref.create") {
    const subjectPost = httpRequests.find(
      (row) => row.operationId === subject.id && row.kind === "github.ref.post",
    );
    if (result.boundary === "subject_settled") {
      const stageValue = value.stageValue as RemoteRefReadyValueV1 | null;
      if (
        value.nextState !== "remote_ready" ||
        value.remoteResidue !== "branch" ||
        stageValue === null ||
        stageValue.baseSha1 !== landing.baseCommitSha1 ||
        stageValue.headSha1 !== landing.candidateCommitSha1 ||
        stageValue.remoteRefOutcome !== "reconciled" ||
        subjectPost === undefined ||
        subjectPost.status !== "settled" ||
        !(subjectPost.outcome === "succeeded" || subjectPost.outcome === "ambiguous") ||
        !hasRemoteRefAbsentIntent(subject, httpRequests) ||
        freshBase?.type !== "ref" ||
        freshBase.state !== "direct" ||
        freshBase.sha1 !== landing.baseCommitSha1 ||
        freshHead?.type !== "ref" ||
        freshHead.state !== "direct" ||
        freshHead.sha1 !== landing.candidateCommitSha1
      ) {
        invalid("Remote-ref subject settlement lacks exact reconciled stage proof");
      }
    } else if (
      result.boundary !== "retry_stage_proven" ||
      value.nextState !== "objects_ready" ||
      value.stageValue !== null ||
      value.remoteResidue !== "none" ||
      freshBase?.type !== "ref" ||
      freshBase.state !== "direct" ||
      freshBase.sha1 !== landing.baseCommitSha1 ||
      freshHead?.type !== "ref" ||
      freshHead.state !== "absent"
    ) {
      invalid("Remote-ref retry-stage reconciliation has an illegal closed mapping");
    }
    return;
  }
  // github.pull_request.create subjects: advance to landed only on the
  // unchanged base, the exact candidate head, and a fresh complete list
  // proving exactly one pull request equal to the stage evidence, with the
  // subject's admitted POST and durable prior absence; retry at remote_ready
  // only when the subject never admitted its POST and the fresh complete list
  // is empty.
  const freshList = reconcileRows.find(
    (row) => row.kind === "github.pull_requests.get" && row.status === "settled",
  )?.result?.projection;
  const subjectPost = httpRequests.find(
    (row) => row.operationId === subject.id && row.kind === "github.pull_request.post",
  );
  if (result.boundary === "subject_settled") {
    const stageValue = value.stageValue as DraftPrExactValueV1 | null;
    if (
      value.nextState !== "landed" ||
      value.remoteResidue !== "pull_request" ||
      stageValue === null ||
      stageValue.pullRequestOutcome !== "reconciled" ||
      !pullRequestMatchesSubject(stageValue, landing) ||
      subjectPost === undefined ||
      subjectPost.status !== "settled" ||
      !(subjectPost.outcome === "succeeded" || subjectPost.outcome === "ambiguous") ||
      !hasPullRequestAbsentIntent(subject, httpRequests) ||
      freshBase?.type !== "ref" ||
      freshBase.state !== "direct" ||
      freshBase.sha1 !== landing.baseCommitSha1 ||
      freshHead?.type !== "ref" ||
      freshHead.state !== "direct" ||
      freshHead.sha1 !== landing.candidateCommitSha1 ||
      freshList?.type !== "pull_request_list" ||
      !freshList.complete ||
      freshList.count !== 1 ||
      !freshList.objects.every((entry) => pullRequestProjectionsMatch(entry, stageValue))
    ) {
      invalid("Pull-request subject settlement lacks exact reconciled stage proof");
    }
  } else if (
    result.boundary !== "retry_stage_proven" ||
    value.nextState !== "remote_ready" ||
    value.stageValue !== null ||
    value.remoteResidue !== "branch" ||
    subjectPost !== undefined ||
    freshBase?.type !== "ref" ||
    freshBase.state !== "direct" ||
    freshBase.sha1 !== landing.baseCommitSha1 ||
    freshHead?.type !== "ref" ||
    freshHead.state !== "direct" ||
    freshHead.sha1 !== landing.candidateCommitSha1 ||
    freshList?.type !== "pull_request_list" ||
    !freshList.complete ||
    freshList.count !== 0
  ) {
    invalid("Pull-request retry-stage reconciliation has an illegal closed mapping");
  }
}

/**
 * The effect-operation preflight binding: the immediately preceding operation
 * in the same coordinator attempt must be a completed `github.preflight` whose
 * result digest, identity, expected state, and bound landing values match the
 * effect's input exactly. A stale, cross-attempt, mismatched, failed, or
 * incomplete preflight cannot start an effect operation.
 */
function hasExactPreflightBinding(
  operation: LandingOperationRecordV1,
  operations: readonly LandingOperationRecordV1[],
): boolean {
  const input = operation.request.input as
    | GitHubObjectsUploadInputV1
    | GitHubRefCreateInputV1
    | GitHubPullRequestCreateInputV1;
  const attemptOperations = operations.filter(
    (entry) => entry.coordinatorAttempt === operation.coordinatorAttempt,
  );
  const index = attemptOperations.findIndex((entry) => entry.id === operation.id);
  const preflight = index > 0 ? attemptOperations[index - 1] : undefined;
  if (
    preflight === undefined ||
    preflight.kind !== "github.preflight" ||
    preflight.status !== "completed" ||
    preflight.result?.outcome !== "completed" ||
    preflight.id !== input.preflightOperationId ||
    preflight.resultSha256 !== input.preflightResultSha256 ||
    preflight.request.expectedState !== operation.request.expectedState ||
    preflightInput(preflight.request).includePullRequestAbsence !==
      (operation.request.expectedState === "remote_ready")
  ) {
    return false;
  }
  // Every value both inputs carry must be byte-equal: the effect operation
  // provably continues the exact preflight's landing, base, head, and
  // candidate authority.
  const bound = preflightInput(preflight.request);
  if (bound.landingSha256 !== input.landingSha256) return false;
  if (operation.kind === "github.ref.create" || operation.kind === "github.pull_request.create") {
    const refInput = input as GitHubRefCreateInputV1 | GitHubPullRequestCreateInputV1;
    return (
      bound.baseRef === refInput.baseRef &&
      bound.expectedRemoteBaseSha1 === refInput.expectedRemoteBaseSha1 &&
      bound.headRef === refInput.headRef &&
      bound.candidateCommitSha1 === refInput.candidateCommitSha1
    );
  }
  return true;
}

function validateAggregate(
  status: LandingStatusV1,
  expectedHttp: ReadonlyMap<string, readonly HttpDescriptorV1[]>,
): void {
  const { landing, decision, attempts, operations, httpRequests, events } = status;
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

  // Durable HTTPS rows: per-attempt ordinals are contiguous under the
  // conservative request charge, each row's operation/attempt/kind ownership
  // is revalidated (the SQL composite foreign key enforces it at write), and
  // each operation's rows are an exact prefix of the one grammar its kind
  // owns. A settled operation may not leave an admitted-but-unsettled row.
  const httpRequestsByOperation = new Map<string, LandingHttpRequestRecordV1[]>();
  const httpOrdinalsByAttempt = new Map<number, number>();
  for (const request of httpRequests) {
    const operation = operations.find((candidate) => candidate.id === request.operationId);
    if (
      operation === undefined ||
      operation.coordinatorAttempt !== request.coordinatorAttempt ||
      operation.kind !== request.operationKind
    ) {
      invalid("Landing HTTP request does not belong to its named operation");
    }
    const nextOrdinal = (httpOrdinalsByAttempt.get(request.coordinatorAttempt) ?? 0) + 1;
    if (request.requestOrdinal !== nextOrdinal) {
      invalid("Landing HTTP request ordinals are not contiguous within their attempt");
    }
    httpOrdinalsByAttempt.set(request.coordinatorAttempt, nextOrdinal);
    const owned = httpRequestsByOperation.get(request.operationId) ?? [];
    owned.push(request);
    httpRequestsByOperation.set(request.operationId, owned);
  }
  for (const [ordinal, count] of httpOrdinalsByAttempt) {
    if (count > httpRequestCharge(landing.changedPaths.length)) {
      invalid("Landing HTTP requests exceed the per-attempt charge", {
        coordinatorAttempt: ordinal,
      });
    }
  }
  // The draft-PR mutation is admitted at most once per landing, ever: the
  // `one_create_pr_post_per_landing` unique index refuses a second row at
  // write, and this load check refuses any store that lost that discipline.
  if (httpRequests.filter((request) => request.kind === "github.pull_request.post").length > 1) {
    invalid("Landing admitted more than one draft pull-request POST");
  }
  for (const operation of operations) {
    const owned = httpRequestsByOperation.get(operation.id) ?? [];
    const descriptors = expectedHttp.get(operation.id) ?? [];
    if (
      owned.length > descriptors.length ||
      !owned.every((row, index) => {
        const descriptor = descriptors[index];
        return (
          descriptor !== undefined &&
          row.kind === descriptor.kind &&
          row.method === descriptor.method &&
          row.request.bodySha256 === descriptor.bodySha256 &&
          canonicalLandingJson(row.request.subject) === canonicalLandingJson(descriptor.subject)
        );
      })
    ) {
      invalid("Landing HTTP requests do not match the operation's derived request grammar");
    }
    const admitted = owned.filter((row) => row.status === "admitted");
    if (
      admitted.length > 1 ||
      (admitted.length === 1 && owned.at(-1)?.status !== "admitted") ||
      (admitted.length === 1 && operation.status !== "started") ||
      (operation.status !== "started" && admitted.length !== 0)
    ) {
      invalid("Landing HTTP request admissions are not sequential within their operation");
    }
    const facts = operation.observation?.facts ?? [];
    for (const fact of facts) {
      if (fact.requestId === null) continue;
      const row = owned.find((candidate) => candidate.id === fact.requestId);
      if (row === undefined || row.status !== "settled" || row.resultSha256 !== fact.resultSha256) {
        invalid("Landing observation fact does not reference a settled request it owns");
      }
    }
    if (operation.result !== null) {
      const represented = new Set(facts.map((fact) => fact.requestId).filter((id) => id !== null));
      const expectedEvidence = [
        ...facts.map((fact) => ({ requestId: fact.requestId, resultSha256: fact.resultSha256 })),
        ...owned
          .filter(
            (row): row is LandingHttpRequestRecordV1 & { readonly resultSha256: string } =>
              row.status === "settled" && !represented.has(row.id),
          )
          .map((row) => ({ requestId: row.id, resultSha256: row.resultSha256 })),
      ];
      if (
        operation.result.evidence.length !== expectedEvidence.length ||
        !operation.result.evidence.every(
          (entry, index) =>
            entry.requestId === expectedEvidence[index]?.requestId &&
            entry.resultSha256 === expectedEvidence[index]?.resultSha256,
        )
      ) {
        invalid("Landing operation result evidence does not match its observations and requests");
      }
    }
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
    if (operation.request.expectedVersion > landing.version) {
      invalid("Landing operation expects a future landing version");
    }
    if (!canStartLandingOperation(operation.kind, operation.request.expectedState)) {
      invalid("Landing operation request has an illegal expected state");
    }
    validatePacket3OperationSettlement(operation, status);
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
      const input = preflightInput(operation.request);
      if (
        input.landingSha256 !== landing.landingSha256 ||
        input.profileSha256 !== landing.profileSha256 ||
        input.baseRef !== `refs/heads/${landing.profile.baseBranch}` ||
        input.expectedRemoteBaseSha1 !== landing.baseCommitSha1 ||
        input.headRef !== landing.headRef ||
        input.candidateCommitSha1 !== landing.candidateCommitSha1 ||
        input.includePullRequestAbsence !== (operation.request.expectedState === "remote_ready")
      ) {
        invalid("Preflight operation does not bind the approved landing");
      }
    } else if (operation.kind === "github.objects.upload") {
      const input = operation.request.input as GitHubObjectsUploadInputV1;
      const candidate = operations.find(
        (entry) =>
          entry.kind === "candidate.prepare" &&
          entry.status === "completed" &&
          entry.result?.outcome === "completed",
      );
      const candidateValue = candidate?.result?.value as CandidateReadyValueV1 | undefined;
      if (
        input.landingSha256 !== landing.landingSha256 ||
        candidateValue === undefined ||
        input.candidateObjectManifestSha256 !== candidateValue.candidateObjectManifestSha256 ||
        input.changedPathsSha256 !== landing.changedPathsSha256 ||
        !hasExactPreflightBinding(operation, operations)
      ) {
        invalid("Object-upload operation does not bind the approved landing and preflight");
      }
      // The retry-subject pair is null exactly when no prior upload admitted a
      // mutating POST; otherwise it binds the most recent effectful subject
      // whose completed reconciliation authorized the byte-identical retry.
      const priorEffectful = operations.filter(
        (entry) =>
          entry.kind === "github.objects.upload" &&
          entry.kindAttempt < operation.kindAttempt &&
          httpRequests.some((row) => row.operationId === entry.id && row.method === "POST"),
      );
      const mostRecent = priorEffectful.at(-1);
      if (input.retrySubjectOperationId === null) {
        if (mostRecent !== undefined) {
          invalid("Object-upload retry dropped the most recent effectful subject");
        }
      } else {
        if (
          mostRecent === undefined ||
          input.retrySubjectOperationId !== mostRecent.id ||
          input.retrySubjectRequestSha256 !== mostRecent.requestSha256
        ) {
          invalid("Object-upload retry does not bind the most recent effectful subject");
        }
        const subjectInput = mostRecent.request.input as GitHubObjectsUploadInputV1;
        if (
          subjectInput.landingSha256 !== input.landingSha256 ||
          subjectInput.candidateObjectManifestSha256 !== input.candidateObjectManifestSha256 ||
          subjectInput.changedPathsSha256 !== input.changedPathsSha256
        ) {
          invalid("Object-upload retry subject drifted from the immutable landing");
        }
        const grant = operations.find(
          (entry) =>
            entry.kind === "landing.reconcile" &&
            entry.status === "completed" &&
            entry.result?.outcome === "completed" &&
            entry.result.boundary === "retry_stage_proven" &&
            (entry.request.input as LandingReconcileInputV1).subjectOperationId === mostRecent.id &&
            (entry.result.value as ReconcileValueV1).nextState === "local_ready",
        );
        if (grant === undefined) {
          invalid("Object-upload retry lacks the subject's completed reconciliation grant");
        }
      }
    } else if (operation.kind === "github.ref.create") {
      const input = operation.request.input as GitHubRefCreateInputV1;
      if (
        input.landingSha256 !== landing.landingSha256 ||
        input.baseRef !== `refs/heads/${landing.profile.baseBranch}` ||
        input.expectedRemoteBaseSha1 !== landing.baseCommitSha1 ||
        input.headRef !== landing.headRef ||
        input.candidateCommitSha1 !== landing.candidateCommitSha1 ||
        !hasExactPreflightBinding(operation, operations)
      ) {
        invalid("Remote-ref operation does not bind the approved landing and preflight");
      }
    } else if (operation.kind === "github.pull_request.create") {
      const input = operation.request.input as GitHubPullRequestCreateInputV1;
      if (
        input.landingSha256 !== landing.landingSha256 ||
        input.baseRef !== `refs/heads/${landing.profile.baseBranch}` ||
        input.expectedRemoteBaseSha1 !== landing.baseCommitSha1 ||
        input.headRef !== landing.headRef ||
        input.candidateCommitSha1 !== landing.candidateCommitSha1 ||
        input.pullRequestTitleSha256 !== landing.pullRequestTitleSha256 ||
        input.pullRequestBodySha256 !== landing.pullRequestBodySha256 ||
        !hasExactPreflightBinding(operation, operations)
      ) {
        invalid("Pull-request operation does not bind the approved landing and preflight");
      }
    } else {
      const input = operation.request.input as LandingReconcileInputV1;
      const subject = operations.find((candidate) => candidate.id === input.subjectOperationId);
      // The resume state pins the one legal subject kind: approved reconciles a
      // local ref, local_ready an object upload, objects_ready a remote ref,
      // remote_ready a draft pull request.
      const expectedSubjectKind =
        input.resumeState === "approved"
          ? "local_ref.create"
          : input.resumeState === "local_ready"
            ? "github.objects.upload"
            : input.resumeState === "objects_ready"
              ? "github.ref.create"
              : input.resumeState === "remote_ready"
                ? "github.pull_request.create"
                : null;
      if (
        input.landingSha256 !== landing.landingSha256 ||
        subject?.kind !== expectedSubjectKind ||
        subject.status !== "interrupted" ||
        subject.coordinatorAttempt >= operation.coordinatorAttempt ||
        subject.requestSha256 !== input.subjectRequestSha256 ||
        subject.resultSha256 !== input.subjectResultSha256
      ) {
        invalid("Landing reconciliation does not bind its settled original subject");
      }
      const resultValue = operation.result?.value;
      if (
        resultValue !== null &&
        resultValue !== undefined &&
        "subjectOperationId" in resultValue &&
        resultValue.subjectOperationId !== subject.id
      ) {
        invalid("Landing reconciliation result changed its original subject");
      }
      if (operation.observation !== null) {
        if (
          operation.observation.facts[0]?.fact !== "subject_operation" ||
          operation.observation.facts[0].resultSha256 !== subjectOperationProjectionSha256(subject)
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
  // Per attempt the contract permits at most one preflight followed by at most
  // one effect operation. Within the attempt every operation but the last must
  // be completed, and the attempt's settlement equals the last operation's —
  // except an interrupted attempt may legitimately end with all-completed
  // operations, the crash having landed in the window between two stages.
  const EFFECT_OPERATION_KINDS: ReadonlySet<LandingOperationKindV1> = new Set([
    "github.objects.upload",
    "github.ref.create",
    "github.pull_request.create",
  ]);
  for (const attempt of attempts) {
    const owned = operationsByAttempt.get(attempt.ordinal) ?? [];
    if (
      owned.length > 2 ||
      (owned.length === 2 &&
        (owned[0]?.kind !== "github.preflight" ||
          owned[0].status !== "completed" ||
          !EFFECT_OPERATION_KINDS.has(owned[1]?.kind ?? "candidate.prepare"))) ||
      ((attempt.status === "completed" || attempt.status === "failed") && owned.length === 0)
    ) {
      invalid("Landing attempt has an impossible operation cardinality");
    }
    for (const [index, operation] of owned.entries()) {
      const final = index === owned.length - 1;
      if (
        (!final && (operation.status !== "completed" || operation.errorCode !== null)) ||
        (final &&
          ((attempt.status === "completed" &&
            (operation.status !== "completed" || operation.errorCode !== null)) ||
            (attempt.status === "failed" &&
              (operation.status !== "failed" || operation.errorCode !== attempt.errorCode)) ||
            (attempt.status === "interrupted" &&
              !(
                operation.status === "completed" ||
                (operation.status === "interrupted" && operation.errorCode === attempt.errorCode)
              ))))
      ) {
        invalid("Landing operation and coordinator attempt settlements disagree");
      }
    }
  }
  const startedAttempt = attempts.find((attempt) => attempt.status === "started");
  const startedOperation = operations.find((operation) => operation.status === "started");
  if (startedOperation !== undefined) {
    const actionState = landingOperationActionState(startedOperation.kind);
    const activeStates =
      actionState === null ? landingOperationExpectedStates(startedOperation.kind) : [actionState];
    // `github.preflight` maps to no action state: it runs while the landing
    // remains in its stable retry-safe state
    // (`local_ready`/`objects_ready`/`remote_ready`).
    if (
      startedAttempt === undefined ||
      !(activeStates as readonly LandingStateV1[]).includes(landing.state)
    ) {
      invalid("Landing active attempt/operation does not match its current state");
    }
  }
  if (
    (startedAttempt !== undefined &&
      startedOperation === undefined &&
      !(
        landing.state === "preparing_candidate" ||
        landing.state === "approved" ||
        landing.state === "local_ready" ||
        landing.state === "objects_ready" ||
        landing.state === "remote_ready"
      )) ||
    (startedAttempt === undefined &&
      (landing.state === "creating_local_ref" ||
        landing.state === "uploading_objects" ||
        landing.state === "creating_remote_ref" ||
        landing.state === "opening_draft_pr"))
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
        landing.state === "uploading_objects" ||
        landing.state === "objects_ready" ||
        landing.state === "creating_remote_ref" ||
        landing.state === "remote_ready" ||
        landing.state === "opening_draft_pr" ||
        landing.state === "landed" ||
        landing.state === "reconciliation_required" ||
        (landing.state === "failed" &&
          (landing.resumeState === "approved" ||
            landing.resumeState === "local_ready" ||
            landing.resumeState === "objects_ready" ||
            landing.resumeState === "remote_ready"))
      ))
  ) {
    invalid("Landing decision and current state are inconsistent");
  }
  if (landing.state === "reconciliation_required") {
    reconciliationSubject(status);
  }
  if (landing.state === "local_ready") {
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
      // A retry-stage reconcile returning to local_ready proves the object
      // upload's retry stage, not the local-ref delivery stage; only a
      // subject-settled local-ref reconciliation is that stage's proof.
      if (
        operation.kind === "landing.reconcile" &&
        operation.result.boundary === "subject_settled"
      ) {
        const value = operation.result.value;
        return value !== null && "nextState" in value && value.nextState === "local_ready";
      }
      return false;
    });
    if (readyProofs.length !== 1) invalid("Local-ready landing lacks one exact stage proof");
  }
  if (landing.state === "objects_ready") {
    const readyProofs = operations.filter((operation) => {
      if (operation.status !== "completed" || operation.result?.outcome !== "completed") {
        return false;
      }
      if (operation.kind === "github.objects.upload") {
        const value = operation.result.value;
        return value !== null && "candidateObjectManifestSha256" in value;
      }
      if (
        operation.kind === "landing.reconcile" &&
        operation.result.boundary === "subject_settled"
      ) {
        const value = operation.result.value;
        return value !== null && "nextState" in value && value.nextState === "objects_ready";
      }
      return false;
    });
    if (readyProofs.length !== 1) invalid("Objects-ready landing lacks one exact stage proof");
  }
  if (landing.state === "remote_ready") {
    const readyProofs = operations.filter((operation) => {
      if (operation.status !== "completed" || operation.result?.outcome !== "completed") {
        return false;
      }
      if (operation.kind === "github.ref.create") {
        const value = operation.result.value;
        return (
          value !== null && "headSha1" in value && value.headSha1 === landing.candidateCommitSha1
        );
      }
      if (
        operation.kind === "landing.reconcile" &&
        operation.result.boundary === "subject_settled"
      ) {
        const value = operation.result.value;
        return value !== null && "nextState" in value && value.nextState === "remote_ready";
      }
      return false;
    });
    if (readyProofs.length !== 1) invalid("Remote-ready landing lacks one exact stage proof");
  }
  if (landing.state === "landed") {
    // The terminal state requires all four delivery stages' proofs, and the
    // immutable receipt's evidence-derived outcomes must equal them exactly.
    const stageOutcomes = landingDeliveryStageOutcomes(status);
    if (
      stageOutcomes === null ||
      status.receipt === null ||
      status.receipt.localRefOutcome !== stageOutcomes.localRefOutcome ||
      status.receipt.remoteObjectOutcome !== stageOutcomes.remoteObjectOutcome ||
      status.receipt.remoteRefOutcome !== stageOutcomes.remoteRefOutcome ||
      status.receipt.pullRequestOutcome !== stageOutcomes.pullRequestOutcome ||
      status.receipt.pullRequestNumber !== stageOutcomes.draftPr.number
    ) {
      invalid("Landed landing lacks its four delivery-stage proofs and matching receipt");
    }
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
  for (const request of httpRequests) {
    const admitted = (eventsByType.get("landing.github.request.admitted") ?? []).filter((event) =>
      eventMatches(event, {
        schemaVersion: 1,
        landingId: landing.id,
        operationId: request.operationId,
        requestId: request.id,
        coordinatorAttempt: request.coordinatorAttempt,
        operationKind: request.operationKind,
        requestOrdinal: request.requestOrdinal,
        kind: request.kind,
        requestSha256: request.requestSha256,
      }),
    );
    if (admitted.length !== 1) {
      invalid("Landing HTTP request has missing or duplicate admission events");
    }
    if (request.status === "settled") {
      const settled = (eventsByType.get("landing.github.request.settled") ?? []).filter((event) =>
        eventMatches(event, {
          schemaVersion: 1,
          landingId: landing.id,
          operationId: request.operationId,
          requestId: request.id,
          coordinatorAttempt: request.coordinatorAttempt,
          operationKind: request.operationKind,
          requestOrdinal: request.requestOrdinal,
          kind: request.kind,
          outcome: request.outcome,
          resultSha256: request.resultSha256,
          errorCode: request.errorCode,
        }),
      );
      const settledEvent = settled[0];
      const admittedEvent = admitted[0];
      if (
        admittedEvent === undefined ||
        settledEvent === undefined ||
        settled.length !== 1 ||
        settledEvent.sequence <= admittedEvent.sequence
      ) {
        invalid("Landing HTTP request settlement event is missing or reordered");
      }
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

  for (const [operationIndex, operation] of operations.entries()) {
    const attemptStarted = attemptStartEvents.get(operation.coordinatorAttempt);
    const operationStarted = operationStartEvents.get(operation.id);
    if (
      attemptStarted === undefined ||
      operationStarted === undefined ||
      operationStarted.sequence <= attemptStarted.sequence
    ) {
      invalid("Landing operation started before its coordinator attempt");
    }
    if (
      operation.kind === "landing.reconcile" &&
      operationStarted.sequence !== attemptStarted.sequence + 1
    ) {
      invalid("Landing reconciliation admission is not atomic in event order");
    }
    if (operation.status === "started") continue;
    const operationSettled = operationSettleEvents.get(operation.id);
    if (operationSettled === undefined) {
      invalid("Landing operation settlement event is missing");
    }
    const attemptSettled = attemptSettleEvents.get(operation.coordinatorAttempt);
    const attempt = attempts.find((entry) => entry.ordinal === operation.coordinatorAttempt);
    const nextOperation = operations[operationIndex + 1];
    const isLastInAttempt =
      nextOperation === undefined ||
      nextOperation.coordinatorAttempt !== operation.coordinatorAttempt;
    if (!isLastInAttempt) {
      // A mid-attempt operation settlement closes only its own transaction; the
      // next operation starts immediately after (preflight, then one effect).
      if (
        nextOperation === undefined ||
        operationStartEvents.get(nextOperation.id)?.sequence !== operationSettled.sequence + 1
      ) {
        invalid("Landing mid-attempt operation settlement is not followed by the next start");
      }
      continue;
    }
    // The attempt's settlement follows the last settled operation: the one
    // ambiguous request settlement an interrupted-effect takeover writes
    // precedes the operation settlement, so the two stay adjacent.
    if (attempt === undefined || attempt.status === "started") continue;
    if (attemptSettled === undefined || attemptSettled.sequence !== operationSettled.sequence + 1) {
      invalid("Landing operation and attempt settlements are not in exact source order");
    }
  }

  let replayedState: LandingStateV1 = "preparing_candidate";
  let replayedResumeState: LandingResumeStateV1 | null = null;
  let replayedVersion = 0;
  let replayedErrorCode: string | null = null;
  let nextAttemptOrdinal = 1;
  let activeAttemptOrdinal: number | null = null;
  const replayedKindAttempts = new Map<LandingOperationKindV1, number>();
  const replayedStartedOperations = new Set<string>();
  const replayedSettledOperations = new Set<string>();
  const outstandingRequestOperations = new Map<string, string>();
  const lastAdmittedOrdinalByOperation = new Map<string, number>();
  for (const [index, event] of events.entries()) {
    if (event.type === "landing.attempt.started") {
      const ordinal = (event.payload as { readonly coordinatorAttempt: number }).coordinatorAttempt;
      const initialAttempt = ordinal === 1;
      // The stable delivery states this slice admits attempts from. The
      // mutation-stage states `uploading_objects`/`creating_remote_ref`/
      // `opening_draft_pr` are action states (never admission states).
      const allowedAdmissionState =
        replayedState === "preparing_candidate" ||
        replayedState === "approved" ||
        replayedState === "local_ready" ||
        replayedState === "objects_ready" ||
        replayedState === "remote_ready" ||
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
      const ordinal = (event.payload as { readonly coordinatorAttempt: number }).coordinatorAttempt;
      if (activeAttemptOrdinal !== ordinal) {
        invalid("Landing attempt settlement does not close the active attempt");
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
      replayedKindAttempts.set(payload.kind, expectedKindAttempt);
      replayedStartedOperations.add(payload.operationId);
      continue;
    }
    if (event.type === "landing.operation.settled") {
      const operationId = (event.payload as { readonly operationId: string }).operationId;
      const operation = operations.find((entry) => entry.id === operationId);
      if (operation === undefined || operation.coordinatorAttempt !== activeAttemptOrdinal) {
        invalid("Landing operation settlement does not belong to the active attempt");
      }
      if ([...outstandingRequestOperations.values()].includes(operationId)) {
        invalid("Landing operation settled with an admitted request still unsettled");
      }
      replayedSettledOperations.add(operationId);
      continue;
    }
    if (event.type === "landing.github.request.admitted") {
      const requestPayload = event.payload as {
        readonly operationId: string;
        readonly requestId: string;
        readonly coordinatorAttempt: number;
        readonly requestOrdinal: number;
      };
      const request = httpRequests.find((entry) => entry.id === requestPayload.requestId);
      const operation = operations.find((entry) => entry.id === requestPayload.operationId);
      if (
        request === undefined ||
        operation === undefined ||
        request.operationId !== operation.id ||
        requestPayload.coordinatorAttempt !== activeAttemptOrdinal ||
        operation.coordinatorAttempt !== activeAttemptOrdinal ||
        !replayedStartedOperations.has(operation.id) ||
        replayedSettledOperations.has(operation.id) ||
        [...outstandingRequestOperations.values()].includes(operation.id) ||
        requestPayload.requestOrdinal <= (lastAdmittedOrdinalByOperation.get(operation.id) ?? 0)
      ) {
        invalid("Landing HTTP request admission does not follow its operation's sequence");
      }
      outstandingRequestOperations.set(request.id, operation.id);
      lastAdmittedOrdinalByOperation.set(operation.id, requestPayload.requestOrdinal);
      continue;
    }
    if (event.type === "landing.github.request.settled") {
      const requestPayload = event.payload as {
        readonly operationId: string;
        readonly requestId: string;
        readonly coordinatorAttempt: number;
      };
      const request = httpRequests.find((entry) => entry.id === requestPayload.requestId);
      if (
        request === undefined ||
        request.operationId !== requestPayload.operationId ||
        requestPayload.coordinatorAttempt !== activeAttemptOrdinal ||
        outstandingRequestOperations.get(request.id) !== request.operationId
      ) {
        invalid("Landing HTTP request settlement does not close its own admission");
      }
      outstandingRequestOperations.delete(request.id);
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
      transition === "local_ready->failed" ||
      transition === "objects_ready->failed" ||
      transition === "remote_ready->failed"
    ) {
      // A deterministic refusal at a stable state keeps it as the retry-safe
      // resume marker: the read-only preflight's failure, or the stage
      // effect's definitive pre-mutation refusal (before its one POST exists).
      const effectKind =
        from === "local_ready"
          ? "github.objects.upload"
          : from === "objects_ready"
            ? "github.ref.create"
            : "github.pull_request.create";
      if (
        !(owner?.kind === "github.preflight" || owner?.kind === effectKind) ||
        owner.result?.outcome !== "failed" ||
        !isSettlementOwned
      ) {
        invalid("Stable-state failure transition has the wrong operation owner");
      }
      replayedResumeState =
        from === "local_ready"
          ? "local_ready"
          : from === "objects_ready"
            ? "objects_ready"
            : "remote_ready";
    } else if (transition === "local_ready->uploading_objects") {
      if (
        owner?.kind !== "github.objects.upload" ||
        operationStartEvents.get(owner.id)?.sequence !== event.sequence - 1
      ) {
        invalid("Object-upload action transition has the wrong started operation");
      }
    } else if (
      transition === "uploading_objects->objects_ready" ||
      transition === "uploading_objects->failed" ||
      transition === "uploading_objects->reconciliation_required"
    ) {
      const expectedOutcome =
        to === "objects_ready"
          ? "completed"
          : to === "failed"
            ? "failed"
            : "reconciliation_required";
      if (
        owner?.kind !== "github.objects.upload" ||
        owner.result?.outcome !== expectedOutcome ||
        !isSettlementOwned
      ) {
        invalid("Object-upload settlement transition has the wrong operation owner");
      }
      replayedResumeState = to === "objects_ready" ? null : "local_ready";
    } else if (transition === "objects_ready->creating_remote_ref") {
      if (
        owner?.kind !== "github.ref.create" ||
        operationStartEvents.get(owner.id)?.sequence !== event.sequence - 1
      ) {
        invalid("Remote-ref action transition has the wrong started operation");
      }
    } else if (
      transition === "creating_remote_ref->remote_ready" ||
      transition === "creating_remote_ref->failed" ||
      transition === "creating_remote_ref->reconciliation_required"
    ) {
      const expectedOutcome =
        to === "remote_ready"
          ? "completed"
          : to === "failed"
            ? "failed"
            : "reconciliation_required";
      if (
        owner?.kind !== "github.ref.create" ||
        owner.result?.outcome !== expectedOutcome ||
        !isSettlementOwned
      ) {
        invalid("Remote-ref settlement transition has the wrong operation owner");
      }
      replayedResumeState = to === "remote_ready" ? null : "objects_ready";
    } else if (transition === "remote_ready->opening_draft_pr") {
      if (
        owner?.kind !== "github.pull_request.create" ||
        operationStartEvents.get(owner.id)?.sequence !== event.sequence - 1
      ) {
        invalid("Pull-request action transition has the wrong started operation");
      }
    } else if (
      transition === "opening_draft_pr->landed" ||
      transition === "opening_draft_pr->failed" ||
      transition === "opening_draft_pr->reconciliation_required"
    ) {
      const expectedOutcome =
        to === "landed" ? "completed" : to === "failed" ? "failed" : "reconciliation_required";
      if (
        owner?.kind !== "github.pull_request.create" ||
        owner.result?.outcome !== expectedOutcome ||
        !isSettlementOwned
      ) {
        invalid("Pull-request settlement transition has the wrong operation owner");
      }
      replayedResumeState = to === "landed" ? null : "remote_ready";
    } else if (
      transition === "reconciliation_required->approved" ||
      transition === "reconciliation_required->local_ready" ||
      transition === "reconciliation_required->objects_ready" ||
      transition === "reconciliation_required->remote_ready" ||
      transition === "reconciliation_required->landed"
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
    } else if (
      transition === "failed->preparing_candidate" ||
      transition === "failed->approved" ||
      transition === "failed->local_ready" ||
      transition === "failed->objects_ready" ||
      transition === "failed->remote_ready"
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
      invalid("Landing event stream contains a non-Packet-3 transition");
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
  const expectedEventCount =
    attempts.length +
    attempts.filter((attempt) => attempt.status !== "started").length +
    operations.length +
    operations.filter((operation) => operation.status !== "started").length +
    httpRequests.length +
    httpRequests.filter((request) => request.status === "settled").length +
    (decision === null ? 0 : 1) +
    landing.version;
  if (events.length !== expectedEventCount) {
    invalid("Landing event stream contains an omitted or extra source event");
  }
}

/**
 * Whether one pull-request projection binds the landing's exact approved
 * subject. `state`, `draft`, `markerCount`, and `maintainerCanModify` are
 * decoder literals, so they carry no comparison here.
 */
function pullRequestMatchesSubject(
  projection: PullRequestProjectionV1,
  landing: LandingRecordV1,
): boolean {
  return (
    projection.owner === landing.profile.owner &&
    projection.repository === landing.profile.repository &&
    projection.headOwner === landing.profile.owner &&
    projection.headRef === landing.headRef.slice("refs/heads/".length) &&
    projection.headSha1 === landing.candidateCommitSha1 &&
    projection.baseRef === landing.profile.baseBranch &&
    projection.baseSha1 === landing.baseCommitSha1 &&
    projection.titleSha256 === landing.pullRequestTitleSha256 &&
    projection.bodySha256 === landing.pullRequestBodySha256
  );
}

/** Field-exact equality of two pull-request projections. */
function pullRequestProjectionsMatch(
  left: PullRequestProjectionV1,
  right: PullRequestProjectionV1,
): boolean {
  return (
    left.number === right.number &&
    left.owner === right.owner &&
    left.repository === right.repository &&
    left.headOwner === right.headOwner &&
    left.headRef === right.headRef &&
    left.headSha1 === right.headSha1 &&
    left.baseRef === right.baseRef &&
    left.baseSha1 === right.baseSha1 &&
    left.titleSha256 === right.titleSha256 &&
    left.bodySha256 === right.bodySha256
  );
}

/**
 * The terminal evidence-derived outcome of each delivery stage, or null when
 * any stage lacks its proof. Each stage's value comes from its own completed
 * operation, superseded by a later subject-settled reconciliation of that
 * stage; uploaded objects are content-addressed, so their only honest outcome
 * is `created_or_exact`. Never caller-chosen.
 */
function landingDeliveryStageOutcomes(status: LandingStatusV1): {
  readonly localRefOutcome: "created" | "reconciled";
  readonly remoteObjectOutcome: "created_or_exact";
  readonly remoteRefOutcome: "created" | "reconciled";
  readonly pullRequestOutcome: "created" | "reconciled";
  readonly draftPr: DraftPrExactValueV1;
} | null {
  let localRefOutcome: "created" | "reconciled" | null = null;
  let objectsProven = false;
  let remoteRefOutcome: "created" | "reconciled" | null = null;
  let draftPr: DraftPrExactValueV1 | null = null;
  for (const operation of status.operations) {
    if (operation.status !== "completed" || operation.result?.outcome !== "completed") continue;
    const value = operation.result.value;
    if (value === null) continue;
    if (operation.kind === "local_ref.create" && "localRefOutcome" in value) {
      localRefOutcome = value.localRefOutcome;
    } else if (operation.kind === "github.objects.upload" && "remoteObjectOutcome" in value) {
      objectsProven = true;
    } else if (operation.kind === "github.ref.create" && "remoteRefOutcome" in value) {
      remoteRefOutcome = value.remoteRefOutcome;
    } else if (operation.kind === "github.pull_request.create" && "pullRequestOutcome" in value) {
      draftPr = value;
    } else if (
      operation.kind === "landing.reconcile" &&
      operation.result.boundary === "subject_settled" &&
      "nextState" in value
    ) {
      if (value.nextState === "local_ready") {
        localRefOutcome = "reconciled";
      } else if (value.nextState === "objects_ready") {
        objectsProven = true;
      } else if (value.nextState === "remote_ready") {
        remoteRefOutcome = "reconciled";
      } else if (value.nextState === "landed") {
        const stageValue = value.stageValue;
        draftPr =
          stageValue !== null && "pullRequestOutcome" in stageValue ? stageValue : null;
      }
    }
  }
  if (
    localRefOutcome === null ||
    !objectsProven ||
    remoteRefOutcome === null ||
    draftPr === null
  ) {
    return null;
  }
  return {
    localRefOutcome,
    remoteObjectOutcome: "created_or_exact",
    remoteRefOutcome,
    pullRequestOutcome: draftPr.pullRequestOutcome,
    draftPr,
  };
}

function reconstructLandingDigest(status: LandingStatusV1): {
  readonly record: LandingDigestV1;
  readonly sha256: string;
  readonly candidate: CandidateReadyValueV1;
  readonly pullRequestBody: string;
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
  return { record, sha256: authoritySha256, candidate, pullRequestBody: body };
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

  /**
   * Re-derives the candidate object manifest from the landing's immutable
   * columns and the evidence checkpoint bytes, and requires it to digest to
   * the completed candidate operation's recorded manifest digest. Returns null
   * only before candidate settlement; a digest drift fails closed.
   */
  #uploadEvidence(
    status: LandingStatusV1,
    required = false,
  ): {
    readonly manifest: CandidateObjectManifestV1;
    readonly checkpointFiles: readonly CheckpointFile[];
  } | null {
    const landing = status.landing;
    const hasUpload = status.operations.some(
      (operation) => operation.kind === "github.objects.upload",
    );
    // Reading the run evidence requires a still-completed run; loads of
    // pre-delivery landings after a rollback has begun must stay readable, so
    // the manifest is derived only when an upload exists (or the caller
    // requires it for an admission or settlement).
    if (!hasUpload && !required) {
      return null;
    }
    if (
      landing.candidateTreeSha1 === null ||
      landing.candidateCommitSha1 === null ||
      landing.candidateCommitPayloadSha256 === null
    ) {
      if (required) {
        invalid("Object upload requires the completed candidate authority");
      }
      return null;
    }
    const candidate = status.operations.find(
      (operation) =>
        operation.kind === "candidate.prepare" &&
        operation.status === "completed" &&
        operation.result?.outcome === "completed",
    );
    const candidateValue = candidate?.result?.value as CandidateReadyValueV1 | undefined;
    if (candidateValue === undefined) {
      invalid("Landing candidate settlement lacks its completed operation");
    }
    const evidence = this.#evidenceSource(landing.runId);
    const manifest = deriveCandidateObjectManifestV1({
      baseCommitSha1: landing.baseCommitSha1,
      baseTreeSha1: landing.baseTreeSha1,
      candidateTreeSha1: landing.candidateTreeSha1,
      candidateCommitSha1: landing.candidateCommitSha1,
      candidateCommitPayloadSha256: landing.candidateCommitPayloadSha256,
      changedPaths: landing.changedPaths,
      checkpointFiles: evidence.checkpointFiles,
    });
    if (digestLandingRecord(manifest) !== candidateValue.candidateObjectManifestSha256) {
      invalid("Candidate object manifest no longer matches its durable digest");
    }
    return { manifest, checkpointFiles: evidence.checkpointFiles };
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
    const attempts = (
      this.#database
        .prepare("SELECT * FROM landing_attempts WHERE landing_id = ? ORDER BY ordinal")
        .all(canonicalLandingId) as unknown[]
    ).map((entry) => decodeAttemptRow(entry, canonicalLandingId));
    const operations = (
      this.#database
        .prepare(
          "SELECT rowid AS source_rowid, * FROM landing_operations " +
            "WHERE landing_id = ? ORDER BY coordinator_attempt, source_rowid",
        )
        .all(canonicalLandingId) as unknown[]
    ).map((entry) => decodeOperationRow(entry, landing));
    const httpRequests = (
      this.#database
        .prepare(
          "SELECT * FROM landing_http_requests " +
            "WHERE landing_id = ? ORDER BY coordinator_attempt, request_ordinal",
        )
        .all(canonicalLandingId) as unknown[]
    ).map((entry) => decodeHttpRequestRow(entry, landing));
    const eventRows = this.#database
      .prepare("SELECT * FROM landing_events WHERE landing_id = ? ORDER BY sequence")
      .all(canonicalLandingId) as unknown[];
    const events = eventRows.map((entry, index) =>
      decodeEventRow(entry, canonicalLandingId, index + 1),
    );
    // The immutable receipt is present exactly when the landing is landed; it
    // decodes canonically from bytes that digest to the stored value and binds
    // every immutable landing authority field.
    const receiptEntry = this.#database
      .prepare("SELECT receipt_json, receipt_sha256 FROM landing_receipts WHERE landing_id = ?")
      .get(canonicalLandingId);
    let receipt: LandingReceiptV1 | null = null;
    if (receiptEntry !== undefined) {
      const receiptRow = expectRow(receiptEntry, "landing receipt");
      const receiptJson = text(receiptRow.receipt_json, "landing_receipts.receipt_json");
      const receiptSha256 = assertSha256(
        receiptRow.receipt_sha256,
        "landing_receipts.receipt_sha256",
      );
      if (sha256(receiptJson) !== receiptSha256) {
        invalid("Landing receipt digest does not match its stored bytes");
      }
      receipt = decodeCanonicalLandingReceiptJsonV1(receiptJson);
      if (
        receipt.landingId !== landing.id ||
        receipt.runId !== landing.runId ||
        receipt.projectId !== landing.projectId ||
        receipt.owner !== landing.profile.owner ||
        receipt.repository !== landing.profile.repository ||
        receipt.baseRef !== `refs/heads/${landing.profile.baseBranch}` ||
        receipt.baseCommitSha1 !== landing.baseCommitSha1 ||
        receipt.headRef !== landing.headRef ||
        receipt.candidateTreeSha1 !== landing.candidateTreeSha1 ||
        receipt.candidateCommitSha1 !== landing.candidateCommitSha1 ||
        receipt.landingSha256 !== landing.landingSha256 ||
        receipt.profileSha256 !== landing.profileSha256 ||
        receipt.planSha256 !== landing.planSha256 ||
        receipt.diffSha256 !== landing.diffSha256 ||
        receipt.checkpointSha256 !== landing.checkpointSha256 ||
        receipt.verificationSha256 !== landing.verificationSha256 ||
        receipt.reviewDecisionSha256 !== landing.reviewDecisionSha256 ||
        receipt.changedPathsSha256 !== landing.changedPathsSha256
      ) {
        invalid("Landing receipt does not bind its landing's immutable authority");
      }
    }
    if ((receipt === null) !== (landing.state !== "landed")) {
      invalid("Landing receipt and landed state disagree");
    }
    const status: LandingStatusV1 = {
      landing,
      decision,
      attempts,
      operations,
      httpRequests,
      events,
      receipt,
      revision: events.at(-1)?.sequence ?? 0,
    };
    // The landing authority (and with it the exact pull-request body) is
    // re-derived before any HTTP descriptor so a stored POST row revalidates
    // against recomputed bytes rather than trusted ones.
    const reconstructed = reconstructLandingDigest(status);
    // The candidate object manifest is re-derived from durable evidence
    // whenever an object upload exists, so stored HTTP rows are revalidated
    // against the exact immutable byte authority rather than trusted.
    const uploadEvidence = this.#uploadEvidence(status);
    const expectedHttp = new Map<string, readonly HttpDescriptorV1[]>();
    for (const operation of operations) {
      if (operation.kind === "candidate.prepare" || operation.kind === "local_ref.create") continue;
      const descriptors = httpDescriptorsFor(
        operation,
        landing,
        uploadEvidence?.manifest ?? null,
        uploadEvidence?.checkpointFiles ?? [],
        operations,
        reconstructed?.pullRequestBody ?? null,
      );
      if (descriptors.length > 0) expectedHttp.set(operation.id, descriptors);
    }
    validateAggregate(status, expectedHttp);
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
      const body = reconstructed === null ? null : reconstructed.pullRequestBody;
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
    kind:
      | "candidate.prepare"
      | "local_ref.create"
      | "github.preflight"
      | "github.objects.upload"
      | "github.ref.create"
      | "github.pull_request.create"
      | "landing.reconcile",
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
      result.evidence.length < observationFacts.length ||
      !observationFacts.every(
        (fact, index) =>
          result.evidence[index]?.requestId === fact.requestId &&
          result.evidence[index]?.resultSha256 === fact.resultSha256,
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
        facts = [
          {
            fact: "subject_operation",
            requestId: null,
            resultSha256: subjectOperationProjectionSha256(subject),
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

  /**
   * Writes the one complete pre-effect (or reconciliation) observation for an
   * HTTP-owning operation, derived from its durable settled reads and — for a
   * reconciliation — the settled subject projection. Partial observations are
   * never stored: every required provider read must be settled succeeded first.
   */
  recordGithubOperationObservation(landingId: string, operationIdInput: string): LandingStatusV1 {
    const operationId = assertUuid(operationIdInput, "operationId");
    const transaction = this.#database.transaction(() => {
      const status = this.#mutableStatus(landingId);
      const operation = status.operations.find((entry) => entry.id === operationId);
      if (
        operation === undefined ||
        operation.status !== "started" ||
        !(
          operation.kind === "github.objects.upload" ||
          operation.kind === "github.ref.create" ||
          operation.kind === "github.pull_request.create" ||
          operation.kind === "landing.reconcile"
        )
      ) {
        throw new IcarusError(
          "LANDING_NOT_ADMITTED",
          "Observation has no active HTTP-owning operation",
        );
      }
      const rows = status.httpRequests
        .filter((entry) => entry.operationId === operation.id)
        .sort((left, right) => left.requestOrdinal - right.requestOrdinal);
      const providerFact = (
        fact: "actor" | "base_ref" | "head_ref" | "pull_requests",
        position: number,
      ): LandingOperationObservationV1["facts"][number] => {
        const row = rows[position];
        if (
          row === undefined ||
          row.status !== "settled" ||
          row.outcome !== "succeeded" ||
          row.kind !==
            (fact === "pull_requests" ? "github.pull_requests.get" : `github.${fact}.get`) ||
          row.resultSha256 === null
        ) {
          invalid("Observation lacks its settled exact provider fact");
        }
        return { fact, requestId: row.id, resultSha256: row.resultSha256 };
      };
      let facts: LandingOperationObservationV1["facts"];
      if (operation.kind === "github.objects.upload") {
        facts = [providerFact("actor", 0)];
      } else if (operation.kind === "github.ref.create") {
        facts = [
          providerFact("actor", 0),
          providerFact("base_ref", 1),
          providerFact("head_ref", 2),
        ];
      } else if (operation.kind === "github.pull_request.create") {
        facts = [
          providerFact("actor", 0),
          providerFact("base_ref", 1),
          providerFact("head_ref", 2),
          providerFact("pull_requests", 3),
        ];
      } else {
        const input = operation.request.input as LandingReconcileInputV1;
        const subject = status.operations.find((entry) => entry.id === input.subjectOperationId);
        if (subject === undefined) {
          invalid("Reconciliation subject is missing");
        }
        const subjectFact = {
          fact: "subject_operation" as const,
          requestId: null,
          resultSha256: subjectOperationProjectionSha256(subject),
        };
        const subjectKind = reconciliationSubjectKind(operation, status.operations);
        facts =
          subjectKind === "github.ref.create"
            ? [
                subjectFact,
                providerFact("actor", 0),
                providerFact("base_ref", 1),
                providerFact("head_ref", 2),
              ]
            : subjectKind === "github.pull_request.create"
              ? [
                  subjectFact,
                  providerFact("actor", 0),
                  providerFact("base_ref", 1),
                  providerFact("head_ref", 2),
                  providerFact("pull_requests", 3),
                ]
              : [subjectFact];
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

  /**
   * Admits the read-only GitHub preflight intent at `local_ready`. Preflight
   * maps to no action state: the operation start commits without a landing
   * transition, exactly like candidate preparation commits without one.
   */
  startGithubPreflight(landingId: string): LandingOperationAdmissionV1 {
    let operationId = "";
    const transaction = this.#database.transaction(() => {
      const status = this.#mutableStatus(landingId);
      if (
        !(
          status.landing.state === "local_ready" ||
          status.landing.state === "objects_ready" ||
          status.landing.state === "remote_ready"
        ) ||
        status.decision?.decision !== "approve"
      ) {
        throw new IcarusError(
          "INVALID_LANDING_STATE",
          "Landing is not at a stable state admitting GitHub preflight",
        );
      }
      if (
        status.landing.landingSha256 === null ||
        status.landing.candidateCommitSha1 === null ||
        reconstructLandingDigest(status)?.sha256 !== status.landing.landingSha256
      ) {
        invalid("Approved landing authority is incomplete");
      }
      operationId = this.#startOperation(status, "github.preflight", {
        landingSha256: status.landing.landingSha256,
        profileSha256: status.landing.profileSha256,
        baseRef: `refs/heads/${status.landing.profile.baseBranch}`,
        expectedRemoteBaseSha1: status.landing.baseCommitSha1,
        headRef: status.landing.headRef,
        candidateCommitSha1: status.landing.candidateCommitSha1,
        // Pull-request absence is part of the draft-PR preflight: the
        // `remote_ready` preflight proves the complete empty list (and the
        // exact candidate head) before the one POST is admitted.
        includePullRequestAbsence: status.landing.state === "remote_ready",
      });
    });
    runImmediate(transaction);
    return { status: this.getStatus(landingId), operationId };
  }

  /**
   * Admits the object-upload intent at `local_ready` and enters the action
   * state atomically. The input binds the candidate manifest, the immediately
   * preceding completed preflight in this attempt, and — when a prior upload
   * admitted a mutating POST — the retry subject and its reconciliation grant.
   */
  startGithubObjectsUpload(landingId: string): LandingOperationAdmissionV1 {
    let operationId = "";
    const transaction = this.#database.transaction(() => {
      const status = this.#mutableStatus(landingId);
      if (status.landing.state !== "local_ready" || status.decision?.decision !== "approve") {
        throw new IcarusError(
          "INVALID_LANDING_STATE",
          "Landing is not local-ready for object upload",
        );
      }
      const reconstructed = reconstructLandingDigest(status);
      if (reconstructed === null || status.landing.landingSha256 === null) {
        invalid("Approved landing authority is incomplete");
      }
      const uploadEvidence = this.#uploadEvidence(status, true);
      if (uploadEvidence === null) {
        invalid("Object upload requires the derived candidate object manifest");
      }
      const preflight = this.#immediatelyPrecedingCompletedPreflight(status);
      const retry = this.#objectUploadRetrySubject(status);
      operationId = this.#startOperation(status, "github.objects.upload", {
        landingSha256: status.landing.landingSha256,
        candidateObjectManifestSha256: reconstructed.candidate.candidateObjectManifestSha256,
        changedPathsSha256: status.landing.changedPathsSha256,
        preflightOperationId: preflight.id,
        preflightResultSha256: preflight.resultSha256 ?? invalid("Preflight result is unsettled"),
        retrySubjectOperationId: retry?.id ?? null,
        retrySubjectRequestSha256: retry?.requestSha256 ?? null,
      });
      this.#transition(status.landing, "uploading_objects", null, null, operationId);
    });
    runImmediate(transaction);
    return { status: this.getStatus(landingId), operationId };
  }

  /**
   * Admits the absent-only remote-ref intent at `objects_ready` and enters the
   * action state atomically, mirroring the local compare-and-swap discipline:
   * the operation binds the immediately preceding completed preflight of this
   * attempt before any mutation is admitted.
   */
  startGithubRemoteRef(landingId: string): LandingOperationAdmissionV1 {
    let operationId = "";
    const transaction = this.#database.transaction(() => {
      const status = this.#mutableStatus(landingId);
      if (status.landing.state !== "objects_ready" || status.decision?.decision !== "approve") {
        throw new IcarusError(
          "INVALID_LANDING_STATE",
          "Landing is not objects-ready for remote-ref creation",
        );
      }
      if (
        status.landing.landingSha256 === null ||
        status.landing.candidateCommitSha1 === null ||
        reconstructLandingDigest(status)?.sha256 !== status.landing.landingSha256
      ) {
        invalid("Approved landing authority is incomplete");
      }
      const preflight = this.#immediatelyPrecedingCompletedPreflight(status);
      operationId = this.#startOperation(status, "github.ref.create", {
        landingSha256: status.landing.landingSha256,
        baseRef: `refs/heads/${status.landing.profile.baseBranch}`,
        expectedRemoteBaseSha1: status.landing.baseCommitSha1,
        headRef: status.landing.headRef,
        candidateCommitSha1: status.landing.candidateCommitSha1,
        preflightOperationId: preflight.id,
        preflightResultSha256: preflight.resultSha256 ?? invalid("Preflight result is unsettled"),
      });
      this.#transition(status.landing, "creating_remote_ref", null, null, operationId);
    });
    runImmediate(transaction);
    return { status: this.getStatus(landingId), operationId };
  }

  /**
   * Admits the one draft pull-request intent at `remote_ready` and enters the
   * action state atomically. The operation binds the immediately preceding
   * completed pull-request-absence preflight of this attempt; a landing that
   * already admitted its one POST — whatever that admission's outcome — can
   * never start another pull-request operation.
   */
  startGithubPullRequest(landingId: string): LandingOperationAdmissionV1 {
    let operationId = "";
    const transaction = this.#database.transaction(() => {
      const status = this.#mutableStatus(landingId);
      if (status.landing.state !== "remote_ready" || status.decision?.decision !== "approve") {
        throw new IcarusError(
          "INVALID_LANDING_STATE",
          "Landing is not remote-ready for draft pull-request creation",
        );
      }
      if (
        status.landing.landingSha256 === null ||
        status.landing.candidateCommitSha1 === null ||
        status.landing.pullRequestBodySha256 === null ||
        reconstructLandingDigest(status)?.sha256 !== status.landing.landingSha256
      ) {
        invalid("Approved landing authority is incomplete");
      }
      // At most one POST admission ever: the unique index refuses a second
      // row at write, and this admission check refuses a second operation
      // before any network I/O. A prior POST admission — even a definitively
      // refused one — spends the landing's one draft-PR mutation.
      if (status.httpRequests.some((row) => row.kind === "github.pull_request.post")) {
        invalid("Landing already admitted its one draft pull-request POST");
      }
      const preflight = this.#immediatelyPrecedingCompletedPreflight(status);
      if (!preflightInput(preflight.request).includePullRequestAbsence) {
        invalid("Draft pull-request creation lacks the pull-request-absence preflight");
      }
      operationId = this.#startOperation(status, "github.pull_request.create", {
        landingSha256: status.landing.landingSha256,
        baseRef: `refs/heads/${status.landing.profile.baseBranch}`,
        expectedRemoteBaseSha1: status.landing.baseCommitSha1,
        headRef: status.landing.headRef,
        candidateCommitSha1: status.landing.candidateCommitSha1,
        pullRequestTitleSha256: status.landing.pullRequestTitleSha256,
        pullRequestBodySha256: status.landing.pullRequestBodySha256,
        draft: true,
        maintainerCanModify: false,
        preflightOperationId: preflight.id,
        preflightResultSha256: preflight.resultSha256 ?? invalid("Preflight result is unsettled"),
      });
      this.#transition(status.landing, "opening_draft_pr", null, null, operationId);
    });
    runImmediate(transaction);
    return { status: this.getStatus(landingId), operationId };
  }

  /**
   * The one completed preflight immediately preceding the effect operation in
   * the current started attempt, with no intervening operation. Everything the
   * binding must prove is revalidated here and again at load.
   */
  #immediatelyPrecedingCompletedPreflight(status: LandingStatusV1): LandingOperationRecordV1 {
    const attempt = this.#startedAttempt(status);
    const attemptOperations = status.operations.filter(
      (operation) => operation.coordinatorAttempt === attempt.ordinal,
    );
    const preflight = attemptOperations.at(-1);
    if (
      preflight === undefined ||
      preflight.kind !== "github.preflight" ||
      preflight.status !== "completed" ||
      preflight.result?.outcome !== "completed"
    ) {
      invalid("Landing effect operation lacks its immediately preceding completed preflight");
    }
    return preflight;
  }

  /**
   * The retry subject for a new object upload: the most recent prior upload
   * that admitted a mutating POST, which must carry a completed reconciliation
   * authorizing the byte-identical retry at `local_ready`. A missing
   * reconciliation refuses before actor resolution or any POST.
   */
  #objectUploadRetrySubject(status: LandingStatusV1): LandingOperationRecordV1 | null {
    const attempt = this.#startedAttempt(status);
    const priorEffectful = status.operations.filter(
      (operation) =>
        operation.kind === "github.objects.upload" &&
        operation.coordinatorAttempt !== attempt.ordinal &&
        status.httpRequests.some(
          (row) => row.operationId === operation.id && row.method === "POST",
        ),
    );
    const subject = priorEffectful.at(-1);
    if (subject === undefined) return null;
    const grant = status.operations.find(
      (operation) =>
        operation.kind === "landing.reconcile" &&
        operation.status === "completed" &&
        operation.result?.outcome === "completed" &&
        operation.result.boundary === "retry_stage_proven" &&
        (operation.request.input as LandingReconcileInputV1).subjectOperationId === subject.id &&
        (operation.result.value as ReconcileValueV1).nextState === "local_ready",
    );
    if (grant === undefined) {
      invalid("Object-upload retry lacks the subject's completed reconciliation grant");
    }
    return subject;
  }

  /**
   * Admits exactly one HTTPS request: the conservative per-attempt charge, the
   * operation-owned grammar, and the `landing.github.request.admitted` event
   * commit in one transaction before any network I/O. The caller names only
   * the HTTP kind it intends; the subject is derived from immutable landing
   * records so no caller input can drift the request's authority.
   */
  admitGithubRequest(
    landingId: string,
    operationIdInput: string,
    kindInput: LandingHttpKindV1,
  ): LandingHttpRequestAdmissionV1 {
    const operationId = assertUuid(operationIdInput, "operationId");
    if (!isLandingHttpKindV1(kindInput)) {
      invalid("Landing HTTP request kind is unsupported");
    }
    const kind = kindInput;
    let requestId = "";
    const transaction = this.#database.transaction(() => {
      const status = this.#mutableStatus(landingId);
      const operation = status.operations.find((entry) => entry.id === operationId);
      if (operation === undefined || operation.status !== "started") {
        throw new IcarusError(
          "LANDING_NOT_ADMITTED",
          "Landing HTTP admission has no active operation",
        );
      }
      const operationRows = status.httpRequests
        .filter((entry) => entry.operationId === operation.id)
        .sort((left, right) => left.requestOrdinal - right.requestOrdinal);
      if (operationRows.some((entry) => entry.status !== "settled")) {
        throw new IcarusError(
          "LANDING_REQUEST_IN_PROGRESS",
          "Landing HTTP admission has an unsettled prior request",
        );
      }
      const uploadEvidence = this.#uploadEvidence(status);
      // The pull-request POST descriptor rebuilds its exact body from the
      // landing authority; every other grammar ignores it.
      const reconstructed =
        operation.kind === "github.pull_request.create"
          ? (reconstructLandingDigest(status) ??
            invalid("Pull-request admission lacks the landing authority"))
          : null;
      const descriptors = httpDescriptorsFor(
        operation,
        status.landing,
        uploadEvidence?.manifest ?? null,
        uploadEvidence?.checkpointFiles ?? [],
        status.operations,
        reconstructed?.pullRequestBody ?? null,
      );
      const descriptor = descriptors[operationRows.length];
      if (descriptor === undefined || kind !== descriptor.kind) {
        invalid("Landing HTTP request does not match the operation's request grammar");
      }
      const attemptRows = status.httpRequests.filter(
        (entry) => entry.coordinatorAttempt === operation.coordinatorAttempt,
      );
      const requestOrdinal = attemptRows.length + 1;
      if (requestOrdinal > httpRequestCharge(status.landing.changedPaths.length)) {
        throw new IcarusError(
          "LANDING_REQUEST_LIMIT",
          "Landing coordinator HTTP request charge is exhausted",
        );
      }
      requestId = this.#identifier();
      const request = decodeLandingHttpRequestV1({
        schemaVersion: 1,
        requestId,
        landingId: status.landing.id,
        operationId: operation.id,
        coordinatorAttempt: operation.coordinatorAttempt,
        operationKind: operation.kind,
        requestOrdinal,
        kind,
        method: descriptor.method,
        profileSha256: status.landing.profileSha256,
        bodySha256: descriptor.bodySha256,
        subject: descriptor.subject,
      });
      const requestJson = canonicalLandingJson(request);
      const requestSha256 = sha256(requestJson);
      this.#database
        .prepare(
          "INSERT INTO landing_http_requests " +
            "(id, landing_id, operation_id, coordinator_attempt, operation_kind, " +
            "request_ordinal, kind, method, request_sha256, request_json, status, outcome, " +
            "http_status, result_sha256, result_json, error_code, admitted_at, settled_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'admitted', NULL, NULL, NULL, NULL, NULL, ?, NULL)",
        )
        .run(
          requestId,
          status.landing.id,
          operation.id,
          operation.coordinatorAttempt,
          operation.kind,
          requestOrdinal,
          kind,
          request.method,
          requestSha256,
          requestJson,
          this.#timestamp(),
        );
      this.#appendEvent(status.landing.id, "landing.github.request.admitted", {
        schemaVersion: 1,
        landingId: status.landing.id,
        operationId: operation.id,
        requestId,
        coordinatorAttempt: operation.coordinatorAttempt,
        operationKind: operation.kind,
        requestOrdinal,
        kind,
        requestSha256,
      });
    });
    runImmediate(transaction);
    return { status: this.getStatus(landingId), requestId };
  }

  /**
   * Settles one admitted request with its canonical result and settled event.
   * Used by the coordinator after an exchange completes and by takeover for
   * the admitted-but-unsettled row an interruption leaves behind.
   */
  #settleHttpRequestRow(
    request: LandingHttpRequestRecordV1,
    input: LandingHttpSettlementInputV1,
  ): LandingHttpResultV1 {
    const result = decodeLandingHttpResultV1({
      schemaVersion: 1,
      requestId: request.id,
      kind: request.kind,
      outcome: input.outcome,
      httpStatus: input.httpStatus,
      projection: input.projection,
      errorCode: input.errorCode,
    });
    // The projection must restate the admitted subject, so a caller cannot
    // record an observation about a different actor, reference, or object than
    // the one the durable request binds.
    if (
      result.outcome === "succeeded" &&
      (result.projection === null ||
        !httpProjectionRestatesSubject(request.request, result.projection))
    ) {
      invalid("Landing HTTP result does not restate its admitted subject");
    }
    const resultJson = canonicalLandingJson(result);
    const resultSha256 = sha256(resultJson);
    const update = this.#database
      .prepare(
        "UPDATE landing_http_requests SET status = 'settled', outcome = ?, http_status = ?, " +
          "result_sha256 = ?, result_json = ?, error_code = ?, settled_at = ? " +
          "WHERE id = ? AND landing_id = ? AND status = 'admitted'",
      )
      .run(
        result.outcome,
        result.httpStatus,
        resultSha256,
        resultJson,
        result.errorCode,
        this.#timestamp(),
        request.id,
        request.landingId,
      );
    if (update.changes !== 1) {
      throw new IcarusError("LANDING_CONFLICT", "Landing HTTP request admission changed");
    }
    this.#appendEvent(request.landingId, "landing.github.request.settled", {
      schemaVersion: 1,
      landingId: request.landingId,
      operationId: request.operationId,
      requestId: request.id,
      coordinatorAttempt: request.coordinatorAttempt,
      operationKind: request.operationKind,
      requestOrdinal: request.requestOrdinal,
      kind: request.kind,
      outcome: result.outcome,
      resultSha256,
      errorCode: result.errorCode,
    });
    return result;
  }

  settleGithubRequest(
    landingId: string,
    requestIdInput: string,
    input: LandingHttpSettlementInputV1,
  ): LandingStatusV1 {
    const requestId = assertUuid(requestIdInput, "requestId");
    const transaction = this.#database.transaction(() => {
      const status = this.#mutableStatus(landingId);
      const request = status.httpRequests.find((entry) => entry.id === requestId);
      if (request === undefined) {
        throw new IcarusError("NOT_FOUND", "Landing HTTP request was not found");
      }
      const operation = status.operations.find((entry) => entry.id === request.operationId);
      if (
        operation === undefined ||
        operation.status !== "started" ||
        request.status !== "admitted"
      ) {
        throw new IcarusError(
          "LANDING_NOT_ADMITTED",
          "Landing HTTP request has no active admission",
        );
      }
      this.#settleHttpRequestRow(request, input);
    });
    runImmediate(transaction);
    return this.getStatus(landingId);
  }

  /**
   * Settles the read-only preflight. A completed settlement derives its exact
   * value from the durable settled reads, writes the one complete observation,
   * and — when the coordinator chains the attempt's effect operation next —
   * leaves the attempt open for it. A failed settlement enters `failed` with
   * the current stable state as the retry-safe resume marker; an interrupted
   * settlement leaves the landing in that state for explicit resume.
   */
  settleGithubPreflight(
    landingId: string,
    input: GithubPreflightSettlementInputV1,
  ): LandingStatusV1 {
    if (
      !(
        input.outcome === "completed" ||
        input.outcome === "failed" ||
        input.outcome === "interrupted"
      )
    ) {
      invalid("Preflight settlement outcome is unsupported");
    }
    if (input.outcome === "completed" && input.errorCode !== null) {
      invalid("Completed preflight settlement cannot have an error");
    }
    const transaction = this.#database.transaction(() => {
      const status = this.#mutableStatus(landingId);
      if (
        status.landing.state !== "local_ready" &&
        status.landing.state !== "objects_ready" &&
        status.landing.state !== "remote_ready"
      ) {
        throw new IcarusError(
          "INVALID_LANDING_STATE",
          "Landing is not at a stable state settling preflight",
        );
      }
      const operation = this.#startedOperation(status, "github.preflight");
      const attempt = this.#startedAttempt(status);
      if (operation.coordinatorAttempt !== attempt.ordinal) {
        invalid("Preflight operation and coordinator attempt disagree");
      }
      const rows = status.httpRequests
        .filter((entry) => entry.operationId === operation.id)
        .sort((left, right) => left.requestOrdinal - right.requestOrdinal);
      if (rows.some((entry) => entry.status !== "settled")) {
        invalid("Preflight settlement has an unsettled admitted request");
      }
      if (input.outcome !== "completed") {
        const errorCode = assertSafeCode(input.errorCode, "preflight errorCode");
        const evidence = rows.map((row) => ({
          requestId: row.id,
          resultSha256:
            row.resultSha256 ?? invalid("Settled landing HTTP request lacks its result digest"),
        }));
        this.#settleOperation(operation, {
          schemaVersion: 1,
          operationId: operation.id,
          kind: operation.kind,
          outcome: input.outcome,
          boundary: input.outcome === "failed" ? "operation_failed" : "operation_interrupted",
          evidence,
          value: null,
          errorCode,
        });
        this.#settleAttempt(attempt, input.outcome, errorCode);
        if (input.outcome === "failed") {
          this.#transition(status.landing, "failed", status.landing.state, errorCode, operation.id);
        }
        return;
      }
      const grammar = httpGrammarFor(operation, status.operations, null);
      if (
        rows.length !== grammar.length ||
        rows.some((row) => row.outcome !== "succeeded" || row.result === null)
      ) {
        invalid("Completed preflight lacks its exact settled read grammar");
      }
      const projections = rows.map((row) => row.result?.projection ?? null);
      const actor = projections[0]?.type === "actor" ? projections[0].login : null;
      const base = projections[1]?.type === "ref" ? projections[1] : null;
      const head = projections[2]?.type === "ref" ? projections[2] : null;
      const pullRequests = projections[3]?.type === "pull_request_list" ? projections[3] : null;
      // The required head state is `absent` before the object/remote-ref
      // stages and `exact` (the candidate commit) before draft-PR creation.
      const requiredHeadState =
        operation.request.expectedState === "remote_ready" ? "exact" : "absent";
      const headExact =
        head?.state === "direct" && head.sha1 === status.landing.candidateCommitSha1;
      if (
        actor !== status.landing.profile.expectedActor ||
        base?.state !== "direct" ||
        base.sha1 !== status.landing.baseCommitSha1 ||
        (requiredHeadState === "absent" ? head?.state !== "absent" : !headExact)
      ) {
        invalid("Completed preflight does not prove the approved actor, base, and head state");
      }
      const includePullRequestAbsence = preflightInput(operation.request).includePullRequestAbsence;
      if (
        includePullRequestAbsence &&
        !(pullRequests?.complete === true && pullRequests.count === 0)
      ) {
        invalid("Completed preflight lacks the complete empty pull-request list");
      }
      const value: PreflightExactValueV1 = {
        actor,
        baseSha1: base.sha1,
        headState: requiredHeadState,
        pullRequestCount: includePullRequestAbsence ? 0 : null,
      };
      const facts = rows.map((row) => ({
        fact: FACT_NAME_BY_HTTP_GET_KIND[row.kind as keyof typeof FACT_NAME_BY_HTTP_GET_KIND],
        requestId: row.id,
        resultSha256:
          row.resultSha256 ?? invalid("Settled landing HTTP request lacks its result digest"),
      }));
      const observation = decodeLandingOperationObservationV1({
        schemaVersion: 1,
        operationId: operation.id,
        kind: operation.kind,
        phase: "pre_effect",
        facts,
      });
      const observationJson = canonicalLandingJson(observation);
      const observationSha256 = sha256(observationJson);
      const observationUpdate = this.#database
        .prepare(
          "UPDATE landing_operations SET observation_sha256 = ?, observation_json = ? " +
            "WHERE id = ? AND landing_id = ? AND status = 'started' " +
            "AND observation_sha256 IS NULL AND observation_json IS NULL",
        )
        .run(observationSha256, observationJson, operation.id, operation.landingId);
      if (observationUpdate.changes !== 1) {
        throw new IcarusError("LANDING_CONFLICT", "Landing observation changed concurrently");
      }
      const observed: LandingOperationRecordV1 = { ...operation, observation, observationSha256 };
      this.#settleOperation(observed, {
        schemaVersion: 1,
        operationId: operation.id,
        kind: operation.kind,
        outcome: "completed",
        boundary: "preflight_exact",
        evidence: facts.map(({ requestId, resultSha256 }) => ({ requestId, resultSha256 })),
        value,
        errorCode: null,
      });
      if (input.closeAttempt) {
        this.#settleAttempt(attempt, "completed", null);
      }
    });
    runImmediate(transaction);
    return this.getStatus(landingId);
  }

  /**
   * Settles the object upload. A completed settlement requires the full blob/
   * tree/commit grammar settled succeeded with every returned object name
   * equal to its locally computed identity (enforced when each row settled).
   * A failed settlement is legal only before the first mutating POST. Anything
   * else — a failed or ambiguous POST row — enters `reconciliation_required`;
   * unreachable content-addressed objects are never remote residue.
   */
  settleGithubObjectsUpload(
    landingId: string,
    input: GithubEffectSettlementInputV1,
  ): LandingStatusV1 {
    if (
      !(
        input.outcome === "completed" ||
        input.outcome === "failed" ||
        input.outcome === "reconciliation_required"
      )
    ) {
      invalid("Object-upload settlement outcome is unsupported");
    }
    if (input.outcome === "completed" && input.errorCode !== null) {
      invalid("Completed object-upload settlement cannot have an error");
    }
    const transaction = this.#database.transaction(() => {
      const status = this.#mutableStatus(landingId);
      if (status.landing.state !== "uploading_objects") {
        throw new IcarusError("INVALID_LANDING_STATE", "Landing is not uploading objects");
      }
      const operation = this.#startedOperation(status, "github.objects.upload");
      const attempt = this.#startedAttempt(status);
      if (operation.coordinatorAttempt !== attempt.ordinal) {
        invalid("Object-upload operation and coordinator attempt disagree");
      }
      const rows = status.httpRequests
        .filter((entry) => entry.operationId === operation.id)
        .sort((left, right) => left.requestOrdinal - right.requestOrdinal);
      if (rows.some((entry) => entry.status !== "settled")) {
        invalid("Object-upload settlement has an unsettled admitted request");
      }
      const evidence = this.#operationEvidence(operation, rows);
      if (input.outcome === "reconciliation_required") {
        const errorCode = assertSafeCode(input.errorCode, "object-upload errorCode");
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
          "local_ready",
          errorCode,
          operation.id,
        );
        return;
      }
      if (input.outcome === "failed") {
        const errorCode = assertSafeCode(input.errorCode, "object-upload errorCode");
        if (rows.some((row) => row.method === "POST")) {
          invalid("Object-upload failure after a mutating POST must reconcile, not fail");
        }
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
        this.#transition(status.landing, "failed", "local_ready", errorCode, operation.id);
        return;
      }
      const uploadEvidence = this.#uploadEvidence(status, true);
      if (uploadEvidence === null) {
        invalid("Object-upload settlement lacks the derived candidate manifest");
      }
      const grammar = httpGrammarFor(operation, status.operations, uploadEvidence.manifest);
      if (
        rows.length !== grammar.length ||
        rows.some((row) => row.outcome !== "succeeded" || row.result === null) ||
        operation.observation === null
      ) {
        invalid("Completed object upload lacks its exact settled grammar and observation");
      }
      const manifestSha256 = digestLandingRecord(uploadEvidence.manifest);
      const inputManifest = (operation.request.input as GitHubObjectsUploadInputV1)
        .candidateObjectManifestSha256;
      if (manifestSha256 !== inputManifest) {
        invalid("Object-upload input manifest does not match the derived evidence");
      }
      this.#settleOperation(operation, {
        schemaVersion: 1,
        operationId: operation.id,
        kind: operation.kind,
        outcome: "completed",
        boundary: "objects_exact",
        evidence,
        value: {
          candidateObjectManifestSha256: inputManifest,
          remoteObjectOutcome: "created_or_exact",
        },
        errorCode: null,
      });
      this.#settleAttempt(attempt, "completed", null);
      this.#transition(status.landing, "objects_ready", null, null, operation.id);
    });
    runImmediate(transaction);
    return this.getStatus(landingId);
  }

  /**
   * Settles the absent-only remote-ref creation, mirroring the local CAS
   * discipline: `created` only when the one POST settled succeeded and the
   * post-read suffix proved the exact head on the unchanged base; `reconciled`
   * only when the POST settled ambiguous and the suffix proves the branch; a
   * failed POST row can produce neither. A definitive no-effect suffix (absent
   * head, unchanged base) fails back to `objects_ready` for an explicit retry;
   * everything uncertain or drifted enters `reconciliation_required` with the
   * honestly derived residue.
   */
  settleGithubRemoteRef(landingId: string, input: GithubEffectSettlementInputV1): LandingStatusV1 {
    if (
      !(
        input.outcome === "completed" ||
        input.outcome === "failed" ||
        input.outcome === "reconciliation_required"
      )
    ) {
      invalid("Remote-ref settlement outcome is unsupported");
    }
    if (input.outcome === "completed" && input.errorCode !== null) {
      invalid("Completed remote-ref settlement cannot have an error");
    }
    const transaction = this.#database.transaction(() => {
      const status = this.#mutableStatus(landingId);
      if (status.landing.state !== "creating_remote_ref") {
        throw new IcarusError("INVALID_LANDING_STATE", "Landing is not creating its remote ref");
      }
      const operation = this.#startedOperation(status, "github.ref.create");
      const attempt = this.#startedAttempt(status);
      if (operation.coordinatorAttempt !== attempt.ordinal) {
        invalid("Remote-ref operation and coordinator attempt disagree");
      }
      const rows = status.httpRequests
        .filter((entry) => entry.operationId === operation.id)
        .sort((left, right) => left.requestOrdinal - right.requestOrdinal);
      if (rows.some((entry) => entry.status !== "settled")) {
        invalid("Remote-ref settlement has an unsettled admitted request");
      }
      const evidence = this.#operationEvidence(operation, rows);
      if (input.outcome === "reconciliation_required") {
        const errorCode = assertSafeCode(input.errorCode, "remote-ref errorCode");
        this.#settleOperation(operation, {
          schemaVersion: 1,
          operationId: operation.id,
          kind: operation.kind,
          outcome: "reconciliation_required",
          boundary: "reconciliation_required",
          evidence,
          value: {
            subjectOperationId: operation.id,
            remoteResidue: remoteRefResidueFromRows(rows),
          },
          errorCode,
        });
        this.#settleAttempt(attempt, "interrupted", errorCode);
        this.#transition(
          status.landing,
          "reconciliation_required",
          "objects_ready",
          errorCode,
          operation.id,
        );
        return;
      }
      const post = rows.find((entry) => entry.kind === "github.ref.post");
      const suffixHead = rows.filter((entry) => entry.kind === "github.head_ref.get").at(-1);
      const suffixBase = rows.filter((entry) => entry.kind === "github.base_ref.get").at(-1);
      const headProjection =
        suffixHead?.result?.projection?.type === "ref" ? suffixHead.result.projection : null;
      const baseProjection =
        suffixBase?.result?.projection?.type === "ref" ? suffixBase.result.projection : null;
      const suffixProvesAbsentUnchanged =
        headProjection?.state === "absent" &&
        baseProjection?.state === "direct" &&
        baseProjection.sha1 === status.landing.baseCommitSha1;
      const suffixProvesExactUnchanged =
        headProjection?.state === "direct" &&
        headProjection.sha1 === status.landing.candidateCommitSha1 &&
        baseProjection?.state === "direct" &&
        baseProjection.sha1 === status.landing.baseCommitSha1;
      if (input.outcome === "failed") {
        const errorCode = assertSafeCode(input.errorCode, "remote-ref errorCode");
        if (!(post === undefined || (post.status === "settled" && suffixProvesAbsentUnchanged))) {
          invalid("Remote-ref failure without a definitive no-effect proof must reconcile");
        }
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
        this.#transition(status.landing, "failed", "objects_ready", errorCode, operation.id);
        return;
      }
      if (
        post === undefined ||
        post.status !== "settled" ||
        post.outcome === "failed" ||
        !(post.outcome === "succeeded" || post.outcome === "ambiguous") ||
        !suffixProvesExactUnchanged ||
        headProjection?.sha1 === undefined ||
        baseProjection?.sha1 === undefined ||
        operation.observation === null
      ) {
        invalid("Completed remote-ref settlement lacks its exact created or reconciled proof");
      }
      this.#settleOperation(operation, {
        schemaVersion: 1,
        operationId: operation.id,
        kind: operation.kind,
        outcome: "completed",
        boundary: "remote_ref_ready",
        evidence,
        value: {
          baseSha1: baseProjection.sha1,
          headSha1: headProjection.sha1 ?? invalid("Remote-ref value lacks its proven head"),
          remoteRefOutcome: post.outcome === "succeeded" ? "created" : "reconciled",
        },
        errorCode: null,
      });
      this.#settleAttempt(attempt, "completed", null);
      this.#transition(status.landing, "remote_ready", null, null, operation.id);
    });
    runImmediate(transaction);
    return this.getStatus(landingId);
  }

  /**
   * Inserts the one immutable receipt, deriving every stage outcome from the
   * durable operation chain (the just-settled terminal operation included via
   * its post-settle view) and never from caller input. The primary key makes
   * the write exactly-once; the loader revalidates digest and binding.
   */
  #insertLandingReceipt(
    status: LandingStatusV1,
    settledOperation: LandingOperationRecordV1,
  ): void {
    const landing = status.landing;
    const outcomes = landingDeliveryStageOutcomes({
      ...status,
      operations: status.operations.map((entry) =>
        entry.id === settledOperation.id ? settledOperation : entry,
      ),
    });
    if (
      outcomes === null ||
      landing.landingSha256 === null ||
      landing.candidateTreeSha1 === null ||
      landing.candidateCommitSha1 === null
    ) {
      invalid("Landing receipt lacks a proven delivery stage");
    }
    const receipt = decodeLandingReceiptV1({
      version: 1,
      landingId: landing.id,
      runId: landing.runId,
      projectId: landing.projectId,
      provider: "github",
      owner: landing.profile.owner,
      repository: landing.profile.repository,
      baseRef: `refs/heads/${landing.profile.baseBranch}`,
      baseCommitSha1: landing.baseCommitSha1,
      headRef: landing.headRef,
      candidateTreeSha1: landing.candidateTreeSha1,
      candidateCommitSha1: landing.candidateCommitSha1,
      pullRequestNumber: outcomes.draftPr.number,
      reconstructedPullRequestUrl: reconstructPullRequestUrlV1(
        landing.profile,
        outcomes.draftPr.number,
      ),
      draft: true,
      landingSha256: landing.landingSha256,
      profileSha256: landing.profileSha256,
      planSha256: landing.planSha256,
      diffSha256: landing.diffSha256,
      checkpointSha256: landing.checkpointSha256,
      verificationSha256: landing.verificationSha256,
      reviewDecisionSha256: landing.reviewDecisionSha256,
      changedPathsSha256: landing.changedPathsSha256,
      localRefOutcome: outcomes.localRefOutcome,
      remoteObjectOutcome: outcomes.remoteObjectOutcome,
      remoteRefOutcome: outcomes.remoteRefOutcome,
      pullRequestOutcome: outcomes.pullRequestOutcome,
      completedAt: this.#timestamp(),
    });
    const receiptJson = canonicalLandingJson(receipt);
    this.#database
      .prepare(
        "INSERT INTO landing_receipts (landing_id, receipt_json, receipt_sha256, created_at) " +
          "VALUES (?, ?, ?, ?)",
      )
      .run(landing.id, receiptJson, sha256(receiptJson), this.#timestamp());
  }

  /**
   * Settles the draft pull-request operation. A completed settlement requires
   * the full eight-request grammar settled, the one POST succeeded or
   * ambiguous, the suffix base/head unchanged and exact, and the suffix
   * complete list proving exactly one pull request equal to the POST
   * projection (created) or to the approved subject with durable prior
   * absence (reconciled); the receipt commits in the same transaction as the
   * landed transition. A failed settlement is legal only before the POST was
   * ever admitted. Anything else enters `reconciliation_required` with the
   * derived residue.
   */
  settleGithubPullRequest(
    landingId: string,
    input: GithubEffectSettlementInputV1,
  ): LandingStatusV1 {
    if (
      !(
        input.outcome === "completed" ||
        input.outcome === "failed" ||
        input.outcome === "reconciliation_required"
      )
    ) {
      invalid("Pull-request settlement outcome is unsupported");
    }
    if (input.outcome === "completed" && input.errorCode !== null) {
      invalid("Completed pull-request settlement cannot have an error");
    }
    const transaction = this.#database.transaction(() => {
      const status = this.#mutableStatus(landingId);
      if (status.landing.state !== "opening_draft_pr") {
        throw new IcarusError(
          "INVALID_LANDING_STATE",
          "Landing is not opening its draft pull request",
        );
      }
      const operation = this.#startedOperation(status, "github.pull_request.create");
      const attempt = this.#startedAttempt(status);
      if (operation.coordinatorAttempt !== attempt.ordinal) {
        invalid("Pull-request operation and coordinator attempt disagree");
      }
      const rows = status.httpRequests
        .filter((entry) => entry.operationId === operation.id)
        .sort((left, right) => left.requestOrdinal - right.requestOrdinal);
      if (rows.some((entry) => entry.status !== "settled")) {
        invalid("Pull-request settlement has an unsettled admitted request");
      }
      const evidence = this.#operationEvidence(operation, rows);
      if (input.outcome === "reconciliation_required") {
        const errorCode = assertSafeCode(input.errorCode, "pull-request errorCode");
        this.#settleOperation(operation, {
          schemaVersion: 1,
          operationId: operation.id,
          kind: operation.kind,
          outcome: "reconciliation_required",
          boundary: "reconciliation_required",
          evidence,
          value: {
            subjectOperationId: operation.id,
            remoteResidue: pullRequestResidueFromRows(rows),
          },
          errorCode,
        });
        this.#settleAttempt(attempt, "interrupted", errorCode);
        this.#transition(
          status.landing,
          "reconciliation_required",
          "remote_ready",
          errorCode,
          operation.id,
        );
        return;
      }
      const post = rows.find((entry) => entry.kind === "github.pull_request.post");
      if (input.outcome === "failed") {
        const errorCode = assertSafeCode(input.errorCode, "pull-request errorCode");
        // A definitive pre-POST refusal is the only retry-safe failure: the
        // one POST admission was never spent, so resume may try again.
        if (post !== undefined) {
          invalid("Pull-request failure after its POST admission must reconcile");
        }
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
        this.#transition(status.landing, "failed", "remote_ready", errorCode, operation.id);
        return;
      }
      const suffixBase = rows.filter((entry) => entry.kind === "github.base_ref.get").at(-1);
      const suffixHead = rows.filter((entry) => entry.kind === "github.head_ref.get").at(-1);
      const suffixList = rows.filter((entry) => entry.kind === "github.pull_requests.get").at(-1);
      const baseProjection =
        suffixBase?.result?.projection?.type === "ref" ? suffixBase.result.projection : null;
      const headProjection =
        suffixHead?.result?.projection?.type === "ref" ? suffixHead.result.projection : null;
      const listProjection =
        suffixList?.result?.projection?.type === "pull_request_list"
          ? suffixList.result.projection
          : null;
      const provenPullRequest =
        listProjection !== null && listProjection.complete && listProjection.count === 1
          ? (listProjection.objects[0] ?? null)
          : null;
      const postProjection =
        post?.result?.projection?.type === "pull_request" ? post.result.projection : null;
      if (
        post === undefined ||
        post.status !== "settled" ||
        post.outcome === "failed" ||
        !(post.outcome === "succeeded" || post.outcome === "ambiguous") ||
        baseProjection?.state !== "direct" ||
        baseProjection.sha1 !== status.landing.baseCommitSha1 ||
        headProjection?.state !== "direct" ||
        headProjection.sha1 !== status.landing.candidateCommitSha1 ||
        operation.observation === null ||
        provenPullRequest === null ||
        !pullRequestMatchesSubject(provenPullRequest, status.landing) ||
        (post.outcome === "succeeded"
          ? postProjection === null ||
            !pullRequestProjectionsMatch(postProjection, provenPullRequest)
          : !hasPullRequestAbsentIntent(operation, rows))
      ) {
        invalid("Completed pull-request settlement lacks its exact created or reconciled proof");
      }
      const value: DraftPrExactValueV1 = {
        ...provenPullRequest,
        pullRequestOutcome: post.outcome === "succeeded" ? "created" : "reconciled",
      };
      const result = this.#settleOperation(operation, {
        schemaVersion: 1,
        operationId: operation.id,
        kind: operation.kind,
        outcome: "completed",
        boundary: "draft_pr_exact",
        evidence,
        value,
        errorCode: null,
      });
      this.#settleAttempt(attempt, "completed", null);
      this.#insertLandingReceipt(status, {
        ...operation,
        status: "completed",
        result,
        resultSha256: sha256(canonicalLandingJson(result)),
        errorCode: null,
      });
      this.#transition(status.landing, "landed", null, null, operation.id);
    });
    runImmediate(transaction);
    return this.getStatus(landingId);
  }

  /**
   * The result evidence replaying the durable observation facts first, then
   * each settled request result not already represented, in ordinal order.
   */
  #operationEvidence(
    operation: LandingOperationRecordV1,
    rows: readonly LandingHttpRequestRecordV1[],
  ): { readonly requestId: string | null; readonly resultSha256: string }[] {
    const facts = operation.observation?.facts ?? [];
    const represented = new Set(facts.map((fact) => fact.requestId).filter((id) => id !== null));
    return [
      ...facts.map((fact) => ({ requestId: fact.requestId, resultSha256: fact.resultSha256 })),
      ...rows
        .filter((row) => !represented.has(row.id))
        .map((row) => ({
          requestId: row.id,
          resultSha256:
            row.resultSha256 ?? invalid("Settled landing HTTP request lacks its result digest"),
        })),
    ];
  }

  /**
   * Settles an object-upload reconciliation. No fresh reads exist for the
   * immutable subject: the completed settlement either proves the whole
   * grammar landed (`objects_ready`) or authorizes the byte-identical retry
   * (`local_ready`), both derived from the subject's durable rows.
   */
  settleObjectUploadReconciliation(
    landingId: string,
    input: GithubReconciliationSettlementInputV1,
  ): LandingStatusV1 {
    if (
      !(
        input.outcome === "objects_ready" ||
        input.outcome === "retry_local_ready" ||
        input.outcome === "reconciliation_required"
      )
    ) {
      invalid("Object-upload reconciliation outcome is unsupported");
    }
    const transaction = this.#database.transaction(() => {
      const status = this.#mutableStatus(landingId);
      if (
        status.landing.state !== "reconciliation_required" ||
        status.landing.resumeState !== "local_ready"
      ) {
        throw new IcarusError(
          "INVALID_LANDING_STATE",
          "Landing is not reconciling an object upload",
        );
      }
      const operation = this.#startedOperation(status, "landing.reconcile");
      const attempt = this.#startedAttempt(status);
      const subject = this.#reconciliationSubject(status);
      if (subject.kind !== "github.objects.upload") {
        invalid("Landing reconciliation subject is not an object upload");
      }
      const rows = status.httpRequests
        .filter((entry) => entry.operationId === operation.id)
        .sort((left, right) => left.requestOrdinal - right.requestOrdinal);
      if (rows.some((entry) => entry.status !== "settled")) {
        invalid("Reconciliation settlement has an unsettled admitted request");
      }
      const evidence = this.#operationEvidence(operation, rows);
      if (input.outcome === "reconciliation_required") {
        const errorCode = assertSafeCode(input.errorCode, "reconciliation errorCode");
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
        return;
      }
      if (input.errorCode !== null) {
        invalid("Completed reconciliation cannot carry an error");
      }
      const stageValue =
        input.outcome === "objects_ready"
          ? {
              candidateObjectManifestSha256: (subject.request.input as GitHubObjectsUploadInputV1)
                .candidateObjectManifestSha256,
              remoteObjectOutcome: "created_or_exact" as const,
            }
          : null;
      if (
        input.outcome === "objects_ready" &&
        !objectUploadRowsProveCompletion(subject, status.httpRequests)
      ) {
        invalid("Object-upload reconciliation lacks the complete immutable-object proof");
      }
      this.#settleOperation(operation, {
        schemaVersion: 1,
        operationId: operation.id,
        kind: operation.kind,
        outcome: "completed",
        boundary: input.outcome === "objects_ready" ? "subject_settled" : "retry_stage_proven",
        evidence,
        value: {
          subjectOperationId: subject.id,
          nextState: input.outcome === "objects_ready" ? "objects_ready" : "local_ready",
          remoteResidue: "none",
          stageValue,
        },
        errorCode: null,
      });
      this.#settleAttempt(attempt, "completed", null);
      this.#transition(
        status.landing,
        input.outcome === "objects_ready" ? "objects_ready" : "local_ready",
        null,
        null,
        operation.id,
      );
    });
    runImmediate(transaction);
    return this.getStatus(landingId);
  }

  /**
   * Settles a remote-ref reconciliation from its fresh settled reads: the
   * unchanged base plus the exact candidate head advances to `remote_ready`
   * (reconciled — never caller-chosen); the unchanged base plus a freshly
   * absent head authorizes one more absent-only POST from `objects_ready`;
   * drift, conflict, or unresolved visibility holds `reconciliation_required`
   * with the derived residue.
   */
  settleRemoteRefReconciliation(
    landingId: string,
    input: GithubReconciliationSettlementInputV1,
  ): LandingStatusV1 {
    if (
      !(
        input.outcome === "remote_ready" ||
        input.outcome === "retry_objects_ready" ||
        input.outcome === "reconciliation_required"
      )
    ) {
      invalid("Remote-ref reconciliation outcome is unsupported");
    }
    const transaction = this.#database.transaction(() => {
      const status = this.#mutableStatus(landingId);
      if (
        status.landing.state !== "reconciliation_required" ||
        status.landing.resumeState !== "objects_ready"
      ) {
        throw new IcarusError("INVALID_LANDING_STATE", "Landing is not reconciling a remote ref");
      }
      const operation = this.#startedOperation(status, "landing.reconcile");
      const attempt = this.#startedAttempt(status);
      const subject = this.#reconciliationSubject(status);
      if (subject.kind !== "github.ref.create") {
        invalid("Landing reconciliation subject is not a remote ref");
      }
      const rows = status.httpRequests
        .filter((entry) => entry.operationId === operation.id)
        .sort((left, right) => left.requestOrdinal - right.requestOrdinal);
      if (rows.some((entry) => entry.status !== "settled")) {
        invalid("Reconciliation settlement has an unsettled admitted request");
      }
      const evidence = this.#operationEvidence(operation, rows);
      if (input.outcome === "reconciliation_required") {
        const errorCode = assertSafeCode(input.errorCode, "reconciliation errorCode");
        this.#settleOperation(operation, {
          schemaVersion: 1,
          operationId: operation.id,
          kind: operation.kind,
          outcome: "reconciliation_required",
          boundary: "reconciliation_required",
          evidence,
          value: {
            subjectOperationId: subject.id,
            remoteResidue: remoteRefResidueFromRows(rows),
          },
          errorCode,
        });
        this.#settleAttempt(attempt, "interrupted", errorCode);
        return;
      }
      if (input.errorCode !== null) {
        invalid("Completed reconciliation cannot carry an error");
      }
      const freshBase = rows.find((entry) => entry.kind === "github.base_ref.get")?.result
        ?.projection;
      const freshHead = rows.find((entry) => entry.kind === "github.head_ref.get")?.result
        ?.projection;
      const baseUnchanged =
        freshBase?.type === "ref" &&
        freshBase.state === "direct" &&
        freshBase.sha1 === status.landing.baseCommitSha1;
      const subjectPost = status.httpRequests.find(
        (row) => row.operationId === subject.id && row.kind === "github.ref.post",
      );
      if (input.outcome === "remote_ready") {
        if (
          !baseUnchanged ||
          freshHead?.type !== "ref" ||
          freshHead.state !== "direct" ||
          freshHead.sha1 !== status.landing.candidateCommitSha1 ||
          subjectPost === undefined ||
          subjectPost.status !== "settled" ||
          !(subjectPost.outcome === "succeeded" || subjectPost.outcome === "ambiguous") ||
          !hasRemoteRefAbsentIntent(subject, status.httpRequests)
        ) {
          invalid("Remote-ref reconciliation lacks the exact proven branch");
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
            nextState: "remote_ready",
            remoteResidue: "branch",
            stageValue: {
              baseSha1: status.landing.baseCommitSha1,
              headSha1:
                status.landing.candidateCommitSha1 ??
                invalid("Landing remote-ref value lacks its candidate commit"),
              remoteRefOutcome: "reconciled",
            },
          },
          errorCode: null,
        });
        this.#settleAttempt(attempt, "completed", null);
        this.#transition(status.landing, "remote_ready", null, null, operation.id);
        return;
      }
      if (!baseUnchanged || freshHead?.type !== "ref" || freshHead.state !== "absent") {
        invalid("Remote-ref retry reconciliation lacks the unchanged base and absent head");
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
          nextState: "objects_ready",
          remoteResidue: "none",
          stageValue: null,
        },
        errorCode: null,
      });
      this.#settleAttempt(attempt, "completed", null);
      this.#transition(status.landing, "objects_ready", null, null, operation.id);
    });
    runImmediate(transaction);
    return this.getStatus(landingId);
  }

  /**
   * Settles a draft-PR reconciliation from its fresh settled reads: the
   * unchanged base, the exact candidate head, and a fresh complete list
   * proving exactly one pull request equal to the approved subject advances
   * to `landed` (reconciled — never caller-chosen) with the receipt committed
   * in the same transaction; the unchanged base, exact head, and a fresh
   * complete empty list authorize the one POST from `remote_ready` only when
   * the subject never admitted it. Drift, conflict, or unresolved visibility
   * holds `reconciliation_required` with the derived residue.
   */
  settlePullRequestReconciliation(
    landingId: string,
    input: GithubReconciliationSettlementInputV1,
  ): LandingStatusV1 {
    if (
      !(
        input.outcome === "landed" ||
        input.outcome === "retry_remote_ready" ||
        input.outcome === "reconciliation_required"
      )
    ) {
      invalid("Pull-request reconciliation outcome is unsupported");
    }
    const transaction = this.#database.transaction(() => {
      const status = this.#mutableStatus(landingId);
      if (
        status.landing.state !== "reconciliation_required" ||
        status.landing.resumeState !== "remote_ready"
      ) {
        throw new IcarusError(
          "INVALID_LANDING_STATE",
          "Landing is not reconciling a draft pull request",
        );
      }
      const operation = this.#startedOperation(status, "landing.reconcile");
      const attempt = this.#startedAttempt(status);
      const subject = this.#reconciliationSubject(status);
      if (subject.kind !== "github.pull_request.create") {
        invalid("Landing reconciliation subject is not a draft pull request");
      }
      const rows = status.httpRequests
        .filter((entry) => entry.operationId === operation.id)
        .sort((left, right) => left.requestOrdinal - right.requestOrdinal);
      if (rows.some((entry) => entry.status !== "settled")) {
        invalid("Reconciliation settlement has an unsettled admitted request");
      }
      const evidence = this.#operationEvidence(operation, rows);
      if (input.outcome === "reconciliation_required") {
        const errorCode = assertSafeCode(input.errorCode, "reconciliation errorCode");
        this.#settleOperation(operation, {
          schemaVersion: 1,
          operationId: operation.id,
          kind: operation.kind,
          outcome: "reconciliation_required",
          boundary: "reconciliation_required",
          evidence,
          value: {
            subjectOperationId: subject.id,
            remoteResidue: pullRequestResidueFromRows(rows),
          },
          errorCode,
        });
        this.#settleAttempt(attempt, "interrupted", errorCode);
        return;
      }
      if (input.errorCode !== null) {
        invalid("Completed reconciliation cannot carry an error");
      }
      const freshBase = rows.find((entry) => entry.kind === "github.base_ref.get")?.result
        ?.projection;
      const freshHead = rows.find((entry) => entry.kind === "github.head_ref.get")?.result
        ?.projection;
      const freshList = rows.find((entry) => entry.kind === "github.pull_requests.get")?.result
        ?.projection;
      const baseUnchanged =
        freshBase?.type === "ref" &&
        freshBase.state === "direct" &&
        freshBase.sha1 === status.landing.baseCommitSha1;
      const headExact =
        freshHead?.type === "ref" &&
        freshHead.state === "direct" &&
        freshHead.sha1 === status.landing.candidateCommitSha1;
      const subjectPost = status.httpRequests.find(
        (row) => row.operationId === subject.id && row.kind === "github.pull_request.post",
      );
      if (input.outcome === "landed") {
        const provenPullRequest =
          freshList?.type === "pull_request_list" &&
          freshList.complete &&
          freshList.count === 1
            ? (freshList.objects[0] ?? null)
            : null;
        if (
          !baseUnchanged ||
          !headExact ||
          provenPullRequest === null ||
          !pullRequestMatchesSubject(provenPullRequest, status.landing) ||
          subjectPost === undefined ||
          subjectPost.status !== "settled" ||
          !(subjectPost.outcome === "succeeded" || subjectPost.outcome === "ambiguous") ||
          !hasPullRequestAbsentIntent(subject, status.httpRequests)
        ) {
          invalid("Pull-request reconciliation lacks the exact proven draft pull request");
        }
        const stageValue: DraftPrExactValueV1 = {
          ...provenPullRequest,
          pullRequestOutcome: "reconciled",
        };
        const result = this.#settleOperation(operation, {
          schemaVersion: 1,
          operationId: operation.id,
          kind: operation.kind,
          outcome: "completed",
          boundary: "subject_settled",
          evidence,
          value: {
            subjectOperationId: subject.id,
            nextState: "landed",
            remoteResidue: "pull_request",
            stageValue,
          },
          errorCode: null,
        });
        this.#settleAttempt(attempt, "completed", null);
        this.#insertLandingReceipt(status, {
          ...operation,
          status: "completed",
          result,
          resultSha256: sha256(canonicalLandingJson(result)),
          errorCode: null,
        });
        this.#transition(status.landing, "landed", null, null, operation.id);
        return;
      }
      if (
        !baseUnchanged ||
        !headExact ||
        freshList?.type !== "pull_request_list" ||
        !freshList.complete ||
        freshList.count !== 0 ||
        subjectPost !== undefined
      ) {
        invalid(
          "Pull-request retry reconciliation lacks the unchanged base, exact head, " +
            "complete empty list, and unspent POST",
        );
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
          nextState: "remote_ready",
          remoteResidue: "branch",
          stageValue: null,
        },
        errorCode: null,
      });
      this.#settleAttempt(attempt, "completed", null);
      this.#transition(status.landing, "remote_ready", null, null, operation.id);
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

  #reconciliationSubject(status: LandingStatusV1): LandingOperationRecordV1 {
    return reconciliationSubject(status);
  }

  #startReconciliation(status: LandingStatusV1): string {
    const resumeState = status.landing.resumeState;
    if (
      status.landing.state !== "reconciliation_required" ||
      (resumeState !== "approved" &&
        resumeState !== "local_ready" &&
        resumeState !== "objects_ready" &&
        resumeState !== "remote_ready") ||
      status.landing.landingSha256 === null
    ) {
      throw new IcarusError(
        "INVALID_LANDING_STATE",
        "Landing is not awaiting reconciliation in an implemented slice",
      );
    }
    const subject = this.#reconciliationSubject(status);
    if (subject.resultSha256 === null) invalid("Reconciliation subject result digest is missing");
    return this.#startOperation(status, "landing.reconcile", {
      landingSha256: status.landing.landingSha256,
      resumeState,
      subjectOperationId: subject.id,
      subjectRequestSha256: subject.requestSha256,
      subjectResultSha256: subject.resultSha256,
    });
  }

  admitResume(landingId: string): LandingResumeAdmissionV1 {
    let attemptOrdinal: number | null = null;
    let operationId: string | null = null;
    let attemptLimitReached = false;
    const transaction = this.#database.transaction(() => {
      let status = this.#mutableStatus(landingId);
      const activeAttempt = status.attempts.find((attempt) => attempt.status === "started");
      if (activeAttempt !== undefined) {
        const activeOperation = status.operations.find(
          (operation) => operation.status === "started",
        );
        const expectedActiveKind =
          status.landing.state === "preparing_candidate"
            ? "candidate.prepare"
            : status.landing.state === "creating_local_ref"
              ? "local_ref.create"
              : status.landing.state === "local_ready" ||
                  status.landing.state === "objects_ready" ||
                  status.landing.state === "remote_ready"
                ? "github.preflight"
                : status.landing.state === "uploading_objects"
                  ? "github.objects.upload"
                  : status.landing.state === "creating_remote_ref"
                    ? "github.ref.create"
                    : status.landing.state === "opening_draft_pr"
                      ? "github.pull_request.create"
                      : status.landing.state === "reconciliation_required"
                        ? "landing.reconcile"
                        : null;
        if (
          (activeOperation === undefined &&
            !(
              status.landing.state === "preparing_candidate" ||
              status.landing.state === "approved" ||
              status.landing.state === "local_ready" ||
              status.landing.state === "objects_ready" ||
              status.landing.state === "remote_ready"
            )) ||
          (activeOperation !== undefined && activeOperation.kind !== expectedActiveKind)
        ) {
          invalid("Orphaned landing attempt does not match its current state");
        }
        const takeoverError = "LANDING_COORDINATOR_TAKEOVER";
        if (activeOperation !== undefined) {
          // First settle any admitted-but-unsettled HTTP request as ambiguous
          // with its canonical result and settled event: the host never infers
          // failure from an absent response, and no settled operation may keep
          // an open admission. Only then does the operation itself settle.
          const operationRows = status.httpRequests
            .filter((entry) => entry.operationId === activeOperation.id)
            .sort((left, right) => left.requestOrdinal - right.requestOrdinal);
          const admittedRows = operationRows.filter((entry) => entry.status === "admitted");
          if (admittedRows.length > 1) {
            invalid("Started landing operation has more than one unsettled request");
          }
          const settledResults: { readonly requestId: string; readonly resultSha256: string }[] =
            operationRows
              .filter((entry) => entry.status === "settled")
              .map((entry) => ({
                requestId: entry.id,
                resultSha256:
                  entry.resultSha256 ??
                  invalid("Settled landing HTTP request lacks its result digest"),
              }));
          for (const row of admittedRows) {
            const ambiguous = this.#settleHttpRequestRow(row, {
              outcome: "ambiguous",
              httpStatus: null,
              projection: null,
              errorCode: "GITHUB_OUTCOME_AMBIGUOUS",
            });
            settledResults.push({
              requestId: row.id,
              resultSha256: sha256(canonicalLandingJson(ambiguous)),
            });
          }
          const observationFacts = activeOperation.observation?.facts ?? [];
          const represented = new Set(
            observationFacts.map((fact) => fact.requestId).filter((id) => id !== null),
          );
          const evidence = [
            ...observationFacts.map(({ requestId, resultSha256 }) => ({ requestId, resultSha256 })),
            ...settledResults.filter((entry) => !represented.has(entry.requestId)),
          ];
          if (activeOperation.kind === "local_ref.create") {
            this.#settleOperation(activeOperation, {
              schemaVersion: 1,
              operationId: activeOperation.id,
              kind: activeOperation.kind,
              outcome: "reconciliation_required",
              boundary: "reconciliation_required",
              evidence,
              value: { subjectOperationId: activeOperation.id, remoteResidue: "none" },
              errorCode: takeoverError,
            });
          } else if (activeOperation.kind === "github.objects.upload") {
            // An interrupted effect always reconciles; content-addressed
            // objects are unreachable, so they are never remote residue.
            this.#settleOperation(activeOperation, {
              schemaVersion: 1,
              operationId: activeOperation.id,
              kind: activeOperation.kind,
              outcome: "reconciliation_required",
              boundary: "reconciliation_required",
              evidence,
              value: { subjectOperationId: activeOperation.id, remoteResidue: "none" },
              errorCode: takeoverError,
            });
          } else if (activeOperation.kind === "github.ref.create") {
            this.#settleOperation(activeOperation, {
              schemaVersion: 1,
              operationId: activeOperation.id,
              kind: activeOperation.kind,
              outcome: "reconciliation_required",
              boundary: "reconciliation_required",
              evidence,
              value: {
                subjectOperationId: activeOperation.id,
                remoteResidue: remoteRefResidueFromRows(operationRows),
              },
              errorCode: takeoverError,
            });
          } else if (activeOperation.kind === "github.pull_request.create") {
            this.#settleOperation(activeOperation, {
              schemaVersion: 1,
              operationId: activeOperation.id,
              kind: activeOperation.kind,
              outcome: "reconciliation_required",
              boundary: "reconciliation_required",
              evidence,
              value: {
                subjectOperationId: activeOperation.id,
                remoteResidue: pullRequestResidueFromRows(operationRows),
              },
              errorCode: takeoverError,
            });
          } else if (activeOperation.kind === "landing.reconcile") {
            const subject = this.#reconciliationSubject(status);
            this.#settleOperation(activeOperation, {
              schemaVersion: 1,
              operationId: activeOperation.id,
              kind: activeOperation.kind,
              outcome: "reconciliation_required",
              boundary: "reconciliation_required",
              evidence,
              value: {
                subjectOperationId: subject.id,
                remoteResidue:
                  subject.kind === "github.ref.create"
                    ? remoteRefResidueFromRows(operationRows)
                    : subject.kind === "github.pull_request.create"
                      ? pullRequestResidueFromRows(operationRows)
                      : "none",
              },
              errorCode: takeoverError,
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
              errorCode: takeoverError,
            });
          }
        }
        this.#settleAttempt(activeAttempt, "interrupted", takeoverError);
        if (activeOperation?.kind === "local_ref.create") {
          this.#transition(
            status.landing,
            "reconciliation_required",
            "approved",
            takeoverError,
            activeOperation.id,
          );
        } else if (activeOperation?.kind === "github.objects.upload") {
          this.#transition(
            status.landing,
            "reconciliation_required",
            "local_ready",
            takeoverError,
            activeOperation.id,
          );
        } else if (activeOperation?.kind === "github.ref.create") {
          this.#transition(
            status.landing,
            "reconciliation_required",
            "objects_ready",
            takeoverError,
            activeOperation.id,
          );
        } else if (activeOperation?.kind === "github.pull_request.create") {
          this.#transition(
            status.landing,
            "reconciliation_required",
            "remote_ready",
            takeoverError,
            activeOperation.id,
          );
        }
        status = this.getStatus(landingId);
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
        status.landing.state === "objects_ready" ||
        status.landing.state === "remote_ready" ||
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
      const subject = this.#reconciliationSubject(status);
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
