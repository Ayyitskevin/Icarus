import { describe, expect, it } from "vitest";

import {
  bindHeadlessExecutionV1,
  type HeadlessExecutionBindingAuthorityV1,
} from "../../packages/core/src/headless-binding.js";
import { IcarusError } from "../../packages/core/src/errors.js";
import { planApprovalDigest } from "../../packages/core/src/policy.js";
import { createProviderConfig } from "../../packages/core/src/provider.js";
import type {
  ApprovalRecord,
  PlanProposal,
  ProjectRecord,
  ProviderConfig,
  ReadableManifest,
  RunRecord,
} from "../../packages/core/src/types.js";
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

function code(action: () => unknown): string | null {
  try {
    action();
    return null;
  } catch (error) {
    return error instanceof IcarusError ? error.code : "UNKNOWN";
  }
}

function fixture(
  options: {
    readonly provider?: ProviderConfig;
    readonly plan?: PlanProposal;
    readonly readableManifest?: ReadableManifest | null;
    readonly toolIds?: readonly string[];
  } = {},
): {
  readonly profile: Record<string, unknown>;
  readonly authority: HeadlessExecutionBindingAuthorityV1;
} {
  const provider = options.provider ?? UNIT_PROVIDER;
  const plan = options.plan ?? UNIT_PLAN;
  const readableManifest = options.readableManifest ?? null;
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
    provider,
    checks: project.checks,
    sandbox: project.sandbox,
    ceiling: project.ceiling,
    plan,
    readableManifest,
  });
  const run: RunRecord = {
    id: UNIT_RUN_ID,
    projectId: project.id,
    task: "Update the greeting",
    target: plan.target,
    provider,
    state: "running",
    resumeState: null,
    baseCommit: UNIT_BASE_COMMIT,
    context,
    contextArtifactPath: "/private/context.json",
    contextSha256,
    plan,
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
    profile: {
      schemaVersion: 1,
      profileId: "unit-one-task",
      providerProfileId: "unit-provider",
      toolIds: options.toolIds ?? [],
      budgets: { ...UNIT_CEILING, iterationCeiling: plan.iterationCeiling },
      output: { format: "jsonl" },
      worker: {
        mode: "one_task",
        maxConcurrency: 1,
        childRuns: "deny",
        scheduledRuns: "deny",
      },
    },
    authority: {
      run,
      project,
      approvals,
      readableManifest,
      providerProfiles: [
        {
          id: "unit-provider",
          kind: provider.kind,
          model: provider.model,
          baseUrl: provider.baseUrl,
          inputUsdPerMillionTokens: provider.inputUsdPerMillionTokens,
          outputUsdPerMillionTokens: provider.outputUsdPerMillionTokens,
        },
      ],
    },
  };
}

describe("headless execution binding authority boundary", () => {
  it("refuses a type-compatible plan with no persisted approval", () => {
    const current = fixture();
    expect(
      code(() => bindHeadlessExecutionV1(current.profile, { ...current.authority, approvals: [] })),
    ).toBe("HEADLESS_BINDING_AUTHORITY_DENIED");
  });

  it("refuses mismatched, rejected, and duplicate plan approvals", () => {
    const current = fixture();
    const approval = current.authority.approvals[0];
    if (approval === undefined) throw new Error("approval fixture missing");
    for (const approvals of [
      [{ ...approval, digest: "f".repeat(64) }],
      [{ ...approval, decision: "reject" as const }],
      [approval, { ...approval }],
    ]) {
      expect(
        code(() => bindHeadlessExecutionV1(current.profile, { ...current.authority, approvals })),
      ).toBe("HEADLESS_BINDING_AUTHORITY_DENIED");
    }
  });

  it("refuses plan, project, or state drift after approval", () => {
    const current = fixture();
    const cases: readonly HeadlessExecutionBindingAuthorityV1[] = [
      {
        ...current.authority,
        run: { ...current.authority.run, task: "Different task" },
      },
      {
        ...current.authority,
        project: { ...current.authority.project, id: "other-project" },
      },
      {
        ...current.authority,
        run: { ...current.authority.run, state: "awaiting_approval" },
      },
      {
        ...current.authority,
        run: { ...current.authority.run, worktreePath: "/already-started" },
      },
    ];
    for (const authority of cases) {
      expect(code(() => bindHeadlessExecutionV1(current.profile, authority))).toBe(
        "HEADLESS_BINDING_AUTHORITY_DENIED",
      );
    }
  });

  it("refuses host provider remapping that differs from the plan-approved provider", () => {
    const current = fixture();
    const selected = current.authority.providerProfiles[0];
    if (selected === undefined) throw new Error("provider fixture missing");
    expect(
      code(() =>
        bindHeadlessExecutionV1(current.profile, {
          ...current.authority,
          providerProfiles: [{ ...selected, model: "unapproved-model" }],
        }),
      ),
    ).toBe("HEADLESS_BINDING_AUTHORITY_DENIED");
  });

  it("refuses a missing readable manifest that the plan approval digest covered", () => {
    const readableManifest: ReadableManifest = {
      baseCommit: UNIT_BASE_COMMIT,
      entries: [{ path: "src/greeting.txt", sha256: "d".repeat(64) }],
    };
    const plan: PlanProposal = {
      ...UNIT_PLAN,
      grants: [{ kind: "read.manifest", scope: ["src/greeting.txt"], maxCalls: 1 }],
    };
    const current = fixture({ plan, readableManifest, toolIds: ["read_file"] });
    expect(
      code(() =>
        bindHeadlessExecutionV1(current.profile, {
          ...current.authority,
          readableManifest: null,
        }),
      ),
    ).toBe("HEADLESS_BINDING_AUTHORITY_DENIED");
  });

  it("requires the exact egress approval for a remote plan-approved provider", () => {
    const remote = createProviderConfig({
      kind: "openai",
      model: "remote-model",
      baseUrl: "https://api.openai.com/v1",
      inputUsdPerMillionTokens: 1,
      outputUsdPerMillionTokens: 2,
    });
    const current = fixture({ provider: remote });
    expect(code(() => bindHeadlessExecutionV1(current.profile, current.authority))).toBe(
      "HEADLESS_BINDING_AUTHORITY_DENIED",
    );
    const approval = current.authority.approvals[0];
    if (approval === undefined) throw new Error("approval fixture missing");
    const binding = bindHeadlessExecutionV1(current.profile, {
      ...current.authority,
      approvals: [
        {
          runId: UNIT_RUN_ID,
          kind: "egress",
          digest: current.authority.run.contextSha256,
          actor: "unit-operator",
          decision: "approve",
          createdAt: NOW,
        },
        approval,
      ],
    });
    expect(binding.egressApproval?.digest).toBe(current.authority.run.contextSha256);
  });

  it("keeps H1 tool selection subordinate to the approved plan grants", () => {
    const current = fixture({ toolIds: ["run_checks"] });
    expect(code(() => bindHeadlessExecutionV1(current.profile, current.authority))).toBe(
      "HEADLESS_PROFILE_AUTHORITY_DENIED",
    );
  });
});
