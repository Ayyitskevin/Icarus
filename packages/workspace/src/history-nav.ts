import type { RunEventHistoryPageView, RunView } from "./api.js";

export const HISTORY_PAGE_SIZE = 64;
export const HISTORY_MAX_PAGES = 4;
export const HISTORY_MAX_NEWER_CURSORS = HISTORY_MAX_PAGES - 1;

const HISTORY_PAGE_KEYS = ["runId", "before", "snapshot", "nextBefore", "hasMore", "events"];
const HISTORY_EVENT_KEYS = ["sequence", "type", "label", "evidenceSection", "timestamp"];
const HISTORY_EVENT_TYPE_MAX_BYTES = 128;
const HISTORY_EVENT_TIMESTAMP_MAX_BYTES = 64;
const HISTORY_EVENT_TYPE_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const HISTORY_EVENT_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const HISTORY_EVIDENCE_SECTIONS = new Set([
  "summary",
  "context",
  "plan",
  "action",
  "verification",
  "outputs",
  "approvals",
  "usage",
  "activity",
]);

export type HistoryDirection = "initial" | "older" | "newer";

export interface HistoryRequest {
  readonly runId: string;
  readonly before: number;
  readonly snapshot: number;
  readonly direction: HistoryDirection;
}

export interface HistorySession {
  readonly runId: string;
  readonly snapshot: number;
  readonly initialBefore: number;
  readonly page: RunEventHistoryPageView | null;
  readonly newerBefore: readonly number[];
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && keys.every((key) => actualKeys.includes(key));
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isCanonicalTimestamp(value: string): boolean {
  if (
    utf8Length(value) > HISTORY_EVENT_TIMESTAMP_MAX_BYTES ||
    !HISTORY_EVENT_TIMESTAMP_PATTERN.test(value)
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

export function createHistorySession(
  run: Pick<RunView, "id" | "eventCursor" | "timeline" | "timelineTotal" | "timelineTruncated">,
): HistorySession {
  if (!run.timelineTruncated || run.timeline.length === 0) {
    throw new Error("Older activity is available only when the recent timeline is truncated.");
  }
  if (
    !isPositiveSafeInteger(run.timelineTotal) ||
    !isPositiveSafeInteger(run.eventCursor) ||
    run.timelineTotal !== run.eventCursor ||
    run.timelineTotal <= run.timeline.length
  ) {
    throw new Error("The recent timeline cannot seed a pinned historical snapshot.");
  }

  const initialBefore = run.timeline[0]?.sequence;
  if (initialBefore === undefined || !isPositiveSafeInteger(initialBefore)) {
    throw new Error("The recent timeline has no valid earliest event cursor.");
  }
  let expectedSequence = initialBefore;
  for (const event of run.timeline) {
    if (event.sequence !== expectedSequence) {
      throw new Error("The recent timeline sequence was not contiguous.");
    }
    expectedSequence += 1;
  }
  if (expectedSequence - 1 !== run.eventCursor) {
    throw new Error("The recent timeline does not reach its pinned event revision.");
  }

  return {
    runId: run.id,
    snapshot: run.eventCursor,
    initialBefore,
    page: null,
    newerBefore: [],
  };
}

export function canNavigateOlder(session: HistorySession): boolean {
  return session.page?.hasMore === true && session.newerBefore.length < HISTORY_MAX_NEWER_CURSORS;
}

export function canNavigateNewer(session: HistorySession): boolean {
  return session.page !== null && session.newerBefore.length > 0;
}

export function historyPageDepth(session: HistorySession): number {
  return session.page === null ? 0 : session.newerBefore.length + 1;
}

export function historyRequest(
  session: HistorySession,
  direction: HistoryDirection,
): HistoryRequest {
  let before: number;
  switch (direction) {
    case "initial":
      if (session.page !== null) {
        throw new Error("The initial historical page has already been loaded.");
      }
      before = session.initialBefore;
      break;
    case "older":
      if (!canNavigateOlder(session) || session.page === null) {
        throw new Error("The bounded historical window cannot navigate farther back.");
      }
      before = session.page.nextBefore;
      break;
    case "newer": {
      if (!canNavigateNewer(session)) {
        throw new Error("The historical page has no newer page in this session.");
      }
      const newerBefore = session.newerBefore.at(-1);
      if (newerBefore === undefined) {
        throw new Error("The historical newer-page cursor is missing.");
      }
      before = newerBefore;
      break;
    }
  }
  return {
    runId: session.runId,
    before,
    snapshot: session.snapshot,
    direction,
  };
}

export function validateHistoryPage(
  request: HistoryRequest,
  page: unknown,
): asserts page is RunEventHistoryPageView {
  if (!isExactRecord(page, HISTORY_PAGE_KEYS)) {
    throw new Error("The historical event page shape was invalid.");
  }
  if (
    page.runId !== request.runId ||
    page.before !== request.before ||
    page.snapshot !== request.snapshot
  ) {
    throw new Error("The historical event page did not match its exact request.");
  }
  if (
    !isPositiveSafeInteger(page.before) ||
    !isPositiveSafeInteger(page.snapshot) ||
    page.before > page.snapshot + 1 ||
    !isPositiveSafeInteger(page.nextBefore) ||
    typeof page.hasMore !== "boolean" ||
    !Array.isArray(page.events) ||
    page.events.length > HISTORY_PAGE_SIZE
  ) {
    throw new Error("The historical event page metadata was invalid.");
  }

  for (const event of page.events) {
    if (!isExactRecord(event, HISTORY_EVENT_KEYS)) {
      throw new Error("The historical event metadata shape was invalid.");
    }
    if (
      !isPositiveSafeInteger(event.sequence) ||
      typeof event.type !== "string" ||
      utf8Length(event.type) > HISTORY_EVENT_TYPE_MAX_BYTES ||
      !HISTORY_EVENT_TYPE_PATTERN.test(event.type) ||
      typeof event.label !== "string" ||
      utf8Length(event.label) > HISTORY_EVENT_TYPE_MAX_BYTES ||
      event.label !== event.type.replaceAll(".", " ") ||
      typeof event.timestamp !== "string" ||
      !isCanonicalTimestamp(event.timestamp) ||
      typeof event.evidenceSection !== "string" ||
      !HISTORY_EVIDENCE_SECTIONS.has(event.evidenceSection)
    ) {
      throw new Error("The historical event metadata was invalid.");
    }
  }

  if (page.events.length === 0) {
    if (page.before !== 1 || page.hasMore || page.nextBefore !== page.before) {
      throw new Error("The empty historical event page cursor was inconsistent.");
    }
    return;
  }

  const firstSequence = page.before - page.events.length;
  if (!isPositiveSafeInteger(firstSequence)) {
    throw new Error("The historical event page exceeded its exclusive cursor.");
  }
  for (const [index, event] of page.events.entries()) {
    if (event.sequence !== firstSequence + index) {
      throw new Error("The historical event sequence was not contiguous.");
    }
  }
  if (page.nextBefore !== firstSequence) {
    throw new Error("The historical event page cursor was inconsistent.");
  }
  if (
    (page.hasMore && (page.events.length !== HISTORY_PAGE_SIZE || firstSequence === 1)) ||
    (!page.hasMore && firstSequence !== 1)
  ) {
    throw new Error("The historical event page boundary was inconsistent.");
  }
}

export function acceptHistoryPage(
  session: HistorySession,
  request: HistoryRequest,
  page: unknown,
): HistorySession {
  if (request.runId !== session.runId || request.snapshot !== session.snapshot) {
    throw new Error("The historical request no longer belongs to this run session.");
  }
  const expected = historyRequest(session, request.direction);
  if (expected.before !== request.before) {
    throw new Error("The historical request cursor is stale.");
  }
  validateHistoryPage(request, page);

  let newerBefore = session.newerBefore;
  if (request.direction === "older") {
    if (session.page === null) {
      throw new Error("The current historical page is missing.");
    }
    newerBefore = [...session.newerBefore, session.page.before];
  } else if (request.direction === "newer") {
    newerBefore = session.newerBefore.slice(0, -1);
  }
  if (newerBefore.length > HISTORY_MAX_NEWER_CURSORS) {
    throw new Error("The historical page window exceeded its bounded depth.");
  }
  return { ...session, page, newerBefore };
}
