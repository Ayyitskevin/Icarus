export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export const CONTEXT_AUDIT_POLICY_VERSION = "tracked-tree-secret-audit-v1";

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

export type ProviderKind = "ollama" | "openai";
export type ProviderLocality = "loopback" | "remote";

export interface SunCeiling {
  readonly maxToolCalls: number;
  readonly maxActiveRuntimeMs: number;
  readonly maxContextBytes: number;
  readonly maxOutputTokensPerCall: number;
  readonly maxTotalTokens: number;
  readonly maxCostUsd: number;
  readonly maxFilesChanged: 1;
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
  readonly target: string;
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
  readonly target: string;
  readonly repositoryMap: readonly string[];
  readonly entries: readonly ContextManifestEntry[];
  readonly totalBytes: number;
}

export interface PlanProposal {
  readonly summary: string;
  readonly steps: readonly string[];
  readonly risks: readonly string[];
  readonly target: string;
  readonly checkIds: readonly string[];
}

export interface EditProposal {
  readonly path: string;
  readonly expectedPreimageSha256: string;
  readonly findText: string;
  readonly replaceText: string;
  readonly rationale: string;
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
  readonly edit: EditProposal | null;
  readonly cachePath: string | null;
  readonly worktreePath: string | null;
  readonly baselineBase64: string | null;
  readonly approvedBase64: string | null;
  readonly diff: string | null;
  readonly verification: VerificationEvidence | null;
  readonly usage: RunUsage;
  readonly lastError: { readonly code: string; readonly message: string } | null;
  readonly createdAt: string;
  readonly updatedAt: string;
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

export interface ApprovalRecord {
  readonly runId: string;
  readonly kind: "egress" | "plan" | "review" | "rollback" | "restore";
  readonly digest: string;
  readonly actor: string;
  readonly decision: "approve" | "reject";
  readonly createdAt: string;
}

export interface RunHistory {
  readonly run: RunRecord;
  readonly approvals: readonly ApprovalRecord[];
  readonly events: readonly EventRecord[];
}

export interface RunPresentationSnapshot {
  readonly run: RunRecord;
  readonly approvals: readonly ApprovalRecord[];
  readonly events: readonly EventSummaryRecord[];
  readonly eventCursor: number;
  readonly eventCount: number;
  readonly actionEvents: readonly EventSummaryRecord[];
}

export interface OperationToken {
  readonly id: string;
  readonly runId: string;
  readonly kind: string;
  readonly reservedCostUsd: number;
  readonly reservedTokens: number;
  readonly reservedRuntimeMs: number;
}

export interface OperationFinish {
  readonly outcome: "succeeded" | "failed" | "cancelled";
  readonly activeRuntimeMs: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly estimatedCostUsd: number | null;
  readonly detail: JsonValue;
}
