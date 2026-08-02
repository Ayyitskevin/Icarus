import { rmSync } from "node:fs";
import { createRequire } from "node:module";

import { afterEach, describe, expect, it } from "vitest";

import { sha256 } from "../../packages/core/src/digest.js";
import { IcarusError } from "../../packages/core/src/errors.js";
import {
  MAX_SESSION_ITERATIONS,
  parsePlanProposal,
  planApprovalDigest,
  treeCheckpointDigest,
} from "../../packages/core/src/policy.js";
import { SESSION_ITERATION_OPERATION_KIND } from "../../packages/core/src/store.js";
import type {
  CheckEvidence,
  CheckpointFile,
  OperationFinish,
  PatchSet,
  VerificationEvidence,
} from "../../packages/core/src/types.js";
import {
  approveChangeRoomPlan,
  createChangeRoomFixture,
  prepareChangeRoomRun,
} from "../support/change-room-fixtures.js";
import {
  createUnitStore,
  seedUnitProject,
  UNIT_BASE_COMMIT,
  UNIT_CEILING,
  UNIT_PLAN,
  UNIT_PROVIDER,
  UNIT_SANDBOX,
  unitContextDigest,
  unitContextManifest,
} from "../support/unit-fixtures.js";

const RUN_ID = "00000000-0000-4000-8000-0000000000f1";
const TARGET = "src/greeting.txt";
const BASELINE = "hello\n";
const APPROVED = "hello, icarus\n";

interface TestDatabase {
  exec(sql: string): void;
  prepare(sql: string): { run(...parameters: unknown[]): unknown };
  close(): void;
}

const Database = createRequire(new URL("../../packages/core/package.json", import.meta.url))(
  "better-sqlite3",
) as new (
  filename: string,
) => TestDatabase;

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

function patchSetFor(replaceText: string): PatchSet {
  return {
    summary: "Bounded fixture change.",
    edits: [
      {
        op: "modify",
        path: TARGET,
        expectedPreimageSha256: sha256(BASELINE),
        replacements: [{ findText: BASELINE, replaceText }],
        rationale: "Fixture edit.",
      },
    ],
  };
}

function checkpointFilesFor(approved: string): CheckpointFile[] {
  return [
    {
      path: TARGET,
      op: "modify",
      baselineBase64: Buffer.from(BASELINE, "utf8").toString("base64"),
      approvedBase64: Buffer.from(approved, "utf8").toString("base64"),
    },
  ];
}

function checkEvidence(outcome: CheckEvidence["outcome"]): CheckEvidence {
  return {
    checkId: "unit",
    argv: ["node", "--test"],
    exitCode: outcome === "passed" ? 0 : outcome === "failed" ? 1 : null,
    signal: null,
    durationMs: 5,
    stdout: outcome === "passed" ? "ok\n" : "",
    stderr: outcome === "failed" ? "assertion failed\n" : "",
    truncated: false,
    outcome,
  };
}

function succeededFinish(detail: OperationFinish["detail"] = {}): OperationFinish {
  return {
    outcome: "succeeded",
    activeRuntimeMs: 1,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
    detail,
  };
}

/** Drives a run to `verifying` with a recorded patch set and checkpoint. */
function seedVerifyingRun(iterationCeiling: number): {
  readonly store: ReturnType<typeof createUnitStore>["store"];
  readonly databasePath: string;
  readonly diff: string;
  verificationFor(outcome: "passed" | "failed", approved: string): VerificationEvidence;
} {
  const fixture = createUnitStore();
  roots.push(fixture.root);
  const { projectId } = seedUnitProject(fixture.store);
  const store = fixture.store;

  store.createRun({
    id: RUN_ID,
    projectId,
    task: "Repair the greeting.",
    targets: UNIT_PLAN.targets,
    provider: UNIT_PROVIDER,
  });
  store.pinRunBase(RUN_ID, UNIT_BASE_COMMIT);
  const context = unitContextManifest();
  store.completePreparation(RUN_ID, context, "artifacts/context.json", unitContextDigest(context));

  const plan = { ...UNIT_PLAN, iterationCeiling };
  const planSha256 = planApprovalDigest({
    task: "Repair the greeting.",
    baseCommit: UNIT_BASE_COMMIT,
    contextSha256: unitContextDigest(context),
    targets: context.targets,
    provider: UNIT_PROVIDER,
    checks: [{ id: "unit", name: "Unit check", argv: ["node", "--test"] }],
    sandbox: UNIT_SANDBOX,
    ceiling: UNIT_CEILING,
    plan,
    readableManifest: null,
  });
  store.recordPlanAndAwaitApproval(RUN_ID, plan, planSha256);
  store.approvePlan(RUN_ID, planSha256, "unit-operator");
  store.recordWorkspace(RUN_ID, "/private/cache", "/private/worktree", null);
  store.recordPatchSetIntent(RUN_ID, patchSetFor(APPROVED), checkpointFilesFor(APPROVED));
  store.transition(RUN_ID, "verifying", "edit.materialized", {
    target: TARGET,
    approvedSha256: sha256(APPROVED),
  });

  const diff = "diff --git a/src/greeting.txt b/src/greeting.txt\n";
  return {
    store,
    databasePath: fixture.databasePath,
    diff,
    verificationFor(outcome, approved) {
      store.saveTreeCheckpoint(
        RUN_ID,
        treeCheckpointDigest({
          runId: RUN_ID,
          baseCommit: UNIT_BASE_COMMIT,
          files: checkpointFilesFor(approved),
        }),
      );
      return {
        outcome,
        checks: [checkEvidence(outcome)],
        changedPaths: [TARGET],
        diffSha256: sha256(diff),
        checkpointSha256: store.getCheckpoint(RUN_ID).checkpointSha256,
      };
    },
  };
}

/** Charges one `provider.revise` operation, as a real repair iteration does. */
function chargeRepairIteration(store: ReturnType<typeof createUnitStore>["store"]): void {
  const operation = store.beginOperation(RUN_ID, SESSION_ITERATION_OPERATION_KIND, 0, 16, 1_000);
  store.finishOperation(operation, {
    outcome: "succeeded",
    activeRuntimeMs: 1,
    inputTokens: 1,
    outputTokens: 1,
    estimatedCostUsd: 0,
    detail: {},
  });
}

function beginPatchOperation(store: ReturnType<typeof createUnitStore>["store"]) {
  return store.beginOperation(RUN_ID, "session.tool.mutation.patchset", 0, 0, 1_000, "running");
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(IcarusError);
    expect((error as IcarusError).code).toBe(code);
    return;
  }
  throw new Error(`Expected ${code}`);
}

describe("repair grant", () => {
  it("is carried by the plan and bound by its approval digest", () => {
    const withGrant = { ...UNIT_PLAN, iterationCeiling: 2 };
    const withoutGrant = { ...UNIT_PLAN, iterationCeiling: 0 };
    const base = {
      task: "Repair the greeting.",
      baseCommit: UNIT_BASE_COMMIT,
      contextSha256: "a".repeat(64),
      targets: UNIT_PLAN.targets,
      provider: UNIT_PROVIDER,
      checks: [{ id: "unit", name: "Unit check", argv: ["node", "--test"] }],
      sandbox: UNIT_SANDBOX,
      ceiling: UNIT_CEILING,
      readableManifest: null,
    };

    expect(planApprovalDigest({ ...base, plan: withGrant })).not.toBe(
      planApprovalDigest({ ...base, plan: withoutGrant }),
    );
  });

  it("refuses a plan requesting more repairs than the host permits", () => {
    const selection = [TARGET];
    const checks = [{ id: "unit", name: "Unit check", argv: ["node", "--test"] }];
    const proposal = {
      summary: "Update one tracked file.",
      steps: ["Apply one exact replacement."],
      risks: [],
      target: TARGET,
      targets: [TARGET],
      iterationCeiling: MAX_SESSION_ITERATIONS + 1,
      checkIds: ["unit"],
    };

    expectCode(() => parsePlanProposal(proposal, selection, checks), "INVALID_PROVIDER_OUTPUT");
    expect(
      parsePlanProposal(
        { ...proposal, iterationCeiling: MAX_SESSION_ITERATIONS },
        selection,
        checks,
      ).iterationCeiling,
    ).toBe(MAX_SESSION_ITERATIONS);
  });

  it("refuses a plan with a fractional or negative repair grant", () => {
    const selection = [TARGET];
    const checks = [{ id: "unit", name: "Unit check", argv: ["node", "--test"] }];
    const proposal = {
      summary: "Update one tracked file.",
      steps: ["Apply one exact replacement."],
      risks: [],
      target: TARGET,
      targets: [TARGET],
      iterationCeiling: 0,
      checkIds: ["unit"],
    };
    for (const invalid of [-1, 1.5, Number.NaN, "2"]) {
      expectCode(
        () => parsePlanProposal({ ...proposal, iterationCeiling: invalid }, selection, checks),
        "INVALID_PROVIDER_OUTPUT",
      );
    }
  });
});

describe("bounded repair transition", () => {
  it("re-enters execution while the grant and a failing verification both hold", () => {
    const seeded = seedVerifyingRun(2);
    const failing = seeded.verificationFor("failed", APPROVED);

    expect(seeded.store.remainingIterationBudget(RUN_ID)).toBe(2);
    const held = seeded.store.recordVerificationAndAwaitReview(
      RUN_ID,
      seeded.diff,
      failing,
      "verifying",
    );
    expect(held.state).toBe("verifying");
    expect(held.verification?.outcome).toBe("failed");

    const repairing = seeded.store.beginSessionIteration(RUN_ID);
    expect(repairing.state).toBe("running");
    const events = seeded.store.listEvents(RUN_ID).map((event) => event.type);
    expect(events).toContain("verification.completed");
    expect(events).toContain("repair.requested");
  });

  it("refuses to repair a passing verification", () => {
    const seeded = seedVerifyingRun(2);
    const passing = seeded.verificationFor("passed", APPROVED);
    seeded.store.recordVerificationAndAwaitReview(RUN_ID, seeded.diff, passing);

    expectCode(() => seeded.store.beginSessionIteration(RUN_ID), "INVALID_STATE");
  });

  it("refuses to retain a passing verification for repair", () => {
    const seeded = seedVerifyingRun(2);
    const passing = seeded.verificationFor("passed", APPROVED);

    expectCode(
      () =>
        seeded.store.recordVerificationAndAwaitReview(RUN_ID, seeded.diff, passing, "verifying"),
      "VERIFICATION_OUTCOME_MISMATCH",
    );
  });

  it("refuses to repair without an approved grant and lands the failure honestly", () => {
    const seeded = seedVerifyingRun(0);
    const failing = seeded.verificationFor("failed", APPROVED);

    expect(seeded.store.remainingIterationBudget(RUN_ID)).toBe(0);
    expectCode(
      () =>
        seeded.store.recordVerificationAndAwaitReview(RUN_ID, seeded.diff, failing, "verifying"),
      "ITERATION_BUDGET_EXHAUSTED",
    );

    const landed = seeded.store.recordVerificationAndAwaitReview(RUN_ID, seeded.diff, failing);
    expect(landed.state).toBe("awaiting_review");
    expect(landed.verification?.outcome).toBe("failed");
    expectCode(() => seeded.store.beginSessionIteration(RUN_ID), "INVALID_STATE");
  });

  it("spends the grant from the durable operation ledger", () => {
    const seeded = seedVerifyingRun(1);
    const failing = seeded.verificationFor("failed", APPROVED);
    seeded.store.recordVerificationAndAwaitReview(RUN_ID, seeded.diff, failing, "verifying");
    seeded.store.beginSessionIteration(RUN_ID);

    expect(seeded.store.countSessionIterations(RUN_ID)).toBe(0);
    chargeRepairIteration(seeded.store);

    expect(seeded.store.countSessionIterations(RUN_ID)).toBe(1);
    expect(seeded.store.remainingIterationBudget(RUN_ID)).toBe(0);
  });

  it("supersedes the prior patch set and records the superseded digest", () => {
    const seeded = seedVerifyingRun(2);
    const failing = seeded.verificationFor("failed", APPROVED);
    seeded.store.recordVerificationAndAwaitReview(RUN_ID, seeded.diff, failing, "verifying");
    seeded.store.beginSessionIteration(RUN_ID);
    chargeRepairIteration(seeded.store);
    beginPatchOperation(seeded.store);

    const revised = "hello, repaired\n";
    const updated = seeded.store.recordPatchSetIntent(
      RUN_ID,
      patchSetFor(revised),
      checkpointFilesFor(revised),
    );

    expect(updated.patchSet?.edits[0]?.op).toBe("modify");
    expect(updated.diff).toBeNull();
    expect(updated.verification).toBeNull();
    expect(seeded.store.listCheckpointFiles(RUN_ID)).toEqual(checkpointFilesFor(revised));
    const events = seeded.store.listEvents(RUN_ID);
    const superseded = events.filter((event) => event.type === "patch_set.superseded");
    expect(superseded).toHaveLength(1);
    // The superseded revision's evidence stays in the append-only log.
    expect(events.filter((event) => event.type === "verification.completed")).toHaveLength(1);
  });

  it("refuses a second supersession for the same charged iteration", () => {
    const seeded = seedVerifyingRun(2);
    const failing = seeded.verificationFor("failed", APPROVED);
    seeded.store.recordVerificationAndAwaitReview(RUN_ID, seeded.diff, failing, "verifying");
    seeded.store.beginSessionIteration(RUN_ID);
    chargeRepairIteration(seeded.store);
    beginPatchOperation(seeded.store);
    seeded.store.recordPatchSetIntent(
      RUN_ID,
      patchSetFor("first\n"),
      checkpointFilesFor("first\n"),
    );

    // The grant still has one iteration left, but this one is already spent.
    expect(seeded.store.remainingIterationBudget(RUN_ID)).toBe(1);
    expectCode(
      () =>
        seeded.store.recordPatchSetIntent(
          RUN_ID,
          patchSetFor("second\n"),
          checkpointFilesFor("second\n"),
        ),
      "IMMUTABLE_ARTIFACT_CONFLICT",
    );
  });

  it("refuses to supersede a patch set before the iteration is charged", () => {
    const seeded = seedVerifyingRun(2);
    const failing = seeded.verificationFor("failed", APPROVED);
    seeded.store.recordVerificationAndAwaitReview(RUN_ID, seeded.diff, failing, "verifying");
    seeded.store.beginSessionIteration(RUN_ID);
    beginPatchOperation(seeded.store);

    expect(seeded.store.countSessionIterations(RUN_ID)).toBe(0);
    expectCode(
      () =>
        seeded.store.recordPatchSetIntent(
          RUN_ID,
          patchSetFor("uncharged\n"),
          checkpointFilesFor("uncharged\n"),
        ),
      "IMMUTABLE_ARTIFACT_CONFLICT",
    );
  });

  it("refuses to supersede a patch set with no grant remaining", () => {
    const seeded = seedVerifyingRun(0);

    expectCode(
      () =>
        seeded.store.recordPatchSetIntent(
          RUN_ID,
          patchSetFor("other\n"),
          checkpointFilesFor("other\n"),
        ),
      "INVALID_STATE",
    );
  });
});

describe("durable agent-session disposition", () => {
  function enterRunningSession(store: ReturnType<typeof createUnitStore>["store"]): void {
    const diff = "diff --git a/src/greeting.txt b/src/greeting.txt\n";
    const checkpointSha256 = store.getCheckpoint(RUN_ID).checkpointSha256;
    store.recordVerificationAndAwaitReview(
      RUN_ID,
      diff,
      {
        outcome: "failed",
        checks: [checkEvidence("failed")],
        changedPaths: [TARGET],
        diffSha256: sha256(diff),
        checkpointSha256,
      },
      "verifying",
    );
    store.beginSessionIteration(RUN_ID);
    chargeRepairIteration(store);
  }

  function recordPassingSessionVerification(
    seeded: ReturnType<typeof seedVerifyingRun>,
  ): VerificationEvidence {
    const passing = seeded.verificationFor("passed", APPROVED);
    const operation = seeded.store.beginOperation(
      RUN_ID,
      "session.tool.exec.check",
      0,
      0,
      1_000,
      "running",
    );
    seeded.store.finishSessionVerificationOperation(
      operation,
      succeededFinish({ tool: "run_checks" }),
      seeded.diff,
      passing,
    );
    return passing;
  }

  it.each([
    "session.tool.read.manifest",
    "session.tool.read.checks",
    "session.tool.exec.check",
    "session.tool.mutation.patchset",
    "session.reconcile",
  ] as const)("refuses session-only operation %s outside an open repair epoch", (operationKind) => {
    const fixture = createChangeRoomFixture();
    roots.push(fixture.root);
    prepareChangeRoomRun(fixture.store);
    approveChangeRoomPlan(fixture.store);
    fixture.store.recordWorkspace(fixture.runId, "/private/cache", "/private/worktree", null);
    fixture.store.recordPatchSetIntent(
      fixture.runId,
      patchSetFor(APPROVED),
      checkpointFilesFor(APPROVED),
    );
    expect(fixture.store.getRun(fixture.runId).state).toBe("running");

    expectCode(
      () => fixture.store.beginOperation(fixture.runId, operationKind, 0, 0, 1_000, "running"),
      "INVALID_STATE",
    );
    expect(fixture.store.countOperationsByKind(fixture.runId, operationKind)).toBe(0);
    expect(
      fixture.store.listEvents(fixture.runId).filter((event) => event.type === "checkpoint.saved"),
    ).toHaveLength(0);
    fixture.store.close();
  });

  it("records a settled iteration boundary as resumable evidence", () => {
    const seeded = seedVerifyingRun(1);
    seeded.verificationFor("failed", APPROVED);
    enterRunningSession(seeded.store);

    const updated = seeded.store.recordSessionIterationBoundary(RUN_ID, 1);
    expect(updated.state).toBe("running");
    expect(
      seeded.store
        .listEvents(RUN_ID)
        .filter((event) => event.type === "session.iteration_completed"),
    ).toEqual([
      expect.objectContaining({
        payload: { iterations: 1 },
      }),
    ]);
    expectCode(
      () => seeded.store.recordSessionIterationBoundary(RUN_ID, 0),
      "INVALID_SESSION_ITERATION",
    );
    expectCode(
      () => seeded.store.recordSessionIterationBoundary(RUN_ID, 1),
      "INVALID_SESSION_ITERATION",
    );
    expectCode(
      () => seeded.store.recordSessionIterationBoundary(RUN_ID, 2),
      "INVALID_SESSION_ITERATION",
    );
  });

  it("rejects active, failed, and interrupted provider revisions as iteration boundaries", () => {
    for (const outcome of ["active", "failed", "interrupted"] as const) {
      const seeded = seedVerifyingRun(1);
      const failing = seeded.verificationFor("failed", APPROVED);
      seeded.store.recordVerificationAndAwaitReview(RUN_ID, seeded.diff, failing, "verifying");
      seeded.store.beginSessionIteration(RUN_ID);
      const operation = seeded.store.beginOperation(
        RUN_ID,
        SESSION_ITERATION_OPERATION_KIND,
        0,
        16,
        1_000,
      );
      if (outcome === "failed") {
        seeded.store.finishOperation(operation, {
          ...succeededFinish(),
          outcome: "failed",
        });
      } else if (outcome === "interrupted") {
        seeded.store.markStartedOperationsInterrupted(RUN_ID);
      }

      expectCode(
        () => seeded.store.recordSessionIterationBoundary(RUN_ID, 1),
        "INVALID_SESSION_ITERATION",
      );
      if (outcome === "active") seeded.store.markStartedOperationsInterrupted(RUN_ID);
    }
  });

  it("records the compatibility completion API but does not treat it as atomic report_done", () => {
    const seeded = seedVerifyingRun(1);
    seeded.verificationFor("failed", APPROVED);
    enterRunningSession(seeded.store);
    const passing = recordPassingSessionVerification(seeded);

    const awaitingReview = seeded.store.recordSessionOutcome(
      RUN_ID,
      "completed",
      "The registered check passes.",
      1,
    );
    expect(awaitingReview.state).toBe("awaiting_review");
    expect(awaitingReview.verification).toEqual(passing);
    expect(
      seeded.store.listEvents(RUN_ID).filter((event) => event.type === "session.completed"),
    ).toEqual([
      expect.objectContaining({
        payload: {
          iterations: 1,
          summary: "The registered check passes.",
        },
      }),
    ]);
    expectCode(
      () => seeded.store.decideReview(RUN_ID, passing.diffSha256, "unit-operator", "approve"),
      "SESSION_NOT_COMPLETED",
    );
  });

  it("refuses completion when the current verification is not passing", () => {
    const seeded = seedVerifyingRun(1);
    seeded.verificationFor("failed", APPROVED);
    enterRunningSession(seeded.store);

    expectCode(
      () =>
        seeded.store.recordSessionOutcome(
          RUN_ID,
          "completed",
          "This must not override failed evidence.",
          1,
        ),
      "VERIFICATION_NOT_PASSED",
    );
    expect(seeded.store.getRun(RUN_ID).state).toBe("running");
  });

  it("refuses completion when passing evidence names a stale checkpoint", () => {
    const seeded = seedVerifyingRun(1);
    seeded.verificationFor("failed", APPROVED);
    enterRunningSession(seeded.store);
    recordPassingSessionVerification(seeded);
    const database = new Database(seeded.databasePath);
    try {
      database
        .prepare("UPDATE checkpoints SET checkpoint_sha256 = ? WHERE run_id = ?")
        .run("f".repeat(64), RUN_ID);
    } finally {
      database.close();
    }

    expectCode(
      () =>
        seeded.store.recordSessionOutcome(
          RUN_ID,
          "completed",
          "This must not bless stale evidence.",
          1,
        ),
      "CHECKPOINT_MISMATCH",
    );
    expect(seeded.store.getRun(RUN_ID).state).toBe("running");
  });

  it.each([
    ["awaiting_human", "Which implementation should I use?"],
    ["exhausted", null],
  ] as const)("makes a %s disposition non-approvable", (kind, textValue) => {
    const seeded = seedVerifyingRun(1);
    seeded.verificationFor("failed", APPROVED);
    enterRunningSession(seeded.store);
    const passing = recordPassingSessionVerification(seeded);
    seeded.store.recordSessionOutcome(RUN_ID, kind, textValue, 1);

    expectCode(
      () => seeded.store.decideReview(RUN_ID, passing.diffSha256, "unit-operator", "approve"),
      "SESSION_NOT_COMPLETED",
    );
    expect(seeded.store.getRun(RUN_ID).state).toBe("awaiting_review");
  });

  it("blocks approval when a charged session has no terminal disposition", () => {
    const seeded = seedVerifyingRun(1);
    const failing = seeded.verificationFor("failed", APPROVED);
    seeded.store.recordVerificationAndAwaitReview(RUN_ID, seeded.diff, failing, "verifying");
    seeded.store.beginSessionIteration(RUN_ID);
    chargeRepairIteration(seeded.store);
    const passing = seeded.verificationFor("passed", APPROVED);
    seeded.store.transition(RUN_ID, "verifying", "session.verification_requested");
    seeded.store.recordVerificationAndAwaitReview(RUN_ID, seeded.diff, passing);

    expectCode(
      () => seeded.store.decideReview(RUN_ID, passing.diffSha256, "unit-operator", "approve"),
      "SESSION_NOT_COMPLETED",
    );
    expect(seeded.store.getRun(RUN_ID).state).toBe("awaiting_review");
  });

  it("preserves the legacy successful review path when no session was charged", () => {
    const seeded = seedVerifyingRun(0);
    const passing = seeded.verificationFor("passed", APPROVED);
    seeded.store.recordVerificationAndAwaitReview(RUN_ID, seeded.diff, passing);

    const completed = seeded.store.decideReview(
      RUN_ID,
      passing.diffSha256,
      "unit-operator",
      "approve",
    );
    expect(completed.state).toBe("completed");
  });

  it.each([
    ["session.tool.exec.check", "passed"],
    ["session.tool.mutation.patchset", "unavailable"],
  ] as const)("atomically settles %s with its current verification", (operationKind, outcome) => {
    const seeded = seedVerifyingRun(1);
    seeded.verificationFor("failed", APPROVED);
    enterRunningSession(seeded.store);
    const passing = seeded.verificationFor("passed", APPROVED);
    const verification: VerificationEvidence =
      outcome === "passed"
        ? passing
        : { ...passing, outcome, checks: [checkEvidence("unavailable")] };
    const operation = seeded.store.beginOperation(RUN_ID, operationKind, 0, 0, 1_000, "running");
    if (operationKind === "session.tool.mutation.patchset") {
      const current = seeded.store.getRun(RUN_ID);
      if (current.patchSet === null) throw new Error("Expected a current patch set");
      seeded.store.recordPatchSetIntent(
        RUN_ID,
        current.patchSet,
        seeded.store.listCheckpointFiles(RUN_ID),
      );
      seeded.store.saveTreeCheckpoint(RUN_ID, verification.checkpointSha256);
    }

    const updated = seeded.store.finishSessionVerificationOperation(
      operation,
      succeededFinish({
        tool: operationKind === "session.tool.mutation.patchset" ? "apply_patchset" : operationKind,
      }),
      seeded.diff,
      verification,
    );

    expect(updated.state).toBe("running");
    expect(updated.verification).toEqual(verification);
    expect(
      seeded.store
        .listEvents(RUN_ID)
        .slice(-2)
        .map((event) => event.type),
    ).toEqual(["operation.finished", "verification.completed"]);
  });

  it("binds patch intent to mutation and rejects succeeded or failed proposal relabeling", () => {
    const seeded = seedVerifyingRun(1);
    const failing = seeded.verificationFor("failed", APPROVED);
    seeded.store.recordVerificationAndAwaitReview(RUN_ID, seeded.diff, failing, "verifying");
    seeded.store.beginSessionIteration(RUN_ID);
    chargeRepairIteration(seeded.store);

    seeded.store.beginOperation(RUN_ID, "session.tool.read.manifest", 0, 0, 1_000);
    const before = seeded.store.getRun(RUN_ID);
    if (before.patchSet === null) throw new Error("Expected a current patch set");
    const checkpointFiles = seeded.store.listCheckpointFiles(RUN_ID);
    expectCode(
      () => seeded.store.recordPatchSetIntent(RUN_ID, before.patchSet as PatchSet, checkpointFiles),
      "RUN_BUSY",
    );
    seeded.store.markStartedOperationsInterrupted(RUN_ID);

    const mutation = seeded.store.beginOperation(
      RUN_ID,
      "session.tool.mutation.patchset",
      0,
      0,
      1_000,
    );
    seeded.store.recordPatchSetIntent(RUN_ID, before.patchSet, checkpointFiles);
    seeded.store.saveTreeCheckpoint(RUN_ID, failing.checkpointSha256);
    expectCode(
      () => seeded.store.finishOperation(mutation, succeededFinish({ tool: "propose_patch" })),
      "INVALID_OPERATION_OUTCOME",
    );
    expectCode(
      () =>
        seeded.store.finishOperation(mutation, {
          ...succeededFinish({ tool: "propose_patch" }),
          outcome: "failed",
        }),
      "INVALID_OPERATION_OUTCOME",
    );
    seeded.store.markStartedOperationsInterrupted(RUN_ID);
  });

  it("requires operation-bound repair intent and verification semantics", () => {
    const outside = seedVerifyingRun(1);
    const outsideFailure = outside.verificationFor("failed", APPROVED);
    outside.store.recordVerificationAndAwaitReview(
      RUN_ID,
      outside.diff,
      outsideFailure,
      "verifying",
    );
    outside.store.beginSessionIteration(RUN_ID);
    chargeRepairIteration(outside.store);
    const outsideRun = outside.store.getRun(RUN_ID);
    if (outsideRun.patchSet === null) throw new Error("Expected a current patch set");
    expectCode(
      () =>
        outside.store.recordPatchSetIntent(
          RUN_ID,
          outsideRun.patchSet as PatchSet,
          outside.store.listCheckpointFiles(RUN_ID),
        ),
      "RUN_BUSY",
    );

    const direct = seedVerifyingRun(1);
    direct.verificationFor("failed", APPROVED);
    enterRunningSession(direct.store);
    expectCode(
      () =>
        direct.store.recordVerificationAndAwaitReview(
          RUN_ID,
          direct.diff,
          direct.verificationFor("passed", APPROVED),
          "running",
        ),
      "INVALID_OPERATION_OUTCOME",
    );

    const applied = seedVerifyingRun(1);
    const appliedFailure = applied.verificationFor("failed", APPROVED);
    applied.store.recordVerificationAndAwaitReview(
      RUN_ID,
      applied.diff,
      appliedFailure,
      "verifying",
    );
    applied.store.beginSessionIteration(RUN_ID);
    chargeRepairIteration(applied.store);
    const appliedRun = applied.store.getRun(RUN_ID);
    if (appliedRun.patchSet === null) throw new Error("Expected a current patch set");
    const apply = beginPatchOperation(applied.store);
    applied.store.recordPatchSetIntent(
      RUN_ID,
      appliedRun.patchSet,
      applied.store.listCheckpointFiles(RUN_ID),
    );
    const passingApply = applied.verificationFor("passed", APPROVED);
    expectCode(
      () =>
        applied.store.finishSessionVerificationOperation(
          apply,
          succeededFinish({ tool: "apply_patchset" }),
          applied.diff,
          passingApply,
        ),
      "VERIFICATION_OUTCOME_MISMATCH",
    );
    applied.store.markStartedOperationsInterrupted(RUN_ID);

    const reconciled = seedVerifyingRun(1);
    reconciled.verificationFor("failed", APPROVED);
    enterRunningSession(reconciled.store);
    const reconcile = reconciled.store.beginOperation(
      RUN_ID,
      "session.reconcile",
      0,
      0,
      1_000,
      "running",
    );
    expectCode(
      () =>
        reconciled.store.finishSessionVerificationOperation(
          reconcile,
          succeededFinish(),
          reconciled.diff,
          reconciled.verificationFor("passed", APPROVED),
        ),
      "VERIFICATION_OUTCOME_MISMATCH",
    );
    reconciled.store.markStartedOperationsInterrupted(RUN_ID);
  });

  it("requires failed patch settlement to carry its exact durable effects", () => {
    const seeded = seedVerifyingRun(1);
    seeded.verificationFor("failed", APPROVED);
    enterRunningSession(seeded.store);
    const operation = beginPatchOperation(seeded.store);
    const current = seeded.store.getRun(RUN_ID);
    if (current.verification === null) throw new Error("Expected failing verification");
    const unavailable: VerificationEvidence = {
      ...current.verification,
      outcome: "unavailable",
      checks: [checkEvidence("unavailable")],
    };
    expectCode(
      () =>
        seeded.store.finishFailedSessionPatchVerificationOperation(
          operation,
          {
            ...succeededFinish({ tool: "apply_patchset" }),
            outcome: "failed",
          },
          seeded.diff,
          unavailable,
        ),
      "INVALID_OPERATION_OUTCOME",
    );
    seeded.store.markStartedOperationsInterrupted(RUN_ID);
  });

  it.each([
    "session.tool.exec.check",
    "session.tool.mutation.patchset",
    "session.control.report_done",
    "session.control.request_human_input",
    "review.validate",
    "checkpoint.rollback",
    "checkpoint.restore",
  ] as const)("requires atomic durable settlement for succeeded %s", (operationKind) => {
    const seeded = seedVerifyingRun(1);
    const failing = seeded.verificationFor("failed", APPROVED);
    seeded.store.recordVerificationAndAwaitReview(RUN_ID, seeded.diff, failing, "verifying");
    seeded.store.beginSessionIteration(RUN_ID);
    chargeRepairIteration(seeded.store);
    const operation = seeded.store.beginOperation(RUN_ID, operationKind, 0, 0, 1_000);

    expectCode(
      () => seeded.store.finishOperation(operation, succeededFinish()),
      "INVALID_OPERATION_OUTCOME",
    );
    expect(
      seeded.store.finishOperation(operation, {
        ...succeededFinish(),
        outcome: "failed",
        detail:
          operationKind === "session.tool.mutation.patchset" ? { tool: "apply_patchset" } : {},
      }).state,
    ).toBe("running");
  });

  it("rolls operation settlement back when current verification validation fails", () => {
    const seeded = seedVerifyingRun(1);
    seeded.verificationFor("failed", APPROVED);
    enterRunningSession(seeded.store);
    const passing = seeded.verificationFor("passed", APPROVED);
    const operation = seeded.store.beginOperation(
      RUN_ID,
      "session.tool.exec.check",
      0,
      0,
      1_000,
      "running",
    );
    const admitted = seeded.store.getRun(RUN_ID);

    expectCode(
      () =>
        seeded.store.finishSessionVerificationOperation(operation, succeededFinish(), seeded.diff, {
          ...passing,
          diffSha256: "f".repeat(64),
        }),
      "VERIFICATION_DIGEST_MISMATCH",
    );

    expect(seeded.store.getRun(RUN_ID)).toMatchObject({
      state: "running",
      usage: admitted.usage,
      verification: { outcome: "failed" },
    });
    expect(
      seeded.store
        .listEvents(RUN_ID)
        .some(
          (event) =>
            event.type === "operation.finished" &&
            (event.payload as Record<string, unknown>).operationId === operation.id,
        ),
    ).toBe(false);
    seeded.store.markStartedOperationsInterrupted(RUN_ID);
  });

  it("rolls session verification settlement back when its evidence event cannot persist", () => {
    const seeded = seedVerifyingRun(1);
    seeded.verificationFor("failed", APPROVED);
    enterRunningSession(seeded.store);
    const passing = seeded.verificationFor("passed", APPROVED);
    const operation = seeded.store.beginOperation(
      RUN_ID,
      "session.tool.exec.check",
      0,
      0,
      1_000,
      "running",
    );
    const admitted = seeded.store.getRun(RUN_ID);
    const approvalsBefore = seeded.store.listApprovals(RUN_ID);
    const eventsBefore = seeded.store.listEvents(RUN_ID);
    const database = new Database(seeded.databasePath);
    try {
      database.exec(`CREATE TRIGGER reject_session_verification_completion
        BEFORE INSERT ON run_events
        WHEN NEW.type = 'verification.completed'
        BEGIN SELECT RAISE(ABORT, 'synthetic verification event failure'); END`);
    } finally {
      database.close();
    }

    expect(() =>
      seeded.store.finishSessionVerificationOperation(
        operation,
        succeededFinish(),
        seeded.diff,
        passing,
      ),
    ).toThrow("synthetic verification event failure");
    expect(seeded.store.getRun(RUN_ID)).toMatchObject({
      state: "running",
      usage: admitted.usage,
      diff: admitted.diff,
      verification: admitted.verification,
    });
    expect(seeded.store.listApprovals(RUN_ID)).toEqual(approvalsBefore);
    expect(seeded.store.listEvents(RUN_ID)).toEqual(eventsBefore);
    expect(
      seeded.store
        .listEvents(RUN_ID)
        .some(
          (event) =>
            event.type === "operation.finished" &&
            (event.payload as Record<string, unknown>).operationId === operation.id,
        ),
    ).toBe(false);
    seeded.store.markStartedOperationsInterrupted(RUN_ID);
  });

  it("accepts only the exact session verification operation kinds", () => {
    const seeded = seedVerifyingRun(1);
    seeded.verificationFor("failed", APPROVED);
    enterRunningSession(seeded.store);
    const passing = seeded.verificationFor("passed", APPROVED);
    const operation = seeded.store.beginOperation(
      RUN_ID,
      "session.tool.read.manifest",
      0,
      0,
      1_000,
      "running",
    );

    expectCode(
      () =>
        seeded.store.finishSessionVerificationOperation(
          operation,
          succeededFinish(),
          seeded.diff,
          passing,
        ),
      "OPERATION_TOKEN_MISMATCH",
    );
    seeded.store.markStartedOperationsInterrupted(RUN_ID);
  });

  it("atomically pairs succeeded report_done settlement with an approvable completion", () => {
    const seeded = seedVerifyingRun(1);
    seeded.verificationFor("failed", APPROVED);
    enterRunningSession(seeded.store);
    const passing = recordPassingSessionVerification(seeded);
    const operation = seeded.store.beginOperation(
      RUN_ID,
      "session.control.report_done",
      0,
      0,
      1_000,
      "running",
    );

    const awaitingReview = seeded.store.finishSessionControlOperation(
      operation,
      succeededFinish({ tool: "report_done" }),
      "completed",
      "The registered check passes.",
      1,
    );

    expect(awaitingReview.state).toBe("awaiting_review");
    const terminal = seeded.store.listEvents(RUN_ID).slice(-2);
    expect(terminal.map((event) => event.type)).toEqual([
      "operation.finished",
      "session.completed",
    ]);
    expect(terminal[1]?.payload).toEqual({
      iterations: 1,
      operationId: operation.id,
      summary: "The registered check passes.",
    });
    seeded.store.recordSessionIterationBoundary(RUN_ID, 1);
    expect(
      seeded.store.decideReview(RUN_ID, passing.diffSha256, "unit-operator", "approve").state,
    ).toBe("completed");
  });

  it("rolls report_done settlement back when completion evidence is not passing", () => {
    const seeded = seedVerifyingRun(1);
    seeded.verificationFor("failed", APPROVED);
    enterRunningSession(seeded.store);
    const operation = seeded.store.beginOperation(
      RUN_ID,
      "session.control.report_done",
      0,
      0,
      1_000,
      "running",
    );
    const admitted = seeded.store.getRun(RUN_ID);

    expectCode(
      () =>
        seeded.store.finishSessionControlOperation(
          operation,
          succeededFinish(),
          "completed",
          "This must not override failed evidence.",
          1,
        ),
      "VERIFICATION_NOT_PASSED",
    );
    expect(seeded.store.getRun(RUN_ID)).toMatchObject({ state: "running", usage: admitted.usage });
    expect(
      seeded.store
        .listEvents(RUN_ID)
        .some(
          (event) =>
            event.type === "operation.finished" &&
            (event.payload as Record<string, unknown>).operationId === operation.id,
        ),
    ).toBe(false);
    seeded.store.markStartedOperationsInterrupted(RUN_ID);
  });

  it("rolls report_done settlement back when its session event cannot persist", () => {
    const seeded = seedVerifyingRun(1);
    seeded.verificationFor("failed", APPROVED);
    enterRunningSession(seeded.store);
    const passing = recordPassingSessionVerification(seeded);
    const operation = seeded.store.beginOperation(
      RUN_ID,
      "session.control.report_done",
      0,
      0,
      1_000,
      "running",
    );
    const admitted = seeded.store.getRun(RUN_ID);
    const approvalsBefore = seeded.store.listApprovals(RUN_ID);
    const eventsBefore = seeded.store.listEvents(RUN_ID);
    const database = new Database(seeded.databasePath);
    try {
      database.exec(`CREATE TRIGGER reject_session_completion
        BEFORE INSERT ON run_events
        WHEN NEW.type = 'session.completed'
        BEGIN SELECT RAISE(ABORT, 'synthetic session event failure'); END`);
    } finally {
      database.close();
    }

    expect(() =>
      seeded.store.finishSessionControlOperation(
        operation,
        succeededFinish(),
        "completed",
        "The registered check passes.",
        1,
      ),
    ).toThrow("synthetic session event failure");
    expect(seeded.store.getRun(RUN_ID)).toMatchObject({
      state: "running",
      usage: admitted.usage,
      verification: passing,
    });
    expect(seeded.store.listApprovals(RUN_ID)).toEqual(approvalsBefore);
    expect(seeded.store.listEvents(RUN_ID)).toEqual(eventsBefore);
    expect(
      seeded.store
        .listEvents(RUN_ID)
        .some(
          (event) =>
            event.type === "operation.finished" &&
            (event.payload as Record<string, unknown>).operationId === operation.id,
        ),
    ).toBe(false);
    seeded.store.markStartedOperationsInterrupted(RUN_ID);
  });

  it("atomically settles request_human_input with a non-approvable disposition", () => {
    const seeded = seedVerifyingRun(1);
    seeded.verificationFor("failed", APPROVED);
    enterRunningSession(seeded.store);
    const operation = seeded.store.beginOperation(
      RUN_ID,
      "session.control.request_human_input",
      0,
      0,
      1_000,
      "running",
    );

    const updated = seeded.store.finishSessionControlOperation(
      operation,
      succeededFinish(),
      "awaiting_human",
      "Which implementation should I use?",
      1,
    );

    expect(updated.state).toBe("awaiting_review");
    expect(
      seeded.store
        .listEvents(RUN_ID)
        .slice(-2)
        .map((event) => event.type),
    ).toEqual(["operation.finished", "session.awaiting_human"]);
    expectCode(
      () => seeded.store.decideReview(RUN_ID, sha256(seeded.diff), "unit-operator", "approve"),
      "SESSION_NOT_COMPLETED",
    );
  });

  it("allows zero-turn exhaustion while completed outcomes still require an iteration", () => {
    const seeded = seedVerifyingRun(1);
    const failing = seeded.verificationFor("failed", APPROVED);
    seeded.store.recordVerificationAndAwaitReview(RUN_ID, seeded.diff, failing, "verifying");
    seeded.store.beginSessionIteration(RUN_ID);

    expectCode(
      () => seeded.store.recordSessionOutcome(RUN_ID, "completed", "Not verified.", 0),
      "INVALID_SESSION_ITERATION",
    );
    expect(seeded.store.recordSessionOutcome(RUN_ID, "exhausted", null, 0).state).toBe(
      "awaiting_review",
    );
  });

  it("bounds session outcome text by UTF-8 bytes", () => {
    const seeded = seedVerifyingRun(1);
    seeded.verificationFor("failed", APPROVED);
    enterRunningSession(seeded.store);

    expectCode(
      () => seeded.store.recordSessionOutcome(RUN_ID, "awaiting_human", "é".repeat(1_001), 1),
      "INVALID_SESSION_OUTCOME",
    );
    expect(seeded.store.getRun(RUN_ID).state).toBe("running");
  });

  it("atomically settles review.validate with the review approval", () => {
    const seeded = seedVerifyingRun(0);
    const passing = seeded.verificationFor("passed", APPROVED);
    seeded.store.recordVerificationAndAwaitReview(RUN_ID, seeded.diff, passing);
    const operation = seeded.store.beginOperation(
      RUN_ID,
      "review.validate",
      0,
      0,
      1_000,
      "awaiting_review",
    );

    const completed = seeded.store.finishReviewValidationAndApprove(
      operation,
      succeededFinish(),
      passing.diffSha256,
      "unit-operator",
    );

    expect(completed.state).toBe("completed");
    expect(
      seeded.store
        .listEvents(RUN_ID)
        .slice(-2)
        .map((event) => event.type),
    ).toEqual(["operation.finished", "review.accepted"]);
  });

  it("rolls review.validate settlement back when approval validation fails", () => {
    const seeded = seedVerifyingRun(0);
    const passing = seeded.verificationFor("passed", APPROVED);
    seeded.store.recordVerificationAndAwaitReview(RUN_ID, seeded.diff, passing);
    const operation = seeded.store.beginOperation(
      RUN_ID,
      "review.validate",
      0,
      0,
      1_000,
      "awaiting_review",
    );
    const admitted = seeded.store.getRun(RUN_ID);

    expectCode(
      () =>
        seeded.store.finishReviewValidationAndApprove(
          operation,
          succeededFinish(),
          "f".repeat(64),
          "unit-operator",
        ),
      "STALE_APPROVAL",
    );
    expect(seeded.store.getRun(RUN_ID)).toMatchObject({
      state: "awaiting_review",
      usage: admitted.usage,
    });
    expect(
      seeded.store.listApprovals(RUN_ID).filter((approval) => approval.kind === "review"),
    ).toEqual([]);
    expect(
      seeded.store
        .listEvents(RUN_ID)
        .some(
          (event) =>
            event.type === "operation.finished" &&
            (event.payload as Record<string, unknown>).operationId === operation.id,
        ),
    ).toBe(false);
    seeded.store.markStartedOperationsInterrupted(RUN_ID);
  });

  it("rolls review validation settlement back when its acceptance event cannot persist", () => {
    const seeded = seedVerifyingRun(0);
    const passing = seeded.verificationFor("passed", APPROVED);
    seeded.store.recordVerificationAndAwaitReview(RUN_ID, seeded.diff, passing);
    const operation = seeded.store.beginOperation(
      RUN_ID,
      "review.validate",
      0,
      0,
      1_000,
      "awaiting_review",
    );
    const admitted = seeded.store.getRun(RUN_ID);
    const approvalsBefore = seeded.store.listApprovals(RUN_ID);
    const eventsBefore = seeded.store.listEvents(RUN_ID);
    const database = new Database(seeded.databasePath);
    try {
      database.exec(`CREATE TRIGGER reject_review_acceptance
        BEFORE INSERT ON run_events
        WHEN NEW.type = 'review.accepted'
        BEGIN SELECT RAISE(ABORT, 'synthetic review event failure'); END`);
    } finally {
      database.close();
    }

    expect(() =>
      seeded.store.finishReviewValidationAndApprove(
        operation,
        succeededFinish(),
        passing.diffSha256,
        "unit-operator",
      ),
    ).toThrow("synthetic review event failure");
    expect(seeded.store.getRun(RUN_ID)).toMatchObject({
      state: "awaiting_review",
      usage: admitted.usage,
      verification: passing,
    });
    expect(seeded.store.listApprovals(RUN_ID)).toEqual(approvalsBefore);
    expect(
      seeded.store.listApprovals(RUN_ID).filter((approval) => approval.kind === "review"),
    ).toEqual([]);
    expect(seeded.store.listEvents(RUN_ID)).toEqual(eventsBefore);
    expect(
      seeded.store
        .listEvents(RUN_ID)
        .some(
          (event) =>
            event.type === "operation.finished" &&
            (event.payload as Record<string, unknown>).operationId === operation.id,
        ),
    ).toBe(false);
    seeded.store.markStartedOperationsInterrupted(RUN_ID);
  });

  it("atomically settles checkpoint rollback and restore transitions", () => {
    const seeded = seedVerifyingRun(0);
    const passing = seeded.verificationFor("passed", APPROVED);
    seeded.store.recordVerificationAndAwaitReview(RUN_ID, seeded.diff, passing);
    seeded.store.approveRollback(RUN_ID, passing.diffSha256, "unit-operator");
    const rollback = seeded.store.beginOperation(
      RUN_ID,
      "checkpoint.rollback",
      0,
      0,
      1_000,
      "rolling_back",
    );
    expect(seeded.store.finishCheckpointRecoveryOperation(rollback, succeededFinish()).state).toBe(
      "rolled_back",
    );
    expect(
      seeded.store
        .listEvents(RUN_ID)
        .slice(-2)
        .map((event) => event.type),
    ).toEqual(["operation.finished", "rollback.completed"]);

    seeded.store.approveRestore(
      RUN_ID,
      seeded.store.getCheckpoint(RUN_ID).checkpointSha256,
      "unit-operator",
    );
    const restore = seeded.store.beginOperation(
      RUN_ID,
      "checkpoint.restore",
      0,
      0,
      1_000,
      "restoring",
    );
    expect(seeded.store.finishCheckpointRecoveryOperation(restore, succeededFinish()).state).toBe(
      "verifying",
    );
    expect(
      seeded.store
        .listEvents(RUN_ID)
        .slice(-2)
        .map((event) => event.type),
    ).toEqual(["operation.finished", "restore.completed"]);
  });

  it("rolls checkpoint operation settlement back when its transition cannot persist", () => {
    const seeded = seedVerifyingRun(0);
    const passing = seeded.verificationFor("passed", APPROVED);
    seeded.store.recordVerificationAndAwaitReview(RUN_ID, seeded.diff, passing);
    seeded.store.approveRollback(RUN_ID, passing.diffSha256, "unit-operator");
    const rollback = seeded.store.beginOperation(
      RUN_ID,
      "checkpoint.rollback",
      0,
      0,
      1_000,
      "rolling_back",
    );
    const admitted = seeded.store.getRun(RUN_ID);
    const database = new Database(seeded.databasePath);
    try {
      database.exec(`CREATE TRIGGER reject_rollback_completion
        BEFORE INSERT ON run_events
        WHEN NEW.type = 'rollback.completed'
        BEGIN SELECT RAISE(ABORT, 'synthetic transition failure'); END`);
    } finally {
      database.close();
    }

    expect(() =>
      seeded.store.finishCheckpointRecoveryOperation(rollback, succeededFinish()),
    ).toThrow("synthetic transition failure");
    expect(seeded.store.getRun(RUN_ID)).toMatchObject({
      state: "rolling_back",
      usage: admitted.usage,
    });
    expect(
      seeded.store
        .listEvents(RUN_ID)
        .some(
          (event) =>
            event.type === "operation.finished" &&
            (event.payload as Record<string, unknown>).operationId === rollback.id,
        ),
    ).toBe(false);
    seeded.store.markStartedOperationsInterrupted(RUN_ID);
  });

  it("rolls restore operation settlement back when its transition event cannot persist", () => {
    const seeded = seedVerifyingRun(0);
    const passing = seeded.verificationFor("passed", APPROVED);
    seeded.store.recordVerificationAndAwaitReview(RUN_ID, seeded.diff, passing);
    seeded.store.approveRollback(RUN_ID, passing.diffSha256, "unit-operator");
    const rollback = seeded.store.beginOperation(
      RUN_ID,
      "checkpoint.rollback",
      0,
      0,
      1_000,
      "rolling_back",
    );
    seeded.store.finishCheckpointRecoveryOperation(rollback, succeededFinish());
    seeded.store.approveRestore(
      RUN_ID,
      seeded.store.getCheckpoint(RUN_ID).checkpointSha256,
      "unit-operator",
    );
    const restore = seeded.store.beginOperation(
      RUN_ID,
      "checkpoint.restore",
      0,
      0,
      1_000,
      "restoring",
    );
    const admitted = seeded.store.getRun(RUN_ID);
    const approvalsBefore = seeded.store.listApprovals(RUN_ID);
    const eventsBefore = seeded.store.listEvents(RUN_ID);
    const database = new Database(seeded.databasePath);
    try {
      database.exec(`CREATE TRIGGER reject_restore_completion
        BEFORE INSERT ON run_events
        WHEN NEW.type = 'restore.completed'
        BEGIN SELECT RAISE(ABORT, 'synthetic restore event failure'); END`);
    } finally {
      database.close();
    }

    expect(() =>
      seeded.store.finishCheckpointRecoveryOperation(restore, succeededFinish()),
    ).toThrow("synthetic restore event failure");
    expect(seeded.store.getRun(RUN_ID)).toMatchObject({
      state: "restoring",
      usage: admitted.usage,
      verification: admitted.verification,
    });
    expect(seeded.store.listApprovals(RUN_ID)).toEqual(approvalsBefore);
    expect(seeded.store.listEvents(RUN_ID)).toEqual(eventsBefore);
    expect(
      seeded.store
        .listEvents(RUN_ID)
        .some(
          (event) =>
            event.type === "operation.finished" &&
            (event.payload as Record<string, unknown>).operationId === restore.id,
        ),
    ).toBe(false);
    seeded.store.markStartedOperationsInterrupted(RUN_ID);
  });

  it("enforces the checkpoint operation kind's expected recovery state", () => {
    const seeded = seedVerifyingRun(0);
    const passing = seeded.verificationFor("passed", APPROVED);
    seeded.store.recordVerificationAndAwaitReview(RUN_ID, seeded.diff, passing);
    seeded.store.approveRollback(RUN_ID, passing.diffSha256, "unit-operator");
    const wrong = seeded.store.beginOperation(
      RUN_ID,
      "checkpoint.restore",
      0,
      0,
      1_000,
      "rolling_back",
    );

    expectCode(
      () => seeded.store.finishCheckpointRecoveryOperation(wrong, succeededFinish()),
      "INVALID_STATE",
    );
    expect(seeded.store.getRun(RUN_ID).state).toBe("rolling_back");
    seeded.store.markStartedOperationsInterrupted(RUN_ID);
  });

  it("resumes a modern patch-set verification before a checkpoint row exists", () => {
    const seeded = seedVerifyingRun(0);
    seeded.store.failRun(
      RUN_ID,
      "verifying",
      new IcarusError("INTERRUPTED", "Synthetic verification interruption"),
    );

    expect(seeded.store.resumeFailed(RUN_ID).state).toBe("verifying");
  });

  it.each(["rolling_back", "restoring"] as const)(
    "resumes a modern patch-set %s recovery state",
    (resumeState) => {
      const seeded = seedVerifyingRun(0);
      const passing = seeded.verificationFor("passed", APPROVED);
      seeded.store.recordVerificationAndAwaitReview(RUN_ID, seeded.diff, passing);
      seeded.store.approveRollback(RUN_ID, passing.diffSha256, "unit-operator");
      if (resumeState === "restoring") {
        seeded.store.finishRollback(RUN_ID);
        seeded.store.approveRestore(
          RUN_ID,
          seeded.store.getCheckpoint(RUN_ID).checkpointSha256,
          "unit-operator",
        );
      }
      seeded.store.failRun(
        RUN_ID,
        resumeState,
        new IcarusError("INTERRUPTED", "Synthetic recovery interruption"),
      );

      expect(seeded.store.resumeFailed(RUN_ID).state).toBe(resumeState);
    },
  );

  it("does not accept legacy byte columns in place of modern checkpoint files", () => {
    const seeded = seedVerifyingRun(0);
    seeded.store.failRun(
      RUN_ID,
      "verifying",
      new IcarusError("INTERRUPTED", "Synthetic verification interruption"),
    );
    const database = new Database(seeded.databasePath);
    try {
      database
        .prepare(
          "UPDATE runs SET baseline_base64 = 'YmFzZQ==', approved_base64 = 'YXBwcm92ZWQ=' WHERE id = ?",
        )
        .run(RUN_ID);
      database.prepare("DELETE FROM checkpoint_files WHERE run_id = ?").run(RUN_ID);
    } finally {
      database.close();
    }

    expectCode(() => seeded.store.resumeFailed(RUN_ID), "MISSING_CHECKPOINT");
  });

  it("requires the immutable checkpoint when resuming modern rollback", () => {
    const seeded = seedVerifyingRun(0);
    const passing = seeded.verificationFor("passed", APPROVED);
    seeded.store.recordVerificationAndAwaitReview(RUN_ID, seeded.diff, passing);
    seeded.store.approveRollback(RUN_ID, passing.diffSha256, "unit-operator");
    seeded.store.failRun(
      RUN_ID,
      "rolling_back",
      new IcarusError("INTERRUPTED", "Synthetic rollback interruption"),
    );
    const database = new Database(seeded.databasePath);
    try {
      database.prepare("DELETE FROM checkpoints WHERE run_id = ?").run(RUN_ID);
    } finally {
      database.close();
    }

    expectCode(() => seeded.store.resumeFailed(RUN_ID), "MISSING_CHECKPOINT");
  });
});
