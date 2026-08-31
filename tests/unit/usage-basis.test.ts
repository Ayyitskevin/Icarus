import { rmSync } from "node:fs";
import { createRequire } from "node:module";

import { afterEach, describe, expect, test } from "vitest";
import { IcarusStore } from "../../packages/core/src/store.js";
import {
  createUnitStore,
  makeUnitIdGenerator,
  seedUnitProject,
  UNIT_PLAN,
  UNIT_PROVIDER,
  UNIT_RUN_ID,
} from "../support/unit-fixtures.js";

const Database = createRequire(new URL("../../packages/core/package.json", import.meta.url))(
  "better-sqlite3",
) as typeof import("better-sqlite3");

const cleanupRoots: string[] = [];
afterEach(() => {
  while (cleanupRoots.length > 0) {
    const root = cleanupRoots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

function startRun(store: IcarusStore): void {
  const { projectId } = seedUnitProject(store);
  store.createRun({
    id: UNIT_RUN_ID,
    projectId,
    task: "Record usage basis",
    targets: UNIT_PLAN.targets,
    provider: UNIT_PROVIDER,
  });
}

/**
 * Why this boundary exists.
 *
 * An operation whose provider reports no token counts is still charged its full
 * reservation, which is correct: an unmeasured operation must not be free. What was
 * wrong is that the charge was written into `input_tokens` with `output_tokens` set
 * to 0, so a run with unknown usage became indistinguishable from a run that
 * genuinely consumed a great deal of input and produced no output. The durable
 * RunUsage claimed observation it never made, and misfiled output work as input.
 *
 * Enforcement must not weaken -- the ceiling still counts every charged token -- but
 * the record must say which tokens were seen and which were merely charged.
 */
describe("run usage separates observed usage from charged upper bounds", () => {
  test("provider-reported usage lands in observed counters only", () => {
    const fixture = createUnitStore();
    cleanupRoots.push(fixture.root);
    startRun(fixture.store);

    const operation = fixture.store.beginOperation(UNIT_RUN_ID, "context.prepare", 0, 500, 1);
    fixture.store.finishOperation(operation, {
      outcome: "failed",
      activeRuntimeMs: 0,
      inputTokens: 120,
      outputTokens: 30,
      estimatedCostUsd: 0,
      detail: {},
    });

    const usage = fixture.store.getRun(UNIT_RUN_ID).usage;
    expect(usage.inputTokens).toBe(120);
    expect(usage.outputTokens).toBe(30);
    expect(usage.upperBoundTokens).toBe(0);
  });

  test("unreported usage is charged as an upper bound, never as observed input", () => {
    const fixture = createUnitStore();
    cleanupRoots.push(fixture.root);
    startRun(fixture.store);

    const operation = fixture.store.beginOperation(UNIT_RUN_ID, "context.prepare", 0, 500, 1);
    fixture.store.finishOperation(operation, {
      outcome: "failed",
      activeRuntimeMs: 0,
      inputTokens: null,
      outputTokens: null,
      estimatedCostUsd: 0,
      detail: {},
    });

    const usage = fixture.store.getRun(UNIT_RUN_ID).usage;
    // The reservation is charged in full -- an unmeasured operation is not free.
    expect(usage.upperBoundTokens).toBe(500);
    // ...but nothing was observed, so nothing is claimed as observed.
    expect(usage.inputTokens).toBe(0);
    expect(usage.outputTokens).toBe(0);
  });

  test("a provider that reports one counter and hides the other keeps what it reported", () => {
    // ProviderUsage lets the two counts be independently null, and real adapters
    // decode them independently. Treating "one is missing" as "nothing was observed"
    // discards evidence the provider actually stated -- the same loss at a different
    // boundary. The reported half belongs in its own column; only the unstated
    // remainder of the conservative charge is an upper bound.
    const fixture = createUnitStore();
    cleanupRoots.push(fixture.root);
    startRun(fixture.store);

    const operation = fixture.store.beginOperation(UNIT_RUN_ID, "context.prepare", 0, 500, 1);
    fixture.store.finishOperation(operation, {
      outcome: "failed",
      activeRuntimeMs: 0,
      inputTokens: 120,
      outputTokens: null,
      estimatedCostUsd: 0,
      detail: {},
    });

    const usage = fixture.store.getRun(UNIT_RUN_ID).usage;
    expect(usage.inputTokens).toBe(120);
    expect(usage.outputTokens).toBe(0);
    expect(usage.upperBoundTokens).toBe(380);
    // Enforcement is unchanged: the full reservation is still charged.
    expect(usage.inputTokens + usage.outputTokens + usage.upperBoundTokens).toBe(500);
  });

  test("a partially reported total above the reservation is still refused", () => {
    // The old code only compared a COMPLETE report against the reservation, so a
    // provider reporting 600 input tokens against a 500-token reservation passed
    // unchecked as long as it hid the output count.
    const fixture = createUnitStore();
    cleanupRoots.push(fixture.root);
    startRun(fixture.store);

    const operation = fixture.store.beginOperation(UNIT_RUN_ID, "context.prepare", 0, 500, 1);
    expect(() =>
      fixture.store.finishOperation(operation, {
        outcome: "failed",
        activeRuntimeMs: 0,
        inputTokens: 600,
        outputTokens: null,
        estimatedCostUsd: 0,
        detail: {},
      }),
    ).toThrow(/OPERATION_TOKENS_EXCEEDED|above its reservation/);
  });
});

/**
 * Why this boundary exists.
 *
 * The column was introduced with migration SQL but no way to run it: no store
 * option, no operator token. Because the constructor's exact-schema check compares
 * the stored `runs` DDL against the canonical one, a state root recorded before
 * ADR 0068 could not be opened at all -- and SQLite's ALTER TABLE ADD COLUMN
 * appends, so the canonical DDL must declare the column LAST or the migration
 * cannot satisfy the very check it runs into.
 */
describe("an existing state root migrates to the usage basis exactly once", () => {
  test("a pre-0068 database refuses to open, then migrates to the fresh shape", () => {
    const fixture = createUnitStore();
    cleanupRoots.push(fixture.root);
    startRun(fixture.store);
    const operation = fixture.store.beginOperation(UNIT_RUN_ID, "context.prepare", 0, 500, 1);
    fixture.store.finishOperation(operation, {
      outcome: "failed",
      activeRuntimeMs: 0,
      inputTokens: null,
      outputTokens: null,
      estimatedCostUsd: 0,
      detail: {},
    });
    fixture.store.close();

    const database = new Database(fixture.databasePath);
    database.prepare("ALTER TABLE runs DROP COLUMN upper_bound_tokens").run();
    database.close();

    let refused: unknown;
    try {
      new IcarusStore(fixture.databasePath, {
        now: () => "2026-07-19T12:00:00.000Z",
        id: makeUnitIdGenerator(),
      });
    } catch (error) {
      refused = error;
    }
    expect(refused).toMatchObject({ code: "DATABASE_MIGRATION_REQUIRED" });

    // The approved migration must land byte-identical to the fresh shape; the
    // constructor's exact-schema startup check is the proof.
    const migrated = new IcarusStore(fixture.databasePath, {
      now: () => "2026-07-19T12:00:00.000Z",
      id: makeUnitIdGenerator(),
      allowUsageBasisMigration: true,
    });
    // A column the database never had reads as zero. Under the pre-0068 basis that
    // run's charge is inside input_tokens, and this migration does not invent a
    // history by moving it.
    expect(migrated.getRun(UNIT_RUN_ID).usage.upperBoundTokens).toBe(0);
    migrated.close();
  });
});
