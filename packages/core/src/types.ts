import type { LandingResumeStateV1, LandingStateV1 } from "./landing-state.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export const CONTEXT_AUDIT_POLICY_VERSION = "tracked-tree-secret-audit-v2";

export type RunState =
  | "preparing"
  | "planned"
  | "awaiting_egress_approval"
  | "awaiting_approval"
  | "running"
  | "verifying"
  | "awaiting_review"
  | "completed"
  | "rolling_back"
  | "cancelling"
  | "failed"
  | "cancelled"
  | "rolled_back"
  | "restoring";

export type ProviderKind = "ollama" | "openai" | "anthropic";
export type ProviderLocality = "loopback" | "remote";

export interface SunCeiling {
  readonly maxToolCalls: number;
  readonly maxActiveRuntimeMs: number;
  readonly maxContextBytes: number;
  readonly maxOutputTokensPerCall: number;
  readonly maxTotalTokens: number;
  readonly maxCostUsd: number;
  readonly maxFilesChanged: number;
  readonly maxFileBytes: number;
  readonly maxDiffBytes: number;
  readonly maxCommandOutputBytes: number;
  readonly maxRawCommandOutputBytes: number;
  readonly providerTimeoutMs: number;
  readonly commandTimeoutMs: number;
}

export interface CheckProfile {
  readonly id: string;
  readonly name: string;
  readonly argv: readonly string[];
}

export interface SandboxProfile {
  readonly image: string;
  readonly cpus: number;
  readonly memoryMb: number;
  readonly pids: number;
  readonly tmpfsMb: number;
}

export interface RepositoryRecord {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly device: number;
  readonly inode: number;
  readonly createdAt: string;
}

export interface ProjectRecord {
  readonly id: string;
  readonly name: string;
  readonly repositoryId: string;
  readonly baseRef: string;
  readonly checks: readonly CheckProfile[];
  readonly sandbox: SandboxProfile;
  readonly ceiling: SunCeiling;
  readonly createdAt: string;
}

export interface WorkspaceProjectEntry {
  readonly project: ProjectRecord;
  readonly repository: RepositoryRecord;
}

export interface WorkspaceProjectPage {
  readonly before: number;
  readonly snapshot: number;
  readonly nextBefore: number;
  readonly hasMore: boolean;
  readonly projects: readonly WorkspaceProjectEntry[];
}

export type RepositoryAvailability = "available" | "missing" | "identity_changed" | "unavailable";

export type RepositoryWorktreeStatus = "clean" | "dirty" | "unknown";

export type RepositoryStatusIssueCode =
  | "DIRTY_REPOSITORY"
  | "REPOSITORY_IDENTITY_CHANGED"
  | "BASE_REF_UNRESOLVED"
  | "BASE_REF_NOT_HEAD"
  | "REPOSITORY_MISSING"
  | "REPOSITORY_UNAVAILABLE";

export interface ProjectRepositoryStatus {
  readonly projectId: string;
  readonly repositoryId: string;
  readonly checkedAt: string;
  readonly availability: RepositoryAvailability;
  readonly worktree: RepositoryWorktreeStatus;
  readonly head: string | null;
  readonly branch: string | null;
  readonly baseRef: string;
  readonly baseCommit: string | null;
  readonly headMatchesBaseRef: boolean | null;
  readonly issue: { readonly code: RepositoryStatusIssueCode } | null;
}

export interface ModelCapabilities {
  readonly contextSize: number | null;
  readonly toolSupport: false;
  readonly visionSupport: false;
  readonly structuredOutputSupport: true;
  readonly streamingSupport: false;
  readonly costClass: "local" | "configured_remote";
  readonly latencyClass: "local" | "remote";
  readonly privacyClass: "local_process" | "remote_api";
  readonly reasoningQuality: "unknown";
  readonly locality: ProviderLocality;
}

export interface ProviderConfig {
  readonly kind: ProviderKind;
  readonly model: string;
  readonly baseUrl: string;
  readonly inputUsdPerMillionTokens: number | null;
  readonly outputUsdPerMillionTokens: number | null;
  readonly capabilities: ModelCapabilities;
}

export interface ContextEntry {
  readonly path: string;
  readonly reason: "repository_map" | "root_rules" | "target_rules" | "seed" | "target";
  readonly bytes: number;
  readonly sha256: string;
  readonly content: string;
}

export interface ContextBundle {
  readonly auditPolicyVersion: typeof CONTEXT_AUDIT_POLICY_VERSION;
  readonly baseCommit: string;
  /** The operator's candidate selection, sorted and deduplicated (ADR 0023). */
  readonly targets: readonly string[];
  readonly repositoryMap: readonly string[];
  readonly entries: readonly ContextEntry[];
  readonly totalBytes: number;
}

export interface ContextManifestEntry {
  readonly path: string;
  readonly reason: ContextEntry["reason"];
  readonly bytes: number;
  readonly sha256: string;
}

export interface ContextManifest {
  readonly auditPolicyVersion: typeof CONTEXT_AUDIT_POLICY_VERSION;
  readonly baseCommit: string;
  /** The operator's candidate selection, sorted and deduplicated (ADR 0023). */
  readonly targets: readonly string[];
  readonly repositoryMap: readonly string[];
  readonly entries: readonly ContextManifestEntry[];
  readonly totalBytes: number;
}

export interface PlanProposal {
  readonly summary: string;
  readonly steps: readonly string[];
  readonly risks: readonly string[];
  readonly target: string;
  /**
   * The exact set of repository-relative paths this run is authorized to
   * change (ADR 0023). Sorted, deduplicated, and always containing `target`.
   * Plan approval binds this set, so it is a maximum authority rather than a
   * prediction: a patch set may change a non-empty subset and may never
   * introduce a path outside it.
   */
  readonly targets: readonly string[];
  /**
   * Iterations this plan requests beyond its first attempt (ADR 0026, which
   * supersedes the ADR 0024 repair grant). One budget, not two: approving the
   * plan is the single operator decision that authorizes the loop, and the
   * approval digest binds the number. Zero preserves single-attempt behavior.
   */
  readonly iterationCeiling: number;
  readonly checkIds: readonly string[];
  /**
   * Capabilities this plan requests (ADR 0026). Itemized, sorted, and covered
   * by the plan approval digest, so approving the plan is the single operator
   * decision that grants them. An empty list is a plan that requests no
   * capability beyond the authority `targets` and `checkIds` already carry.
   */
  readonly grants: readonly CapabilityGrant[];
}

/**
 * The capabilities a grant may name (ADR 0026). Deliberately closed: a
 * capability that is not in this union cannot be requested, approved, or
 * checked, so widening host authority requires editing this type and its ADR
 * rather than passing a new string through from provider output.
 */
export type CapabilityKind = "read.manifest" | "read.checks" | "mutation.patchset" | "exec.check";

/**
 * One itemized capability request. `scope` is interpreted per kind — for
 * `read.manifest` it is the requested read scope, resolved by the host into a
 * `ReadableManifest` before approval. Limits are the grant's own ceilings and
 * never widen a `SunCeiling`; the tighter of the two binds.
 */
export interface CapabilityGrant {
  readonly kind: CapabilityKind;
  readonly scope: readonly string[];
  readonly maxCalls: number;
}

/**
 * One file a `read.manifest` grant admits, pinned by the sha256 of its
 * contents at the run's base commit. The operator approves these entries, so a
 * read may only return bytes whose digest still matches.
 */
export interface ReadableManifestEntry {
  readonly path: string;
  readonly sha256: string;
}

/**
 * The enumerated set of files a `read.manifest` grant admits, resolved against
 * the pinned base commit. Approving the manifest digest is what keeps egress
 * exact under a read tool: every byte a read can return was covered by a digest
 * the operator approved, and the approval names the file it came from.
 *
 * Resolution is bounded rather than truncated — a scope admitting more than
 * `MAX_READABLE_FILES` entries is refused, because a silently shortened
 * manifest would make the model's view differ from the operator's with neither
 * able to tell.
 */
export interface ReadableManifest {
  readonly baseCommit: string;
  readonly entries: readonly ReadableManifestEntry[];
}

/** Retained to decode runs persisted before ADR 0023 (schema v1). */
export interface EditProposal {
  readonly path: string;
  readonly expectedPreimageSha256: string;
  readonly findText: string;
  readonly replaceText: string;
  readonly rationale: string;
}

export type FileEditOperation = "modify" | "create" | "delete";

export interface FileReplacement {
  readonly findText: string;
  readonly replaceText: string;
}

/**
 * One file-scoped operation inside a patch set (ADR 0023). A `modify` carries
 * ordered replacements that must each match exactly once against the content
 * produced by the preceding replacement; a `create` carries complete content;
 * a `delete` carries only its preimage binding.
 */
export type FileEdit =
  | {
      readonly op: "modify";
      readonly path: string;
      readonly expectedPreimageSha256: string;
      readonly replacements: readonly FileReplacement[];
      readonly rationale: string;
    }
  | {
      readonly op: "create";
      readonly path: string;
      readonly content: string;
      readonly rationale: string;
    }
  | {
      readonly op: "delete";
      readonly path: string;
      readonly expectedPreimageSha256: string;
      readonly rationale: string;
    };

export interface PatchSet {
  readonly summary: string;
  readonly edits: readonly FileEdit[];
}

/**
 * One path's baseline and approved bytes inside a tree checkpoint. `baseline`
 * is absent for a created path and `approved` is absent for a deleted path;
 * neither absence is ever inferred as an empty file.
 */
export interface CheckpointFile {
  readonly path: string;
  readonly op: FileEditOperation;
  readonly baselineBase64: string | null;
  readonly approvedBase64: string | null;
}

export interface TreeCheckpoint {
  readonly runId: string;
  readonly sha256: string;
  readonly files: readonly CheckpointFile[];
  readonly createdAt: string;
}

export interface ProviderUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly estimatedCostUsd: number | null;
  readonly latencyMs: number;
}

export interface CheckEvidence {
  readonly checkId: string;
  readonly argv: readonly string[];
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly durationMs: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly outcome: "passed" | "failed" | "unavailable" | "cancelled";
}

export interface VerificationEvidence {
  readonly outcome: "passed" | "failed" | "unavailable";
  readonly checks: readonly CheckEvidence[];
  readonly changedPaths: readonly string[];
  readonly diffSha256: string;
  readonly checkpointSha256: string;
}

export interface RunUsage {
  readonly toolCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly activeRuntimeMs: number;
  readonly estimatedCostUsd: number;
  readonly reservedCostUsd: number;
}

export interface RunRecord {
  readonly id: string;
  readonly projectId: string;
  readonly task: string;
  readonly target: string;
  readonly provider: ProviderConfig;
  readonly state: RunState;
  readonly resumeState: RunState | null;
  readonly baseCommit: string;
  readonly context: ContextManifest;
  readonly contextArtifactPath: string;
  readonly contextSha256: string;
  readonly plan: PlanProposal | null;
  readonly planSha256: string | null;
  /**
   * The proposed change (ADR 0023). Runs persisted before that decision are
   * presented as an equivalent single `modify` edit rather than being rewritten.
   */
  readonly patchSet: PatchSet | null;
  readonly cachePath: string | null;
  readonly worktreePath: string | null;
  /** Legacy single-file checkpoint bytes; null for patch-set runs. */
  readonly baselineBase64: string | null;
  /** Legacy single-file checkpoint bytes; null for patch-set runs. */
  readonly approvedBase64: string | null;
  readonly diff: string | null;
  readonly verification: VerificationEvidence | null;
  readonly usage: RunUsage;
  readonly lastError: { readonly code: string; readonly message: string } | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorkspaceRunSummary {
  readonly id: string;
  readonly projectId: string;
  readonly task: string;
  readonly target: string;
  readonly state: RunState;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorkspaceRunPage {
  readonly before: number;
  readonly snapshot: number;
  readonly nextBefore: number;
  readonly hasMore: boolean;
  readonly runs: readonly WorkspaceRunSummary[];
}

export interface EventRecord {
  readonly sequence: number;
  readonly runId: string;
  readonly type: string;
  readonly payload: JsonValue;
  readonly createdAt: string;
}

export interface EventSummaryRecord {
  readonly sequence: number;
  readonly runId: string;
  readonly type: string;
  readonly createdAt: string;
}

export interface RunEventPage {
  readonly runId: string;
  readonly revision: number;
  readonly nextAfter: number;
  readonly hasMore: boolean;
  readonly events: readonly EventSummaryRecord[];
}

export interface RunEventHistoryPage {
  readonly runId: string;
  readonly before: number;
  readonly snapshot: number;
  readonly nextBefore: number;
  readonly hasMore: boolean;
  readonly events: readonly EventSummaryRecord[];
}

export type VerificationAttemptStartProvenance =
  | "observed_initial_edit"
  | "observed_restore"
  | "observed_resume"
  | "outside_coverage";

export type VerificationAttemptStatus =
  | "passed"
  | "failed"
  | "unavailable"
  | "cancelled"
  | "incomplete_failed"
  | "incomplete_at_snapshot";

export type VerificationAttemptCheckpointProvenance =
  | "recorded_digest_match"
  | "run_checkpoint_available"
  | "not_available";

export interface VerificationAttemptSummary {
  readonly identity: string;
  readonly anchorSequence: number;
  readonly startSequence: number | null;
  readonly startedAt: string | null;
  readonly startProvenance: VerificationAttemptStartProvenance;
  readonly status: VerificationAttemptStatus;
  readonly endSequence: number | null;
  readonly endedAt: string | null;
  readonly diffSha256: string | null;
  readonly checkpointSha256: string | null;
  readonly checkpointProvenance: VerificationAttemptCheckpointProvenance;
  readonly laterAttemptObservedWithinCoverage: boolean;
}

export type VerificationCheckpointSummary =
  | { readonly status: "not_saved" }
  | {
      readonly status: "saved";
      readonly sha256: string;
      readonly createdAt: string;
      readonly saveEvent:
        | {
            readonly status: "observed_in_coverage";
            readonly sequence: number;
            readonly timestamp: string;
          }
        | { readonly status: "not_observed_in_coverage" };
    };

export interface RunVerificationAttemptsSnapshot {
  readonly runId: string;
  readonly snapshot: number;
  readonly coverage: {
    readonly firstSequence: number;
    readonly lastSequence: number;
    readonly eventCount: number;
    readonly eventLimit: 200;
    readonly earlierEventsExcluded: boolean;
  };
  readonly attemptLimit: 8;
  readonly attemptAnchorsTruncatedWithinCoverage: boolean;
  readonly checkpoint: VerificationCheckpointSummary;
  readonly attempts: readonly VerificationAttemptSummary[];
}

export interface ApprovalRecord {
  readonly runId: string;
  readonly kind: "egress" | "plan" | "review" | "rollback" | "restore";
  readonly digest: string;
  readonly actor: string;
  readonly decision: "approve" | "reject";
  readonly createdAt: string;
}

export const CHANGE_ROOM_SCHEMA = "icarus.change-room.v1";
export const CHANGE_CONTEXT_SCHEMA = "icarus.change-context.v1";

export type ChangeRoomCardKind =
  | "task_scope"
  | "base_context"
  | "provider_plan"
  | "plan_approval"
  | "patchset"
  | "registered_checks"
  | "check_outcomes"
  | "review_decision"
  | "checkpoint"
  | "rollback_restoration"
  | "terminal_state";

export type ChangeRoomAnnotationTarget = ChangeRoomCardKind | "room";

export type ChangeRoomProvenanceClass =
  | "operator_assertion"
  | "provider_output"
  | "host_fact"
  | "approval_decision"
  | "verification_evidence"
  | "system_failure";

export type ChangeRoomCardStatus = "available" | "pending" | "not_applicable" | "unavailable";

export type ChangeRoomEvidenceRef =
  | { readonly kind: "event_sequence"; readonly sequence: number }
  | {
      readonly kind: "approval";
      readonly approvalKind: ApprovalRecord["kind"];
      readonly digest: string;
    }
  | { readonly kind: "digest"; readonly label: string; readonly sha256: string }
  | { readonly kind: "checkpoint"; readonly sha256: string };

export interface ChangeRoomCardIndicators {
  readonly truncated: boolean;
  readonly redacted: boolean;
  readonly unavailableEvidence: boolean;
}

interface ChangeRoomCardBase {
  readonly id: string;
  readonly title: string;
  readonly provenanceClass: ChangeRoomProvenanceClass;
  readonly status: ChangeRoomCardStatus;
  readonly refs: readonly ChangeRoomEvidenceRef[];
  readonly indicators: ChangeRoomCardIndicators;
}

export interface TaskScopeCardBody {
  readonly task: string;
  readonly target: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly baseRef: string;
}

export interface BaseContextCardBody {
  readonly baseCommit: string | null;
  readonly contextSha256: string | null;
  readonly targets: readonly string[];
  readonly totalBytes: number | null;
  readonly auditPolicyVersion: string | null;
  readonly repositoryMap: readonly string[];
  readonly entries: readonly ContextManifestEntry[];
  readonly egress: {
    readonly state: "not_required_loopback" | "awaiting_approval" | "approved" | "not_reached";
    readonly approval: {
      readonly actor: string;
      readonly digest: string;
      readonly createdAt: string;
    } | null;
  };
}

export interface ProviderPlanCardBody {
  readonly provider: {
    readonly kind: ProviderKind;
    readonly model: string;
    readonly locality: ProviderLocality;
    readonly privacyClass: ModelCapabilities["privacyClass"];
  };
  readonly trustLabel: "untrusted_proposal";
  readonly plan: PlanProposal | null;
  readonly planSha256: string | null;
}

export interface PlanApprovalCardBody {
  readonly approval: {
    readonly actor: string;
    readonly decision: ApprovalRecord["decision"];
    readonly digest: string;
    readonly createdAt: string;
  } | null;
}

export type PatchsetActionStatus =
  | "not_recorded"
  | "proposed"
  | "materialized"
  | "reverted"
  | "completed"
  | "cancelled"
  | "unknown";

export interface PatchsetEditSummary {
  readonly op: FileEditOperation;
  readonly path: string;
  readonly rationale: string;
  readonly expectedPreimageSha256: string | null;
  readonly replacementCount: number | null;
}

export interface PatchsetCardBody {
  readonly patchSet: {
    readonly summary: string;
    readonly edits: readonly PatchsetEditSummary[];
  } | null;
  readonly patchSetEditsTruncated: boolean;
  readonly actionStatus: PatchsetActionStatus;
  readonly diffSha256: string | null;
  readonly diffBytes: number | null;
  readonly diff: string | null;
  readonly changedPaths: readonly string[];
  readonly note: string;
}

export interface RegisteredChecksCardBody {
  readonly checks: readonly CheckProfile[];
  readonly sandbox: SandboxProfile;
}

export interface CheckOutcomeEntry {
  readonly id: string;
  readonly name: string;
  readonly argv: readonly string[];
  readonly outcome: CheckEvidence["outcome"] | "not_run";
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly durationMs: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
}

export interface CheckOutcomesCardBody {
  readonly outcome: VerificationEvidence["outcome"] | "not_run";
  readonly checks: readonly CheckOutcomeEntry[];
  readonly diffSha256: string | null;
  readonly checkpointSha256: string | null;
}

export interface ReviewDecisionCardBody {
  readonly decision: {
    readonly actor: string;
    readonly decision: ApprovalRecord["decision"];
    readonly digest: string;
    readonly createdAt: string;
  } | null;
}

export interface CheckpointCardBody {
  readonly status: "saved" | "not_saved";
  readonly sha256: string | null;
  readonly createdAt: string | null;
  readonly note: string;
}

export interface RollbackRestorationRecord {
  readonly kind: "rollback" | "restore";
  readonly actor: string;
  readonly decision: ApprovalRecord["decision"];
  readonly digest: string;
  readonly createdAt: string;
  readonly completed: boolean;
  readonly completedSequence: number | null;
}

export interface RollbackRestorationCardBody {
  readonly records: readonly RollbackRestorationRecord[];
  readonly note: string;
}

export interface TerminalStateCardBody {
  readonly state: RunState;
  readonly resumeState: RunState | null;
  readonly terminal: boolean;
  readonly terminalReason: string | null;
  readonly lastError: { readonly code: string; readonly message: string } | null;
  readonly updatedAt: string;
}

export type ChangeRoomCard =
  | (ChangeRoomCardBase & { readonly kind: "task_scope"; readonly body: TaskScopeCardBody })
  | (ChangeRoomCardBase & { readonly kind: "base_context"; readonly body: BaseContextCardBody })
  | (ChangeRoomCardBase & {
      readonly kind: "provider_plan";
      readonly body: ProviderPlanCardBody;
    })
  | (ChangeRoomCardBase & { readonly kind: "plan_approval"; readonly body: PlanApprovalCardBody })
  | (ChangeRoomCardBase & { readonly kind: "patchset"; readonly body: PatchsetCardBody })
  | (ChangeRoomCardBase & {
      readonly kind: "registered_checks";
      readonly body: RegisteredChecksCardBody;
    })
  | (ChangeRoomCardBase & { readonly kind: "check_outcomes"; readonly body: CheckOutcomesCardBody })
  | (ChangeRoomCardBase & {
      readonly kind: "review_decision";
      readonly body: ReviewDecisionCardBody;
    })
  | (ChangeRoomCardBase & { readonly kind: "checkpoint"; readonly body: CheckpointCardBody })
  | (ChangeRoomCardBase & {
      readonly kind: "rollback_restoration";
      readonly body: RollbackRestorationCardBody;
    })
  | (ChangeRoomCardBase & {
      readonly kind: "terminal_state";
      readonly body: TerminalStateCardBody;
    });

export interface RunAnnotationRecord {
  readonly id: string;
  readonly runId: string;
  readonly card: ChangeRoomAnnotationTarget;
  readonly actor: string;
  readonly body: string;
  readonly createdAt: string;
}

export interface ChangeRoomCheckpointSummary {
  readonly sha256: string;
  readonly createdAt: string;
}

export interface ChangeRoomSnapshot {
  readonly run: RunRecord;
  readonly approvals: readonly ApprovalRecord[];
  readonly events: readonly EventSummaryRecord[];
  readonly eventCursor: number;
  readonly eventCount: number;
  readonly checkpoint: ChangeRoomCheckpointSummary | null;
  readonly annotations: readonly RunAnnotationRecord[];
}

export interface ChangeRoomProjection {
  readonly schema: typeof CHANGE_ROOM_SCHEMA;
  readonly roomId: string;
  readonly projectId: string;
  readonly state: RunState;
  readonly cards: readonly ChangeRoomCard[];
  readonly annotations: readonly RunAnnotationRecord[];
  readonly timeline: readonly EventSummaryRecord[];
  readonly integrity: {
    readonly eventCursor: number;
    readonly eventCount: number;
    readonly timelineTruncated: boolean;
    readonly digestSemantics: "byte_binding_only";
    readonly note: string;
  };
  readonly generatedBy: "deterministic_host_projection";
}

export type ChangeRoomVerificationOutcome = VerificationEvidence["outcome"] | "not_run";

export interface ChangeRoomIndexSummary {
  readonly roomId: string;
  readonly projectId: string;
  readonly task: string;
  readonly target: string;
  readonly state: RunState;
  readonly verificationOutcome: ChangeRoomVerificationOutcome;
  readonly provider: {
    readonly kind: ProviderKind;
    readonly model: string;
    readonly locality: ProviderLocality;
    readonly privacyClass: ModelCapabilities["privacyClass"];
  };
  readonly terminalReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ChangeRoomIndexPage {
  readonly before: number;
  readonly snapshot: number;
  readonly nextBefore: number;
  readonly hasMore: boolean;
  readonly rooms: readonly ChangeRoomIndexSummary[];
}

export type ChangeContextQuestion =
  | "why_blocked"
  | "what_changed"
  | "what_passed"
  | "what_remains_before_review"
  | "why_rolled_back";

export interface ChangeContextReceipt {
  readonly cardId: string;
  readonly eventSequences: readonly number[];
  readonly digests: readonly string[];
}

export interface ChangeContextComponent {
  readonly statement: string;
  readonly receipts: readonly ChangeContextReceipt[];
}

export interface ChangeContextPacket {
  readonly schema: typeof CHANGE_CONTEXT_SCHEMA;
  readonly roomId: string;
  readonly eventCursor: number;
  readonly question: ChangeContextQuestion;
  readonly components: readonly ChangeContextComponent[];
  readonly omissions: readonly string[];
  readonly uncertainty: readonly string[];
  readonly generatedBy: "deterministic_host_projection";
}

export interface ApprovalCoverage {
  readonly limit: 12;
  readonly loaded: number;
  readonly earlierApprovalsExcluded: boolean;
}

export interface RunHistory {
  readonly run: RunRecord;
  readonly approvals: readonly ApprovalRecord[];
  readonly events: readonly EventRecord[];
}

/**
 * The operator-facing projection of the immutable landing receipt: metadata,
 * identities, digests, and evidence-derived outcomes only — never credentials,
 * paths, or upstream text. Field-for-field the display-safe LandingReceiptV1.
 */
export interface LandingReceiptPresentationV1 {
  readonly version: 1;
  readonly landingId: string;
  readonly runId: string;
  readonly projectId: string;
  readonly provider: "github";
  readonly owner: string;
  readonly repository: string;
  readonly baseRef: string;
  readonly baseCommitSha1: string;
  readonly headRef: string;
  readonly candidateTreeSha1: string;
  readonly candidateCommitSha1: string;
  readonly pullRequestNumber: number;
  readonly reconstructedPullRequestUrl: string;
  readonly draft: true;
  readonly landingSha256: string;
  readonly profileSha256: string;
  readonly planSha256: string;
  readonly diffSha256: string;
  readonly checkpointSha256: string;
  readonly verificationSha256: string;
  readonly reviewDecisionSha256: string;
  readonly changedPathsSha256: string;
  readonly localRefOutcome: "created" | "reconciled";
  readonly remoteObjectOutcome: "created_or_exact";
  readonly remoteRefOutcome: "created" | "reconciled";
  readonly pullRequestOutcome: "created" | "reconciled";
  readonly completedAt: string;
}

export interface RunLandingPresentation {
  readonly landingId: string;
  readonly state: LandingStateV1;
  readonly resumeState: LandingResumeStateV1 | null;
  readonly version: number;
  readonly landingSha256: string | null;
  readonly candidateCommitSha1: string | null;
  readonly pullRequestTitle: string;
  readonly pullRequestBody: string | null;
  readonly receipt: LandingReceiptPresentationV1 | null;
  readonly derivativeEffects: {
    readonly version: 1;
    readonly disposition: "inert-repository" | "operator-approved";
    readonly evidenceSha256: string;
  };
  readonly decision: {
    readonly actor: string;
    readonly decision: "approve" | "reject";
    readonly createdAt: string;
  } | null;
  readonly errorCode: string | null;
  readonly updatedAt: string;
}

export interface RunPresentationSnapshot {
  readonly run: RunRecord;
  readonly approvals: readonly ApprovalRecord[];
  readonly approvalCoverage: ApprovalCoverage;
  readonly events: readonly EventSummaryRecord[];
  readonly eventCursor: number;
  readonly eventCount: number;
  readonly actionEvents: readonly EventSummaryRecord[];
  readonly landing: RunLandingPresentation | null;
  readonly landingRevision: number;
}

export interface OperationToken {
  readonly id: string;
  readonly runId: string;
  readonly kind: string;
  readonly reservedCostUsd: number;
  readonly reservedTokens: number;
  readonly reservedRuntimeMs: number;
  /**
   * Present only when this operation is the durable domain anchor for one
   * admitted ADR 0029 browser action. It is transport correlation, never
   * operation authority.
   */
  readonly browserActionId: string | null;
}

export interface OperationFinish {
  readonly outcome: "succeeded" | "failed" | "cancelled";
  readonly activeRuntimeMs: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly estimatedCostUsd: number | null;
  readonly detail: JsonValue;
}
