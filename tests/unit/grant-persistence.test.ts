import { createRequire } from "node:module";

import { afterEach, describe, expect, it } from "vitest";

import { sha256 } from "../../packages/core/src/digest.js";
import { IcarusError } from "../../packages/core/src/errors.js";
import { planApprovalDigest } from "../../packages/core/src/policy.js";
import { IcarusStore } from "../../packages/core/src/store.js";
import type { PlanProposal, ReadableManifest } from "../../packages/core/src/types.js";
import {
  createUnitStore,
  seedUnitProject,
  UNIT_BASE_COMMIT,
  UNIT_PLAN,
  UNIT_PROVIDER,
  UNIT_RUN_ID,
  unitContextDigest,
  unitContextManifest,
} from "../support/unit-fixtures.js";

interface TestDatabase {
  prepare(sql: string): { run(...params: readonly unknown[]): unknown };
  exec(sql: string): void;
  close(): void;
}

const Database = createRequire(new URL("../../packages/core/package.json", import.meta.url))(
  "better-sqlite3",
) as new (
  filename: string,
) => TestDatabase;

const cleanupRoots: string[] = [];

afterEach(async () => {
  const { rmSync } = await import("node:fs");
  while (cleanupRoots.length > 0) {
    const root = cleanupRoots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

function seedPlannedRun(): {
  readonly store: IcarusStore;
  readonly root: string;
  readonly databasePath: string;
} {
  const fixture = createUnitStore();
  cleanupRoots.push(fixture.root);
  const { projectId } = seedUnitProject(fixture.store);
  fixture.store.createRun({
    id: UNIT_RUN_ID,
    projectId,
    task: "Update the greeting",
    targets: UNIT_PLAN.targets,
    provider: UNIT_PROVIDER,
  });
  fixture.store.pinRunBase(UNIT_RUN_ID, UNIT_BASE_COMMIT);
  const context = unitContextManifest();
  fixture.store.completePreparation(
    UNIT_RUN_ID,
    context,
    "/tmp/unit-context.json",
    unitContextDigest(context),
  );
  return { store: fixture.store, root: fixture.root, databasePath: fixture.databasePath };
}

function digestFor(
  store: IcarusStore,
  plan: PlanProposal,
  readableManifest: ReadableManifest | null,
): string {
  const run = store.getRun(UNIT_RUN_ID);
  const project = store.getProject(run.projectId);
  return planApprovalDigest({
    task: run.task,
    baseCommit: run.baseCommit,
    contextSha256: run.contextSha256,
    targets: run.context.targets,
    provider: run.provider,
    checks: project.checks,
    sandbox: project.sandbox,
    ceiling: project.ceiling,
    plan,
    readableManifest,
  });
}

function expectIcarusCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error(`Expected Icarus error ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(IcarusError);
    expect((error as IcarusError).code).toBe(code);
  }
}

const READ_PLAN: PlanProposal = {
  ...UNIT_PLAN,
  grants: [{ kind: "read.manifest", scope: ["src/"], maxCalls: 8 }],
};

describe("granted authority is persisted only when it is resolved", () => {
  it("refuses a read grant with no resolved manifest to approve", () => {
    const { store } = seedPlannedRun();
    expectIcarusCode(
      () =>
        store.recordPlanAndAwaitApproval(
          UNIT_RUN_ID,
          READ_PLAN,
          digestFor(store, READ_PLAN, null),
          null,
        ),
      "READ_MANIFEST_UNRESOLVED",
    );
    expect(store.getRun(UNIT_RUN_ID).state).toBe("planned");
    store.close();
  });

  it("refuses a manifest no grant asked for", () => {
    const { store } = seedPlannedRun();
    const manifest: ReadableManifest = {
      baseCommit: UNIT_BASE_COMMIT,
      entries: [{ path: "src/greeting.txt", sha256: sha256("hello") }],
    };
    expectIcarusCode(
      () =>
        store.recordPlanAndAwaitApproval(
          UNIT_RUN_ID,
          UNIT_PLAN,
          digestFor(store, UNIT_PLAN, manifest),
          manifest,
        ),
      "READ_MANIFEST_UNRESOLVED",
    );
    expect(store.getRun(UNIT_RUN_ID).state).toBe("planned");
    store.close();
  });

  it("refuses a manifest resolved against a different base commit", () => {
    const { store } = seedPlannedRun();
    const manifest: ReadableManifest = {
      baseCommit: "f".repeat(40),
      entries: [{ path: "src/greeting.txt", sha256: sha256("hello") }],
    };
    expectIcarusCode(
      () =>
        store.recordPlanAndAwaitApproval(
          UNIT_RUN_ID,
          READ_PLAN,
          digestFor(store, READ_PLAN, manifest),
          manifest,
        ),
      "READ_MANIFEST_UNRESOLVED",
    );
    expect(store.getRun(UNIT_RUN_ID).state).toBe("planned");
    store.close();
  });

  it("records a plan whose read grant carries a resolved manifest", () => {
    const { store } = seedPlannedRun();
    const manifest: ReadableManifest = {
      baseCommit: UNIT_BASE_COMMIT,
      entries: [{ path: "src/greeting.txt", sha256: sha256("hello") }],
    };
    const recorded = store.recordPlanAndAwaitApproval(
      UNIT_RUN_ID,
      READ_PLAN,
      digestFor(store, READ_PLAN, manifest),
      manifest,
    );
    expect(recorded.state).toBe("awaiting_approval");
    expect(recorded.plan?.grants).toHaveLength(1);
    store.close();
  });

  it("refuses a digest that omits the manifest it was approved with", () => {
    const { store } = seedPlannedRun();
    const manifest: ReadableManifest = {
      baseCommit: UNIT_BASE_COMMIT,
      entries: [{ path: "src/greeting.txt", sha256: sha256("hello") }],
    };
    expectIcarusCode(
      () =>
        store.recordPlanAndAwaitApproval(
          UNIT_RUN_ID,
          READ_PLAN,
          // Digest computed as if no manifest were granted.
          digestFor(store, READ_PLAN, null),
          manifest,
        ),
      "PLAN_DIGEST_MISMATCH",
    );
    store.close();
  });
});

describe("the approved readable set survives a restart", () => {
  const manifest: ReadableManifest = {
    baseCommit: UNIT_BASE_COMMIT,
    entries: [
      { path: "src/greeting.txt", sha256: sha256("hello") },
      { path: "README.md", sha256: sha256("readme") },
    ],
  };

  it("returns the manifest the approval bound, and null when no grant asked", () => {
    const seeded = seedPlannedRun();
    expect(seeded.store.readableManifest(UNIT_RUN_ID)).toBeNull();

    seeded.store.recordPlanAndAwaitApproval(
      UNIT_RUN_ID,
      READ_PLAN,
      digestFor(seeded.store, READ_PLAN, manifest),
      manifest,
    );
    seeded.store.close();

    const reopened = new IcarusStore(seeded.databasePath, {
      now: () => "2026-07-19T12:05:00.000Z",
      id: () => "unit-reopen-id",
    });
    const restored = reopened.readableManifest(UNIT_RUN_ID);
    expect(restored?.baseCommit).toBe(UNIT_BASE_COMMIT);
    expect(restored?.entries.map((entry) => entry.path)).toEqual(["src/greeting.txt", "README.md"]);
    reopened.close();
  });

  it("fails closed when a stored manifest no longer matches its recorded digest", () => {
    const seeded = seedPlannedRun();
    seeded.store.recordPlanAndAwaitApproval(
      UNIT_RUN_ID,
      READ_PLAN,
      digestFor(seeded.store, READ_PLAN, manifest),
      manifest,
    );
    seeded.store.close();

    // Widen the stored set behind Icarus's back, leaving the recorded digest
    // in place — the shape a tampered or corrupted state file would take.
    const raw = new Database(seeded.databasePath);
    raw.prepare("UPDATE readable_manifests SET entries_json = ? WHERE run_id = ?").run(
      JSON.stringify([
        { path: "src/greeting.txt", sha256: sha256("hello") },
        { path: "README.md", sha256: sha256("readme") },
        { path: "src/secret.txt", sha256: sha256("smuggled") },
      ]),
      UNIT_RUN_ID,
    );
    raw.close();

    const reopened = new IcarusStore(seeded.databasePath, {
      now: () => "2026-07-19T12:05:00.000Z",
      id: () => "unit-tamper-id",
    });
    expectIcarusCode(() => reopened.readableManifest(UNIT_RUN_ID), "READ_MANIFEST_DRIFT");
    reopened.close();
  });
});

describe("the readable manifest table is an operator-gated migration", () => {
  it("refuses to add the table to an existing state file without approval", () => {
    const seeded = seedPlannedRun();
    seeded.store.close();

    // An existing state file written before ADR 0026 has `runs` but no
    // `readable_manifests`.
    const raw = new Database(seeded.databasePath);
    raw.exec("DROP TABLE readable_manifests");
    raw.close();

    expectIcarusCode(
      () => new IcarusStore(seeded.databasePath, { now: () => "2026-07-19T12:05:00.000Z" }),
      "DATABASE_MIGRATION_REQUIRED",
    );

    const migrated = new IcarusStore(seeded.databasePath, {
      now: () => "2026-07-19T12:05:00.000Z",
      id: () => "unit-migrate-id",
      allowReadableManifestMigration: true,
    });
    expect(migrated.readableManifest(UNIT_RUN_ID)).toBeNull();
    migrated.close();
  });
});

describe("plans persisted before a field existed stay readable", () => {
  it("decodes a plan with no grants as requesting no capability", () => {
    const seeded = seedPlannedRun();
    const digest = digestFor(seeded.store, UNIT_PLAN, null);
    seeded.store.recordPlanAndAwaitApproval(UNIT_RUN_ID, UNIT_PLAN, digest, null);
    seeded.store.close();

    // Rewrite the row the way an older Icarus wrote it: no `grants` (pre-ADR
    // 0026) and no `iterationCeiling` (pre-ADR 0024). Casting past the absent
    // fields is what makes `plan.grants.length` throw and
    // `Math.min(plan.iterationCeiling, n)` yield NaN.
    const legacy = {
      summary: UNIT_PLAN.summary,
      steps: [...UNIT_PLAN.steps],
      risks: [...UNIT_PLAN.risks],
      target: UNIT_PLAN.target,
      targets: [...UNIT_PLAN.targets],
      checkIds: [...UNIT_PLAN.checkIds],
    };
    const raw = new Database(seeded.databasePath);
    raw
      .prepare("UPDATE runs SET plan_json = ? WHERE id = ?")
      .run(JSON.stringify(legacy), UNIT_RUN_ID);
    raw.close();

    const reopened = new IcarusStore(seeded.databasePath, {
      now: () => "2026-07-19T12:05:00.000Z",
      id: () => "unit-legacy-id",
    });
    const run = reopened.getRun(UNIT_RUN_ID);
    expect(run.plan?.grants).toEqual([]);
    expect(run.plan?.iterationCeiling).toBe(0);
    // The normalized zero keeps the repair grant at a real number rather than
    // the NaN an absent field would produce.
    expect(reopened.remainingIterationBudget(UNIT_RUN_ID)).toBe(0);
    reopened.close();
  });

  it("preserves a pre-ADR 0026 repair allowance as the same iteration ceiling", () => {
    const seeded = seedPlannedRun();
    const digest = digestFor(seeded.store, UNIT_PLAN, null);
    seeded.store.recordPlanAndAwaitApproval(UNIT_RUN_ID, UNIT_PLAN, digest, null);
    seeded.store.close();

    // An operator approved two repair attempts under the old field name. The
    // allowance must survive as exactly two — neither widened to the new
    // default nor discarded.
    const legacy = {
      summary: UNIT_PLAN.summary,
      steps: [...UNIT_PLAN.steps],
      risks: [...UNIT_PLAN.risks],
      target: UNIT_PLAN.target,
      targets: [...UNIT_PLAN.targets],
      checkIds: [...UNIT_PLAN.checkIds],
      repairIterations: 2,
    };
    const raw = new Database(seeded.databasePath);
    raw
      .prepare("UPDATE runs SET plan_json = ? WHERE id = ?")
      .run(JSON.stringify(legacy), UNIT_RUN_ID);
    raw.close();

    const reopened = new IcarusStore(seeded.databasePath, {
      now: () => "2026-07-19T12:06:00.000Z",
      id: () => "unit-legacy-ceiling-id",
    });
    expect(reopened.getRun(UNIT_RUN_ID).plan?.iterationCeiling).toBe(2);
    expect(reopened.remainingIterationBudget(UNIT_RUN_ID)).toBe(2);
    reopened.close();
  });
});
