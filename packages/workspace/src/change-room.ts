import type {
  ChangeContextPacketView,
  ChangeContextQuestion,
  ChangeRoomAnnotationTarget,
  ChangeRoomApprovalKind,
  ChangeRoomApprovalView,
  ChangeRoomCardKind,
  ChangeRoomCardStatus,
  ChangeRoomDetailView,
  ChangeRoomPageView,
  ChangeRoomProvenanceClass,
  ChangeRoomProviderView,
  ChangeRoomSummaryView,
  RunPhase,
  RunStateView,
} from "./api.js";

export const CHANGE_ROOM_PAGE_SIZE = 12;
export const CHANGE_ROOM_PAGE_MAX_PAGES = 4;
export const CHANGE_ROOM_PAGE_MAX_NEWER_CURSORS = CHANGE_ROOM_PAGE_MAX_PAGES - 1;
export const CHANGE_ROOM_CARD_LIMIT = 11;
export const CHANGE_ROOM_ANNOTATION_LIMIT = 32;
export const CHANGE_ROOM_TIMELINE_LIMIT = 200;
export const CHANGE_CONTEXT_COMPONENT_LIMIT = 8;

export const CHANGE_ROOM_CARD_ORDER: readonly ChangeRoomCardKind[] = [
  "task_scope",
  "base_context",
  "provider_plan",
  "plan_approval",
  "patchset",
  "registered_checks",
  "check_outcomes",
  "review_decision",
  "checkpoint",
  "rollback_restoration",
  "terminal_state",
];

const PAGE_KEYS = ["before", "snapshot", "nextBefore", "hasMore", "rooms"];
const SUMMARY_KEYS = [
  "roomId",
  "projectId",
  "task",
  "target",
  "state",
  "phase",
  "verificationOutcome",
  "provider",
  "terminalReason",
  "createdAt",
  "lastActivity",
];
const PROVIDER_KEYS = ["kind", "model", "locality", "privacyClass"];
const ROOM_KEYS = [
  "schema",
  "roomId",
  "projectId",
  "state",
  "phase",
  "cards",
  "annotations",
  "timeline",
  "integrity",
  "generatedBy",
];
const CARD_KEYS = [
  "id",
  "kind",
  "title",
  "provenanceClass",
  "status",
  "refs",
  "indicators",
  "body",
];
const INDICATOR_KEYS = ["truncated", "redacted", "unavailableEvidence"];
const REF_EVENT_KEYS = ["kind", "sequence"];
const REF_APPROVAL_KEYS = ["kind", "approvalKind", "digest"];
const REF_DIGEST_KEYS = ["kind", "label", "sha256"];
const REF_CHECKPOINT_KEYS = ["kind", "sha256"];
const TASK_SCOPE_BODY_KEYS = ["task", "target", "projectId", "projectName", "baseRef"];
const BASE_CONTEXT_BODY_KEYS = [
  "baseCommit",
  "contextSha256",
  "target",
  "totalBytes",
  "auditPolicyVersion",
  "repositoryMap",
  "entries",
  "egress",
];
const CONTEXT_ENTRY_KEYS = ["path", "reason", "bytes", "sha256"];
const EGRESS_KEYS = ["state", "approval"];
const EGRESS_APPROVAL_KEYS = ["actor", "digest", "createdAt"];
const PROVIDER_PLAN_BODY_KEYS = ["provider", "trustLabel", "plan", "planSha256"];
const PLAN_KEYS = ["summary", "steps", "risks", "target", "checkIds"];
const PLAN_APPROVAL_BODY_KEYS = ["approval"];
const APPROVAL_KEYS = ["actor", "decision", "digest", "createdAt"];
const PATCHSET_BODY_KEYS = [
  "action",
  "actionStatus",
  "diffSha256",
  "diffBytes",
  "diff",
  "changedPaths",
  "note",
];
const PATCHSET_ACTION_KEYS = ["path", "expectedPreimageSha256", "rationale"];
const REGISTERED_CHECKS_BODY_KEYS = ["checks", "sandbox"];
const REGISTERED_CHECK_KEYS = ["id", "name", "argv"];
const SANDBOX_KEYS = ["image", "cpus", "memoryMb", "pids", "tmpfsMb"];
const CHECK_OUTCOMES_BODY_KEYS = ["outcome", "checks", "diffSha256", "checkpointSha256"];
const CHECK_OUTCOME_KEYS = [
  "id",
  "name",
  "argv",
  "outcome",
  "exitCode",
  "signal",
  "durationMs",
  "stdout",
  "stderr",
  "truncated",
];
const REVIEW_DECISION_BODY_KEYS = ["decision"];
const CHECKPOINT_BODY_KEYS = ["status", "sha256", "createdAt", "note"];
const ROLLBACK_BODY_KEYS = ["records", "note"];
const ROLLBACK_RECORD_KEYS = [
  "kind",
  "actor",
  "decision",
  "digest",
  "createdAt",
  "completed",
  "completedSequence",
];
const TERMINAL_STATE_BODY_KEYS = [
  "state",
  "resumeState",
  "terminal",
  "terminalReason",
  "lastError",
  "updatedAt",
];
const LAST_ERROR_KEYS = ["code", "message"];
const ANNOTATION_KEYS = ["id", "runId", "card", "actor", "body", "createdAt"];
const TIMELINE_ENTRY_KEYS = [
  "sequence",
  "type",
  "label",
  "evidenceSection",
  "timestamp",
  "createdAt",
];
const INTEGRITY_KEYS = [
  "eventCursor",
  "eventCount",
  "timelineTruncated",
  "digestSemantics",
  "note",
];
const PACKET_KEYS = [
  "schema",
  "roomId",
  "eventCursor",
  "question",
  "components",
  "omissions",
  "uncertainty",
  "generatedBy",
];
const COMPONENT_KEYS = ["statement", "receipts"];
const RECEIPT_KEYS = ["cardId", "eventSequences", "digests"];

const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,127}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

const TIMESTAMP_MAX_BYTES = 64;
const TASK_MAX_BYTES = 8 * 1024;
const TARGET_MAX_BYTES = 1024;
const MODEL_MAX_BYTES = 256;
const ANNOTATION_BODY_MAX_BYTES = 1024;
const DIFF_MAX_BYTES = 256 * 1024;
const OUTPUT_MAX_BYTES = 256 * 1024;
const NAME_MAX_BYTES = 1024;
const ACTOR_MAX_BYTES = 1024;
const TITLE_MAX_BYTES = 256;
const LABEL_MAX_BYTES = 256;
const EVENT_TEXT_MAX_BYTES = 256;
const AUDIT_POLICY_MAX_BYTES = 256;
const CHECK_ID_MAX_BYTES = 512;
const PLAN_SUMMARY_MAX_BYTES = 4 * 1024;
const PLAN_ITEM_MAX_BYTES = 2 * 1024;
const RATIONALE_MAX_BYTES = 4 * 1024;
const NOTE_MAX_BYTES = 4 * 1024;
const ERROR_MESSAGE_MAX_BYTES = 8 * 1024;
const TERMINAL_REASON_MAX_BYTES = 512;
const STATEMENT_MAX_BYTES = 16 * 1024;
const EXPLAIN_TEXT_MAX_BYTES = 2 * 1024;

const CONTEXT_ENTRY_LIMIT = 4096;
const CHECK_LIMIT = 64;
const CHANGED_PATH_LIMIT = 8;
const RECORD_LIMIT = 64;
const CARD_REFS_LIMIT = 256;
const EXPLAIN_LIST_LIMIT = 32;
const RECEIPT_LIMIT = CHANGE_ROOM_CARD_LIMIT;
const RECEIPT_DIGEST_LIMIT = 8;
const RECEIPT_SEQUENCE_LIMIT = CHANGE_ROOM_TIMELINE_LIMIT;
const SAFE_CURSOR_MAX = Number.MAX_SAFE_INTEGER - 1;

const RUN_PHASES: Readonly<Record<RunStateView, RunPhase>> = {
  preparing: "draft",
  planned: "planned",
  awaiting_egress_approval: "awaiting_approval",
  awaiting_approval: "awaiting_approval",
  running: "running",
  verifying: "running",
  awaiting_review: "awaiting_approval",
  completed: "completed",
  rolling_back: "running",
  cancelling: "running",
  failed: "failed",
  cancelled: "cancelled",
  rolled_back: "cancelled",
  restoring: "running",
};

const VERIFICATION_OUTCOMES = new Set(["passed", "failed", "unavailable", "not_run"]);
const PROVIDER_KINDS = new Set(["ollama", "openai"]);
const PROVIDER_LOCALITIES = new Set(["loopback", "remote"]);
const PRIVACY_CLASSES = new Set(["local_process", "remote_api"]);
const PROVENANCE_CLASSES = new Set<ChangeRoomProvenanceClass>([
  "operator_assertion",
  "provider_output",
  "host_fact",
  "approval_decision",
  "verification_evidence",
  "system_failure",
]);
const CARD_STATUSES = new Set<ChangeRoomCardStatus>([
  "available",
  "pending",
  "not_applicable",
  "unavailable",
]);
const APPROVAL_KINDS = new Set<ChangeRoomApprovalKind>([
  "egress",
  "plan",
  "review",
  "rollback",
  "restore",
]);
const APPROVAL_DECISIONS = new Set(["approve", "reject"]);
const EGRESS_STATES = new Set([
  "not_required_loopback",
  "awaiting_approval",
  "approved",
  "not_reached",
]);
const CONTEXT_ENTRY_REASONS = new Set([
  "repository_map",
  "root_rules",
  "target_rules",
  "seed",
  "target",
]);
const ACTION_STATUSES = new Set([
  "not_recorded",
  "proposed",
  "materialized",
  "reverted",
  "completed",
  "cancelled",
  "unknown",
]);
const CHECK_OUTCOME_STATUSES = new Set(["passed", "failed", "unavailable", "cancelled", "not_run"]);
const RECOVERY_KINDS = new Set(["rollback", "restore"]);
const TERMINAL_STATES = new Set<RunStateView>(["completed", "failed", "cancelled", "rolled_back"]);
const ANNOTATION_TARGETS = new Set<ChangeRoomAnnotationTarget>([...CHANGE_ROOM_CARD_ORDER, "room"]);

export type ChangeRoomPageDirection = "older" | "newer";

export interface ChangeRoomPageRequest {
  readonly before: number;
  readonly snapshot: number;
  readonly direction: ChangeRoomPageDirection;
}

export interface ChangeRoomPageSession {
  readonly snapshot: number;
  readonly initialBefore: number;
  readonly page: ChangeRoomPageView;
  readonly newerBefore: readonly number[];
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return isNonnegativeSafeInteger(value) && value > 0;
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && keys.every((key) => actualKeys.includes(key));
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isBoundedText(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    !value.includes("\0") &&
    utf8Length(value) <= maxBytes
  );
}

function isBoundedRawText(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && !value.includes("\0") && utf8Length(value) <= maxBytes;
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    utf8Length(value) > TIMESTAMP_MAX_BYTES ||
    !TIMESTAMP_PATTERN.test(value)
  ) {
    return false;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  const canonical = new Date(parsed).toISOString();
  return (
    value === canonical ||
    (canonical.endsWith(".000Z") && value === canonical.replace(".000Z", "Z"))
  );
}

function isRunState(value: unknown): value is RunStateView {
  return typeof value === "string" && Object.hasOwn(RUN_PHASES, value);
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && DIGEST_PATTERN.test(value);
}

function isNullableDigest(value: unknown): value is string | null {
  return value === null || isDigest(value);
}

function isNullableBoundedText(value: unknown, maxBytes: number): value is string | null {
  return value === null || isBoundedText(value, maxBytes);
}

function isBoundedStringArray(
  value: unknown,
  limit: number,
  maxBytes: number,
): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= limit &&
    value.every((entry) => isBoundedText(entry, maxBytes))
  );
}

function isActor(value: unknown): value is string {
  return isBoundedText(value, ACTOR_MAX_BYTES) && !/[\r\n]/.test(value);
}

function validateProvider(value: unknown): asserts value is ChangeRoomProviderView {
  if (
    !isExactRecord(value, PROVIDER_KEYS) ||
    typeof value.kind !== "string" ||
    !PROVIDER_KINDS.has(value.kind) ||
    !isBoundedText(value.model, MODEL_MAX_BYTES) ||
    typeof value.locality !== "string" ||
    !PROVIDER_LOCALITIES.has(value.locality) ||
    typeof value.privacyClass !== "string" ||
    !PRIVACY_CLASSES.has(value.privacyClass)
  ) {
    throw new Error("The change room provider metadata was invalid.");
  }
}

function validateApproval(value: unknown): asserts value is ChangeRoomApprovalView {
  if (
    !isExactRecord(value, APPROVAL_KEYS) ||
    !isActor(value.actor) ||
    typeof value.decision !== "string" ||
    !APPROVAL_DECISIONS.has(value.decision) ||
    !isDigest(value.digest) ||
    !isCanonicalTimestamp(value.createdAt)
  ) {
    throw new Error("The change room approval metadata was invalid.");
  }
}

function validateSummary(value: unknown): asserts value is ChangeRoomSummaryView {
  if (!isExactRecord(value, SUMMARY_KEYS)) {
    throw new Error("The change room summary shape was invalid.");
  }
  if (
    typeof value.roomId !== "string" ||
    !UUID_PATTERN.test(value.roomId) ||
    typeof value.projectId !== "string" ||
    !UUID_PATTERN.test(value.projectId) ||
    !isBoundedText(value.task, TASK_MAX_BYTES) ||
    !isBoundedText(value.target, TARGET_MAX_BYTES) ||
    !isRunState(value.state) ||
    value.phase !== RUN_PHASES[value.state] ||
    typeof value.verificationOutcome !== "string" ||
    !VERIFICATION_OUTCOMES.has(value.verificationOutcome) ||
    !isNullableBoundedText(value.terminalReason, TERMINAL_REASON_MAX_BYTES) ||
    !isCanonicalTimestamp(value.createdAt) ||
    !isCanonicalTimestamp(value.lastActivity)
  ) {
    throw new Error("The change room summary metadata was invalid.");
  }
  validateProvider(value.provider);
}

export function validateChangeRoomPage(
  page: unknown,
  expected?: Pick<ChangeRoomPageRequest, "before" | "snapshot">,
): asserts page is ChangeRoomPageView {
  if (!isExactRecord(page, PAGE_KEYS)) {
    throw new Error("The change room page shape was invalid.");
  }
  if (
    (expected !== undefined &&
      (page.before !== expected.before || page.snapshot !== expected.snapshot)) ||
    !isPositiveSafeInteger(page.before) ||
    !isNonnegativeSafeInteger(page.snapshot) ||
    page.snapshot > SAFE_CURSOR_MAX ||
    page.before > page.snapshot + 1 ||
    !isPositiveSafeInteger(page.nextBefore) ||
    typeof page.hasMore !== "boolean" ||
    !Array.isArray(page.rooms) ||
    page.rooms.length > CHANGE_ROOM_PAGE_SIZE
  ) {
    throw new Error("The change room page metadata was invalid.");
  }

  const roomIds = new Set<string>();
  for (const summary of page.rooms) {
    validateSummary(summary);
    if (roomIds.has(summary.roomId)) {
      throw new Error("The change room page repeated a room.");
    }
    roomIds.add(summary.roomId);
  }

  if (page.rooms.length === 0) {
    if (page.before !== 1 || page.snapshot !== 0 || page.nextBefore !== 1 || page.hasMore) {
      throw new Error("The empty change room page cursor was inconsistent.");
    }
    return;
  }

  if (
    page.snapshot === 0 ||
    page.nextBefore >= page.before ||
    page.nextBefore > page.snapshot ||
    (page.hasMore && page.rooms.length !== CHANGE_ROOM_PAGE_SIZE)
  ) {
    throw new Error("The change room page boundary was inconsistent.");
  }
}

export function createChangeRoomPageSession(page: unknown): ChangeRoomPageSession {
  validateChangeRoomPage(page);
  if (page.before !== page.snapshot + 1) {
    throw new Error("The newest change room page did not start a pinned session.");
  }
  return {
    snapshot: page.snapshot,
    initialBefore: page.before,
    page,
    newerBefore: [],
  };
}

export function canNavigateToOlderRooms(session: ChangeRoomPageSession): boolean {
  return session.page.hasMore && session.newerBefore.length < CHANGE_ROOM_PAGE_MAX_NEWER_CURSORS;
}

export function canNavigateToNewerRooms(session: ChangeRoomPageSession): boolean {
  return session.newerBefore.length > 0;
}

export function changeRoomPageDepth(session: ChangeRoomPageSession): number {
  return session.newerBefore.length + 1;
}

export function changeRoomPageRequest(
  session: ChangeRoomPageSession,
  direction: ChangeRoomPageDirection,
): ChangeRoomPageRequest {
  if (direction === "older") {
    if (!canNavigateToOlderRooms(session)) {
      throw new Error("The bounded change room window cannot navigate farther back.");
    }
    return {
      before: session.page.nextBefore,
      snapshot: session.snapshot,
      direction,
    };
  }

  if (!canNavigateToNewerRooms(session)) {
    throw new Error("The change room page has no newer page in this session.");
  }
  const before = session.newerBefore.at(-1);
  if (before === undefined) {
    throw new Error("The change room newer-page cursor is missing.");
  }
  return { before, snapshot: session.snapshot, direction };
}

export function acceptChangeRoomPage(
  session: ChangeRoomPageSession,
  request: ChangeRoomPageRequest,
  page: unknown,
): ChangeRoomPageSession {
  if (request.snapshot !== session.snapshot) {
    throw new Error("The change room request no longer belongs to this page session.");
  }
  const expected = changeRoomPageRequest(session, request.direction);
  if (expected.before !== request.before) {
    throw new Error("The change room request cursor is stale.");
  }
  validateChangeRoomPage(page, request);

  const newerBefore =
    request.direction === "older"
      ? [...session.newerBefore, session.page.before]
      : session.newerBefore.slice(0, -1);
  if (newerBefore.length > CHANGE_ROOM_PAGE_MAX_NEWER_CURSORS) {
    throw new Error("The change room page window exceeded its bounded depth.");
  }
  return { ...session, page, newerBefore };
}

function validateRef(value: unknown, timelineSequences: ReadonlySet<number>): void {
  if (isExactRecord(value, REF_EVENT_KEYS)) {
    if (
      value.kind !== "event_sequence" ||
      !isPositiveSafeInteger(value.sequence) ||
      !timelineSequences.has(value.sequence)
    ) {
      throw new Error("The change room event reference was invalid.");
    }
    return;
  }
  if (isExactRecord(value, REF_APPROVAL_KEYS)) {
    if (
      value.kind !== "approval" ||
      typeof value.approvalKind !== "string" ||
      !APPROVAL_KINDS.has(value.approvalKind as ChangeRoomApprovalKind) ||
      !isDigest(value.digest)
    ) {
      throw new Error("The change room approval reference was invalid.");
    }
    return;
  }
  if (isExactRecord(value, REF_DIGEST_KEYS)) {
    if (
      value.kind !== "digest" ||
      !isBoundedText(value.label, LABEL_MAX_BYTES) ||
      !isDigest(value.sha256)
    ) {
      throw new Error("The change room digest reference was invalid.");
    }
    return;
  }
  if (isExactRecord(value, REF_CHECKPOINT_KEYS)) {
    if (value.kind !== "checkpoint" || !isDigest(value.sha256)) {
      throw new Error("The change room checkpoint reference was invalid.");
    }
    return;
  }
  throw new Error("The change room evidence reference shape was invalid.");
}

function validateTaskScopeBody(value: unknown, projectId: string): void {
  if (
    !isExactRecord(value, TASK_SCOPE_BODY_KEYS) ||
    !isBoundedText(value.task, TASK_MAX_BYTES) ||
    !isBoundedText(value.target, TARGET_MAX_BYTES) ||
    value.projectId !== projectId ||
    !isBoundedText(value.projectName, NAME_MAX_BYTES) ||
    !isBoundedText(value.baseRef, NAME_MAX_BYTES)
  ) {
    throw new Error("The task and scope card body was invalid.");
  }
}

function validateBaseContextBody(value: unknown): void {
  if (!isExactRecord(value, BASE_CONTEXT_BODY_KEYS)) {
    throw new Error("The base and context card body shape was invalid.");
  }
  if (
    !(
      value.baseCommit === null ||
      (typeof value.baseCommit === "string" && COMMIT_PATTERN.test(value.baseCommit))
    ) ||
    !isNullableDigest(value.contextSha256) ||
    !isNullableBoundedText(value.target, TARGET_MAX_BYTES) ||
    !(value.totalBytes === null || isNonnegativeSafeInteger(value.totalBytes)) ||
    !isNullableBoundedText(value.auditPolicyVersion, AUDIT_POLICY_MAX_BYTES) ||
    !isBoundedStringArray(value.repositoryMap, CONTEXT_ENTRY_LIMIT, TARGET_MAX_BYTES) ||
    !Array.isArray(value.entries) ||
    value.entries.length > CONTEXT_ENTRY_LIMIT
  ) {
    throw new Error("The base and context card body metadata was invalid.");
  }
  for (const entry of value.entries) {
    if (
      !isExactRecord(entry, CONTEXT_ENTRY_KEYS) ||
      !isBoundedText(entry.path, TARGET_MAX_BYTES) ||
      typeof entry.reason !== "string" ||
      !CONTEXT_ENTRY_REASONS.has(entry.reason) ||
      !isNonnegativeSafeInteger(entry.bytes) ||
      !isDigest(entry.sha256)
    ) {
      throw new Error("The base and context entry was invalid.");
    }
  }
  if (!isExactRecord(value.egress, EGRESS_KEYS)) {
    throw new Error("The context egress metadata shape was invalid.");
  }
  if (
    typeof value.egress.state !== "string" ||
    !EGRESS_STATES.has(value.egress.state) ||
    !(value.egress.approval === null || isExactRecord(value.egress.approval, EGRESS_APPROVAL_KEYS))
  ) {
    throw new Error("The context egress metadata was invalid.");
  }
  if (value.egress.approval !== null) {
    if (
      !isActor(value.egress.approval.actor) ||
      !isDigest(value.egress.approval.digest) ||
      !isCanonicalTimestamp(value.egress.approval.createdAt)
    ) {
      throw new Error("The context egress approval was invalid.");
    }
  }
  if (value.contextSha256 === null) {
    if (
      value.target !== null ||
      value.totalBytes !== null ||
      value.auditPolicyVersion !== null ||
      value.repositoryMap.length !== 0 ||
      value.entries.length !== 0
    ) {
      throw new Error("The unpinned base and context card body was inconsistent.");
    }
  } else if (
    value.target === null ||
    value.totalBytes === null ||
    value.auditPolicyVersion === null
  ) {
    throw new Error("The pinned base and context card body was inconsistent.");
  }
}

function validateProviderPlanBody(value: unknown): void {
  if (!isExactRecord(value, PROVIDER_PLAN_BODY_KEYS)) {
    throw new Error("The provider plan card body shape was invalid.");
  }
  validateProvider(value.provider);
  if (value.trustLabel !== "untrusted_proposal" || !isNullableDigest(value.planSha256)) {
    throw new Error("The provider plan card body metadata was invalid.");
  }
  if (value.plan === null) {
    if (value.planSha256 !== null) {
      throw new Error("The missing provider plan exposed an unexpected digest.");
    }
    return;
  }
  if (value.planSha256 === null) {
    throw new Error("The recorded provider plan is missing its digest.");
  }
  if (
    !isExactRecord(value.plan, PLAN_KEYS) ||
    !isBoundedText(value.plan.summary, PLAN_SUMMARY_MAX_BYTES) ||
    !Array.isArray(value.plan.steps) ||
    value.plan.steps.length < 1 ||
    value.plan.steps.length > 8 ||
    !value.plan.steps.every((step: unknown) => isBoundedText(step, PLAN_ITEM_MAX_BYTES)) ||
    !Array.isArray(value.plan.risks) ||
    value.plan.risks.length > 6 ||
    !value.plan.risks.every((risk: unknown) => isBoundedText(risk, PLAN_ITEM_MAX_BYTES)) ||
    !isBoundedText(value.plan.target, TARGET_MAX_BYTES) ||
    !Array.isArray(value.plan.checkIds) ||
    value.plan.checkIds.length < 1 ||
    value.plan.checkIds.length > 8 ||
    !value.plan.checkIds.every((checkId: unknown) => isBoundedText(checkId, CHECK_ID_MAX_BYTES))
  ) {
    throw new Error("The provider plan proposal was invalid.");
  }
}

function validatePatchsetBody(value: unknown): void {
  if (!isExactRecord(value, PATCHSET_BODY_KEYS)) {
    throw new Error("The patchset card body shape was invalid.");
  }
  if (
    typeof value.actionStatus !== "string" ||
    !ACTION_STATUSES.has(value.actionStatus) ||
    !isNullableDigest(value.diffSha256) ||
    !(value.diffBytes === null || isNonnegativeSafeInteger(value.diffBytes)) ||
    !(value.diff === null || isBoundedText(value.diff, DIFF_MAX_BYTES)) ||
    !isBoundedStringArray(value.changedPaths, CHANGED_PATH_LIMIT, TARGET_MAX_BYTES) ||
    !isBoundedText(value.note, NOTE_MAX_BYTES)
  ) {
    throw new Error("The patchset card body metadata was invalid.");
  }
  if (value.action === null) {
    if (value.actionStatus !== "not_recorded") {
      throw new Error("The unrecorded patchset action status was inconsistent.");
    }
  } else {
    if (value.actionStatus === "not_recorded") {
      throw new Error("The recorded patchset action status was inconsistent.");
    }
    if (
      !isExactRecord(value.action, PATCHSET_ACTION_KEYS) ||
      !isBoundedText(value.action.path, TARGET_MAX_BYTES) ||
      !isDigest(value.action.expectedPreimageSha256) ||
      !isBoundedText(value.action.rationale, RATIONALE_MAX_BYTES)
    ) {
      throw new Error("The patchset action was invalid.");
    }
  }
  if (value.diff === null) {
    if (value.diffSha256 !== null || value.diffBytes !== null || value.changedPaths.length !== 0) {
      throw new Error("The missing patchset diff exposed unexpected evidence.");
    }
  } else if (value.diffSha256 === null || value.diffBytes !== utf8Length(value.diff as string)) {
    throw new Error("The patchset diff evidence was inconsistent.");
  }
}

function validateRegisteredChecksBody(value: unknown): void {
  if (!isExactRecord(value, REGISTERED_CHECKS_BODY_KEYS)) {
    throw new Error("The registered checks card body shape was invalid.");
  }
  if (!Array.isArray(value.checks) || value.checks.length > CHECK_LIMIT) {
    throw new Error("The registered checks list was invalid.");
  }
  for (const check of value.checks) {
    if (
      !isExactRecord(check, REGISTERED_CHECK_KEYS) ||
      !isBoundedText(check.id, CHECK_ID_MAX_BYTES) ||
      !isBoundedText(check.name, NAME_MAX_BYTES) ||
      !Array.isArray(check.argv) ||
      check.argv.length > CHECK_LIMIT ||
      !check.argv.every((argument: unknown) => isBoundedText(argument, NAME_MAX_BYTES))
    ) {
      throw new Error("A registered check was invalid.");
    }
  }
  if (
    !isExactRecord(value.sandbox, SANDBOX_KEYS) ||
    !isBoundedText(value.sandbox.image, NAME_MAX_BYTES) ||
    !isPositiveSafeInteger(value.sandbox.cpus) ||
    !isPositiveSafeInteger(value.sandbox.memoryMb) ||
    !isPositiveSafeInteger(value.sandbox.pids) ||
    !isNonnegativeSafeInteger(value.sandbox.tmpfsMb)
  ) {
    throw new Error("The registered sandbox profile was invalid.");
  }
}

function validateCheckOutcomesBody(value: unknown): void {
  if (!isExactRecord(value, CHECK_OUTCOMES_BODY_KEYS)) {
    throw new Error("The verification outcomes card body shape was invalid.");
  }
  if (
    typeof value.outcome !== "string" ||
    !VERIFICATION_OUTCOMES.has(value.outcome) ||
    !isNullableDigest(value.diffSha256) ||
    !isNullableDigest(value.checkpointSha256) ||
    !Array.isArray(value.checks) ||
    value.checks.length > CHECK_LIMIT
  ) {
    throw new Error("The verification outcomes card body metadata was invalid.");
  }
  for (const check of value.checks) {
    if (
      !isExactRecord(check, CHECK_OUTCOME_KEYS) ||
      !isBoundedText(check.id, CHECK_ID_MAX_BYTES) ||
      !isBoundedText(check.name, NAME_MAX_BYTES) ||
      !Array.isArray(check.argv) ||
      check.argv.length > CHECK_LIMIT ||
      !check.argv.every((argument: unknown) => isBoundedText(argument, NAME_MAX_BYTES)) ||
      typeof check.outcome !== "string" ||
      !CHECK_OUTCOME_STATUSES.has(check.outcome) ||
      !(check.exitCode === null || Number.isSafeInteger(check.exitCode)) ||
      !(check.signal === null || isBoundedText(check.signal, LABEL_MAX_BYTES)) ||
      !(
        check.durationMs === null ||
        (typeof check.durationMs === "number" &&
          Number.isFinite(check.durationMs) &&
          check.durationMs >= 0)
      ) ||
      !isBoundedRawText(check.stdout, OUTPUT_MAX_BYTES) ||
      !isBoundedRawText(check.stderr, OUTPUT_MAX_BYTES) ||
      typeof check.truncated !== "boolean"
    ) {
      throw new Error("A verification outcome entry was invalid.");
    }
  }
  if ((value.outcome === "not_run") !== (value.diffSha256 === null)) {
    throw new Error("The verification outcome digest state was inconsistent.");
  }
  if ((value.diffSha256 === null) !== (value.checkpointSha256 === null)) {
    throw new Error("The verification checkpoint digest state was inconsistent.");
  }
}

function validateCheckpointBody(value: unknown): void {
  if (
    !isExactRecord(value, CHECKPOINT_BODY_KEYS) ||
    (value.status !== "saved" && value.status !== "not_saved") ||
    !isNullableDigest(value.sha256) ||
    !(value.createdAt === null || isCanonicalTimestamp(value.createdAt)) ||
    !isBoundedText(value.note, NOTE_MAX_BYTES)
  ) {
    throw new Error("The checkpoint card body was invalid.");
  }
  if (value.status === "saved" && (value.sha256 === null || value.createdAt === null)) {
    throw new Error("The saved checkpoint metadata was inconsistent.");
  }
  if (value.status === "not_saved" && (value.sha256 !== null || value.createdAt !== null)) {
    throw new Error("The unsaved checkpoint metadata was inconsistent.");
  }
}

function validateRollbackRestorationBody(
  value: unknown,
  timelineSequences: ReadonlySet<number>,
): void {
  if (
    !isExactRecord(value, ROLLBACK_BODY_KEYS) ||
    !Array.isArray(value.records) ||
    value.records.length > RECORD_LIMIT ||
    !isBoundedText(value.note, NOTE_MAX_BYTES)
  ) {
    throw new Error("The rollback and restoration card body was invalid.");
  }
  for (const record of value.records) {
    if (
      !isExactRecord(record, ROLLBACK_RECORD_KEYS) ||
      typeof record.kind !== "string" ||
      !RECOVERY_KINDS.has(record.kind) ||
      !isActor(record.actor) ||
      typeof record.decision !== "string" ||
      !APPROVAL_DECISIONS.has(record.decision) ||
      !isDigest(record.digest) ||
      !isCanonicalTimestamp(record.createdAt) ||
      typeof record.completed !== "boolean" ||
      !(
        record.completedSequence === null ||
        (isPositiveSafeInteger(record.completedSequence) &&
          timelineSequences.has(record.completedSequence))
      )
    ) {
      throw new Error("A rollback or restoration record was invalid.");
    }
  }
}

function validateTerminalStateBody(value: unknown): void {
  if (!isExactRecord(value, TERMINAL_STATE_BODY_KEYS)) {
    throw new Error("The terminal state card body shape was invalid.");
  }
  if (
    !isRunState(value.state) ||
    !(value.resumeState === null || isRunState(value.resumeState)) ||
    typeof value.terminal !== "boolean" ||
    !isNullableBoundedText(value.terminalReason, TERMINAL_REASON_MAX_BYTES) ||
    !isCanonicalTimestamp(value.updatedAt)
  ) {
    throw new Error("The terminal state card body metadata was invalid.");
  }
  if (value.lastError !== null) {
    if (
      !isExactRecord(value.lastError, LAST_ERROR_KEYS) ||
      typeof value.lastError.code !== "string" ||
      !ERROR_CODE_PATTERN.test(value.lastError.code) ||
      !isBoundedText(value.lastError.message, ERROR_MESSAGE_MAX_BYTES)
    ) {
      throw new Error("The terminal state error metadata was invalid.");
    }
  }
  const state = value.state as RunStateView;
  if (value.terminal !== TERMINAL_STATES.has(state)) {
    throw new Error("The terminal state flag was inconsistent with the run state.");
  }
  if ((value.terminalReason !== null) !== TERMINAL_STATES.has(state)) {
    throw new Error("The terminal reason was inconsistent with the run state.");
  }
}

function validateCard(
  value: unknown,
  expectedKind: ChangeRoomCardKind,
  projectId: string,
  timelineSequences: ReadonlySet<number>,
): void {
  if (!isExactRecord(value, CARD_KEYS)) {
    throw new Error(`The ${expectedKind} card shape was invalid.`);
  }
  if (
    value.kind !== expectedKind ||
    value.id !== `card-${expectedKind.replaceAll("_", "-")}` ||
    !isBoundedText(value.title, TITLE_MAX_BYTES) ||
    typeof value.provenanceClass !== "string" ||
    !PROVENANCE_CLASSES.has(value.provenanceClass as ChangeRoomProvenanceClass) ||
    typeof value.status !== "string" ||
    !CARD_STATUSES.has(value.status as ChangeRoomCardStatus) ||
    !Array.isArray(value.refs) ||
    value.refs.length > CARD_REFS_LIMIT
  ) {
    throw new Error(`The ${expectedKind} card metadata was invalid.`);
  }
  if (
    !isExactRecord(value.indicators, INDICATOR_KEYS) ||
    typeof value.indicators.truncated !== "boolean" ||
    typeof value.indicators.redacted !== "boolean" ||
    typeof value.indicators.unavailableEvidence !== "boolean"
  ) {
    throw new Error(`The ${expectedKind} card indicators were invalid.`);
  }
  for (const ref of value.refs) {
    validateRef(ref, timelineSequences);
  }
  switch (expectedKind) {
    case "task_scope":
      validateTaskScopeBody(value.body, projectId);
      return;
    case "base_context":
      validateBaseContextBody(value.body);
      return;
    case "provider_plan":
      validateProviderPlanBody(value.body);
      return;
    case "plan_approval":
      if (!isExactRecord(value.body, PLAN_APPROVAL_BODY_KEYS)) {
        throw new Error("The plan approval card body shape was invalid.");
      }
      if (value.body.approval !== null) validateApproval(value.body.approval);
      return;
    case "patchset":
      validatePatchsetBody(value.body);
      return;
    case "registered_checks":
      validateRegisteredChecksBody(value.body);
      return;
    case "check_outcomes":
      validateCheckOutcomesBody(value.body);
      return;
    case "review_decision":
      if (!isExactRecord(value.body, REVIEW_DECISION_BODY_KEYS)) {
        throw new Error("The review decision card body shape was invalid.");
      }
      if (value.body.decision !== null) validateApproval(value.body.decision);
      return;
    case "checkpoint":
      validateCheckpointBody(value.body);
      return;
    case "rollback_restoration":
      validateRollbackRestorationBody(value.body, timelineSequences);
      return;
    case "terminal_state":
      validateTerminalStateBody(value.body);
      return;
  }
}

function validateTimelineEntry(value: unknown): void {
  if (
    !isExactRecord(value, TIMELINE_ENTRY_KEYS) ||
    !isPositiveSafeInteger(value.sequence) ||
    !isBoundedText(value.type, EVENT_TEXT_MAX_BYTES) ||
    !isBoundedText(value.label, EVENT_TEXT_MAX_BYTES) ||
    !isBoundedText(value.evidenceSection, EVENT_TEXT_MAX_BYTES) ||
    !isCanonicalTimestamp(value.timestamp) ||
    !isCanonicalTimestamp(value.createdAt)
  ) {
    throw new Error("The change room timeline entry was invalid.");
  }
}

export function validateChangeRoom(
  roomId: string,
  value: unknown,
): asserts value is ChangeRoomDetailView {
  if (!isExactRecord(value, ROOM_KEYS)) {
    throw new Error("The change room shape was invalid.");
  }
  if (
    value.schema !== "icarus.change-room.v1" ||
    value.generatedBy !== "deterministic_host_projection" ||
    !UUID_PATTERN.test(roomId) ||
    value.roomId !== roomId ||
    typeof value.projectId !== "string" ||
    !UUID_PATTERN.test(value.projectId) ||
    !isRunState(value.state) ||
    value.phase !== RUN_PHASES[value.state] ||
    !Array.isArray(value.cards) ||
    value.cards.length !== CHANGE_ROOM_CARD_LIMIT ||
    !Array.isArray(value.annotations) ||
    value.annotations.length > CHANGE_ROOM_ANNOTATION_LIMIT ||
    !Array.isArray(value.timeline) ||
    value.timeline.length > CHANGE_ROOM_TIMELINE_LIMIT ||
    !isExactRecord(value.integrity, INTEGRITY_KEYS)
  ) {
    throw new Error("The change room metadata was invalid.");
  }

  const integrity = value.integrity;
  if (
    !isNonnegativeSafeInteger(integrity.eventCursor) ||
    !isNonnegativeSafeInteger(integrity.eventCount) ||
    integrity.eventCursor > SAFE_CURSOR_MAX ||
    integrity.eventCount !== integrity.eventCursor ||
    typeof integrity.timelineTruncated !== "boolean" ||
    integrity.digestSemantics !== "byte_binding_only" ||
    !isBoundedText(integrity.note, NOTE_MAX_BYTES)
  ) {
    throw new Error("The change room integrity metadata was invalid.");
  }
  if (integrity.timelineTruncated !== value.timeline.length < integrity.eventCount) {
    throw new Error("The change room truncation state was inconsistent.");
  }

  const eventCursor = integrity.eventCursor;
  const firstSequence = eventCursor - value.timeline.length + 1;
  if (value.timeline.length === 0 ? eventCursor !== 0 : firstSequence < 1) {
    throw new Error("The change room timeline suffix was inconsistent.");
  }
  const timelineSequences = new Set<number>();
  for (const [index, entry] of value.timeline.entries()) {
    validateTimelineEntry(entry);
    if (entry.sequence !== firstSequence + index) {
      throw new Error("The change room timeline was not a contiguous suffix of events.");
    }
    timelineSequences.add(entry.sequence);
  }

  const projectId = value.projectId;
  for (const [index, card] of value.cards.entries()) {
    const expectedKind = CHANGE_ROOM_CARD_ORDER[index];
    if (expectedKind === undefined) {
      throw new Error("The change room card order was invalid.");
    }
    validateCard(card, expectedKind, projectId, timelineSequences);
  }

  for (const annotation of value.annotations) {
    if (
      !isExactRecord(annotation, ANNOTATION_KEYS) ||
      typeof annotation.id !== "string" ||
      !UUID_PATTERN.test(annotation.id) ||
      annotation.runId !== roomId ||
      typeof annotation.card !== "string" ||
      !ANNOTATION_TARGETS.has(annotation.card as ChangeRoomAnnotationTarget) ||
      !isActor(annotation.actor) ||
      !isBoundedText(annotation.body, ANNOTATION_BODY_MAX_BYTES) ||
      !isCanonicalTimestamp(annotation.createdAt)
    ) {
      throw new Error("A change room annotation was invalid.");
    }
  }
}

export function acceptChangeRoom(roomId: string, value: unknown): ChangeRoomDetailView {
  validateChangeRoom(roomId, value);
  return value;
}

export function validateChangeContextPacket(
  room: ChangeRoomDetailView,
  question: ChangeContextQuestion,
  value: unknown,
): asserts value is ChangeContextPacketView {
  if (!isExactRecord(value, PACKET_KEYS)) {
    throw new Error("The change-context packet shape was invalid.");
  }
  if (
    value.schema !== "icarus.change-context.v1" ||
    value.generatedBy !== "deterministic_host_projection" ||
    value.roomId !== room.roomId ||
    value.eventCursor !== room.integrity.eventCursor ||
    value.question !== question ||
    !Array.isArray(value.components) ||
    value.components.length > CHANGE_CONTEXT_COMPONENT_LIMIT ||
    !Array.isArray(value.omissions) ||
    value.omissions.length > EXPLAIN_LIST_LIMIT ||
    !Array.isArray(value.uncertainty) ||
    value.uncertainty.length > EXPLAIN_LIST_LIMIT
  ) {
    throw new Error("The change-context packet metadata was invalid.");
  }

  const cardIds = new Set(room.cards.map((card) => card.id));
  const timelineSequences = new Set(room.timeline.map((entry) => entry.sequence));
  for (const component of value.components) {
    if (
      !isExactRecord(component, COMPONENT_KEYS) ||
      !isBoundedText(component.statement, STATEMENT_MAX_BYTES) ||
      !Array.isArray(component.receipts) ||
      component.receipts.length > RECEIPT_LIMIT
    ) {
      throw new Error("A change-context component was invalid.");
    }
    for (const receipt of component.receipts) {
      if (
        !isExactRecord(receipt, RECEIPT_KEYS) ||
        typeof receipt.cardId !== "string" ||
        !cardIds.has(receipt.cardId) ||
        !Array.isArray(receipt.eventSequences) ||
        receipt.eventSequences.length > RECEIPT_SEQUENCE_LIMIT ||
        !receipt.eventSequences.every(
          (sequence: unknown) => isPositiveSafeInteger(sequence) && timelineSequences.has(sequence),
        ) ||
        !Array.isArray(receipt.digests) ||
        receipt.digests.length > RECEIPT_DIGEST_LIMIT ||
        !receipt.digests.every((digest: unknown) => isDigest(digest))
      ) {
        throw new Error("A change-context receipt was invalid.");
      }
    }
  }
  for (const list of [value.omissions, value.uncertainty]) {
    if (!list.every((entry: unknown) => isBoundedText(entry, EXPLAIN_TEXT_MAX_BYTES))) {
      throw new Error("The change-context omissions or uncertainty text was invalid.");
    }
  }
}

export function acceptChangeContextPacket(
  room: ChangeRoomDetailView,
  question: ChangeContextQuestion,
  value: unknown,
): ChangeContextPacketView {
  validateChangeContextPacket(room, question, value);
  return value;
}
