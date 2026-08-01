import { sha256 } from "../../packages/core/src/digest.js";
import { checkpointDigest, planApprovalDigest } from "../../packages/core/src/policy.js";
import type { IcarusStore } from "../../packages/core/src/store.js";
import type { VerificationEvidence } from "../../packages/core/src/types.js";
import {
  createUnitStore,
  seedUnitProject,
  UNIT_BASE_COMMIT,
  UNIT_PLAN,
  UNIT_PROVIDER,
  UNIT_RUN_ID,
  unitContextDigest,
  unitContextManifest,
} from "./unit-fixtures.js";

export interface ChangeRoomFixture {
  readonly root: string;
  readonly databasePath: string;
  readonly store: IcarusStore;
  readonly projectId: string;
  readonly runId: string;
}

export function createChangeRoomFixture(): ChangeRoomFixture {
  const fixture = createUnitStore();
  const { projectId } = seedUnitProject(fixture.store);
  fixture.store.createRun({
    id: UNIT_RUN_ID,
    projectId,
    task: "Update the greeting",
    target: UNIT_PLAN.target,
    provider: UNIT_PROVIDER,
  });
  return { ...fixture, projectId, runId: UNIT_RUN_ID };
}

export function prepareChangeRoomRun(store: IcarusStore): void {
  store.pinRunBase(UNIT_RUN_ID, UNIT_BASE_COMMIT);
  const context = unitContextManifest();
  store.completePreparation(
    UNIT_RUN_ID,
    context,
    "/tmp/unit-context.json",
    unitContextDigest(context),
  );
}

export function approveChangeRoomPlan(store: IcarusStore): string {
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
  return digest;
}

export interface VerifiedRunEvidence {
  readonly diff: string;
  readonly diffSha256: string;
  readonly checkpointSha256: string;
}

export function driveToAwaitingReview(
  store: IcarusStore,
  outcome: VerificationEvidence["outcome"] = "passed",
): VerifiedRunEvidence {
  prepareChangeRoomRun(store);
  approveChangeRoomPlan(store);
  return finishToAwaitingReview(store, outcome);
}

export function finishToAwaitingReview(
  store: IcarusStore,
  outcome: VerificationEvidence["outcome"] = "passed",
): VerifiedRunEvidence {
  const baselineBase64 = Buffer.from("hello\n").toString("base64");
  const approvedBase64 = Buffer.from("goodbye\n").toString("base64");
  store.recordWorkspace(UNIT_RUN_ID, "/tmp/unit-cache.git", "/tmp/unit-worktree", baselineBase64);
  store.recordEditIntent(
    UNIT_RUN_ID,
    {
      path: UNIT_PLAN.target,
      expectedPreimageSha256: sha256("hello\n"),
      findText: "hello",
      replaceText: "goodbye",
      rationale: "Exercise the Change Room projection.",
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
  store.saveCheckpoint(UNIT_RUN_ID, baselineBase64, approvedBase64, checkpointSha256);
  store.transition(UNIT_RUN_ID, "verifying", "edit.materialized");
  const diff = "diff --git a/src/greeting.txt b/src/greeting.txt\n-hello\n+goodbye\n";
  store.recordVerificationAndAwaitReview(UNIT_RUN_ID, diff, {
    outcome,
    checks: [
      {
        checkId: "unit",
        argv: ["node", "--test"],
        exitCode: outcome === "passed" ? 0 : 1,
        signal: null,
        durationMs: 10,
        stdout: outcome === "passed" ? "ok\n" : "",
        stderr: outcome === "passed" ? "" : "assertion failed\n",
        truncated: false,
        outcome: outcome === "passed" ? "passed" : "failed",
      },
    ],
    changedPaths: [UNIT_PLAN.target],
    diffSha256: sha256(diff),
    checkpointSha256,
  });
  return { diff, diffSha256: sha256(diff), checkpointSha256 };
}

export function driveToCompleted(store: IcarusStore): VerifiedRunEvidence {
  const evidence = driveToAwaitingReview(store, "passed");
  store.decideReview(UNIT_RUN_ID, evidence.diffSha256, "unit-operator", "approve");
  return evidence;
}

export function driveToRolledBack(store: IcarusStore): VerifiedRunEvidence {
  const evidence = driveToAwaitingReview(store, "passed");
  store.decideReview(UNIT_RUN_ID, evidence.diffSha256, "unit-operator", "reject");
  store.finishRollback(UNIT_RUN_ID);
  return evidence;
}
