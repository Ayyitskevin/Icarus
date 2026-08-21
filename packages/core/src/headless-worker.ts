import { IcarusError, invariant } from "./errors.js";
import type { HeadlessExecutionBindingV1 } from "./headless-binding.js";
import type { ToolName } from "./tools.js";
import type { EventRecord, JsonValue, RunRecord, SunCeiling } from "./types.js";

export const HEADLESS_WORKER_SCHEMA = "icarus.headless.worker.v1";

export type HeadlessWorkerOutcomeV1 =
  | "review_ready"
  | "awaiting_human"
  | "exhausted"
  | "cancelled"
  | "failed";

export type HeadlessWorkerExitCodeV1 = 0 | 1 | 2 | 3 | 130;

export interface HeadlessWorkerSettlementV1 {
  readonly schema: typeof HEADLESS_WORKER_SCHEMA;
  readonly runId: string;
  readonly bindingDigestSha256: string;
  readonly outcome: HeadlessWorkerOutcomeV1;
  readonly exitCode: HeadlessWorkerExitCodeV1;
  readonly finalState: RunRecord["state"];
  readonly verificationOutcome: "passed" | "failed" | "unavailable" | null;
  readonly usage: RunRecord["usage"];
  readonly error: { readonly code: string; readonly message: string } | null;
}

export interface HeadlessWorkerExecutionV1 {
  readonly binding: HeadlessExecutionBindingV1;
  readonly settlement: HeadlessWorkerSettlementV1;
  readonly run: RunRecord;
}

export interface ActiveHeadlessExecutionV1 {
  readonly binding: HeadlessExecutionBindingV1;
  readonly ceiling: SunCeiling;
  readonly toolIds: ReadonlySet<ToolName>;
}

export function assertHeadlessWorkerBudgetAvailable(run: RunRecord, ceiling: SunCeiling): void {
  const exhausted =
    run.usage.toolCalls > ceiling.maxToolCalls ||
    run.usage.activeRuntimeMs > ceiling.maxActiveRuntimeMs ||
    run.usage.inputTokens + run.usage.outputTokens > ceiling.maxTotalTokens ||
    run.usage.estimatedCostUsd + run.usage.reservedCostUsd > ceiling.maxCostUsd;
  invariant(
    !exhausted,
    "HEADLESS_PROFILE_ALREADY_EXHAUSTED",
    "Run usage already exceeds the selected headless profile ceiling",
  );
}

const QUIESCENT_STATES = new Set<RunRecord["state"]>([
  "awaiting_review",
  "completed",
  "failed",
  "cancelled",
  "rolled_back",
]);

function latestDisposition(events: readonly EventRecord[]): EventRecord | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (
      event !== undefined &&
      (event.type === "session.completed" ||
        event.type === "session.awaiting_human" ||
        event.type === "session.exhausted")
    ) {
      return event;
    }
  }
  return null;
}

function assertQuiescent(events: readonly EventRecord[]): void {
  const active = new Set<string>();
  for (const event of events) {
    if (
      event.type !== "operation.started" &&
      event.type !== "operation.finished" &&
      event.type !== "operation.interrupted"
    ) {
      continue;
    }
    const payload = event.payload as { readonly operationId?: unknown };
    invariant(
      typeof payload.operationId === "string" && payload.operationId.length > 0,
      "INVALID_HEADLESS_WORKER_HISTORY",
      "Headless worker operation history is malformed",
    );
    if (event.type === "operation.started") active.add(payload.operationId);
    else active.delete(payload.operationId);
  }
  invariant(
    active.size === 0,
    "HEADLESS_WORKER_NOT_QUIESCENT",
    "Headless worker cannot settle with an active operation",
  );
}

function outcomeFor(
  run: RunRecord,
  events: readonly EventRecord[],
): { readonly outcome: HeadlessWorkerOutcomeV1; readonly exitCode: HeadlessWorkerExitCodeV1 } {
  if (run.state === "cancelled") return { outcome: "cancelled", exitCode: 130 };
  if (run.state === "failed") return { outcome: "failed", exitCode: 1 };
  const disposition = latestDisposition(events);
  if (disposition?.type === "session.awaiting_human") {
    return { outcome: "awaiting_human", exitCode: 3 };
  }
  if (disposition?.type === "session.exhausted") {
    return { outcome: "exhausted", exitCode: 2 };
  }
  if (
    (run.state === "awaiting_review" || run.state === "completed") &&
    run.verification?.outcome === "passed"
  ) {
    return { outcome: "review_ready", exitCode: 0 };
  }
  return { outcome: "failed", exitCode: 1 };
}

export function createHeadlessWorkerSettlementV1(input: {
  readonly binding: HeadlessExecutionBindingV1;
  readonly run: RunRecord;
  readonly events: readonly EventRecord[];
  readonly error?: { readonly code: string; readonly message: string } | null;
}): HeadlessWorkerSettlementV1 {
  invariant(
    input.run.id === input.binding.runId,
    "HEADLESS_WORKER_IDENTITY_CHANGED",
    "Headless worker run identity changed before settlement",
  );
  invariant(
    QUIESCENT_STATES.has(input.run.state),
    "HEADLESS_WORKER_NOT_QUIESCENT",
    `Headless worker stopped in non-quiescent state ${input.run.state}`,
  );
  assertQuiescent(input.events);
  const { outcome, exitCode } = outcomeFor(input.run, input.events);
  const error = input.error ?? null;
  if (outcome === "failed" && error === null) {
    throw new IcarusError(
      "INCOMPLETE_HEADLESS_WORKER_SETTLEMENT",
      "Failed headless worker settlement requires an explicit error",
    );
  }
  return {
    schema: HEADLESS_WORKER_SCHEMA,
    runId: input.run.id,
    bindingDigestSha256: input.binding.bindingDigestSha256,
    outcome,
    exitCode,
    finalState: input.run.state,
    verificationOutcome: input.run.verification?.outcome ?? null,
    usage: { ...input.run.usage },
    error,
  };
}

export function headlessWorkerStartedPayload(binding: HeadlessExecutionBindingV1): JsonValue {
  return {
    schema: HEADLESS_WORKER_SCHEMA,
    bindingDigestSha256: binding.bindingDigestSha256,
    profileDigestSha256: binding.profileDigestSha256,
    resolutionDigestSha256: binding.resolutionDigestSha256,
    profileId: binding.resolution.profile.profileId,
    providerProfileId: binding.resolution.profile.providerProfileId,
    toolIds: [...binding.resolution.profile.toolIds],
    budgets: binding.resolution.profile.budgets as unknown as JsonValue,
    worker: binding.resolution.profile.worker as unknown as JsonValue,
  };
}

export function headlessWorkerSettledPayload(settlement: HeadlessWorkerSettlementV1): JsonValue {
  return settlement as unknown as JsonValue;
}
