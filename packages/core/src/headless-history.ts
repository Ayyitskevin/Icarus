import { createHash } from "node:crypto";

import { canonicalJsonLine } from "./canonical-json.js";
import { invariant } from "./errors.js";
import type { ApprovalRecord, EventRecord, JsonValue } from "./types.js";

export const HEADLESS_HISTORY_SCHEMA = "icarus.headless.history.v2" as const;

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
  readonly approvalCount: number;
  readonly eventCount: number;
  readonly lastSequence: number;
  /** SHA-256 over every preceding canonical JSONL record, including newlines. */
  readonly contentSha256: string;
}

export type HeadlessHistoryContentLine =
  | HeadlessHistoryRunLine
  | HeadlessHistoryApprovalLine
  | HeadlessHistoryEventLine;

export type HeadlessHistoryLine = HeadlessHistoryContentLine | HeadlessHistoryEndLine;

export function headlessHistoryContentSha256(lines: readonly HeadlessHistoryContentLine[]): string {
  const digest = createHash("sha256");
  for (const line of lines) digest.update(canonicalJsonLine(line));
  return digest.digest("hex");
}

/** Build a complete machine stream over an authoritative run history snapshot. */
export function createHeadlessHistoryLines(
  runId: string,
  run: JsonValue,
  approvals: readonly ApprovalRecord[],
  events: readonly EventRecord[],
): readonly HeadlessHistoryLine[] {
  invariant(
    typeof run === "object" && run !== null && !Array.isArray(run) && run.id === runId,
    "INVALID_HEADLESS_HISTORY",
    "Headless history run envelope does not match the requested run",
  );
  for (const approval of approvals) {
    invariant(
      approval.runId === runId,
      "INVALID_HEADLESS_HISTORY",
      "Headless history approval belongs to a different run",
    );
  }

  let previousSequence = 0;
  for (const event of events) {
    invariant(
      event.runId === runId,
      "INVALID_HEADLESS_HISTORY",
      "Headless history event belongs to a different run",
    );
    invariant(
      Number.isSafeInteger(event.sequence) && event.sequence > previousSequence,
      "INVALID_HEADLESS_HISTORY",
      "Headless history event sequence must be positive and strictly increasing",
      { previousSequence, sequence: event.sequence },
    );
    previousSequence = event.sequence;
  }

  const content: readonly HeadlessHistoryContentLine[] = [
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
  ];
  return [
    ...content,
    {
      schema: HEADLESS_HISTORY_SCHEMA,
      kind: "end",
      runId,
      approvalCount: approvals.length,
      eventCount: events.length,
      lastSequence: previousSequence,
      contentSha256: headlessHistoryContentSha256(content),
    },
  ];
}
