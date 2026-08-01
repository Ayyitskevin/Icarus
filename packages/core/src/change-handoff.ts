import { canonicalJson, canonicalJsonLine, parseStrictJson } from "./canonical-json.js";
import { sha256 } from "./digest.js";
import { IcarusError } from "./errors.js";
import type { ApprovalRecord, ProviderKind, ProviderLocality, RunState } from "./types.js";

export const CHANGE_HANDOFF_SCHEMA = "icarus.change-handoff.v1";
export const CHANGE_HANDOFF_VERSION = 1;
export const CHANGE_HANDOFF_DISCLOSURE_CLASS = "icarus.lifecycle-metadata-only.v1";
export const CHANGE_HANDOFF_INTEGRITY_STATEMENT =
  "Digests prove byte binding and recorded local evidence integrity only. They do not establish fresh authorization, semantic correctness, evidence truth, disclosure permission, or permission to execute/land code.";

export const CHANGE_HANDOFF_OMISSIONS = [
  "raw_task_prompts_and_research",
  "plan_text_steps_risks_rationale_and_grants",
  "source_paths_repository_maps_context_contents_patch_diff_and_checkpoint_bytes",
  "check_commands_argv_sandbox_stdout_stderr_and_output_fragments",
  "annotations_actors_and_event_payloads",
  "local_cache_worktree_and_artifact_paths",
  "urls_destinations_credentials_tokens_keys_bearers_and_headers",
  "commands_tool_calls_approval_retry_and_execution_instructions",
] as const;

export const CHANGE_HANDOFF_UNCERTAINTIES = [
  "Lifecycle status reflects recorded Icarus evidence at preview time and may change afterward.",
  "Failed runs may be resumable; a failed state is not represented as irreversibly final.",
  "Rollback and restoration completion metadata is observational and does not prove causal linkage.",
  "Omitted local evidence is not represented directly. Digest references are integrity identifiers, not confidentiality controls, and can confirm correctly guessed low-entropy evidence.",
] as const;

const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const CORRELATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const EXTERNAL_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CREDENTIAL_WORD_PATTERN =
  /(?:^|[._:-])(?:api[_-]?key|authorization|bearer|credential|password|passwd|private[_-]?key|secret|token)(?:$|[._:-])/i;
const CREDENTIAL_PREFIX_PATTERN =
  /(?:^|[._:-])(?:AKIA|ASIA|AIza|github_pat_|gh[pousr]_|glpat-|npm_|sk-|rk-|sk_(?:live|test)_|rk_(?:live|test)_|xox[a-z]-)/;
const EMBEDDED_CREDENTIAL_PATTERN =
  /(?:(?:AKIA|ASIA)[0-9A-Z]{12,}|AIza[0-9A-Za-z_-]{16,}|github_pat_[A-Za-z0-9_]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|glpat-[A-Za-z0-9_-]{8,}|npm_[A-Za-z0-9_-]{8,}|(?:sk-|rk-|sk_(?:live|test)_|rk_(?:live|test)_)[A-Za-z0-9_-]{8,}|xox[a-z]-[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,})/;
const MAX_HANDOFF_APPROVALS = 64;
const MAX_HANDOFF_EVENTS = 4_096;
const MAX_HANDOFF_CHANGED_FILES = 16;
const MAX_HANDOFF_VERIFICATION_CHECKS = 32;
const RUN_STATES = new Set<RunState>([
  "preparing",
  "planned",
  "awaiting_egress_approval",
  "awaiting_approval",
  "running",
  "verifying",
  "awaiting_review",
  "completed",
  "rolling_back",
  "cancelling",
  "failed",
  "cancelled",
  "rolled_back",
  "restoring",
]);

export type ChangeHandoffPhase =
  | "draft"
  | "planned"
  | "awaiting_approval"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type ChangeHandoffArtifactType =
  | "context_manifest"
  | "provider_plan_binding"
  | "verified_diff"
  | "tree_checkpoint";

export interface ChangeHandoffSourceSnapshot {
  readonly runId: string;
  readonly projectId: string;
  readonly state: RunState;
  readonly resumeState: RunState | null;
  readonly runVersion: number;
  readonly provider: {
    readonly kind: ProviderKind;
    readonly model: string;
    readonly locality: ProviderLocality;
    readonly privacyClass: "local_process" | "remote_api";
  };
  readonly contextSha256: string | null;
  readonly planSha256: string | null;
  readonly verification: {
    readonly outcome: "passed" | "failed" | "unavailable";
    readonly diffSha256: string;
    readonly checkpointSha256: string;
    readonly changedFiles: number;
    readonly checks: number;
  } | null;
  readonly reviewDecision: ApprovalRecord["decision"] | null;
  readonly interruptedRecovery: "rolling_back" | "restoring" | null;
  readonly checkpointSha256: string | null;
  readonly approvals: ReadonlyArray<{
    readonly kind: ApprovalRecord["kind"];
    readonly digest: string;
    readonly decision: ApprovalRecord["decision"];
  }>;
  readonly events: {
    readonly count: number;
    readonly highWater: number;
    readonly rollbackCompletedCount: number;
    readonly rollbackCompletedSequence: number | null;
    readonly restoreCompletedCount: number;
    readonly restoreCompletedSequence: number | null;
    readonly cancellationCompletedCount: number;
    readonly cancellationCompletedSequence: number | null;
    readonly reviewAcceptedCount: number;
    readonly reviewAcceptedSequence: number | null;
    readonly reviewRejectedCount: number;
    readonly reviewRejectedSequence: number | null;
    readonly transitionEvidenceSha256: string;
  };
  readonly activeOperations: 0;
}

export interface ChangeHandoffRequest {
  readonly correlationId: string;
  readonly externalTaskRef?: string | null;
}

export interface ChangeHandoffArtifactReference {
  readonly schema: "icarus.artifact-reference.v1";
  readonly version: 1;
  readonly type: ChangeHandoffArtifactType;
  readonly sha256: string;
}

export interface ChangeHandoffPayloadV1 {
  readonly schema: typeof CHANGE_HANDOFF_SCHEMA;
  readonly version: typeof CHANGE_HANDOFF_VERSION;
  readonly identifiers: {
    readonly handoffId: string;
    readonly runId: string;
    readonly projectId: string;
    readonly correlationId: string;
    readonly externalTaskRef: string | null;
  };
  readonly run: {
    readonly state: RunState;
    readonly phase: ChangeHandoffPhase;
  };
  readonly provider: {
    readonly kind: ProviderKind;
    readonly model: string;
    readonly locality: ProviderLocality;
    readonly privacyClass: "local_process" | "remote_api";
  };
  readonly lifecycle: {
    readonly egress:
      | "not_required_loopback"
      | "not_reached"
      | "awaiting_approval"
      | "approved"
      | "not_approved";
    readonly planApproval: "not_reached" | "awaiting_approval" | "approved" | "not_approved";
    readonly verification: "not_run" | "passed" | "failed" | "unavailable";
    readonly review: "not_reached" | "awaiting_decision" | "approved" | "rejected" | "not_decided";
    readonly rollback: "not_started" | "in_progress" | "completed" | "interrupted";
    readonly restoration: "not_started" | "in_progress" | "completed" | "interrupted";
    readonly terminalReason: string | null;
  };
  readonly counts: {
    readonly changedFiles: number | null;
    readonly verificationChecks: number;
  };
  readonly artifactReferences: readonly ChangeHandoffArtifactReference[];
  readonly disclosureClass: typeof CHANGE_HANDOFF_DISCLOSURE_CLASS;
  readonly summary: readonly string[];
  readonly integrity: {
    readonly semantics: "byte_binding_and_recorded_local_evidence_only";
    readonly statement: typeof CHANGE_HANDOFF_INTEGRITY_STATEMENT;
  };
  readonly omissions: typeof CHANGE_HANDOFF_OMISSIONS;
  readonly uncertainty: typeof CHANGE_HANDOFF_UNCERTAINTIES;
}

export interface ChangeHandoffPreview {
  readonly payload: ChangeHandoffPayloadV1;
  readonly payloadBytes: Buffer;
  readonly payloadSha256: string;
  readonly previewSha256: string;
  readonly sourceBindingSha256: string;
}

export interface ChangeHandoffExportResult {
  readonly exportStatus: "exported";
  readonly previewSha256: string;
  readonly outputSchema: typeof CHANGE_HANDOFF_SCHEMA;
  readonly payloadSha256: string;
}

export interface ChangeHandoffVerification {
  readonly schema: typeof CHANGE_HANDOFF_SCHEMA;
  readonly payloadSha256: string;
  readonly previewSha256: string;
  readonly exportStatus: "exported";
  readonly consistency: "internally_consistent";
  readonly authenticity: "not_established";
  readonly authorization: "not_established";
  readonly semanticTruth: "not_established";
  readonly disclosurePermission: "not_established";
  readonly executionAuthority: "none";
}

export interface ChangeHandoffInspection extends ChangeHandoffVerification {
  readonly handoff: ChangeHandoffPayloadV1;
}

type JsonRecord = Record<string, unknown>;

function invalid(code = "INVALID_HANDOFF", message = "Handoff artifact is invalid"): never {
  throw new IcarusError(code, message);
}

function exactRecord(value: unknown, keys: readonly string[]): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const object = value as JsonRecord;
  const expected = [...keys].sort();
  const actual = Object.keys(object).sort();
  if (expected.length !== actual.length || !expected.every((key, index) => key === actual[index])) {
    invalid();
  }
  return object;
}

function stringValue(value: unknown, maxBytes: number): string {
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > maxBytes
  ) {
    invalid();
  }
  return value;
}

function literal<T extends string | number>(value: unknown, expected: T): T {
  if (value !== expected) invalid();
  return expected;
}

function nullableString(value: unknown, maxBytes: number): string | null {
  return value === null ? null : stringValue(value, maxBytes);
}

function safeCount(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
    invalid();
  }
  return value;
}

function digestValue(value: unknown): string {
  const result = stringValue(value, 64);
  if (!SHA256_PATTERN.test(result)) invalid();
  return result;
}

function assertSafeOpaqueIdentifier(
  value: unknown,
  pattern: RegExp,
  code: string,
  label: string,
): string {
  if (
    typeof value !== "string" ||
    !pattern.test(value) ||
    CREDENTIAL_WORD_PATTERN.test(value) ||
    CREDENTIAL_PREFIX_PATTERN.test(value) ||
    EMBEDDED_CREDENTIAL_PATTERN.test(value)
  ) {
    throw new IcarusError(code, `${label} is not a safe opaque identifier`);
  }
  return value;
}

export function validateChangeHandoffRequest(input: ChangeHandoffRequest): {
  readonly correlationId: string;
  readonly externalTaskRef: string | null;
} {
  const correlationId = assertSafeOpaqueIdentifier(
    input.correlationId,
    CORRELATION_PATTERN,
    "INVALID_CORRELATION_ID",
    "Correlation ID",
  );
  const externalTaskRef = input.externalTaskRef ?? null;
  if (externalTaskRef !== null) {
    assertSafeOpaqueIdentifier(
      externalTaskRef,
      EXTERNAL_REFERENCE_PATTERN,
      "INVALID_EXTERNAL_TASK_REF",
      "External task reference",
    );
  }
  return { correlationId, externalTaskRef };
}

function validateModel(model: string): string {
  return assertSafeOpaqueIdentifier(
    model,
    MODEL_PATTERN,
    "UNSAFE_PROVIDER_MODEL",
    "Provider model",
  );
}

export function changeHandoffPhase(state: RunState): ChangeHandoffPhase {
  switch (state) {
    case "preparing":
      return "draft";
    case "planned":
      return "planned";
    case "awaiting_egress_approval":
    case "awaiting_approval":
    case "awaiting_review":
      return "awaiting_approval";
    case "running":
    case "verifying":
    case "rolling_back":
    case "restoring":
    case "cancelling":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
    case "rolled_back":
      return "cancelled";
  }
}

function hasApproval(
  source: ChangeHandoffSourceSnapshot,
  kind: ApprovalRecord["kind"],
  subject: string | null,
  decision: ApprovalRecord["decision"] = "approve",
): boolean {
  return (
    subject !== null &&
    source.approvals.some(
      (approval) =>
        approval.kind === kind && approval.digest === subject && approval.decision === decision,
    )
  );
}

function deriveLifecycle(source: ChangeHandoffSourceSnapshot): ChangeHandoffPayloadV1["lifecycle"] {
  const effectiveState =
    source.state === "failed" && source.resumeState !== null ? source.resumeState : source.state;
  const egress =
    source.provider.locality === "loopback"
      ? "not_required_loopback"
      : source.contextSha256 === null
        ? "not_reached"
        : effectiveState === "awaiting_egress_approval"
          ? "awaiting_approval"
          : hasApproval(source, "egress", source.contextSha256)
            ? "approved"
            : "not_approved";
  const planApproval =
    source.planSha256 === null
      ? "not_reached"
      : effectiveState === "awaiting_approval"
        ? "awaiting_approval"
        : hasApproval(source, "plan", source.planSha256)
          ? "approved"
          : "not_approved";
  const review =
    source.verification === null
      ? "not_reached"
      : source.state === "awaiting_review"
        ? "awaiting_decision"
        : source.reviewDecision === "approve"
          ? "approved"
          : source.reviewDecision === "reject"
            ? "rejected"
            : "not_decided";
  const rollback =
    source.state === "rolling_back"
      ? "in_progress"
      : source.interruptedRecovery === "rolling_back"
        ? "interrupted"
        : source.events.rollbackCompletedCount > 0
          ? "completed"
          : "not_started";
  const restorationCompletedInLatestCycle =
    source.events.restoreCompletedSequence !== null &&
    source.events.rollbackCompletedSequence !== null &&
    source.events.restoreCompletedSequence > source.events.rollbackCompletedSequence;
  const rollbackActive =
    source.state === "rolling_back" || source.interruptedRecovery === "rolling_back";
  const restoration =
    source.state === "restoring"
      ? "in_progress"
      : source.interruptedRecovery === "restoring"
        ? "interrupted"
        : rollbackActive
          ? "not_started"
          : restorationCompletedInLatestCycle
            ? "completed"
            : "not_started";
  const terminalReason =
    source.state === "completed"
      ? "completed"
      : source.state === "cancelled"
        ? "cancelled"
        : source.state === "rolled_back"
          ? "rolled_back"
          : source.state === "failed"
            ? "failed"
            : null;
  return {
    egress,
    planApproval,
    verification: source.verification?.outcome ?? "not_run",
    review,
    rollback,
    restoration,
    terminalReason,
  };
}

function stateSummary(state: RunState): string {
  switch (state) {
    case "preparing":
      return "This Icarus run is being prepared.";
    case "planned":
      return "This Icarus run is planned.";
    case "awaiting_egress_approval":
    case "awaiting_approval":
    case "awaiting_review":
      return "This Icarus run is awaiting an operator decision.";
    case "running":
    case "verifying":
    case "rolling_back":
    case "restoring":
    case "cancelling":
      return "This Icarus run has recorded work in progress.";
    case "completed":
      return "This Icarus run is completed.";
    case "failed":
      return "This Icarus run is failed and may be resumable.";
    case "cancelled":
      return "This Icarus run is cancelled.";
    case "rolled_back":
      return "This Icarus run is rolled back.";
  }
}

function verificationSummary(outcome: ChangeHandoffPayloadV1["lifecycle"]["verification"]): string {
  switch (outcome) {
    case "not_run":
      return "Verification has not been recorded.";
    case "passed":
      return "Verification passed.";
    case "failed":
      return "Verification failed.";
    case "unavailable":
      return "Verification was unavailable.";
  }
}

function reviewSummary(review: ChangeHandoffPayloadV1["lifecycle"]["review"]): string {
  switch (review) {
    case "not_reached":
      return "Review has not been reached.";
    case "awaiting_decision":
      return "Review is awaiting an operator decision.";
    case "approved":
      return "Review was approved.";
    case "rejected":
      return "Review was rejected.";
    case "not_decided":
      return "No current review decision is represented.";
  }
}

function buildSummary(
  state: RunState,
  lifecycle: ChangeHandoffPayloadV1["lifecycle"],
): readonly string[] {
  return [
    stateSummary(state),
    verificationSummary(lifecycle.verification),
    reviewSummary(lifecycle.review),
    "Evidence remains local in Icarus.",
    "No commit, push, merge, or deployment is represented by this artifact.",
  ];
}

function artifactReferences(
  source: ChangeHandoffSourceSnapshot,
): readonly ChangeHandoffArtifactReference[] {
  const entries: ChangeHandoffArtifactReference[] = [];
  const add = (type: ChangeHandoffArtifactType, value: string | null): void => {
    if (value === null) return;
    if (!SHA256_PATTERN.test(value)) invalid("HANDOFF_SOURCE_INVALID");
    entries.push({
      schema: "icarus.artifact-reference.v1",
      version: 1,
      type,
      sha256: value,
    });
  };
  add("context_manifest", source.contextSha256);
  add("provider_plan_binding", source.planSha256);
  add("verified_diff", source.verification?.diffSha256 ?? null);
  add("tree_checkpoint", source.checkpointSha256);
  return entries;
}

function assertSourceSnapshot(source: ChangeHandoffSourceSnapshot): void {
  const resumeStateIsValid =
    source.resumeState === "preparing" ||
    source.resumeState === "planned" ||
    source.resumeState === "running" ||
    source.resumeState === "verifying" ||
    source.resumeState === "rolling_back" ||
    source.resumeState === "restoring" ||
    source.resumeState === "cancelling";
  const expectedFailedRecovery =
    source.state === "failed" &&
    (source.resumeState === "rolling_back" || source.resumeState === "restoring")
      ? source.resumeState
      : null;
  const cancellationState = source.state === "cancelling" || source.state === "cancelled";
  if (
    (source.interruptedRecovery !== null &&
      source.interruptedRecovery !== "rolling_back" &&
      source.interruptedRecovery !== "restoring") ||
    (source.state === "failed" && source.interruptedRecovery !== expectedFailedRecovery) ||
    (source.state !== "failed" && !cancellationState && source.interruptedRecovery !== null)
  ) {
    invalid("HANDOFF_SOURCE_INVALID");
  }
  if (
    !UUID_PATTERN.test(source.runId) ||
    !UUID_PATTERN.test(source.projectId) ||
    !RUN_STATES.has(source.state) ||
    (source.state === "failed" ? !resumeStateIsValid : source.resumeState !== null) ||
    !Number.isSafeInteger(source.runVersion) ||
    source.runVersion < 0 ||
    source.activeOperations !== 0 ||
    (source.provider.kind !== "ollama" &&
      source.provider.kind !== "openai" &&
      source.provider.kind !== "anthropic") ||
    (source.provider.locality !== "loopback" && source.provider.locality !== "remote")
  ) {
    invalid("HANDOFF_SOURCE_INVALID");
  }
  validateModel(source.provider.model);
  if (
    (source.provider.locality === "loopback" && source.provider.privacyClass !== "local_process") ||
    (source.provider.locality === "remote" && source.provider.privacyClass !== "remote_api")
  ) {
    invalid("HANDOFF_SOURCE_INVALID");
  }
  for (const value of [
    source.contextSha256,
    source.planSha256,
    source.verification?.diffSha256 ?? null,
    source.verification?.checkpointSha256 ?? null,
    source.checkpointSha256,
  ]) {
    if (value !== null && !SHA256_PATTERN.test(value)) invalid("HANDOFF_SOURCE_INVALID");
  }
  if (
    source.verification !== null &&
    ((source.verification.outcome !== "passed" &&
      source.verification.outcome !== "failed" &&
      source.verification.outcome !== "unavailable") ||
      source.checkpointSha256 !== source.verification.checkpointSha256 ||
      !Number.isSafeInteger(source.verification.changedFiles) ||
      source.verification.changedFiles < 1 ||
      source.verification.changedFiles > MAX_HANDOFF_CHANGED_FILES ||
      !Number.isSafeInteger(source.verification.checks) ||
      source.verification.checks < 0 ||
      source.verification.checks > MAX_HANDOFF_VERIFICATION_CHECKS)
  ) {
    invalid("HANDOFF_SOURCE_INVALID");
  }
  if (
    (source.reviewDecision !== null &&
      source.reviewDecision !== "approve" &&
      source.reviewDecision !== "reject") ||
    (source.verification === null && source.reviewDecision !== null) ||
    (source.state === "awaiting_review" && source.reviewDecision !== null)
  ) {
    invalid("HANDOFF_SOURCE_INVALID");
  }
  const effectiveState =
    source.state === "failed" && source.resumeState !== null ? source.resumeState : source.state;
  const beforePlan =
    effectiveState === "preparing" ||
    effectiveState === "planned" ||
    effectiveState === "awaiting_egress_approval";
  const requiresPlan =
    effectiveState === "awaiting_approval" ||
    effectiveState === "running" ||
    effectiveState === "verifying" ||
    effectiveState === "awaiting_review" ||
    effectiveState === "completed" ||
    effectiveState === "rolling_back" ||
    effectiveState === "rolled_back" ||
    effectiveState === "restoring";
  const requiresApprovedPlan = requiresPlan && effectiveState !== "awaiting_approval";
  const requiresVerification =
    effectiveState === "awaiting_review" ||
    effectiveState === "completed" ||
    effectiveState === "rolling_back" ||
    effectiveState === "rolled_back" ||
    effectiveState === "restoring";
  const forbidsVerification =
    effectiveState === "preparing" ||
    effectiveState === "planned" ||
    effectiveState === "awaiting_egress_approval" ||
    effectiveState === "awaiting_approval";
  if (
    (beforePlan && source.planSha256 !== null) ||
    (requiresPlan && source.planSha256 === null) ||
    (effectiveState !== "preparing" &&
      effectiveState !== "cancelling" &&
      effectiveState !== "cancelled" &&
      source.contextSha256 === null) ||
    (requiresVerification && source.verification === null) ||
    (forbidsVerification && source.verification !== null)
  ) {
    invalid("HANDOFF_SOURCE_INVALID");
  }

  const eventPairs: ReadonlyArray<readonly [number, number | null]> = [
    [source.events.rollbackCompletedCount, source.events.rollbackCompletedSequence],
    [source.events.restoreCompletedCount, source.events.restoreCompletedSequence],
    [source.events.cancellationCompletedCount, source.events.cancellationCompletedSequence],
    [source.events.reviewAcceptedCount, source.events.reviewAcceptedSequence],
    [source.events.reviewRejectedCount, source.events.reviewRejectedSequence],
  ];
  const eventNumbers = [
    source.events.count,
    source.events.highWater,
    ...eventPairs.map(([count]) => count),
  ];
  const nonnullSequences = eventPairs.flatMap(([, sequence]) =>
    sequence === null ? [] : [sequence],
  );
  if (
    !SHA256_PATTERN.test(source.events.transitionEvidenceSha256) ||
    eventNumbers.some(
      (value) => !Number.isSafeInteger(value) || value < 0 || value > MAX_HANDOFF_EVENTS,
    ) ||
    source.events.count < 1 ||
    source.events.highWater !== source.events.count ||
    eventPairs.some(
      ([count, sequence]) =>
        (count === 0) !== (sequence === null) ||
        (sequence !== null &&
          (!Number.isSafeInteger(sequence) ||
            sequence < 1 ||
            sequence > source.events.highWater ||
            count > sequence)),
    ) ||
    new Set(nonnullSequences).size !== nonnullSequences.length ||
    !Array.isArray(source.approvals) ||
    source.approvals.length > MAX_HANDOFF_APPROVALS
  ) {
    invalid("HANDOFF_SOURCE_INVALID");
  }

  source.approvals.forEach((approval) => {
    if (
      (approval.kind !== "egress" &&
        approval.kind !== "plan" &&
        approval.kind !== "review" &&
        approval.kind !== "rollback" &&
        approval.kind !== "restore") ||
      !SHA256_PATTERN.test(approval.digest) ||
      (approval.decision !== "approve" && approval.decision !== "reject") ||
      (approval.decision === "reject" && approval.kind !== "review")
    ) {
      invalid("HANDOFF_SOURCE_INVALID");
    }
  });

  const approvedReviews = source.approvals.filter(
    (approval) => approval.kind === "review" && approval.decision === "approve",
  ).length;
  const rejectedReviews = source.approvals.filter(
    (approval) => approval.kind === "review" && approval.decision === "reject",
  ).length;
  const rollbackAuthorizations =
    rejectedReviews +
    source.approvals.filter(
      (approval) => approval.kind === "rollback" && approval.decision === "approve",
    ).length;
  const restoreAuthorizations = source.approvals.filter(
    (approval) => approval.kind === "restore" && approval.decision === "approve",
  ).length;
  const currentDiffSha256 = source.verification?.diffSha256 ?? null;
  const rollbackAuthorized =
    hasApproval(source, "review", currentDiffSha256, "reject") ||
    hasApproval(source, "rollback", currentDiffSha256);
  const cancellationLike = effectiveState === "cancelling" || effectiveState === "cancelled";
  if (
    (source.interruptedRecovery === "rolling_back" &&
      (source.verification === null || source.checkpointSha256 === null || !rollbackAuthorized)) ||
    (source.interruptedRecovery === "restoring" &&
      (source.verification === null ||
        source.checkpointSha256 === null ||
        source.events.rollbackCompletedCount < 1 ||
        !hasApproval(source, "restore", source.checkpointSha256)))
  ) {
    invalid("HANDOFF_SOURCE_INVALID");
  }

  if (
    (effectiveState === "preparing" && source.contextSha256 !== null) ||
    (source.provider.locality === "remote" &&
      effectiveState !== "preparing" &&
      effectiveState !== "awaiting_egress_approval" &&
      !cancellationLike &&
      !hasApproval(source, "egress", source.contextSha256)) ||
    (requiresApprovedPlan && !hasApproval(source, "plan", source.planSha256)) ||
    source.events.reviewAcceptedCount !== approvedReviews ||
    source.events.reviewRejectedCount !== rejectedReviews ||
    source.events.rollbackCompletedCount > rollbackAuthorizations ||
    source.events.restoreCompletedCount > restoreAuthorizations ||
    source.events.restoreCompletedCount > source.events.rollbackCompletedCount ||
    source.events.cancellationCompletedCount > 1 ||
    (source.state === "cancelled") !== (source.events.cancellationCompletedCount === 1)
  ) {
    invalid("HANDOFF_SOURCE_INVALID");
  }
  if (
    source.state === "completed" &&
    (source.verification?.outcome !== "passed" ||
      source.reviewDecision !== "approve" ||
      source.events.reviewAcceptedCount < 1)
  ) {
    invalid("HANDOFF_SOURCE_INVALID");
  }
  if (
    (effectiveState === "rolling_back" || source.state === "rolled_back") &&
    (source.checkpointSha256 === null || !rollbackAuthorized)
  ) {
    invalid("HANDOFF_SOURCE_INVALID");
  }
  if (source.state === "rolled_back" && source.events.rollbackCompletedCount < 1) {
    invalid("HANDOFF_SOURCE_INVALID");
  }
  if (
    effectiveState === "restoring" &&
    (source.checkpointSha256 === null ||
      source.events.rollbackCompletedCount < 1 ||
      !hasApproval(source, "restore", source.checkpointSha256))
  ) {
    invalid("HANDOFF_SOURCE_INVALID");
  }
}

function sourceBinding(source: ChangeHandoffSourceSnapshot): string {
  const verification =
    source.verification === null
      ? null
      : {
          outcome: source.verification.outcome,
          diffSha256: source.verification.diffSha256,
          checkpointSha256: source.verification.checkpointSha256,
          changedFiles: source.verification.changedFiles,
          checks: source.verification.checks,
        };
  const approvals = source.approvals.map((approval) => ({
    kind: approval.kind,
    digest: approval.digest,
    decision: approval.decision,
  }));
  const events = {
    count: source.events.count,
    highWater: source.events.highWater,
    rollbackCompletedCount: source.events.rollbackCompletedCount,
    rollbackCompletedSequence: source.events.rollbackCompletedSequence,
    restoreCompletedCount: source.events.restoreCompletedCount,
    restoreCompletedSequence: source.events.restoreCompletedSequence,
    cancellationCompletedCount: source.events.cancellationCompletedCount,
    cancellationCompletedSequence: source.events.cancellationCompletedSequence,
    reviewAcceptedCount: source.events.reviewAcceptedCount,
    reviewAcceptedSequence: source.events.reviewAcceptedSequence,
    reviewRejectedCount: source.events.reviewRejectedCount,
    reviewRejectedSequence: source.events.reviewRejectedSequence,
    transitionEvidenceSha256: source.events.transitionEvidenceSha256,
  };
  const binding = {
    schema: "icarus.change-handoff-source-binding.v1",
    version: 1,
    runId: source.runId,
    projectId: source.projectId,
    state: source.state,
    resumeState: source.resumeState,
    runVersion: source.runVersion,
    provider: {
      kind: source.provider.kind,
      model: source.provider.model,
      locality: source.provider.locality,
      privacyClass: source.provider.privacyClass,
    },
    contextSha256: source.contextSha256,
    planSha256: source.planSha256,
    verification,
    checkpointSha256: source.checkpointSha256,
    reviewDecision: source.reviewDecision,
    interruptedRecovery: source.interruptedRecovery,
    approvals,
    events,
    activeOperations: source.activeOperations,
  };
  return sha256(canonicalJson(binding));
}

export function buildChangeHandoffPreview(
  source: ChangeHandoffSourceSnapshot,
  requestInput: ChangeHandoffRequest,
): ChangeHandoffPreview {
  assertSourceSnapshot(source);
  const request = validateChangeHandoffRequest(requestInput);
  const sourceBindingSha256 = sourceBinding(source);
  const handoffId = sha256(
    canonicalJson([
      "icarus.change-handoff-id.v1",
      source.runId,
      request.correlationId,
      request.externalTaskRef,
      sourceBindingSha256,
    ]),
  );
  const lifecycle = deriveLifecycle(source);
  const payload: ChangeHandoffPayloadV1 = {
    schema: CHANGE_HANDOFF_SCHEMA,
    version: CHANGE_HANDOFF_VERSION,
    identifiers: {
      handoffId,
      runId: source.runId,
      projectId: source.projectId,
      correlationId: request.correlationId,
      externalTaskRef: request.externalTaskRef,
    },
    run: {
      state: source.state,
      phase: changeHandoffPhase(source.state),
    },
    provider: {
      kind: source.provider.kind,
      model: source.provider.model,
      locality: source.provider.locality,
      privacyClass: source.provider.privacyClass,
    },
    lifecycle,
    counts: {
      changedFiles: source.verification?.changedFiles ?? null,
      verificationChecks: source.verification?.checks ?? 0,
    },
    artifactReferences: artifactReferences(source),
    disclosureClass: CHANGE_HANDOFF_DISCLOSURE_CLASS,
    summary: buildSummary(source.state, lifecycle),
    integrity: {
      semantics: "byte_binding_and_recorded_local_evidence_only",
      statement: CHANGE_HANDOFF_INTEGRITY_STATEMENT,
    },
    omissions: CHANGE_HANDOFF_OMISSIONS,
    uncertainty: CHANGE_HANDOFF_UNCERTAINTIES,
  };
  const payloadBytes = canonicalJsonLine(payload);
  decodeChangeHandoffPayloadBytes(payloadBytes);
  const payloadSha256 = sha256(payloadBytes);
  const previewSha256 = sha256(
    canonicalJson([
      "icarus.change-handoff-preview.v1",
      1,
      source.runId,
      request.correlationId,
      request.externalTaskRef,
      sourceBindingSha256,
      payloadSha256,
    ]),
  );
  return {
    payload,
    payloadBytes,
    payloadSha256,
    previewSha256,
    sourceBindingSha256,
  };
}

function enumValue<T extends string>(value: unknown, values: readonly T[]): T {
  const result = stringValue(value, 128);
  if (!values.includes(result as T)) invalid();
  return result as T;
}

function decodeArtifactReference(value: unknown): ChangeHandoffArtifactReference {
  const object = exactRecord(value, ["schema", "version", "type", "sha256"]);
  return {
    schema: literal(object.schema, "icarus.artifact-reference.v1"),
    version: literal(object.version, 1),
    type: enumValue(object.type, [
      "context_manifest",
      "provider_plan_binding",
      "verified_diff",
      "tree_checkpoint",
    ]),
    sha256: digestValue(object.sha256),
  };
}

function decodePayload(value: unknown): ChangeHandoffPayloadV1 {
  const object = exactRecord(value, [
    "schema",
    "version",
    "identifiers",
    "run",
    "provider",
    "lifecycle",
    "counts",
    "artifactReferences",
    "disclosureClass",
    "summary",
    "integrity",
    "omissions",
    "uncertainty",
  ]);
  const identifiers = exactRecord(object.identifiers, [
    "handoffId",
    "runId",
    "projectId",
    "correlationId",
    "externalTaskRef",
  ]);
  const handoffId = digestValue(identifiers.handoffId);
  const runId = stringValue(identifiers.runId, 64);
  const projectId = stringValue(identifiers.projectId, 64);
  if (!UUID_PATTERN.test(runId) || !UUID_PATTERN.test(projectId)) invalid();
  const request = validateChangeHandoffRequest({
    correlationId: stringValue(identifiers.correlationId, 128),
    externalTaskRef: nullableString(identifiers.externalTaskRef, 256),
  });

  const run = exactRecord(object.run, ["state", "phase"]);
  const state = enumValue(run.state, [...RUN_STATES]);
  const phase = enumValue(run.phase, [
    "draft",
    "planned",
    "awaiting_approval",
    "running",
    "completed",
    "failed",
    "cancelled",
  ]);
  if (phase !== changeHandoffPhase(state)) invalid();

  const provider = exactRecord(object.provider, ["kind", "model", "locality", "privacyClass"]);
  const kind = enumValue(provider.kind, ["ollama", "openai", "anthropic"]);
  const model = validateModel(stringValue(provider.model, 128));
  const locality = enumValue(provider.locality, ["loopback", "remote"]);
  const privacyClass = enumValue(provider.privacyClass, ["local_process", "remote_api"]);
  if (
    (locality === "loopback" && privacyClass !== "local_process") ||
    (locality === "remote" && privacyClass !== "remote_api")
  ) {
    invalid();
  }

  const lifecycleObject = exactRecord(object.lifecycle, [
    "egress",
    "planApproval",
    "verification",
    "review",
    "rollback",
    "restoration",
    "terminalReason",
  ]);
  const lifecycle: ChangeHandoffPayloadV1["lifecycle"] = {
    egress: enumValue(lifecycleObject.egress, [
      "not_required_loopback",
      "not_reached",
      "awaiting_approval",
      "approved",
      "not_approved",
    ]),
    planApproval: enumValue(lifecycleObject.planApproval, [
      "not_reached",
      "awaiting_approval",
      "approved",
      "not_approved",
    ]),
    verification: enumValue(lifecycleObject.verification, [
      "not_run",
      "passed",
      "failed",
      "unavailable",
    ]),
    review: enumValue(lifecycleObject.review, [
      "not_reached",
      "awaiting_decision",
      "approved",
      "rejected",
      "not_decided",
    ]),
    rollback: enumValue(lifecycleObject.rollback, [
      "not_started",
      "in_progress",
      "completed",
      "interrupted",
    ]),
    restoration: enumValue(lifecycleObject.restoration, [
      "not_started",
      "in_progress",
      "completed",
      "interrupted",
    ]),
    terminalReason: nullableString(lifecycleObject.terminalReason, 72),
  };
  const expectedTerminal =
    state === "completed"
      ? "completed"
      : state === "cancelled"
        ? "cancelled"
        : state === "rolled_back"
          ? "rolled_back"
          : state === "failed"
            ? "failed"
            : null;
  if (lifecycle.terminalReason !== expectedTerminal) invalid();
  const requiresApprovedPlan =
    state === "running" ||
    state === "verifying" ||
    state === "awaiting_review" ||
    state === "completed" ||
    state === "rolling_back" ||
    state === "rolled_back" ||
    state === "restoring";
  const earlyState =
    state === "preparing" ||
    state === "planned" ||
    state === "awaiting_egress_approval" ||
    state === "awaiting_approval";
  const cancellationOrFailure =
    state === "cancelling" || state === "cancelled" || state === "failed";
  const verificationReached = lifecycle.verification !== "not_run";
  const postRestoreVerificationGap =
    (state === "verifying" ||
      state === "failed" ||
      state === "cancelling" ||
      state === "cancelled") &&
    lifecycle.verification === "not_run" &&
    lifecycle.review === "not_reached" &&
    lifecycle.rollback === "completed" &&
    lifecycle.restoration === "completed";
  const postRecoveryExecutionState =
    state === "running" ||
    state === "verifying" ||
    state === "awaiting_review" ||
    state === "completed";
  if (
    (locality === "loopback" && lifecycle.egress !== "not_required_loopback") ||
    (locality === "remote" && lifecycle.egress === "not_required_loopback") ||
    (locality === "remote" &&
      lifecycle.egress === "awaiting_approval" &&
      state !== "awaiting_egress_approval") ||
    (locality === "remote" &&
      state === "awaiting_egress_approval" &&
      lifecycle.egress !== "awaiting_approval") ||
    (locality === "remote" &&
      lifecycle.egress === "not_reached" &&
      state !== "preparing" &&
      !cancellationOrFailure) ||
    (locality === "remote" && lifecycle.egress === "not_approved" && !cancellationOrFailure) ||
    (locality === "remote" && verificationReached && lifecycle.egress !== "approved") ||
    (requiresApprovedPlan && lifecycle.planApproval !== "approved") ||
    ((state === "preparing" || state === "planned" || state === "awaiting_egress_approval") &&
      lifecycle.planApproval !== "not_reached") ||
    (state === "awaiting_approval" && lifecycle.planApproval !== "awaiting_approval") ||
    (lifecycle.planApproval === "awaiting_approval" && state !== "awaiting_approval") ||
    (lifecycle.planApproval === "not_approved" && !cancellationOrFailure) ||
    (verificationReached && lifecycle.planApproval !== "approved") ||
    (earlyState &&
      (verificationReached ||
        lifecycle.review !== "not_reached" ||
        lifecycle.rollback !== "not_started" ||
        lifecycle.restoration !== "not_started")) ||
    ((lifecycle.rollback !== "not_started" || lifecycle.restoration !== "not_started") &&
      !verificationReached &&
      !postRestoreVerificationGap) ||
    verificationReached === (lifecycle.review === "not_reached") ||
    (state === "awaiting_review" && lifecycle.review !== "awaiting_decision") ||
    (lifecycle.review === "awaiting_decision" && state !== "awaiting_review") ||
    (state === "completed" &&
      (lifecycle.verification !== "passed" || lifecycle.review !== "approved")) ||
    (state === "rolling_back" && lifecycle.rollback !== "in_progress") ||
    (lifecycle.rollback === "in_progress" && state !== "rolling_back") ||
    (lifecycle.rollback === "interrupted" &&
      state !== "failed" &&
      state !== "cancelling" &&
      state !== "cancelled") ||
    (state === "rolled_back" && lifecycle.rollback !== "completed") ||
    (state === "restoring" &&
      (lifecycle.rollback !== "completed" || lifecycle.restoration !== "in_progress")) ||
    (lifecycle.restoration === "in_progress" && state !== "restoring") ||
    (lifecycle.restoration === "interrupted" &&
      state !== "failed" &&
      state !== "cancelling" &&
      state !== "cancelled") ||
    (postRecoveryExecutionState &&
      lifecycle.rollback === "completed" &&
      lifecycle.restoration !== "completed") ||
    ((lifecycle.restoration === "completed" || lifecycle.restoration === "interrupted") &&
      lifecycle.rollback !== "completed")
  ) {
    invalid();
  }

  const countsObject = exactRecord(object.counts, ["changedFiles", "verificationChecks"]);
  const changedFiles =
    countsObject.changedFiles === null
      ? null
      : safeCount(countsObject.changedFiles, MAX_HANDOFF_CHANGED_FILES);
  const verificationChecks = safeCount(
    countsObject.verificationChecks,
    MAX_HANDOFF_VERIFICATION_CHECKS,
  );
  if (
    (lifecycle.verification === "not_run" && (changedFiles !== null || verificationChecks !== 0)) ||
    (lifecycle.verification !== "not_run" && (changedFiles === null || changedFiles < 1))
  ) {
    invalid();
  }

  if (!Array.isArray(object.artifactReferences) || object.artifactReferences.length > 4) invalid();
  const references = object.artifactReferences.map(decodeArtifactReference);
  const order: readonly ChangeHandoffArtifactType[] = [
    "context_manifest",
    "provider_plan_binding",
    "verified_diff",
    "tree_checkpoint",
  ];
  const indices = references.map((reference) => order.indexOf(reference.type));
  if (
    new Set(indices).size !== indices.length ||
    indices.some((index, position) => position > 0 && index <= (indices[position - 1] ?? -1))
  ) {
    invalid();
  }
  const contextReference = references.find((reference) => reference.type === "context_manifest");
  const planReference = references.find((reference) => reference.type === "provider_plan_binding");
  const diffReference = references.find((reference) => reference.type === "verified_diff");
  const checkpointReference = references.find((reference) => reference.type === "tree_checkpoint");
  if (
    (state === "preparing" && contextReference !== undefined) ||
    (state !== "preparing" && !cancellationOrFailure && contextReference === undefined) ||
    (locality === "remote" &&
      (lifecycle.egress === "not_reached") !== (contextReference === undefined)) ||
    (lifecycle.planApproval === "not_reached") !== (planReference === undefined) ||
    (planReference !== undefined && contextReference === undefined) ||
    (locality === "remote" && planReference !== undefined && lifecycle.egress !== "approved") ||
    (lifecycle.verification === "not_run" && diffReference !== undefined) ||
    (lifecycle.verification !== "not_run" &&
      (diffReference === undefined || checkpointReference === undefined)) ||
    ((lifecycle.rollback !== "not_started" || lifecycle.restoration !== "not_started") &&
      checkpointReference === undefined)
  ) {
    invalid();
  }

  if (
    !Array.isArray(object.summary) ||
    !object.summary.every((entry) => typeof entry === "string")
  ) {
    invalid();
  }
  const summary = object.summary as readonly string[];
  const expectedSummary = buildSummary(state, lifecycle);
  if (
    summary.length !== expectedSummary.length ||
    !expectedSummary.every((entry, index) => entry === summary[index])
  ) {
    invalid();
  }

  const integrity = exactRecord(object.integrity, ["semantics", "statement"]);
  literal(integrity.semantics, "byte_binding_and_recorded_local_evidence_only");
  literal(integrity.statement, CHANGE_HANDOFF_INTEGRITY_STATEMENT);

  const omissions = object.omissions;
  const uncertainty = object.uncertainty;
  if (
    !Array.isArray(omissions) ||
    omissions.length !== CHANGE_HANDOFF_OMISSIONS.length ||
    !CHANGE_HANDOFF_OMISSIONS.every((entry, index) => entry === omissions[index]) ||
    !Array.isArray(uncertainty) ||
    uncertainty.length !== CHANGE_HANDOFF_UNCERTAINTIES.length ||
    !CHANGE_HANDOFF_UNCERTAINTIES.every((entry, index) => entry === uncertainty[index])
  ) {
    invalid();
  }

  return {
    schema: literal(object.schema, CHANGE_HANDOFF_SCHEMA),
    version: literal(object.version, CHANGE_HANDOFF_VERSION),
    identifiers: {
      handoffId,
      runId,
      projectId,
      correlationId: request.correlationId,
      externalTaskRef: request.externalTaskRef,
    },
    run: { state, phase },
    provider: { kind, model, locality, privacyClass },
    lifecycle,
    counts: { changedFiles, verificationChecks },
    artifactReferences: references,
    disclosureClass: literal(object.disclosureClass, CHANGE_HANDOFF_DISCLOSURE_CLASS),
    summary,
    integrity: {
      semantics: "byte_binding_and_recorded_local_evidence_only",
      statement: CHANGE_HANDOFF_INTEGRITY_STATEMENT,
    },
    omissions: CHANGE_HANDOFF_OMISSIONS,
    uncertainty: CHANGE_HANDOFF_UNCERTAINTIES,
  };
}

function strictCanonicalDocument(bytes: Uint8Array, maxBytes: number): unknown {
  const buffer = Buffer.from(bytes);
  if (
    buffer.length < 3 ||
    buffer.length > maxBytes ||
    buffer[buffer.length - 1] !== 0x0a ||
    buffer[buffer.length - 2] === 0x0a ||
    buffer.includes(0) ||
    (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf)
  ) {
    invalid("INVALID_HANDOFF_FILE", "Handoff file framing is invalid");
  }
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      buffer.subarray(0, -1),
    );
  } catch {
    invalid("INVALID_HANDOFF_FILE", "Handoff file is not valid UTF-8");
  }
  try {
    return parseStrictJson(decoded, 8);
  } catch {
    invalid("INVALID_HANDOFF_FILE", "Handoff file is not strict JSON");
  }
}

export function decodeChangeHandoffPayloadBytes(bytes: Uint8Array): ChangeHandoffPayloadV1 {
  const payload = decodePayload(strictCanonicalDocument(bytes, 64 * 1024));
  if (!Buffer.from(bytes).equals(canonicalJsonLine(payload))) {
    invalid("INVALID_HANDOFF_FILE", "Handoff file is not canonical JSON");
  }
  return payload;
}

export function createChangeHandoffExportResult(
  preview: ChangeHandoffPreview,
): ChangeHandoffExportResult {
  return {
    exportStatus: "exported",
    previewSha256: preview.previewSha256,
    outputSchema: CHANGE_HANDOFF_SCHEMA,
    payloadSha256: preview.payloadSha256,
  };
}

export function encodeChangeHandoffExportResult(result: ChangeHandoffExportResult): Buffer {
  return canonicalJsonLine(result);
}

export function decodeChangeHandoffExportResultBytes(bytes: Uint8Array): ChangeHandoffExportResult {
  const object = exactRecord(strictCanonicalDocument(bytes, 2 * 1024), [
    "exportStatus",
    "previewSha256",
    "outputSchema",
    "payloadSha256",
  ]);
  const result: ChangeHandoffExportResult = {
    exportStatus: literal(object.exportStatus, "exported"),
    previewSha256: digestValue(object.previewSha256),
    outputSchema: literal(object.outputSchema, CHANGE_HANDOFF_SCHEMA),
    payloadSha256: digestValue(object.payloadSha256),
  };
  if (!Buffer.from(bytes).equals(canonicalJsonLine(result))) {
    invalid("INVALID_HANDOFF_FILE", "Handoff result file is not canonical JSON");
  }
  return result;
}

export function verifyChangeHandoffDocuments(
  payloadBytes: Uint8Array,
  resultBytes: Uint8Array,
): ChangeHandoffVerification {
  decodeChangeHandoffPayloadBytes(payloadBytes);
  const result = decodeChangeHandoffExportResultBytes(resultBytes);
  const payloadSha256 = sha256(payloadBytes);
  if (result.payloadSha256 !== payloadSha256 || result.previewSha256 === result.payloadSha256) {
    invalid("HANDOFF_DIGEST_MISMATCH", "Handoff result does not bind the payload bytes");
  }
  return {
    schema: CHANGE_HANDOFF_SCHEMA,
    payloadSha256,
    previewSha256: result.previewSha256,
    exportStatus: result.exportStatus,
    consistency: "internally_consistent",
    authenticity: "not_established",
    authorization: "not_established",
    semanticTruth: "not_established",
    disclosurePermission: "not_established",
    executionAuthority: "none",
  };
}

export function inspectChangeHandoffDocuments(
  payloadBytes: Uint8Array,
  resultBytes: Uint8Array,
): ChangeHandoffInspection {
  const verification = verifyChangeHandoffDocuments(payloadBytes, resultBytes);
  const handoff = decodeChangeHandoffPayloadBytes(payloadBytes);
  return { ...verification, handoff };
}

export function assertExpectedChangeHandoffPreview(
  actual: ChangeHandoffPreview,
  expectedPreviewSha256: string,
): void {
  if (!SHA256_PATTERN.test(expectedPreviewSha256)) {
    throw new IcarusError("INVALID_PREVIEW_DIGEST", "Expected preview digest is invalid");
  }
  if (actual.previewSha256 !== expectedPreviewSha256) {
    throw new IcarusError(
      "STALE_HANDOFF_PREVIEW",
      "Handoff source changed after preview; export was refused",
    );
  }
}
