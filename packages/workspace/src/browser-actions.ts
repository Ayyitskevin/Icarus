import {
  ApiError,
  isExactLandingView,
  type BrowserActionDescriptorView,
  type BrowserActionExecutionView,
  type BrowserActionReceiptView,
  type BrowserActionRequest,
  type PersistedDiffReviewView,
  type PlanAuthorityView,
} from "./api.js";

export const ACTION_RECEIPT_POLL_INTERVAL_MS = 2_000;
export const ACTION_RECEIPT_POLL_MAX_ATTEMPTS = 15;
export const ACTION_RECEIPT_REQUEST_TIMEOUT_MS = 1_000;
export const ACTION_RECEIPT_POLL_MAX_WALL_CLOCK_MS = 30_000;

export interface BrowserActionConfirmation {
  readonly actionId: string;
  readonly descriptor: BrowserActionDescriptorView;
  readonly evidenceIdentity: string;
}

function descriptorIdentity(descriptor: BrowserActionDescriptorView): string {
  return JSON.stringify([
    descriptor.version,
    descriptor.kind,
    descriptor.runId,
    descriptor.expectedState,
    descriptor.eventRevision,
    descriptor.subjectDigest,
    descriptor.activeActionId,
    descriptor.activeActionDigest,
    descriptor.actionDigest,
    descriptor.label,
    descriptor.consequence,
  ]);
}

function evidenceIdentity(
  descriptor: BrowserActionDescriptorView,
  diff: string | null,
  diffReview: PersistedDiffReviewView,
  planAuthority: PlanAuthorityView | null,
): string {
  if (descriptor.kind === "plan.approve") return JSON.stringify(planAuthority);
  if (descriptor.kind === "review.approve" || descriptor.kind === "review.reject") {
    return JSON.stringify([diff, diffReview]);
  }
  return "not-evidence-bound";
}

export function createBrowserActionConfirmation(
  descriptor: BrowserActionDescriptorView,
  diff: string | null,
  diffReview: PersistedDiffReviewView,
  planAuthority: PlanAuthorityView | null,
  randomUuid: () => string = () => globalThis.crypto.randomUUID(),
): BrowserActionConfirmation {
  return {
    actionId: randomUuid(),
    descriptor: { ...descriptor },
    evidenceIdentity: evidenceIdentity(descriptor, diff, diffReview, planAuthority),
  };
}

export function browserActionConfirmationIsCurrent(
  confirmation: BrowserActionConfirmation,
  actions: readonly BrowserActionDescriptorView[],
  diff: string | null,
  diffReview: PersistedDiffReviewView,
  planAuthority: PlanAuthorityView | null,
): boolean {
  const current = actions.find((candidate) => candidate.kind === confirmation.descriptor.kind);
  return (
    current !== undefined &&
    descriptorIdentity(current) === descriptorIdentity(confirmation.descriptor) &&
    evidenceIdentity(current, diff, diffReview, planAuthority) === confirmation.evidenceIdentity
  );
}

export function browserActionRequest(
  confirmation: BrowserActionConfirmation,
): BrowserActionRequest {
  const { descriptor, actionId } = confirmation;
  return {
    actionId,
    version: descriptor.version,
    kind: descriptor.kind,
    runId: descriptor.runId,
    expectedState: descriptor.expectedState,
    eventRevision: descriptor.eventRevision,
    subjectDigest: descriptor.subjectDigest,
    activeActionId: descriptor.activeActionId,
    activeActionDigest: descriptor.activeActionDigest,
    actionDigest: descriptor.actionDigest,
  };
}

export async function sha256DisplayedText(
  text: string,
  subtle: Pick<SubtleCrypto, "digest"> = globalThis.crypto.subtle,
): Promise<string> {
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type ReviewApprovalProof =
  | { readonly status: "not_applicable"; readonly computedDigest: null }
  | { readonly status: "unavailable"; readonly computedDigest: null }
  | { readonly status: "match"; readonly computedDigest: string }
  | { readonly status: "mismatch"; readonly computedDigest: string };

export async function proveDisplayedReviewDiff(
  descriptor: BrowserActionDescriptorView,
  diff: string | null,
  diffReview: PersistedDiffReviewView,
  subtle?: Pick<SubtleCrypto, "digest">,
): Promise<ReviewApprovalProof> {
  if (descriptor.kind !== "review.approve") {
    return { status: "not_applicable", computedDigest: null };
  }
  if (
    diff === null ||
    diffReview.status !== "available" ||
    descriptor.subjectDigest === null ||
    diffReview.sha256 !== descriptor.subjectDigest
  ) {
    return { status: "unavailable", computedDigest: null };
  }
  const computedDigest = await sha256DisplayedText(diff, subtle ?? globalThis.crypto.subtle);
  return {
    status: computedDigest === descriptor.subjectDigest ? "match" : "mismatch",
    computedDigest,
  };
}

export class BrowserActionResponseIdentityError extends Error {
  constructor() {
    super("The action response did not match the submitted immutable identity.");
    this.name = "BrowserActionResponseIdentityError";
  }
}

const RECEIPT_KEYS = ["actionId", "errorCode", "kind", "outcome", "status", "updatedAt"];
const RECEIPT_STATUSES = new Set(["prepared", "admitted", "settled"]);
const RECEIPT_OUTCOMES = new Set([
  "succeeded",
  "refused",
  "failed",
  "cancelled",
  "reconciliation_required",
]);
const ACTION_KINDS = new Set([
  "egress.approve",
  "plan.approve",
  "review.approve",
  "review.reject",
  "rollback.approve",
  "restore.approve",
  "run.resume",
  "run.cancel",
]);
const RUN_PHASES = new Set([
  "draft",
  "planned",
  "awaiting_approval",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
const DIFF_REVIEW_KEYS = [
  "addedLines",
  "browserByteLimit",
  "byteCount",
  "deletedLines",
  "digestProvenance",
  "hunkCount",
  "lineCount",
  "path",
  "sha256",
  "status",
];
const DESCRIPTOR_KEYS = [
  "actionDigest",
  "activeActionDigest",
  "activeActionId",
  "consequence",
  "eventRevision",
  "expectedState",
  "kind",
  "label",
  "runId",
  "subjectDigest",
  "version",
];
const RUN_KEYS = [
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
  "landing",
  "landingRevision",
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

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\n") === keys.join("\n");
}

function isNullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isRecordArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((entry) => record(entry) !== null);
}

function isBrowserActionReceipt(value: unknown): value is BrowserActionReceiptView {
  const receipt = record(value);
  if (receipt === null || !hasExactKeys(receipt, RECEIPT_KEYS)) return false;
  return (
    typeof receipt.actionId === "string" &&
    typeof receipt.kind === "string" &&
    ACTION_KINDS.has(receipt.kind) &&
    typeof receipt.status === "string" &&
    RECEIPT_STATUSES.has(receipt.status) &&
    (receipt.outcome === null ||
      (typeof receipt.outcome === "string" && RECEIPT_OUTCOMES.has(receipt.outcome))) &&
    isNullableString(receipt.errorCode) &&
    typeof receipt.updatedAt === "string"
  );
}

function isBrowserActionDescriptor(value: unknown): boolean {
  const descriptor = record(value);
  if (descriptor === null || !hasExactKeys(descriptor, DESCRIPTOR_KEYS)) return false;
  return (
    descriptor.version === 1 &&
    typeof descriptor.kind === "string" &&
    ACTION_KINDS.has(descriptor.kind) &&
    typeof descriptor.runId === "string" &&
    typeof descriptor.expectedState === "string" &&
    isNonNegativeInteger(descriptor.eventRevision) &&
    isNullableString(descriptor.subjectDigest) &&
    isNullableString(descriptor.activeActionId) &&
    isNullableString(descriptor.activeActionDigest) &&
    typeof descriptor.actionDigest === "string" &&
    typeof descriptor.label === "string" &&
    typeof descriptor.consequence === "string"
  );
}

function isPersistedDiffReview(value: unknown): boolean {
  const review = record(value);
  if (review === null || !hasExactKeys(review, DIFF_REVIEW_KEYS)) return false;
  if (review.browserByteLimit !== 262_144 || typeof review.status !== "string") return false;
  if (review.status === "not_produced") {
    return (
      review.path === null &&
      review.sha256 === null &&
      review.byteCount === 0 &&
      review.lineCount === 0 &&
      review.addedLines === 0 &&
      review.deletedLines === 0 &&
      review.hunkCount === 0 &&
      review.digestProvenance === "not_available"
    );
  }
  if (
    typeof review.path !== "string" ||
    typeof review.sha256 !== "string" ||
    !isNonNegativeInteger(review.byteCount)
  ) {
    return false;
  }
  if (review.status === "available") {
    return (
      isNonNegativeInteger(review.lineCount) &&
      isNonNegativeInteger(review.addedLines) &&
      isNonNegativeInteger(review.deletedLines) &&
      isNonNegativeInteger(review.hunkCount) &&
      review.digestProvenance === "displayed_text_rehash_match"
    );
  }
  return (
    review.status === "outside_browser_bound" &&
    review.lineCount === null &&
    review.addedLines === null &&
    review.deletedLines === null &&
    review.hunkCount === null &&
    review.digestProvenance === "recorded_only"
  );
}

function isRunView(value: unknown, runId: string): value is BrowserActionExecutionView["run"] {
  const run = record(value);
  if (run === null || !hasExactKeys(run, RUN_KEYS)) return false;
  const files = record(run.files);
  const provider = record(run.provider);
  const verification = record(run.verification);
  const approvalCoverage = record(run.approvalCoverage);
  const usage = record(run.usage);
  const timestamps = record(run.timestamps);
  return (
    run.id === runId &&
    isNonNegativeInteger(run.eventCursor) &&
    isNonNegativeInteger(run.landingRevision) &&
    isExactLandingView(run.landing) &&
    (run.landing === null ? run.landingRevision === 0 : run.landingRevision > 0) &&
    isNonNegativeInteger(run.timelineTotal) &&
    typeof run.timelineTruncated === "boolean" &&
    typeof run.phase === "string" &&
    RUN_PHASES.has(run.phase) &&
    typeof run.state === "string" &&
    isNullableString(run.resumeState) &&
    (run.gate === null || record(run.gate) !== null) &&
    typeof run.projectId === "string" &&
    typeof run.task === "string" &&
    typeof run.target === "string" &&
    isNullableString(run.baseCommit) &&
    provider !== null &&
    typeof provider.model === "string" &&
    typeof provider.baseUrl === "string" &&
    (run.context === null || record(run.context) !== null) &&
    (run.plan === null || record(run.plan) !== null) &&
    isNullableString(run.planSha256) &&
    (run.action === null || record(run.action) !== null) &&
    files !== null &&
    hasExactKeys(files, ["changed", "involved"]) &&
    isStringArray(files.involved) &&
    isStringArray(files.changed) &&
    isRecordArray(run.checks) &&
    verification !== null &&
    typeof verification.outcome === "string" &&
    isNullableString(verification.diffSha256) &&
    isNullableString(verification.checkpointSha256) &&
    isNullableString(run.diff) &&
    isPersistedDiffReview(run.diffReview) &&
    isRecordArray(run.outputs) &&
    Array.isArray(run.warnings) &&
    run.warnings.every((warning) => typeof warning === "string" || record(warning) !== null) &&
    isRecordArray(run.approvals) &&
    approvalCoverage !== null &&
    approvalCoverage.limit === 12 &&
    isNonNegativeInteger(approvalCoverage.loaded) &&
    typeof approvalCoverage.earlierApprovalsExcluded === "boolean" &&
    usage !== null &&
    Object.values(usage).every((amount) => typeof amount === "number" && Number.isFinite(amount)) &&
    (run.lastError === null || record(run.lastError) !== null) &&
    isRecordArray(run.timeline) &&
    timestamps !== null &&
    typeof timestamps.createdAt === "string" &&
    typeof timestamps.updatedAt === "string" &&
    Object.values(timestamps).every((timestamp) => typeof timestamp === "string") &&
    typeof run.createdAt === "string" &&
    typeof run.updatedAt === "string" &&
    Array.isArray(run.browserActions) &&
    run.browserActions.every(isBrowserActionDescriptor) &&
    (run.browserActionRecovery === null || isBrowserActionReceipt(run.browserActionRecovery)) &&
    (run.planAuthority === null || record(run.planAuthority) !== null)
  );
}

export function browserActionReceiptMatchesRequest(
  value: unknown,
  request: BrowserActionRequest,
): value is BrowserActionReceiptView {
  return (
    isBrowserActionReceipt(value) &&
    value.actionId === request.actionId &&
    value.kind === request.kind
  );
}

export function browserActionExecutionMatchesRequest(
  value: unknown,
  request: BrowserActionRequest,
): value is BrowserActionExecutionView {
  const execution = record(value);
  return (
    execution !== null &&
    hasExactKeys(execution, ["action", "run"]) &&
    browserActionReceiptMatchesRequest(execution.action, request) &&
    isRunView(execution.run, request.runId)
  );
}

export function browserActionOutcomeIsUncertain(error: unknown): boolean {
  return (
    error instanceof BrowserActionResponseIdentityError ||
    (error instanceof ApiError &&
      (error.code === "API_UNREACHABLE" ||
        error.code === "INVALID_API_RESPONSE" ||
        error.status >= 500))
  );
}

export function browserActionSessionShouldDemote(error: unknown): boolean {
  return error instanceof ApiError && error.code === "API_UNREACHABLE";
}

export function browserActionCanStart(
  descriptor: BrowserActionDescriptorView,
  activeRequests: readonly BrowserActionRequest[],
): boolean {
  if (activeRequests.length === 0) return true;
  if (
    descriptor.kind !== "run.cancel" ||
    descriptor.activeActionId === null ||
    descriptor.activeActionDigest === null
  ) {
    return false;
  }
  return (
    !activeRequests.some((request) => request.kind === "run.cancel") &&
    activeRequests.some(
      (request) =>
        request.kind !== "run.cancel" &&
        request.actionId === descriptor.activeActionId &&
        request.actionDigest === descriptor.activeActionDigest,
    )
  );
}

export function browserActionReceiptPollRemainingMs(
  startedAt: number,
  now: number,
  attempts: number,
): number {
  if (attempts >= ACTION_RECEIPT_POLL_MAX_ATTEMPTS) return 0;
  return Math.max(0, ACTION_RECEIPT_POLL_MAX_WALL_CLOCK_MS - Math.max(0, now - startedAt));
}

export interface BrowserActionReceiptRequestGuard {
  readonly signal: AbortSignal;
  readonly timedOut: () => boolean;
  readonly dispose: () => void;
  readonly abort: () => void;
}

export function createBrowserActionReceiptRequestGuard(
  timeoutMs: number,
): BrowserActionReceiptRequestGuard {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("The action receipt request timed out.", "TimeoutError"));
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => clearTimeout(timer),
    abort: () => {
      clearTimeout(timer);
      controller.abort();
    },
  };
}
