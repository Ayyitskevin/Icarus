import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  LANDING_DERIVATIVE_GITHUB_EVENTS,
  LANDING_DERIVATIVE_MAY_TRIGGER,
  LANDING_DIRECT_ICARUS_EFFECTS,
  LANDING_EFFECT_WARNING,
  presentRun,
  presentRunEventHistoryPage,
  presentRunEventPage,
  presentRunVerificationAttempts,
  presentTimelineEvent,
  presentWorkspaceRunPage,
  WORKSPACE_DIFF_DISPLAY_MAX_BYTES,
  workspaceRunPhase,
} from "../../packages/api/src/present.js";
import type {
  FileEdit,
  PatchSet,
  ProjectRecord,
  RunHistory,
  RunPresentationSnapshot,
  RunRecord,
  RunState,
  RunVerificationAttemptsSnapshot,
  WorkspaceRunPage,
} from "../../packages/core/src/types.js";
import { CONTEXT_AUDIT_POLICY_VERSION } from "../../packages/core/src/types.js";
import { ApprovalProvenance } from "../../packages/workspace/src/App.js";
import { UNIT_CEILING, UNIT_PROVIDER, UNIT_SANDBOX } from "../support/unit-fixtures.js";

const workspaceRequire = createRequire(
  new URL("../../packages/workspace/package.json", import.meta.url),
);
const { createElement } = workspaceRequire("react") as {
  createElement(type: unknown, props: unknown): unknown;
};
const { renderToStaticMarkup } = workspaceRequire("react-dom/server") as {
  renderToStaticMarkup(element: unknown): string;
};

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
  const approvals = history.approvals.slice(-12);
  return {
    run: history.run,
    approvals,
    approvalCoverage: {
      limit: 12,
      loaded: approvals.length,
      earlierApprovalsExcluded: history.approvals.length > approvals.length,
    },
    events: presentationEvents,
    eventCursor: events.at(-1)?.sequence ?? 0,
    eventCount: events.length,
    landing: null,
    landingRevision: 0,
    actionEvents: presentationEvents.filter((event) => actionEventTypes.has(event.type)).slice(-2),
  };
}

describe("workspace run presentation", () => {
  test("renders hostile approval actors only as inert text", () => {
    const actor = '<img data-approval-injection="true"> Recorded digest:';
    const markup = renderToStaticMarkup(
      createElement(ApprovalProvenance, {
        run: {
          approvalCoverage: { limit: 12, loaded: 1, earlierApprovalsExcluded: false },
          approvals: [
            {
              kind: "plan",
              digest: "f".repeat(64),
              actor,
              decision: "approve",
              createdAt: "2026-07-22T12:00:00.000Z",
            },
          ],
        },
      }),
    );

    expect(markup).toContain("&lt;img");
    expect(markup).not.toContain("<img");
    expect(markup).not.toMatch(/<(?:a|button|form|input|textarea)\b/u);
    expect(markup).toContain("Recorded digest:");
  });

  test.each(states)("maps %s to the truthful workspace phase %s", (state, phase) => {
    expect(workspaceRunPhase(state)).toBe(phase);
  });

  test("allowlists fixed workspace run summary fields and derives phase", () => {
    const page: WorkspaceRunPage = {
      before: 43,
      snapshot: 42,
      nextBefore: 31,
      hasMore: true,
      runs: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          task: "Review <script>alert(1)</script> as text",
          target: "src/<private>.txt",
          state: "awaiting_review",
          createdAt: "2026-07-20T12:00:00.000Z",
          updatedAt: "2026-07-20T12:01:00.000Z",
        },
      ],
    };

    const view = presentWorkspaceRunPage(page);

    expect(Object.keys(view).sort()).toEqual(
      ["before", "snapshot", "nextBefore", "hasMore", "runs"].sort(),
    );
    expect(view).toEqual({
      before: 43,
      snapshot: 42,
      nextBefore: 31,
      hasMore: true,
      runs: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          task: "Review <script>alert(1)</script> as text",
          target: "src/<private>.txt",
          state: "awaiting_review",
          phase: "awaiting_approval",
          createdAt: "2026-07-20T12:00:00.000Z",
          updatedAt: "2026-07-20T12:01:00.000Z",
        },
      ],
    });
    expect(Object.keys((view.runs as Array<Record<string, unknown>>)[0] ?? {}).sort()).toEqual(
      ["id", "projectId", "task", "target", "state", "phase", "createdAt", "updatedAt"].sort(),
    );
  });

  test("reconstructs the exact verification-attempt allowlist without private evidence", () => {
    const runId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const checkpointSha256 = "c".repeat(64);
    const diffSha256 = "d".repeat(64);
    const privateSentinel = "<script>private-payload-navigation-sentinel</script>";
    const snapshot = {
      runId,
      snapshot: 8,
      coverage: {
        firstSequence: 1,
        lastSequence: 8,
        eventCount: 8,
        eventLimit: 200,
        earlierEventsExcluded: false,
        privatePath: privateSentinel,
      },
      attemptLimit: 8,
      attemptAnchorsTruncatedWithinCoverage: false,
      checkpoint: {
        status: "saved",
        sha256: checkpointSha256,
        createdAt: "2026-07-22T12:00:03.000Z",
        baselineBase64: privateSentinel,
        approvedBase64: privateSentinel,
        saveEvent: {
          status: "observed_in_coverage",
          sequence: 3,
          timestamp: "2026-07-22T12:00:03.000Z",
          payloadJson: privateSentinel,
        },
      },
      attempts: [
        {
          identity: "verification-anchor-4",
          anchorSequence: 4,
          startSequence: 2,
          startedAt: "2026-07-22T12:00:02.000Z",
          startProvenance: "observed_initial_edit",
          status: "passed",
          endSequence: 4,
          endedAt: "2026-07-22T12:00:04.000Z",
          diffSha256,
          checkpointSha256,
          checkpointProvenance: "recorded_digest_match",
          laterAttemptObservedWithinCoverage: true,
          diff: privateSentinel,
          checks: [{ argv: [privateSentinel], stdout: privateSentinel }],
          actor: privateSentinel,
        },
        {
          identity: "verification-anchor-8",
          anchorSequence: 8,
          startSequence: null,
          startedAt: null,
          startProvenance: "outside_coverage",
          status: "incomplete_at_snapshot",
          endSequence: null,
          endedAt: null,
          diffSha256: null,
          checkpointSha256,
          checkpointProvenance: "run_checkpoint_available",
          laterAttemptObservedWithinCoverage: false,
          error: privateSentinel,
          navigateTo: privateSentinel,
        },
      ],
      payloadJson: privateSentinel,
      rawPayload: privateSentinel,
    } as unknown as RunVerificationAttemptsSnapshot;

    const view = presentRunVerificationAttempts(snapshot);

    expect(Object.keys(view).sort()).toEqual(
      [
        "runId",
        "snapshot",
        "coverage",
        "attemptLimit",
        "attemptAnchorsTruncatedWithinCoverage",
        "checkpoint",
        "attempts",
      ].sort(),
    );
    expect(Object.keys(view.coverage as Record<string, unknown>).sort()).toEqual(
      ["firstSequence", "lastSequence", "eventCount", "eventLimit", "earlierEventsExcluded"].sort(),
    );
    const checkpoint = view.checkpoint as Record<string, unknown>;
    expect(Object.keys(checkpoint).sort()).toEqual(
      ["status", "sha256", "createdAt", "saveEvent"].sort(),
    );
    expect(Object.keys(checkpoint.saveEvent as Record<string, unknown>).sort()).toEqual(
      ["status", "sequence", "timestamp"].sort(),
    );
    const attempts = view.attempts as readonly Record<string, unknown>[];
    expect(attempts).toHaveLength(2);
    for (const attempt of attempts) {
      expect(Object.keys(attempt).sort()).toEqual(
        [
          "identity",
          "anchorSequence",
          "startSequence",
          "startedAt",
          "startProvenance",
          "status",
          "endSequence",
          "endedAt",
          "diffSha256",
          "checkpointSha256",
          "checkpointProvenance",
          "laterAttemptObservedWithinCoverage",
        ].sort(),
      );
    }
    expect(view).toEqual({
      runId,
      snapshot: 8,
      coverage: {
        firstSequence: 1,
        lastSequence: 8,
        eventCount: 8,
        eventLimit: 200,
        earlierEventsExcluded: false,
      },
      attemptLimit: 8,
      attemptAnchorsTruncatedWithinCoverage: false,
      checkpoint: {
        status: "saved",
        sha256: checkpointSha256,
        createdAt: "2026-07-22T12:00:03.000Z",
        saveEvent: {
          status: "observed_in_coverage",
          sequence: 3,
          timestamp: "2026-07-22T12:00:03.000Z",
        },
      },
      attempts: [
        {
          identity: "verification-anchor-4",
          anchorSequence: 4,
          startSequence: 2,
          startedAt: "2026-07-22T12:00:02.000Z",
          startProvenance: "observed_initial_edit",
          status: "passed",
          endSequence: 4,
          endedAt: "2026-07-22T12:00:04.000Z",
          diffSha256,
          checkpointSha256,
          checkpointProvenance: "recorded_digest_match",
          laterAttemptObservedWithinCoverage: true,
        },
        {
          identity: "verification-anchor-8",
          anchorSequence: 8,
          startSequence: null,
          startedAt: null,
          startProvenance: "outside_coverage",
          status: "incomplete_at_snapshot",
          endSequence: null,
          endedAt: null,
          diffSha256: null,
          checkpointSha256,
          checkpointProvenance: "run_checkpoint_available",
          laterAttemptObservedWithinCoverage: false,
        },
      ],
    });
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain(privateSentinel);
    expect(serialized).not.toMatch(
      /payloadJson|rawPayload|baselineBase64|approvedBase64|"diff":|checks|argv|stdout|actor|error|navigateTo/,
    );

    const notObserved = presentRunVerificationAttempts({
      ...snapshot,
      checkpoint: {
        status: "saved",
        sha256: checkpointSha256,
        createdAt: "2026-07-22T12:00:03.000Z",
        saveEvent: { status: "not_observed_in_coverage", payloadJson: privateSentinel },
        baselineBase64: privateSentinel,
      },
    } as unknown as RunVerificationAttemptsSnapshot);
    expect(notObserved.checkpoint).toEqual({
      status: "saved",
      sha256: checkpointSha256,
      createdAt: "2026-07-22T12:00:03.000Z",
      saveEvent: { status: "not_observed_in_coverage" },
    });

    const notSaved = presentRunVerificationAttempts({
      ...snapshot,
      checkpoint: { status: "not_saved", baselineBase64: privateSentinel },
      attempts: [],
    } as unknown as RunVerificationAttemptsSnapshot);
    expect(notSaved.checkpoint).toEqual({ status: "not_saved" });
    expect(JSON.stringify([notObserved, notSaved])).not.toContain(privateSentinel);
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
        auditPolicyVersion: CONTEXT_AUDIT_POLICY_VERSION,
        baseCommit: "",
        targets: ["src/greeting.txt"],
        repositoryMap: [],
        entries: [],
        totalBytes: 0,
      },
      contextArtifactPath: "/private/state/artifacts/context.json",
      contextSha256: "",
      plan: null,
      planSha256: null,
      patchSet: null,
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
      diff: null,
      diffReview: {
        status: "not_produced",
        path: null,
        sha256: null,
        byteCount: 0,
        lineCount: 0,
        addedLines: 0,
        deletedLines: 0,
        hunkCount: 0,
        browserByteLimit: 262_144,
        digestProvenance: "not_available",
      },
      approvalCoverage: {
        limit: 12,
        loaded: 0,
        earlierApprovalsExcluded: false,
      },
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
    const privateLandingSentinel = "LANDING_CREDENTIAL_ENV_MUST_NOT_LEAK";
    const pullRequestTitle = "Exact <script>alert('title')</script>";
    const pullRequestBody =
      "Approved prefix\n\nEvidence line <img src=x onerror=alert(1)>\n\n<!-- marker -->";
    const landingPresentation = presentRun(project, {
      ...presentationSnapshot({ run, approvals: [], events: [] }),
      landingRevision: 7,
      landing: {
        landingId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        state: "awaiting_approval",
        resumeState: null,
        version: 1,
        landingSha256: "d".repeat(64),
        candidateCommitSha1: "c".repeat(40),
        pullRequestTitle,
        pullRequestBody,
        receipt: {
          version: 1,
          landingId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          runId: "11111111-1111-4111-8111-111111111111",
          projectId: "55555555-5555-4555-8555-555555555555",
          provider: "github",
          owner: "icarus-owner",
          repository: "icarus-repository",
          baseRef: "refs/heads/main",
          baseCommitSha1: "1".repeat(40),
          headRef: "refs/heads/icarus/11111111-1111-4111-8111-111111111111",
          candidateTreeSha1: "7".repeat(40),
          candidateCommitSha1: "c".repeat(40),
          pullRequestNumber: 701,
          reconstructedPullRequestUrl: "https://github.com/icarus-owner/icarus-repository/pull/701",
          draft: true,
          landingSha256: "d".repeat(64),
          profileSha256: "0".repeat(64),
          planSha256: "2".repeat(64),
          diffSha256: "3".repeat(64),
          checkpointSha256: "4".repeat(64),
          verificationSha256: "5".repeat(64),
          reviewDecisionSha256: "6".repeat(64),
          changedPathsSha256: "8".repeat(64),
          localRefOutcome: "created",
          remoteObjectOutcome: "created_or_exact",
          remoteRefOutcome: "reconciled",
          pullRequestOutcome: "created",
          completedAt: "2026-08-02T12:03:00.000Z",
          credentialValue: privateLandingSentinel,
        },
        derivativeEffects: {
          version: 1,
          disposition: "inert-repository",
          evidenceSha256: "e".repeat(64),
        },
        decision: {
          actor: "operator",
          decision: "approve",
          createdAt: "2026-08-02T12:01:00.000Z",
        },
        errorCode: null,
        updatedAt: "2026-08-02T12:02:00.000Z",
        credentialEnv: privateLandingSentinel,
      },
    } as unknown as RunPresentationSnapshot);
    expect(landingPresentation.landingRevision).toBe(7);
    expect(landingPresentation.landing).toEqual({
      landingId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      state: "awaiting_approval",
      resumeState: null,
      version: 1,
      landingSha256: "d".repeat(64),
      candidateCommitSha1: "c".repeat(40),
      pullRequestTitle,
      pullRequestBody,
      receipt: {
        version: 1,
        landingId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        runId: "11111111-1111-4111-8111-111111111111",
        projectId: "55555555-5555-4555-8555-555555555555",
        provider: "github",
        owner: "icarus-owner",
        repository: "icarus-repository",
        baseRef: "refs/heads/main",
        baseCommitSha1: "1".repeat(40),
        headRef: "refs/heads/icarus/11111111-1111-4111-8111-111111111111",
        candidateTreeSha1: "7".repeat(40),
        candidateCommitSha1: "c".repeat(40),
        pullRequestNumber: 701,
        reconstructedPullRequestUrl: "https://github.com/icarus-owner/icarus-repository/pull/701",
        draft: true,
        landingSha256: "d".repeat(64),
        profileSha256: "0".repeat(64),
        planSha256: "2".repeat(64),
        diffSha256: "3".repeat(64),
        checkpointSha256: "4".repeat(64),
        verificationSha256: "5".repeat(64),
        reviewDecisionSha256: "6".repeat(64),
        changedPathsSha256: "8".repeat(64),
        localRefOutcome: "created",
        remoteObjectOutcome: "created_or_exact",
        remoteRefOutcome: "reconciled",
        pullRequestOutcome: "created",
        completedAt: "2026-08-02T12:03:00.000Z",
      },
      decision: {
        actor: "operator",
        decision: "approve",
        createdAt: "2026-08-02T12:01:00.000Z",
      },
      errorCode: null,
      updatedAt: "2026-08-02T12:02:00.000Z",
      directIcarusEffects: LANDING_DIRECT_ICARUS_EFFECTS,
      derivativeEffectDisclosure: {
        version: 1,
        githubEvents: LANDING_DERIVATIVE_GITHUB_EVENTS,
        mayTrigger: LANDING_DERIVATIVE_MAY_TRIGGER,
        disposition: "inert-repository",
        evidenceSha256: "e".repeat(64),
      },
      effectWarning: LANDING_EFFECT_WARNING,
    });
    expect(Object.keys(landingPresentation.landing as Record<string, unknown>).sort()).toEqual(
      [
        "candidateCommitSha1",
        "decision",
        "derivativeEffectDisclosure",
        "directIcarusEffects",
        "effectWarning",
        "errorCode",
        "landingId",
        "landingSha256",
        "pullRequestBody",
        "pullRequestTitle",
        "receipt",
        "resumeState",
        "state",
        "updatedAt",
        "version",
      ].sort(),
    );
    expect(JSON.stringify(landingPresentation)).not.toContain(privateLandingSentinel);
    expect(JSON.stringify(landingPresentation)).not.toContain("credentialEnv");

    expect(serialized).not.toContain("/private/state");

    const greetingEdit: FileEdit = {
      op: "modify",
      path: run.target,
      expectedPreimageSha256: "a".repeat(64),
      replacements: [{ findText: "Hello", replaceText: "Hello, Icarus" }],
      rationale: "Apply one exact replacement.",
    };
    const patchSet: PatchSet = {
      summary: "Replace the greeting and record the change.",
      edits: [
        greetingEdit,
        {
          op: "create",
          path: "src/notes.md",
          content: "# Notes\n",
          rationale: "Record the change alongside the greeting.",
        },
      ],
    };
    const withPatchSet: RunRecord = { ...run, patchSet };
    const proposed = presentRun(
      project,
      presentationSnapshot({
        run: withPatchSet,
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
      action: {
        status: "proposed",
        kind: "patch_set",
        summary: "Patch set across 2 approved paths",
        path: run.target,
        files: [run.target, "src/notes.md"],
        operations: [
          { path: run.target, op: "modify" },
          { path: "src/notes.md", op: "create" },
        ],
        rationale: patchSet.summary,
        allowed: false,
      },
    });
    expect(Object.keys(proposed.action as Record<string, unknown>).sort()).toEqual(
      ["status", "kind", "summary", "path", "files", "operations", "rationale", "allowed"].sort(),
    );
    const singlePathAction = presentRun(
      project,
      presentationSnapshot({
        run: { ...run, patchSet: { summary: patchSet.summary, edits: [greetingEdit] } },
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
    ).action as Record<string, unknown>;
    expect(singlePathAction).toMatchObject({
      status: "proposed",
      kind: "patch_set",
      summary: "Patch set across 1 approved path",
      path: run.target,
      files: [run.target],
      operations: [{ path: run.target, op: "modify" }],
      allowed: false,
    });
    const materialized = presentRun(
      project,
      presentationSnapshot({
        run: withPatchSet,
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
        run: withPatchSet,
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
        run: withPatchSet,
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
      presentationSnapshot({ run: withPatchSet, approvals: [], events: truncatedActionEvents }),
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

  test("presents only bounded, rehashed persisted diff evidence", () => {
    const project: ProjectRecord = {
      id: "project-id",
      name: "project",
      repositoryId: "repository-id",
      baseRef: "main",
      checks: [{ id: "verify", name: "Verify", argv: ["node", "--test"] }],
      sandbox: UNIT_SANDBOX,
      ceiling: UNIT_CEILING,
      createdAt: "2026-07-22T12:00:00.000Z",
    };
    const diff = [
      "diff --git a/src/greeting.txt b/src/greeting.txt",
      "index ce01362..63c704a 100644",
      "--- a/src/greeting.txt",
      "+++ b/src/greeting.txt",
      "@@ -1 +1,2 @@",
      "-Hello",
      "+Hello, Icarus 🪽",
      "+<script>diff text stays text</script>",
      "",
    ].join("\n");
    const digest = createHash("sha256").update(diff, "utf8").digest("hex");
    const verification = {
      outcome: "passed",
      checks: [],
      changedPaths: ["src/greeting.txt"],
      diffSha256: digest,
      checkpointSha256: "c".repeat(64),
    } as const;
    const run: RunRecord = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      projectId: project.id,
      task: "Review a persisted diff",
      target: "src/greeting.txt",
      provider: UNIT_PROVIDER,
      state: "awaiting_review",
      resumeState: null,
      baseCommit: "a".repeat(40),
      context: {
        auditPolicyVersion: CONTEXT_AUDIT_POLICY_VERSION,
        baseCommit: "a".repeat(40),
        targets: ["src/greeting.txt"],
        repositoryMap: ["src/greeting.txt"],
        entries: [],
        totalBytes: 0,
      },
      contextArtifactPath: "/private/context.json",
      contextSha256: "b".repeat(64),
      plan: null,
      planSha256: null,
      patchSet: null,
      cachePath: "/private/cache.git",
      worktreePath: "/private/worktree",
      baselineBase64: "SGVsbG8=",
      approvedBase64: "SGVsbG8sIEljYXJ1cw==",
      diff,
      verification,
      usage: {
        toolCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        activeRuntimeMs: 0,
        estimatedCostUsd: 0,
        reservedCostUsd: 0,
      },
      lastError: null,
      createdAt: "2026-07-22T12:00:00.000Z",
      updatedAt: "2026-07-22T12:01:00.000Z",
    };

    const available = presentRun(project, presentationSnapshot({ run, approvals: [], events: [] }));
    expect(Buffer.byteLength(diff, "utf8")).toBeGreaterThan(diff.length);
    expect(available.context).toMatchObject({
      target: run.target,
      targets: ["src/greeting.txt"],
      baseCommit: "a".repeat(40),
      sha256: "b".repeat(64),
    });
    expect(available.diff).toBe(diff);
    expect(available.diffReview).toEqual({
      status: "available",
      path: "src/greeting.txt",
      paths: ["src/greeting.txt"],
      sha256: digest,
      byteCount: Buffer.byteLength(diff, "utf8"),
      lineCount: 8,
      addedLines: 2,
      deletedLines: 1,
      hunkCount: 1,
      browserByteLimit: 262_144,
      digestProvenance: "displayed_text_rehash_match",
    });
    expect(Object.keys(available.diffReview as Record<string, unknown>).sort()).toEqual(
      [
        "status",
        "path",
        "paths",
        "sha256",
        "byteCount",
        "lineCount",
        "addedLines",
        "deletedLines",
        "hunkCount",
        "browserByteLimit",
        "digestProvenance",
      ].sort(),
    );

    const exactBoundaryPrefix = [
      "diff --git a/src/greeting.txt b/src/greeting.txt",
      "index ce01362..63c704a 100644",
      "--- a/src/greeting.txt",
      "+++ b/src/greeting.txt",
      "@@ -1 +1 @@",
      "-Hello",
      "+",
    ].join("\n");
    const exactBoundaryDiff = `${exactBoundaryPrefix}${"x".repeat(
      WORKSPACE_DIFF_DISPLAY_MAX_BYTES - Buffer.byteLength(exactBoundaryPrefix, "utf8") - 1,
    )}\n`;
    const exactBoundaryDigest = createHash("sha256")
      .update(exactBoundaryDiff, "utf8")
      .digest("hex");
    const exactBoundary = presentRun(
      project,
      presentationSnapshot({
        run: {
          ...run,
          diff: exactBoundaryDiff,
          verification: { ...verification, diffSha256: exactBoundaryDigest },
        },
        approvals: [],
        events: [],
      }),
    );
    expect(Buffer.byteLength(exactBoundaryDiff, "utf8")).toBe(WORKSPACE_DIFF_DISPLAY_MAX_BYTES);
    expect(exactBoundary.diff).toBe(exactBoundaryDiff);
    expect(exactBoundary.diffReview).toMatchObject({
      status: "available",
      sha256: exactBoundaryDigest,
      byteCount: WORKSPACE_DIFF_DISPLAY_MAX_BYTES,
      digestProvenance: "displayed_text_rehash_match",
    });

    const outsideSentinel = "outside-browser-bound-private-tail";
    const oversizedDiff = [
      "diff --git a/src/greeting.txt b/src/greeting.txt",
      "--- a/src/greeting.txt",
      "+++ b/src/greeting.txt",
      "@@ -1 +1 @@",
      "-Hello",
      `+${"x".repeat(WORKSPACE_DIFF_DISPLAY_MAX_BYTES)}${outsideSentinel}`,
      "",
    ].join("\n");
    const oversizedDigest = createHash("sha256").update(oversizedDiff, "utf8").digest("hex");
    const oversized = presentRun(
      {
        ...project,
        ceiling: {
          ...project.ceiling,
          maxDiffBytes: Buffer.byteLength(oversizedDiff, "utf8") + 1,
        },
      },
      presentationSnapshot({
        run: {
          ...run,
          diff: oversizedDiff,
          verification: { ...verification, diffSha256: oversizedDigest },
        },
        approvals: [],
        events: [],
      }),
    );
    expect(oversized.diff).toBeNull();
    expect(oversized.diffReview).toEqual({
      status: "outside_browser_bound",
      path: "src/greeting.txt",
      paths: ["src/greeting.txt"],
      sha256: oversizedDigest,
      byteCount: Buffer.byteLength(oversizedDiff, "utf8"),
      lineCount: null,
      addedLines: null,
      deletedLines: null,
      hunkCount: null,
      browserByteLimit: 262_144,
      digestProvenance: "recorded_only",
    });
    expect(JSON.stringify(oversized)).not.toContain(outsideSentinel);

    const quotedTarget = "src/greeting 🪽.txt";
    const quotedDiff = [
      'diff --git "a/src/greeting \\360\\237\\252\\275.txt" "b/src/greeting \\360\\237\\252\\275.txt"',
      "index ce01362..63c704a 100644",
      '--- "a/src/greeting \\360\\237\\252\\275.txt"',
      '+++ "b/src/greeting \\360\\237\\252\\275.txt"',
      "@@ -1 +1 @@",
      "-Hello",
      "+Hello, quoted path",
      "",
    ].join("\n");
    const quoted = presentRun(
      project,
      presentationSnapshot({
        run: {
          ...run,
          target: quotedTarget,
          diff: quotedDiff,
          verification: {
            ...verification,
            changedPaths: [quotedTarget],
            diffSha256: createHash("sha256").update(quotedDiff, "utf8").digest("hex"),
          },
        },
        approvals: [],
        events: [],
      }),
    );
    expect(quoted.diffReview).toMatchObject({ status: "available", path: quotedTarget });

    const nativeGitRoot = mkdtempSync(path.join(tmpdir(), "icarus-presenter-native-git-"));
    const nativeGitRepository = path.join(nativeGitRoot, "repository");
    const nativeGitConfig = path.join(nativeGitRoot, "gitconfig");
    const nativeTarget = "src/file with space.txt";
    try {
      mkdirSync(path.join(nativeGitRepository, "src"), { recursive: true });
      writeFileSync(nativeGitConfig, "", "utf8");
      const nativeGit = (args: readonly string[]): string =>
        execFileSync("git", ["-c", "core.fsmonitor=false", ...args], {
          cwd: nativeGitRepository,
          encoding: "utf8",
          env: {
            ...process.env,
            GIT_CONFIG_GLOBAL: nativeGitConfig,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_TERMINAL_PROMPT: "0",
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
      nativeGit(["init", "-b", "main"]);
      writeFileSync(path.join(nativeGitRepository, nativeTarget), "Hello\n", "utf8");
      nativeGit(["add", "--", nativeTarget]);
      nativeGit([
        "-c",
        "user.name=Icarus Presenter Test",
        "-c",
        "user.email=presenter@example.invalid",
        "commit",
        "-m",
        "fixture",
      ]);
      writeFileSync(path.join(nativeGitRepository, nativeTarget), "Hello, native Git\n", "utf8");
      const nativeDiff = nativeGit([
        "diff",
        "--binary",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--",
        nativeTarget,
      ]);
      expect(nativeDiff).toContain(`diff --git a/${nativeTarget} b/${nativeTarget}`);
      const nativePresentation = presentRun(
        project,
        presentationSnapshot({
          run: {
            ...run,
            target: nativeTarget,
            diff: nativeDiff,
            verification: {
              ...verification,
              changedPaths: [nativeTarget],
              diffSha256: createHash("sha256").update(nativeDiff, "utf8").digest("hex"),
            },
          },
          approvals: [],
          events: [],
        }),
      );
      expect(nativePresentation.diffReview).toMatchObject({
        status: "available",
        path: nativeTarget,
      });
    } finally {
      rmSync(nativeGitRoot, { recursive: true, force: true });
    }

    const persistedRunWithDiff = (candidate: string): RunRecord => ({
      ...run,
      diff: candidate,
      verification: {
        ...verification,
        diffSha256: createHash("sha256").update(candidate, "utf8").digest("hex"),
      },
    });
    const wrongTargetDiff = diff.replaceAll("src/greeting.txt", "private/other.txt");
    const hunkBeforeHeader = [
      "@@ -1 +1 @@",
      "-Hello",
      "+Wrong order",
      ...diff.trimEnd().split("\n"),
      "",
    ].join("\n");
    const mismatchedFileHeaders = diff.replace(
      "--- a/src/greeting.txt\n+++ b/src/greeting.txt",
      "--- a/src/greeting.txt\n+++ b/src/other.txt",
    );
    const inconsistentHunkCount = diff.replace("@@ -1 +1,2 @@", "@@ -1,2 +1,2 @@");
    const trailingSecondPatch = `${diff.trimEnd()}\n${diff}`;

    const corruptRuns: RunRecord[] = [
      { ...run, verification: null },
      { ...run, verification: { ...verification, diffSha256: "f".repeat(64) } },
      { ...run, verification: { ...verification, checkpointSha256: "not-a-digest" } },
      {
        ...run,
        verification: { ...verification, outcome: "invented" },
      } as unknown as RunRecord,
      {
        ...run,
        verification: { ...verification, changedPaths: null },
      } as unknown as RunRecord,
      { ...run, verification: { ...verification, changedPaths: ["src/other.txt"] } },
      {
        ...run,
        diff: "not a patch",
        verification: {
          ...verification,
          diffSha256: createHash("sha256").update("not a patch").digest("hex"),
        },
      },
      persistedRunWithDiff(wrongTargetDiff),
      persistedRunWithDiff(hunkBeforeHeader),
      persistedRunWithDiff(mismatchedFileHeaders),
      persistedRunWithDiff(inconsistentHunkCount),
      persistedRunWithDiff(trailingSecondPatch),
      persistedRunWithDiff(
        diff.replace(
          "diff --git a/src/greeting.txt b/src/greeting.txt",
          'diff --git "a/src/greeting\\q.txt" "b/src/greeting\\q.txt"',
        ),
      ),
      { ...run, diff: null },
    ];
    for (const corruptRun of corruptRuns) {
      expect(() =>
        presentRun(project, presentationSnapshot({ run: corruptRun, approvals: [], events: [] })),
      ).toThrowError(expect.objectContaining({ code: "DATABASE_ERROR" }));
    }

    expect(
      presentTimelineEvent({
        sequence: 4,
        type: "verification.completed",
        createdAt: "2026-07-22T12:01:00.000Z",
      }),
    ).toMatchObject({ evidenceSection: "diff" });
    expect(
      presentTimelineEvent({
        sequence: 3,
        type: "checkpoint.saved",
        createdAt: "2026-07-22T12:00:59.000Z",
      }),
    ).toMatchObject({ evidenceSection: "verification" });
  });
});
