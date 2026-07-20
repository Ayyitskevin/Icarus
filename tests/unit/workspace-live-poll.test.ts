import { describe, expect, test } from "vitest";

import type { RunEventPageView } from "../../packages/workspace/src/api.js";
import {
  advanceEventPoll,
  eventPollDelayMs,
  evidenceTarget,
  liveEventAnnouncement,
  snapshotIncludesObservedRevision,
} from "../../packages/workspace/src/live-poll.js";

const RUN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function page(revision: number, start: number, end: number, hasMore: boolean): RunEventPageView {
  return {
    runId: RUN_ID,
    revision,
    nextAfter: end,
    hasMore,
    events: Array.from({ length: end - start }, (_, index) => ({
      sequence: start + index + 1,
      type: "run.event",
      label: `event ${start + index + 1}`,
      evidenceSection: "summary",
      timestamp: "2026-07-20T12:00:00.000Z",
    })),
  };
}

describe("workspace live-event polling", () => {
  test("maps evidence labels only onto the fixed run-evidence anchors", () => {
    const expectedTargets = new Map<string, string>([
      ["run-summary", "run-summary"],
      ["summary", "run-summary"],
      ["overview", "run-summary"],
      ["gate", "run-summary"],
      ["run-context", "run-context"],
      ["context", "run-context"],
      ["run-plan", "run-plan"],
      ["plan", "run-plan"],
      ["run-action", "run-action"],
      ["action", "run-action"],
      ["files", "run-action"],
      ["run-verification", "run-verification"],
      ["verification", "run-verification"],
      ["checks", "run-verification"],
      ["diff", "run-verification"],
      ["run-outputs", "run-outputs"],
      ["outputs", "run-outputs"],
      ["run-approvals", "run-approvals"],
      ["approvals", "run-approvals"],
      ["warnings", "run-approvals"],
      ["run-usage", "run-usage"],
      ["usage", "run-usage"],
      ["run-activity", "run-activity"],
    ]);
    for (const [label, target] of expectedTargets) {
      expect(evidenceTarget(label)).toBe(target);
    }
    expect(evidenceTarget("  RUN_CONTEXT  ")).toBe("run-context");
  });

  test.each([
    undefined,
    "",
    "#run-context",
    "run-context?next=run-plan",
    "run-context/../run-plan",
    "run/context",
    "__proto__",
    "constructor",
    '"><script>alert(1)</script>',
    "\u0000run-summary",
  ])("routes the untrusted evidence label %j to the fixed activity fallback", (label) => {
    expect(evidenceTarget(label)).toBe("run-activity");
  });

  test("uses a bounded retry sequence and returns to the success baseline", () => {
    expect([0, 1, 2, 3, 4, 100].map(eventPollDelayMs)).toEqual([
      2_000, 4_000, 8_000, 15_000, 15_000, 15_000,
    ]);
    expect(eventPollDelayMs(0)).toBe(2_000);
    expect(() => eventPollDelayMs(-1)).toThrow("non-negative safe integer");
    expect(() => eventPollDelayMs(1.5)).toThrow("non-negative safe integer");
  });

  test("rejects a later page whose revision rolls back below the observed high-water mark", () => {
    const first = advanceEventPoll(RUN_ID, 0, 0, page(100, 0, 64, true));
    expect(first).toMatchObject({ cursor: 64, observedRevision: 100, eventCount: 64 });

    expect(() =>
      advanceEventPoll(RUN_ID, first.cursor, first.observedRevision, page(70, 64, 70, false)),
    ).toThrow("The persisted event revision moved backwards.");
  });

  test("requires a full snapshot to reach a capped drain's observed revision", () => {
    const cappedProgress = advanceEventPoll(RUN_ID, 0, 0, page(100, 0, 64, true));
    expect(
      snapshotIncludesObservedRevision(cappedProgress.cursor, cappedProgress.observedRevision),
    ).toBe(false);
    expect(snapshotIncludesObservedRevision(100, cappedProgress.observedRevision)).toBe(true);
    expect(snapshotIncludesObservedRevision(101, cappedProgress.observedRevision)).toBe(true);

    const announcement = liveEventAnnouncement(64, true, "event 64");
    expect(announcement).toContain("a coherent snapshot through the observed revision");
    expect(announcement).toContain("Last directly paged: event 64");
    expect(announcement).not.toContain("latest");

    const uncappedAnnouncement = liveEventAnnouncement(1, false, "event 65");
    expect(uncappedAnnouncement).toBe(
      "1 new persisted event directly paged. Last directly paged: event 65.",
    );
    expect(uncappedAnnouncement).not.toContain("latest");
  });
});
