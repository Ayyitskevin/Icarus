import { rmSync } from "node:fs";
import { createRequire } from "node:module";

import { afterEach, describe, expect, test } from "vitest";

import { IcarusError } from "../../packages/core/src/errors.js";
import { IcarusStore } from "../../packages/core/src/store.js";
import { readRunVerificationAttempts } from "../../packages/core/src/verification-provenance.js";
import {
  createUnitStore,
  makeUnitIdGenerator,
  seedUnitProject,
  UNIT_PLAN,
  UNIT_PROVIDER,
  UNIT_RUN_ID,
} from "../support/unit-fixtures.js";

interface TestDatabase {
  prepare(sql: string): {
    run(...parameters: unknown[]): unknown;
    get(...parameters: unknown[]): unknown;
    all(...parameters: unknown[]): unknown[];
  };
  transaction<T>(callback: () => T): () => T;
  close(): void;
}

const Database = createRequire(new URL("../../packages/core/package.json", import.meta.url))(
  "better-sqlite3",
) as new (
  filename: string,
) => TestDatabase;

const CHECKPOINT_SHA256 = "c".repeat(64);
const DIFF_SHA256 = "d".repeat(64);
const PRIVATE_SENTINEL = "/private/source/check-output-<img-onerror-sentinel>";
const COMPLETION_PAYLOAD_LIMIT = 8 * 1024 * 1024;
const TRANSITION_PAYLOAD_LIMIT = 16 * 1024;
const CHECKPOINT_EVENT_PAYLOAD_LIMIT = 1024;
const cleanupRoots: string[] = [];

afterEach(() => {
  for (const root of cleanupRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

interface SeedEvent {
  readonly type: string;
  readonly payload: unknown;
  readonly timestamp?: string;
}

function timestamp(sequence: number): string {
  return new Date(Date.UTC(2026, 6, 22, 12, 0, 0, sequence)).toISOString();
}

function initialStart(): SeedEvent {
  return {
    type: "edit.materialized",
    payload: {
      from: "running",
      to: "verifying",
      detail: { target: PRIVATE_SENTINEL, approvedSha256: "a".repeat(64) },
    },
  };
}

function restoreStart(): SeedEvent {
  return {
    type: "restore.completed",
    payload: { from: "restoring", to: "verifying" },
  };
}

function resumeStart(): SeedEvent {
  return {
    type: "run.resumed",
    payload: { from: "failed", to: "verifying" },
  };
}

function checkpointSaved(digest = CHECKPOINT_SHA256): SeedEvent {
  return { type: "checkpoint.saved", payload: { checkpointSha256: digest } };
}

function completed(
  outcome: "passed" | "failed" | "unavailable" = "passed",
  checkpointSha256 = CHECKPOINT_SHA256,
): SeedEvent {
  return {
    type: "verification.completed",
    payload: {
      from: "verifying",
      to: "awaiting_review",
      outcome,
      diffSha256: DIFF_SHA256,
      diff: PRIVATE_SENTINEL,
      verification: {
        outcome,
        checks: [
          {
            checkId: "private-check",
            argv: [PRIVATE_SENTINEL],
            stdout: PRIVATE_SENTINEL,
            stderr: "Verification exceeded its configured timeout",
          },
        ],
        changedPaths: [PRIVATE_SENTINEL],
        diffSha256: DIFF_SHA256,
        checkpointSha256,
      },
    },
  };
}

function cancelled(): SeedEvent {
  return {
    type: "cancellation.requested",
    payload: {
      from: "verifying",
      to: "cancelling",
      detail: { actor: PRIVATE_SENTINEL },
    },
  };
}

function incompleteFailure(): SeedEvent {
  return {
    type: "run.failed",
    payload: {
      from: "verifying",
      to: "failed",
      resumeState: "verifying",
      code: "OPERATION_TIMEOUT",
      message: PRIVATE_SENTINEL,
    },
  };
}

function irrelevant(index: number, payload: unknown = "not-json-private-payload"): SeedEvent {
  return { type: `operation.${index % 2 === 0 ? "started" : "finished"}`, payload };
}

function seedProjection(
  options: {
    readonly events?: readonly SeedEvent[];
    readonly state?: string;
    readonly resumeState?: string | null;
    readonly checkpoint?: boolean;
    readonly checkpointDigest?: string;
  } = {},
): {
  readonly root: string;
  readonly databasePath: string;
  readonly store: IcarusStore;
  readonly database: TestDatabase;
  readonly snapshot: number;
} {
  const fixture = createUnitStore();
  cleanupRoots.push(fixture.root);
  const { projectId } = seedUnitProject(fixture.store);
  fixture.store.createRun({
    id: UNIT_RUN_ID,
    projectId,
    task: "Inspect bounded verification provenance",
    target: UNIT_PLAN.target,
    provider: UNIT_PROVIDER,
  });

  const database = new Database(fixture.databasePath);
  database
    .prepare("UPDATE runs SET state = ?, resume_state = ? WHERE id = ?")
    .run(options.state ?? "completed", options.resumeState ?? null, UNIT_RUN_ID);
  const insert = database.prepare(
    `INSERT INTO run_events (run_id, sequence, type, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  let sequence = 1;
  for (const event of options.events ?? []) {
    sequence += 1;
    insert.run(
      UNIT_RUN_ID,
      sequence,
      event.type,
      typeof event.payload === "string" ? event.payload : JSON.stringify(event.payload),
      event.timestamp ?? timestamp(sequence),
    );
  }
  if (options.checkpoint === true) {
    database
      .prepare(
        `INSERT INTO checkpoints
           (run_id, baseline_base64, approved_base64, checkpoint_sha256, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        UNIT_RUN_ID,
        Buffer.from(PRIVATE_SENTINEL).toString("base64"),
        Buffer.from(`${PRIVATE_SENTINEL}-approved`).toString("base64"),
        options.checkpointDigest ?? CHECKPOINT_SHA256,
        timestamp(1),
      );
  }
  return { ...fixture, database, snapshot: sequence };
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(IcarusError);
    expect((error as IcarusError).code).toBe(code);
    expect((error as Error).message).not.toContain(PRIVATE_SENTINEL);
  }
}

function padJsonToBytes(value: unknown, bytes: number): string {
  const json = JSON.stringify(value);
  expect(Buffer.byteLength(json)).toBeLessThanOrEqual(bytes);
  return `${json}${" ".repeat(bytes - Buffer.byteLength(json))}`;
}

function multibytePadding(bytes: number): string {
  expect(bytes).toBeGreaterThanOrEqual(0);
  return `${bytes % 2 === 0 ? "" : "x"}${"é".repeat(Math.floor(bytes / 2))}`;
}

function replacePayload(
  database: TestDatabase,
  sequence: number,
  payload: string | number | Buffer,
): void {
  database
    .prepare("UPDATE run_events SET payload_json = ? WHERE run_id = ? AND sequence = ?")
    .run(payload, UNIT_RUN_ID, sequence);
}

describe("bounded verification and checkpoint provenance", () => {
  test("returns an honest empty bounded view without inventing a pass", () => {
    const fixture = seedProjection();
    const result = fixture.store.getRunVerificationAttempts(UNIT_RUN_ID, fixture.snapshot);

    expect(result).toEqual({
      runId: UNIT_RUN_ID,
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
    });
    fixture.database.close();
    fixture.store.close();
  });

  test("projects only safe completed scalars and collapses timeout detail honestly", () => {
    const fixture = seedProjection({
      events: [initialStart(), checkpointSaved(), completed("failed")],
      state: "awaiting_review",
      checkpoint: true,
    });
    const result = fixture.store.getRunVerificationAttempts(UNIT_RUN_ID, fixture.snapshot);

    expect(result.attempts).toEqual([
      {
        identity: "verification-anchor-4",
        anchorSequence: 4,
        startSequence: 2,
        startedAt: timestamp(2),
        startProvenance: "observed_initial_edit",
        status: "failed",
        endSequence: 4,
        endedAt: timestamp(4),
        diffSha256: DIFF_SHA256,
        checkpointSha256: CHECKPOINT_SHA256,
        checkpointProvenance: "recorded_digest_match",
        laterAttemptObservedWithinCoverage: false,
      },
    ]);
    expect(result.checkpoint).toEqual({
      status: "saved",
      sha256: CHECKPOINT_SHA256,
      createdAt: timestamp(1),
      saveEvent: { status: "observed_in_coverage", sequence: 3, timestamp: timestamp(3) },
    });
    expect(JSON.stringify(result)).not.toContain(PRIVATE_SENTINEL);
    expect(JSON.stringify(result)).not.toContain("timeout");
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(4_096);
    fixture.database.close();
    fixture.store.close();
  });

  test("distinguishes cancelled, failed-before-completion, and open intervals", () => {
    const cases = [
      {
        terminal: cancelled(),
        state: "cancelled",
        resumeState: null,
        status: "cancelled",
      },
      {
        terminal: incompleteFailure(),
        state: "failed",
        resumeState: "verifying",
        status: "incomplete_failed",
      },
      {
        terminal: null,
        state: "verifying",
        resumeState: null,
        status: "incomplete_at_snapshot",
      },
    ] as const;

    for (const item of cases) {
      const events = [initialStart(), checkpointSaved()];
      if (item.terminal !== null) events.push(item.terminal);
      const fixture = seedProjection({
        events,
        state: item.state,
        resumeState: item.resumeState,
        checkpoint: true,
      });
      const result = fixture.store.getRunVerificationAttempts(UNIT_RUN_ID, fixture.snapshot);
      expect(result.attempts).toHaveLength(1);
      expect(result.attempts[0]).toMatchObject({
        startSequence: 2,
        status: item.status,
        checkpointSha256: CHECKPOINT_SHA256,
        checkpointProvenance: "run_checkpoint_available",
      });
      expect(result.attempts[0]?.diffSha256).toBeNull();
      if (item.terminal === null) {
        expect(result.attempts[0]).toMatchObject({ endSequence: null, endedAt: null });
      }
      expect(JSON.stringify(result)).not.toContain(PRIVATE_SENTINEL);
      fixture.database.close();
      fixture.store.close();
    }
  });

  test("reports restore and resume starts without claiming rollback causality", () => {
    const fixture = seedProjection({
      events: [
        initialStart(),
        checkpointSaved(),
        completed(),
        { type: "rollback.completed", payload: { from: "rolling_back", to: "rolled_back" } },
        restoreStart(),
        completed("unavailable"),
        {
          type: "run.failed",
          payload: {
            from: "awaiting_review",
            to: "failed",
            resumeState: "verifying",
            code: "X",
            message: PRIVATE_SENTINEL,
          },
        },
        resumeStart(),
        completed("passed"),
      ],
      state: "awaiting_review",
      checkpoint: true,
    });
    const result = fixture.store.getRunVerificationAttempts(UNIT_RUN_ID, fixture.snapshot);

    expect(result.attempts.map((attempt) => attempt.startProvenance)).toEqual([
      "observed_initial_edit",
      "observed_restore",
      "observed_resume",
    ]);
    expect(result.attempts.map((attempt) => attempt.status)).toEqual([
      "passed",
      "unavailable",
      "passed",
    ]);
    expect(result.attempts.map((attempt) => attempt.laterAttemptObservedWithinCoverage)).toEqual([
      true,
      true,
      false,
    ]);
    expect(JSON.stringify(result)).not.toMatch(/rollback|supersed/i);
    fixture.database.close();
    fixture.store.close();
  });

  test("retains the newest eight anchors and marks only bounded anchor overflow", () => {
    const events: SeedEvent[] = [checkpointSaved()];
    for (let index = 0; index < 9; index += 1) {
      events.push(
        index === 0 ? initialStart() : restoreStart(),
        completed(index % 2 ? "failed" : "passed"),
      );
    }
    const fixture = seedProjection({ events, state: "awaiting_review", checkpoint: true });
    const result = fixture.store.getRunVerificationAttempts(UNIT_RUN_ID, fixture.snapshot);

    expect(result.attemptAnchorsTruncatedWithinCoverage).toBe(true);
    expect(result.attempts).toHaveLength(8);
    expect(result.attempts.map((attempt) => attempt.anchorSequence)).toEqual([
      6, 8, 10, 12, 14, 16, 18, 20,
    ]);
    expect(result.attempts.at(-1)?.laterAttemptObservedWithinCoverage).toBe(false);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(8_192);
    fixture.database.close();
    fixture.store.close();
  });

  test("does not decode a malformed completion excluded by the newest-eight cap", () => {
    const events: SeedEvent[] = [
      checkpointSaved(),
      initialStart(),
      { ...completed(), payload: `${PRIVATE_SENTINEL}:malformed-excluded-completion` },
    ];
    for (let index = 0; index < 8; index += 1) {
      events.push(restoreStart(), completed(index % 2 === 0 ? "passed" : "failed"));
    }
    const fixture = seedProjection({ events, state: "awaiting_review", checkpoint: true });

    const result = fixture.store.getRunVerificationAttempts(UNIT_RUN_ID, fixture.snapshot);
    expect(result.attemptAnchorsTruncatedWithinCoverage).toBe(true);
    expect(result.attempts).toHaveLength(8);
    expect(JSON.stringify(result)).not.toContain(PRIVATE_SENTINEL);
    fixture.database.close();
    fixture.store.close();
  });

  test("marks a start outside the fixed 200-event suffix without reading private noise", () => {
    const events: SeedEvent[] = [initialStart(), checkpointSaved()];
    for (let index = 0; index < 202; index += 1) events.push(irrelevant(index));
    events.push(completed());
    const fixture = seedProjection({ events, state: "awaiting_review", checkpoint: true });
    const result = fixture.store.getRunVerificationAttempts(UNIT_RUN_ID, fixture.snapshot);

    expect(result.coverage).toEqual({
      firstSequence: fixture.snapshot - 199,
      lastSequence: fixture.snapshot,
      eventCount: 200,
      eventLimit: 200,
      earlierEventsExcluded: true,
    });
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]).toMatchObject({
      startSequence: null,
      startedAt: null,
      startProvenance: "outside_coverage",
      status: "passed",
    });
    expect(result.checkpoint).toMatchObject({
      status: "saved",
      saveEvent: { status: "not_observed_in_coverage" },
    });
    fixture.database.close();
    fixture.store.close();
  });

  test("does not decode unrelated malformed payloads", () => {
    const fixture = seedProjection({
      events: [initialStart(), checkpointSaved(), irrelevant(1), completed()],
      state: "awaiting_review",
      checkpoint: true,
    });
    expect(
      fixture.store.getRunVerificationAttempts(UNIT_RUN_ID, fixture.snapshot).attempts,
    ).toHaveLength(1);
    fixture.database.close();
    fixture.store.close();
  });

  test("fails closed on missing/mismatched checkpoint and corrupt selected metadata", () => {
    const missing = seedProjection({
      events: [initialStart(), completed()],
      state: "awaiting_review",
    });
    expectCode(
      () => missing.store.getRunVerificationAttempts(UNIT_RUN_ID, missing.snapshot),
      "DATABASE_ERROR",
    );
    missing.database.close();
    missing.store.close();

    const mismatch = seedProjection({
      events: [initialStart(), checkpointSaved(), completed()],
      state: "awaiting_review",
      checkpoint: true,
      checkpointDigest: "e".repeat(64),
    });
    expectCode(
      () => mismatch.store.getRunVerificationAttempts(UNIT_RUN_ID, mismatch.snapshot),
      "DATABASE_ERROR",
    );
    mismatch.database.close();
    mismatch.store.close();

    for (const events of [
      [initialStart(), completed(), checkpointSaved()],
      [restoreStart(), checkpointSaved(), completed()],
      [resumeStart(), checkpointSaved(), completed()],
    ] as const) {
      const reverseOrder = seedProjection({
        events,
        state: "awaiting_review",
        checkpoint: true,
      });
      expectCode(
        () => reverseOrder.store.getRunVerificationAttempts(UNIT_RUN_ID, reverseOrder.snapshot),
        "DATABASE_ERROR",
      );
      reverseOrder.database.close();
      reverseOrder.store.close();
    }

    for (const events of [
      [initialStart(), checkpointSaved(), { ...completed(), payload: "{not-json" }],
      [
        { ...initialStart(), payload: { from: "running", to: "awaiting_review", detail: {} } },
        checkpointSaved(),
        completed(),
      ],
      [initialStart(), checkpointSaved(), { ...completed(), timestamp: "not-a-time" }],
    ] as const) {
      const corrupt = seedProjection({
        events,
        state: "awaiting_review",
        checkpoint: true,
      });
      expectCode(
        () => corrupt.store.getRunVerificationAttempts(UNIT_RUN_ID, corrupt.snapshot),
        "DATABASE_ERROR",
      );
      corrupt.database.close();
      corrupt.store.close();
    }
  });

  test("accepts exact payload byte ceilings and rejects one byte over before projection", () => {
    const cases = [
      {
        events: [initialStart(), checkpointSaved(), completed()] as const,
        sequence: 4,
        value: completed().payload,
        limit: COMPLETION_PAYLOAD_LIMIT,
      },
      {
        events: [initialStart()] as const,
        sequence: 2,
        value: initialStart().payload,
        limit: TRANSITION_PAYLOAD_LIMIT,
      },
      {
        events: [checkpointSaved()] as const,
        sequence: 2,
        value: checkpointSaved().payload,
        limit: CHECKPOINT_EVENT_PAYLOAD_LIMIT,
      },
    ] as const;

    for (const item of cases) {
      const exact = seedProjection({
        events: item.events,
        state: item.limit === TRANSITION_PAYLOAD_LIMIT ? "verifying" : "awaiting_review",
        checkpoint: item.limit !== TRANSITION_PAYLOAD_LIMIT,
      });
      replacePayload(exact.database, item.sequence, padJsonToBytes(item.value, item.limit));
      expect(() =>
        exact.store.getRunVerificationAttempts(UNIT_RUN_ID, exact.snapshot),
      ).not.toThrow();
      exact.database.close();
      exact.store.close();

      const over = seedProjection({
        events: item.events,
        state: item.limit === TRANSITION_PAYLOAD_LIMIT ? "verifying" : "awaiting_review",
        checkpoint: item.limit !== TRANSITION_PAYLOAD_LIMIT,
      });
      replacePayload(over.database, item.sequence, padJsonToBytes(item.value, item.limit + 1));
      expectCode(
        () => over.store.getRunVerificationAttempts(UNIT_RUN_ID, over.snapshot),
        "DATABASE_ERROR",
      );
      over.database.close();
      over.store.close();
    }
  });

  test("measures multibyte selected payloads by UTF-8 bytes at the large ceilings", () => {
    const transitionPayload = {
      from: "running",
      to: "verifying",
      detail: { privatePadding: "" },
    };
    const transitionBaseBytes = Buffer.byteLength(JSON.stringify(transitionPayload));
    transitionPayload.detail.privatePadding = multibytePadding(
      TRANSITION_PAYLOAD_LIMIT - transitionBaseBytes,
    );
    const transitionJson = JSON.stringify(transitionPayload);
    expect(Buffer.byteLength(transitionJson)).toBe(TRANSITION_PAYLOAD_LIMIT);

    const transition = seedProjection({ events: [initialStart()], state: "verifying" });
    replacePayload(transition.database, 2, transitionJson);
    expect(() =>
      transition.store.getRunVerificationAttempts(UNIT_RUN_ID, transition.snapshot),
    ).not.toThrow();
    replacePayload(transition.database, 2, transitionJson.replace(/"}}$/, 'x"}}'));
    expectCode(
      () => transition.store.getRunVerificationAttempts(UNIT_RUN_ID, transition.snapshot),
      "DATABASE_ERROR",
    );
    transition.database.close();
    transition.store.close();

    const completionPayload = {
      ...(completed().payload as Record<string, unknown>),
      privatePadding: "",
    };
    const completionBaseBytes = Buffer.byteLength(JSON.stringify(completionPayload));
    completionPayload.privatePadding = multibytePadding(
      COMPLETION_PAYLOAD_LIMIT - completionBaseBytes,
    );
    const completionJson = JSON.stringify(completionPayload);
    expect(Buffer.byteLength(completionJson)).toBe(COMPLETION_PAYLOAD_LIMIT);

    const completion = seedProjection({
      events: [initialStart(), checkpointSaved(), completed()],
      state: "awaiting_review",
      checkpoint: true,
    });
    replacePayload(completion.database, 4, completionJson);
    expect(() =>
      completion.store.getRunVerificationAttempts(UNIT_RUN_ID, completion.snapshot),
    ).not.toThrow();
    replacePayload(completion.database, 4, completionJson.replace(/"}$/, 'x"}'));
    expectCode(
      () => completion.store.getRunVerificationAttempts(UNIT_RUN_ID, completion.snapshot),
      "DATABASE_ERROR",
    );
    completion.database.close();
    completion.store.close();
  });

  test("rejects JSON5, duplicate selected keys, BLOBs, numbers, and sequence gaps", () => {
    const corruptPayloads: readonly (string | number | Buffer)[] = [
      "{from:'running',to:'verifying',detail:{}}",
      '{"from":"running","from":"running","to":"verifying","detail":{}}',
      Buffer.from(JSON.stringify(initialStart().payload)),
      7,
    ];
    for (const payload of corruptPayloads) {
      const fixture = seedProjection({
        events: [initialStart()],
        state: "verifying",
      });
      replacePayload(fixture.database, 2, payload);
      expectCode(
        () => fixture.store.getRunVerificationAttempts(UNIT_RUN_ID, fixture.snapshot),
        "DATABASE_ERROR",
      );
      fixture.database.close();
      fixture.store.close();
    }

    const duplicateNested = seedProjection({
      events: [initialStart(), checkpointSaved(), completed()],
      state: "awaiting_review",
      checkpoint: true,
    });
    replacePayload(
      duplicateNested.database,
      4,
      `{"from":"verifying","to":"awaiting_review","outcome":"passed","diffSha256":"${DIFF_SHA256}","verification":{"outcome":"passed","diffSha256":"${DIFF_SHA256}","checkpointSha256":"${CHECKPOINT_SHA256}","checkpointSha256":"${CHECKPOINT_SHA256}"}}`,
    );
    expectCode(
      () => duplicateNested.store.getRunVerificationAttempts(UNIT_RUN_ID, duplicateNested.snapshot),
      "DATABASE_ERROR",
    );
    duplicateNested.database.close();
    duplicateNested.store.close();

    for (const events of [
      [{ ...initialStart(), payload: { from: 7, to: "verifying", detail: {} } }],
      [{ ...checkpointSaved(), payload: { checkpointSha256: 7 } }],
      [
        initialStart(),
        checkpointSaved(),
        {
          ...completed(),
          payload: {
            ...(completed().payload as Record<string, unknown>),
            outcome: 7,
          },
        },
      ],
    ] as const) {
      const wrongScalar = seedProjection({
        events,
        state:
          events.length === 1 && events[0]?.type === "edit.materialized"
            ? "verifying"
            : "awaiting_review",
        checkpoint: events[0]?.type === "checkpoint.saved" || events.length > 1,
      });
      expectCode(
        () => wrongScalar.store.getRunVerificationAttempts(UNIT_RUN_ID, wrongScalar.snapshot),
        "DATABASE_ERROR",
      );
      wrongScalar.database.close();
      wrongScalar.store.close();
    }

    const gap = seedProjection({
      events: [initialStart(), checkpointSaved(), irrelevant(1), completed()],
      state: "awaiting_review",
      checkpoint: true,
    });
    gap.database
      .prepare("DELETE FROM run_events WHERE run_id = ? AND sequence = ?")
      .run(UNIT_RUN_ID, 4);
    expectCode(
      () => gap.store.getRunVerificationAttempts(UNIT_RUN_ID, gap.snapshot),
      "DATABASE_ERROR",
    );
    gap.database.close();
    gap.store.close();
  });

  test("refuses to bridge an interval across contradictory selected transitions", () => {
    const contradictions = [
      {
        type: "run.resumed",
        payload: { from: "failed", to: "running" },
      },
      {
        type: "run.failed",
        payload: {
          from: "verifying",
          to: "failed",
          resumeState: "running",
          code: "INTERRUPTED",
          message: PRIVATE_SENTINEL,
        },
      },
    ] as const;

    for (const contradiction of contradictions) {
      const fixture = seedProjection({
        events: [initialStart(), checkpointSaved(), contradiction, completed()],
        state: "awaiting_review",
        checkpoint: true,
      });
      expectCode(
        () => fixture.store.getRunVerificationAttempts(UNIT_RUN_ID, fixture.snapshot),
        "DATABASE_ERROR",
      );
      fixture.database.close();
      fixture.store.close();
    }
  });

  test("uses exact-current snapshots and indexed fixed-range/exact-anchor lookups", () => {
    const fixture = seedProjection({
      events: [initialStart(), checkpointSaved(), completed()],
      state: "awaiting_review",
      checkpoint: true,
    });
    const first = fixture.store.getRunVerificationAttempts(UNIT_RUN_ID, fixture.snapshot);
    expect(first.snapshot).toBe(4);

    fixture.database
      .prepare(
        `INSERT INTO run_events (run_id, sequence, type, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(UNIT_RUN_ID, 5, "review.rejected", "not-json-private", timestamp(5));
    expectCode(
      () => fixture.store.getRunVerificationAttempts(UNIT_RUN_ID, fixture.snapshot),
      "EVENT_SNAPSHOT_CONFLICT",
    );

    const rangePlan = fixture.database
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT sequence, run_id, type, created_at
         FROM run_events
         WHERE run_id = ? AND sequence >= ? AND sequence <= ?
         ORDER BY sequence`,
      )
      .all(UNIT_RUN_ID, 1, 5)
      .map((entry) => String((entry as Record<string, unknown>).detail));
    const exactPlan = fixture.database
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT sequence, typeof(payload_json), octet_length(payload_json)
         FROM run_events WHERE run_id = ? AND sequence = ?`,
      )
      .all(UNIT_RUN_ID, 4)
      .map((entry) => String((entry as Record<string, unknown>).detail));
    expect(
      [...rangePlan, ...exactPlan].every((detail) =>
        detail.includes("sqlite_autoindex_run_events_1"),
      ),
    ).toBe(true);
    expect(
      [...rangePlan, ...exactPlan].every((detail) => !detail.includes("SCAN run_events")),
    ).toBe(true);

    fixture.database.close();
    fixture.store.close();

    const reopened = new IcarusStore(fixture.databasePath, {
      now: () => timestamp(10),
      id: makeUnitIdGenerator(),
    });
    expect(reopened.getRunVerificationAttempts(UNIT_RUN_ID, 5).attempts).toHaveLength(1);
    reopened.close();
  });

  test("keeps checkpoint and event state coherent when a WAL append lands after revision read", () => {
    const fixture = seedProjection({
      events: [initialStart()],
      state: "verifying",
    });
    const writer = new Database(fixture.databasePath);
    let appended = false;
    const instrumented = new Proxy(fixture.database, {
      get(target, property) {
        if (property === "prepare") {
          return (sql: string) => {
            const statement = target.prepare(sql);
            if (!sql.includes("SELECT COALESCE(MAX(sequence), 0) AS revision")) {
              return statement;
            }
            return new Proxy(statement, {
              get(statementTarget, statementProperty) {
                const value = Reflect.get(statementTarget, statementProperty);
                if (statementProperty !== "get" || typeof value !== "function") {
                  return typeof value === "function" ? value.bind(statementTarget) : value;
                }
                return (...parameters: unknown[]) => {
                  const revision = value.apply(statementTarget, parameters);
                  writer.transaction(() => {
                    writer
                      .prepare(
                        `INSERT INTO checkpoints
                           (run_id, baseline_base64, approved_base64,
                            checkpoint_sha256, created_at)
                         VALUES (?, ?, ?, ?, ?)`,
                      )
                      .run(
                        UNIT_RUN_ID,
                        Buffer.from(PRIVATE_SENTINEL).toString("base64"),
                        Buffer.from(`${PRIVATE_SENTINEL}-approved`).toString("base64"),
                        CHECKPOINT_SHA256,
                        timestamp(fixture.snapshot + 1),
                      );
                    writer
                      .prepare(
                        `INSERT INTO run_events
                           (run_id, sequence, type, payload_json, created_at)
                         VALUES (?, ?, ?, ?, ?)`,
                      )
                      .run(
                        UNIT_RUN_ID,
                        fixture.snapshot + 1,
                        "checkpoint.saved",
                        JSON.stringify({ checkpointSha256: CHECKPOINT_SHA256 }),
                        timestamp(fixture.snapshot + 1),
                      );
                  })();
                  appended = true;
                  return revision;
                };
              },
            });
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Parameters<typeof readRunVerificationAttempts>[0];

    const result = readRunVerificationAttempts(instrumented, UNIT_RUN_ID, fixture.snapshot);
    expect(appended).toBe(true);
    expect(result.snapshot).toBe(fixture.snapshot);
    expect(result.coverage.lastSequence).toBe(fixture.snapshot);
    expect(result.checkpoint).toEqual({ status: "not_saved" });
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]).toMatchObject({
      status: "incomplete_at_snapshot",
      checkpointSha256: null,
      checkpointProvenance: "not_available",
    });
    expectCode(
      () => fixture.store.getRunVerificationAttempts(UNIT_RUN_ID, fixture.snapshot),
      "EVENT_SNAPSHOT_CONFLICT",
    );
    expect(
      fixture.store.getRunVerificationAttempts(UNIT_RUN_ID, fixture.snapshot + 1).checkpoint,
    ).toMatchObject({
      status: "saved",
      sha256: CHECKPOINT_SHA256,
      saveEvent: { status: "observed_in_coverage", sequence: fixture.snapshot + 1 },
    });

    writer.close();
    fixture.database.close();
    fixture.store.close();
  });
});
