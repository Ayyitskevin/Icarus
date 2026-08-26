import { describe, expect, test } from "vitest";

import { assertHeadlessContinuationReplaySafeV1 } from "../../packages/core/src/headless-continuation.js";
import type {
  HeadlessCrashTailEffectV1,
  HeadlessReconstructionV1,
} from "../../packages/core/src/headless-reconstruction.js";
import type { HeadlessExecutionBindingV1 } from "../../packages/core/src/headless-binding.js";
import {
  createContinuedHeadlessWorkerSettlementV1,
  createInterruptedHeadlessWorkerSettlementV1,
  HEADLESS_WORKER_CONTINUATION_SCHEMA,
  HEADLESS_WORKER_INTERRUPTION_SCHEMA,
  HEADLESS_WORKER_RESUME_SCHEMA,
  HEADLESS_WORKER_SCHEMA,
  type HeadlessWorkerResumeRequestV1,
  inspectHeadlessWorkerLifecycleV1,
} from "../../packages/core/src/headless-worker.js";
import { createProviderConfig } from "../../packages/core/src/provider.js";
import type { EventRecord, RunRecord } from "../../packages/core/src/types.js";

const RUN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BINDING_DIGEST = "b".repeat(64);
const RECONSTRUCTION_DIGEST = "e".repeat(64);

const binding = {
  runId: RUN_ID,
  bindingDigestSha256: BINDING_DIGEST,
} as unknown as HeadlessExecutionBindingV1;

function run(
  state: RunRecord["state"],
  verification: "passed" | "failed" | "unavailable" | null,
): RunRecord {
  return {
    id: RUN_ID,
    projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    task: "Replace the greeting.",
    target: "src/greeting.txt",
    provider: createProviderConfig({
      kind: "ollama",
      model: "unit-model",
      baseUrl: "http://127.0.0.1:11434/",
    }),
    state,
    resumeState: null,
    baseCommit: "c".repeat(40),
    context: {
      auditPolicyVersion: "tracked-tree-secret-audit-v2",
      baseCommit: "c".repeat(40),
      targets: ["src/greeting.txt"],
      repositoryMap: ["src/greeting.txt"],
      entries: [],
      totalBytes: 0,
    },
    contextArtifactPath: "contexts/unit.json",
    contextSha256: "d".repeat(64),
    plan: null,
    planSha256: "f".repeat(64),
    patchSet: null,
    cachePath: null,
    worktreePath: null,
    baselineBase64: null,
    approvedBase64: null,
    diff: verification === null ? null : "diff",
    verification:
      verification === null
        ? null
        : {
            outcome: verification,
            checks: [],
            changedPaths: [],
            diffSha256: "d".repeat(64),
            checkpointSha256: "c".repeat(64),
          },
    usage: {
      toolCalls: 3,
      inputTokens: 10,
      outputTokens: 5,
      activeRuntimeMs: 20,
      estimatedCostUsd: 0,
      reservedCostUsd: 0,
    },
    lastError: null,
    createdAt: "2026-08-26T12:00:00.000Z",
    updatedAt: "2026-08-26T12:00:01.000Z",
  };
}

function event(sequence: number, type: string, payload: EventRecord["payload"]): EventRecord {
  return { sequence, runId: RUN_ID, type, payload, createdAt: "2026-08-26T12:00:00.000Z" };
}

function startedEvent(sequence = 1): EventRecord {
  return event(sequence, "headless.worker.started", {
    schema: HEADLESS_WORKER_SCHEMA,
    bindingDigestSha256: BINDING_DIGEST,
  });
}

function resumeRequest(sequence: number, overrides: Record<string, unknown> = {}): EventRecord {
  const payload: HeadlessWorkerResumeRequestV1 = {
    schema: HEADLESS_WORKER_RESUME_SCHEMA,
    runId: RUN_ID,
    bindingDigestSha256: BINDING_DIGEST,
    reconstructionDigestSha256: RECONSTRUCTION_DIGEST,
    startedEventSequence: 1,
    ...overrides,
  };
  return event(
    sequence,
    "headless.worker.resume_requested",
    payload as unknown as EventRecord["payload"],
  );
}

function interruptedSettlementEvent(sequence: number, tail: readonly EventRecord[]): EventRecord {
  const settlement = createInterruptedHeadlessWorkerSettlementV1({
    run: run("running", null),
    events: tail,
  });
  return event(
    sequence,
    "headless.worker.settled",
    settlement as unknown as EventRecord["payload"],
  );
}

function continuedSettlementEvent(
  sequence: number,
  events: readonly EventRecord[],
  overrides: Record<string, unknown> = {},
): EventRecord {
  const resume = events.find((event) => event.type === "headless.worker.resume_requested");
  const interrupted = events.find((event) => event.type === "headless.worker.settled");
  if (resume === undefined || interrupted === undefined) {
    throw new Error("continuation fixture requires resume and interrupted events");
  }
  const settlement = {
    ...createContinuedHeadlessWorkerSettlementV1({
      binding,
      run: run("awaiting_review", "passed"),
      events,
      resumeEventSequence: resume.sequence,
      interruptedSettlementSequence: interrupted.sequence,
      reconstructionDigestSha256: RECONSTRUCTION_DIGEST,
    }),
    ...overrides,
  };
  return event(
    sequence,
    "headless.worker.settled",
    settlement as unknown as EventRecord["payload"],
  );
}

/** A complete continued lifecycle: start, crash settlement, intent, settlement. */
function continuedEvents(): readonly EventRecord[] {
  const base = [
    startedEvent(1),
    event(2, "operation.started", { operationId: "op-1" }),
    event(3, "operation.interrupted", { operationId: "op-1" }),
  ];
  const interrupted = interruptedSettlementEvent(4, base);
  const tail = [...base, interrupted, resumeRequest(5)];
  return [
    ...tail,
    event(6, "operation.started", { operationId: "op-2" }),
    event(7, "operation.finished", {
      operationId: "op-2",
      kind: "verification.postflight",
      outcome: "succeeded",
      detail: {},
    }),
    continuedSettlementEvent(8, tail),
  ];
}

describe("headless continuation lifecycle grammar", () => {
  test("parses a complete continued lifecycle and exposes both settlements", () => {
    const lifecycle = inspectHeadlessWorkerLifecycleV1(RUN_ID, continuedEvents());
    expect(lifecycle).toMatchObject({
      status: "settled",
      bindingDigestSha256: BINDING_DIGEST,
      startedEventSequence: 1,
      settlement: {
        schema: HEADLESS_WORKER_CONTINUATION_SCHEMA,
        outcome: "review_ready",
        exitCode: 0,
        continuation: {
          resumeEventSequence: 5,
          interruptedSettlementSequence: 4,
          reconstructionDigestSha256: RECONSTRUCTION_DIGEST,
        },
      },
      interruptedSettlement: {
        schema: HEADLESS_WORKER_INTERRUPTION_SCHEMA,
        outcome: "interrupted",
      },
    });
  });

  test("a crashed continuation epoch stays open for reconciliation", () => {
    const base = [
      startedEvent(1),
      event(2, "operation.started", { operationId: "op-1" }),
      event(3, "operation.interrupted", { operationId: "op-1" }),
    ];
    const interrupted = interruptedSettlementEvent(4, base);
    const open = [
      ...base,
      interrupted,
      resumeRequest(5),
      event(6, "operation.started", { operationId: "op-2" }),
    ];
    expect(inspectHeadlessWorkerLifecycleV1(RUN_ID, open)).toEqual({
      status: "started",
      bindingDigestSha256: BINDING_DIGEST,
      startedEventSequence: 1,
      continuationRequest: {
        resumeEventSequence: 5,
        reconstructionDigestSha256: RECONSTRUCTION_DIGEST,
      },
    });
  });

  test("a reconciled crashed continuation closes terminally with a second interruption", () => {
    const base = [
      startedEvent(1),
      event(2, "operation.started", { operationId: "op-1" }),
      event(3, "operation.interrupted", { operationId: "op-1" }),
    ];
    const interrupted = interruptedSettlementEvent(4, base);
    const crashedContinuation = [
      ...base,
      interrupted,
      resumeRequest(5),
      event(6, "operation.started", { operationId: "op-2" }),
      event(7, "operation.interrupted", { operationId: "op-2" }),
    ];
    const closure = createInterruptedHeadlessWorkerSettlementV1({
      run: run("verifying", null),
      events: crashedContinuation,
    });
    // The full-tail rule links every durable interruption after the start.
    expect(closure.reconciliation.interruptedOperationIds).toEqual(["op-1", "op-2"]);
    const closed = [
      ...crashedContinuation,
      event(8, "headless.worker.settled", closure as unknown as EventRecord["payload"]),
    ];
    const lifecycle = inspectHeadlessWorkerLifecycleV1(RUN_ID, closed);
    expect(lifecycle).toMatchObject({
      status: "settled",
      settlement: { schema: HEADLESS_WORKER_INTERRUPTION_SCHEMA, outcome: "interrupted" },
      interruptedSettlement: { schema: HEADLESS_WORKER_INTERRUPTION_SCHEMA },
    });
  });

  test("rejects resume intent without an interrupted settlement", () => {
    expect(() =>
      inspectHeadlessWorkerLifecycleV1(RUN_ID, [startedEvent(1), resumeRequest(2)]),
    ).toThrowError(/without an interrupted settlement/);
    const ordinary = {
      schema: HEADLESS_WORKER_SCHEMA,
      runId: RUN_ID,
      bindingDigestSha256: BINDING_DIGEST,
      outcome: "cancelled",
      exitCode: 130,
      finalState: "cancelled",
      verificationOutcome: null,
      usage: { ...run("cancelled", null).usage },
      error: null,
    };
    expect(() =>
      inspectHeadlessWorkerLifecycleV1(RUN_ID, [
        startedEvent(1),
        event(2, "headless.worker.settled", ordinary),
        resumeRequest(3),
      ]),
    ).toThrowError(/must follow an interrupted settlement/);
  });

  test("rejects a continuation settlement without resume intent or a third settlement", () => {
    const events = continuedEvents();
    const withoutResume = events.filter(
      (candidate) => candidate.type !== "headless.worker.resume_requested",
    );
    expect(() => inspectHeadlessWorkerLifecycleV1(RUN_ID, withoutResume)).toThrowError(
      /without resume intent/,
    );
    expect(() =>
      inspectHeadlessWorkerLifecycleV1(RUN_ID, [...events, events.at(-1) as EventRecord]),
    ).toThrowError(/more than two settlements/);
    expect(() =>
      inspectHeadlessWorkerLifecycleV1(RUN_ID, [
        startedEvent(1),
        resumeRequest(2),
        resumeRequest(3),
      ]),
    ).toThrowError(/more than one resume request/);
  });

  test("rejects a continuation settlement whose linkage drifts", () => {
    const events = continuedEvents();
    const tail = events.slice(0, -1);
    const settlement = {
      ...createContinuedHeadlessWorkerSettlementV1({
        binding,
        run: run("awaiting_review", "passed"),
        events: tail,
        resumeEventSequence: 5,
        interruptedSettlementSequence: 4,
        reconstructionDigestSha256: RECONSTRUCTION_DIGEST,
      }),
      continuation: {
        resumeEventSequence: 99,
        interruptedSettlementSequence: 4,
        reconstructionDigestSha256: RECONSTRUCTION_DIGEST,
      },
    };
    const badResumeSequence = [
      ...tail,
      event(8, "headless.worker.settled", settlement as unknown as EventRecord["payload"]),
    ];
    expect(() => inspectHeadlessWorkerLifecycleV1(RUN_ID, badResumeSequence)).toThrowError(
      /does not match its resume intent/,
    );
  });
});

describe("continued headless worker settlement", () => {
  test("requires the exact resume intent and binding", () => {
    const base = [
      startedEvent(1),
      event(2, "operation.started", { operationId: "op-1" }),
      event(3, "operation.interrupted", { operationId: "op-1" }),
    ];
    const tail = [...base, interruptedSettlementEvent(4, base), resumeRequest(5)];
    const created = createContinuedHeadlessWorkerSettlementV1({
      binding,
      run: run("awaiting_review", "passed"),
      events: tail,
      resumeEventSequence: 5,
      interruptedSettlementSequence: 4,
      reconstructionDigestSha256: RECONSTRUCTION_DIGEST,
    });
    expect(created).toMatchObject({
      schema: HEADLESS_WORKER_CONTINUATION_SCHEMA,
      outcome: "review_ready",
      exitCode: 0,
      continuation: {
        resumeEventSequence: 5,
        interruptedSettlementSequence: 4,
        reconstructionDigestSha256: RECONSTRUCTION_DIGEST,
      },
    });
    expect(() =>
      createContinuedHeadlessWorkerSettlementV1({
        binding,
        run: run("awaiting_review", "passed"),
        events: tail,
        resumeEventSequence: 5,
        interruptedSettlementSequence: 4,
        reconstructionDigestSha256: "0".repeat(64),
      }),
    ).toThrowError(/does not match its resume intent/);
    expect(() =>
      createContinuedHeadlessWorkerSettlementV1({
        binding,
        run: run("awaiting_review", "passed"),
        events: tail.filter((candidate) => candidate.type !== "headless.worker.resume_requested"),
        resumeEventSequence: 5,
        interruptedSettlementSequence: 4,
        reconstructionDigestSha256: RECONSTRUCTION_DIGEST,
      }),
    ).toThrowError(/lacks its resume intent/);
  });
});

function effect(overrides: Partial<HeadlessCrashTailEffectV1>): HeadlessCrashTailEffectV1 {
  return {
    operationId: "op-1",
    kind: "provider.edit",
    startedSequence: 2,
    settlementSequence: 3,
    settlement: "finished",
    disposition: "durably_settled",
    ...overrides,
  };
}

function evidence(effects: readonly HeadlessCrashTailEffectV1[]): HeadlessReconstructionV1 {
  return {
    schema: "icarus.headless.reconstruction.v1",
    runId: RUN_ID,
    projectId: "project-unit",
    lifecycle: "settled",
    startedEventSequence: 1,
    bindingDigestSha256: BINDING_DIGEST,
    profileDigestSha256: "a".repeat(64),
    resolutionDigestSha256: "0".repeat(64),
    planSha256: "f".repeat(64),
    provider: {
      kind: "ollama",
      model: "unit-model",
      baseUrl: "http://127.0.0.1:11434/",
      locality: "loopback",
    },
    workspace: {
      baseCommit: "c".repeat(40),
      contextSha256: "d".repeat(64),
      worktreeMaterialized: true,
    },
    effects,
    reconstructionDigestSha256: RECONSTRUCTION_DIGEST,
  };
}

describe("headless continuation replay-safety gate", () => {
  test("admits a clean single-shot crash tail with durable successor intent", () => {
    const admitted: RunRecord = {
      ...run("verifying", null),
      worktreePath: "/private/worktree",
      patchSet: { summary: "s", edits: [] } as unknown as RunRecord["patchSet"],
    };
    expect(() =>
      assertHeadlessContinuationReplaySafeV1(
        evidence([effect({ kind: "workspace.create" }), effect({ kind: "provider.edit" })]),
        admitted,
      ),
    ).not.toThrow();
  });

  test("refuses any ambiguous crash-tail effect", () => {
    const admitted: RunRecord = {
      ...run("verifying", null),
      worktreePath: "/private/worktree",
      patchSet: { summary: "s", edits: [] } as unknown as RunRecord["patchSet"],
    };
    expect(() =>
      assertHeadlessContinuationReplaySafeV1(
        evidence([
          effect({ kind: "workspace.create" }),
          effect({
            kind: "edit.materialize",
            settlement: "interrupted",
            disposition: "ambiguous",
          }),
        ]),
        admitted,
      ),
    ).toThrowError(/unknown durable outcome/);
  });

  test("refuses a settled effect whose durable successor intent is missing", () => {
    const withWorkspace: RunRecord = { ...run("running", null), worktreePath: "/private/worktree" };
    expect(() =>
      assertHeadlessContinuationReplaySafeV1(evidence([effect({ kind: "provider.edit" })]), {
        ...withWorkspace,
      }),
    ).toThrowError(/patch-set intent/);
    expect(() =>
      assertHeadlessContinuationReplaySafeV1(evidence([effect({ kind: "workspace.create" })]), {
        ...run("running", null),
        patchSet: { summary: "s", edits: [] } as unknown as RunRecord["patchSet"],
      }),
    ).toThrowError(/workspace identity/);
    expect(() =>
      assertHeadlessContinuationReplaySafeV1(evidence([effect({ kind: "sandbox.verify" })]), {
        ...withWorkspace,
        patchSet: { summary: "s", edits: [] } as unknown as RunRecord["patchSet"],
      }),
    ).toThrowError(/verification evidence/);
  });

  test("refuses session-turn and foreign crash-tail kinds", () => {
    const admitted: RunRecord = {
      ...run("running", null),
      worktreePath: "/private/worktree",
      patchSet: { summary: "s", edits: [] } as unknown as RunRecord["patchSet"],
    };
    expect(() =>
      assertHeadlessContinuationReplaySafeV1(
        evidence([effect({ kind: "session.tool.read.manifest", disposition: "no_effect" })]),
        admitted,
      ),
    ).toThrowError(/not continuable/);
    expect(() =>
      assertHeadlessContinuationReplaySafeV1(
        evidence([effect({ kind: "provider.revise" })]),
        admitted,
      ),
    ).toThrowError(/not continuable/);
  });

  test("refuses states that are neither re-drivable nor settle-only", () => {
    expect(() =>
      assertHeadlessContinuationReplaySafeV1(evidence([]), run("cancelling", null)),
    ).toThrowError(/cannot re-enter run state/);
    expect(() =>
      assertHeadlessContinuationReplaySafeV1(evidence([]), run("awaiting_review", "passed")),
    ).not.toThrow();
  });
});
