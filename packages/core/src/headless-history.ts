import type { ApprovalRecord, EventRecord, JsonValue } from "./types.js";

export const HEADLESS_HISTORY_SCHEMA = "icarus.headless.history.v1" as const;

export interface HeadlessHistoryRunLine {
  readonly schema: typeof HEADLESS_HISTORY_SCHEMA;
  readonly kind: "run";
  readonly run: JsonValue;
}

export interface HeadlessHistoryApprovalLine {
  readonly schema: typeof HEADLESS_HISTORY_SCHEMA;
  readonly kind: "approval";
  readonly approval: ApprovalRecord;
}

export interface HeadlessHistoryEventLine {
  readonly schema: typeof HEADLESS_HISTORY_SCHEMA;
  readonly kind: "event";
  readonly sequence: number;
  readonly runId: string;
  readonly type: string;
  readonly payload: JsonValue;
  readonly createdAt: string;
}

export interface HeadlessHistoryEndLine {
  readonly schema: typeof HEADLESS_HISTORY_SCHEMA;
  readonly kind: "end";
  readonly runId: string;
  readonly eventCount: number;
  readonly lastSequence: number;
}

export type HeadlessHistoryLine =
  | HeadlessHistoryRunLine
  | HeadlessHistoryApprovalLine
  | HeadlessHistoryEventLine
  | HeadlessHistoryEndLine;

/** Build a complete machine stream over an authoritative run history snapshot. */
export function createHeadlessHistoryLines(
  runId: string,
  run: JsonValue,
  approvals: readonly ApprovalRecord[],
  events: readonly EventRecord[],
): readonly HeadlessHistoryLine[] {
  if (approvals.some((approval) => approval.runId !== runId)) {
    throw new Error("Headless history approval belongs to a different run");
  }
  if (events.some((event) => event.runId !== runId)) {
    throw new Error("Headless history event belongs to a different run");
  }

  return [
    { schema: HEADLESS_HISTORY_SCHEMA, kind: "run", run },
    ...approvals.map(
      (approval): HeadlessHistoryApprovalLine => ({
        schema: HEADLESS_HISTORY_SCHEMA,
        kind: "approval",
        approval,
      }),
    ),
    ...events.map(
      (event): HeadlessHistoryEventLine => ({
        schema: HEADLESS_HISTORY_SCHEMA,
        kind: "event",
        sequence: event.sequence,
        runId: event.runId,
        type: event.type,
        payload: event.payload,
        createdAt: event.createdAt,
      }),
    ),
    {
      schema: HEADLESS_HISTORY_SCHEMA,
      kind: "end",
      runId,
      eventCount: events.length,
      lastSequence: events.at(-1)?.sequence ?? 0,
    },
  ];
}
