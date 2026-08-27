import { createHash } from "node:crypto";

import { canonicalJsonLine } from "./canonical-json.js";
import { digestJson } from "./digest.js";
import { IcarusError, invariant } from "./errors.js";
import {
  decodeHeadlessChildSettlementV1,
  type HeadlessChildSettlementV1,
} from "./headless-children.js";
import { inspectHeadlessWorkerLifecycleV1 } from "./headless-worker.js";
import type {
  ApprovalRecord,
  CapabilityGrant,
  EventRecord,
  FileEditOperation,
  JsonValue,
  RunHistory,
  RunState,
  RunUsage,
  VerificationEvidence,
} from "./types.js";

export const HEADLESS_STREAM_SCHEMA = "icarus.headless.stream.v1" as const;

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

/**
 * Where a stream line's evidence lives in the authoritative record. Every
 * line cites its source so a consumer can resolve any projected event back to
 * the exact durable event sequence or approval digest it was derived from.
 */
export type HeadlessStreamSourceV1 =
  | { readonly type: "event"; readonly sequence: number; readonly eventType: string }
  | {
      readonly type: "approval";
      readonly approvalKind: ApprovalRecord["kind"];
      readonly digest: string;
    }
  | { readonly type: "snapshot" };

interface HeadlessStreamLineBaseV1 {
  readonly schema: typeof HEADLESS_STREAM_SCHEMA;
  /** 1-based ordinal inside this stream; not the durable event sequence. */
  readonly sequence: number;
  readonly runId: string;
  readonly createdAt: string;
  readonly source: HeadlessStreamSourceV1;
}

export interface HeadlessStreamInitLineV1 extends HeadlessStreamLineBaseV1 {
  readonly kind: "init";
  readonly phase: "run_created" | "worker_started";
  readonly baseCommit: string | null;
  readonly contextSha256: string | null;
  readonly bindingDigestSha256: string | null;
  readonly profileId: string | null;
  readonly providerProfileId: string | null;
  readonly toolIds: readonly string[];
}

export interface HeadlessStreamPlanLineV1 extends HeadlessStreamLineBaseV1 {
  readonly kind: "plan";
  readonly planSha256: string;
  readonly targets: readonly string[];
  readonly checkIds: readonly string[];
  readonly grants: readonly CapabilityGrant[];
  readonly iterationCeiling: number;
}

export interface HeadlessStreamGrantLineV1 extends HeadlessStreamLineBaseV1 {
  readonly kind: "grant";
  readonly approvalKind: ApprovalRecord["kind"];
  readonly digest: string;
  readonly actor: string;
  readonly decision: ApprovalRecord["decision"];
}

export interface HeadlessStreamPatchSetLineV1 extends HeadlessStreamLineBaseV1 {
  readonly kind: "patchset";
  readonly action: "intent_recorded" | "superseded" | "materialized";
  readonly patchSetSha256: string | null;
  readonly paths: readonly string[];
  readonly operations: readonly FileEditOperation[] | null;
  readonly approvedSha256: string | null;
}

export interface HeadlessStreamCheckEntryV1 {
  readonly checkId: string;
  readonly outcome: "passed" | "failed" | "unavailable" | "cancelled";
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly durationMs: number;
  readonly truncated: boolean;
}

export interface HeadlessStreamCheckLineV1 extends HeadlessStreamLineBaseV1 {
  readonly kind: "check";
  readonly outcome: VerificationEvidence["outcome"];
  readonly diffSha256: string;
  readonly checkpointSha256: string;
  readonly checks: readonly HeadlessStreamCheckEntryV1[];
}

export interface HeadlessStreamReceiptLineV1 extends HeadlessStreamLineBaseV1 {
  readonly kind: "receipt";
  readonly receiptKind: "worker" | "child";
  readonly settlementSchema: string;
  readonly outcome: string;
  readonly exitCode: number;
  readonly bindingDigestSha256: string | null;
  readonly childRunId: string | null;
}

export interface HeadlessStreamResultLineV1 extends HeadlessStreamLineBaseV1 {
  readonly kind: "result";
  readonly finalState: RunState;
  readonly verificationOutcome: "passed" | "failed" | "unavailable" | null;
  readonly settlement: {
    readonly schema: string;
    readonly outcome: string;
    readonly exitCode: number;
    readonly bindingDigestSha256: string;
  } | null;
  readonly usage: RunUsage;
  readonly approvalCount: number;
  readonly eventCount: number;
  readonly lastEventSequence: number;
  /** SHA-256 over every preceding canonical JSONL record, including newlines. */
  readonly contentSha256: string;
}

export type HeadlessStreamContentLineV1 =
  | HeadlessStreamInitLineV1
  | HeadlessStreamPlanLineV1
  | HeadlessStreamGrantLineV1
  | HeadlessStreamPatchSetLineV1
  | HeadlessStreamCheckLineV1
  | HeadlessStreamReceiptLineV1;

export type HeadlessStreamLineV1 = HeadlessStreamContentLineV1 | HeadlessStreamResultLineV1;

export function headlessStreamContentSha256(lines: readonly HeadlessStreamContentLineV1[]): string {
  const digest = createHash("sha256");
  for (const line of lines) digest.update(canonicalJsonLine(line));
  return digest.digest("hex");
}

function eventPayload(event: EventRecord, label: string): Readonly<Record<string, JsonValue>> {
  invariant(
    typeof event.payload === "object" && event.payload !== null && !Array.isArray(event.payload),
    "INVALID_HEADLESS_STREAM",
    `${label} payload is malformed`,
  );
  return event.payload;
}

function payloadDigest(
  payload: Readonly<Record<string, JsonValue>>,
  member: string,
  label: string,
): string {
  const value = payload[member];
  invariant(
    typeof value === "string" && DIGEST_PATTERN.test(value),
    "INVALID_HEADLESS_STREAM",
    `${label} ${member} is malformed`,
  );
  return value;
}

function payloadStringList(
  payload: Readonly<Record<string, JsonValue>>,
  member: string,
  label: string,
): readonly string[] {
  const value = payload[member];
  invariant(
    Array.isArray(value) && value.every((entry) => typeof entry === "string"),
    "INVALID_HEADLESS_STREAM",
    `${label} ${member} is malformed`,
  );
  return value as readonly string[];
}

const FILE_EDIT_OPERATIONS = new Set<FileEditOperation>(["modify", "create", "delete"]);

function payloadOperations(
  payload: Readonly<Record<string, JsonValue>>,
  label: string,
): readonly FileEditOperation[] {
  const value = payload.operations;
  invariant(
    Array.isArray(value) &&
      value.every(
        (entry) =>
          typeof entry === "string" && FILE_EDIT_OPERATIONS.has(entry as FileEditOperation),
      ),
    "INVALID_HEADLESS_STREAM",
    `${label} operations are malformed`,
  );
  return value as readonly FileEditOperation[];
}

function checkEntries(payload: Readonly<Record<string, JsonValue>>): {
  readonly outcome: VerificationEvidence["outcome"];
  readonly diffSha256: string;
  readonly checkpointSha256: string;
  readonly checks: readonly HeadlessStreamCheckEntryV1[];
} {
  const verification = payload.verification;
  invariant(
    typeof verification === "object" && verification !== null && !Array.isArray(verification),
    "INVALID_HEADLESS_STREAM",
    "Check payload verification is malformed",
  );
  const outcome = verification.outcome;
  invariant(
    outcome === "passed" || outcome === "failed" || outcome === "unavailable",
    "INVALID_HEADLESS_STREAM",
    "Check payload outcome is malformed",
  );
  const checks = verification.checks;
  invariant(Array.isArray(checks), "INVALID_HEADLESS_STREAM", "Check payload checks are malformed");
  const entries = checks.map((entry): HeadlessStreamCheckEntryV1 => {
    invariant(
      typeof entry === "object" && entry !== null && !Array.isArray(entry),
      "INVALID_HEADLESS_STREAM",
      "Check entry is malformed",
    );
    const { checkId, outcome: checkOutcome, exitCode, signal, durationMs, truncated } = entry;
    invariant(
      typeof checkId === "string" &&
        (checkOutcome === "passed" ||
          checkOutcome === "failed" ||
          checkOutcome === "unavailable" ||
          checkOutcome === "cancelled") &&
        (exitCode === null || (typeof exitCode === "number" && Number.isSafeInteger(exitCode))) &&
        (signal === null || typeof signal === "string") &&
        typeof durationMs === "number" &&
        Number.isSafeInteger(durationMs) &&
        durationMs >= 0 &&
        typeof truncated === "boolean",
      "INVALID_HEADLESS_STREAM",
      "Check entry is malformed",
    );
    return { checkId, outcome: checkOutcome, exitCode, signal, durationMs, truncated };
  });
  return {
    outcome,
    diffSha256: payloadDigest(verification, "diffSha256", "Check payload"),
    checkpointSha256: payloadDigest(verification, "checkpointSha256", "Check payload"),
    checks: entries,
  };
}

function receiptFields(
  payload: Readonly<Record<string, JsonValue>>,
  child: boolean,
  runId: string,
): {
  readonly settlementSchema: string;
  readonly outcome: string;
  readonly exitCode: number;
  readonly bindingDigestSha256: string | null;
  readonly childRunId: string | null;
} {
  const { schema, outcome, exitCode } = payload;
  const label = child ? "Child settlement" : "Worker settlement";
  invariant(
    typeof schema === "string" &&
      typeof outcome === "string" &&
      typeof exitCode === "number" &&
      Number.isSafeInteger(exitCode),
    "INVALID_HEADLESS_STREAM",
    `${label} is malformed`,
  );
  if (child) {
    const settlement = childSettlementForStream(payload, runId);
    return {
      settlementSchema: settlement.schema,
      outcome: settlement.outcome,
      exitCode: settlement.exitCode,
      bindingDigestSha256: settlement.childBindingDigestSha256,
      childRunId: settlement.childRunId,
    };
  }
  return {
    settlementSchema: schema,
    outcome,
    exitCode,
    bindingDigestSha256: payloadDigest(payload, "bindingDigestSha256", label),
    childRunId: null,
  };
}

function childSettlementForStream(
  payload: Readonly<Record<string, JsonValue>>,
  runId: string,
): HeadlessChildSettlementV1 {
  try {
    return decodeHeadlessChildSettlementV1(payload, runId);
  } catch (error) {
    if (error instanceof IcarusError) {
      throw new IcarusError(
        "INVALID_HEADLESS_STREAM",
        `Child settlement is malformed: ${error.message}`,
      );
    }
    throw error;
  }
}

function assertValidWorkerLifecycle(runId: string, events: readonly EventRecord[]): void {
  try {
    inspectHeadlessWorkerLifecycleV1(runId, events);
  } catch (error) {
    if (error instanceof IcarusError) {
      throw new IcarusError(
        "INVALID_HEADLESS_STREAM",
        `Headless worker lifecycle is malformed: ${error.message}`,
      );
    }
    throw error;
  }
}

function assertValidChildLifecycle(runId: string, events: readonly EventRecord[]): void {
  const childEvents = events.filter((event) => event.type === "headless.child.settled");

  const started = events.find((event) => event.type === "headless.worker.started");
  const startedPayload =
    started === undefined ? null : eventPayload(started, "Headless worker start");
  const declaredChildren = startedPayload?.children;
  if (childEvents.length === 0 && declaredChildren === undefined) return;
  invariant(
    Array.isArray(declaredChildren),
    "INVALID_HEADLESS_STREAM",
    "Headless child settlement lacks its worker-start declaration",
  );
  const declaredChildIds = declaredChildren.map((entry) => {
    invariant(
      typeof entry === "object" &&
        entry !== null &&
        !Array.isArray(entry) &&
        typeof entry.childId === "string",
      "INVALID_HEADLESS_STREAM",
      "Headless worker child declaration is malformed",
    );
    return entry.childId;
  });
  invariant(
    new Set(declaredChildIds).size === declaredChildIds.length,
    "INVALID_HEADLESS_STREAM",
    "Headless worker child declaration identity is duplicated",
  );
  if (declaredChildIds.length === 0 && childEvents.length === 0) return;
  const workerSettlements = events.filter((event) => event.type === "headless.worker.settled");
  const firstWorkerSettlement = workerSettlements[0];
  const secondWorkerSettlement = workerSettlements[1];
  const applyRequest = events.find((event) => event.type === "headless.worker.apply_requested");
  const resumeRequest = events.find((event) => event.type === "headless.worker.resume_requested");
  const firstSettlementSchema =
    firstWorkerSettlement === undefined
      ? null
      : eventPayload(firstWorkerSettlement, "Worker settlement").schema;
  const applicationEpoch = applyRequest !== undefined;
  const epochStart = applicationEpoch ? applyRequest : started;
  const epochEnd = applicationEpoch ? secondWorkerSettlement : firstWorkerSettlement;
  invariant(
    epochStart !== undefined &&
      resumeRequest === undefined &&
      (!applicationEpoch || firstSettlementSchema === "icarus.headless.worker-proposal.v1") &&
      (applicationEpoch ||
        firstSettlementSchema !== "icarus.headless.worker-proposal.v1" ||
        childEvents.length === 0) &&
      childEvents.every(
        (event) =>
          event.sequence > epochStart.sequence &&
          (epochEnd === undefined || event.sequence < epochEnd.sequence),
      ),
    "INVALID_HEADLESS_STREAM",
    "Headless child settlement is outside the parent worker lifecycle",
  );

  const childIds = new Set<string>();
  const childRunIds = new Set<string>();
  let previousOutcome: HeadlessChildSettlementV1["outcome"] | null = null;
  for (const [index, event] of childEvents.entries()) {
    const settlement = childSettlementForStream(eventPayload(event, "Child settlement"), runId);
    invariant(
      declaredChildIds[index] === settlement.childId &&
        (previousOutcome === null || previousOutcome === "review_ready"),
      "INVALID_HEADLESS_STREAM",
      "Headless child settlement does not match its declared sequence",
    );
    invariant(
      !childIds.has(settlement.childId),
      "INVALID_HEADLESS_STREAM",
      "Headless child settlement identity is duplicated",
    );
    childIds.add(settlement.childId);
    previousOutcome = settlement.outcome;
    if (settlement.childRunId !== null) {
      invariant(
        !childRunIds.has(settlement.childRunId),
        "INVALID_HEADLESS_STREAM",
        "Headless child run identity is duplicated",
      );
      childRunIds.add(settlement.childRunId);
    }
  }
  const epochEndOutcome =
    epochEnd === undefined ? null : eventPayload(epochEnd, "Worker settlement").outcome;
  invariant(
    epochEndOutcome !== "review_ready" || childEvents.length === declaredChildIds.length,
    "INVALID_HEADLESS_STREAM",
    "Successful parent settlement is missing declared child evidence",
  );
}

/**
 * Projects the authoritative run history snapshot into a typed NDJSON event
 * stream (ADR 0061). The stream is a presentation projection only: it appends
 * nothing, carries no authority, and every line cites the durable event
 * sequence or approval digest it was derived from. Given the same snapshot
 * the output is byte-identical under canonical JSONL encoding.
 */
export function createHeadlessStreamLines(history: RunHistory): readonly HeadlessStreamLineV1[] {
  const { run, approvals, events } = history;
  const runId = run.id;
  for (const approval of approvals) {
    invariant(
      approval.runId === runId,
      "INVALID_HEADLESS_STREAM",
      "Headless stream approval belongs to a different run",
    );
  }
  let previousSequence = 0;
  for (const event of events) {
    invariant(
      event.runId === runId,
      "INVALID_HEADLESS_STREAM",
      "Headless stream event belongs to a different run",
    );
    invariant(
      Number.isSafeInteger(event.sequence) && event.sequence > previousSequence,
      "INVALID_HEADLESS_STREAM",
      "Headless stream event sequence must be positive and strictly increasing",
      { previousSequence, sequence: event.sequence },
    );
    previousSequence = event.sequence;
  }
  assertValidWorkerLifecycle(runId, events);
  assertValidChildLifecycle(runId, events);

  const runCreated = events.filter((event) => event.type === "run.created");
  invariant(
    runCreated.length === 1 && runCreated[0] !== undefined,
    "INVALID_HEADLESS_STREAM",
    "Headless stream history must contain exactly one run creation",
  );

  const baseCommit = run.baseCommit.length > 0 ? run.baseCommit : null;
  const contextSha256 = run.contextSha256.length > 0 ? run.contextSha256 : null;
  const content: HeadlessStreamContentLineV1[] = [];
  const push = <T extends HeadlessStreamContentLineV1>(line: Omit<T, "schema" | "sequence">): T => {
    const stored = {
      schema: HEADLESS_STREAM_SCHEMA,
      sequence: content.length + 1,
      ...line,
    } as T;
    content.push(stored);
    return stored;
  };

  const created = runCreated[0];
  push<HeadlessStreamInitLineV1>({
    runId,
    kind: "init",
    phase: "run_created",
    createdAt: created.createdAt,
    source: { type: "event", sequence: created.sequence, eventType: created.type },
    baseCommit,
    contextSha256,
    bindingDigestSha256: null,
    profileId: null,
    providerProfileId: null,
    toolIds: [],
  });

  // Authority grants precede the evidence chronology, mirroring the H0
  // history envelope; each grant cites its approval digest and timestamp so a
  // consumer can place it in exact time order when it needs to.
  for (const approval of approvals) {
    push<HeadlessStreamGrantLineV1>({
      runId,
      kind: "grant",
      createdAt: approval.createdAt,
      source: { type: "approval", approvalKind: approval.kind, digest: approval.digest },
      approvalKind: approval.kind,
      digest: approval.digest,
      actor: approval.actor,
      decision: approval.decision,
    });
  }

  // Patch-set digest binding: a supersession event carries the digest of the
  // set it replaces, which is always the most recent unbound intent; the
  // surviving set's digest is recomputed from the run snapshot and bound to
  // the one remaining unbound intent. Any other shape is malformed history.
  const unboundIntents: number[] = [];
  const bindIntent = (digest: string): void => {
    const index = unboundIntents.pop();
    invariant(
      index !== undefined,
      "INVALID_HEADLESS_STREAM",
      "Headless stream patch-set supersession lacks its intent",
    );
    const line = content[index];
    invariant(
      line !== undefined && line.kind === "patchset" && line.action === "intent_recorded",
      "INVALID_HEADLESS_STREAM",
      "Headless stream patch-set supersession lacks its intent",
    );
    content[index] = { ...(line as HeadlessStreamPatchSetLineV1), patchSetSha256: digest };
  };

  let lastWorkerSettlement: HeadlessStreamReceiptLineV1 | null = null;

  for (const event of events) {
    const source: HeadlessStreamSourceV1 = {
      type: "event",
      sequence: event.sequence,
      eventType: event.type,
    };
    if (event.type === "headless.worker.started") {
      const payload = eventPayload(event, "Worker start");
      const { profileId, providerProfileId, toolIds } = payload;
      invariant(
        typeof profileId === "string" &&
          typeof providerProfileId === "string" &&
          Array.isArray(toolIds) &&
          toolIds.every((toolId) => typeof toolId === "string"),
        "INVALID_HEADLESS_STREAM",
        "Worker start payload is malformed",
      );
      push<HeadlessStreamInitLineV1>({
        runId,
        kind: "init",
        phase: "worker_started",
        createdAt: event.createdAt,
        source,
        baseCommit,
        contextSha256,
        bindingDigestSha256: payloadDigest(payload, "bindingDigestSha256", "Worker start"),
        profileId,
        providerProfileId,
        toolIds: toolIds as readonly string[],
      });
      continue;
    }
    if (event.type === "plan.created") {
      invariant(
        run.plan !== null && run.planSha256 !== null,
        "INVALID_HEADLESS_STREAM",
        "Headless stream plan event lacks its persisted plan",
      );
      push<HeadlessStreamPlanLineV1>({
        runId,
        kind: "plan",
        createdAt: event.createdAt,
        source,
        planSha256: run.planSha256,
        targets: run.plan.targets,
        checkIds: run.plan.checkIds,
        grants: run.plan.grants,
        iterationCeiling: run.plan.iterationCeiling,
      });
      continue;
    }
    if (event.type === "patch_set.intent_recorded") {
      const payload = eventPayload(event, "Patch-set intent");
      push<HeadlessStreamPatchSetLineV1>({
        runId,
        kind: "patchset",
        action: "intent_recorded",
        createdAt: event.createdAt,
        source,
        patchSetSha256: null,
        paths: payloadStringList(payload, "paths", "Patch-set intent"),
        operations: payloadOperations(payload, "Patch-set intent"),
        approvedSha256: null,
      });
      unboundIntents.push(content.length - 1);
      continue;
    }
    if (event.type === "patch_set.superseded") {
      const payload = eventPayload(event, "Patch-set supersession");
      const digest = payloadDigest(payload, "digest", "Patch-set supersession");
      push<HeadlessStreamPatchSetLineV1>({
        runId,
        kind: "patchset",
        action: "superseded",
        createdAt: event.createdAt,
        source,
        patchSetSha256: digest,
        paths: payloadStringList(payload, "paths", "Patch-set supersession"),
        operations: null,
        approvedSha256: null,
      });
      bindIntent(digest);
      continue;
    }
    if (event.type === "edit.materialized") {
      const payload = eventPayload(event, "Patch-set materialization");
      // Transition-emitted events wrap their domain payload in `detail`.
      const detail = payload.detail;
      invariant(
        typeof detail === "object" && detail !== null && !Array.isArray(detail),
        "INVALID_HEADLESS_STREAM",
        "Patch-set materialization detail is malformed",
      );
      const target = detail.target;
      invariant(
        typeof target === "string",
        "INVALID_HEADLESS_STREAM",
        "Patch-set materialization target is malformed",
      );
      push<HeadlessStreamPatchSetLineV1>({
        runId,
        kind: "patchset",
        action: "materialized",
        createdAt: event.createdAt,
        source,
        patchSetSha256: null,
        paths: [target],
        operations: null,
        approvedSha256: payloadDigest(detail, "approvedSha256", "Patch-set materialization"),
      });
      continue;
    }
    if (event.type === "verification.completed") {
      const payload = eventPayload(event, "Check");
      const verification = checkEntries(payload);
      push<HeadlessStreamCheckLineV1>({
        runId,
        kind: "check",
        createdAt: event.createdAt,
        source,
        outcome: verification.outcome,
        diffSha256: verification.diffSha256,
        checkpointSha256: verification.checkpointSha256,
        checks: verification.checks,
      });
      continue;
    }
    if (event.type === "headless.worker.settled" || event.type === "headless.child.settled") {
      const child = event.type === "headless.child.settled";
      const receipt = receiptFields(eventPayload(event, "Settlement"), child, runId);
      const line = push<HeadlessStreamReceiptLineV1>({
        runId,
        kind: "receipt",
        receiptKind: child ? "child" : "worker",
        createdAt: event.createdAt,
        source,
        settlementSchema: receipt.settlementSchema,
        outcome: receipt.outcome,
        exitCode: receipt.exitCode,
        bindingDigestSha256: receipt.bindingDigestSha256,
        childRunId: receipt.childRunId,
      });
      if (!child) lastWorkerSettlement = line;
    }
    // Every other durable event type stays available through the H0 history
    // envelope; the stream is a curated projection, not a replay.
  }

  // Bind the surviving patch set, recomputed exactly as the store digests it.
  // Runs recorded before ADR 0023 have a synthesized patch set but no intent
  // event, so binding happens only when an unbound intent actually exists.
  if (unboundIntents.length > 0) {
    invariant(
      run.patchSet !== null && unboundIntents.length === 1,
      "INVALID_HEADLESS_STREAM",
      "Headless stream patch-set intent lacks its digest",
    );
    bindIntent(digestJson(run.patchSet as unknown as JsonValue));
  }

  const settlement =
    lastWorkerSettlement !== null && lastWorkerSettlement.bindingDigestSha256 !== null
      ? {
          schema: lastWorkerSettlement.settlementSchema,
          outcome: lastWorkerSettlement.outcome,
          exitCode: lastWorkerSettlement.exitCode,
          bindingDigestSha256: lastWorkerSettlement.bindingDigestSha256,
        }
      : null;
  const result: HeadlessStreamResultLineV1 = {
    schema: HEADLESS_STREAM_SCHEMA,
    sequence: content.length + 1,
    runId,
    kind: "result",
    createdAt: run.updatedAt,
    source: { type: "snapshot" },
    finalState: run.state,
    verificationOutcome: run.verification?.outcome ?? null,
    settlement,
    usage: { ...run.usage },
    approvalCount: approvals.length,
    eventCount: events.length,
    lastEventSequence: previousSequence,
    contentSha256: headlessStreamContentSha256(content),
  };
  return [...content, result];
}
