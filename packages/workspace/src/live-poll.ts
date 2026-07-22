import type { RunEventPageView, TimelineEntryView } from "./api.js";

const EVENT_POLL_INTERVAL_MS = 2_000;
const EVENT_POLL_MAX_BACKOFF_MS = 15_000;

export function eventPollDelayMs(failureCount: number): number {
  if (!Number.isSafeInteger(failureCount) || failureCount < 0) {
    throw new Error("The event-poll failure count must be a non-negative safe integer.");
  }
  if (failureCount === 0) return EVENT_POLL_INTERVAL_MS;
  return Math.min(
    EVENT_POLL_INTERVAL_MS * 2 ** Math.min(failureCount, 3),
    EVENT_POLL_MAX_BACKOFF_MS,
  );
}

export function evidenceTarget(section: string | undefined): string {
  const normalized = section?.trim().toLowerCase().replaceAll("_", "-");
  switch (normalized) {
    case "run-summary":
    case "summary":
    case "overview":
    case "gate":
      return "run-summary";
    case "run-context":
    case "context":
      return "run-context";
    case "run-plan":
    case "plan":
      return "run-plan";
    case "run-action":
    case "action":
    case "files":
      return "run-action";
    case "run-verification":
    case "verification":
    case "checks":
    case "diff":
      return "run-verification";
    case "run-outputs":
    case "outputs":
      return "run-outputs";
    case "run-approvals":
    case "approvals":
      return "run-approvals";
    case "run-warnings":
    case "warnings":
      return "run-warnings";
    case "run-usage":
    case "usage":
      return "run-usage";
    case "run-activity":
      return "run-activity";
    default:
      return "run-activity";
  }
}

export interface EventPollProgress {
  readonly cursor: number;
  readonly observedRevision: number;
  readonly eventCount: number;
  readonly lastEvent: TimelineEntryView | null;
}

export function advanceEventPoll(
  runId: string,
  cursor: number,
  observedRevision: number,
  page: RunEventPageView,
): EventPollProgress {
  if (
    page.runId !== runId ||
    !Number.isSafeInteger(page.revision) ||
    page.revision < observedRevision ||
    page.revision < cursor
  ) {
    throw new Error("The persisted event revision moved backwards.");
  }

  let expectedSequence = cursor;
  for (const event of page.events) {
    if (
      event.sequence === undefined ||
      !Number.isSafeInteger(event.sequence) ||
      event.sequence !== expectedSequence + 1
    ) {
      throw new Error("The persisted event sequence was not contiguous.");
    }
    expectedSequence = event.sequence;
  }
  if (
    !Number.isSafeInteger(page.nextAfter) ||
    page.nextAfter !== expectedSequence ||
    page.nextAfter > page.revision ||
    (page.hasMore && page.events.length === 0) ||
    (!page.hasMore && page.nextAfter !== page.revision)
  ) {
    throw new Error("The persisted event page cursor was inconsistent.");
  }

  return {
    cursor: page.nextAfter,
    observedRevision: page.revision,
    eventCount: page.events.length,
    lastEvent: page.events.at(-1) ?? null,
  };
}

export function snapshotIncludesObservedRevision(
  snapshotCursor: number,
  observedRevision: number,
): boolean {
  return (
    Number.isSafeInteger(snapshotCursor) &&
    Number.isSafeInteger(observedRevision) &&
    snapshotCursor >= observedRevision
  );
}

export function liveEventAnnouncement(
  observedEvents: number,
  drainCapped: boolean,
  lastPagedLabel: string,
): string {
  const count = `${drainCapped ? "At least " : ""}${observedEvents} new persisted event${
    observedEvents === 1 ? "" : "s"
  } directly paged`;
  return drainCapped
    ? `${count}; refreshed to a coherent snapshot through the observed revision. Last directly paged: ${lastPagedLabel}.`
    : `${count}. Last directly paged: ${lastPagedLabel}.`;
}
