import { rmSync } from "node:fs";
import { afterEach, describe, expect, test } from "vitest";
import { IcarusStore } from "../../packages/core/src/store.js";
import {
  createUnitStore,
  seedUnitProject,
  UNIT_PLAN,
  UNIT_PROVIDER,
  UNIT_RUN_ID,
} from "../support/unit-fixtures.js";

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
});
