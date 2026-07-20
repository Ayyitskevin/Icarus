import { describe, expect, test } from "vitest";

import {
  presentRun,
  presentRunEventHistoryPage,
  presentRunEventPage,
  workspaceRunPhase,
} from "../../packages/api/src/present.js";
import type {
  ProjectRecord,
  RunHistory,
  RunPresentationSnapshot,
  RunRecord,
  RunState,
} from "../../packages/core/src/types.js";
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

const actionEventTypes = new Set([
  "edit.materialized",
  "restore.completed",
  "rollback.completed",
  "cancellation.completed",
  "review.accepted",
]);

function presentationSnapshot(history: RunHistory): RunPresentationSnapshot {
  const events = history.events.map((event) => ({
    sequence: event.sequence,
    runId: event.runId,
    type: event.type,
    createdAt: event.createdAt,
  }));
  const presentationEvents = events.slice(-200);
  return {
    run: history.run,
    approvals: history.approvals,
    events: presentationEvents,
    eventCursor: events.at(-1)?.sequence ?? 0,
    eventCount: events.length,
    actionEvents: presentationEvents.filter((event) => actionEventTypes.has(event.type)).slice(-2),
  };
}

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

    const view = presentRun(project, presentationSnapshot({ run, approvals: [], events: [] }));
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
    const proposed = presentRun(
      project,
      presentationSnapshot({
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
      }),
    );
    expect(proposed).toMatchObject({
      action: { status: "proposed", path: run.target, allowed: false },
    });
    const materialized = presentRun(
      project,
      presentationSnapshot({
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
      }),
    );
    expect(materialized).toMatchObject({ action: { status: "materialized" } });
    const cancelledBeforeMaterialization = presentRun(
      project,
      presentationSnapshot({
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
      }),
    );
    expect(cancelledBeforeMaterialization).toMatchObject({
      action: { status: "cancelled" },
    });
    const revertedAfterMaterialization = presentRun(
      project,
      presentationSnapshot({
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
      }),
    );
    expect(revertedAfterMaterialization).toMatchObject({
      action: { status: "reverted" },
    });

    const truncatedActionEvents = Array.from({ length: 206 }, (_, index) => ({
      sequence: index + 1,
      runId: run.id,
      type:
        index === 1
          ? "edit.materialized"
          : index === 205
            ? "cancellation.completed"
            : "operation.finished",
      payload: {},
      createdAt: run.updatedAt,
    }));
    const unknownAfterTruncatedMaterialization = presentRun(
      project,
      presentationSnapshot({ run: withEdit, approvals: [], events: truncatedActionEvents }),
    );
    expect(unknownAfterTruncatedMaterialization).toMatchObject({
      action: { status: "unknown" },
    });
    expect(unknownAfterTruncatedMaterialization.warnings).toContain(
      "Action status predates the bounded browser timeline; use the CLI for complete history.",
    );

    const events = Array.from({ length: 205 }, (_, index) => ({
      sequence: index + 1,
      runId: run.id,
      type: index === 0 ? "context.assembled" : "operation.started",
      payload: { privatePath: "/private/state/sentinel", diff: "+private diff" },
      createdAt: run.createdAt,
    }));
    const capped = presentRun(project, presentationSnapshot({ run, approvals: [], events }));
    expect(capped).toMatchObject({
      eventCursor: 205,
      timelineTotal: 205,
      timelineTruncated: true,
    });
    expect(capped.timeline).toHaveLength(200);
    expect((capped.timeline as Array<{ sequence: number }>)[0]?.sequence).toBe(6);

    const eventPage = presentRunEventPage({
      runId: run.id,
      revision: 205,
      nextAfter: 2,
      hasMore: true,
      events: events.slice(0, 2),
    });
    expect(eventPage).toMatchObject({
      runId: run.id,
      revision: 205,
      nextAfter: 2,
      hasMore: true,
    });
    expect((eventPage.events as Array<Record<string, unknown>>)[0]).toEqual({
      sequence: 1,
      type: "context.assembled",
      label: "context assembled",
      evidenceSection: "context",
      timestamp: run.createdAt,
    });
    const serializedEventPage = JSON.stringify(eventPage);
    expect(serializedEventPage).not.toContain("payload");
    expect(serializedEventPage).not.toContain("createdAt");
    expect(serializedEventPage).not.toContain("/private/state/sentinel");
    expect(serializedEventPage).not.toContain("+private diff");

    const historyPage = presentRunEventHistoryPage({
      runId: run.id,
      before: 3,
      snapshot: 205,
      nextBefore: 1,
      hasMore: false,
      events: events.slice(0, 2),
    });
    expect(historyPage).toEqual({
      runId: run.id,
      before: 3,
      snapshot: 205,
      nextBefore: 1,
      hasMore: false,
      events: [
        {
          sequence: 1,
          type: "context.assembled",
          label: "context assembled",
          evidenceSection: "context",
          timestamp: run.createdAt,
        },
        {
          sequence: 2,
          type: "operation.started",
          label: "operation started",
          evidenceSection: "usage",
          timestamp: run.createdAt,
        },
      ],
    });
    const serializedHistoryPage = JSON.stringify(historyPage);
    expect(serializedHistoryPage).not.toContain("payload");
    expect(serializedHistoryPage).not.toContain("createdAt");
    expect(serializedHistoryPage).not.toContain("/private/state/sentinel");
    expect(serializedHistoryPage).not.toContain("+private diff");
  });
});
