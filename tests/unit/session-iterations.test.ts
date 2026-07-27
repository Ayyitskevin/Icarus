import { rmSync } from "node:fs";

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
  PatchSet,
  VerificationEvidence,
} from "../../packages/core/src/types.js";
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
    exitCode: outcome === "passed" ? 0 : 1,
    signal: null,
    durationMs: 5,
    stdout: outcome === "passed" ? "ok\n" : "assertion failed\n",
    stderr: "",
    truncated: false,
    outcome,
  };
}

/** Drives a run to `verifying` with a recorded patch set and checkpoint. */
function seedVerifyingRun(iterationCeiling: number): {
  readonly store: ReturnType<typeof createUnitStore>["store"];
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

    const revised = "hello, repaired\n";
    const updated = seeded.store.recordPatchSetIntent(
      RUN_ID,
      patchSetFor(revised),
      checkpointFilesFor(revised),
    );

    expect(updated.patchSet?.edits[0]?.op).toBe("modify");
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
