import { describe, expect, it } from "vitest";

import {
  bindHeadlessExecutionV1,
  HEADLESS_EXECUTION_BINDING_SCHEMA,
  reconstructHeadlessExecutionBindingV1,
  type HeadlessExecutionBindingAuthorityV1,
} from "../../packages/core/src/headless-binding.js";
import { IcarusError } from "../../packages/core/src/errors.js";
import { planApprovalDigest } from "../../packages/core/src/policy.js";
import type { ApprovalRecord, ProjectRecord, RunRecord } from "../../packages/core/src/types.js";
import {
  UNIT_BASE_COMMIT,
  UNIT_CEILING,
  UNIT_PLAN,
  UNIT_PROVIDER,
  UNIT_RUN_ID,
  UNIT_SANDBOX,
  unitContextDigest,
  unitContextManifest,
} from "../support/unit-fixtures.js";

const NOW = "2026-08-21T05:30:00.000Z";

function sourceProfile(): Record<string, unknown> {
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
  };
}

function fixture(): {
  readonly profile: Record<string, unknown>;
  readonly authority: HeadlessExecutionBindingAuthorityV1;
} {
  const context = unitContextManifest();
  const project: ProjectRecord = {
    id: "project-unit",
    name: "unit-project",
    repositoryId: "repository-unit",
    baseRef: "main",
    checks: [{ id: "unit", name: "Unit check", argv: ["node", "--test"] }],
    sandbox: UNIT_SANDBOX,
    ceiling: UNIT_CEILING,
    createdAt: NOW,
  };
  const contextSha256 = unitContextDigest(context);
  const planSha256 = planApprovalDigest({
    task: "Update the greeting",
    baseCommit: UNIT_BASE_COMMIT,
    contextSha256,
    targets: context.targets,
    provider: UNIT_PROVIDER,
    checks: project.checks,
    sandbox: project.sandbox,
    ceiling: project.ceiling,
    plan: UNIT_PLAN,
    readableManifest: null,
  });
  const run: RunRecord = {
    id: UNIT_RUN_ID,
    projectId: project.id,
    task: "Update the greeting",
    target: UNIT_PLAN.target,
    provider: UNIT_PROVIDER,
    state: "running",
    resumeState: null,
    baseCommit: UNIT_BASE_COMMIT,
    context,
    contextArtifactPath: "/private/context.json",
    contextSha256,
    plan: UNIT_PLAN,
    planSha256,
    patchSet: null,
    cachePath: null,
    worktreePath: null,
    baselineBase64: null,
    approvedBase64: null,
    diff: null,
    verification: null,
    usage: {
      toolCalls: 2,
      inputTokens: 100,
      outputTokens: 50,
      upperBoundTokens: 0,
      activeRuntimeMs: 25,
      estimatedCostUsd: 0,
      reservedCostUsd: 0,
    },
    lastError: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const approvals: readonly ApprovalRecord[] = [
    {
      runId: run.id,
      kind: "plan",
      digest: planSha256,
      actor: "unit-operator",
      decision: "approve",
      createdAt: NOW,
    },
  ];
  return {
    profile: sourceProfile(),
    authority: {
      run,
      project,
      approvals,
      readableManifest: null,
      providerProfiles: [
        {
          id: "unit-provider",
          kind: UNIT_PROVIDER.kind,
          model: UNIT_PROVIDER.model,
          baseUrl: UNIT_PROVIDER.baseUrl,
          inputUsdPerMillionTokens: UNIT_PROVIDER.inputUsdPerMillionTokens,
          outputUsdPerMillionTokens: UNIT_PROVIDER.outputUsdPerMillionTokens,
        },
      ],
    },
  };
}

describe("headless execution authority binding", () => {
  it("binds one H1 resolution to the exact approved persisted run identities", () => {
    const current = fixture();
    const binding = bindHeadlessExecutionV1(current.profile, current.authority);

    expect(binding).toMatchObject({
      schema: HEADLESS_EXECUTION_BINDING_SCHEMA,
      runId: UNIT_RUN_ID,
      projectId: "project-unit",
      baseCommit: UNIT_BASE_COMMIT,
      contextSha256: current.authority.run.contextSha256,
      planSha256: current.authority.run.planSha256,
      egressApproval: null,
      planApproval: {
        kind: "plan",
        digest: current.authority.run.planSha256,
        actor: "unit-operator",
        createdAt: NOW,
      },
    });
    expect(binding.profileDigestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(binding.resolutionDigestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(binding.bindingDigestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(binding.resolution.provider).toEqual(UNIT_PROVIDER);
    expect(binding.resolution.tools).toEqual([]);
  });

  it("is deterministic across source-profile object key order", () => {
    const current = fixture();
    const original = bindHeadlessExecutionV1(current.profile, current.authority);
    const reordered = {
      worker: current.profile.worker,
      output: current.profile.output,
      budgets: current.profile.budgets,
      toolIds: current.profile.toolIds,
      providerProfileId: current.profile.providerProfileId,
      profileId: current.profile.profileId,
      schemaVersion: current.profile.schemaVersion,
    };
    const second = bindHeadlessExecutionV1(reordered, current.authority);
    expect(second.profileDigestSha256).toBe(original.profileDigestSha256);
    expect(second.resolutionDigestSha256).toBe(original.resolutionDigestSha256);
    expect(second.bindingDigestSha256).toBe(original.bindingDigestSha256);
  });

  it("rejects malformed host run records with a typed fail-closed error on both entry points", () => {
    // Review regression guard (PR #57): the pristine-snapshot assertion must run
    // AFTER the host-shape validation inside the shared binding path, so a
    // malformed host record can never escape as an untyped TypeError.
    const current = fixture();
    for (const entry of [bindHeadlessExecutionV1, reconstructHeadlessExecutionBindingV1]) {
      for (const malformed of [null, undefined, []]) {
        let caught: unknown;
        try {
          entry(current.profile, {
            ...current.authority,
            run: malformed as unknown as (typeof current.authority)["run"],
          });
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(IcarusError);
        expect((caught as IcarusError).code).toBe("INVALID_HEADLESS_BINDING_HOST");
      }
    }
  });

  it("binds approval provenance without treating the binding digest as approval", () => {
    const current = fixture();
    const original = bindHeadlessExecutionV1(current.profile, current.authority);
    const approval = current.authority.approvals[0];
    if (approval === undefined) throw new Error("approval fixture missing");
    const changed = bindHeadlessExecutionV1(current.profile, {
      ...current.authority,
      approvals: [{ ...approval, actor: "second-operator" }],
    });
    expect(changed.planSha256).toBe(original.planSha256);
    expect(changed.bindingDigestSha256).not.toBe(original.bindingDigestSha256);
  });
});
