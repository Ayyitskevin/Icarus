import { describe, expect, test } from "vitest";

import type {
  ChangeContextPacketView,
  ChangeRoomDetailView,
  ChangeRoomPageView,
  ChangeRoomSummaryView,
  RunPhase,
  RunStateView,
} from "../../packages/workspace/src/api.js";
import {
  acceptChangeRoomPage,
  canNavigateToNewerRooms,
  canNavigateToOlderRooms,
  CHANGE_ROOM_CARD_ORDER,
  CHANGE_ROOM_PAGE_MAX_NEWER_CURSORS,
  CHANGE_ROOM_PAGE_MAX_PAGES,
  CHANGE_ROOM_PAGE_SIZE,
  changeRoomPageDepth,
  changeRoomPageRequest,
  createChangeRoomPageSession,
  validateChangeContextPacket,
  validateChangeRoom,
  validateChangeRoomPage,
} from "../../packages/workspace/src/change-room.js";

const ROOM_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const APPROVAL_DIGEST = "b".repeat(64);
const CONTEXT_SHA256 = "c".repeat(64);
const DIFF_SHA256 = "d".repeat(64);
const PLAN_SHA256 = "e".repeat(64);
const CHECKPOINT_SHA256 = "f".repeat(64);
const PREIMAGE_SHA256 = "1".repeat(64);
const BASE_COMMIT = "0".repeat(40);
const DIFF_TEXT = "diff --git a/src/example.ts b/src/example.ts\n-old line\n+new line\n";
const DIFF_BYTES = new TextEncoder().encode(DIFF_TEXT).byteLength;

const phases: Readonly<Record<RunStateView, RunPhase>> = {
  preparing: "draft",
  planned: "planned",
  awaiting_egress_approval: "awaiting_approval",
  awaiting_approval: "awaiting_approval",
  running: "running",
  verifying: "running",
  awaiting_review: "awaiting_approval",
  completed: "completed",
  rolling_back: "running",
  cancelling: "running",
  failed: "failed",
  cancelled: "cancelled",
  rolled_back: "cancelled",
  restoring: "running",
};

function summary(index: number, state: RunStateView = "completed"): ChangeRoomSummaryView {
  return {
    roomId: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
    projectId: PROJECT_ID,
    task: `Guarded change ${index}`,
    target: `src/example-${index}.ts`,
    state,
    phase: phases[state],
    verificationOutcome: "passed",
    provider: {
      kind: "ollama",
      model: "qwen2.5-coder:7b",
      locality: "loopback",
      privacyClass: "local_process",
    },
    terminalReason: state === "completed" ? "completed" : null,
    createdAt: "2026-07-20T12:00:00.000Z",
    lastActivity: "2026-07-20T12:01:00Z",
  };
}

function page(
  before: number,
  snapshot: number,
  count: number,
  hasMore: boolean,
  nextBefore: number,
  offset = 0,
): ChangeRoomPageView {
  return {
    before,
    snapshot,
    nextBefore,
    hasMore,
    rooms: Array.from({ length: count }, (_, index) => summary(offset + index + 1)),
  };
}

function timelineEntry(sequence: number, type: string): ChangeRoomDetailView["timeline"][number] {
  const stamp = `2026-07-20T12:${String(Math.floor(sequence / 60) % 60).padStart(2, "0")}:${String(
    sequence % 60,
  ).padStart(2, "0")}.000Z`;
  return {
    sequence,
    type,
    label: type.replaceAll(".", " "),
    evidenceSection: "Run evidence",
    timestamp: stamp,
    createdAt: stamp,
  };
}

function indicators(
  partial: Partial<ChangeRoomDetailView["cards"][number]["indicators"]> = {},
): ChangeRoomDetailView["cards"][number]["indicators"] {
  return {
    truncated: partial.truncated ?? false,
    redacted: partial.redacted ?? false,
    unavailableEvidence: partial.unavailableEvidence ?? false,
  };
}

function cards(): ChangeRoomDetailView["cards"] {
  return [
    {
      id: "card-task-scope",
      kind: "task_scope",
      title: "Task and approved scope",
      provenanceClass: "operator_assertion",
      status: "available",
      refs: [{ kind: "event_sequence", sequence: 1 }],
      indicators: indicators(),
      body: {
        task: "Replace the greeting text",
        target: "src/example.ts",
        projectId: PROJECT_ID,
        projectName: "Example project",
        baseRef: "main",
      },
    },
    {
      id: "card-base-context",
      kind: "base_context",
      title: "Pinned base and context egress",
      provenanceClass: "host_fact",
      status: "available",
      refs: [
        { kind: "event_sequence", sequence: 2 },
        { kind: "digest", label: "context", sha256: CONTEXT_SHA256 },
      ],
      indicators: indicators(),
      body: {
        baseCommit: BASE_COMMIT,
        contextSha256: CONTEXT_SHA256,
        target: "src/example.ts",
        totalBytes: 4096,
        auditPolicyVersion: "tracked-tree-secret-audit-v1",
        repositoryMap: ["src/example.ts", "README.md"],
        entries: [
          {
            path: "src/example.ts",
            reason: "target",
            bytes: 512,
            sha256: PREIMAGE_SHA256,
          },
        ],
        egress: { state: "not_required_loopback", approval: null },
      },
    },
    {
      id: "card-provider-plan",
      kind: "provider_plan",
      title: "Provider plan (untrusted proposal)",
      provenanceClass: "provider_output",
      status: "available",
      refs: [
        { kind: "event_sequence", sequence: 3 },
        { kind: "digest", label: "plan", sha256: PLAN_SHA256 },
      ],
      indicators: indicators(),
      body: {
        provider: {
          kind: "ollama",
          model: "qwen2.5-coder:7b",
          locality: "loopback",
          privacyClass: "local_process",
        },
        trustLabel: "untrusted_proposal",
        plan: {
          summary: "Replace one exact line in the target file.",
          steps: ["Read the target", "Replace the line"],
          risks: ["The preimage may have drifted"],
          target: "src/example.ts",
          checkIds: ["check-lint"],
        },
        planSha256: PLAN_SHA256,
      },
    },
    {
      id: "card-plan-approval",
      kind: "plan_approval",
      title: "Plan approval",
      provenanceClass: "approval_decision",
      status: "available",
      refs: [{ kind: "approval", approvalKind: "plan", digest: APPROVAL_DIGEST }],
      indicators: indicators(),
      body: {
        approval: {
          actor: "operator",
          decision: "approve",
          digest: APPROVAL_DIGEST,
          createdAt: "2026-07-20T12:00:03.500Z",
        },
      },
    },
    {
      id: "card-patchset",
      kind: "patchset",
      title: "PatchSet and diff evidence",
      provenanceClass: "provider_output",
      status: "available",
      refs: [{ kind: "digest", label: "diff", sha256: DIFF_SHA256 }],
      indicators: indicators({ redacted: true }),
      body: {
        action: {
          path: "src/example.ts",
          expectedPreimageSha256: PREIMAGE_SHA256,
          rationale: "The greeting must match the new copy.",
        },
        actionStatus: "materialized",
        diffSha256: DIFF_SHA256,
        diffBytes: DIFF_BYTES,
        diff: DIFF_TEXT,
        changedPaths: ["src/example.ts"],
        note: "The edit proposal is untrusted provider output until validated.",
      },
    },
    {
      id: "card-registered-checks",
      kind: "registered_checks",
      title: "Registered verification checks",
      provenanceClass: "operator_assertion",
      status: "available",
      refs: [],
      indicators: indicators(),
      body: {
        checks: [
          { id: "check-lint", name: "Lint", argv: ["pnpm", "lint"] },
          { id: "check-types", name: "Types", argv: ["pnpm", "typecheck"] },
        ],
        sandbox: { image: "icarus-sandbox:local", cpus: 2, memoryMb: 1024, pids: 256, tmpfsMb: 64 },
      },
    },
    {
      id: "card-check-outcomes",
      kind: "check_outcomes",
      title: "Verification outcomes",
      provenanceClass: "verification_evidence",
      status: "available",
      refs: [
        { kind: "event_sequence", sequence: 4 },
        { kind: "digest", label: "diff", sha256: DIFF_SHA256 },
      ],
      indicators: indicators({ redacted: true }),
      body: {
        outcome: "passed",
        checks: [
          {
            id: "check-lint",
            name: "Lint",
            argv: ["pnpm", "lint"],
            outcome: "passed",
            exitCode: 0,
            signal: null,
            durationMs: 1250,
            stdout: "lint ok\n",
            stderr: "",
            truncated: false,
          },
          {
            id: "check-types",
            name: "Types",
            argv: ["pnpm", "typecheck"],
            outcome: "not_run",
            exitCode: null,
            signal: null,
            durationMs: null,
            stdout: "",
            stderr: "",
            truncated: false,
          },
        ],
        diffSha256: DIFF_SHA256,
        checkpointSha256: CHECKPOINT_SHA256,
      },
    },
    {
      id: "card-review-decision",
      kind: "review_decision",
      title: "Review decision",
      provenanceClass: "approval_decision",
      status: "pending",
      refs: [],
      indicators: indicators(),
      body: { decision: null },
    },
    {
      id: "card-checkpoint",
      kind: "checkpoint",
      title: "Checkpoint",
      provenanceClass: "host_fact",
      status: "available",
      refs: [{ kind: "checkpoint", sha256: CHECKPOINT_SHA256 }],
      indicators: indicators(),
      body: {
        status: "saved",
        sha256: CHECKPOINT_SHA256,
        createdAt: "2026-07-20T12:00:04.000Z",
        note: "The checkpoint digest is a recorded byte binding, not a fresh rehash.",
      },
    },
    {
      id: "card-rollback-restoration",
      kind: "rollback_restoration",
      title: "Rollback and restoration",
      provenanceClass: "approval_decision",
      status: "available",
      refs: [],
      indicators: indicators(),
      body: {
        records: [
          {
            kind: "restore",
            actor: "operator",
            decision: "approve",
            digest: APPROVAL_DIGEST,
            createdAt: "2026-07-20T12:00:04.500Z",
            completed: true,
            completedSequence: 4,
          },
        ],
        note: "Restoration rewrites only checkpoint-approved bytes.",
      },
    },
    {
      id: "card-terminal-state",
      kind: "terminal_state",
      title: "Run state and terminal outcome",
      provenanceClass: "host_fact",
      status: "available",
      refs: [],
      indicators: indicators(),
      body: {
        state: "awaiting_review",
        resumeState: null,
        terminal: false,
        terminalReason: null,
        lastError: null,
        updatedAt: "2026-07-20T12:00:05.000Z",
      },
    },
  ];
}

function roomDetail(): ChangeRoomDetailView {
  return {
    schema: "icarus.change-room.v1",
    roomId: ROOM_ID,
    projectId: PROJECT_ID,
    state: "awaiting_review",
    phase: "awaiting_approval",
    cards: cards(),
    annotations: [
      {
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        runId: ROOM_ID,
        card: "room",
        actor: "operator",
        body: "Reviewing this after the deploy freeze lifts.",
        createdAt: "2026-07-20T12:05:00.000Z",
      },
      {
        id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        runId: ROOM_ID,
        card: "patchset",
        actor: "operator",
        body: "Diff matches the approved plan.",
        createdAt: "2026-07-20T12:06:00.000Z",
      },
    ],
    timeline: [
      timelineEntry(1, "run.created"),
      timelineEntry(2, "base.pinned"),
      timelineEntry(3, "plan.created"),
      timelineEntry(4, "verification.completed"),
    ],
    integrity: {
      eventCursor: 4,
      eventCount: 4,
      timelineTruncated: false,
      digestSemantics: "byte_binding_only",
      note: "Digests prove only byte binding, not semantic correctness.",
    },
    generatedBy: "deterministic_host_projection",
  };
}

function draftRoom(): ChangeRoomDetailView {
  const base = roomDetail();
  const replacement = cards().map((card) => {
    switch (card.kind) {
      case "base_context":
        return {
          ...card,
          status: "pending" as const,
          refs: [],
          body: {
            baseCommit: null,
            contextSha256: null,
            target: null,
            totalBytes: null,
            auditPolicyVersion: null,
            repositoryMap: [],
            entries: [],
            egress: { state: "not_required_loopback" as const, approval: null },
          },
        };
      case "provider_plan":
        return {
          ...card,
          status: "pending" as const,
          refs: [],
          body: { ...card.body, plan: null, planSha256: null },
        };
      case "plan_approval":
        return {
          ...card,
          status: "pending" as const,
          refs: [],
          body: { approval: null },
        };
      case "patchset":
        return {
          ...card,
          status: "pending" as const,
          refs: [],
          indicators: indicators(),
          body: {
            action: null,
            actionStatus: "not_recorded" as const,
            diffSha256: null,
            diffBytes: null,
            diff: null,
            changedPaths: [],
            note: "Nothing has been proposed yet.",
          },
        };
      case "check_outcomes":
        return {
          ...card,
          status: "pending" as const,
          refs: [],
          indicators: indicators(),
          body: {
            outcome: "not_run" as const,
            checks: [],
            diffSha256: null,
            checkpointSha256: null,
          },
        };
      case "checkpoint":
        return {
          ...card,
          status: "pending" as const,
          refs: [],
          body: {
            status: "not_saved" as const,
            sha256: null,
            createdAt: null,
            note: "No checkpoint row was recorded.",
          },
        };
      case "rollback_restoration":
        return {
          ...card,
          status: "not_applicable" as const,
          body: { records: [], note: "No recovery is recorded." },
        };
      case "terminal_state":
        return {
          ...card,
          body: {
            state: "preparing" as const,
            resumeState: null,
            terminal: false,
            terminalReason: null,
            lastError: null,
            updatedAt: "2026-07-20T12:00:01.000Z",
          },
        };
      default:
        return card;
    }
  });
  return {
    ...base,
    state: "preparing",
    phase: "draft",
    cards: replacement,
    annotations: [],
    timeline: [timelineEntry(1, "run.created")],
    integrity: { ...base.integrity, eventCursor: 1, eventCount: 1 },
  };
}

function packet(
  room: ChangeRoomDetailView,
  question: ChangeContextPacketView["question"] = "what_passed",
): ChangeContextPacketView {
  return {
    schema: "icarus.change-context.v1",
    roomId: room.roomId,
    eventCursor: room.integrity.eventCursor,
    question,
    components: [
      {
        statement: "Latest verification outcome: passed, recorded in the no-network sandbox.",
        receipts: [
          {
            cardId: "card-check-outcomes",
            eventSequences: [4],
            digests: [DIFF_SHA256],
          },
        ],
      },
      {
        statement: "Check check-lint (Lint): passed, exit 0.",
        receipts: [{ cardId: "card-check-outcomes", eventSequences: [], digests: [] }],
      },
    ],
    omissions: ["Some check output was truncated and redacted at persistence time."],
    uncertainty: ["Earlier verification attempts are not replayed here."],
    generatedBy: "deterministic_host_projection",
  };
}

describe("workspace change room page navigation", () => {
  test("accepts the exact empty newest-page contract", () => {
    const empty: ChangeRoomPageView = {
      before: 1,
      snapshot: 0,
      nextBefore: 1,
      hasMore: false,
      rooms: [],
    };
    const session = createChangeRoomPageSession(empty);

    expect(session).toEqual({ snapshot: 0, initialBefore: 1, page: empty, newerBefore: [] });
    expect(changeRoomPageDepth(session)).toBe(1);
    expect(canNavigateToOlderRooms(session)).toBe(false);
    expect(canNavigateToNewerRooms(session)).toBe(false);
  });

  test("replaces pages and retains only three newer cursors", () => {
    // The window is capped at four pages so the browser never accumulates
    // unbounded pinned history; older runs stay reachable through the CLI.
    let session = createChangeRoomPageSession(page(501, 500, 12, true, 489));
    expect(CHANGE_ROOM_PAGE_SIZE).toBe(12);
    expect(changeRoomPageDepth(session)).toBe(1);

    for (const [before, nextBefore, offset] of [
      [489, 477, 12],
      [477, 465, 24],
      [465, 453, 36],
    ] as const) {
      const request = changeRoomPageRequest(session, "older");
      expect(request.before).toBe(before);
      session = acceptChangeRoomPage(
        session,
        request,
        page(before, 500, 12, true, nextBefore, offset),
      );
    }

    expect(CHANGE_ROOM_PAGE_MAX_PAGES).toBe(4);
    expect(CHANGE_ROOM_PAGE_MAX_NEWER_CURSORS).toBe(3);
    expect(changeRoomPageDepth(session)).toBe(4);
    expect(session.newerBefore).toEqual([501, 489, 477]);
    expect(session.page.before).toBe(465);
    expect(canNavigateToOlderRooms(session)).toBe(false);
    expect(() => changeRoomPageRequest(session, "older")).toThrow("cannot navigate farther back");

    const newerRequest = changeRoomPageRequest(session, "newer");
    expect(newerRequest.before).toBe(477);
    session = acceptChangeRoomPage(session, newerRequest, page(477, 500, 12, true, 465, 24));
    expect(session.newerBefore).toEqual([501, 489]);
    expect(session.page.before).toBe(477);
    expect(changeRoomPageDepth(session)).toBe(3);
  });

  test("uses hasMore alone to gate Older on a terminal page", () => {
    let session = createChangeRoomPageSession(page(13, 12, 12, false, 1));
    expect(session.page.nextBefore).toBe(1);
    expect(canNavigateToOlderRooms(session)).toBe(false);

    const first = createChangeRoomPageSession(page(25, 24, 12, true, 13));
    const request = changeRoomPageRequest(first, "older");
    session = acceptChangeRoomPage(first, request, page(13, 24, 12, false, 1, 12));
    expect(session.page.rooms).toHaveLength(12);
    expect(session.page.hasMore).toBe(false);
    expect(canNavigateToOlderRooms(session)).toBe(false);
    expect(canNavigateToNewerRooms(session)).toBe(true);
  });

  test("rejects mismatched, malformed, oversized, and stale pages", () => {
    const initialPage = page(101, 100, 12, true, 89);
    const initial = createChangeRoomPageSession(initialPage);
    const request = changeRoomPageRequest(initial, "older");
    const valid = page(89, 100, 12, true, 77, 12);
    const firstRoom = valid.rooms[0];
    if (firstRoom === undefined) throw new Error("Fixture room is missing");

    const invalidPages: readonly unknown[] = [
      { ...valid, before: 88 },
      { ...valid, snapshot: 99 },
      { ...valid, nextBefore: 89 },
      { ...valid, rooms: [...valid.rooms, summary(99)] },
      { ...valid, rooms: valid.rooms.slice(0, 11) },
      { ...valid, rooms: [firstRoom, firstRoom, ...valid.rooms.slice(2)] },
      { ...valid, unexpected: "not allowed" },
      { ...valid, rooms: [{ ...firstRoom, detail: "private detail" }, ...valid.rooms.slice(1)] },
      {
        ...valid,
        rooms: [{ ...firstRoom, roomId: firstRoom.roomId.toUpperCase() }, ...valid.rooms.slice(1)],
      },
      { ...valid, rooms: [{ ...firstRoom, task: " \n " }, ...valid.rooms.slice(1)] },
      { ...valid, rooms: [{ ...firstRoom, task: `task\0secret` }, ...valid.rooms.slice(1)] },
      // Task text is capped at 8 KiB so one hostile row cannot exhaust the renderer.
      {
        ...valid,
        rooms: [{ ...firstRoom, task: "x".repeat(8 * 1024 + 1) }, ...valid.rooms.slice(1)],
      },
      { ...valid, rooms: [{ ...firstRoom, target: "é".repeat(513) }, ...valid.rooms.slice(1)] },
      { ...valid, rooms: [{ ...firstRoom, phase: "running" }, ...valid.rooms.slice(1)] },
      { ...valid, rooms: [{ ...firstRoom, state: "unknown" }, ...valid.rooms.slice(1)] },
      {
        ...valid,
        rooms: [{ ...firstRoom, verificationOutcome: "partial" }, ...valid.rooms.slice(1)],
      },
      {
        ...valid,
        rooms: [
          { ...firstRoom, provider: { ...firstRoom.provider, kind: "anthropic" } },
          ...valid.rooms.slice(1),
        ],
      },
      {
        ...valid,
        rooms: [
          { ...firstRoom, provider: { ...firstRoom.provider, locality: "datacenter" } },
          ...valid.rooms.slice(1),
        ],
      },
      {
        ...valid,
        rooms: [
          { ...firstRoom, provider: { ...firstRoom.provider, privacyClass: "public" } },
          ...valid.rooms.slice(1),
        ],
      },
      {
        ...valid,
        rooms: [
          { ...firstRoom, provider: { ...firstRoom.provider, model: "m".repeat(257) } },
          ...valid.rooms.slice(1),
        ],
      },
      { ...valid, rooms: [{ ...firstRoom, terminalReason: 7 }, ...valid.rooms.slice(1)] },
      { ...valid, rooms: [{ ...firstRoom, lastActivity: "not-a-time" }, ...valid.rooms.slice(1)] },
    ];
    for (const invalid of invalidPages) {
      expect(() => acceptChangeRoomPage(initial, request, invalid)).toThrow();
      expect(initial.page).toBe(initialPage);
      expect(initial.newerBefore).toEqual([]);
    }

    const accepted = acceptChangeRoomPage(initial, request, valid);
    expect(() => acceptChangeRoomPage(accepted, request, valid)).toThrow("cursor is stale");
    expect(accepted.page).toBe(valid);
  });

  test("rejects invalid newest and empty page metadata", () => {
    expect(() => createChangeRoomPageSession(page(100, 100, 12, false, 88))).toThrow(
      "did not start a pinned session",
    );
    expect(() =>
      createChangeRoomPageSession({
        before: 1,
        snapshot: 0,
        nextBefore: 1,
        hasMore: false,
        rooms: [summary(1)],
      }),
    ).toThrow("boundary was inconsistent");
    expect(() =>
      createChangeRoomPageSession({
        before: 1,
        snapshot: 0,
        nextBefore: 0,
        hasMore: false,
        rooms: [],
      }),
    ).toThrow();
    expect(() =>
      createChangeRoomPageSession({
        before: Number.MAX_SAFE_INTEGER,
        snapshot: Number.MAX_SAFE_INTEGER,
        nextBefore: 1,
        hasMore: false,
        rooms: [summary(1)],
      }),
    ).toThrow();
    expect(() => validateChangeRoomPage({ ...page(2, 1, 1, false, 1), hasMore: true })).toThrow(
      "boundary was inconsistent",
    );
  });

  test("preserves the last page and exact retry request after rejection", () => {
    const firstPage = page(101, 100, 12, true, 89);
    const session = createChangeRoomPageSession(firstPage);
    const request = changeRoomPageRequest(session, "older");

    expect(() =>
      acceptChangeRoomPage(session, request, { ...page(89, 100, 12, true, 77), before: 88 }),
    ).toThrow();
    expect(session.page).toBe(firstPage);
    expect(changeRoomPageRequest(session, "older")).toEqual(request);
  });
});

describe("workspace change room detail contract", () => {
  test("accepts populated and draft rooms with exact card order", () => {
    expect(CHANGE_ROOM_CARD_ORDER).toHaveLength(11);
    expect(() => validateChangeRoom(ROOM_ID, roomDetail())).not.toThrow();
    expect(() => validateChangeRoom(ROOM_ID, draftRoom())).not.toThrow();
  });

  test("accepts terminal states with consistent flags", () => {
    const base = roomDetail();
    const terminalCard = base.cards[10];
    if (terminalCard === undefined || terminalCard.kind !== "terminal_state") {
      throw new Error("Fixture terminal card is missing");
    }
    for (const [state, reason] of [
      ["completed", "completed"],
      ["failed", "failed:PROVIDER_TIMEOUT"],
      ["cancelled", "cancelled"],
      ["rolled_back", "rolled_back"],
    ] as const) {
      const room: ChangeRoomDetailView = {
        ...base,
        state,
        phase: phases[state],
        cards: [
          ...base.cards.slice(0, 10),
          {
            ...terminalCard,
            provenanceClass: state === "failed" ? "system_failure" : "host_fact",
            body: {
              ...terminalCard.body,
              state,
              terminal: true,
              terminalReason: reason,
              lastError:
                state === "failed"
                  ? { code: "PROVIDER_TIMEOUT", message: "The provider timed out." }
                  : null,
            },
          },
        ],
      };
      expect(() => validateChangeRoom(ROOM_ID, room)).not.toThrow();
    }
  });

  test("rejects wrong schema, identity, card count, order, and ids", () => {
    const valid = roomDetail();
    const reordered = [...valid.cards];
    const first = reordered[0];
    const second = reordered[1];
    if (first === undefined || second === undefined) throw new Error("Fixture cards are missing");
    reordered[0] = second;
    reordered[1] = first;
    const wrongIds = valid.cards.map((card) => ({ ...card, id: `id-${card.kind}` }));
    const wrongKinds = valid.cards.map((card, index) =>
      index === 0 ? { ...card, kind: "checkpoint" } : card,
    );
    const wrongTitle = valid.cards.map((card, index) =>
      index === 0 ? { ...card, title: " \n " } : card,
    );
    const wrongProvenance = valid.cards.map((card, index) =>
      index === 0 ? { ...card, provenanceClass: "user_guess" } : card,
    );
    const wrongStatus = valid.cards.map((card, index) =>
      index === 0 ? { ...card, status: "success" } : card,
    );
    const wrongIndicators = valid.cards.map((card, index) =>
      index === 0 ? { ...card, indicators: { ...card.indicators, truncated: "yes" } } : card,
    );

    // Exactly eleven cards in the fixed order keep the projection canonical:
    // a host may not invent, drop, or reorder the operator-facing explanation.
    const invalidRooms: readonly unknown[] = [
      { ...valid, schema: "icarus.change-room.v2" },
      { ...valid, generatedBy: "model_assisted" },
      { ...valid, privatePayload: "<img src=x onerror=alert(1)>" },
      { ...valid, roomId: ROOM_ID.toUpperCase() },
      { ...valid, projectId: "not-a-project" },
      { ...valid, state: "unknown" },
      { ...valid, phase: "running" },
      { ...valid, cards: valid.cards.slice(0, 10) },
      { ...valid, cards: [...valid.cards, valid.cards[0]] },
      { ...valid, cards: reordered },
      { ...valid, cards: wrongIds },
      { ...valid, cards: wrongKinds },
      { ...valid, cards: wrongTitle },
      { ...valid, cards: wrongProvenance },
      { ...valid, cards: wrongStatus },
      { ...valid, cards: wrongIndicators },
    ];
    for (const invalid of invalidRooms) {
      expect(() => validateChangeRoom(ROOM_ID, invalid)).toThrow();
    }
    // A room answered for a different run id must never be rendered for this run.
    expect(() => validateChangeRoom(PROJECT_ID, valid)).toThrow();
  });

  test("rejects invalid card bodies and broken evidence coupling", () => {
    const valid = roomDetail();
    const withCard = (index: number, body: unknown): unknown => ({
      ...valid,
      cards: valid.cards.map((card, cardIndex) => (cardIndex === index ? { ...card, body } : card)),
    });
    const taskScope = valid.cards[0];
    const baseContext = valid.cards[1];
    const providerPlan = valid.cards[2];
    const patchset = valid.cards[4];
    const checkOutcomes = valid.cards[6];
    const checkpoint = valid.cards[8];
    const rollback = valid.cards[9];
    const terminal = valid.cards[10];
    if (
      taskScope?.kind !== "task_scope" ||
      baseContext?.kind !== "base_context" ||
      providerPlan?.kind !== "provider_plan" ||
      patchset?.kind !== "patchset" ||
      checkOutcomes?.kind !== "check_outcomes" ||
      checkpoint?.kind !== "checkpoint" ||
      rollback?.kind !== "rollback_restoration" ||
      terminal?.kind !== "terminal_state"
    ) {
      throw new Error("Fixture cards are missing");
    }

    const invalidBodies: readonly unknown[] = [
      withCard(0, { ...taskScope.body, task: "x".repeat(8 * 1024 + 1) }),
      withCard(0, { ...taskScope.body, projectId: ROOM_ID }),
      withCard(0, { ...taskScope.body, rawPrompt: "private" }),
      withCard(1, { ...baseContext.body, contextSha256: "C".repeat(64) }),
      // A null context digest means no context was pinned; the body must not
      // imply pinned evidence exists anyway.
      withCard(1, { ...baseContext.body, contextSha256: null }),
      withCard(1, { ...baseContext.body, entries: [{ path: "x", reason: "target", bytes: 1 }] }),
      withCard(1, {
        ...baseContext.body,
        entries: [{ path: "x", reason: "guessed", bytes: 1, sha256: PREIMAGE_SHA256 }],
      }),
      withCard(1, { ...baseContext.body, egress: { state: "leaked", approval: null } }),
      withCard(2, { ...providerPlan.body, trustLabel: "trusted" }),
      // The plan and its digest are recorded together; one without the other is a lie.
      withCard(2, { ...providerPlan.body, planSha256: null }),
      withCard(2, { ...providerPlan.body, plan: null }),
      withCard(2, {
        ...providerPlan.body,
        plan: { ...(providerPlan.body.plan ?? {}), steps: [] },
      }),
      withCard(4, { ...patchset.body, actionStatus: "deployed" }),
      // A missing action row means no edit was recorded; the status must agree.
      withCard(4, { ...patchset.body, action: null }),
      withCard(4, { ...patchset.body, actionStatus: "not_recorded" }),
      // The diff byte count is recomputed client-side so a host cannot
      // under-report the evidence size.
      withCard(4, { ...patchset.body, diffBytes: DIFF_BYTES + 1 }),
      withCard(4, { ...patchset.body, diff: null }),
      withCard(4, { ...patchset.body, diff: "x".repeat(256 * 1024 + 1) }),
      withCard(6, { ...checkOutcomes.body, outcome: "partial" }),
      // not_run must never carry pass-shaped digests; absence is not a pass.
      withCard(6, { ...checkOutcomes.body, outcome: "not_run" }),
      withCard(6, { ...checkOutcomes.body, checkpointSha256: null }),
      withCard(6, {
        ...checkOutcomes.body,
        checks: [{ ...(checkOutcomes.body.checks[0] ?? {}), outcome: "timed_out" }],
      }),
      withCard(6, {
        ...checkOutcomes.body,
        checks: [{ ...(checkOutcomes.body.checks[0] ?? {}), stdout: "x".repeat(256 * 1024 + 1) }],
      }),
      // Checkpoint rows are immutable: saved needs digest and time, unsaved needs neither.
      withCard(8, { ...checkpoint.body, createdAt: null }),
      withCard(8, { ...checkpoint.body, status: "not_saved" }),
      withCard(9, {
        ...rollback.body,
        records: [{ ...(rollback.body.records[0] ?? {}), kind: "deploy" }],
      }),
      // Recovery completion may only cite events retained in the bounded timeline.
      withCard(9, {
        ...rollback.body,
        records: [{ ...(rollback.body.records[0] ?? {}), completedSequence: 99 }],
      }),
      // The terminal flag and reason must agree with the exact run state.
      withCard(10, { ...terminal.body, terminal: true }),
      withCard(10, { ...terminal.body, terminalReason: "completed" }),
      withCard(10, { ...terminal.body, state: "completed" }),
      withCard(10, { ...terminal.body, lastError: { code: "lowercase", message: "bad" } }),
    ];
    for (const invalid of invalidBodies) {
      expect(() => validateChangeRoom(ROOM_ID, invalid)).toThrow();
    }
  });

  test("rejects invalid refs, annotations, timeline, and integrity", () => {
    const valid = roomDetail();
    const withRefs = (index: number, refs: unknown): unknown => ({
      ...valid,
      cards: valid.cards.map((card, cardIndex) => (cardIndex === index ? { ...card, refs } : card)),
    });
    const baseAnnotation = valid.annotations[0];
    if (baseAnnotation === undefined) throw new Error("Fixture annotation is missing");

    const invalidRooms: readonly unknown[] = [
      // Event refs must cite events retained in this pinned timeline.
      withRefs(0, [{ kind: "event_sequence", sequence: 99 }]),
      withRefs(0, [{ kind: "event_sequence", sequence: 0 }]),
      withRefs(0, [{ kind: "approval", approvalKind: "deploy", digest: APPROVAL_DIGEST }]),
      withRefs(0, [{ kind: "digest", label: "context", sha256: "Z".repeat(64) }]),
      withRefs(0, [{ kind: "checkpoint", sha256: "short" }]),
      withRefs(0, [{ kind: "event_sequence", sequence: 1, payload: "private" }]),
      { ...valid, annotations: [...valid.annotations, { ...baseAnnotation, body: " \n " }] },
      // Annotation bodies are capped at 1 KiB; they are operator context, not a data channel.
      {
        ...valid,
        annotations: [...valid.annotations, { ...baseAnnotation, body: "x".repeat(1025) }],
      },
      {
        ...valid,
        annotations: Array.from({ length: 33 }, (_, index) => ({
          ...baseAnnotation,
          id: `eeeeeeee-eeee-4eee-8eee-${String(index).padStart(12, "0")}`,
        })),
      },
      { ...valid, annotations: [{ ...baseAnnotation, runId: PROJECT_ID }] },
      { ...valid, annotations: [{ ...baseAnnotation, card: "diff" }] },
      { ...valid, annotations: [{ ...baseAnnotation, actor: "bad\nactor" }] },
      { ...valid, timeline: [...valid.timeline, timelineEntry(5, "run.failed")] },
      // The timeline is a contiguous suffix of the persisted event log ending
      // exactly at the pinned event cursor.
      { ...valid, timeline: valid.timeline.slice(1) },
      {
        ...valid,
        timeline: [timelineEntry(1, "run.created"), timelineEntry(3, "plan.created")],
      },
      { ...valid, timeline: [...valid.timeline].reverse() },
      { ...valid, integrity: { ...valid.integrity, eventCount: 5 } },
      { ...valid, integrity: { ...valid.integrity, timelineTruncated: true } },
      { ...valid, integrity: { ...valid.integrity, digestSemantics: "full_semantic_proof" } },
    ];
    for (const invalid of invalidRooms) {
      expect(() => validateChangeRoom(ROOM_ID, invalid)).toThrow();
    }
  });

  test("enforces the 200-event timeline bound with an exact contiguous suffix", () => {
    const base = roomDetail();
    const timeline = Array.from({ length: 200 }, (_, index) =>
      timelineEntry(index + 1, index === 0 ? "run.created" : `event.${index + 1}`),
    );
    const room: ChangeRoomDetailView = {
      ...base,
      timeline,
      integrity: { ...base.integrity, eventCursor: 200, eventCount: 200 },
    };
    expect(() => validateChangeRoom(ROOM_ID, room)).not.toThrow();

    const over: ChangeRoomDetailView = {
      ...room,
      timeline: [...timeline, timelineEntry(201, "event.201")],
      integrity: { ...room.integrity, eventCursor: 201, eventCount: 201 },
    };
    // The browser projection is bounded to the newest 200 events; a host may
    // not exceed the bound even with well-formed entries.
    expect(() => validateChangeRoom(ROOM_ID, over)).toThrow();

    const truncated: ChangeRoomDetailView = {
      ...room,
      // Event refs may only cite retained events, so a truncated suffix drops
      // refs into the excluded prefix (the digest refs remain valid).
      cards: room.cards.map((card) =>
        card.kind === "rollback_restoration"
          ? // Recovery completion sequences likewise must stay inside the suffix.
            { ...card, body: { ...card.body, records: [] } }
          : {
              ...card,
              refs: card.refs.filter((ref) => ref.kind !== "event_sequence"),
            },
      ),
      timeline: timeline.slice(50),
      integrity: { ...room.integrity, timelineTruncated: true },
    };
    // timelineTruncated is recomputed from eventCount versus retained length.
    expect(truncated.timeline).toHaveLength(150);
    expect(() => validateChangeRoom(ROOM_ID, truncated)).not.toThrow();
    expect(() =>
      validateChangeRoom(ROOM_ID, {
        ...truncated,
        integrity: { ...truncated.integrity, timelineTruncated: false },
      }),
    ).toThrow();
  });
});

describe("workspace change-context packet contract", () => {
  test("accepts a valid packet that cites retained evidence", () => {
    const room = roomDetail();
    expect(() => validateChangeContextPacket(room, "what_passed", packet(room))).not.toThrow();
    const empty: ChangeContextPacketView = {
      schema: "icarus.change-context.v1",
      roomId: room.roomId,
      eventCursor: room.integrity.eventCursor,
      question: "what_remains_before_review",
      components: [],
      omissions: [],
      uncertainty: [],
      generatedBy: "deterministic_host_projection",
    };
    expect(() =>
      validateChangeContextPacket(room, "what_remains_before_review", empty),
    ).not.toThrow();
  });

  test("rejects packets that are unpinned, oversized, or cite unknown evidence", () => {
    const room = roomDetail();
    const valid = packet(room);
    const firstComponent = valid.components[0];
    if (firstComponent === undefined) throw new Error("Fixture component is missing");
    const crowded = Array.from({ length: 9 }, (_, index) => ({
      statement: `Statement ${index}`,
      receipts: [],
    }));

    const invalidPackets: readonly unknown[] = [
      { ...valid, schema: "icarus.change-context.v2" },
      { ...valid, generatedBy: "model_assisted" },
      { ...valid, roomId: PROJECT_ID },
      { ...valid, eventCursor: 3 },
      { ...valid, question: "what_changed" },
      { ...valid, privatePayload: "secret" },
      // Explanations are capped at eight components so one answer stays a
      // bounded, inspectable projection.
      { ...valid, components: crowded },
      { ...valid, components: [{ ...firstComponent, statement: " \n " }] },
      {
        ...valid,
        components: [{ ...firstComponent, statement: "x".repeat(16 * 1024 + 1) }],
      },
      // Receipts may only reference the eleven canonical card ids.
      {
        ...valid,
        components: [
          {
            ...firstComponent,
            receipts: [{ cardId: "card-shell", eventSequences: [], digests: [] }],
          },
        ],
      },
      // Receipt event sequences must exist in the retained pinned timeline.
      {
        ...valid,
        components: [
          {
            ...firstComponent,
            receipts: [{ cardId: "card-check-outcomes", eventSequences: [99], digests: [] }],
          },
        ],
      },
      {
        ...valid,
        components: [
          {
            ...firstComponent,
            receipts: [{ cardId: "card-check-outcomes", eventSequences: [4], digests: ["zz"] }],
          },
        ],
      },
      {
        ...valid,
        components: [
          {
            ...firstComponent,
            receipts: [{ cardId: "card-check-outcomes", eventSequences: [], digests: [], raw: 1 }],
          },
        ],
      },
      { ...valid, omissions: Array.from({ length: 33 }, (_, index) => `omission ${index}`) },
      { ...valid, uncertainty: ["fine", ""] },
    ];
    for (const invalid of invalidPackets) {
      expect(() => validateChangeContextPacket(room, "what_passed", invalid)).toThrow();
    }
  });
});
