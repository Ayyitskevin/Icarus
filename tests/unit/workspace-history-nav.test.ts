import { describe, expect, test } from "vitest";

import type {
  RunEventHistoryPageView,
  RunView,
  TimelineEntryView,
} from "../../packages/workspace/src/api.js";
import {
  acceptHistoryPage,
  canNavigateNewer,
  canNavigateOlder,
  createHistorySession,
  HISTORY_MAX_NEWER_CURSORS,
  HISTORY_MAX_PAGES,
  historyPageDepth,
  historyRequest,
} from "../../packages/workspace/src/history-nav.js";

const RUN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function event(sequence: number): TimelineEntryView {
  return {
    sequence,
    type: "run.event",
    label: "run event",
    evidenceSection: "summary",
    timestamp: "2026-07-20T12:00:00.000Z",
  };
}

function truncatedRun(
  snapshot = 500,
  first = snapshot - 199,
): Pick<RunView, "id" | "eventCursor" | "timeline" | "timelineTotal" | "timelineTruncated"> {
  return {
    id: RUN_ID,
    eventCursor: snapshot,
    timelineTotal: snapshot,
    timelineTruncated: true,
    timeline: Array.from({ length: snapshot - first + 1 }, (_, index) => event(first + index)),
  };
}

function page(
  before: number,
  snapshot: number,
  count: number,
  hasMore: boolean,
): RunEventHistoryPageView {
  const first = before - count;
  return {
    runId: RUN_ID,
    before,
    snapshot,
    nextBefore: count === 0 ? before : first,
    hasMore,
    events: Array.from({ length: count }, (_, index) => event(first + index)),
  };
}

describe("workspace bounded older-event navigation", () => {
  test("seeds only from a coherent truncated recent timeline", () => {
    const session = createHistorySession(truncatedRun());
    expect(session).toMatchObject({
      runId: RUN_ID,
      snapshot: 500,
      initialBefore: 301,
      page: null,
      newerBefore: [],
    });
    expect(historyRequest(session, "initial")).toEqual({
      runId: RUN_ID,
      before: 301,
      snapshot: 500,
      direction: "initial",
    });

    expect(() => createHistorySession({ ...truncatedRun(), timelineTruncated: false })).toThrow(
      "only when the recent timeline is truncated",
    );
    expect(() =>
      createHistorySession({
        ...truncatedRun(),
        timeline: [event(301), event(303), ...truncatedRun().timeline.slice(3)],
      }),
    ).toThrow("recent timeline sequence was not contiguous");
    expect(() => createHistorySession({ ...truncatedRun(), eventCursor: 501 })).toThrow(
      "cannot seed a pinned historical snapshot",
    );
    expect(() => createHistorySession({ ...truncatedRun(), timelineTotal: 501 })).toThrow(
      "cannot seed a pinned historical snapshot",
    );
    expect(() =>
      createHistorySession({ ...truncatedRun(), timelineTotal: Number.POSITIVE_INFINITY }),
    ).toThrow("cannot seed a pinned historical snapshot");
  });

  test("replaces pages within a four-page window and retains only three newer cursors", () => {
    let session = createHistorySession(truncatedRun());
    const firstRequest = historyRequest(session, "initial");
    session = acceptHistoryPage(session, firstRequest, page(301, 500, 64, true));
    expect(historyPageDepth(session)).toBe(1);
    expect(session.page?.events.map((entry) => entry.sequence)).toEqual(
      Array.from({ length: 64 }, (_, index) => index + 237),
    );

    for (const before of [237, 173, 109]) {
      const request = historyRequest(session, "older");
      expect(request.before).toBe(before);
      session = acceptHistoryPage(session, request, page(before, 500, 64, true));
    }

    expect(HISTORY_MAX_PAGES).toBe(4);
    expect(HISTORY_MAX_NEWER_CURSORS).toBe(3);
    expect(historyPageDepth(session)).toBe(4);
    expect(session.newerBefore).toEqual([301, 237, 173]);
    expect(session.page?.before).toBe(109);
    expect(session.page?.events.at(0)?.sequence).toBe(45);
    expect(canNavigateOlder(session)).toBe(false);
    expect(() => historyRequest(session, "older")).toThrow("cannot navigate farther back");

    const newerRequest = historyRequest(session, "newer");
    expect(newerRequest.before).toBe(173);
    session = acceptHistoryPage(session, newerRequest, page(173, 500, 64, true));
    expect(session.newerBefore).toEqual([301, 237]);
    expect(session.page?.before).toBe(173);
    expect(historyPageDepth(session)).toBe(3);
    expect(canNavigateNewer(session)).toBe(true);
  });

  test("recognizes the oldest complete page without offering older navigation", () => {
    let session = createHistorySession(truncatedRun(244, 45));
    const request = historyRequest(session, "initial");
    session = acceptHistoryPage(session, request, page(45, 244, 44, false));

    expect(session.page?.events.at(0)?.sequence).toBe(1);
    expect(session.page?.events.at(-1)?.sequence).toBe(44);
    expect(canNavigateOlder(session)).toBe(false);
    expect(canNavigateNewer(session)).toBe(false);
  });

  test("rejects mismatched, malformed, noncontiguous, and stale pages", () => {
    const initial = createHistorySession(truncatedRun());
    const request = historyRequest(initial, "initial");
    const valid = page(301, 500, 64, true);

    const invalidPages: readonly unknown[] = [
      { ...valid, runId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
      { ...valid, before: 300 },
      { ...valid, snapshot: 499 },
      { ...valid, nextBefore: 238 },
      { ...valid, hasMore: false },
      { ...valid, events: [...valid.events.slice(0, 20), event(999), ...valid.events.slice(21)] },
      page(301, 500, 65, true),
      page(301, 500, 0, false),
      { ...valid, unexpected: "not allowed" },
      {
        ...valid,
        events: [
          { ...valid.events[0], detail: "private payload detail" },
          ...valid.events.slice(1),
        ],
      },
      {
        ...valid,
        events: [
          { ...valid.events[0], type: "invalid", label: "invalid" },
          ...valid.events.slice(1),
        ],
      },
      {
        ...valid,
        events: [
          { ...valid.events[0], type: `run.${"x".repeat(129)}`, label: `run ${"x".repeat(129)}` },
          ...valid.events.slice(1),
        ],
      },
      {
        ...valid,
        events: [
          { ...valid.events[0], label: "provider-controlled label" },
          ...valid.events.slice(1),
        ],
      },
      {
        ...valid,
        events: [{ ...valid.events[0], timestamp: "not-a-timestamp" }, ...valid.events.slice(1)],
      },
      {
        ...valid,
        events: [
          { ...valid.events[0], evidenceSection: "private-source" },
          ...valid.events.slice(1),
        ],
      },
      {
        ...valid,
        events: [{ ...valid.events[0], sequence: 1.5 }, ...valid.events.slice(1)],
      },
    ];
    for (const invalid of invalidPages) {
      expect(() => acceptHistoryPage(initial, request, invalid)).toThrow();
      expect(initial.page).toBeNull();
    }

    const accepted = acceptHistoryPage(initial, request, valid);
    expect(() => acceptHistoryPage(accepted, request, valid)).toThrow();
    expect(accepted.page).toBe(valid);
  });

  test("keeps the successful page and exact retry request after a failed navigation", () => {
    const initial = createHistorySession(truncatedRun());
    const firstRequest = historyRequest(initial, "initial");
    const loaded = acceptHistoryPage(initial, firstRequest, page(301, 500, 64, true));
    const olderRequest = historyRequest(loaded, "older");
    const invalidOlder = { ...page(237, 500, 64, true), snapshot: 499 };

    expect(() => acceptHistoryPage(loaded, olderRequest, invalidOlder)).toThrow();
    expect(loaded.page?.before).toBe(301);
    expect(loaded.page?.events.at(0)?.sequence).toBe(237);
    expect(historyRequest(loaded, "older")).toEqual(olderRequest);
  });
});
