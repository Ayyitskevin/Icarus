import { clearActionSession, getActionSession } from "./action-session.js";

export type RunPhase =
  | "draft"
  | "planned"
  | "awaiting_approval"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type RunStateView =
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

export interface CapabilityView {
  readonly status: string;
  readonly reason: string | null;
}

export interface WorkspaceCapabilities {
  readonly execution: CapabilityView;
  readonly mutation: CapabilityView;
  readonly planning: CapabilityView;
  readonly provider: CapabilityView;
}

export interface CheckConfiguration {
  readonly id: string;
  readonly name: string;
  readonly argv: readonly string[];
}

export interface RepositoryView {
  readonly id: string;
  readonly name: string;
  readonly path: string;
}

export interface ProjectSandboxView {
  readonly image: string;
  readonly cpus: number;
  readonly memoryMb: number;
  readonly pids: number;
  readonly tmpfsMb: number;
}

export interface ProjectCeilingView {
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

export type RepositoryAvailability = "available" | "missing" | "identity_changed" | "unavailable";

export interface RepositoryStatusView {
  readonly projectId: string;
  readonly repositoryId: string;
  readonly checkedAt: string;
  readonly availability: RepositoryAvailability;
  readonly worktree: "clean" | "dirty" | "unknown";
  readonly head: string | null;
  readonly branch: string | null;
  readonly baseRef: string;
  readonly baseCommit: string | null;
  readonly headMatchesBaseRef: boolean | null;
  readonly issue: { readonly code: string; readonly message: string } | null;
}

export interface ProjectView {
  readonly id: string;
  readonly name: string;
  readonly baseRef: string;
  readonly repository: RepositoryView;
  readonly checks: readonly CheckConfiguration[];
  readonly sandbox: ProjectSandboxView;
  readonly ceiling: ProjectCeilingView;
  readonly createdAt: string;
}

export interface ContextEntryView {
  readonly path: string;
  readonly reason: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface ExcludedContextEntryView {
  readonly path?: string;
  readonly reason: string;
  readonly count?: number;
}

export interface ContextMetadataView {
  readonly target: string;
  readonly targets?: readonly string[];
  readonly baseCommit?: string;
  readonly sha256?: string;
  readonly digest?: string;
  readonly repositoryDigest?: string;
  readonly totalBytes: number;
  readonly entries: readonly ContextEntryView[];
  readonly repositoryMap?: readonly string[];
  readonly map?: readonly ContextEntryView[];
  readonly counts?: ContextPreviewCounts;
  readonly excluded?: readonly ExcludedContextEntryView[];
  readonly warnings?: readonly string[];
}

export interface ContextPreviewCounts {
  readonly trackedEntries: number;
  readonly trackedFiles: number;
  readonly includedFiles: number;
  readonly excludedFiles: number;
  readonly excludedPathFiles: number;
  readonly excludedBinaryFiles: number;
  readonly excludedSecretFiles: number;
  readonly submoduleEntries: number;
  readonly omittedMapFiles: number;
  readonly scannedBytes: number;
  readonly includedBytes: number;
}

export interface ProjectContextPreview {
  readonly baseCommit: string;
  readonly target: string;
  readonly digest: string;
  readonly repositoryDigest: string;
  readonly map: readonly ContextEntryView[];
  readonly selected: readonly ContextEntryView[];
  readonly counts: ContextPreviewCounts;
  readonly warnings: readonly string[];
}

type RawContextPreview = ContextMetadataView | ProjectContextPreview;

export type ContextPreviewResponse =
  | RawContextPreview
  | {
      readonly context: RawContextPreview;
      readonly warnings?: readonly string[];
    };

export interface ProviderView {
  readonly kind?: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly locality?: string;
  readonly status?: string;
  readonly reason?: string | null;
}

export interface PlanView {
  readonly summary: string;
  readonly steps: readonly string[];
  readonly risks: readonly string[];
  readonly target?: string;
  readonly targets?: readonly string[];
  readonly checkIds?: readonly string[];
}

export type BrowserActionKind =
  | "egress.approve"
  | "plan.approve"
  | "review.approve"
  | "review.reject"
  | "rollback.approve"
  | "restore.approve"
  | "run.resume"
  | "run.cancel";

export interface BrowserActionDescriptorView {
  readonly version: 1;
  readonly kind: BrowserActionKind;
  readonly runId: string;
  readonly expectedState: RunStateView;
  readonly eventRevision: number;
  readonly subjectDigest: string | null;
  readonly activeActionId: string | null;
  readonly activeActionDigest: string | null;
  readonly actionDigest: string;
  readonly label: string;
  readonly consequence: string;
}

/** The exact ten-key action request body. Actor attribution is host configured. */
export interface BrowserActionRequest {
  readonly actionId: string;
  readonly version: 1;
  readonly kind: BrowserActionKind;
  readonly runId: string;
  readonly expectedState: RunStateView;
  readonly eventRevision: number;
  readonly subjectDigest: string | null;
  readonly activeActionId: string | null;
  readonly activeActionDigest: string | null;
  readonly actionDigest: string;
}

export interface BrowserActionReceiptView {
  readonly actionId: string;
  readonly kind: BrowserActionKind;
  readonly status: "prepared" | "admitted" | "settled";
  readonly outcome:
    | "succeeded"
    | "refused"
    | "failed"
    | "cancelled"
    | "reconciliation_required"
    | null;
  readonly errorCode: string | null;
  readonly updatedAt: string;
}

export interface PlanAuthorityGrantView {
  readonly kind: "read.manifest" | "read.checks" | "mutation.patchset" | "exec.check";
  readonly scope: readonly string[];
  readonly maxCalls: number;
}

export interface PlanAuthorityView {
  readonly planDigest: string;
  readonly targets: readonly string[];
  readonly checkIds: readonly string[];
  readonly grants: readonly PlanAuthorityGrantView[];
  readonly iterationCeiling: number;
  readonly readableManifest: {
    readonly digest: string;
    readonly entries: readonly { readonly path: string; readonly sha256: string }[];
  } | null;
  readonly contextDigest: string;
  readonly baseCommit: string;
  readonly checks: readonly CheckConfiguration[];
  readonly sandbox: ProjectSandboxView;
  readonly provider: {
    readonly kind: string;
    readonly model: string;
    readonly capabilities: {
      readonly contextSize: number | null;
      readonly toolSupport: false;
      readonly visionSupport: false;
      readonly structuredOutputSupport: true;
      readonly streamingSupport: false;
      readonly costClass: "local" | "configured_remote";
      readonly latencyClass: "local" | "remote";
      readonly privacyClass: "local_process" | "remote_api";
      readonly reasoningQuality: "unknown";
      readonly locality: string;
    };
    readonly locality: string;
    readonly baseUrl: string;
    readonly inputUsdPerMillionTokens: number | null;
    readonly outputUsdPerMillionTokens: number | null;
  };
  readonly ceiling: ProjectCeilingView;
  readonly execution: {
    readonly platform: "linux";
    readonly checksRequireSandbox: true;
    readonly consequence: string;
  };
}

export interface GateView {
  readonly kind: string;
  readonly status?: string;
  readonly label?: string;
  readonly digest?: string;
  readonly reason?: string;
}

export interface ActionView {
  readonly kind?: string;
  readonly status: string;
  readonly summary?: string;
  readonly rationale?: string;
  readonly path?: string;
  readonly files?: readonly string[];
  /** Per-path patch-set operations (ADR 0023). */
  readonly operations?: readonly { readonly path: string; readonly op: string }[];
  readonly allowed?: boolean;
}

export interface CheckEvidenceView {
  readonly id?: string;
  readonly checkId?: string;
  readonly name?: string;
  readonly argv?: readonly string[];
  readonly status?: string;
  readonly outcome?: string;
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  readonly durationMs?: number | null;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly output?: string;
  readonly truncated?: boolean;
}

export interface OutputView {
  readonly label?: string;
  readonly stream?: string;
  readonly text: string;
  readonly truncated?: boolean;
}

export interface WarningView {
  readonly code?: string;
  readonly message: string;
}

export interface TimelineEntryView {
  readonly id?: string;
  readonly sequence?: number;
  readonly type?: string;
  readonly phase?: RunPhase;
  readonly state?: string;
  readonly label?: string;
  readonly detail?: string;
  readonly evidenceSection?: string;
  readonly timestamp?: string;
  readonly createdAt?: string;
}

export interface RunEventPageView {
  readonly runId: string;
  readonly revision: number;
  readonly nextAfter: number;
  readonly hasMore: boolean;
  readonly events: readonly TimelineEntryView[];
}

export interface RunEventHistoryPageView {
  readonly runId: string;
  readonly before: number;
  readonly snapshot: number;
  readonly nextBefore: number;
  readonly hasMore: boolean;
  readonly events: readonly TimelineEntryView[];
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

export interface VerificationAttemptView {
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

export interface VerificationAttemptCoverageView {
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly eventCount: number;
  readonly eventLimit: 200;
  readonly earlierEventsExcluded: boolean;
}

export type VerificationAttemptCheckpointView =
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

export interface VerificationAttemptsView {
  readonly runId: string;
  readonly snapshot: number;
  readonly coverage: VerificationAttemptCoverageView;
  readonly attemptLimit: 8;
  readonly attemptAnchorsTruncatedWithinCoverage: boolean;
  readonly checkpoint: VerificationAttemptCheckpointView;
  readonly attempts: readonly VerificationAttemptView[];
}

export interface RunSummaryView {
  readonly id: string;
  readonly projectId: string;
  readonly task: string;
  readonly target: string;
  readonly state: RunStateView;
  readonly phase: RunPhase;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RunPageView {
  readonly before: number;
  readonly snapshot: number;
  readonly nextBefore: number;
  readonly hasMore: boolean;
  readonly runs: readonly RunSummaryView[];
}

export type ChangeRoomVerificationOutcome = "passed" | "failed" | "unavailable" | "not_run";

export type ChangeRoomProviderKind = "ollama" | "openai";

export type ChangeRoomProviderLocality = "loopback" | "remote";

export type ChangeRoomPrivacyClass = "local_process" | "remote_api";

export interface ChangeRoomProviderView {
  readonly kind: ChangeRoomProviderKind;
  readonly model: string;
  readonly locality: ChangeRoomProviderLocality;
  readonly privacyClass: ChangeRoomPrivacyClass;
}

export interface ChangeRoomSummaryView {
  readonly roomId: string;
  readonly projectId: string;
  readonly task: string;
  readonly target: string;
  readonly state: RunStateView;
  readonly phase: RunPhase;
  readonly verificationOutcome: ChangeRoomVerificationOutcome;
  readonly provider: ChangeRoomProviderView;
  readonly terminalReason: string | null;
  readonly createdAt: string;
  readonly lastActivity: string;
}

export interface ChangeRoomPageView {
  readonly before: number;
  readonly snapshot: number;
  readonly nextBefore: number;
  readonly hasMore: boolean;
  readonly rooms: readonly ChangeRoomSummaryView[];
}

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

export type ChangeRoomApprovalKind = "egress" | "plan" | "review" | "rollback" | "restore";

export type ChangeRoomApprovalDecision = "approve" | "reject";

export type ChangeRoomEvidenceRefView =
  | { readonly kind: "event_sequence"; readonly sequence: number }
  | {
      readonly kind: "approval";
      readonly approvalKind: ChangeRoomApprovalKind;
      readonly digest: string;
    }
  | { readonly kind: "digest"; readonly label: string; readonly sha256: string }
  | { readonly kind: "checkpoint"; readonly sha256: string };

export interface ChangeRoomCardIndicatorsView {
  readonly truncated: boolean;
  readonly redacted: boolean;
  readonly unavailableEvidence: boolean;
}

export interface ChangeRoomApprovalView {
  readonly actor: string;
  readonly decision: ChangeRoomApprovalDecision;
  readonly digest: string;
  readonly createdAt: string;
}

export interface TaskScopeCardBodyView {
  readonly task: string;
  readonly target: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly baseRef: string;
}

export type ChangeRoomEgressState =
  | "not_required_loopback"
  | "awaiting_approval"
  | "approved"
  | "not_reached";

export type ChangeRoomContextEntryReason =
  | "repository_map"
  | "root_rules"
  | "target_rules"
  | "seed"
  | "target";

export interface BaseContextCardBodyView {
  readonly baseCommit: string | null;
  readonly contextSha256: string | null;
  readonly targets: readonly string[];
  readonly totalBytes: number | null;
  readonly auditPolicyVersion: string | null;
  readonly repositoryMap: readonly string[];
  readonly entries: readonly {
    readonly path: string;
    readonly reason: ChangeRoomContextEntryReason;
    readonly bytes: number;
    readonly sha256: string;
  }[];
  readonly egress: {
    readonly state: ChangeRoomEgressState;
    readonly approval: {
      readonly actor: string;
      readonly digest: string;
      readonly createdAt: string;
    } | null;
  };
}

export type ChangeRoomCapabilityKind =
  | "read.manifest"
  | "read.checks"
  | "mutation.patchset"
  | "exec.check";

export interface ChangeRoomCapabilityGrantView {
  readonly kind: ChangeRoomCapabilityKind;
  readonly scope: readonly string[];
  readonly maxCalls: number;
}

export interface ProviderPlanCardBodyView {
  readonly provider: ChangeRoomProviderView;
  readonly trustLabel: "untrusted_proposal";
  readonly plan: {
    readonly summary: string;
    readonly steps: readonly string[];
    readonly risks: readonly string[];
    readonly target: string;
    readonly targets: readonly string[];
    readonly iterationCeiling: number;
    readonly checkIds: readonly string[];
    readonly grants: readonly ChangeRoomCapabilityGrantView[];
  } | null;
  readonly planSha256: string | null;
}

export interface PlanApprovalCardBodyView {
  readonly approval: ChangeRoomApprovalView | null;
}

export type PatchsetActionStatusView =
  | "not_recorded"
  | "proposed"
  | "materialized"
  | "reverted"
  | "completed"
  | "cancelled"
  | "unknown";

export type PatchsetEditOperationView = "modify" | "create" | "delete";

export interface PatchsetEditSummaryView {
  readonly op: PatchsetEditOperationView;
  readonly path: string;
  readonly rationale: string;
  readonly expectedPreimageSha256: string | null;
  readonly replacementCount: number | null;
}

export interface PatchsetCardBodyView {
  readonly patchSet: {
    readonly summary: string;
    readonly edits: readonly PatchsetEditSummaryView[];
  } | null;
  readonly patchSetEditsTruncated: boolean;
  readonly actionStatus: PatchsetActionStatusView;
  readonly diffSha256: string | null;
  readonly diffBytes: number | null;
  readonly diff: string | null;
  readonly changedPaths: readonly string[];
  readonly note: string;
}

export interface RegisteredChecksCardBodyView {
  readonly checks: readonly {
    readonly id: string;
    readonly name: string;
    readonly argv: readonly string[];
  }[];
  readonly sandbox: {
    readonly image: string;
    readonly cpus: number;
    readonly memoryMb: number;
    readonly pids: number;
    readonly tmpfsMb: number;
  };
}

export type CheckOutcomeStatusView = "passed" | "failed" | "unavailable" | "cancelled" | "not_run";

export interface CheckOutcomeEntryView {
  readonly id: string;
  readonly name: string;
  readonly argv: readonly string[];
  readonly outcome: CheckOutcomeStatusView;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly durationMs: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
}

export interface CheckOutcomesCardBodyView {
  readonly outcome: ChangeRoomVerificationOutcome;
  readonly checks: readonly CheckOutcomeEntryView[];
  readonly diffSha256: string | null;
  readonly checkpointSha256: string | null;
}

export interface ReviewDecisionCardBodyView {
  readonly decision: ChangeRoomApprovalView | null;
}

export interface CheckpointCardBodyView {
  readonly status: "saved" | "not_saved";
  readonly sha256: string | null;
  readonly createdAt: string | null;
  readonly note: string;
}

export interface RollbackRestorationRecordView {
  readonly kind: "rollback" | "restore";
  readonly actor: string;
  readonly decision: ChangeRoomApprovalDecision;
  readonly digest: string;
  readonly createdAt: string;
  readonly completed: boolean;
  readonly completedSequence: number | null;
}

export interface RollbackRestorationCardBodyView {
  readonly records: readonly RollbackRestorationRecordView[];
  readonly note: string;
}

export interface TerminalStateCardBodyView {
  readonly state: RunStateView;
  readonly resumeState: RunStateView | null;
  readonly terminal: boolean;
  readonly terminalReason: string | null;
  readonly lastError: { readonly code: string; readonly message: string } | null;
  readonly updatedAt: string;
}

interface ChangeRoomCardBaseView {
  readonly id: string;
  readonly title: string;
  readonly provenanceClass: ChangeRoomProvenanceClass;
  readonly status: ChangeRoomCardStatus;
  readonly refs: readonly ChangeRoomEvidenceRefView[];
  readonly indicators: ChangeRoomCardIndicatorsView;
}

export type ChangeRoomCardView =
  | (ChangeRoomCardBaseView & { readonly kind: "task_scope"; readonly body: TaskScopeCardBodyView })
  | (ChangeRoomCardBaseView & {
      readonly kind: "base_context";
      readonly body: BaseContextCardBodyView;
    })
  | (ChangeRoomCardBaseView & {
      readonly kind: "provider_plan";
      readonly body: ProviderPlanCardBodyView;
    })
  | (ChangeRoomCardBaseView & {
      readonly kind: "plan_approval";
      readonly body: PlanApprovalCardBodyView;
    })
  | (ChangeRoomCardBaseView & { readonly kind: "patchset"; readonly body: PatchsetCardBodyView })
  | (ChangeRoomCardBaseView & {
      readonly kind: "registered_checks";
      readonly body: RegisteredChecksCardBodyView;
    })
  | (ChangeRoomCardBaseView & {
      readonly kind: "check_outcomes";
      readonly body: CheckOutcomesCardBodyView;
    })
  | (ChangeRoomCardBaseView & {
      readonly kind: "review_decision";
      readonly body: ReviewDecisionCardBodyView;
    })
  | (ChangeRoomCardBaseView & {
      readonly kind: "checkpoint";
      readonly body: CheckpointCardBodyView;
    })
  | (ChangeRoomCardBaseView & {
      readonly kind: "rollback_restoration";
      readonly body: RollbackRestorationCardBodyView;
    })
  | (ChangeRoomCardBaseView & {
      readonly kind: "terminal_state";
      readonly body: TerminalStateCardBodyView;
    });

export interface ChangeRoomAnnotationView {
  readonly id: string;
  readonly runId: string;
  readonly card: ChangeRoomAnnotationTarget;
  readonly actor: string;
  readonly body: string;
  readonly createdAt: string;
}

export interface ChangeRoomTimelineEntryView {
  readonly sequence: number;
  readonly type: string;
  readonly label: string;
  readonly evidenceSection: string;
  readonly timestamp: string;
  readonly createdAt: string;
}

export interface ChangeRoomIntegrityView {
  readonly eventCursor: number;
  readonly eventCount: number;
  readonly timelineTruncated: boolean;
  readonly digestSemantics: "byte_binding_only";
  readonly note: string;
}

export interface ChangeRoomDetailView {
  readonly schema: "icarus.change-room.v1";
  readonly roomId: string;
  readonly projectId: string;
  readonly state: RunStateView;
  readonly phase: RunPhase;
  readonly cards: readonly ChangeRoomCardView[];
  readonly annotations: readonly ChangeRoomAnnotationView[];
  readonly timeline: readonly ChangeRoomTimelineEntryView[];
  readonly integrity: ChangeRoomIntegrityView;
  readonly generatedBy: "deterministic_host_projection";
}

export type ChangeContextQuestion =
  | "why_blocked"
  | "what_changed"
  | "what_passed"
  | "what_remains_before_review"
  | "why_rolled_back";

export interface ChangeContextReceiptView {
  readonly cardId: string;
  readonly eventSequences: readonly number[];
  readonly digests: readonly string[];
}

export interface ChangeContextComponentView {
  readonly statement: string;
  readonly receipts: readonly ChangeContextReceiptView[];
}

export interface ChangeContextPacketView {
  readonly schema: "icarus.change-context.v1";
  readonly roomId: string;
  readonly eventCursor: number;
  readonly question: ChangeContextQuestion;
  readonly components: readonly ChangeContextComponentView[];
  readonly omissions: readonly string[];
  readonly uncertainty: readonly string[];
  readonly generatedBy: "deterministic_host_projection";
}

export interface RunFilesView {
  readonly involved: readonly string[];
  readonly changed: readonly string[];
}

export interface VerificationView {
  readonly outcome: string;
  readonly diffSha256: string | null;
  readonly checkpointSha256: string | null;
}

export interface ApprovalView {
  readonly kind: string;
  readonly digest: string;
  readonly actor: string;
  readonly decision: string;
  readonly createdAt: string;
}

export interface ApprovalCoverageView {
  readonly limit: 12;
  readonly loaded: number;
  readonly earlierApprovalsExcluded: boolean;
}

export interface UsageView {
  readonly toolCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly activeRuntimeMs: number;
  readonly estimatedCostUsd: number;
  readonly reservedCostUsd: number;
}

export interface RunErrorView {
  readonly code: string;
  readonly message: string;
}

export interface RunTimestamps {
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly [name: string]: string;
}

export type PersistedDiffReviewView =
  | {
      readonly status: "not_produced";
      readonly path: null;
      readonly sha256: null;
      readonly byteCount: 0;
      readonly lineCount: 0;
      readonly addedLines: 0;
      readonly deletedLines: 0;
      readonly hunkCount: 0;
      readonly browserByteLimit: 262_144;
      readonly digestProvenance: "not_available";
    }
  | {
      readonly status: "available";
      readonly path: string;
      readonly sha256: string;
      readonly byteCount: number;
      readonly lineCount: number;
      readonly addedLines: number;
      readonly deletedLines: number;
      readonly hunkCount: number;
      readonly browserByteLimit: 262_144;
      readonly digestProvenance: "displayed_text_rehash_match";
    }
  | {
      readonly status: "outside_browser_bound";
      readonly path: string;
      readonly sha256: string;
      readonly byteCount: number;
      readonly lineCount: null;
      readonly addedLines: null;
      readonly deletedLines: null;
      readonly hunkCount: null;
      readonly browserByteLimit: 262_144;
      readonly digestProvenance: "recorded_only";
    };

export interface RunView {
  readonly id: string;
  readonly eventCursor: number;
  readonly timelineTotal: number;
  readonly timelineTruncated: boolean;
  readonly phase: RunPhase;
  readonly state: string;
  readonly resumeState: RunStateView | null;
  readonly gate: GateView | null;
  readonly projectId: string;
  readonly task: string;
  readonly target: string;
  readonly baseCommit: string | null;
  readonly provider: ProviderView;
  readonly context: ContextMetadataView | null;
  readonly plan: PlanView | null;
  readonly planSha256: string | null;
  readonly action: ActionView | null;
  readonly files: RunFilesView;
  readonly checks: readonly CheckEvidenceView[];
  readonly verification: VerificationView;
  readonly diff: string | null;
  readonly diffReview: PersistedDiffReviewView;
  readonly outputs: readonly OutputView[];
  readonly warnings: readonly (string | WarningView)[];
  readonly approvals: readonly ApprovalView[];
  readonly approvalCoverage: ApprovalCoverageView;
  readonly usage: UsageView;
  readonly lastError: RunErrorView | null;
  readonly timeline: readonly TimelineEntryView[];
  readonly timestamps: RunTimestamps;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly browserActions: readonly BrowserActionDescriptorView[];
  readonly browserActionRecovery: BrowserActionReceiptView | null;
  readonly planAuthority: PlanAuthorityView | null;
}

export interface WorkspaceView {
  readonly capabilities: WorkspaceCapabilities;
  readonly projectPage: ProjectPageView;
  readonly runPage: RunPageView;
}

export interface ProjectPageView {
  readonly before: number;
  readonly snapshot: number;
  readonly nextBefore: number;
  readonly hasMore: boolean;
  readonly projects: readonly ProjectView[];
}

export interface ProjectPageCursor {
  readonly before: number;
  readonly snapshot: number;
}

export interface RunPageCursor {
  readonly before: number;
  readonly snapshot: number;
}

export interface CreateProjectInput {
  readonly repository: {
    readonly name: string;
    readonly path: string;
  };
  readonly project: {
    readonly name: string;
    readonly baseRef: string;
    readonly sandboxImage: string;
    readonly checks: readonly CheckConfiguration[];
  };
}

export interface CreateRunInput {
  readonly projectId: string;
  readonly task: string;
  readonly targets: readonly string[];
  readonly provider: {
    readonly model: string;
    readonly baseUrl: string;
  };
}

interface ApiErrorBody {
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
  };
  readonly code?: string;
  readonly message?: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

const ACTION_SESSION_REQUIRED_MESSAGE =
  "This workspace is review-only until it is opened from a fresh action-session launch URL.";

function actionSessionRequired(): ApiError {
  return new ApiError(401, "ACTION_SESSION_REQUIRED", ACTION_SESSION_REQUIRED_MESSAGE);
}

let pageLifecycleHidden = false;
let pageLifecycleWindow: Window | null = null;

function markPageLifecycleHidden(): void {
  pageLifecycleHidden = true;
}

function markPageLifecycleShown(): void {
  pageLifecycleHidden = false;
}

function trackPageLifecycle(): void {
  if (typeof window === "undefined" || pageLifecycleWindow === window) return;
  pageLifecycleWindow?.removeEventListener("pagehide", markPageLifecycleHidden);
  pageLifecycleWindow?.removeEventListener("pageshow", markPageLifecycleShown);
  pageLifecycleWindow = window;
  pageLifecycleHidden = false;
  pageLifecycleWindow.addEventListener("pagehide", markPageLifecycleHidden);
  pageLifecycleWindow.addEventListener("pageshow", markPageLifecycleShown);
}

function requestTransportError(init: RequestInit, error: unknown): ApiError {
  const signal = init.signal ?? null;
  const reason = signal?.reason as unknown;
  const errorName =
    typeof error === "object" && error !== null && "name" in error ? error.name : undefined;
  const timedOut =
    typeof reason === "object" &&
    reason !== null &&
    "name" in reason &&
    reason.name === "TimeoutError";
  const appOwnedAbort =
    signal !== null && (signal.aborted || errorName === "AbortError" || pageLifecycleHidden);
  if (appOwnedAbort && !timedOut) {
    return new ApiError(0, "REQUEST_ABORTED", "The local API request was cancelled.");
  }
  clearActionSession();
  const message = error instanceof Error ? error.message : "The local API could not be reached.";
  return new ApiError(0, "API_UNREACHABLE", message);
}

async function requestJson<T>(
  path: string,
  init: RequestInit = {},
  protectedAction = "workspace.mutate",
  acceptErrorResponse?: (status: number, value: unknown) => boolean,
): Promise<T> {
  trackPageLifecycle();
  const headers = new Headers(init.headers);
  const method = (init.method ?? "GET").toUpperCase();
  headers.set("accept", "application/json");
  if (method === "POST") {
    const actionSession = getActionSession();
    if (actionSession === null) {
      throw actionSessionRequired();
    }
    headers.set("authorization", `Bearer ${actionSession}`);
    headers.set("x-icarus-action", protectedAction);
    headers.set("content-type", "application/json");
  } else {
    headers.delete("authorization");
    headers.delete("x-icarus-action");
  }
  let response: Response;
  try {
    response = await fetch(path, { ...init, headers });
  } catch (error) {
    throw requestTransportError(init, error);
  }

  let raw: string;
  try {
    raw = await response.text();
  } catch (error) {
    throw requestTransportError(init, error);
  }
  let value: unknown = null;
  if (raw.length > 0) {
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      throw new ApiError(
        response.status,
        "INVALID_API_RESPONSE",
        "The local API returned invalid JSON.",
      );
    }
  }
  if (!response.ok) {
    if (acceptErrorResponse?.(response.status, value) === true) return value as T;
    const body = typeof value === "object" && value !== null ? (value as ApiErrorBody) : undefined;
    const code = body?.error?.code ?? body?.code ?? "API_ERROR";
    if (response.status === 401 && code === "ACTION_SESSION_REQUIRED") {
      clearActionSession();
      throw actionSessionRequired();
    }
    throw new ApiError(
      response.status,
      code,
      body?.error?.message ?? body?.message ?? `The local API returned HTTP ${response.status}.`,
    );
  }
  return value as T;
}

function postJson<T>(
  path: string,
  body?: unknown,
  protectedAction = "workspace.mutate",
  acceptErrorResponse?: (status: number, value: unknown) => boolean,
): Promise<T> {
  return requestJson<T>(
    path,
    body === undefined ? { method: "POST" } : { method: "POST", body: JSON.stringify(body) },
    protectedAction,
    acceptErrorResponse,
  );
}

export function getWorkspace(signal?: AbortSignal): Promise<WorkspaceView> {
  return requestJson<WorkspaceView>("/api/workspace", signal === undefined ? {} : { signal });
}

export function createProject(input: CreateProjectInput): Promise<ProjectView> {
  return postJson<ProjectView>("/api/projects", input);
}

export function getProjectPage(cursor: ProjectPageCursor, signal?: AbortSignal): Promise<unknown> {
  return requestJson<unknown>(
    `/api/projects?before=${encodeURIComponent(String(cursor.before))}&snapshot=${encodeURIComponent(String(cursor.snapshot))}`,
    signal === undefined ? {} : { signal },
  );
}

export function previewProjectContext(
  projectId: string,
  target: string,
): Promise<ContextPreviewResponse> {
  return postJson<ContextPreviewResponse>(
    `/api/projects/${encodeURIComponent(projectId)}/context-preview`,
    { target },
  );
}

export function createRun(input: CreateRunInput): Promise<RunView> {
  return postJson<RunView>("/api/runs", input);
}

export function planRun(runId: string): Promise<RunView> {
  return postJson<RunView>(`/api/runs/${encodeURIComponent(runId)}/plan`, {});
}

export function getRepositoryStatus(
  projectId: string,
  signal?: AbortSignal,
): Promise<RepositoryStatusView> {
  return requestJson<RepositoryStatusView>(
    `/api/projects/${encodeURIComponent(projectId)}/repository-status`,
    signal === undefined ? {} : { signal },
  );
}

export function getRun(runId: string, signal?: AbortSignal): Promise<RunView> {
  return requestJson<RunView>(
    `/api/runs/${encodeURIComponent(runId)}`,
    signal === undefined ? {} : { signal },
  );
}

const ACTION_EXECUTION_KEYS = ["action", "run"];
const ACTION_RECEIPT_KEYS = ["actionId", "errorCode", "kind", "outcome", "status", "updatedAt"];
const ACTION_RUN_KEYS = [
  "action",
  "approvalCoverage",
  "approvals",
  "baseCommit",
  "browserActionRecovery",
  "browserActions",
  "checks",
  "context",
  "createdAt",
  "diff",
  "diffReview",
  "eventCursor",
  "files",
  "gate",
  "id",
  "lastError",
  "outputs",
  "phase",
  "plan",
  "planAuthority",
  "planSha256",
  "projectId",
  "provider",
  "resumeState",
  "state",
  "target",
  "task",
  "timeline",
  "timelineTotal",
  "timelineTruncated",
  "timestamps",
  "updatedAt",
  "usage",
  "verification",
  "warnings",
];

function responseRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function responseHasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\n") === keys.join("\n");
}

function isExactStaleActionExecution(
  status: number,
  value: unknown,
  request: BrowserActionRequest,
): boolean {
  if (status !== 409) return false;
  const execution = responseRecord(value);
  const action = responseRecord(execution?.action);
  const run = responseRecord(execution?.run);
  return (
    execution !== null &&
    responseHasExactKeys(execution, ACTION_EXECUTION_KEYS) &&
    action !== null &&
    responseHasExactKeys(action, ACTION_RECEIPT_KEYS) &&
    action.actionId === request.actionId &&
    action.kind === request.kind &&
    action.status === "settled" &&
    action.outcome === "refused" &&
    action.errorCode === "STALE_ACTION" &&
    typeof action.updatedAt === "string" &&
    run !== null &&
    responseHasExactKeys(run, ACTION_RUN_KEYS) &&
    run.id === request.runId &&
    typeof run.state === "string" &&
    (run.resumeState === null || typeof run.resumeState === "string") &&
    (run.baseCommit === null || typeof run.baseCommit === "string") &&
    (run.planSha256 === null || typeof run.planSha256 === "string") &&
    typeof run.createdAt === "string" &&
    typeof run.updatedAt === "string" &&
    typeof run.eventCursor === "number" &&
    Number.isSafeInteger(run.eventCursor) &&
    Array.isArray(run.browserActions) &&
    "browserActionRecovery" in run &&
    "planAuthority" in run &&
    "diff" in run &&
    responseRecord(run.diffReview) !== null
  );
}

export interface BrowserActionExecutionView {
  readonly action: BrowserActionReceiptView;
  readonly run: RunView;
}

export function executeBrowserAction(
  request: BrowserActionRequest,
): Promise<BrowserActionExecutionView> {
  return postJson<BrowserActionExecutionView>(
    `/api/runs/${encodeURIComponent(request.runId)}/actions`,
    request,
    request.kind,
    (status, value) => isExactStaleActionExecution(status, value, request),
  );
}

export function getBrowserActionReceipt(
  runId: string,
  actionId: string,
  signal?: AbortSignal,
): Promise<BrowserActionReceiptView> {
  return requestJson<BrowserActionReceiptView>(
    `/api/runs/${encodeURIComponent(runId)}/actions/${encodeURIComponent(actionId)}`,
    signal === undefined ? {} : { signal },
  );
}

export function getRunPage(cursor: RunPageCursor, signal?: AbortSignal): Promise<unknown> {
  return requestJson<unknown>(
    `/api/runs?before=${encodeURIComponent(String(cursor.before))}&snapshot=${encodeURIComponent(String(cursor.snapshot))}`,
    signal === undefined ? {} : { signal },
  );
}

export function getRunEvents(
  runId: string,
  after: number,
  signal?: AbortSignal,
): Promise<RunEventPageView> {
  return requestJson<RunEventPageView>(
    `/api/runs/${encodeURIComponent(runId)}/events?after=${encodeURIComponent(String(after))}`,
    signal === undefined ? {} : { signal },
  );
}

export function getRunEventHistory(
  runId: string,
  before: number,
  snapshot: number,
  signal?: AbortSignal,
): Promise<unknown> {
  return requestJson<unknown>(
    `/api/runs/${encodeURIComponent(runId)}/events/history?before=${encodeURIComponent(String(before))}&snapshot=${encodeURIComponent(String(snapshot))}`,
    signal === undefined ? {} : { signal },
  );
}

export function getRunVerificationAttempts(
  runId: string,
  snapshot: number,
  signal?: AbortSignal,
): Promise<unknown> {
  return requestJson<unknown>(
    `/api/runs/${encodeURIComponent(runId)}/verification-attempts?snapshot=${encodeURIComponent(String(snapshot))}`,
    signal === undefined ? {} : { signal },
  );
}

export function getChangeRoomPage(
  cursor: RunPageCursor | null,
  signal?: AbortSignal,
): Promise<unknown> {
  return requestJson<unknown>(
    cursor === null
      ? "/api/change-rooms"
      : `/api/change-rooms?before=${encodeURIComponent(String(cursor.before))}&snapshot=${encodeURIComponent(String(cursor.snapshot))}`,
    signal === undefined ? {} : { signal },
  );
}

export function getChangeRoom(runId: string, signal?: AbortSignal): Promise<unknown> {
  return requestJson<unknown>(
    `/api/runs/${encodeURIComponent(runId)}/change-room`,
    signal === undefined ? {} : { signal },
  );
}

export function getChangeContext(
  runId: string,
  question: ChangeContextQuestion,
  signal?: AbortSignal,
): Promise<unknown> {
  return requestJson<unknown>(
    `/api/runs/${encodeURIComponent(runId)}/change-context?question=${encodeURIComponent(question)}`,
    signal === undefined ? {} : { signal },
  );
}

function normalizeContextPreview(preview: RawContextPreview): ContextMetadataView {
  if ("selected" in preview) {
    const excluded: ExcludedContextEntryView[] = [
      { reason: "path policy", count: preview.counts.excludedPathFiles },
      { reason: "binary content", count: preview.counts.excludedBinaryFiles },
      { reason: "secret policy", count: preview.counts.excludedSecretFiles },
      { reason: "bounded map omission", count: preview.counts.omittedMapFiles },
    ].filter((entry) => (entry.count ?? 0) > 0);
    return {
      target: preview.target,
      baseCommit: preview.baseCommit,
      digest: preview.digest,
      repositoryDigest: preview.repositoryDigest,
      totalBytes: preview.counts.includedBytes,
      entries: preview.selected,
      map: preview.map,
      counts: preview.counts,
      excluded,
      warnings: preview.warnings,
    };
  }
  return preview;
}

export function unwrapContextPreview(response: ContextPreviewResponse): ContextMetadataView {
  if ("context" in response) {
    const normalized = normalizeContextPreview(response.context);
    const warnings = response.warnings ?? normalized.warnings;
    return warnings === undefined ? normalized : { ...normalized, warnings };
  }
  return normalizeContextPreview(response);
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return `${error.code}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}
