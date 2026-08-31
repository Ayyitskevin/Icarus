import { digestJson, sha256 } from "./digest.js";
import { IcarusError, invariant } from "./errors.js";
import type { HeadlessExecutionBindingV1 } from "./headless-binding.js";
import type { ToolName } from "./tools.js";
import type { CheckpointFile, EventRecord, JsonValue, RunRecord, SunCeiling } from "./types.js";

export const HEADLESS_WORKER_SCHEMA = "icarus.headless.worker.v1";
export const HEADLESS_WORKER_INTERRUPTION_SCHEMA = "icarus.headless.worker-interruption.v1";
export const HEADLESS_WORKER_CONTINUATION_SCHEMA = "icarus.headless.worker-continuation.v1";
export const HEADLESS_WORKER_RESUME_SCHEMA = "icarus.headless.worker-resume.v1";
export const HEADLESS_WORKER_PROPOSAL_SCHEMA = "icarus.headless.worker-proposal.v1";
export const HEADLESS_WORKER_APPLICATION_SCHEMA = "icarus.headless.worker-application.v1";
export const HEADLESS_WORKER_APPLY_SCHEMA = "icarus.headless.worker-apply.v1";

export type HeadlessWorkerOutcomeV1 =
  | "review_ready"
  | "awaiting_human"
  | "exhausted"
  | "cancelled"
  | "failed"
  | "proposed";

export type HeadlessWorkerExitCodeV1 = 0 | 1 | 2 | 3 | 10 | 130;

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

export interface InterruptedHeadlessWorkerSettlementV1 {
  readonly schema: typeof HEADLESS_WORKER_INTERRUPTION_SCHEMA;
  readonly runId: string;
  readonly bindingDigestSha256: string;
  readonly outcome: "interrupted";
  readonly exitCode: 1;
  readonly finalState: RunRecord["state"];
  readonly verificationOutcome: "passed" | "failed" | "unavailable" | null;
  readonly usage: RunRecord["usage"];
  readonly error: { readonly code: "HEADLESS_WORKER_INTERRUPTED"; readonly message: string };
  readonly reconciliation: {
    readonly startedEventSequence: number;
    readonly interruptedOperationIds: readonly string[];
    readonly continuation: "requires_binding_reconstruction";
  };
}

/**
 * Terminal settlement of a governed H3b continuation epoch (ADR 0058). The
 * `continuation` member binds the exact resume-intent event, the interrupted
 * settlement it continues, and the reconstruction digest the admission gate
 * was proven against. Ordinary `icarus.headless.worker.v1` consumers remain
 * closed: a continuation never uses that schema.
 */
export interface ContinuedHeadlessWorkerSettlementV1 {
  readonly schema: typeof HEADLESS_WORKER_CONTINUATION_SCHEMA;
  readonly runId: string;
  readonly bindingDigestSha256: string;
  readonly outcome: HeadlessWorkerOutcomeV1;
  readonly exitCode: HeadlessWorkerExitCodeV1;
  readonly finalState: RunRecord["state"];
  readonly verificationOutcome: "passed" | "failed" | "unavailable" | null;
  readonly usage: RunRecord["usage"];
  readonly error: { readonly code: string; readonly message: string } | null;
  readonly continuation: {
    readonly resumeEventSequence: number;
    readonly interruptedSettlementSequence: number;
    readonly reconstructionDigestSha256: string;
  };
}

/** Explicit resume intent recorded by the governed H3b continuation path. */
export interface HeadlessWorkerResumeRequestV1 {
  readonly schema: typeof HEADLESS_WORKER_RESUME_SCHEMA;
  readonly runId: string;
  readonly bindingDigestSha256: string;
  readonly reconstructionDigestSha256: string;
  readonly startedEventSequence: number;
}

/**
 * Clean propose-only stop (ADR 0060): the worker proved quiescence after
 * patch-set intent without materializing a byte. The proposal digest is the
 * same checkpoint-file digest the materialization stage computes, so the
 * digest-bound apply act grants exactly what was proposed.
 */
export interface ProposedHeadlessWorkerSettlementV1 {
  readonly schema: typeof HEADLESS_WORKER_PROPOSAL_SCHEMA;
  readonly runId: string;
  readonly bindingDigestSha256: string;
  readonly outcome: "proposed";
  readonly exitCode: 10;
  readonly finalState: RunRecord["state"];
  readonly verificationOutcome: "passed" | "failed" | "unavailable" | null;
  readonly usage: RunRecord["usage"];
  readonly error: null;
  readonly proposal: { readonly patchSetSha256: string };
}

/**
 * Terminal settlement of a digest-bound application epoch (ADR 0060). The
 * `application` member binds the exact apply-intent event, the proposal
 * settlement it applies, and the patch-set digest the operator granted.
 */
export interface AppliedHeadlessWorkerSettlementV1 {
  readonly schema: typeof HEADLESS_WORKER_APPLICATION_SCHEMA;
  readonly runId: string;
  readonly bindingDigestSha256: string;
  readonly outcome: HeadlessWorkerOutcomeV1;
  readonly exitCode: HeadlessWorkerExitCodeV1;
  readonly finalState: RunRecord["state"];
  readonly verificationOutcome: "passed" | "failed" | "unavailable" | null;
  readonly usage: RunRecord["usage"];
  readonly error: { readonly code: string; readonly message: string } | null;
  readonly application: {
    readonly applyEventSequence: number;
    readonly proposalSettlementSequence: number;
    readonly patchSetSha256: string;
  };
}

/** Explicit apply intent recorded by the digest-bound application path. */
export interface HeadlessWorkerApplyRequestV1 {
  readonly schema: typeof HEADLESS_WORKER_APPLY_SCHEMA;
  readonly runId: string;
  readonly bindingDigestSha256: string;
  readonly patchSetSha256: string;
  readonly startedEventSequence: number;
}

export type DurableHeadlessWorkerSettlementV1 =
  | HeadlessWorkerSettlementV1
  | InterruptedHeadlessWorkerSettlementV1
  | ContinuedHeadlessWorkerSettlementV1
  | ProposedHeadlessWorkerSettlementV1
  | AppliedHeadlessWorkerSettlementV1;

export type HeadlessWorkerLifecycleV1 =
  | { readonly status: "absent" }
  | {
      readonly status: "started";
      readonly bindingDigestSha256: string;
      readonly startedEventSequence: number;
      /** Set when the open epoch is a crashed continuation (ADR 0058). */
      readonly continuationRequest: {
        readonly resumeEventSequence: number;
        readonly reconstructionDigestSha256: string;
      } | null;
      /** Set when the open epoch is a crashed application (ADR 0060). */
      readonly applyRequest: {
        readonly applyEventSequence: number;
        readonly patchSetSha256: string;
      } | null;
    }
  | {
      readonly status: "settled";
      readonly bindingDigestSha256: string;
      readonly startedEventSequence: number;
      /** The final settlement: the only one, or the continuation-era one. */
      readonly settlement: DurableHeadlessWorkerSettlementV1;
      /** The interrupted crash settlement when a continuation followed it. */
      readonly interruptedSettlement: InterruptedHeadlessWorkerSettlementV1 | null;
    };

export interface HeadlessWorkerExecutionV1 {
  readonly binding: HeadlessExecutionBindingV1;
  readonly settlement: HeadlessWorkerSettlementV1 | ProposedHeadlessWorkerSettlementV1;
  readonly run: RunRecord;
}

export interface HeadlessWorkerReconciliationV1 {
  readonly settlement: DurableHeadlessWorkerSettlementV1;
  readonly run: RunRecord;
}

export interface ActiveHeadlessExecutionV1 {
  readonly binding: HeadlessExecutionBindingV1;
  readonly ceiling: SunCeiling;
  readonly toolIds: ReadonlySet<ToolName>;
  /** Effective session iteration ceiling after ADR 0060 envelope clamps. */
  readonly iterationCeiling: number;
}

/** ADR 0060 per-invocation runaway envelopes; every field only narrows. */
export interface HeadlessRunEnvelopeV1 {
  readonly maxTurns?: number;
  readonly maxBudgetUsd?: number;
}

export function assertHeadlessWorkerBudgetAvailable(run: RunRecord, ceiling: SunCeiling): void {
  const exhausted =
    run.usage.toolCalls > ceiling.maxToolCalls ||
    run.usage.activeRuntimeMs > ceiling.maxActiveRuntimeMs ||
    run.usage.inputTokens + run.usage.outputTokens + run.usage.upperBoundTokens >
      ceiling.maxTotalTokens ||
    run.usage.estimatedCostUsd + run.usage.reservedCostUsd > ceiling.maxCostUsd;
  invariant(
    !exhausted,
    "HEADLESS_PROFILE_ALREADY_EXHAUSTED",
    "Run usage already exceeds the selected headless profile ceiling",
  );
}

/**
 * Refuses a per-invocation cost clamp that prior durable usage has already
 * spent. This is an admission refusal, not a worker failure: callers run it
 * before recording an approval or epoch intent (ADR 0060).
 */
export function assertHeadlessWorkerEnvelopeAvailable(
  run: RunRecord,
  envelope: HeadlessRunEnvelopeV1 | undefined,
): void {
  if (envelope?.maxBudgetUsd === undefined) return;
  invariant(
    run.usage.estimatedCostUsd + run.usage.reservedCostUsd <= envelope.maxBudgetUsd,
    "HEADLESS_ENVELOPE_EXHAUSTED",
    "Run usage already exceeds the per-invocation headless budget envelope",
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

function eventPayload(event: EventRecord, label: string): Readonly<Record<string, JsonValue>> {
  invariant(
    typeof event.payload === "object" && event.payload !== null && !Array.isArray(event.payload),
    "INVALID_HEADLESS_WORKER_HISTORY",
    `${label} payload is malformed`,
  );
  return event.payload;
}

function bindingDigest(payload: Readonly<Record<string, JsonValue>>, label: string): string {
  const digest = payload.bindingDigestSha256;
  invariant(
    typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest),
    "INVALID_HEADLESS_WORKER_HISTORY",
    `${label} binding digest is malformed`,
  );
  return digest;
}

const RUN_STATES = new Set<RunRecord["state"]>([
  "preparing",
  "planned",
  "awaiting_egress_approval",
  "awaiting_approval",
  "running",
  "verifying",
  "awaiting_review",
  "completed",
  "rolling_back",
  "cancelling",
  "failed",
  "cancelled",
  "rolled_back",
  "restoring",
]);

const ORDINARY_SETTLEMENT_MEMBERS = [
  "bindingDigestSha256",
  "error",
  "exitCode",
  "finalState",
  "outcome",
  "runId",
  "schema",
  "usage",
  "verificationOutcome",
] as const;

const INTERRUPTED_SETTLEMENT_MEMBERS = [...ORDINARY_SETTLEMENT_MEMBERS, "reconciliation"] as const;

const CONTINUATION_SETTLEMENT_MEMBERS = [...ORDINARY_SETTLEMENT_MEMBERS, "continuation"] as const;

const PROPOSAL_SETTLEMENT_MEMBERS = [...ORDINARY_SETTLEMENT_MEMBERS, "proposal"] as const;

const APPLICATION_SETTLEMENT_MEMBERS = [...ORDINARY_SETTLEMENT_MEMBERS, "application"] as const;

const RESUME_REQUEST_MEMBERS = [
  "bindingDigestSha256",
  "reconstructionDigestSha256",
  "runId",
  "schema",
  "startedEventSequence",
] as const;

const APPLY_REQUEST_MEMBERS = [
  "bindingDigestSha256",
  "patchSetSha256",
  "runId",
  "schema",
  "startedEventSequence",
] as const;

function assertExactMembers(
  value: Readonly<Record<string, JsonValue>>,
  expectedMembers: readonly string[],
  label: string,
  optionalMembers: readonly string[] = [],
): void {
  // Optional members exist for durable payloads written before a field was added.
  // A settlement recorded before charged upper bounds were distinguished from
  // observed usage carries six members; one recorded after carries seven. Requiring
  // exactly one shape would make the older evidence unreadable, and rejecting the
  // newer would make the distinction unrecordable.
  const optional = new Set(optionalMembers);
  const actual = Object.keys(value)
    .filter((member) => !optional.has(member))
    .sort();
  const expected = [...expectedMembers].sort();
  const unknown = Object.keys(value).filter(
    (member) => !optional.has(member) && !expectedMembers.includes(member),
  );
  invariant(
    unknown.length === 0 &&
      actual.length === expected.length &&
      actual.every((member, index) => member === expected[index]),
    "INVALID_HEADLESS_WORKER_HISTORY",
    `${label} members are malformed`,
  );
}

function decodeRunState(value: JsonValue | undefined): RunRecord["state"] {
  invariant(
    typeof value === "string" && RUN_STATES.has(value as RunRecord["state"]),
    "INVALID_HEADLESS_WORKER_HISTORY",
    "Headless worker settlement final state is malformed",
  );
  return value as RunRecord["state"];
}

function decodeVerificationOutcome(
  value: JsonValue | undefined,
): HeadlessWorkerSettlementV1["verificationOutcome"] {
  invariant(
    value === null || value === "passed" || value === "failed" || value === "unavailable",
    "INVALID_HEADLESS_WORKER_HISTORY",
    "Headless worker settlement verification outcome is malformed",
  );
  return value;
}

function decodeUsage(value: JsonValue | undefined): RunRecord["usage"] {
  invariant(
    typeof value === "object" && value !== null && !Array.isArray(value),
    "INVALID_HEADLESS_WORKER_HISTORY",
    "Headless worker settlement usage is malformed",
  );
  assertExactMembers(
    value,
    [
      "activeRuntimeMs",
      "estimatedCostUsd",
      "inputTokens",
      "outputTokens",
      "reservedCostUsd",
      "toolCalls",
    ],
    "Headless worker settlement usage",
    ["upperBoundTokens"],
  );
  const {
    toolCalls,
    inputTokens,
    outputTokens,
    activeRuntimeMs,
    estimatedCostUsd,
    reservedCostUsd,
  } = value;
  // Settlement payloads written before charged upper bounds were distinguished from
  // observed usage carry no such field. Absent means "none recorded", which is the
  // truthful reading: those runs charged reservations into inputTokens, and that
  // history is not retroactively reinterpretable here.
  const upperBoundTokens = "upperBoundTokens" in value ? value.upperBoundTokens : 0;
  invariant(
    Number.isSafeInteger(toolCalls) &&
      typeof toolCalls === "number" &&
      toolCalls >= 0 &&
      Number.isSafeInteger(inputTokens) &&
      typeof inputTokens === "number" &&
      inputTokens >= 0 &&
      Number.isSafeInteger(outputTokens) &&
      typeof outputTokens === "number" &&
      outputTokens >= 0 &&
      Number.isSafeInteger(activeRuntimeMs) &&
      typeof activeRuntimeMs === "number" &&
      activeRuntimeMs >= 0 &&
      typeof estimatedCostUsd === "number" &&
      Number.isFinite(estimatedCostUsd) &&
      estimatedCostUsd >= 0 &&
      typeof reservedCostUsd === "number" &&
      Number.isFinite(reservedCostUsd) &&
      reservedCostUsd >= 0 &&
      Number.isSafeInteger(upperBoundTokens) &&
      typeof upperBoundTokens === "number" &&
      upperBoundTokens >= 0,
    "INVALID_HEADLESS_WORKER_HISTORY",
    "Headless worker settlement usage is malformed",
  );
  return {
    toolCalls,
    inputTokens,
    outputTokens,
    upperBoundTokens,
    activeRuntimeMs,
    estimatedCostUsd,
    reservedCostUsd,
  };
}

function decodeError(value: JsonValue | undefined): HeadlessWorkerSettlementV1["error"] {
  if (value === null) return null;
  invariant(
    typeof value === "object" && !Array.isArray(value),
    "INVALID_HEADLESS_WORKER_HISTORY",
    "Headless worker settlement error is malformed",
  );
  assertExactMembers(value, ["code", "message"], "Headless worker settlement error");
  const { code, message } = value;
  invariant(
    typeof code === "string" &&
      /^[A-Z0-9_]{2,128}$/.test(code) &&
      typeof message === "string" &&
      message.length > 0,
    "INVALID_HEADLESS_WORKER_HISTORY",
    "Headless worker settlement error is malformed",
  );
  return { code, message };
}

function outcomeForEvidence(
  state: RunRecord["state"],
  verificationOutcome: HeadlessWorkerSettlementV1["verificationOutcome"],
  events: readonly EventRecord[],
): { readonly outcome: HeadlessWorkerOutcomeV1; readonly exitCode: HeadlessWorkerExitCodeV1 } {
  if (state === "cancelled") return { outcome: "cancelled", exitCode: 130 };
  if (state === "failed") return { outcome: "failed", exitCode: 1 };
  const disposition = latestDisposition(events);
  if (disposition?.type === "session.awaiting_human") {
    return { outcome: "awaiting_human", exitCode: 3 };
  }
  if (disposition?.type === "session.exhausted") {
    return { outcome: "exhausted", exitCode: 2 };
  }
  // H4: a declared child that failed or never reached review-ready evidence
  // settles the parent failed, even when the parent's own task passes.
  for (const event of events) {
    if (event.type !== "headless.child.settled") continue;
    const payload = event.payload as { readonly outcome?: unknown };
    if (payload.outcome !== "review_ready") {
      return { outcome: "failed", exitCode: 1 };
    }
  }
  if ((state === "awaiting_review" || state === "completed") && verificationOutcome === "passed") {
    return { outcome: "review_ready", exitCode: 0 };
  }
  return { outcome: "failed", exitCode: 1 };
}

/** The H4 spawn gate and CLI-facing evidence mapping, shared with settlement. */
export function headlessWorkerOutcomeForEvidenceV1(
  state: RunRecord["state"],
  verificationOutcome: HeadlessWorkerSettlementV1["verificationOutcome"],
  events: readonly EventRecord[],
): { readonly outcome: HeadlessWorkerOutcomeV1; readonly exitCode: HeadlessWorkerExitCodeV1 } {
  return outcomeForEvidence(state, verificationOutcome, events);
}

/** The first declared child that did not reach review-ready evidence. */
function childFailureFor(
  events: readonly EventRecord[],
): { readonly code: string; readonly message: string } | null {
  for (const event of events) {
    if (event.type !== "headless.child.settled") continue;
    const payload = event.payload as {
      readonly childId?: unknown;
      readonly outcome?: unknown;
      readonly error?: unknown;
    };
    if (payload.outcome === "review_ready") continue;
    const error = payload.error;
    if (
      typeof error === "object" &&
      error !== null &&
      !Array.isArray(error) &&
      typeof (error as { readonly code?: unknown }).code === "string" &&
      /^[A-Z0-9_]{2,128}$/.test((error as { readonly code: string }).code) &&
      typeof (error as { readonly message?: unknown }).message === "string"
    ) {
      return error as { readonly code: string; readonly message: string };
    }
    return {
      code: "HEADLESS_CHILD_FAILED",
      message: `Headless child ${typeof payload.childId === "string" ? payload.childId : "unknown"} did not reach review-ready evidence`,
    };
  }
  return null;
}

function decodeSettlement(
  runId: string,
  event: EventRecord,
  expectedBindingDigest: string,
  expectedStartedEventSequence: number,
  events: readonly EventRecord[],
  epochEvidence: {
    readonly intentEvent: EventRecord;
    readonly firstSettlement: EventRecord;
  } | null,
): DurableHeadlessWorkerSettlementV1 {
  const payload = eventPayload(event, "Headless worker settlement");
  const outcomeValue = payload.outcome;
  const exitCode = payload.exitCode;
  const expectedExitCodes = {
    review_ready: 0,
    failed: 1,
    interrupted: 1,
    exhausted: 2,
    awaiting_human: 3,
    proposed: 10,
    cancelled: 130,
  } as const;
  invariant(
    typeof outcomeValue === "string" && Object.hasOwn(expectedExitCodes, outcomeValue),
    "INVALID_HEADLESS_WORKER_HISTORY",
    "Headless worker settlement outcome is malformed",
  );
  const outcome = outcomeValue as keyof typeof expectedExitCodes;
  const schema = payload.schema;
  invariant(
    schema === HEADLESS_WORKER_SCHEMA ||
      schema === HEADLESS_WORKER_INTERRUPTION_SCHEMA ||
      schema === HEADLESS_WORKER_CONTINUATION_SCHEMA ||
      schema === HEADLESS_WORKER_PROPOSAL_SCHEMA ||
      schema === HEADLESS_WORKER_APPLICATION_SCHEMA,
    "INVALID_HEADLESS_WORKER_HISTORY",
    "Headless worker settlement schema is malformed",
  );
  const isInterrupted = schema === HEADLESS_WORKER_INTERRUPTION_SCHEMA;
  const isContinuation = schema === HEADLESS_WORKER_CONTINUATION_SCHEMA;
  const isProposal = schema === HEADLESS_WORKER_PROPOSAL_SCHEMA;
  const isApplication = schema === HEADLESS_WORKER_APPLICATION_SCHEMA;
  invariant(
    (outcome === "interrupted") === isInterrupted && (outcome === "proposed") === isProposal,
    "INVALID_HEADLESS_WORKER_HISTORY",
    "Headless worker settlement outcome is malformed",
  );
  assertExactMembers(
    payload,
    isInterrupted
      ? INTERRUPTED_SETTLEMENT_MEMBERS
      : isContinuation
        ? CONTINUATION_SETTLEMENT_MEMBERS
        : isProposal
          ? PROPOSAL_SETTLEMENT_MEMBERS
          : isApplication
            ? APPLICATION_SETTLEMENT_MEMBERS
            : ORDINARY_SETTLEMENT_MEMBERS,
    "Headless worker settlement",
  );
  invariant(
    payload.runId === runId,
    "INVALID_HEADLESS_WORKER_HISTORY",
    "Headless worker settlement identity is malformed",
  );
  invariant(
    exitCode === expectedExitCodes[outcome],
    "INVALID_HEADLESS_WORKER_HISTORY",
    "Headless worker settlement exit code does not match its outcome",
  );
  const digest = bindingDigest(payload, "Headless worker settlement");
  invariant(
    digest === expectedBindingDigest,
    "HEADLESS_WORKER_IDENTITY_CHANGED",
    "Headless worker binding changed before settlement",
  );
  const finalState = decodeRunState(payload.finalState);
  const verificationOutcome = decodeVerificationOutcome(payload.verificationOutcome);
  const usage = decodeUsage(payload.usage);
  const error = decodeError(payload.error);
  if (outcome === "interrupted") {
    const reconciliation = payload.reconciliation;
    invariant(
      typeof reconciliation === "object" &&
        reconciliation !== null &&
        !Array.isArray(reconciliation) &&
        error !== null &&
        error.code === "HEADLESS_WORKER_INTERRUPTED",
      "INVALID_HEADLESS_WORKER_HISTORY",
      "Interrupted headless worker settlement lacks reconciliation evidence",
    );
    assertExactMembers(
      reconciliation,
      ["continuation", "interruptedOperationIds", "startedEventSequence"],
      "Interrupted headless worker reconciliation",
    );
    const { startedEventSequence, interruptedOperationIds, continuation } = reconciliation;
    invariant(
      Number.isSafeInteger(startedEventSequence) &&
        typeof startedEventSequence === "number" &&
        startedEventSequence === expectedStartedEventSequence &&
        Array.isArray(interruptedOperationIds) &&
        continuation === "requires_binding_reconstruction",
      "INVALID_HEADLESS_WORKER_HISTORY",
      "Interrupted headless worker settlement lacks reconciliation evidence",
    );
    const operationIds = interruptedOperationIds.map((operationId) => {
      invariant(
        typeof operationId === "string" && operationId.length > 0,
        "INVALID_HEADLESS_WORKER_HISTORY",
        "Interrupted headless worker settlement lacks reconciliation evidence",
      );
      return operationId;
    });
    invariant(
      new Set(operationIds).size === operationIds.length,
      "INVALID_HEADLESS_WORKER_HISTORY",
      "Interrupted headless worker settlement lacks reconciliation evidence",
    );
    const durableOperationIds = events
      .filter(
        (candidate) =>
          candidate.type === "operation.interrupted" &&
          candidate.sequence > expectedStartedEventSequence &&
          candidate.sequence < event.sequence,
      )
      .map((candidate) => {
        const operationId = eventPayload(candidate, "Interrupted operation").operationId;
        invariant(
          typeof operationId === "string" && operationId.length > 0,
          "INVALID_HEADLESS_WORKER_HISTORY",
          "Interrupted headless worker history has malformed operation identity",
        );
        return operationId;
      });
    invariant(
      operationIds.length === durableOperationIds.length &&
        operationIds.every((operationId, index) => operationId === durableOperationIds[index]),
      "INVALID_HEADLESS_WORKER_HISTORY",
      "Interrupted headless worker settlement does not match durable interruption history",
    );
    return {
      schema: HEADLESS_WORKER_INTERRUPTION_SCHEMA,
      runId,
      bindingDigestSha256: digest,
      outcome,
      exitCode: 1,
      finalState,
      verificationOutcome,
      usage,
      error: { code: "HEADLESS_WORKER_INTERRUPTED", message: error.message },
      reconciliation: {
        startedEventSequence,
        interruptedOperationIds: operationIds,
        continuation,
      },
    };
  }
  if (isProposal) {
    const proposal = payload.proposal;
    invariant(
      typeof proposal === "object" &&
        proposal !== null &&
        !Array.isArray(proposal) &&
        finalState === "running" &&
        error === null,
      "INVALID_HEADLESS_WORKER_HISTORY",
      "Proposed headless worker settlement is malformed",
    );
    assertExactMembers(proposal, ["patchSetSha256"], "Proposed headless worker proposal");
    invariant(
      typeof proposal.patchSetSha256 === "string" && /^[a-f0-9]{64}$/.test(proposal.patchSetSha256),
      "INVALID_HEADLESS_WORKER_HISTORY",
      "Proposed headless worker patch-set digest is malformed",
    );
    return {
      schema: HEADLESS_WORKER_PROPOSAL_SCHEMA,
      runId,
      bindingDigestSha256: digest,
      outcome: "proposed",
      exitCode: 10,
      finalState,
      verificationOutcome,
      usage,
      error: null,
      proposal: { patchSetSha256: proposal.patchSetSha256 },
    };
  }
  const expectedOutcome = outcomeForEvidence(finalState, verificationOutcome, events);
  invariant(
    QUIESCENT_STATES.has(finalState) &&
      outcome === expectedOutcome.outcome &&
      exitCode === expectedOutcome.exitCode &&
      (outcome !== "review_ready" || error === null) &&
      (outcome !== "failed" || error !== null),
    "INVALID_HEADLESS_WORKER_HISTORY",
    "Headless worker settlement outcome does not match its evidence",
  );
  if (isApplication) {
    const application = payload.application;
    invariant(
      typeof application === "object" &&
        application !== null &&
        !Array.isArray(application) &&
        epochEvidence !== null,
      "INVALID_HEADLESS_WORKER_HISTORY",
      "Applied headless worker settlement lacks application evidence",
    );
    assertExactMembers(
      application,
      ["applyEventSequence", "patchSetSha256", "proposalSettlementSequence"],
      "Applied headless worker application",
    );
    const { applyEventSequence, proposalSettlementSequence, patchSetSha256 } = application;
    const applyPayload = eventPayload(epochEvidence.intentEvent, "Headless worker apply");
    invariant(
      Number.isSafeInteger(applyEventSequence) &&
        applyEventSequence === epochEvidence.intentEvent.sequence &&
        Number.isSafeInteger(proposalSettlementSequence) &&
        proposalSettlementSequence === epochEvidence.firstSettlement.sequence &&
        typeof patchSetSha256 === "string" &&
        /^[a-f0-9]{64}$/.test(patchSetSha256) &&
        applyPayload.schema === HEADLESS_WORKER_APPLY_SCHEMA &&
        applyPayload.patchSetSha256 === patchSetSha256,
      "INVALID_HEADLESS_WORKER_HISTORY",
      "Applied headless worker settlement does not match its apply intent",
    );
    return {
      schema: HEADLESS_WORKER_APPLICATION_SCHEMA,
      runId,
      bindingDigestSha256: digest,
      outcome,
      exitCode: expectedExitCodes[outcome],
      finalState,
      verificationOutcome,
      usage,
      error,
      application: {
        applyEventSequence: epochEvidence.intentEvent.sequence,
        proposalSettlementSequence: epochEvidence.firstSettlement.sequence,
        patchSetSha256,
      },
    };
  }
  if (isContinuation) {
    const continuation = payload.continuation;
    invariant(
      typeof continuation === "object" &&
        continuation !== null &&
        !Array.isArray(continuation) &&
        epochEvidence !== null,
      "INVALID_HEADLESS_WORKER_HISTORY",
      "Continued headless worker settlement lacks continuation evidence",
    );
    assertExactMembers(
      continuation,
      ["interruptedSettlementSequence", "reconstructionDigestSha256", "resumeEventSequence"],
      "Continued headless worker continuation",
    );
    const { resumeEventSequence, interruptedSettlementSequence, reconstructionDigestSha256 } =
      continuation;
    const resumePayload = eventPayload(epochEvidence.intentEvent, "Headless worker resume");
    invariant(
      Number.isSafeInteger(resumeEventSequence) &&
        resumeEventSequence === epochEvidence.intentEvent.sequence &&
        Number.isSafeInteger(interruptedSettlementSequence) &&
        interruptedSettlementSequence === epochEvidence.firstSettlement.sequence &&
        typeof reconstructionDigestSha256 === "string" &&
        /^[a-f0-9]{64}$/.test(reconstructionDigestSha256) &&
        resumePayload.schema === HEADLESS_WORKER_RESUME_SCHEMA &&
        resumePayload.reconstructionDigestSha256 === reconstructionDigestSha256,
      "INVALID_HEADLESS_WORKER_HISTORY",
      "Continued headless worker settlement does not match its resume intent",
    );
    return {
      schema: HEADLESS_WORKER_CONTINUATION_SCHEMA,
      runId,
      bindingDigestSha256: digest,
      outcome,
      exitCode: expectedExitCodes[outcome],
      finalState,
      verificationOutcome,
      usage,
      error,
      continuation: {
        resumeEventSequence: epochEvidence.intentEvent.sequence,
        interruptedSettlementSequence: epochEvidence.firstSettlement.sequence,
        reconstructionDigestSha256,
      },
    };
  }
  return {
    schema: HEADLESS_WORKER_SCHEMA,
    runId,
    bindingDigestSha256: digest,
    outcome,
    exitCode: expectedExitCodes[outcome],
    finalState,
    verificationOutcome,
    usage,
    error,
  };
}

function decodeResumeRequest(
  runId: string,
  event: EventRecord,
  expectedBindingDigest: string,
  expectedStartedEventSequence: number,
): { readonly resumeEventSequence: number; readonly reconstructionDigestSha256: string } {
  invariant(
    event.runId === runId && event.sequence > expectedStartedEventSequence,
    "INVALID_HEADLESS_WORKER_HISTORY",
    "Headless worker resume request identity is malformed",
  );
  const payload = eventPayload(event, "Headless worker resume");
  assertExactMembers(payload, RESUME_REQUEST_MEMBERS, "Headless worker resume");
  const { startedEventSequence, reconstructionDigestSha256 } = payload;
  invariant(
    payload.schema === HEADLESS_WORKER_RESUME_SCHEMA &&
      payload.runId === runId &&
      Number.isSafeInteger(startedEventSequence) &&
      startedEventSequence === expectedStartedEventSequence &&
      typeof reconstructionDigestSha256 === "string" &&
      /^[a-f0-9]{64}$/.test(reconstructionDigestSha256),
    "INVALID_HEADLESS_WORKER_HISTORY",
    "Headless worker resume request is malformed",
  );
  const digest = bindingDigest(payload, "Headless worker resume");
  invariant(
    digest === expectedBindingDigest,
    "HEADLESS_WORKER_IDENTITY_CHANGED",
    "Headless worker binding changed before resume",
  );
  return {
    resumeEventSequence: event.sequence,
    reconstructionDigestSha256,
  };
}

function decodeApplyRequest(
  runId: string,
  event: EventRecord,
  expectedBindingDigest: string,
  expectedStartedEventSequence: number,
): { readonly applyEventSequence: number; readonly patchSetSha256: string } {
  invariant(
    event.runId === runId && event.sequence > expectedStartedEventSequence,
    "INVALID_HEADLESS_WORKER_HISTORY",
    "Headless worker apply request identity is malformed",
  );
  const payload = eventPayload(event, "Headless worker apply");
  assertExactMembers(payload, APPLY_REQUEST_MEMBERS, "Headless worker apply");
  const { startedEventSequence, patchSetSha256 } = payload;
  invariant(
    payload.schema === HEADLESS_WORKER_APPLY_SCHEMA &&
      payload.runId === runId &&
      Number.isSafeInteger(startedEventSequence) &&
      startedEventSequence === expectedStartedEventSequence &&
      typeof patchSetSha256 === "string" &&
      /^[a-f0-9]{64}$/.test(patchSetSha256),
    "INVALID_HEADLESS_WORKER_HISTORY",
    "Headless worker apply request is malformed",
  );
  const digest = bindingDigest(payload, "Headless worker apply");
  invariant(
    digest === expectedBindingDigest,
    "HEADLESS_WORKER_IDENTITY_CHANGED",
    "Headless worker binding changed before apply",
  );
  return { applyEventSequence: event.sequence, patchSetSha256 };
}

export function inspectHeadlessWorkerLifecycleV1(
  runId: string,
  events: readonly EventRecord[],
): HeadlessWorkerLifecycleV1 {
  const starts = events.filter((event) => event.type === "headless.worker.started");
  const settlements = events.filter((event) => event.type === "headless.worker.settled");
  const resumes = events.filter((event) => event.type === "headless.worker.resume_requested");
  const applies = events.filter((event) => event.type === "headless.worker.apply_requested");
  if (starts.length === 0) {
    invariant(
      settlements.length === 0 && resumes.length === 0 && applies.length === 0,
      "INVALID_HEADLESS_WORKER_HISTORY",
      "Headless worker evidence exists without a start",
    );
    return { status: "absent" };
  }
  invariant(
    starts.length === 1,
    "INVALID_HEADLESS_WORKER_HISTORY",
    "Headless worker history must contain exactly one start",
  );
  invariant(
    resumes.length <= 1,
    "INVALID_HEADLESS_WORKER_HISTORY",
    "Headless worker history contains more than one resume request",
  );
  invariant(
    applies.length <= 1,
    "INVALID_HEADLESS_WORKER_HISTORY",
    "Headless worker history contains more than one apply request",
  );
  invariant(
    resumes.length + applies.length <= 1,
    "INVALID_HEADLESS_WORKER_HISTORY",
    "Headless worker history contains more than one epoch intent",
  );
  invariant(
    settlements.length <= 2,
    "INVALID_HEADLESS_WORKER_HISTORY",
    "Headless worker history contains more than two settlements",
  );
  const started = starts[0];
  invariant(
    started !== undefined,
    "INVALID_HEADLESS_WORKER_HISTORY",
    "Headless worker start is missing",
  );
  const startedPayload = eventPayload(started, "Headless worker start");
  invariant(
    started.runId === runId && startedPayload.schema === HEADLESS_WORKER_SCHEMA,
    "INVALID_HEADLESS_WORKER_HISTORY",
    "Headless worker start identity is malformed",
  );
  const digest = bindingDigest(startedPayload, "Headless worker start");
  const base = {
    bindingDigestSha256: digest,
    startedEventSequence: started.sequence,
  };
  const resume = resumes[0];
  const apply = applies[0];
  const continuationRequest =
    resume === undefined ? null : decodeResumeRequest(runId, resume, digest, started.sequence);
  const applyRequest =
    apply === undefined ? null : decodeApplyRequest(runId, apply, digest, started.sequence);
  const first = settlements[0];
  const second = settlements[1];
  if (first === undefined) {
    invariant(
      continuationRequest === null && applyRequest === null,
      "INVALID_HEADLESS_WORKER_HISTORY",
      "Headless worker epoch intent exists without a first settlement",
    );
    return { status: "started", ...base, continuationRequest: null, applyRequest: null };
  }
  invariant(
    first.runId === runId && first.sequence > started.sequence,
    "INVALID_HEADLESS_WORKER_HISTORY",
    "Headless worker settlement precedes its start",
  );
  const firstSettlement = decodeSettlement(runId, first, digest, started.sequence, events, null);
  if (continuationRequest !== null) {
    invariant(
      firstSettlement.schema === HEADLESS_WORKER_INTERRUPTION_SCHEMA &&
        resume !== undefined &&
        resume.sequence > first.sequence,
      "INVALID_HEADLESS_WORKER_HISTORY",
      "Headless worker resume request must follow an interrupted settlement",
    );
  }
  if (applyRequest !== null) {
    invariant(
      (firstSettlement.schema === HEADLESS_WORKER_PROPOSAL_SCHEMA ||
        firstSettlement.schema === HEADLESS_WORKER_INTERRUPTION_SCHEMA) &&
        apply !== undefined &&
        apply.sequence > first.sequence,
      "INVALID_HEADLESS_WORKER_HISTORY",
      "Headless worker apply request must follow a proposed or interrupted settlement",
    );
  }
  if (second === undefined) {
    if (continuationRequest !== null || applyRequest !== null) {
      // A crashed second epoch: operations may still be open; H3a
      // reconciliation closes this tail before anything else may act.
      return { status: "started", ...base, continuationRequest, applyRequest };
    }
    assertQuiescent(events);
    return {
      status: "settled",
      ...base,
      settlement: firstSettlement,
      interruptedSettlement: null,
    };
  }
  invariant(
    (continuationRequest !== null && resume !== undefined) ||
      (applyRequest !== null && apply !== undefined),
    "INVALID_HEADLESS_WORKER_HISTORY",
    "Headless worker second settlement exists without epoch intent",
  );
  const intentEvent = (resume ?? apply) as EventRecord;
  invariant(
    second.runId === runId && second.sequence > intentEvent.sequence,
    "INVALID_HEADLESS_WORKER_HISTORY",
    "Headless worker second settlement precedes its epoch intent",
  );
  assertQuiescent(events);
  const secondSettlement = decodeSettlement(runId, second, digest, started.sequence, events, {
    intentEvent,
    firstSettlement: first,
  });
  if (continuationRequest !== null) {
    invariant(
      firstSettlement.schema === HEADLESS_WORKER_INTERRUPTION_SCHEMA &&
        (secondSettlement.schema === HEADLESS_WORKER_CONTINUATION_SCHEMA ||
          secondSettlement.schema === HEADLESS_WORKER_INTERRUPTION_SCHEMA),
      "INVALID_HEADLESS_WORKER_HISTORY",
      "Headless worker continuation must follow an interrupted settlement",
    );
  } else {
    invariant(
      (firstSettlement.schema === HEADLESS_WORKER_PROPOSAL_SCHEMA ||
        firstSettlement.schema === HEADLESS_WORKER_INTERRUPTION_SCHEMA) &&
        (secondSettlement.schema === HEADLESS_WORKER_APPLICATION_SCHEMA ||
          secondSettlement.schema === HEADLESS_WORKER_INTERRUPTION_SCHEMA),
      "INVALID_HEADLESS_WORKER_HISTORY",
      "Headless worker application must follow a proposed or interrupted settlement",
    );
  }
  return {
    status: "settled",
    ...base,
    settlement: secondSettlement,
    interruptedSettlement:
      firstSettlement.schema === HEADLESS_WORKER_INTERRUPTION_SCHEMA ? firstSettlement : null,
  };
}

export function createInterruptedHeadlessWorkerSettlementV1(input: {
  readonly run: RunRecord;
  readonly events: readonly EventRecord[];
}): InterruptedHeadlessWorkerSettlementV1 {
  const lifecycle = inspectHeadlessWorkerLifecycleV1(input.run.id, input.events);
  invariant(
    lifecycle.status === "started",
    lifecycle.status === "absent" ? "MISSING_HEADLESS_WORKER" : "HEADLESS_WORKER_ALREADY_SETTLED",
    lifecycle.status === "absent"
      ? "Headless worker never started"
      : "Headless worker already settled",
  );
  assertQuiescent(input.events);
  const interruptedOperationIds = input.events
    .filter(
      (event) =>
        event.type === "operation.interrupted" && event.sequence > lifecycle.startedEventSequence,
    )
    .map((event) => {
      const operationId = eventPayload(event, "Interrupted operation").operationId;
      invariant(
        typeof operationId === "string" && operationId.length > 0,
        "INVALID_HEADLESS_WORKER_HISTORY",
        "Interrupted headless operation identity is malformed",
      );
      return operationId;
    });
  invariant(
    new Set(interruptedOperationIds).size === interruptedOperationIds.length,
    "INVALID_HEADLESS_WORKER_HISTORY",
    "Headless worker interruption history contains a duplicate operation",
  );
  return {
    schema: HEADLESS_WORKER_INTERRUPTION_SCHEMA,
    runId: input.run.id,
    bindingDigestSha256: lifecycle.bindingDigestSha256,
    outcome: "interrupted",
    exitCode: 1,
    finalState: input.run.state,
    verificationOutcome: input.run.verification?.outcome ?? null,
    usage: { ...input.run.usage },
    error: {
      code: "HEADLESS_WORKER_INTERRUPTED",
      message:
        "Headless worker ended before durable settlement; binding reconstruction is required",
    },
    reconciliation: {
      startedEventSequence: lifecycle.startedEventSequence,
      interruptedOperationIds,
      continuation: "requires_binding_reconstruction",
    },
  };
}

function outcomeFor(
  run: RunRecord,
  events: readonly EventRecord[],
): { readonly outcome: HeadlessWorkerOutcomeV1; readonly exitCode: HeadlessWorkerExitCodeV1 } {
  return outcomeForEvidence(run.state, run.verification?.outcome ?? null, events);
}

function verificationFailureFor(
  run: RunRecord,
): { readonly code: string; readonly message: string } | null {
  if (run.state !== "awaiting_review") return null;
  if (run.verification?.outcome === "failed") {
    return {
      code: "HEADLESS_VERIFICATION_FAILED",
      message: "Headless worker registered checks failed",
    };
  }
  if (run.verification?.outcome === "unavailable") {
    return {
      code: "HEADLESS_VERIFICATION_UNAVAILABLE",
      message: "Headless worker registered checks were unavailable",
    };
  }
  return null;
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
  const error =
    input.error ??
    (outcome === "failed"
      ? (verificationFailureFor(input.run) ?? childFailureFor(input.events))
      : null);
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
    ...(binding.resolution.profile.children === undefined
      ? {}
      : { children: binding.resolution.profile.children as unknown as JsonValue }),
  };
}

export function headlessWorkerSettledPayload(
  settlement: DurableHeadlessWorkerSettlementV1,
): JsonValue {
  return settlement as unknown as JsonValue;
}

export function headlessWorkerResumeRequestedPayload(
  request: HeadlessWorkerResumeRequestV1,
): JsonValue {
  return request as unknown as JsonValue;
}

export function headlessWorkerApplyRequestedPayload(
  request: HeadlessWorkerApplyRequestV1,
): JsonValue {
  return request as unknown as JsonValue;
}

/**
 * The exact operation digest the materialization stage binds. Every path,
 * operation, and baseline/approved byte digest is canonicalized; a missing
 * side remains null so delete/create can never collapse into an empty file.
 * The proposal settlement and apply act both recompute it from durable bytes
 * (ADR 0060).
 */
export function headlessPatchSetDigestV1(files: readonly CheckpointFile[]): string {
  return digestJson({
    schema: "icarus.headless.patch-set-digest.v1",
    files: [...files]
      .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
      .map((file) => ({
        path: file.path,
        op: file.op,
        baselineSha256:
          file.baselineBase64 === null ? null : sha256(Buffer.from(file.baselineBase64, "base64")),
        approvedSha256:
          file.approvedBase64 === null ? null : sha256(Buffer.from(file.approvedBase64, "base64")),
      })),
  });
}

/**
 * Clean propose-only stop (ADR 0060): the worker proved quiescence with the
 * patch set durable as intent and nothing materialized. The run stays
 * `running`; the digest-bound apply act is the only way forward.
 */
export function createProposedHeadlessWorkerSettlementV1(input: {
  readonly binding: HeadlessExecutionBindingV1;
  readonly run: RunRecord;
  readonly events: readonly EventRecord[];
  readonly patchSetSha256: string;
}): ProposedHeadlessWorkerSettlementV1 {
  invariant(
    input.run.id === input.binding.runId,
    "HEADLESS_WORKER_IDENTITY_CHANGED",
    "Headless worker run identity changed before settlement",
  );
  invariant(
    input.run.state === "running" && input.run.patchSet !== null,
    "INVALID_HEADLESS_PROPOSAL",
    "Headless proposal requires a running run with a persisted patch set",
  );
  invariant(
    /^[a-f0-9]{64}$/.test(input.patchSetSha256),
    "INVALID_HEADLESS_PROPOSAL",
    "Headless proposal patch-set digest is malformed",
  );
  assertQuiescent(input.events);
  return {
    schema: HEADLESS_WORKER_PROPOSAL_SCHEMA,
    runId: input.run.id,
    bindingDigestSha256: input.binding.bindingDigestSha256,
    outcome: "proposed",
    exitCode: 10,
    finalState: input.run.state,
    verificationOutcome: input.run.verification?.outcome ?? null,
    usage: { ...input.run.usage },
    error: null,
    proposal: { patchSetSha256: input.patchSetSha256 },
  };
}

/**
 * Terminal settlement of the digest-bound application epoch (ADR 0060),
 * mirroring the continuation constructor's outcome mapping and linkage
 * validation against the durable apply intent.
 */
export function createAppliedHeadlessWorkerSettlementV1(input: {
  readonly binding: HeadlessExecutionBindingV1;
  readonly run: RunRecord;
  readonly events: readonly EventRecord[];
  readonly applyEventSequence: number;
  readonly proposalSettlementSequence: number;
  readonly patchSetSha256: string;
  readonly error?: { readonly code: string; readonly message: string } | null;
}): AppliedHeadlessWorkerSettlementV1 {
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
  invariant(
    Number.isSafeInteger(input.applyEventSequence) &&
      input.applyEventSequence > 0 &&
      Number.isSafeInteger(input.proposalSettlementSequence) &&
      input.proposalSettlementSequence > 0 &&
      input.proposalSettlementSequence < input.applyEventSequence &&
      /^[a-f0-9]{64}$/.test(input.patchSetSha256),
    "INVALID_HEADLESS_WORKER_HISTORY",
    "Headless worker application linkage is malformed",
  );
  const apply = input.events.find(
    (event) =>
      event.sequence === input.applyEventSequence &&
      event.type === "headless.worker.apply_requested",
  );
  invariant(
    apply !== undefined,
    "INVALID_HEADLESS_WORKER_HISTORY",
    "Headless worker application lacks its apply intent",
  );
  const applyPayload = eventPayload(apply, "Headless worker apply");
  invariant(
    applyPayload.schema === HEADLESS_WORKER_APPLY_SCHEMA &&
      applyPayload.bindingDigestSha256 === input.binding.bindingDigestSha256 &&
      applyPayload.patchSetSha256 === input.patchSetSha256,
    "HEADLESS_WORKER_IDENTITY_CHANGED",
    "Headless worker application does not match its apply intent",
  );
  assertQuiescent(input.events);
  const { outcome, exitCode } = outcomeFor(input.run, input.events);
  const error =
    input.error ??
    (outcome === "failed"
      ? (verificationFailureFor(input.run) ?? childFailureFor(input.events))
      : null);
  if (outcome === "failed" && error === null) {
    throw new IcarusError(
      "INCOMPLETE_HEADLESS_WORKER_SETTLEMENT",
      "Failed headless worker settlement requires an explicit error",
    );
  }
  return {
    schema: HEADLESS_WORKER_APPLICATION_SCHEMA,
    runId: input.run.id,
    bindingDigestSha256: input.binding.bindingDigestSha256,
    outcome,
    exitCode,
    finalState: input.run.state,
    verificationOutcome: input.run.verification?.outcome ?? null,
    usage: { ...input.run.usage },
    error,
    application: {
      applyEventSequence: input.applyEventSequence,
      proposalSettlementSequence: input.proposalSettlementSequence,
      patchSetSha256: input.patchSetSha256,
    },
  };
}

/**
 * Builds the terminal settlement of a governed continuation epoch (ADR 0058).
 * The settlement reuses the H2b outcome mapping and additionally binds the
 * exact resume-intent event and interrupted settlement it continues, so a
 * forged or drifting continuation is rejected by the lifecycle grammar.
 */
export function createContinuedHeadlessWorkerSettlementV1(input: {
  readonly binding: HeadlessExecutionBindingV1;
  readonly run: RunRecord;
  readonly events: readonly EventRecord[];
  readonly resumeEventSequence: number;
  readonly interruptedSettlementSequence: number;
  readonly reconstructionDigestSha256: string;
  readonly error?: { readonly code: string; readonly message: string } | null;
}): ContinuedHeadlessWorkerSettlementV1 {
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
  invariant(
    Number.isSafeInteger(input.resumeEventSequence) &&
      input.resumeEventSequence > 0 &&
      Number.isSafeInteger(input.interruptedSettlementSequence) &&
      input.interruptedSettlementSequence > 0 &&
      input.interruptedSettlementSequence < input.resumeEventSequence &&
      /^[a-f0-9]{64}$/.test(input.reconstructionDigestSha256),
    "INVALID_HEADLESS_WORKER_HISTORY",
    "Headless worker continuation linkage is malformed",
  );
  const resume = input.events.find(
    (event) =>
      event.sequence === input.resumeEventSequence &&
      event.type === "headless.worker.resume_requested",
  );
  invariant(
    resume !== undefined,
    "INVALID_HEADLESS_WORKER_HISTORY",
    "Headless worker continuation lacks its resume intent",
  );
  const resumePayload = eventPayload(resume, "Headless worker resume");
  invariant(
    resumePayload.schema === HEADLESS_WORKER_RESUME_SCHEMA &&
      resumePayload.bindingDigestSha256 === input.binding.bindingDigestSha256 &&
      resumePayload.reconstructionDigestSha256 === input.reconstructionDigestSha256,
    "HEADLESS_WORKER_IDENTITY_CHANGED",
    "Headless worker continuation does not match its resume intent",
  );
  assertQuiescent(input.events);
  const { outcome, exitCode } = outcomeFor(input.run, input.events);
  const error =
    input.error ??
    (outcome === "failed"
      ? (verificationFailureFor(input.run) ?? childFailureFor(input.events))
      : null);
  if (outcome === "failed" && error === null) {
    throw new IcarusError(
      "INCOMPLETE_HEADLESS_WORKER_SETTLEMENT",
      "Failed headless worker settlement requires an explicit error",
    );
  }
  return {
    schema: HEADLESS_WORKER_CONTINUATION_SCHEMA,
    runId: input.run.id,
    bindingDigestSha256: input.binding.bindingDigestSha256,
    outcome,
    exitCode,
    finalState: input.run.state,
    verificationOutcome: input.run.verification?.outcome ?? null,
    usage: { ...input.run.usage },
    error,
    continuation: {
      resumeEventSequence: input.resumeEventSequence,
      interruptedSettlementSequence: input.interruptedSettlementSequence,
      reconstructionDigestSha256: input.reconstructionDigestSha256,
    },
  };
}
