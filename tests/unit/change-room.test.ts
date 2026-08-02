import { rmSync } from "node:fs";
import { createRequire } from "node:module";

import { afterEach, describe, expect, it } from "vitest";

import { buildChangeRoom } from "../../packages/core/src/change-room.js";
import { IcarusError } from "../../packages/core/src/errors.js";
import { planApprovalDigest } from "../../packages/core/src/policy.js";
import type { IcarusStore } from "../../packages/core/src/store.js";
import type {
  BaseContextCardBody,
  ChangeRoomCardKind,
  CheckOutcomesCardBody,
  CheckpointCardBody,
  PatchsetCardBody,
  PlanApprovalCardBody,
  ProviderPlanCardBody,
  ReviewDecisionCardBody,
  RollbackRestorationCardBody,
  TerminalStateCardBody,
} from "../../packages/core/src/types.js";
import { CHANGE_ROOM_SCHEMA } from "../../packages/core/src/types.js";
import {
  approveChangeRoomPlan,
  createChangeRoomFixture,
  driveToAwaitingReview,
  driveToCompleted,
  driveToRolledBack,
  prepareChangeRoomRun,
} from "../support/change-room-fixtures.js";
import { UNIT_PLAN, UNIT_RUN_ID } from "../support/unit-fixtures.js";

interface TestDatabase {
  prepare(sql: string): {
    run(...parameters: unknown[]): unknown;
    get(...parameters: unknown[]): unknown;
    all(...parameters: unknown[]): unknown[];
  };
  close(): void;
}

const Database = createRequire(new URL("../../packages/core/package.json", import.meta.url))(
  "better-sqlite3",
) as new (
  filename: string,
) => TestDatabase;

const cleanupRoots: string[] = [];

afterEach(() => {
  for (const root of cleanupRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function project(store: IcarusStore) {
  return store.getProject(store.getRun(UNIT_RUN_ID).projectId);
}

function roomAt(store: IcarusStore) {
  return buildChangeRoom(store.getChangeRoomSnapshot(UNIT_RUN_ID), project(store));
}

function cardBody<T>(room: ReturnType<typeof roomAt>, kind: ChangeRoomCardKind): T {
  const card = room.cards.find((candidate) => candidate.kind === kind);
  expect(card, `card ${kind}`).toBeDefined();
  return card?.body as T;
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(IcarusError);
    expect((error as IcarusError).code).toBe(code);
  }
}

describe("Change Room projection", () => {
  it("projects a draft run with pending cards and operator-asserted scope", () => {
    const fixture = createChangeRoomFixture();
    cleanupRoots.push(fixture.root);
    const room = roomAt(fixture.store);

    expect(room.schema).toBe(CHANGE_ROOM_SCHEMA);
    expect(room.roomId).toBe(UNIT_RUN_ID);
    expect(room.state).toBe("preparing");
    expect(room.generatedBy).toBe("deterministic_host_projection");
    expect(room.cards.map((card) => card.kind)).toEqual([
      "task_scope",
      "base_context",
      "provider_plan",
      "plan_approval",
      "patchset",
      "registered_checks",
      "check_outcomes",
      "review_decision",
      "checkpoint",
      "rollback_restoration",
      "terminal_state",
    ]);
    expect(room.cards.map((card) => card.id)).toEqual([
      "card-task-scope",
      "card-base-context",
      "card-provider-plan",
      "card-plan-approval",
      "card-patchset",
      "card-registered-checks",
      "card-check-outcomes",
      "card-review-decision",
      "card-checkpoint",
      "card-rollback-restoration",
      "card-terminal-state",
    ]);

    const scope = room.cards[0];
    expect(scope?.provenanceClass).toBe("operator_assertion");
    expect(scope?.status).toBe("available");
    expect(scope?.refs).toEqual([{ kind: "event_sequence", sequence: 1 }]);

    expect(room.cards[1]?.status).toBe("pending");
    expect(room.cards[2]?.status).toBe("pending");
    expect(room.cards[3]?.status).toBe("pending");
    expect(room.cards[4]?.status).toBe("pending");
    expect(room.cards[6]?.status).toBe("pending");
    expect(cardBody<CheckOutcomesCardBody>(room, "check_outcomes").outcome).toBe("not_run");
    expect(room.cards[8]?.status).toBe("pending");
    expect(cardBody<CheckpointCardBody>(room, "checkpoint").status).toBe("not_saved");
    expect(room.cards[9]?.status).toBe("not_applicable");

    const terminal = cardBody<TerminalStateCardBody>(room, "terminal_state");
    expect(terminal.terminal).toBe(false);
    expect(terminal.terminalReason).toBeNull();

    expect(room.integrity.digestSemantics).toBe("byte_binding_only");
    expect(room.integrity.timelineTruncated).toBe(false);
    expect(room.integrity.eventCursor).toBe(1);
    expect(room.integrity.note).toContain("not fresh authorization");
    expect(room.annotations).toEqual([]);
    fixture.store.close();
  });

  it("marks a planned loopback run as an unapproved untrusted proposal", () => {
    const fixture = createChangeRoomFixture();
    cleanupRoots.push(fixture.root);
    prepareChangeRoomRun(fixture.store);
    const projectRecord = project(fixture.store);
    const run = fixture.store.getRun(UNIT_RUN_ID);
    const digest = planApprovalDigest({
      task: run.task,
      baseCommit: run.baseCommit,
      contextSha256: run.contextSha256,
      targets: run.context.targets,
      provider: run.provider,
      checks: projectRecord.checks,
      sandbox: projectRecord.sandbox,
      ceiling: projectRecord.ceiling,
      plan: UNIT_PLAN,
      readableManifest: null,
    });
    fixture.store.recordPlanAndAwaitApproval(UNIT_RUN_ID, UNIT_PLAN, digest);

    const room = roomAt(fixture.store);
    const base = cardBody<BaseContextCardBody>(room, "base_context");
    expect(base.egress.state).toBe("not_required_loopback");
    expect(base.contextSha256).toMatch(/^[a-f0-9]{64}$/);

    const plan = cardBody<ProviderPlanCardBody>(room, "provider_plan");
    expect(plan.trustLabel).toBe("untrusted_proposal");
    expect(plan.plan?.summary).toBe("Replace the greeting.");
    expect(plan.planSha256).toBe(digest);
    expect(room.cards[2]?.provenanceClass).toBe("provider_output");
    expect(cardBody<PlanApprovalCardBody>(room, "plan_approval").approval).toBeNull();
    fixture.store.close();
  });

  it("projects verification, checkpoint, and patch evidence at review", () => {
    const fixture = createChangeRoomFixture();
    cleanupRoots.push(fixture.root);
    const evidence = driveToAwaitingReview(fixture.store, "passed");
    const room = roomAt(fixture.store);

    const patchset = cardBody<PatchsetCardBody>(room, "patchset");
    expect(patchset.patchSet?.edits).toHaveLength(1);
    expect(patchset.patchSet?.edits[0]?.path).toBe("src/greeting.txt");
    expect(patchset.patchSet?.edits[0]?.op).toBe("modify");
    expect(patchset.patchSet?.edits[0]?.replacementCount).toBe(1);
    expect(patchset.patchSetEditsTruncated).toBe(false);
    expect(patchset.actionStatus).toBe("materialized");
    expect(patchset.diffSha256).toBe(evidence.diffSha256);
    expect(patchset.diffBytes).toBe(Buffer.byteLength(evidence.diff, "utf8"));
    expect(patchset.diff).toBe(evidence.diff);
    expect(patchset.changedPaths).toEqual(["src/greeting.txt"]);
    expect(patchset.note).toContain("untrusted provider output");
    expect(room.cards[4]?.indicators.redacted).toBe(true);

    const outcomes = cardBody<CheckOutcomesCardBody>(room, "check_outcomes");
    expect(outcomes.outcome).toBe("passed");
    expect(outcomes.checks).toHaveLength(1);
    expect(outcomes.checks[0]?.outcome).toBe("passed");
    expect(outcomes.checks[0]?.exitCode).toBe(0);
    expect(room.cards[6]?.provenanceClass).toBe("verification_evidence");
    expect(
      room.cards[6]?.refs.filter((ref) => ref.kind === "event_sequence").length,
    ).toBeGreaterThan(0);

    const checkpoint = cardBody<CheckpointCardBody>(room, "checkpoint");
    expect(checkpoint.status).toBe("saved");
    expect(checkpoint.sha256).toBe(evidence.checkpointSha256);
    expect(checkpoint.note).toContain("not a fresh rehash");

    const review = cardBody<ReviewDecisionCardBody>(room, "review_decision");
    expect(review.decision).toBeNull();
    fixture.store.close();
  });

  it("records the review decision and completed terminal outcome", () => {
    const fixture = createChangeRoomFixture();
    cleanupRoots.push(fixture.root);
    const evidence = driveToCompleted(fixture.store);
    const room = roomAt(fixture.store);

    const review = cardBody<ReviewDecisionCardBody>(room, "review_decision");
    expect(review.decision?.decision).toBe("approve");
    expect(review.decision?.actor).toBe("unit-operator");
    expect(review.decision?.digest).toBe(evidence.diffSha256);
    expect(room.cards[7]?.provenanceClass).toBe("approval_decision");

    const terminal = cardBody<TerminalStateCardBody>(room, "terminal_state");
    expect(terminal.terminal).toBe(true);
    expect(terminal.terminalReason).toBe("completed");

    const patchset = cardBody<PatchsetCardBody>(room, "patchset");
    expect(patchset.actionStatus).toBe("completed");
    fixture.store.close();
  });

  it("records rollback evidence after review rejection", () => {
    const fixture = createChangeRoomFixture();
    cleanupRoots.push(fixture.root);
    driveToRolledBack(fixture.store);
    const room = roomAt(fixture.store);

    const review = cardBody<ReviewDecisionCardBody>(room, "review_decision");
    expect(review.decision?.decision).toBe("reject");

    const recovery = cardBody<RollbackRestorationCardBody>(room, "rollback_restoration");
    expect(recovery.records).toHaveLength(1);
    expect(recovery.records[0]?.kind).toBe("rollback");
    expect(recovery.records[0]?.decision).toBe("reject");
    expect(recovery.records[0]?.completed).toBe(true);
    expect(recovery.records[0]?.completedSequence).not.toBeNull();
    expect(recovery.note).toContain("Neither commits");

    const terminal = cardBody<TerminalStateCardBody>(room, "terminal_state");
    expect(terminal.terminalReason).toBe("rolled_back");

    const patchset = cardBody<PatchsetCardBody>(room, "patchset");
    expect(patchset.actionStatus).toBe("reverted");
    fixture.store.close();
  });

  it("records restoration evidence through re-verification", () => {
    const fixture = createChangeRoomFixture();
    cleanupRoots.push(fixture.root);
    const evidence = driveToRolledBack(fixture.store);
    fixture.store.approveRestore(UNIT_RUN_ID, evidence.checkpointSha256, "unit-operator");
    fixture.store.finishRestore(UNIT_RUN_ID);
    const room = roomAt(fixture.store);

    const recovery = cardBody<RollbackRestorationCardBody>(room, "rollback_restoration");
    expect(recovery.records.map((record) => record.kind)).toEqual(["rollback", "restore"]);
    expect(recovery.records[1]?.completed).toBe(true);
    expect(room.state).toBe("verifying");
    fixture.store.close();
  });

  it("marks a failed run as a system failure with the recorded error", () => {
    const fixture = createChangeRoomFixture();
    cleanupRoots.push(fixture.root);
    prepareChangeRoomRun(fixture.store);
    approveChangeRoomPlan(fixture.store);
    fixture.store.failRun(
      UNIT_RUN_ID,
      "running",
      new IcarusError("INTERRUPTED", "Synthetic interruption"),
    );
    const room = roomAt(fixture.store);

    const terminalCard = room.cards[10];
    expect(terminalCard?.provenanceClass).toBe("system_failure");
    const terminal = cardBody<TerminalStateCardBody>(room, "terminal_state");
    expect(terminal.terminal).toBe(true);
    expect(terminal.terminalReason).toBe("failed:INTERRUPTED");
    expect(terminal.lastError?.code).toBe("INTERRUPTED");
    expect(terminal.resumeState).toBe("running");
    fixture.store.close();
  });

  it("is deterministic across repeated reads", () => {
    const fixture = createChangeRoomFixture();
    cleanupRoots.push(fixture.root);
    driveToCompleted(fixture.store);
    const first = roomAt(fixture.store);
    const second = roomAt(fixture.store);
    expect(first).toEqual(second);
    fixture.store.close();
  });

  it("surfaces CLI annotations as durable operator context in insertion order", () => {
    const fixture = createChangeRoomFixture();
    cleanupRoots.push(fixture.root);
    driveToAwaitingReview(fixture.store, "passed");
    fixture.store.addRunAnnotation(
      UNIT_RUN_ID,
      "check_outcomes",
      "kevin",
      "Flaky on NFS, fine here.",
    );
    fixture.store.addRunAnnotation(UNIT_RUN_ID, "room", "kevin", "Overall looks right.");
    const room = roomAt(fixture.store);

    expect(room.annotations).toHaveLength(2);
    expect(room.annotations[0]?.card).toBe("check_outcomes");
    expect(room.annotations[0]?.actor).toBe("kevin");
    expect(room.annotations[1]?.card).toBe("room");
    fixture.store.close();
  });

  it("keeps the bounded timeline truthful when history exceeds the tail", () => {
    const fixture = createChangeRoomFixture();
    cleanupRoots.push(fixture.root);
    driveToCompleted(fixture.store);
    const highWater = fixture.store.getChangeRoomSnapshot(UNIT_RUN_ID).eventCursor;
    const database = new Database(fixture.databasePath);
    const insert = database.prepare(
      "INSERT INTO run_events (run_id, sequence, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    for (let offset = 1; offset <= 210; offset += 1) {
      insert.run(
        UNIT_RUN_ID,
        highWater + offset,
        "operation.started",
        JSON.stringify({ kind: "sandbox.verify" }),
        "2026-07-19T12:00:00.000Z",
      );
    }
    database.close();
    const room = roomAt(fixture.store);

    expect(room.timeline.length).toBe(200);
    expect(room.integrity.timelineTruncated).toBe(true);
    expect(room.integrity.eventCount).toBe(room.integrity.eventCursor);
    expect(room.integrity.eventCount).toBe(highWater + 210);
    // The task/scope body stays authoritative from the run row while the card
    // honestly reports that its originating event left the retained tail.
    const scope = room.cards[0];
    expect(scope?.refs).toEqual([]);
    expect(scope?.indicators.unavailableEvidence).toBe(true);
    fixture.store.close();
  });

  it("fails closed on a corrupt checkpoint digest instead of projecting it", () => {
    const fixture = createChangeRoomFixture();
    cleanupRoots.push(fixture.root);
    driveToAwaitingReview(fixture.store, "passed");
    const database = new Database(fixture.databasePath);
    database
      .prepare("UPDATE checkpoints SET checkpoint_sha256 = ? WHERE run_id = ?")
      .run("not-a-digest", UNIT_RUN_ID);
    database.close();

    expectCode(() => fixture.store.getChangeRoomSnapshot(UNIT_RUN_ID), "DATABASE_ERROR");
    fixture.store.close();
  });

  it("never exposes private checkpoint bytes in the snapshot", () => {
    const fixture = createChangeRoomFixture();
    cleanupRoots.push(fixture.root);
    driveToAwaitingReview(fixture.store, "passed");
    const snapshot = fixture.store.getChangeRoomSnapshot(UNIT_RUN_ID);
    expect(snapshot.checkpoint).not.toBeNull();
    expect(Object.keys(snapshot.checkpoint ?? {}).sort()).toEqual(["createdAt", "sha256"]);
    fixture.store.close();
  });
});
