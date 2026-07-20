import { describe, expect, test } from "vitest";

import { workspaceRunPhase, presentRun } from "../../packages/api/src/present.js";
import type { ProjectRecord, RunRecord, RunState } from "../../packages/core/src/types.js";
import { UNIT_CEILING, UNIT_PROVIDER, UNIT_SANDBOX } from "../support/unit-fixtures.js";

const states: readonly [RunState, ReturnType<typeof workspaceRunPhase>][] = [
  ["preparing", "draft"],
  ["planned", "planned"],
  ["awaiting_egress_approval", "awaiting_approval"],
  ["awaiting_approval", "awaiting_approval"],
  ["awaiting_review", "awaiting_approval"],
  ["running", "running"],
  ["verifying", "running"],
  ["rolling_back", "running"],
  ["restoring", "running"],
  ["cancelling", "running"],
  ["completed", "completed"],
  ["failed", "failed"],
  ["cancelled", "cancelled"],
  ["rolled_back", "cancelled"],
];

describe("workspace run presentation", () => {
  test.each(states)("maps %s to the truthful workspace phase %s", (state, phase) => {
    expect(workspaceRunPhase(state)).toBe(phase);
  });

  test("allowlists run evidence and labels missing checks as not run", () => {
    const project: ProjectRecord = {
      id: "project-id",
      name: "project",
      repositoryId: "repository-id",
      baseRef: "main",
      checks: [{ id: "verify", name: "Verify", argv: ["node", "--test"] }],
      sandbox: UNIT_SANDBOX,
      ceiling: UNIT_CEILING,
      createdAt: "2026-07-20T12:00:00.000Z",
    };
    const run: RunRecord = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      projectId: project.id,
      task: "Review <script>alert(1)</script> safely",
      target: "src/greeting.txt",
      provider: UNIT_PROVIDER,
      state: "preparing",
      resumeState: null,
      baseCommit: "",
      context: {
        auditPolicyVersion: "tracked-tree-secret-audit-v1",
        baseCommit: "",
        target: "src/greeting.txt",
        repositoryMap: [],
        entries: [],
        totalBytes: 0,
      },
      contextArtifactPath: "/private/state/artifacts/context.json",
      contextSha256: "",
      plan: null,
      planSha256: null,
      edit: null,
      cachePath: "/private/state/cache.git",
      worktreePath: "/private/state/worktree",
      baselineBase64: "c2VjcmV0LWJhc2VsaW5l",
      approvedBase64: "c2VjcmV0LWFwcHJvdmVk",
      diff: null,
      verification: null,
      usage: {
        toolCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        activeRuntimeMs: 0,
        estimatedCostUsd: 0,
        reservedCostUsd: 0,
      },
      lastError: null,
      createdAt: "2026-07-20T12:00:00.000Z",
      updatedAt: "2026-07-20T12:00:00.000Z",
    };

    const view = presentRun(run, project, { run, approvals: [], events: [] });
    const serialized = JSON.stringify(view);

    expect(view).toMatchObject({
      phase: "draft",
      state: "preparing",
      gate: null,
      provider: { baseUrl: UNIT_PROVIDER.baseUrl, status: "configured" },
      action: null,
      verification: { outcome: "not_run" },
      checks: [{ outcome: "not_run" }],
      outputs: [],
      timestamps: {
        createdAt: "2026-07-20T12:00:00.000Z",
        updatedAt: "2026-07-20T12:00:00.000Z",
      },
    });
    expect(serialized).toContain("<script>alert(1)</script>");
    expect(serialized).not.toContain("contextArtifactPath");
    expect(serialized).not.toContain("cachePath");
    expect(serialized).not.toContain("worktreePath");
    expect(serialized).not.toContain("c2VjcmV0");
    expect(serialized).not.toContain("/private/state");

    const withEdit: RunRecord = {
      ...run,
      edit: {
        path: run.target,
        expectedPreimageSha256: "a".repeat(64),
        findText: "Hello",
        replaceText: "Hello, Icarus",
        rationale: "Apply one exact replacement.",
      },
    };
    const proposed = presentRun(withEdit, project, {
      run: withEdit,
      approvals: [],
      events: [
        {
          sequence: 1,
          runId: run.id,
          type: "edit.intent_recorded",
          payload: {},
          createdAt: run.createdAt,
        },
      ],
    });
    expect(proposed).toMatchObject({
      action: { status: "proposed", path: run.target, allowed: false },
    });
    const materialized = presentRun(withEdit, project, {
      run: withEdit,
      approvals: [],
      events: [
        {
          sequence: 1,
          runId: run.id,
          type: "edit.intent_recorded",
          payload: {},
          createdAt: run.createdAt,
        },
        {
          sequence: 2,
          runId: run.id,
          type: "edit.materialized",
          payload: {},
          createdAt: run.updatedAt,
        },
      ],
    });
    expect(materialized).toMatchObject({ action: { status: "materialized" } });
    const cancelledBeforeMaterialization = presentRun(withEdit, project, {
      run: withEdit,
      approvals: [],
      events: [
        {
          sequence: 1,
          runId: run.id,
          type: "edit.intent_recorded",
          payload: {},
          createdAt: run.createdAt,
        },
        {
          sequence: 2,
          runId: run.id,
          type: "cancellation.completed",
          payload: {},
          createdAt: run.updatedAt,
        },
      ],
    });
    expect(cancelledBeforeMaterialization).toMatchObject({
      action: { status: "cancelled" },
    });
    const revertedAfterMaterialization = presentRun(withEdit, project, {
      run: withEdit,
      approvals: [],
      events: [
        {
          sequence: 1,
          runId: run.id,
          type: "edit.materialized",
          payload: {},
          createdAt: run.createdAt,
        },
        {
          sequence: 2,
          runId: run.id,
          type: "cancellation.completed",
          payload: {},
          createdAt: run.updatedAt,
        },
      ],
    });
    expect(revertedAfterMaterialization).toMatchObject({
      action: { status: "reverted" },
    });
  });
});
