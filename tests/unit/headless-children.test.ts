import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

import { IcarusStore } from "../../packages/core/src/store.js";

const Database = createRequire(new URL("../../packages/core/package.json", import.meta.url))(
  "better-sqlite3",
) as typeof import("better-sqlite3");

import {
  assertHeadlessChildEnvelopeV1,
  assertHeadlessChildPlanV1,
  deriveHeadlessChildProfileV1,
  headlessChildSpecDigestV1,
} from "../../packages/core/src/headless-children.js";
import {
  decodeHeadlessProfileV1,
  HEADLESS_CHILD_LIMIT,
  type HeadlessChildSpecV1,
  type HeadlessProfileV1,
  resolveHeadlessProfileV1,
} from "../../packages/core/src/headless-profile.js";
import {
  createHeadlessWorkerSettlementV1,
  headlessWorkerOutcomeForEvidenceV1,
} from "../../packages/core/src/headless-worker.js";
import type { HeadlessExecutionBindingV1 } from "../../packages/core/src/headless-binding.js";
import { createProviderConfig } from "../../packages/core/src/provider.js";
import type { EventRecord, PlanProposal, RunRecord } from "../../packages/core/src/types.js";
import {
  createUnitStore,
  makeUnitIdGenerator,
  UNIT_CEILING,
  UNIT_PLAN,
  UNIT_PROVIDER,
} from "../support/unit-fixtures.js";

const NOW = "2026-08-26T05:30:00.000Z";

function childSpec(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    childId: "c1",
    task: "Replace the greeting in the child workspace.",
    targets: ["src/greeting.txt"],
    toolIds: [],
    budgets: { ...UNIT_CEILING, iterationCeiling: 0 },
    ...overrides,
  };
}

function sourceProfile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    profileId: "unit-one-task",
    providerProfileId: "unit-provider",
    toolIds: [],
    budgets: { ...UNIT_CEILING, iterationCeiling: 0 },
    output: { format: "jsonl" },
    worker: {
      mode: "one_task",
      maxConcurrency: 1,
      childRuns: "deny",
      scheduledRuns: "deny",
    },
    ...overrides,
  };
}

function childAllowProfile(children: unknown): Record<string, unknown> {
  return sourceProfile({
    worker: {
      mode: "one_task",
      maxConcurrency: 1,
      childRuns: { maxDepth: 1, maxChildren: 2 },
      scheduledRuns: "deny",
    },
    children,
  });
}

const hostCatalog = [
  {
    id: "unit-provider",
    kind: UNIT_PROVIDER.kind,
    model: UNIT_PROVIDER.model,
    baseUrl: UNIT_PROVIDER.baseUrl,
    inputUsdPerMillionTokens: UNIT_PROVIDER.inputUsdPerMillionTokens,
    outputUsdPerMillionTokens: UNIT_PROVIDER.outputUsdPerMillionTokens,
  },
];

describe("headless child profile grammar", () => {
  it("decodes an explicit bounded allow with child specifications", () => {
    const profile = decodeHeadlessProfileV1(childAllowProfile([childSpec()]));
    expect(profile.worker.childRuns).toEqual({ maxDepth: 1, maxChildren: 2 });
    expect(profile.children).toHaveLength(1);
    expect(profile.children?.[0]).toMatchObject({
      childId: "c1",
      targets: ["src/greeting.txt"],
    });
  });

  it("keeps the closed deny default and digests empty children as absent", () => {
    const deniedProfile = decodeHeadlessProfileV1(sourceProfile());
    expect(deniedProfile.worker.childRuns).toBe("deny");
    expect(deniedProfile.children).toBeUndefined();
    const withEmpty = decodeHeadlessProfileV1(childAllowProfile([]));
    expect(withEmpty.children).toBeUndefined();
  });

  it("refuses widening or malformed child grammar", () => {
    expect(() =>
      decodeHeadlessProfileV1(childAllowProfile([childSpec({ schedule: "x" })])),
    ).toThrow(/missing or unknown keys/);
    expect(() =>
      decodeHeadlessProfileV1(childAllowProfile([childSpec({ childId: "C1" })])),
    ).toThrow(/canonical lowercase ASCII/);
    expect(() => decodeHeadlessProfileV1(childAllowProfile([childSpec(), childSpec()]))).toThrow(
      /duplicate child IDs/,
    );
    expect(() => decodeHeadlessProfileV1(childAllowProfile([childSpec({ targets: [] })]))).toThrow(
      /non-empty/,
    );
    expect(() => decodeHeadlessProfileV1(childAllowProfile([childSpec({ task: "" })]))).toThrow(
      /non-empty/,
    );
    expect(() =>
      decodeHeadlessProfileV1(
        childAllowProfile(
          Array.from({ length: HEADLESS_CHILD_LIMIT + 1 }, (_, index) =>
            childSpec({ childId: `c${index}` }),
          ),
        ),
      ),
    ).toThrow(/must not exceed/);
    expect(() =>
      decodeHeadlessProfileV1(
        sourceProfile({
          worker: {
            mode: "one_task",
            maxConcurrency: 1,
            childRuns: { maxDepth: 2, maxChildren: 1 },
            scheduledRuns: "deny",
          },
        }),
      ),
    ).toThrow(/maxDepth must equal 1/);
    expect(() =>
      decodeHeadlessProfileV1(
        sourceProfile({
          worker: {
            mode: "one_task",
            maxConcurrency: 1,
            childRuns: { maxDepth: 1, maxChildren: 0 },
            scheduledRuns: "deny",
          },
        }),
      ),
    ).toThrow(/maxChildren/);
  });

  it("refuses child selections outside the parent's authority at resolution", () => {
    const resolve = (profile: unknown) =>
      resolveHeadlessProfileV1(profile, {
        providerProfiles: hostCatalog,
        projectCeiling: UNIT_CEILING,
        approvedPlan: UNIT_PLAN,
      });
    expect(() => resolve(childAllowProfile([childSpec()]))).not.toThrow();
    expect(() =>
      resolve(
        sourceProfile({
          worker: {
            mode: "one_task",
            maxConcurrency: 1,
            childRuns: { maxDepth: 1, maxChildren: 1 },
            scheduledRuns: "deny",
          },
          children: [childSpec(), childSpec({ childId: "c2" })],
        }),
      ),
    ).toThrow(/exceeds the worker child-run ceiling/);
    expect(() => resolve(childAllowProfile([childSpec({ targets: ["src/other.txt"] })]))).toThrow(
      /within the approved plan targets/,
    );
    expect(() => resolve(childAllowProfile([childSpec({ toolIds: ["read_file"] })]))).toThrow(
      /must not exceed the parent tool set/,
    );
    expect(() =>
      resolve(
        childAllowProfile([
          childSpec({
            budgets: {
              ...UNIT_CEILING,
              maxToolCalls: UNIT_CEILING.maxToolCalls + 1,
              iterationCeiling: 0,
            },
          }),
        ]),
      ),
    ).toThrow(/exceeds the parent profile budget/);
    expect(() =>
      resolve(
        sourceProfile({
          worker: {
            mode: "one_task",
            maxConcurrency: 1,
            childRuns: "deny",
            scheduledRuns: "deny",
          },
          children: [childSpec()],
        }),
      ),
    ).toThrow(/requires worker.childRuns to allow child runs/);
  });

  it("refuses children under a remote provider", () => {
    const remote = createProviderConfig({
      kind: "openai",
      model: "unit-model",
      baseUrl: "https://api.openai.invalid/v1",
      inputUsdPerMillionTokens: 1,
      outputUsdPerMillionTokens: 2,
    });
    expect(remote.capabilities.locality).toBe("remote");
    expect(() =>
      resolveHeadlessProfileV1(childAllowProfile([childSpec()]), {
        providerProfiles: [
          {
            id: "unit-provider",
            kind: remote.kind,
            model: remote.model,
            baseUrl: remote.baseUrl,
            inputUsdPerMillionTokens: 1,
            outputUsdPerMillionTokens: 2,
          },
        ],
        projectCeiling: UNIT_CEILING,
        approvedPlan: UNIT_PLAN,
      }),
    ).toThrow(/requires a loopback provider/);
  });
});

describe("headless child derivation, envelope, and plan admission", () => {
  const profile = decodeHeadlessProfileV1(childAllowProfile([childSpec()]));
  const spec = profile.children?.[0] as HeadlessChildSpecV1;

  it("derives a child profile that only narrows the parent", () => {
    const derived = deriveHeadlessChildProfileV1(profile, spec);
    expect(derived).toMatchObject({
      profileId: "unit-one-task-c-c1",
      providerProfileId: profile.providerProfileId,
      toolIds: [],
      worker: { mode: "one_task", maxConcurrency: 1, childRuns: "deny", scheduledRuns: "deny" },
    });
    expect(derived.children).toBeUndefined();
    expect(headlessChildSpecDigestV1(spec)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("admits budgets within the remaining cumulative envelope only", () => {
    const usage = (overrides: Partial<RunRecord["usage"]> = {}): RunRecord["usage"] => ({
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      activeRuntimeMs: 0,
      estimatedCostUsd: 0,
      reservedCostUsd: 0,
      ...overrides,
    });
    expect(() => assertHeadlessChildEnvelopeV1(spec, profile.budgets, usage(), [])).not.toThrow();
    expect(() =>
      assertHeadlessChildEnvelopeV1(spec, profile.budgets, usage({ toolCalls: 1 }), [
        usage({ toolCalls: UNIT_CEILING.maxToolCalls - 1 }),
      ]),
    ).toThrow(/remaining envelope/);
    expect(() =>
      assertHeadlessChildEnvelopeV1(
        {
          ...spec,
          budgets: { ...spec.budgets, maxTotalTokens: UNIT_CEILING.maxTotalTokens },
        },
        profile.budgets,
        usage({ inputTokens: 1 }),
        [],
      ),
    ).toThrow(/remaining envelope/);
    expect(() =>
      assertHeadlessChildEnvelopeV1(
        {
          ...spec,
          budgets: { ...spec.budgets, maxCostUsd: UNIT_CEILING.maxCostUsd },
        },
        profile.budgets,
        usage({ estimatedCostUsd: 0.5 }),
        [usage({ estimatedCostUsd: 0.5 })],
      ),
    ).toThrow(/remaining envelope/);
  });

  it("admits only child plans inside the declared envelope", () => {
    const plan: PlanProposal = { ...UNIT_PLAN };
    expect(() => assertHeadlessChildPlanV1(spec, plan, UNIT_PLAN)).not.toThrow();
    expect(() =>
      assertHeadlessChildPlanV1(spec, { ...plan, targets: ["src/other.txt"] }, UNIT_PLAN),
    ).toThrow(/escapes its declared write set/);
    expect(() =>
      assertHeadlessChildPlanV1(spec, { ...plan, checkIds: ["other"] }, UNIT_PLAN),
    ).toThrow(/escapes the parent's approved checks/);
    expect(() =>
      assertHeadlessChildPlanV1(spec, { ...plan, iterationCeiling: 1 }, UNIT_PLAN),
    ).toThrow(/iteration ceiling/);
  });
});

describe("headless child settlement outcome mapping", () => {
  const RUN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const binding = {
    runId: RUN_ID,
    bindingDigestSha256: "b".repeat(64),
  } as unknown as HeadlessExecutionBindingV1;

  function event(sequence: number, type: string, payload: EventRecord["payload"]): EventRecord {
    return { sequence, runId: RUN_ID, type, payload, createdAt: NOW };
  }

  function childSettled(sequence: number, outcome: string, error: unknown = null): EventRecord {
    return event(sequence, "headless.child.settled", {
      schema: "icarus.headless.child-settlement.v1",
      runId: RUN_ID,
      childId: "c1",
      childRunId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      outcome,
      exitCode: outcome === "review_ready" ? 0 : 1,
      childBindingDigestSha256: "c".repeat(64),
      error,
    } as unknown as EventRecord["payload"]);
  }

  it("maps a failing declared child to a failed parent settlement", () => {
    expect(
      headlessWorkerOutcomeForEvidenceV1("awaiting_review", "passed", [
        childSettled(2, "failed", { code: "HEADLESS_CHILD_FAILED", message: "child failed" }),
      ]),
    ).toEqual({ outcome: "failed", exitCode: 1 });
    expect(
      headlessWorkerOutcomeForEvidenceV1("awaiting_review", "passed", [
        childSettled(2, "review_ready"),
        childSettled(3, "review_ready"),
      ]),
    ).toEqual({ outcome: "review_ready", exitCode: 0 });
    expect(
      headlessWorkerOutcomeForEvidenceV1("cancelled", null, [childSettled(2, "failed")]),
    ).toEqual({ outcome: "cancelled", exitCode: 130 });
  });

  it("derives the child failure as the settlement error", () => {
    const run = {
      id: RUN_ID,
      state: "awaiting_review",
      verification: {
        outcome: "passed",
        checks: [],
        changedPaths: [],
        diffSha256: "d".repeat(64),
        checkpointSha256: "c".repeat(64),
      },
      usage: {
        toolCalls: 1,
        inputTokens: 1,
        outputTokens: 1,
        activeRuntimeMs: 1,
        estimatedCostUsd: 0,
        reservedCostUsd: 0,
      },
    } as unknown as RunRecord;
    const settlement = createHeadlessWorkerSettlementV1({
      binding: binding,
      run,
      events: [childSettled(2, "failed", null)],
    });
    expect(settlement).toMatchObject({
      outcome: "failed",
      exitCode: 1,
      error: { code: "HEADLESS_CHILD_FAILED" },
    });
  });
});

describe("headless child lineage schema migration", () => {
  it("requires explicit approval to migrate a pre-lineage database", () => {
    const fixture = createUnitStore();
    const project = fixture.store.addRepository({
      name: "unit-repository",
      path: "/tmp/unit-repository",
      device: 1,
      inode: 2,
    });
    fixture.store.close();

    // Simulate the pre-ADR-0059 layout: runs without the lineage column and
    // the lineage-blind active-run index.
    const database = new Database(fixture.databasePath);
    database.prepare("DROP INDEX one_active_run_per_project").run();
    database
      .prepare(
        `CREATE UNIQUE INDEX one_active_run_per_project
         ON runs(project_id)
         WHERE state NOT IN ('completed', 'failed', 'cancelled', 'rolled_back')`,
      )
      .run();
    database.prepare("ALTER TABLE runs DROP COLUMN headless_parent_run_id").run();
    database.close();
    void project;

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
      allowHeadlessChildMigration: true,
    });
    migrated.close();
  });
});
