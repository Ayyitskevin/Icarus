import { describe, expect, test } from "vitest";

import type { HeadlessExecutionBindingV1 } from "../../packages/core/src/headless-binding.js";
import {
  decodeHeadlessProfileV1,
  headlessProfileDigest,
} from "../../packages/core/src/headless-profile.js";
import {
  createAppliedHeadlessWorkerSettlementV1,
  createProposedHeadlessWorkerSettlementV1,
  HEADLESS_WORKER_APPLICATION_SCHEMA,
  HEADLESS_WORKER_APPLY_SCHEMA,
  HEADLESS_WORKER_INTERRUPTION_SCHEMA,
  HEADLESS_WORKER_PROPOSAL_SCHEMA,
  HEADLESS_WORKER_SCHEMA,
  type HeadlessWorkerApplyRequestV1,
  headlessPatchSetDigestV1,
  inspectHeadlessWorkerLifecycleV1,
} from "../../packages/core/src/headless-worker.js";
import { createProviderConfig } from "../../packages/core/src/provider.js";
import type { CheckpointFile, EventRecord, RunRecord } from "../../packages/core/src/types.js";
import { UNIT_CEILING } from "../support/unit-fixtures.js";

const NOW = "2026-08-26T05:30:00.000Z";
const RUN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BINDING_DIGEST = "b".repeat(64);
const PATCHSET_DIGEST = "e".repeat(64);

const binding = {
  runId: RUN_ID,
  bindingDigestSha256: BINDING_DIGEST,
} as unknown as HeadlessExecutionBindingV1;

function run(state: RunRecord["state"], overrides: Partial<RunRecord> = {}): RunRecord {
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
    diff: null,
    verification: null,
    usage: {
      toolCalls: 3,
      inputTokens: 10,
      outputTokens: 5,
      upperBoundTokens: 0,
      activeRuntimeMs: 20,
      estimatedCostUsd: 0,
      reservedCostUsd: 0,
    },
    lastError: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function event(sequence: number, type: string, payload: EventRecord["payload"]): EventRecord {
  return { sequence, runId: RUN_ID, type, payload, createdAt: NOW };
}

function startedEvent(sequence = 1): EventRecord {
  return event(sequence, "headless.worker.started", {
    schema: HEADLESS_WORKER_SCHEMA,
    bindingDigestSha256: BINDING_DIGEST,
  });
}

function applyRequestEvent(sequence: number, overrides: Record<string, unknown> = {}): EventRecord {
  const payload: HeadlessWorkerApplyRequestV1 = {
    schema: HEADLESS_WORKER_APPLY_SCHEMA,
    runId: RUN_ID,
    bindingDigestSha256: BINDING_DIGEST,
    patchSetSha256: PATCHSET_DIGEST,
    startedEventSequence: 1,
    ...overrides,
  };
  return event(sequence, "headless.worker.apply_requested", {
    ...payload,
  } as unknown as EventRecord["payload"]);
}

const checkpointFiles = [
  {
    path: "src/greeting.txt",
    op: "modify" as const,
    baselineBase64: "YQ==",
    approvedBase64: "Yg==",
  },
];

function proposedSettlementEvent(sequence: number): EventRecord {
  const settlement = createProposedHeadlessWorkerSettlementV1({
    binding,
    run: run("running", {
      patchSet: { summary: "s", edits: [] } as unknown as RunRecord["patchSet"],
    }),
    events: [startedEvent(1)],
    patchSetSha256: PATCHSET_DIGEST,
  });
  return event(sequence, "headless.worker.settled", {
    ...settlement,
  } as unknown as EventRecord["payload"]);
}

function interruptedSettlementEvent(sequence: number): EventRecord {
  return event(sequence, "headless.worker.settled", {
    schema: HEADLESS_WORKER_INTERRUPTION_SCHEMA,
    runId: RUN_ID,
    bindingDigestSha256: BINDING_DIGEST,
    outcome: "interrupted",
    exitCode: 1,
    finalState: "running",
    verificationOutcome: null,
    usage: { ...run("running").usage },
    error: { code: "HEADLESS_WORKER_INTERRUPTED", message: "Worker process disappeared" },
    reconciliation: {
      startedEventSequence: 1,
      interruptedOperationIds: [],
      continuation: "requires_binding_reconstruction",
    },
  });
}

function appliedSettlementEvent(sequence: number, events: readonly EventRecord[]): EventRecord {
  const settlement = createAppliedHeadlessWorkerSettlementV1({
    binding,
    run: run("awaiting_review", {
      verification: {
        outcome: "passed",
        checks: [],
        changedPaths: [],
        diffSha256: "d".repeat(64),
        checkpointSha256: "c".repeat(64),
      },
    }),
    events,
    applyEventSequence: 3,
    proposalSettlementSequence: 2,
    patchSetSha256: PATCHSET_DIGEST,
  });
  return event(sequence, "headless.worker.settled", {
    ...settlement,
  } as unknown as EventRecord["payload"]);
}

function appliedEvents(): readonly EventRecord[] {
  const base = [startedEvent(1), proposedSettlementEvent(2), applyRequestEvent(3)];
  return [...base, appliedSettlementEvent(4, base)];
}

describe("worker mutation grammar", () => {
  function profileWith(worker: Record<string, unknown>): Record<string, unknown> {
    return {
      schemaVersion: 1,
      profileId: "unit-one-task",
      providerProfileId: "unit-provider",
      toolIds: [],
      budgets: { ...UNIT_CEILING, iterationCeiling: 0 },
      output: { format: "jsonl" },
      worker,
    };
  }

  test("absent mutation decodes identically and digests like pre-ADR-0060", () => {
    const closed = {
      mode: "one_task",
      maxConcurrency: 1,
      childRuns: "deny",
      scheduledRuns: "deny",
    };
    const profile = decodeHeadlessProfileV1(profileWith(closed));
    expect(profile.worker.mutation).toBeUndefined();
    expect(profile.worker).toEqual(closed);
    const before = decodeHeadlessProfileV1(profileWith(closed));
    expect(headlessProfileDigest(profile)).toBe(headlessProfileDigest(before));
  });

  test("propose and apply are the only admitted modes", () => {
    expect(
      decodeHeadlessProfileV1(
        profileWith({
          mode: "one_task",
          maxConcurrency: 1,
          childRuns: "deny",
          scheduledRuns: "deny",
          mutation: "propose",
        }),
      ).worker.mutation,
    ).toBe("propose");
    expect(
      decodeHeadlessProfileV1(
        profileWith({
          mode: "one_task",
          maxConcurrency: 1,
          childRuns: "deny",
          scheduledRuns: "deny",
          mutation: "apply",
        }),
      ).worker.mutation,
    ).toBe("apply");
    expect(() =>
      decodeHeadlessProfileV1(
        profileWith({
          mode: "one_task",
          maxConcurrency: 1,
          childRuns: "deny",
          scheduledRuns: "deny",
          mutation: "force",
        }),
      ),
    ).toThrow(/must equal propose or apply/);
    expect(() =>
      decodeHeadlessProfileV1(
        profileWith({
          mode: "one_task",
          maxConcurrency: 1,
          childRuns: "deny",
          scheduledRuns: "deny",
          mutation: "apply",
          force: true,
        }),
      ),
    ).toThrow(/missing or unknown keys/);
  });
});

describe("proposed worker settlement", () => {
  test("forms only over a running run with durable intent, and decodes back", () => {
    const lifecycle = inspectHeadlessWorkerLifecycleV1(RUN_ID, [
      startedEvent(1),
      proposedSettlementEvent(2),
    ]);
    expect(lifecycle).toMatchObject({
      status: "settled",
      settlement: {
        schema: HEADLESS_WORKER_PROPOSAL_SCHEMA,
        outcome: "proposed",
        exitCode: 10,
        finalState: "running",
        error: null,
        proposal: { patchSetSha256: PATCHSET_DIGEST },
      },
      interruptedSettlement: null,
    });
    expect(() =>
      createProposedHeadlessWorkerSettlementV1({
        binding,
        run: run("awaiting_review"),
        events: [],
        patchSetSha256: PATCHSET_DIGEST,
      }),
    ).toThrow(/requires a running run/);
    expect(() =>
      createProposedHeadlessWorkerSettlementV1({
        binding,
        run: run("running", {
          patchSet: { summary: "s", edits: [] } as unknown as RunRecord["patchSet"],
        }),
        events: [],
        patchSetSha256: "not-a-digest",
      }),
    ).toThrow(/digest is malformed/);
  });

  test("the patch-set digest matches the materialization binding", () => {
    expect(headlessPatchSetDigestV1(checkpointFiles)).toMatch(/^[a-f0-9]{64}$/);
    expect(headlessPatchSetDigestV1(checkpointFiles)).toBe(
      headlessPatchSetDigestV1([...checkpointFiles]),
    );
    expect(headlessPatchSetDigestV1(checkpointFiles)).not.toBe(
      headlessPatchSetDigestV1([
        {
          path: "src/greeting.txt",
          op: "modify",
          baselineBase64: "YQ==",
          approvedBase64: "Yw==",
        },
      ]),
    );
  });

  test("the patch-set digest distinguishes operation, baseline, and absent bytes", () => {
    const deleted: readonly CheckpointFile[] = [
      {
        path: "src/greeting.txt",
        op: "delete",
        baselineBase64: "YQ==",
        approvedBase64: null,
      },
    ];
    const emptied: readonly CheckpointFile[] = [
      {
        path: "src/greeting.txt",
        op: "modify",
        baselineBase64: "YQ==",
        approvedBase64: "",
      },
    ];
    const differentBaseline: readonly CheckpointFile[] = [
      {
        path: "src/greeting.txt",
        op: "modify",
        baselineBase64: "Yg==",
        approvedBase64: "",
      },
    ];

    expect(headlessPatchSetDigestV1(deleted)).not.toBe(headlessPatchSetDigestV1(emptied));
    expect(headlessPatchSetDigestV1(emptied)).not.toBe(headlessPatchSetDigestV1(differentBaseline));
  });
});

describe("application lifecycle grammar", () => {
  test("parses a complete proposal-apply-application lifecycle", () => {
    const lifecycle = inspectHeadlessWorkerLifecycleV1(RUN_ID, appliedEvents());
    expect(lifecycle).toMatchObject({
      status: "settled",
      settlement: {
        schema: HEADLESS_WORKER_APPLICATION_SCHEMA,
        outcome: "review_ready",
        exitCode: 0,
        application: {
          applyEventSequence: 3,
          proposalSettlementSequence: 2,
          patchSetSha256: PATCHSET_DIGEST,
        },
      },
      interruptedSettlement: null,
    });
  });

  test("apply intent requires a proposed settlement and exactly one epoch intent", () => {
    expect(() =>
      inspectHeadlessWorkerLifecycleV1(RUN_ID, [startedEvent(1), applyRequestEvent(2)]),
    ).toThrow(/without a first settlement/);
    const ordinary = {
      schema: HEADLESS_WORKER_SCHEMA,
      runId: RUN_ID,
      bindingDigestSha256: BINDING_DIGEST,
      outcome: "cancelled",
      exitCode: 130,
      finalState: "cancelled",
      verificationOutcome: null,
      usage: { ...run("cancelled").usage },
      error: null,
    };
    expect(() =>
      inspectHeadlessWorkerLifecycleV1(RUN_ID, [
        startedEvent(1),
        event(2, "headless.worker.settled", ordinary),
        applyRequestEvent(3),
      ]),
    ).toThrow(/must follow a proposed or interrupted settlement/);
    expect(() =>
      inspectHeadlessWorkerLifecycleV1(RUN_ID, [
        startedEvent(1),
        proposedSettlementEvent(2),
        applyRequestEvent(3),
        applyRequestEvent(4),
      ]),
    ).toThrow(/more than one apply request/);
  });

  test("an admitted interrupted proposal may enter the application epoch", () => {
    expect(
      inspectHeadlessWorkerLifecycleV1(RUN_ID, [
        startedEvent(1),
        interruptedSettlementEvent(2),
        applyRequestEvent(3),
      ]),
    ).toMatchObject({
      status: "started",
      applyRequest: { applyEventSequence: 3, patchSetSha256: PATCHSET_DIGEST },
      continuationRequest: null,
    });
  });

  test("a crashed application epoch stays open, then closes terminally", () => {
    const open = [
      startedEvent(1),
      proposedSettlementEvent(2),
      applyRequestEvent(3),
      event(4, "operation.started", { operationId: "op-1" }),
    ];
    expect(inspectHeadlessWorkerLifecycleV1(RUN_ID, open)).toMatchObject({
      status: "started",
      applyRequest: { applyEventSequence: 3, patchSetSha256: PATCHSET_DIGEST },
      continuationRequest: null,
    });
  });

  test("rejects an application settlement whose linkage drifts", () => {
    const events = appliedEvents();
    const drifted = (() => {
      const settlement = {
        ...createAppliedHeadlessWorkerSettlementV1({
          binding,
          run: run("awaiting_review", {
            verification: {
              outcome: "passed",
              checks: [],
              changedPaths: [],
              diffSha256: "d".repeat(64),
              checkpointSha256: "c".repeat(64),
            },
          }),
          events: events.slice(0, -1),
          applyEventSequence: 3,
          proposalSettlementSequence: 2,
          patchSetSha256: PATCHSET_DIGEST,
        }),
        application: {
          applyEventSequence: 99,
          proposalSettlementSequence: 2,
          patchSetSha256: PATCHSET_DIGEST,
        },
      };
      return event(4, "headless.worker.settled", settlement as unknown as EventRecord["payload"]);
    })();
    expect(() =>
      inspectHeadlessWorkerLifecycleV1(RUN_ID, [...events.slice(0, -1), drifted]),
    ).toThrow(/does not match its apply intent/);
  });
});
