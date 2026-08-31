import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { canonicalJsonLine } from "../../packages/core/src/canonical-json.js";
import { digestJson } from "../../packages/core/src/digest.js";
import { IcarusError } from "../../packages/core/src/errors.js";
import {
  createHeadlessStreamLines,
  HEADLESS_STREAM_SCHEMA,
  type HeadlessStreamContentLineV1,
  headlessStreamContentSha256,
} from "../../packages/core/src/headless-stream.js";
import type {
  ApprovalRecord,
  EventRecord,
  JsonValue,
  PatchSet,
  RunHistory,
  RunRecord,
} from "../../packages/core/src/types.js";
import { CONTEXT_AUDIT_POLICY_VERSION } from "../../packages/core/src/types.js";
import { UNIT_CEILING } from "../support/unit-fixtures.js";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const BASE_COMMIT = "b".repeat(40);
const CONTEXT_SHA = "c".repeat(64);
const PLAN_SHA = "d".repeat(64);
const BINDING_DIGEST = "e".repeat(64);
const DIFF_SHA = "f".repeat(64);
const CHECKPOINT_SHA = "a".repeat(64);
const APPROVED_SHA = "1".repeat(64);

const PATCH_SET: PatchSet = {
  summary: "Fix the greeting",
  edits: [
    {
      op: "modify",
      path: "src/greeting.txt",
      expectedPreimageSha256: "2".repeat(64),
      replacements: [{ findText: "Icrus", replaceText: "Icarus" }],
      rationale: "Correct the typo",
    },
  ],
};

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: RUN_ID,
    projectId: "project-1",
    task: "Fix the greeting",
    target: "src/greeting.txt",
    provider: {
      kind: "ollama",
      model: "contract-model",
      baseUrl: "http://127.0.0.1:11434/",
      inputUsdPerMillionTokens: null,
      outputUsdPerMillionTokens: null,
      capabilities: {
        contextSize: null,
        toolSupport: false,
        visionSupport: false,
        structuredOutputSupport: true,
        streamingSupport: false,
        costClass: "local",
        latencyClass: "local",
        privacyClass: "local_process",
        reasoningQuality: "unknown",
        locality: "loopback",
      },
    },
    state: "awaiting_review",
    resumeState: null,
    baseCommit: BASE_COMMIT,
    context: {
      auditPolicyVersion: CONTEXT_AUDIT_POLICY_VERSION,
      baseCommit: BASE_COMMIT,
      targets: ["src/greeting.txt"],
      repositoryMap: [],
      entries: [],
      totalBytes: 0,
    },
    contextArtifactPath: "runs/1/context.json",
    contextSha256: CONTEXT_SHA,
    plan: {
      summary: "Fix the greeting",
      steps: ["edit"],
      risks: [],
      target: "src/greeting.txt",
      targets: ["src/greeting.txt"],
      iterationCeiling: 0,
      checkIds: ["verify"],
      grants: [{ kind: "exec.check", scope: ["verify"], maxCalls: 1 }],
    },
    planSha256: PLAN_SHA,
    patchSet: PATCH_SET,
    cachePath: null,
    worktreePath: null,
    baselineBase64: null,
    approvedBase64: null,
    diff: null,
    verification: {
      outcome: "passed",
      checks: [
        {
          checkId: "verify",
          argv: ["python", "checks/verify.py"],
          exitCode: 0,
          signal: null,
          durationMs: 12,
          stdout: "ok",
          stderr: "",
          truncated: false,
          outcome: "passed",
        },
      ],
      changedPaths: ["src/greeting.txt"],
      diffSha256: DIFF_SHA,
      checkpointSha256: CHECKPOINT_SHA,
    },
    usage: {
      toolCalls: 0,
      inputTokens: 10,
      outputTokens: 5,
      upperBoundTokens: 0,
      activeRuntimeMs: 100,
      estimatedCostUsd: 0,
      reservedCostUsd: 0,
    },
    lastError: null,
    createdAt: "2026-08-26T12:00:00.000Z",
    updatedAt: "2026-08-26T12:01:00.000Z",
    ...overrides,
  };
}

function approvals(): readonly ApprovalRecord[] {
  return [
    {
      runId: RUN_ID,
      kind: "plan",
      digest: PLAN_SHA,
      actor: "operator",
      decision: "approve",
      createdAt: "2026-08-26T12:00:10.000Z",
    },
  ];
}

function event(
  sequence: number,
  type: string,
  payload: JsonValue,
  createdAt = `2026-08-26T12:00:${String(10 + sequence).padStart(2, "0")}.000Z`,
): EventRecord {
  return { sequence, runId: RUN_ID, type, payload, createdAt };
}

function headlessEvents(): readonly EventRecord[] {
  return [
    event(1, "run.created", { state: "preparing", target: "src/greeting.txt" }),
    event(2, "base.pinned", { baseCommit: BASE_COMMIT }),
    event(3, "context.assembled", {
      from: "preparing",
      to: "planned",
      contextSha256: CONTEXT_SHA,
    }),
    event(4, "plan.created", {
      from: "planned",
      to: "awaiting_approval",
      planSha256: PLAN_SHA,
      readableFiles: 0,
    }),
    event(5, "headless.worker.started", {
      schema: "icarus.headless.worker.v1",
      bindingDigestSha256: BINDING_DIGEST,
      profileDigestSha256: "3".repeat(64),
      resolutionDigestSha256: "4".repeat(64),
      profileId: "local-headless",
      providerProfileId: "local-provider",
      toolIds: [],
      budgets: {},
      worker: { mode: "one_task" },
    }),
    event(6, "patch_set.intent_recorded", {
      paths: ["src/greeting.txt"],
      operations: ["modify"],
    }),
    event(7, "edit.materialized", {
      from: "running",
      to: "verifying",
      detail: {
        target: "src/greeting.txt",
        approvedSha256: APPROVED_SHA,
      },
    }),
    event(8, "verification.completed", {
      from: "verifying",
      to: "awaiting_review",
      outcome: "passed",
      diffSha256: DIFF_SHA,
      diff: "diff-bytes",
      verification: {
        outcome: "passed",
        checks: [
          {
            checkId: "verify",
            argv: ["python", "checks/verify.py"],
            exitCode: 0,
            signal: null,
            durationMs: 12,
            stdout: "ok",
            stderr: "",
            truncated: false,
            outcome: "passed",
          },
        ],
        changedPaths: ["src/greeting.txt"],
        diffSha256: DIFF_SHA,
        checkpointSha256: CHECKPOINT_SHA,
      },
    }),
    event(9, "headless.worker.settled", {
      schema: "icarus.headless.worker.v1",
      runId: RUN_ID,
      bindingDigestSha256: BINDING_DIGEST,
      outcome: "review_ready",
      exitCode: 0,
      finalState: "awaiting_review",
      verificationOutcome: "passed",
      usage: {
        toolCalls: 0,
        inputTokens: 10,
        outputTokens: 5,
        activeRuntimeMs: 100,
        estimatedCostUsd: 0,
        reservedCostUsd: 0,
      },
      error: null,
    }),
  ];
}

function workerStartedEvent(
  sequence: number,
  declaredChildIds: readonly string[] = [],
): EventRecord {
  const started = headlessEvents().find((entry) => entry.type === "headless.worker.started");
  expect(started).toBeDefined();
  const payload = (started as EventRecord).payload as Readonly<Record<string, JsonValue>>;
  return {
    ...(started as EventRecord),
    sequence,
    payload: {
      ...payload,
      ...(declaredChildIds.length === 0
        ? {}
        : {
            children: declaredChildIds.map((childId) => ({
              childId,
              task: `Run declared child ${childId}`,
              targets: ["src/greeting.txt"],
              toolIds: [],
              budgets: { ...UNIT_CEILING, iterationCeiling: 0 },
            })),
          }),
    },
  };
}

function childSettlementPayload(
  overrides: Readonly<Record<string, JsonValue>> = {},
): Record<string, JsonValue> {
  return {
    schema: "icarus.headless.child-settlement.v1",
    runId: RUN_ID,
    childId: "c1",
    childRunId: "22222222-2222-4222-8222-222222222222",
    outcome: "review_ready",
    exitCode: 0,
    childBindingDigestSha256: "6".repeat(64),
    error: null,
    ...overrides,
  };
}

function history(overrides: Partial<RunHistory> = {}): RunHistory {
  return { run: run(), approvals: approvals(), events: headlessEvents(), ...overrides };
}

function expectInvalidStream(candidate: RunHistory): void {
  try {
    createHeadlessStreamLines(candidate);
  } catch (error) {
    expect(error).toBeInstanceOf(IcarusError);
    expect((error as IcarusError).code).toBe("INVALID_HEADLESS_STREAM");
    return;
  }
  throw new Error("Expected INVALID_HEADLESS_STREAM");
}

describe("headless receipt stream", () => {
  test("projects a settled headless run into a receipt-bound, checksum-terminated stream", () => {
    const lines = createHeadlessStreamLines(history());

    expect(lines.every((line) => line.schema === HEADLESS_STREAM_SCHEMA)).toBe(true);
    expect(lines.map((line) => line.sequence)).toEqual(lines.map((_, index) => index + 1));
    expect(lines.map((line) => line.kind)).toEqual([
      "init",
      "grant",
      "plan",
      "init",
      "patchset",
      "patchset",
      "check",
      "receipt",
      "result",
    ]);

    const [initRun, grant, plan, initWorker, intent, materialized, check, receipt, result] =
      lines as [
        Extract<(typeof lines)[number], { kind: "init" }>,
        Extract<(typeof lines)[number], { kind: "grant" }>,
        Extract<(typeof lines)[number], { kind: "init" }>,
        Extract<(typeof lines)[number], { kind: "plan" }>,
        Extract<(typeof lines)[number], { kind: "patchset" }>,
        Extract<(typeof lines)[number], { kind: "patchset" }>,
        Extract<(typeof lines)[number], { kind: "check" }>,
        Extract<(typeof lines)[number], { kind: "receipt" }>,
        Extract<(typeof lines)[number], { kind: "result" }>,
      ];

    expect(initRun).toMatchObject({
      phase: "run_created",
      baseCommit: BASE_COMMIT,
      contextSha256: CONTEXT_SHA,
      bindingDigestSha256: null,
      source: { type: "event", sequence: 1, eventType: "run.created" },
    });
    expect(grant).toMatchObject({
      approvalKind: "plan",
      digest: PLAN_SHA,
      actor: "operator",
      decision: "approve",
      source: { type: "approval", approvalKind: "plan", digest: PLAN_SHA },
    });
    expect(initWorker).toMatchObject({
      phase: "worker_started",
      bindingDigestSha256: BINDING_DIGEST,
      profileId: "local-headless",
      providerProfileId: "local-provider",
      source: { type: "event", sequence: 5, eventType: "headless.worker.started" },
    });
    expect(plan).toMatchObject({
      planSha256: PLAN_SHA,
      targets: ["src/greeting.txt"],
      checkIds: ["verify"],
      grants: [{ kind: "exec.check", scope: ["verify"], maxCalls: 1 }],
      iterationCeiling: 0,
      source: { type: "event", sequence: 4, eventType: "plan.created" },
    });
    // The surviving patch set is digest-bound exactly as the store digests it.
    expect(intent).toMatchObject({
      action: "intent_recorded",
      patchSetSha256: digestJson(PATCH_SET as unknown as JsonValue),
      paths: ["src/greeting.txt"],
      operations: ["modify"],
      source: { type: "event", sequence: 6, eventType: "patch_set.intent_recorded" },
    });
    expect(materialized).toMatchObject({
      action: "materialized",
      approvedSha256: APPROVED_SHA,
      source: { type: "event", sequence: 7, eventType: "edit.materialized" },
    });
    // Check lines are metadata-only: no check stdout/stderr leaves the store.
    expect(check).toMatchObject({
      outcome: "passed",
      diffSha256: DIFF_SHA,
      checkpointSha256: CHECKPOINT_SHA,
      checks: [
        {
          checkId: "verify",
          outcome: "passed",
          exitCode: 0,
          signal: null,
          durationMs: 12,
          truncated: false,
        },
      ],
      source: { type: "event", sequence: 8, eventType: "verification.completed" },
    });
    expect(JSON.stringify(check)).not.toContain("ok");
    expect(receipt).toMatchObject({
      receiptKind: "worker",
      settlementSchema: "icarus.headless.worker.v1",
      outcome: "review_ready",
      exitCode: 0,
      bindingDigestSha256: BINDING_DIGEST,
      source: { type: "event", sequence: 9, eventType: "headless.worker.settled" },
    });
    expect(result).toMatchObject({
      finalState: "awaiting_review",
      verificationOutcome: "passed",
      settlement: {
        schema: "icarus.headless.worker.v1",
        outcome: "review_ready",
        exitCode: 0,
        bindingDigestSha256: BINDING_DIGEST,
      },
      approvalCount: 1,
      eventCount: 9,
      lastEventSequence: 9,
      source: { type: "snapshot" },
    });
    expect(result.contentSha256).toBe(
      headlessStreamContentSha256(lines.slice(0, -1) as readonly HeadlessStreamContentLineV1[]),
    );
    expect(Buffer.concat(lines.map(canonicalJsonLine))).toEqual(
      Buffer.concat(createHeadlessStreamLines(history()).map(canonicalJsonLine)),
    );
    expect(
      createHash("sha256")
        .update(Buffer.concat(lines.map(canonicalJsonLine)))
        .digest("hex"),
    ).toBe("5193fd0ea107d506c068140b412f43b6cde21641e4a4e58862a660a506e4907b");
  });

  test("binds superseded patch-set digests to their intents in order", () => {
    const supersededDigest = "5".repeat(64);
    const lines = createHeadlessStreamLines(
      history({
        events: [
          event(1, "run.created", { state: "preparing", target: "src/greeting.txt" }),
          event(2, "patch_set.intent_recorded", {
            paths: ["src/greeting.txt"],
            operations: ["modify"],
          }),
          event(3, "patch_set.superseded", {
            digest: supersededDigest,
            paths: ["src/greeting.txt"],
          }),
          event(4, "patch_set.intent_recorded", {
            paths: ["src/greeting.txt"],
            operations: ["modify"],
          }),
        ],
      }),
    );
    const patchsets = lines.filter((line) => line.kind === "patchset");
    expect(patchsets).toHaveLength(3);
    expect(patchsets[0]).toMatchObject({
      action: "intent_recorded",
      patchSetSha256: supersededDigest,
    });
    expect(patchsets[1]).toMatchObject({ action: "superseded", patchSetSha256: supersededDigest });
    expect(patchsets[2]).toMatchObject({
      action: "intent_recorded",
      patchSetSha256: digestJson(PATCH_SET as unknown as JsonValue),
    });
  });

  test("projects child settlements as receipts bound to the child run", () => {
    const lines = createHeadlessStreamLines(
      history({
        events: [
          event(1, "run.created", { state: "preparing", target: "src/greeting.txt" }),
          workerStartedEvent(2, ["child-1"]),
          event(3, "headless.child.settled", childSettlementPayload({ childId: "child-1" })),
        ],
      }),
    );
    const receipt = lines.find((line) => line.kind === "receipt");
    expect(receipt).toMatchObject({
      receiptKind: "child",
      settlementSchema: "icarus.headless.child-settlement.v1",
      bindingDigestSha256: "6".repeat(64),
      childRunId: "22222222-2222-4222-8222-222222222222",
    });
  });

  test("projects an unspawned failed child settlement without inventing identity", () => {
    const lines = createHeadlessStreamLines(
      history({
        events: [
          event(1, "run.created", { state: "preparing", target: "src/greeting.txt" }),
          workerStartedEvent(2, ["c1"]),
          event(
            3,
            "headless.child.settled",
            childSettlementPayload({
              childRunId: null,
              outcome: "failed",
              exitCode: 1,
              childBindingDigestSha256: null,
              error: { code: "HEADLESS_CHILD_DENIED", message: "Envelope refused" },
            }),
          ),
        ],
      }),
    );
    expect(lines.find((line) => line.kind === "receipt")).toMatchObject({
      receiptKind: "child",
      outcome: "failed",
      exitCode: 1,
      bindingDigestSha256: null,
      childRunId: null,
    });
  });

  test("projects child settlement inside a proposal application epoch", () => {
    const patchSetSha256 = "8".repeat(64);
    const usage = { ...run().usage };
    const events = [
      event(1, "run.created", { state: "preparing", target: "src/greeting.txt" }),
      workerStartedEvent(2, ["c1"]),
      event(3, "headless.worker.settled", {
        schema: "icarus.headless.worker-proposal.v1",
        runId: RUN_ID,
        bindingDigestSha256: BINDING_DIGEST,
        outcome: "proposed",
        exitCode: 10,
        finalState: "running",
        verificationOutcome: null,
        usage,
        error: null,
        proposal: { patchSetSha256 },
      }),
      event(4, "headless.worker.apply_requested", {
        schema: "icarus.headless.worker-apply.v1",
        runId: RUN_ID,
        bindingDigestSha256: BINDING_DIGEST,
        patchSetSha256,
        startedEventSequence: 2,
      }),
      event(5, "headless.child.settled", childSettlementPayload()),
    ];
    const complete = [
      ...events,
      event(6, "headless.worker.settled", {
        schema: "icarus.headless.worker-application.v1",
        runId: RUN_ID,
        bindingDigestSha256: BINDING_DIGEST,
        outcome: "review_ready",
        exitCode: 0,
        finalState: "awaiting_review",
        verificationOutcome: "passed",
        usage,
        error: null,
        application: {
          applyEventSequence: 4,
          proposalSettlementSequence: 3,
          patchSetSha256,
        },
      }),
    ];

    expect(
      createHeadlessStreamLines(history({ events: complete })).filter(
        (line) => line.kind === "receipt",
      ),
    ).toHaveLength(3);
  });

  test("projects a child-bearing proposal before any child is started", () => {
    const lines = createHeadlessStreamLines(
      history({
        events: [
          event(1, "run.created", { state: "preparing", target: "src/greeting.txt" }),
          workerStartedEvent(2, ["c1"]),
          event(3, "headless.worker.settled", {
            schema: "icarus.headless.worker-proposal.v1",
            runId: RUN_ID,
            bindingDigestSha256: BINDING_DIGEST,
            outcome: "proposed",
            exitCode: 10,
            finalState: "running",
            verificationOutcome: null,
            usage: { ...run().usage },
            error: null,
            proposal: { patchSetSha256: "8".repeat(64) },
          }),
        ],
      }),
    );

    expect(lines.find((line) => line.kind === "receipt")).toMatchObject({
      receiptKind: "worker",
      settlementSchema: "icarus.headless.worker-proposal.v1",
      outcome: "proposed",
      exitCode: 10,
    });
  });

  test("projects an interactive run without worker evidence", () => {
    const lines = createHeadlessStreamLines(
      history({
        run: run({ state: "completed", patchSet: null }),
        events: [
          event(1, "run.created", { state: "preparing", target: "src/greeting.txt" }),
          event(2, "plan.created", {
            from: "planned",
            to: "awaiting_approval",
            planSha256: PLAN_SHA,
            readableFiles: 0,
          }),
        ],
      }),
    );
    expect(lines.map((line) => line.kind)).toEqual(["init", "grant", "plan", "result"]);
    const result = lines.at(-1);
    expect(result).toMatchObject({ finalState: "completed", settlement: null });
  });

  test("fails closed when a snapshot contains another run's approval", () => {
    expect(() =>
      createHeadlessStreamLines(
        history({
          approvals: [
            {
              runId: "22222222-2222-4222-8222-222222222222",
              kind: "plan",
              digest: PLAN_SHA,
              actor: "operator",
              decision: "approve",
              createdAt: "2026-08-26T12:00:10.000Z",
            },
          ],
        }),
      ),
    ).toThrow("Headless stream approval belongs to a different run");
  });

  test("fails closed when event order is not strictly increasing", () => {
    const events = headlessEvents().map((entry) =>
      entry.sequence === 2 ? { ...entry, sequence: 1 } : entry,
    );
    expect(() => createHeadlessStreamLines(history({ events }))).toThrow(
      "Headless stream event sequence must be positive and strictly increasing",
    );
  });

  test("fails closed without exactly one run creation", () => {
    expect(() => createHeadlessStreamLines(history({ events: [] }))).toThrow(
      "Headless stream history must contain exactly one run creation",
    );
  });

  test("fails closed on a supersession without its intent", () => {
    expect(() =>
      createHeadlessStreamLines(
        history({
          events: [
            event(1, "run.created", { state: "preparing", target: "src/greeting.txt" }),
            event(2, "patch_set.superseded", {
              digest: "5".repeat(64),
              paths: ["src/greeting.txt"],
            }),
          ],
        }),
      ),
    ).toThrow("Headless stream patch-set supersession lacks its intent");
  });

  test("fails closed on an unbound intent when no patch set survives", () => {
    expect(() =>
      createHeadlessStreamLines(
        history({
          run: run({ patchSet: null }),
          events: [
            event(1, "run.created", { state: "preparing", target: "src/greeting.txt" }),
            event(2, "patch_set.intent_recorded", {
              paths: ["src/greeting.txt"],
              operations: ["modify"],
            }),
          ],
        }),
      ),
    ).toThrow("Headless stream patch-set intent lacks its digest");
  });

  test("fails closed on a malformed check payload", () => {
    expect(() =>
      createHeadlessStreamLines(
        history({
          events: [
            event(1, "run.created", { state: "preparing", target: "src/greeting.txt" }),
            event(2, "verification.completed", { from: "verifying", to: "awaiting_review" }),
          ],
        }),
      ),
    ).toThrow("Check payload verification is malformed");
  });

  const workerSettlementMutations: readonly [
    string,
    (payload: Record<string, JsonValue>) => void,
  ][] = [
    [
      "unknown schema",
      (payload) => {
        payload.schema = "attacker.chosen.schema";
      },
    ],
    [
      "unknown outcome",
      (payload) => {
        payload.outcome = "success-ish";
      },
    ],
    [
      "mismatched outcome exit",
      (payload) => {
        payload.exitCode = 8675309;
      },
    ],
    [
      "foreign run identity",
      (payload) => {
        payload.runId = "foreign-run";
      },
    ],
    [
      "changed binding identity",
      (payload) => {
        payload.bindingDigestSha256 = "7".repeat(64);
      },
    ],
    [
      "extra member",
      (payload) => {
        payload.unexpected = true;
      },
    ],
    [
      "missing member",
      (payload) => {
        delete payload.error;
      },
    ],
  ];

  test.each(workerSettlementMutations)(
    "fails closed on malformed worker settlement: %s",
    (_label, mutate) => {
      const events = headlessEvents().map((entry) => {
        if (entry.type !== "headless.worker.settled") return entry;
        const payload = { ...(entry.payload as Readonly<Record<string, JsonValue>>) };
        mutate(payload);
        return { ...entry, payload };
      });
      expectInvalidStream(history({ events }));
    },
  );

  test("fails closed on a duplicate worker settlement without an epoch intent", () => {
    const events = [
      ...headlessEvents(),
      event(10, "headless.worker.settled", {
        ...(headlessEvents().at(-1)?.payload as Readonly<Record<string, JsonValue>>),
      }),
    ];
    expectInvalidStream(history({ events }));
  });

  test("fails closed when a worker settlement precedes its start", () => {
    const workerEvents = headlessEvents();
    const started = workerEvents.find((entry) => entry.type === "headless.worker.started");
    const settled = workerEvents.find((entry) => entry.type === "headless.worker.settled");
    expect(started).toBeDefined();
    expect(settled).toBeDefined();
    expectInvalidStream(
      history({
        events: [
          event(1, "run.created", { state: "preparing", target: "src/greeting.txt" }),
          { ...(settled as EventRecord), sequence: 2 },
          { ...(started as EventRecord), sequence: 3 },
        ],
      }),
    );
  });

  test("fails closed when a worker settlement has no start", () => {
    const settled = headlessEvents().find((entry) => entry.type === "headless.worker.settled");
    expect(settled).toBeDefined();
    expectInvalidStream(
      history({
        events: [
          event(1, "run.created", { state: "preparing", target: "src/greeting.txt" }),
          { ...(settled as EventRecord), sequence: 2 },
        ],
      }),
    );
  });

  const childSettlementMutations: readonly [
    string,
    (payload: Record<string, JsonValue>) => void,
  ][] = [
    [
      "unknown schema",
      (payload) => {
        payload.schema = "attacker.chosen.child-schema";
      },
    ],
    [
      "foreign parent identity",
      (payload) => {
        payload.runId = "foreign-run";
      },
    ],
    [
      "noncanonical child identity",
      (payload) => {
        payload.childId = "Child One";
      },
    ],
    [
      "empty child run identity",
      (payload) => {
        payload.childRunId = "";
      },
    ],
    [
      "noncanonical child run identity",
      (payload) => {
        payload.childRunId = "not-a-run";
      },
    ],
    [
      "unknown outcome",
      (payload) => {
        payload.outcome = "success-ish";
      },
    ],
    [
      "mismatched outcome exit",
      (payload) => {
        payload.exitCode = 1;
      },
    ],
    [
      "malformed binding digest",
      (payload) => {
        payload.childBindingDigestSha256 = "no";
      },
    ],
    [
      "malformed error",
      (payload) => {
        payload.error = { code: "lowercase", message: "failed" };
      },
    ],
    [
      "extra member",
      (payload) => {
        payload.unexpected = true;
      },
    ],
    [
      "propose-only outcome",
      (payload) => {
        payload.outcome = "proposed";
        payload.exitCode = 10;
      },
    ],
    [
      "review-ready without a spawned child",
      (payload) => {
        payload.childRunId = null;
        payload.childBindingDigestSha256 = null;
      },
    ],
    [
      "review-ready with an error",
      (payload) => {
        payload.error = { code: "HEADLESS_CHILD_FAILED", message: "contradictory" };
      },
    ],
    [
      "spawned child without binding identity",
      (payload) => {
        payload.childBindingDigestSha256 = null;
      },
    ],
    [
      "spawned failed child without an error",
      (payload) => {
        payload.outcome = "failed";
        payload.exitCode = 1;
      },
    ],
  ];

  test.each(childSettlementMutations)(
    "fails closed on malformed child settlement: %s",
    (_label, mutate) => {
      const payload = childSettlementPayload();
      mutate(payload);
      expectInvalidStream(
        history({
          events: [
            event(1, "run.created", { state: "preparing", target: "src/greeting.txt" }),
            workerStartedEvent(2, ["c1"]),
            event(3, "headless.child.settled", payload),
          ],
        }),
      );
    },
  );

  test("fails closed when child evidence exists without a worker start", () => {
    expectInvalidStream(
      history({
        events: [
          event(1, "run.created", { state: "preparing", target: "src/greeting.txt" }),
          event(2, "headless.child.settled", childSettlementPayload()),
        ],
      }),
    );
  });

  test("fails closed when a child settlement was not declared at worker start", () => {
    expectInvalidStream(
      history({
        events: [
          event(1, "run.created", { state: "preparing", target: "src/greeting.txt" }),
          workerStartedEvent(2),
          event(3, "headless.child.settled", childSettlementPayload()),
        ],
      }),
    );
  });

  test("fails closed on duplicate child settlement identity", () => {
    expectInvalidStream(
      history({
        events: [
          event(1, "run.created", { state: "preparing", target: "src/greeting.txt" }),
          workerStartedEvent(2, ["c1"]),
          event(3, "headless.child.settled", childSettlementPayload()),
          event(4, "headless.child.settled", childSettlementPayload()),
        ],
      }),
    );
  });

  test("fails closed on duplicate child run identity", () => {
    expectInvalidStream(
      history({
        events: [
          event(1, "run.created", { state: "preparing", target: "src/greeting.txt" }),
          workerStartedEvent(2, ["c1", "c2"]),
          event(3, "headless.child.settled", childSettlementPayload()),
          event(4, "headless.child.settled", childSettlementPayload({ childId: "c2" })),
        ],
      }),
    );
  });

  test("fails closed when child settlement follows the parent settlement", () => {
    expectInvalidStream(
      history({
        events: [
          ...headlessEvents().map((entry) =>
            entry.type === "headless.worker.started"
              ? workerStartedEvent(entry.sequence, ["c1"])
              : entry,
          ),
          event(10, "headless.child.settled", childSettlementPayload()),
        ],
      }),
    );
  });

  test("fails closed when a successful parent omits a declared child settlement", () => {
    const settledEvents = headlessEvents();
    const parentSettlement = settledEvents[settledEvents.length - 1];
    if (parentSettlement === undefined) throw new Error("Expected parent settlement fixture");
    expectInvalidStream(
      history({
        events: [
          ...settledEvents
            .slice(0, -1)
            .map((entry) =>
              entry.type === "headless.worker.started"
                ? workerStartedEvent(entry.sequence, ["c1", "c2"])
                : entry,
            ),
          event(9, "headless.child.settled", childSettlementPayload()),
          { ...parentSettlement, sequence: 10 },
        ],
      }),
    );
  });

  test("fails closed when a child-bearing worker resumes before any child settles", () => {
    expectInvalidStream(
      history({
        events: [
          event(1, "run.created", { state: "preparing", target: "src/greeting.txt" }),
          workerStartedEvent(2, ["c1"]),
          event(3, "headless.worker.settled", {
            schema: "icarus.headless.worker-interruption.v1",
            runId: RUN_ID,
            bindingDigestSha256: BINDING_DIGEST,
            outcome: "interrupted",
            exitCode: 1,
            finalState: "running",
            verificationOutcome: null,
            usage: { ...run().usage },
            error: {
              code: "HEADLESS_WORKER_INTERRUPTED",
              message: "Worker process disappeared",
            },
            reconciliation: {
              startedEventSequence: 2,
              interruptedOperationIds: [],
              continuation: "requires_binding_reconstruction",
            },
          }),
          event(4, "headless.worker.resume_requested", {
            schema: "icarus.headless.worker-resume.v1",
            runId: RUN_ID,
            bindingDigestSha256: BINDING_DIGEST,
            reconstructionDigestSha256: "9".repeat(64),
            startedEventSequence: 2,
          }),
        ],
      }),
    );
  });

  test("fails closed when child-bearing worker evidence contains a resume intent", () => {
    expectInvalidStream(
      history({
        events: [
          event(1, "run.created", { state: "preparing", target: "src/greeting.txt" }),
          workerStartedEvent(2, ["c1"]),
          event(3, "headless.child.settled", childSettlementPayload()),
          event(4, "headless.worker.settled", {
            schema: "icarus.headless.worker-interruption.v1",
            runId: RUN_ID,
            bindingDigestSha256: BINDING_DIGEST,
            outcome: "interrupted",
            exitCode: 1,
            finalState: "running",
            verificationOutcome: null,
            usage: { ...run().usage },
            error: {
              code: "HEADLESS_WORKER_INTERRUPTED",
              message: "Worker process disappeared",
            },
            reconciliation: {
              startedEventSequence: 2,
              interruptedOperationIds: [],
              continuation: "requires_binding_reconstruction",
            },
          }),
          event(5, "headless.worker.resume_requested", {
            schema: "icarus.headless.worker-resume.v1",
            runId: RUN_ID,
            bindingDigestSha256: BINDING_DIGEST,
            reconstructionDigestSha256: "9".repeat(64),
            startedEventSequence: 2,
          }),
        ],
      }),
    );
  });
});
