import { describe, expect, test } from "vitest";
import {
  createHeadlessHistoryLines,
  HEADLESS_HISTORY_SCHEMA,
} from "../../packages/core/src/headless-history.js";

const RUN_ID = "11111111-1111-4111-8111-111111111111";

describe("headless history stream", () => {
  test("emits one reconstructable stream over the existing run snapshot", () => {
    const lines = createHeadlessHistoryLines(
      RUN_ID,
      { id: RUN_ID, state: "completed" },
      [
        {
          runId: RUN_ID,
          kind: "plan",
          digest: "plan-sha",
          actor: "operator",
          decision: "approve",
          createdAt: "2026-08-16T12:00:00.000Z",
        },
      ],
      [
        {
          sequence: 1,
          runId: RUN_ID,
          type: "run.created",
          payload: { task: "inspect" },
          createdAt: "2026-08-16T12:00:01.000Z",
        },
        {
          sequence: 2,
          runId: RUN_ID,
          type: "run.completed",
          payload: { result: "ok" },
          createdAt: "2026-08-16T12:00:02.000Z",
        },
      ],
    );

    expect(lines).toEqual([
      { schema: HEADLESS_HISTORY_SCHEMA, kind: "run", run: { id: RUN_ID, state: "completed" } },
      {
        schema: HEADLESS_HISTORY_SCHEMA,
        kind: "approval",
        approval: expect.objectContaining({ kind: "plan", decision: "approve" }),
      },
      {
        schema: HEADLESS_HISTORY_SCHEMA,
        kind: "event",
        sequence: 1,
        runId: RUN_ID,
        type: "run.created",
        payload: { task: "inspect" },
        createdAt: "2026-08-16T12:00:01.000Z",
      },
      {
        schema: HEADLESS_HISTORY_SCHEMA,
        kind: "event",
        sequence: 2,
        runId: RUN_ID,
        type: "run.completed",
        payload: { result: "ok" },
        createdAt: "2026-08-16T12:00:02.000Z",
      },
      {
        schema: HEADLESS_HISTORY_SCHEMA,
        kind: "end",
        runId: RUN_ID,
        eventCount: 2,
        lastSequence: 2,
      },
    ]);
  });

  test("fails closed when a snapshot contains another run's record", () => {
    expect(() =>
      createHeadlessHistoryLines(
        RUN_ID,
        { id: RUN_ID },
        [],
        [
          {
            sequence: 1,
            runId: "22222222-2222-4222-8222-222222222222",
            type: "run.created",
            payload: null,
            createdAt: "2026-08-16T12:00:00.000Z",
          },
        ],
      ),
    ).toThrow("Headless history event belongs to a different run");
  });
});
