import { describe, expect, test } from "vitest";

import type {
  VerificationAttemptsView,
  VerificationAttemptView,
} from "../../packages/workspace/src/api.js";
import {
  VERIFICATION_ATTEMPT_EVENT_LIMIT,
  VERIFICATION_ATTEMPT_LIMIT,
  validateVerificationAttempts,
  verificationAttemptsAreStale,
  verificationAttemptsRequest,
} from "../../packages/workspace/src/verification-attempts.js";

const RUN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CHECKPOINT_SHA256 = "c".repeat(64);
const DIFF_SHA256 = "d".repeat(64);

function completedAttempt(
  anchorSequence = 4,
  startSequence = 2,
  status: "passed" | "failed" | "unavailable" = "passed",
): VerificationAttemptView {
  return {
    identity: `verification-anchor-${anchorSequence}`,
    anchorSequence,
    startSequence,
    startedAt: `2026-07-22T12:00:${String(startSequence).padStart(2, "0")}.000Z`,
    startProvenance: "observed_initial_edit",
    status,
    endSequence: anchorSequence,
    endedAt: `2026-07-22T12:00:${String(anchorSequence).padStart(2, "0")}.000Z`,
    diffSha256: DIFF_SHA256,
    checkpointSha256: CHECKPOINT_SHA256,
    checkpointProvenance: "recorded_digest_match",
    laterAttemptObservedWithinCoverage: false,
  };
}

function view(
  snapshot = 4,
  attempts: readonly VerificationAttemptView[] = [completedAttempt()],
): VerificationAttemptsView {
  const firstSequence = Math.max(1, snapshot - VERIFICATION_ATTEMPT_EVENT_LIMIT + 1);
  return {
    runId: RUN_ID,
    snapshot,
    coverage: {
      firstSequence,
      lastSequence: snapshot,
      eventCount: snapshot - firstSequence + 1,
      eventLimit: 200,
      earlierEventsExcluded: firstSequence > 1,
    },
    attemptLimit: 8,
    attemptAnchorsTruncatedWithinCoverage: false,
    checkpoint: {
      status: "saved",
      sha256: CHECKPOINT_SHA256,
      createdAt: "2026-07-22T12:00:01.000Z",
      saveEvent:
        firstSequence <= 3
          ? {
              status: "observed_in_coverage",
              sequence: 3,
              timestamp: "2026-07-22T12:00:03.000Z",
            }
          : { status: "not_observed_in_coverage" },
    },
    attempts,
  };
}

function validate(value: unknown, snapshot = 4): void {
  validateVerificationAttempts({ runId: RUN_ID, snapshot }, value);
}

describe("workspace verification-attempt contract", () => {
  test("accepts exact empty and completed bounded responses", () => {
    const empty: VerificationAttemptsView = {
      runId: RUN_ID,
      snapshot: 1,
      coverage: {
        firstSequence: 1,
        lastSequence: 1,
        eventCount: 1,
        eventLimit: 200,
        earlierEventsExcluded: false,
      },
      attemptLimit: 8,
      attemptAnchorsTruncatedWithinCoverage: false,
      checkpoint: { status: "not_saved" },
      attempts: [],
    };
    expect(() => validate(empty, 1)).not.toThrow();
    expect(() => validate(view())).not.toThrow();
    expect(VERIFICATION_ATTEMPT_EVENT_LIMIT).toBe(200);
    expect(VERIFICATION_ATTEMPT_LIMIT).toBe(8);
  });

  test("accepts each bounded terminal and incomplete status with exact digest semantics", () => {
    for (const status of ["passed", "failed", "unavailable"] as const) {
      expect(() => validate(view(4, [completedAttempt(4, 2, status)]))).not.toThrow();
    }

    for (const status of ["cancelled", "incomplete_failed"] as const) {
      const attempt: VerificationAttemptView = {
        ...completedAttempt(),
        status,
        diffSha256: null,
        checkpointProvenance: "run_checkpoint_available",
      };
      expect(() => validate(view(4, [attempt]))).not.toThrow();
    }

    const open: VerificationAttemptView = {
      ...completedAttempt(2, 2),
      status: "incomplete_at_snapshot",
      endSequence: null,
      endedAt: null,
      diffSha256: null,
      checkpointProvenance: "run_checkpoint_available",
    };
    expect(() => validate(view(4, [open]))).not.toThrow();

    const outsideOpen: VerificationAttemptView = {
      identity: "verification-anchor-201",
      anchorSequence: 201,
      startSequence: null,
      startedAt: null,
      startProvenance: "outside_coverage",
      status: "incomplete_at_snapshot",
      endSequence: null,
      endedAt: null,
      diffSha256: null,
      checkpointSha256: null,
      checkpointProvenance: "not_available",
      laterAttemptObservedWithinCoverage: false,
    };
    const outsideView: VerificationAttemptsView = {
      ...view(201, [outsideOpen]),
      checkpoint: { status: "not_saved" },
    };
    expect(() => validate(outsideView, 201)).not.toThrow();
  });

  test("enforces exact 200-event coverage and at-most-eight ordered anchors", () => {
    const attempts = Array.from({ length: 8 }, (_, index) => {
      const anchor = 4 + index * 2;
      return {
        ...completedAttempt(anchor, anchor - 1, index % 2 === 0 ? "passed" : "failed"),
        startProvenance: index === 0 ? "observed_initial_edit" : "observed_restore",
        laterAttemptObservedWithinCoverage: index < 7,
      } satisfies VerificationAttemptView;
    });
    const capped: VerificationAttemptsView = {
      ...view(20, attempts),
      attemptAnchorsTruncatedWithinCoverage: true,
    };
    expect(() => validate(capped, 20)).not.toThrow();

    for (const invalid of [
      { ...capped, attempts: [...attempts, completedAttempt(20, 19)] },
      { ...capped, attempts: attempts.slice(0, 7) },
      { ...capped, coverage: { ...capped.coverage, eventCount: 19 } },
      { ...capped, coverage: { ...capped.coverage, eventLimit: 201 } },
      { ...capped, coverage: { ...capped.coverage, earlierEventsExcluded: true } },
      { ...capped, attempts: [attempts[1], attempts[0], ...attempts.slice(2)] },
    ]) {
      expect(() => validate(invalid, 20)).toThrow();
    }

    const boundary = view(201, []);
    expect(boundary.coverage).toEqual({
      firstSequence: 2,
      lastSequence: 201,
      eventCount: 200,
      eventLimit: 200,
      earlierEventsExcluded: true,
    });
    expect(() => validate(boundary, 201)).not.toThrow();
  });

  test("rejects hostile extras, malformed identities, enums, timestamps, and nullable relations", () => {
    const valid = view();
    const attempt = valid.attempts[0];
    if (attempt === undefined) throw new Error("Fixture attempt is missing");
    const invalidValues: readonly unknown[] = [
      { ...valid, privatePayload: "<img src=x onerror=alert(1)>" },
      { ...valid, runId: RUN_ID.toUpperCase() },
      { ...valid, snapshot: 5 },
      { ...valid, attempts: [{ ...attempt, rawOutput: "private" }] },
      { ...valid, attempts: [{ ...attempt, identity: "attempt-4" }] },
      { ...valid, attempts: [{ ...attempt, anchorSequence: 0 }] },
      { ...valid, attempts: [{ ...attempt, startProvenance: "adjacent" }] },
      { ...valid, attempts: [{ ...attempt, status: "timed_out" }] },
      { ...valid, attempts: [{ ...attempt, startedAt: "not-a-time" }] },
      { ...valid, attempts: [{ ...attempt, diffSha256: "D".repeat(64) }] },
      { ...valid, attempts: [{ ...attempt, endSequence: 3 }] },
      { ...valid, attempts: [{ ...attempt, checkpointSha256: null }] },
      { ...valid, attempts: [{ ...attempt, laterAttemptObservedWithinCoverage: true }] },
      { ...valid, checkpoint: { ...valid.checkpoint, privateBytes: "secret" } },
    ];
    for (const invalid of invalidValues) expect(() => validate(invalid)).toThrow();
  });

  test("enforces checkpoint union, digest equality, and observed save ordering", () => {
    const valid = view();
    const attempt = valid.attempts[0];
    if (attempt === undefined) throw new Error("Fixture attempt is missing");
    for (const invalid of [
      { ...valid, checkpoint: { status: "not_saved", sha256: CHECKPOINT_SHA256 } },
      { ...valid, checkpoint: { status: "not_saved" } },
      {
        ...valid,
        checkpoint: {
          ...valid.checkpoint,
          sha256: "e".repeat(64),
        },
      },
      {
        ...valid,
        checkpoint: {
          ...valid.checkpoint,
          saveEvent: {
            status: "observed_in_coverage",
            sequence: 4,
            timestamp: "2026-07-22T12:00:04.000Z",
          },
        },
      },
      {
        ...valid,
        checkpoint: {
          ...valid.checkpoint,
          saveEvent: { status: "not_observed_in_coverage" },
        },
      },
      {
        ...valid,
        attempts: [{ ...attempt, checkpointProvenance: "run_checkpoint_available" }],
      },
    ]) {
      expect(() => validate(invalid)).toThrow();
    }
  });

  test("seeds every request from the current run and detects only same-run cursor staleness", () => {
    expect(verificationAttemptsRequest({ id: RUN_ID, eventCursor: 4 })).toEqual({
      runId: RUN_ID,
      snapshot: 4,
    });
    expect(() => verificationAttemptsRequest({ id: "not-a-run", eventCursor: 4 })).toThrow();
    expect(() => verificationAttemptsRequest({ id: RUN_ID, eventCursor: 0 })).toThrow();

    const loaded = view();
    expect(verificationAttemptsAreStale({ id: RUN_ID, eventCursor: 4 }, loaded)).toBe(false);
    expect(verificationAttemptsAreStale({ id: RUN_ID, eventCursor: 5 }, loaded)).toBe(true);
    expect(
      verificationAttemptsAreStale(
        { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", eventCursor: 5 },
        loaded,
      ),
    ).toBe(false);
  });
});
