import { rmSync } from "node:fs";
import { createRequire } from "node:module";

import { afterEach, describe, expect, it } from "vitest";

import { sha256 } from "../../packages/core/src/digest.js";
import { IcarusError } from "../../packages/core/src/errors.js";
import { checkpointDigest, planApprovalDigest } from "../../packages/core/src/policy.js";
import { createProviderConfig } from "../../packages/core/src/provider.js";
import {
  CANCELLATION_RECOVERY_OPERATION_KIND,
  CANCELLATION_RECOVERY_RUNTIME_MS,
  IcarusStore,
} from "../../packages/core/src/store.js";
import {
  createUnitStore,
  makeUnitIdGenerator,
  seedUnitProject,
  UNIT_BASE_COMMIT,
  UNIT_CEILING,
  UNIT_PLAN,
  UNIT_PROVIDER,
  UNIT_RUN_ID,
  UNIT_SANDBOX,
  unitContextDigest,
  unitContextManifest,
} from "../support/unit-fixtures.js";

interface TestDatabase {
  prepare(sql: string): { run(...parameters: unknown[]): unknown };
  close(): void;
}

const Database = createRequire(new URL("../../packages/core/package.json", import.meta.url))(
  "better-sqlite3",
) as new (
  filename: string,
) => TestDatabase;

const cleanupRoots: string[] = [];

afterEach(() => {
  for (const root of cleanupRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function prepareRun(store: IcarusStore): void {
  const { projectId } = seedUnitProject(store);
  store.createRun({
    id: UNIT_RUN_ID,
    projectId,
    task: "Update the greeting",
    target: UNIT_PLAN.target,
    provider: UNIT_PROVIDER,
  });
  store.pinRunBase(UNIT_RUN_ID, UNIT_BASE_COMMIT);
  const context = unitContextManifest();
  store.completePreparation(
    UNIT_RUN_ID,
    context,
    "/tmp/unit-context.json",
    unitContextDigest(context),
  );
}

function expectIcarusCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(IcarusError);
    expect((error as IcarusError).code).toBe(code);
  }
}

function approvePreparedRun(store: IcarusStore): void {
  const project = store.getProject(store.getRun(UNIT_RUN_ID).projectId);
  const run = store.getRun(UNIT_RUN_ID);
  const digest = planApprovalDigest({
    task: run.task,
    baseCommit: run.baseCommit,
    contextSha256: run.contextSha256,
    target: run.target,
    provider: run.provider,
    checks: project.checks,
    sandbox: project.sandbox,
    ceiling: project.ceiling,
    plan: UNIT_PLAN,
  });
  store.recordPlanAndAwaitApproval(UNIT_RUN_ID, UNIT_PLAN, digest);
  store.approvePlan(UNIT_RUN_ID, digest, "unit-operator");
}

describe("SQLite run persistence", () => {
  it("atomically lands remote preparation at the egress gate", () => {
    const fixture = createUnitStore();
    cleanupRoots.push(fixture.root);
    const { projectId } = seedUnitProject(fixture.store);
    fixture.store.createRun({
      id: UNIT_RUN_ID,
      projectId,
      task: "Update the greeting",
      target: UNIT_PLAN.target,
      provider: createProviderConfig({
        kind: "openai",
        model: "remote-contract-model",
        baseUrl: "https://api.openai.com/v1/",
        inputUsdPerMillionTokens: 1,
        outputUsdPerMillionTokens: 1,
      }),
    });
    fixture.store.pinRunBase(UNIT_RUN_ID, UNIT_BASE_COMMIT);
    const context = unitContextManifest();
    const prepared = fixture.store.completePreparation(
      UNIT_RUN_ID,
      context,
      "/tmp/unit-context.json",
      unitContextDigest(context),
    );

    expect(prepared.state).toBe("awaiting_egress_approval");
    expect(fixture.store.listApprovals(UNIT_RUN_ID)).toEqual([]);
    expect(fixture.store.listEvents(UNIT_RUN_ID).map((event) => event.type)).toEqual([
      "run.created",
      "base.pinned",
      "context.assembled",
      "egress.requested",
    ]);
    fixture.store.close();
  });

  it("reopens a preparing run without inventing context state", () => {
    const fixture = createUnitStore();
    cleanupRoots.push(fixture.root);
    const { projectId } = seedUnitProject(fixture.store);
    fixture.store.createRun({
      id: UNIT_RUN_ID,
      projectId,
      task: "Update the greeting",
      target: UNIT_PLAN.target,
      provider: UNIT_PROVIDER,
    });
    fixture.store.close();

    const reopened = new IcarusStore(fixture.databasePath, {
      now: () => "2026-07-19T12:01:00.000Z",
      id: makeUnitIdGenerator(),
    });
    const run = reopened.getRun(UNIT_RUN_ID);
    expect(run.state).toBe("preparing");
    expect(run.baseCommit).toBe("");
    expect(run.contextSha256).toBe("");
    expect(reopened.listEvents(UNIT_RUN_ID).map((event) => event.type)).toEqual(["run.created"]);
    reopened.close();
  });

  it("charges worst-case reservations for an operation interrupted across reopen", () => {
    const fixture = createUnitStore();
    cleanupRoots.push(fixture.root);
    prepareRun(fixture.store);
    fixture.store.beginOperation(UNIT_RUN_ID, "provider.plan", 0.25, 50, 500);
    expect(fixture.store.getRun(UNIT_RUN_ID).usage).toMatchObject({
      toolCalls: 1,
      estimatedCostUsd: 0,
      reservedCostUsd: 0.25,
      activeRuntimeMs: 0,
    });
    fixture.store.close();

    const reopened = new IcarusStore(fixture.databasePath, {
      now: () => "2026-07-19T12:01:00.000Z",
      id: makeUnitIdGenerator(),
    });
    reopened.recordResumeRequested(UNIT_RUN_ID);
    const interrupted = reopened.markStartedOperationsInterrupted(UNIT_RUN_ID);
    expect(interrupted.usage).toEqual({
      toolCalls: 1,
      inputTokens: 50,
      outputTokens: 0,
      activeRuntimeMs: 500,
      estimatedCostUsd: 0.25,
      reservedCostUsd: 0,
    });
    expect(
      reopened.listEvents(UNIT_RUN_ID).filter((event) => event.type === "operation.interrupted"),
    ).toHaveLength(1);
    expect(
      reopened
        .listEvents(UNIT_RUN_ID)
        .filter(
          (event) => event.type === "resume.requested" || event.type === "operation.interrupted",
        )
        .map((event) => event.type),
    ).toEqual(["resume.requested", "operation.interrupted"]);

    expect(reopened.markStartedOperationsInterrupted(UNIT_RUN_ID).usage).toEqual(interrupted.usage);
    reopened.close();
  });
  it("conservatively charges and caps interrupted emergency cancellation recovery", () => {
    const fixture = createUnitStore();
    cleanupRoots.push(fixture.root);
    prepareRun(fixture.store);
    expectIcarusCode(
      () =>
        fixture.store.beginOperation(UNIT_RUN_ID, CANCELLATION_RECOVERY_OPERATION_KIND, 0, 0, 1),
      "INVALID_EMERGENCY_OPERATION",
    );

    fixture.store.transition(UNIT_RUN_ID, "cancelling", "cancellation.requested", {
      actor: "unit-operator",
    });

    const first = fixture.store.beginCancellationRecoveryOperation(UNIT_RUN_ID);
    expect(first).toMatchObject({
      kind: CANCELLATION_RECOVERY_OPERATION_KIND,
      reservedRuntimeMs: CANCELLATION_RECOVERY_RUNTIME_MS,
    });
    expect(fixture.store.getRun(UNIT_RUN_ID).usage).toMatchObject({
      toolCalls: 1,
      activeRuntimeMs: 0,
    });
    fixture.store.close();

    const reopened = new IcarusStore(fixture.databasePath, {
      now: () => "2026-07-19T12:01:00.000Z",
      id: makeUnitIdGenerator(),
    });
    reopened.recordResumeRequested(UNIT_RUN_ID);
    const interruptedFirst = reopened.markStartedOperationsInterrupted(UNIT_RUN_ID);
    expect(interruptedFirst.usage).toMatchObject({
      toolCalls: 1,
      activeRuntimeMs: CANCELLATION_RECOVERY_RUNTIME_MS,
    });

    const second = reopened.beginCancellationRecoveryOperation(UNIT_RUN_ID);
    expect(second.reservedRuntimeMs).toBe(CANCELLATION_RECOVERY_RUNTIME_MS);
    const interruptedSecond = reopened.markStartedOperationsInterrupted(UNIT_RUN_ID);
    expect(interruptedSecond.usage).toMatchObject({
      toolCalls: 2,
      activeRuntimeMs: CANCELLATION_RECOVERY_RUNTIME_MS * 2,
    });
    expectIcarusCode(
      () => reopened.beginCancellationRecoveryOperation(UNIT_RUN_ID),
      "RECOVERY_ATTEMPTS_EXHAUSTED",
    );

    const recoveryEvents = reopened
      .listEvents(UNIT_RUN_ID)
      .filter(
        (event) => event.type === "operation.started" || event.type === "operation.interrupted",
      );
    expect(recoveryEvents).toHaveLength(4);
    expect(recoveryEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "operation.started",
          payload: expect.objectContaining({
            kind: CANCELLATION_RECOVERY_OPERATION_KIND,
            budgetClass: "emergency",
            attempt: 1,
          }),
        }),
        expect.objectContaining({
          type: "operation.started",
          payload: expect.objectContaining({
            kind: CANCELLATION_RECOVERY_OPERATION_KIND,
            budgetClass: "emergency",
            attempt: 2,
          }),
        }),
        expect.objectContaining({
          type: "operation.interrupted",
          payload: expect.objectContaining({
            kind: CANCELLATION_RECOVERY_OPERATION_KIND,
            budgetClass: "emergency",
            reservedRuntimeMs: CANCELLATION_RECOVERY_RUNTIME_MS,
          }),
        }),
      ]),
    );
    reopened.close();
  });

  it("keeps stale plan approval out of state and persists an immutable checkpoint", () => {
    const fixture = createUnitStore();
    cleanupRoots.push(fixture.root);
    prepareRun(fixture.store);
    const project = fixture.store.getProject(fixture.store.getRun(UNIT_RUN_ID).projectId);
    const digest = planApprovalDigest({
      task: "Update the greeting",
      baseCommit: UNIT_BASE_COMMIT,
      contextSha256: unitContextDigest(unitContextManifest()),
      target: UNIT_PLAN.target,
      provider: UNIT_PROVIDER,
      checks: project.checks,
      sandbox: UNIT_SANDBOX,
      ceiling: UNIT_CEILING,
      plan: UNIT_PLAN,
    });
    fixture.store.recordPlanAndAwaitApproval(UNIT_RUN_ID, UNIT_PLAN, digest);

    try {
      fixture.store.approvePlan(UNIT_RUN_ID, "0".repeat(64), "unit-operator");
      throw new Error("Expected stale approval rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(IcarusError);
      expect((error as IcarusError).code).toBe("STALE_APPROVAL");
    }
    expect(fixture.store.getRun(UNIT_RUN_ID).state).toBe("awaiting_approval");
    expect(fixture.store.listApprovals(UNIT_RUN_ID)).toEqual([]);

    fixture.store.approvePlan(UNIT_RUN_ID, digest, "unit-operator");
    const baselineBase64 = Buffer.from("hello\n").toString("base64");
    const approvedBase64 = Buffer.from("goodbye\n").toString("base64");
    fixture.store.recordWorkspace(UNIT_RUN_ID, "/tmp/cache.git", "/tmp/worktree", baselineBase64);
    fixture.store.recordEditIntent(
      UNIT_RUN_ID,
      {
        path: UNIT_PLAN.target,
        expectedPreimageSha256: "f".repeat(64),
        findText: "hello",
        replaceText: "goodbye",
        rationale: "Update the fixture.",
      },
      approvedBase64,
    );
    const checkpointSha256 = checkpointDigest({
      runId: UNIT_RUN_ID,
      baseCommit: UNIT_BASE_COMMIT,
      target: UNIT_PLAN.target,
      baselineBase64,
      approvedBase64,
    });
    const first = fixture.store.saveCheckpoint(
      UNIT_RUN_ID,
      baselineBase64,
      approvedBase64,
      checkpointSha256,
    );
    const second = fixture.store.saveCheckpoint(
      UNIT_RUN_ID,
      baselineBase64,
      approvedBase64,
      checkpointSha256,
    );
    expect(second).toEqual(first);
    expect(
      fixture.store.listEvents(UNIT_RUN_ID).filter((event) => event.type === "checkpoint.saved"),
    ).toHaveLength(1);
    fixture.store.close();
  });

  it("rejects a secret-shaped approval actor without persisting an approval", () => {
    const fixture = createUnitStore();
    cleanupRoots.push(fixture.root);
    prepareRun(fixture.store);
    const project = fixture.store.getProject(fixture.store.getRun(UNIT_RUN_ID).projectId);
    const run = fixture.store.getRun(UNIT_RUN_ID);
    const digest = planApprovalDigest({
      task: run.task,
      baseCommit: run.baseCommit,
      contextSha256: run.contextSha256,
      target: run.target,
      provider: run.provider,
      checks: project.checks,
      sandbox: project.sandbox,
      ceiling: project.ceiling,
      plan: UNIT_PLAN,
    });
    fixture.store.recordPlanAndAwaitApproval(UNIT_RUN_ID, UNIT_PLAN, digest);
    const secretActor = ["sk-", "a".repeat(24)].join("");

    expectIcarusCode(
      () => fixture.store.approvePlan(UNIT_RUN_ID, digest, secretActor),
      "SECRET_INPUT_DETECTED",
    );
    expect(fixture.store.getRun(UNIT_RUN_ID).state).toBe("awaiting_approval");
    expect(fixture.store.listApprovals(UNIT_RUN_ID)).toEqual([]);
    expect(JSON.stringify(fixture.store.listEvents(UNIT_RUN_ID))).not.toContain(secretActor);
    fixture.store.close();
  });

  it("fails closed when loading a persisted pre-upgrade timer-unsafe ceiling", () => {
    const fixture = createUnitStore();
    cleanupRoots.push(fixture.root);
    const { projectId } = seedUnitProject(fixture.store);
    fixture.store.close();

    const database = new Database(fixture.databasePath);
    try {
      database
        .prepare("UPDATE projects SET ceiling_json = ? WHERE id = ?")
        .run(JSON.stringify({ ...UNIT_CEILING, providerTimeoutMs: 2_147_483_648 }), projectId);
    } finally {
      database.close();
    }

    const reopened = new IcarusStore(fixture.databasePath, {
      now: () => "2026-07-19T12:01:00.000Z",
      id: makeUnitIdGenerator(),
    });
    try {
      expectIcarusCode(() => reopened.getProject(projectId), "INVALID_CEILING");
    } finally {
      reopened.close();
    }
  });

  it("enforces runtime reservations before starting an operation", () => {
    const fixture = createUnitStore();
    cleanupRoots.push(fixture.root);
    prepareRun(fixture.store);

    try {
      fixture.store.beginOperation(
        UNIT_RUN_ID,
        "too-long",
        0,
        0,
        UNIT_CEILING.maxActiveRuntimeMs + 1,
      );
      throw new Error("Expected runtime ceiling rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(IcarusError);
      expect((error as IcarusError).code).toBe("RUNTIME_BUDGET_EXCEEDED");
    }
    expect(fixture.store.getRun(UNIT_RUN_ID).usage.toolCalls).toBe(0);
    fixture.store.close();
  });
  it("rejects a direct operation after aggregate runtime reaches the exact ceiling", () => {
    const fixture = createUnitStore();
    cleanupRoots.push(fixture.root);
    prepareRun(fixture.store);

    const exact = fixture.store.beginOperation(
      UNIT_RUN_ID,
      "consume-runtime",
      0,
      0,
      UNIT_CEILING.maxActiveRuntimeMs,
    );
    fixture.store.finishOperation(exact, {
      outcome: "succeeded",
      activeRuntimeMs: UNIT_CEILING.maxActiveRuntimeMs,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
      detail: {},
    });
    expectIcarusCode(
      () => fixture.store.beginOperation(UNIT_RUN_ID, "after-runtime-ceiling", 0, 0, 1),
      "RUNTIME_BUDGET_EXCEEDED",
    );
    expect(fixture.store.getRun(UNIT_RUN_ID).usage.activeRuntimeMs).toBe(
      UNIT_CEILING.maxActiveRuntimeMs,
    );
    fixture.store.close();
  });

  it("enforces the tool-call ceiling before starting another operation", () => {
    const fixture = createUnitStore();
    cleanupRoots.push(fixture.root);
    prepareRun(fixture.store);

    for (let index = 0; index < UNIT_CEILING.maxToolCalls; index += 1) {
      const operation = fixture.store.beginOperation(UNIT_RUN_ID, `bounded-tool-${index}`, 0, 0, 1);
      fixture.store.finishOperation(operation, {
        outcome: "succeeded",
        activeRuntimeMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
        detail: {},
      });
    }

    expectIcarusCode(
      () => fixture.store.beginOperation(UNIT_RUN_ID, "one-tool-too-many", 0, 0, 1),
      "TOOL_BUDGET_EXCEEDED",
    );
    expect(fixture.store.getRun(UNIT_RUN_ID).usage.toolCalls).toBe(UNIT_CEILING.maxToolCalls);
    fixture.store.close();
  });

  it("enforces the token ceiling before reserving provider work", () => {
    const fixture = createUnitStore();
    cleanupRoots.push(fixture.root);
    prepareRun(fixture.store);

    expectIcarusCode(
      () =>
        fixture.store.beginOperation(
          UNIT_RUN_ID,
          "too-many-tokens",
          0,
          UNIT_CEILING.maxTotalTokens + 1,
          1,
        ),
      "TOKEN_BUDGET_EXCEEDED",
    );
    expect(fixture.store.getRun(UNIT_RUN_ID).usage.toolCalls).toBe(0);
    fixture.store.close();
  });

  it("enforces the cost ceiling before reserving provider work", () => {
    const fixture = createUnitStore();
    cleanupRoots.push(fixture.root);
    prepareRun(fixture.store);

    expectIcarusCode(
      () =>
        fixture.store.beginOperation(
          UNIT_RUN_ID,
          "too-expensive",
          UNIT_CEILING.maxCostUsd + 0.01,
          0,
          1,
        ),
      "COST_BUDGET_EXCEEDED",
    );
    expect(fixture.store.getRun(UNIT_RUN_ID).usage.toolCalls).toBe(0);
    fixture.store.close();
  });

  it("cannot accept a failed verification or persist a phantom review approval", () => {
    const fixture = createUnitStore();
    cleanupRoots.push(fixture.root);
    prepareRun(fixture.store);
    approvePreparedRun(fixture.store);

    const baselineBase64 = Buffer.from("hello\n").toString("base64");
    const approvedBase64 = Buffer.from("goodbye\n").toString("base64");
    fixture.store.recordWorkspace(
      UNIT_RUN_ID,
      "/tmp/unit-cache.git",
      "/tmp/unit-worktree",
      baselineBase64,
    );
    fixture.store.recordEditIntent(
      UNIT_RUN_ID,
      {
        path: UNIT_PLAN.target,
        expectedPreimageSha256: sha256("hello\n"),
        findText: "hello",
        replaceText: "goodbye",
        rationale: "Exercise the failed verification gate.",
      },
      approvedBase64,
    );
    const checkpointSha256 = checkpointDigest({
      runId: UNIT_RUN_ID,
      baseCommit: UNIT_BASE_COMMIT,
      target: UNIT_PLAN.target,
      baselineBase64,
      approvedBase64,
    });
    fixture.store.saveCheckpoint(UNIT_RUN_ID, baselineBase64, approvedBase64, checkpointSha256);
    fixture.store.transition(UNIT_RUN_ID, "verifying", "execution.completed");

    const diff = "diff --git a/src/greeting.txt b/src/greeting.txt\n-fail\n+still fail\n";
    const awaitingReview = fixture.store.recordVerificationAndAwaitReview(UNIT_RUN_ID, diff, {
      outcome: "failed",
      checks: [
        {
          checkId: "unit",
          argv: ["node", "--test"],
          exitCode: 1,
          signal: null,
          durationMs: 10,
          stdout: "",
          stderr: "assertion failed\n",
          truncated: false,
          outcome: "failed",
        },
      ],
      changedPaths: [UNIT_PLAN.target],
      diffSha256: sha256(diff),
      checkpointSha256,
    });
    expect(awaitingReview.state).toBe("awaiting_review");

    try {
      fixture.store.decideReview(
        UNIT_RUN_ID,
        awaitingReview.verification?.diffSha256 ?? "",
        "unit-operator",
        "approve",
      );
      throw new Error("Expected failed verification rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(IcarusError);
      expect((error as IcarusError).code).toBe("VERIFICATION_NOT_PASSED");
    }
    expect(fixture.store.getRun(UNIT_RUN_ID).state).toBe("awaiting_review");
    expect(fixture.store.listApprovals(UNIT_RUN_ID)).toHaveLength(1);
    expect(fixture.store.listApprovals(UNIT_RUN_ID)[0]?.kind).toBe("plan");
    fixture.store.close();
  });

  it("resumes only after exact plan approval remains durable", () => {
    const fixture = createUnitStore();
    cleanupRoots.push(fixture.root);
    prepareRun(fixture.store);
    approvePreparedRun(fixture.store);
    fixture.store.failRun(
      UNIT_RUN_ID,
      "running",
      new IcarusError("INTERRUPTED", "Synthetic interruption"),
    );
    fixture.store.close();

    const reopened = new IcarusStore(fixture.databasePath, {
      now: () => "2026-07-19T12:01:00.000Z",
      id: makeUnitIdGenerator(),
    });
    expect(reopened.resumeFailed(UNIT_RUN_ID).state).toBe("running");
    reopened.close();
  });
});
