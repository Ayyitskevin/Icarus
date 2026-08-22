import { describe, expect, test } from "vitest";

import type {
  RunPageView,
  RunStateView,
  RunSummaryView,
} from "../../packages/workspace/src/api.js";
import {
  acceptRunPage,
  canNavigateToNewerRuns,
  canNavigateToOlderRuns,
  createRunPageSession,
  RUN_PAGE_MAX_NEWER_CURSORS,
  RUN_PAGE_MAX_PAGES,
  RUN_PAGE_SIZE,
  runPageDepth,
  runPageRequest,
} from "../../packages/workspace/src/run-page-nav.js";

const PROJECT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const phases: Readonly<Record<RunStateView, RunSummaryView["phase"]>> = {
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

function summary(index: number, state: RunStateView = "completed"): RunSummaryView {
  return {
    id: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
    projectId: PROJECT_ID,
    task: `Bounded task ${index}`,
    target: `src/example-${index}.ts`,
    state,
    phase: phases[state],
    createdAt: "2026-07-20T12:00:00.000Z",
    updatedAt: "2026-07-20T12:01:00Z",
  };
}

function page(
  before: number,
  snapshot: number,
  count: number,
  hasMore: boolean,
  nextBefore: number,
  offset = 0,
): RunPageView {
  return {
    before,
    snapshot,
    nextBefore,
    hasMore,
    runs: Array.from({ length: count }, (_, index) => summary(offset + index + 1)),
  };
}

describe("workspace bounded run-page navigation", () => {
  test("accepts the exact empty newest-page contract", () => {
    const empty: RunPageView = {
      before: 1,
      snapshot: 0,
      nextBefore: 1,
      hasMore: false,
      runs: [],
    };
    const session = createRunPageSession(empty);

    expect(session).toEqual({ snapshot: 0, initialBefore: 1, page: empty, newerBefore: [] });
    expect(runPageDepth(session)).toBe(1);
    expect(canNavigateToOlderRuns(session)).toBe(false);
    expect(canNavigateToNewerRuns(session)).toBe(false);
  });

  test("replaces pages and retains only three newer cursors", () => {
    let session = createRunPageSession(page(501, 500, 12, true, 489));
    expect(RUN_PAGE_SIZE).toBe(12);
    expect(runPageDepth(session)).toBe(1);

    for (const [before, nextBefore, offset] of [
      [489, 477, 12],
      [477, 465, 24],
      [465, 453, 36],
    ] as const) {
      const request = runPageRequest(session, "older");
      expect(request.before).toBe(before);
      session = acceptRunPage(session, request, page(before, 500, 12, true, nextBefore, offset));
    }

    expect(RUN_PAGE_MAX_PAGES).toBe(4);
    expect(RUN_PAGE_MAX_NEWER_CURSORS).toBe(3);
    expect(runPageDepth(session)).toBe(4);
    expect(session.newerBefore).toEqual([501, 489, 477]);
    expect(session.page.before).toBe(465);
    expect(canNavigateToOlderRuns(session)).toBe(false);
    expect(() => runPageRequest(session, "older")).toThrow("cannot navigate farther back");

    const newerRequest = runPageRequest(session, "newer");
    expect(newerRequest.before).toBe(477);
    session = acceptRunPage(session, newerRequest, page(477, 500, 12, true, 465, 24));
    expect(session.newerBefore).toEqual([501, 489]);
    expect(session.page.before).toBe(477);
    expect(runPageDepth(session)).toBe(3);
  });

  test("uses hasMore alone to gate Older on a terminal page", () => {
    let session = createRunPageSession(page(13, 12, 12, false, 1));
    expect(session.page.nextBefore).toBe(1);
    expect(canNavigateToOlderRuns(session)).toBe(false);

    const first = createRunPageSession(page(25, 24, 12, true, 13));
    const request = runPageRequest(first, "older");
    session = acceptRunPage(first, request, page(13, 24, 12, false, 1, 12));
    expect(session.page.runs).toHaveLength(12);
    expect(session.page.hasMore).toBe(false);
    expect(canNavigateToOlderRuns(session)).toBe(false);
    expect(canNavigateToNewerRuns(session)).toBe(true);
  });

  test("rejects mismatched, malformed, oversized, and stale pages", () => {
    const initialPage = page(101, 100, 12, true, 89);
    const initial = createRunPageSession(initialPage);
    const request = runPageRequest(initial, "older");
    const valid = page(89, 100, 12, true, 77, 12);
    const firstRun = valid.runs[0];
    if (firstRun === undefined) throw new Error("Fixture run is missing");

    const invalidPages: readonly unknown[] = [
      { ...valid, before: 88 },
      { ...valid, snapshot: 99 },
      { ...valid, nextBefore: 89 },
      { ...valid, runs: [...valid.runs, summary(99)] },
      { ...valid, runs: valid.runs.slice(0, 11) },
      { ...valid, runs: [firstRun, firstRun, ...valid.runs.slice(2)] },
      { ...valid, unexpected: "not allowed" },
      { ...valid, runs: [{ ...firstRun, detail: "private detail" }, ...valid.runs.slice(1)] },
      { ...valid, runs: [{ ...firstRun, id: firstRun.id.toUpperCase() }, ...valid.runs.slice(1)] },
      { ...valid, runs: [{ ...firstRun, task: " \n " }, ...valid.runs.slice(1)] },
      { ...valid, runs: [{ ...firstRun, task: `task\0secret` }, ...valid.runs.slice(1)] },
      { ...valid, runs: [{ ...firstRun, task: "x".repeat(8 * 1024 + 1) }, ...valid.runs.slice(1)] },
      { ...valid, runs: [{ ...firstRun, target: "é".repeat(513) }, ...valid.runs.slice(1)] },
      { ...valid, runs: [{ ...firstRun, phase: "running" }, ...valid.runs.slice(1)] },
      { ...valid, runs: [{ ...firstRun, state: "unknown" }, ...valid.runs.slice(1)] },
      { ...valid, runs: [{ ...firstRun, updatedAt: "not-a-time" }, ...valid.runs.slice(1)] },
    ];
    for (const invalid of invalidPages) {
      expect(() => acceptRunPage(initial, request, invalid)).toThrow();
      expect(initial.page).toBe(initialPage);
      expect(initial.newerBefore).toEqual([]);
    }

    const accepted = acceptRunPage(initial, request, valid);
    expect(() => acceptRunPage(accepted, request, valid)).toThrow("cursor is stale");
    expect(accepted.page).toBe(valid);
  });

  test("rejects invalid newest and empty page metadata", () => {
    expect(() => createRunPageSession(page(100, 100, 12, false, 88))).toThrow(
      "did not start a pinned session",
    );
    expect(() =>
      createRunPageSession({
        before: 1,
        snapshot: 0,
        nextBefore: 1,
        hasMore: false,
        runs: [summary(1)],
      }),
    ).toThrow("boundary was inconsistent");
    expect(() =>
      createRunPageSession({
        before: 1,
        snapshot: 0,
        nextBefore: 0,
        hasMore: false,
        runs: [],
      }),
    ).toThrow();
    expect(() =>
      createRunPageSession({
        before: Number.MAX_SAFE_INTEGER,
        snapshot: Number.MAX_SAFE_INTEGER,
        nextBefore: 1,
        hasMore: false,
        runs: [summary(1)],
      }),
    ).toThrow();
  });

  test("preserves the last page and exact retry request after rejection", () => {
    const firstPage = page(101, 100, 12, true, 89);
    const session = createRunPageSession(firstPage);
    const request = runPageRequest(session, "older");

    expect(() =>
      acceptRunPage(session, request, { ...page(89, 100, 12, true, 77), before: 88 }),
    ).toThrow();
    expect(session.page).toBe(firstPage);
    expect(runPageRequest(session, "older")).toEqual(request);
  });
});
