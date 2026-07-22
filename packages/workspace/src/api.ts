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
  readonly planning: CapabilityView;
  readonly provider: CapabilityView;
}

export interface CheckConfiguration {
  readonly id: string;
  readonly name: string;
  readonly argv: readonly string[];
}

export interface RepositoryView {
  readonly id?: string;
  readonly name: string;
  readonly path: string;
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
  readonly sandboxImage?: string;
  readonly sandbox?: { readonly image: string };
  readonly createdAt?: string;
  readonly updatedAt?: string;
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
  readonly checkIds?: readonly string[];
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

export interface RunView {
  readonly id: string;
  readonly eventCursor: number;
  readonly timelineTotal: number;
  readonly timelineTruncated: boolean;
  readonly phase: RunPhase;
  readonly state: string;
  readonly gate: GateView | null;
  readonly projectId: string;
  readonly task: string;
  readonly target: string;
  readonly provider: ProviderView;
  readonly context: ContextMetadataView | null;
  readonly plan: PlanView | null;
  readonly action: ActionView | null;
  readonly files: RunFilesView;
  readonly checks: readonly CheckEvidenceView[];
  readonly verification: VerificationView;
  readonly diff: string | null;
  readonly outputs: readonly OutputView[];
  readonly warnings: readonly (string | WarningView)[];
  readonly approvals: readonly ApprovalView[];
  readonly usage: UsageView;
  readonly lastError: RunErrorView | null;
  readonly timeline: readonly TimelineEntryView[];
  readonly timestamps: RunTimestamps;
}

export interface WorkspaceView {
  readonly capabilities: WorkspaceCapabilities;
  readonly projects: readonly ProjectView[];
  readonly runPage: RunPageView;
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
  readonly target: string;
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

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (init.body !== undefined) {
    headers.set("content-type", "application/json");
  }
  let response: Response;
  try {
    response = await fetch(path, { ...init, headers });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The local API could not be reached.";
    throw new ApiError(0, "API_UNREACHABLE", message);
  }

  const raw = await response.text();
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
    const body = typeof value === "object" && value !== null ? (value as ApiErrorBody) : undefined;
    throw new ApiError(
      response.status,
      body?.error?.code ?? body?.code ?? "API_ERROR",
      body?.error?.message ?? body?.message ?? `The local API returned HTTP ${response.status}.`,
    );
  }
  return value as T;
}

function postJson<T>(path: string, body?: unknown): Promise<T> {
  return requestJson<T>(
    path,
    body === undefined ? { method: "POST" } : { method: "POST", body: JSON.stringify(body) },
  );
}

export function getWorkspace(signal?: AbortSignal): Promise<WorkspaceView> {
  return requestJson<WorkspaceView>("/api/workspace", signal === undefined ? {} : { signal });
}

export function createProject(input: CreateProjectInput): Promise<ProjectView> {
  return postJson<ProjectView>("/api/projects", input);
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
