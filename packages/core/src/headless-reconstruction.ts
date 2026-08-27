import { digestJson } from "./digest.js";
import { IcarusError, invariant } from "./errors.js";
import {
  type HeadlessExecutionBindingV1,
  reconstructHeadlessExecutionBindingV1,
} from "./headless-binding.js";
import {
  decodeHeadlessProfileV1,
  type HeadlessHostProviderProfileV1,
  headlessProfileDigest,
  resolveHeadlessProfileV1,
} from "./headless-profile.js";
import { inspectHeadlessWorkerLifecycleV1 } from "./headless-worker.js";
import type {
  ApprovalRecord,
  EventRecord,
  JsonValue,
  ProjectRecord,
  ProviderKind,
  ProviderLocality,
  ReadableManifest,
  RunRecord,
} from "./types.js";

// H3b evidence reconstruction (ADR 0057). This module is a pure read-only
// projection over durable run authority. It never appends an event, creates
// or settles an operation, records resume intent, invokes a provider,
// sandbox, Git controller, or model tool, or changes SQLite state. Its
// result is self-checking metadata for a later continuation design; neither
// the reconstruction digest nor any classification label is authority to
// resume, replay, or fork.

export const HEADLESS_RECONSTRUCTION_SCHEMA = "icarus.headless.reconstruction.v1";
export const HEADLESS_SESSION_RECONSTRUCTION_SCHEMA = "icarus.headless.reconstruction.v2";
/** Hard cap on classified crash-tail effects so the result stays bounded. */
export const HEADLESS_RECONSTRUCTION_EFFECT_LIMIT = 1024;

export type HeadlessEffectDispositionV1 = "no_effect" | "durably_settled" | "ambiguous";

export interface HeadlessCrashTailEffectV1 {
  readonly operationId: string;
  readonly kind: string | null;
  readonly startedSequence: number | null;
  readonly settlementSequence: number | null;
  readonly settlement: "finished" | "interrupted" | null;
  readonly disposition: HeadlessEffectDispositionV1;
}

export interface HeadlessReconstructionAuthorityV1 {
  readonly run: RunRecord;
  readonly project: ProjectRecord;
  readonly approvals: readonly ApprovalRecord[];
  readonly events: readonly EventRecord[];
  readonly readableManifest: ReadableManifest | null;
}

export interface HeadlessReconstructionProviderV1 {
  readonly kind: ProviderKind;
  readonly model: string;
  readonly baseUrl: string;
  readonly locality: ProviderLocality;
}

export interface HeadlessReconstructionWorkspaceV1 {
  readonly baseCommit: string;
  readonly contextSha256: string;
  readonly worktreeMaterialized: boolean;
}

export interface HeadlessSessionIterationBoundaryV1 {
  readonly eventSequence: number;
  readonly iterations: number;
}

interface HeadlessReconstructionBase {
  readonly runId: string;
  readonly projectId: string;
  readonly lifecycle: "started" | "settled";
  readonly startedEventSequence: number;
  readonly bindingDigestSha256: string;
  readonly profileDigestSha256: string;
  readonly resolutionDigestSha256: string;
  readonly planSha256: string;
  readonly provider: HeadlessReconstructionProviderV1;
  readonly workspace: HeadlessReconstructionWorkspaceV1;
  readonly effects: readonly HeadlessCrashTailEffectV1[];
  readonly reconstructionDigestSha256: string;
}

export interface HeadlessReconstructionV1 extends HeadlessReconstructionBase {
  readonly schema: typeof HEADLESS_RECONSTRUCTION_SCHEMA;
}

/**
 * A distinct version keeps the closed v1 evidence shape byte-stable while
 * binding the completed session batch needed by the ADR 0063 continuation.
 */
export interface HeadlessReconstructionV2 extends HeadlessReconstructionBase {
  readonly schema: typeof HEADLESS_SESSION_RECONSTRUCTION_SCHEMA;
  readonly sessionIterationBoundary: HeadlessSessionIterationBoundaryV1;
}

export type HeadlessReconstruction = HeadlessReconstructionV1 | HeadlessReconstructionV2;

/**
 * Operation kinds whose durable start cannot have produced any provider,
 * sandbox, workspace, or Git effect even when the worker died mid-call.
 * Every other kind is effectful when its settlement is not durably recorded.
 */
const NO_EFFECT_OPERATION_KINDS: ReadonlySet<string> = new Set([
  "session.tool.read.manifest",
  "session.tool.read.checks",
]);

/** The closed enumeration of operation kinds the runtime can begin. */
const KNOWN_OPERATION_KINDS: ReadonlySet<string> = new Set([
  "headless.child",
  "context.prepare",
  "egress.validate",
  "approval.validate",
  "provider.plan",
  "execution.prepare",
  "workspace.create",
  "edit.prepare",
  "provider.edit",
  "edit.materialize",
  "provider.revise",
  "session.tool.read.manifest",
  "session.tool.read.checks",
  "session.tool.exec.check",
  "session.tool.mutation.patchset",
  "session.reconcile",
  "session.control.report_done",
  "session.control.request_human_input",
  "verification.preflight",
  "sandbox.verify",
  "verification.postflight",
  "review.validate",
  "checkpoint.rollback",
  "checkpoint.restore",
  "cancellation.recovery",
]);

const OPERATION_EVENT_TYPES: ReadonlySet<string> = new Set([
  "operation.started",
  "operation.finished",
  "operation.interrupted",
]);

const FINISHED_OPERATION_MEMBERS = ["detail", "kind", "operationId", "outcome"] as const;

const STARTED_EVENT_MEMBERS = [
  "bindingDigestSha256",
  "budgets",
  "profileDigestSha256",
  "profileId",
  "providerProfileId",
  "resolutionDigestSha256",
  "schema",
  "toolIds",
  "worker",
] as const;

// H4: profiles that declare children carry them in the durable start payload;
// older payloads simply omit the member.
const STARTED_EVENT_CHILD_MEMBER = "children";

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

function denied(message: string): never {
  throw new IcarusError("HEADLESS_RECONSTRUCTION_AUTHORITY_DENIED", message);
}

function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function payloadObject(event: EventRecord, label: string): Readonly<Record<string, JsonValue>> {
  invariant(
    typeof event.payload === "object" && event.payload !== null && !Array.isArray(event.payload),
    "INVALID_HEADLESS_RECONSTRUCTION_HISTORY",
    `${label} payload is malformed`,
  );
  return event.payload;
}

function assertExactMembers(
  value: Readonly<Record<string, JsonValue>>,
  expectedMembers: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...expectedMembers].sort();
  invariant(
    actual.length === expected.length &&
      actual.every((member, index) => member === expected[index]),
    "INVALID_HEADLESS_RECONSTRUCTION_HISTORY",
    `${label} members are malformed`,
  );
}

function payloadDigest(
  payload: Readonly<Record<string, JsonValue>>,
  member: string,
  label: string,
): string {
  const value = payload[member];
  invariant(
    typeof value === "string" && DIGEST_PATTERN.test(value),
    "INVALID_HEADLESS_RECONSTRUCTION_HISTORY",
    `${label} ${member} is malformed`,
  );
  return value;
}

interface OperationEvidence {
  readonly operationId: string;
  readonly started: readonly EventRecord[];
  readonly finished: readonly EventRecord[];
  readonly interrupted: readonly EventRecord[];
}

function eventOperationIdentity(
  event: EventRecord,
  label: string,
): { readonly operationId: string; readonly kind: string } {
  const payload = payloadObject(event, label);
  const { operationId, kind } = payload;
  // Identity strings share the store's operation-kind discipline: bounded and
  // free of control characters so a hostile payload cannot grow the result.
  invariant(
    typeof operationId === "string" &&
      operationId.length > 0 &&
      Buffer.byteLength(operationId, "utf8") <= 128 &&
      !/[\r\n\0]/.test(operationId),
    "INVALID_HEADLESS_RECONSTRUCTION_HISTORY",
    `${label} operation identity is malformed`,
  );
  invariant(
    typeof kind === "string" &&
      kind.length > 0 &&
      Buffer.byteLength(kind, "utf8") <= 128 &&
      !/[\r\n\0]/.test(kind),
    "INVALID_HEADLESS_RECONSTRUCTION_HISTORY",
    `${label} operation kind is malformed`,
  );
  return { operationId, kind };
}

function classifyOperation(evidence: OperationEvidence): HeadlessCrashTailEffectV1 {
  const started = evidence.started[0];
  const finished = evidence.finished[0];
  const interrupted = evidence.interrupted[0];
  const startedKind =
    started === undefined ? null : eventOperationIdentity(started, "Operation start").kind;
  const eventKinds = [
    started === undefined ? null : startedKind,
    finished === undefined ? null : eventOperationIdentity(finished, "Operation finish").kind,
    interrupted === undefined
      ? null
      : eventOperationIdentity(interrupted, "Operation interruption").kind,
  ].filter((kind): kind is string => kind !== null);
  const terminators = evidence.finished.length + evidence.interrupted.length;

  // Missing, duplicate, contradictory, or unknown evidence is never settled.
  const consistent =
    evidence.started.length === 1 &&
    terminators <= 1 &&
    startedKind !== null &&
    started !== undefined &&
    eventKinds.every((kind) => kind === startedKind) &&
    (finished === undefined || finished.sequence > started.sequence) &&
    (interrupted === undefined || interrupted.sequence > started.sequence) &&
    KNOWN_OPERATION_KINDS.has(startedKind);

  let disposition: HeadlessEffectDispositionV1 = "ambiguous";
  let settlement: HeadlessCrashTailEffectV1["settlement"] = null;
  let settlementSequence: number | null = null;
  if (consistent && finished !== undefined) {
    const payload = payloadObject(finished, "Operation finish");
    const receipt =
      Object.keys(payload).every((member) =>
        (FINISHED_OPERATION_MEMBERS as readonly string[]).includes(member),
      ) &&
      Object.hasOwn(payload, "detail") &&
      (payload.outcome === "succeeded" || payload.outcome === "failed");
    settlement = "finished";
    settlementSequence = finished.sequence;
    disposition = receipt ? "durably_settled" : "ambiguous";
  } else if (consistent) {
    // An interrupted or still-open operation: only the closed read-only kinds
    // are provably free of any external effect.
    if (interrupted !== undefined) {
      settlement = "interrupted";
      settlementSequence = interrupted.sequence;
    }
    disposition = NO_EFFECT_OPERATION_KINDS.has(startedKind) ? "no_effect" : "ambiguous";
  }
  return {
    operationId: evidence.operationId,
    kind: startedKind,
    startedSequence: started?.sequence ?? null,
    settlementSequence,
    settlement,
    disposition,
  };
}

function classifyCrashTail(
  events: readonly EventRecord[],
  startedEventSequence: number,
): readonly HeadlessCrashTailEffectV1[] {
  const byOperation = new Map<
    string,
    { started: EventRecord[]; finished: EventRecord[]; interrupted: EventRecord[] }
  >();
  for (const event of events) {
    if (event.sequence <= startedEventSequence || !OPERATION_EVENT_TYPES.has(event.type)) {
      continue;
    }
    const { operationId } = eventOperationIdentity(event, "Operation history");
    let entry = byOperation.get(operationId);
    if (entry === undefined) {
      entry = { started: [], finished: [], interrupted: [] };
      byOperation.set(operationId, entry);
    }
    if (event.type === "operation.started") entry.started.push(event);
    else if (event.type === "operation.finished") entry.finished.push(event);
    else entry.interrupted.push(event);
  }
  invariant(
    byOperation.size <= HEADLESS_RECONSTRUCTION_EFFECT_LIMIT,
    "INVALID_HEADLESS_RECONSTRUCTION_HISTORY",
    "Headless crash tail exceeds the reconstruction effect limit",
  );
  return [...byOperation.entries()].map(([operationId, entry]) =>
    classifyOperation({ operationId, ...entry }),
  );
}

function latestSessionIterationBoundary(
  events: readonly EventRecord[],
  startedEventSequence: number,
): HeadlessSessionIterationBoundaryV1 | null {
  const boundaries = events.filter(
    (event) =>
      event.sequence > startedEventSequence && event.type === "session.iteration_completed",
  );
  let previous = 0;
  for (const boundary of boundaries) {
    const payload = payloadObject(boundary, "Session iteration boundary");
    assertExactMembers(payload, ["iterations"], "Session iteration boundary");
    const iterations = payload.iterations;
    invariant(
      Number.isSafeInteger(iterations) && iterations === previous + 1,
      "INVALID_HEADLESS_RECONSTRUCTION_HISTORY",
      "Session iteration boundaries are malformed or nonmonotonic",
    );
    previous = iterations as number;
  }
  const latest = boundaries.at(-1);
  if (latest === undefined) return null;
  return { eventSequence: latest.sequence, iterations: previous };
}

function durableStartedProfile(
  events: readonly EventRecord[],
  startedEventSequence: number,
): {
  readonly profile: unknown;
  readonly profileDigestSha256: string;
  readonly resolutionDigestSha256: string;
} {
  const started = events.find(
    (event) => event.sequence === startedEventSequence && event.type === "headless.worker.started",
  );
  invariant(
    started !== undefined,
    "INVALID_HEADLESS_RECONSTRUCTION_HISTORY",
    "Headless worker start event is missing from the durable tail",
  );
  const payload = payloadObject(started, "Headless worker start");
  assertExactMembers(
    payload,
    Object.hasOwn(payload, STARTED_EVENT_CHILD_MEMBER)
      ? [...STARTED_EVENT_MEMBERS, STARTED_EVENT_CHILD_MEMBER]
      : STARTED_EVENT_MEMBERS,
    "Headless worker start",
  );
  // The durable start payload carries every operator-selectable profile field;
  // schemaVersion and output are fixed by the H1 v1 grammar. Rebuilding the
  // source profile from these bytes and requiring its digest keeps the
  // projection bound to what the worker actually recorded.
  const profile = {
    schemaVersion: 1,
    profileId: payload.profileId,
    providerProfileId: payload.providerProfileId,
    toolIds: payload.toolIds,
    budgets: payload.budgets,
    output: { format: "jsonl" },
    worker: payload.worker,
    ...(Object.hasOwn(payload, STARTED_EVENT_CHILD_MEMBER) ? { children: payload.children } : {}),
  };
  return {
    profile,
    profileDigestSha256: payloadDigest(payload, "profileDigestSha256", "Headless worker start"),
    resolutionDigestSha256: payloadDigest(
      payload,
      "resolutionDigestSha256",
      "Headless worker start",
    ),
  };
}

/**
 * The continuation gate (ADR 0058) needs the reconstructed binding itself —
 * the resolved profile ceiling and tool filter — in addition to the public
 * evidence record. Both come from the same single recomputation.
 */
export interface HeadlessContinuationReconstructionV1 {
  readonly evidence: HeadlessReconstruction;
  readonly binding: HeadlessExecutionBindingV1;
}

function reconstructHeadlessCore(
  authority: HeadlessReconstructionAuthorityV1,
): HeadlessContinuationReconstructionV1 {
  const { run, project, events } = authority;
  invariant(
    typeof run === "object" && run !== null && !Array.isArray(run),
    "INVALID_HEADLESS_RECONSTRUCTION_HOST",
    "Host run record is invalid",
  );
  const lifecycle = inspectHeadlessWorkerLifecycleV1(run.id, events);
  invariant(
    lifecycle.status !== "absent",
    "MISSING_HEADLESS_WORKER",
    "Headless worker never started",
  );
  if (run.plan === null || run.planSha256 === null) {
    denied("headless reconstruction requires a persisted plan and digest");
  }
  // A resume request inside the worker lifecycle would contradict the
  // fail-closed H3 boundary; treat it as malformed evidence.
  invariant(
    !events.some(
      (event) =>
        event.sequence > lifecycle.startedEventSequence && event.type === "resume.requested",
    ),
    "INVALID_HEADLESS_RECONSTRUCTION_HISTORY",
    "Headless lifecycle contains resume intent",
  );

  const durable = durableStartedProfile(events, lifecycle.startedEventSequence);
  const profile = decodeHeadlessProfileV1(durable.profile);
  invariant(
    headlessProfileDigest(profile) === durable.profileDigestSha256,
    "HEADLESS_RECONSTRUCTION_AUTHORITY_DENIED",
    "Reconstructed profile digest does not match the durable worker start",
  );

  // The provider identity is rebuilt from the persisted run provider, which
  // the recomputed plan digest independently pins; no host catalog input or
  // provider adapter is consulted.
  const providerProfile: HeadlessHostProviderProfileV1 = {
    id: profile.providerProfileId,
    kind: run.provider.kind,
    model: run.provider.model,
    baseUrl: run.provider.baseUrl,
    inputUsdPerMillionTokens: run.provider.inputUsdPerMillionTokens,
    outputUsdPerMillionTokens: run.provider.outputUsdPerMillionTokens,
  };
  const resolution = resolveHeadlessProfileV1(profile, {
    providerProfiles: [providerProfile],
    projectCeiling: project.ceiling,
    approvedPlan: run.plan,
  });
  invariant(
    resolution.resolutionDigestSha256 === durable.resolutionDigestSha256,
    "HEADLESS_RECONSTRUCTION_AUTHORITY_DENIED",
    "Reconstructed resolution digest does not match the durable worker start",
  );

  const binding = reconstructHeadlessExecutionBindingV1(profile, {
    run,
    project,
    approvals: authority.approvals,
    readableManifest: authority.readableManifest,
    providerProfiles: [providerProfile],
  });
  invariant(
    binding.bindingDigestSha256 === lifecycle.bindingDigestSha256,
    "HEADLESS_RECONSTRUCTION_AUTHORITY_DENIED",
    "Reconstructed binding digest does not match the durable headless lifecycle",
  );

  const effects = classifyCrashTail(events, lifecycle.startedEventSequence);
  const sessionIterationBoundary = latestSessionIterationBoundary(
    events,
    lifecycle.startedEventSequence,
  );
  const commonPayload = {
    runId: run.id,
    projectId: project.id,
    lifecycle: lifecycle.status,
    startedEventSequence: lifecycle.startedEventSequence,
    bindingDigestSha256: binding.bindingDigestSha256,
    profileDigestSha256: binding.profileDigestSha256,
    resolutionDigestSha256: binding.resolutionDigestSha256,
    planSha256: run.planSha256,
    provider: {
      kind: resolution.provider.kind,
      model: resolution.provider.model,
      baseUrl: resolution.provider.baseUrl,
      locality: resolution.provider.capabilities.locality,
    },
    workspace: {
      baseCommit: run.baseCommit,
      contextSha256: run.contextSha256,
      worktreeMaterialized: run.worktreePath !== null,
    },
    effects,
  } as const;
  if (sessionIterationBoundary === null) {
    const payload = { schema: HEADLESS_RECONSTRUCTION_SCHEMA, ...commonPayload } as const;
    return {
      evidence: {
        ...payload,
        reconstructionDigestSha256: digestJson(json(payload)),
      },
      binding,
    };
  }
  const payload = {
    schema: HEADLESS_SESSION_RECONSTRUCTION_SCHEMA,
    ...commonPayload,
    sessionIterationBoundary,
  } as const;
  return {
    evidence: {
      ...payload,
      reconstructionDigestSha256: digestJson(json(payload)),
    },
    binding,
  };
}

export function reconstructHeadlessEvidenceV1(
  authority: HeadlessReconstructionAuthorityV1,
): HeadlessReconstruction {
  return reconstructHeadlessCore(authority).evidence;
}

/**
 * ADR 0058 continuation support: the same evidence recomputation, plus the
 * reconstructed H2a binding for the governed resume path. Still pure: no
 * event, operation, lease, or provider effect is created here.
 */
export function reconstructHeadlessContinuationV1(
  authority: HeadlessReconstructionAuthorityV1,
): HeadlessContinuationReconstructionV1 {
  return reconstructHeadlessCore(authority);
}
