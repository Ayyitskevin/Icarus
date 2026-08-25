import { describe, expect, test } from "vitest";
import { canonicalJsonLine } from "../../packages/core/src/canonical-json.js";
import {
  createHeadlessHistoryLines,
  HEADLESS_HISTORY_SCHEMA,
  type HeadlessHistoryContentLine,
  headlessHistoryContentSha256,
} from "../../packages/core/src/headless-history.js";

const RUN_ID = "11111111-1111-4111-8111-111111111111";

function sampleLines() {
  return createHeadlessHistoryLines(
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
}

describe("headless history stream", () => {
  test("emits one deterministic, checksum-terminated stream over the existing run snapshot", () => {
    const lines = sampleLines();

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
        approvalCount: 1,
        eventCount: 2,
        lastSequence: 2,
        contentSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    ]);
    const content = lines.slice(0, -1) as readonly HeadlessHistoryContentLine[];
    expect(lines.at(-1)).toMatchObject({
      contentSha256: headlessHistoryContentSha256(content),
    });
    expect(Buffer.concat(lines.map(canonicalJsonLine))).toEqual(
      Buffer.concat(sampleLines().map(canonicalJsonLine)),
    );
  });

  test("fails closed when the run envelope does not match the requested run", () => {
    expect(() => createHeadlessHistoryLines(RUN_ID, { id: "another-run" }, [], [])).toThrow(
      "Headless history run envelope does not match the requested run",
    );
  });

  test("fails closed when a snapshot contains another run's approval", () => {
    expect(() =>
      createHeadlessHistoryLines(
        RUN_ID,
        { id: RUN_ID },
        [
          {
            runId: "22222222-2222-4222-8222-222222222222",
            kind: "plan",
            digest: "plan-sha",
            actor: "operator",
            decision: "approve",
            createdAt: "2026-08-16T12:00:00.000Z",
          },
        ],
        [],
      ),
    ).toThrow("Headless history approval belongs to a different run");
  });

  test("fails closed when a snapshot contains another run's event", () => {
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

  test("fails closed when event order is not strictly increasing", () => {
    expect(() =>
      createHeadlessHistoryLines(
        RUN_ID,
        { id: RUN_ID },
        [],
        [
          {
            sequence: 2,
            runId: RUN_ID,
            type: "run.created",
            payload: null,
            createdAt: "2026-08-16T12:00:00.000Z",
          },
          {
            sequence: 2,
            runId: RUN_ID,
            type: "run.completed",
            payload: null,
            createdAt: "2026-08-16T12:00:01.000Z",
          },
        ],
      ),
    ).toThrow("Headless history event sequence must be positive and strictly increasing");
  });
});
