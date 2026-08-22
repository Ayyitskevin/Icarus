import type { RunPageView, RunPhase, RunStateView, RunSummaryView } from "./api.js";

export const RUN_PAGE_SIZE = 12;
export const RUN_PAGE_MAX_PAGES = 4;
export const RUN_PAGE_MAX_NEWER_CURSORS = RUN_PAGE_MAX_PAGES - 1;

const RUN_PAGE_KEYS = ["before", "snapshot", "nextBefore", "hasMore", "runs"];
const RUN_SUMMARY_KEYS = [
  "id",
  "projectId",
  "task",
  "target",
  "state",
  "phase",
  "createdAt",
  "updatedAt",
];
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const TIMESTAMP_MAX_BYTES = 64;
const TASK_MAX_BYTES = 8 * 1024;
const TARGET_MAX_BYTES = 1024;

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

export type RunPageDirection = "older" | "newer";

export interface RunPageRequest {
  readonly before: number;
  readonly snapshot: number;
  readonly direction: RunPageDirection;
}

export interface RunPageSession {
  readonly snapshot: number;
  readonly initialBefore: number;
  readonly page: RunPageView;
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

function validateSummary(value: unknown): asserts value is RunSummaryView {
  if (!isExactRecord(value, RUN_SUMMARY_KEYS)) {
    throw new Error("The workspace run summary shape was invalid.");
  }
  if (
    typeof value.id !== "string" ||
    !UUID_PATTERN.test(value.id) ||
    typeof value.projectId !== "string" ||
    !UUID_PATTERN.test(value.projectId) ||
    !isBoundedText(value.task, TASK_MAX_BYTES) ||
    !isBoundedText(value.target, TARGET_MAX_BYTES) ||
    !isRunState(value.state) ||
    value.phase !== RUN_PHASES[value.state] ||
    !isCanonicalTimestamp(value.createdAt) ||
    !isCanonicalTimestamp(value.updatedAt)
  ) {
    throw new Error("The workspace run summary metadata was invalid.");
  }
}

export function validateRunPage(
  page: unknown,
  expected?: Pick<RunPageRequest, "before" | "snapshot">,
): asserts page is RunPageView {
  if (!isExactRecord(page, RUN_PAGE_KEYS)) {
    throw new Error("The workspace run page shape was invalid.");
  }
  if (
    (expected !== undefined &&
      (page.before !== expected.before || page.snapshot !== expected.snapshot)) ||
    !isPositiveSafeInteger(page.before) ||
    !isNonnegativeSafeInteger(page.snapshot) ||
    page.snapshot > Number.MAX_SAFE_INTEGER - 1 ||
    page.before > page.snapshot + 1 ||
    !isPositiveSafeInteger(page.nextBefore) ||
    typeof page.hasMore !== "boolean" ||
    !Array.isArray(page.runs) ||
    page.runs.length > RUN_PAGE_SIZE
  ) {
    throw new Error("The workspace run page metadata was invalid.");
  }

  const runIds = new Set<string>();
  for (const summary of page.runs) {
    validateSummary(summary);
    if (runIds.has(summary.id)) {
      throw new Error("The workspace run page repeated a run.");
    }
    runIds.add(summary.id);
  }

  if (page.runs.length === 0) {
    if (page.before !== 1 || page.snapshot !== 0 || page.nextBefore !== 1 || page.hasMore) {
      throw new Error("The empty workspace run page cursor was inconsistent.");
    }
    return;
  }

  if (
    page.snapshot === 0 ||
    page.nextBefore >= page.before ||
    page.nextBefore > page.snapshot ||
    (page.hasMore && page.runs.length !== RUN_PAGE_SIZE)
  ) {
    throw new Error("The workspace run page boundary was inconsistent.");
  }
}

export function createRunPageSession(page: unknown): RunPageSession {
  validateRunPage(page);
  if (page.before !== page.snapshot + 1) {
    throw new Error("The newest workspace run page did not start a pinned session.");
  }
  return {
    snapshot: page.snapshot,
    initialBefore: page.before,
    page,
    newerBefore: [],
  };
}

export function canNavigateToOlderRuns(session: RunPageSession): boolean {
  return session.page.hasMore && session.newerBefore.length < RUN_PAGE_MAX_NEWER_CURSORS;
}

export function canNavigateToNewerRuns(session: RunPageSession): boolean {
  return session.newerBefore.length > 0;
}

export function runPageDepth(session: RunPageSession): number {
  return session.newerBefore.length + 1;
}

export function runPageRequest(
  session: RunPageSession,
  direction: RunPageDirection,
): RunPageRequest {
  if (direction === "older") {
    if (!canNavigateToOlderRuns(session)) {
      throw new Error("The bounded workspace run window cannot navigate farther back.");
    }
    return {
      before: session.page.nextBefore,
      snapshot: session.snapshot,
      direction,
    };
  }

  if (!canNavigateToNewerRuns(session)) {
    throw new Error("The workspace run page has no newer page in this session.");
  }
  const before = session.newerBefore.at(-1);
  if (before === undefined) {
    throw new Error("The workspace newer-page cursor is missing.");
  }
  return { before, snapshot: session.snapshot, direction };
}

export function acceptRunPage(
  session: RunPageSession,
  request: RunPageRequest,
  page: unknown,
): RunPageSession {
  if (request.snapshot !== session.snapshot) {
    throw new Error("The workspace run request no longer belongs to this page session.");
  }
  const expected = runPageRequest(session, request.direction);
  if (expected.before !== request.before) {
    throw new Error("The workspace run request cursor is stale.");
  }
  validateRunPage(page, request);

  const newerBefore =
    request.direction === "older"
      ? [...session.newerBefore, session.page.before]
      : session.newerBefore.slice(0, -1);
  if (newerBefore.length > RUN_PAGE_MAX_NEWER_CURSORS) {
    throw new Error("The workspace run page window exceeded its bounded depth.");
  }
  return { ...session, page, newerBefore };
}
