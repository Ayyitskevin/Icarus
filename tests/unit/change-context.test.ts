import { rmSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { buildChangeContext } from "../../packages/core/src/change-context.js";
import { buildChangeRoom } from "../../packages/core/src/change-room.js";
import { IcarusError } from "../../packages/core/src/errors.js";
import { planApprovalDigest } from "../../packages/core/src/policy.js";
import { createProviderConfig } from "../../packages/core/src/provider.js";
import type { IcarusStore } from "../../packages/core/src/store.js";
import type { ChangeContextQuestion, ChangeRoomProjection } from "../../packages/core/src/types.js";
import { CHANGE_CONTEXT_SCHEMA } from "../../packages/core/src/types.js";
import {
  approveChangeRoomPlan,
  createChangeRoomFixture,
  driveToAwaitingReview,
  driveToCompleted,
  driveToRolledBack,
  finishToAwaitingReview,
  prepareChangeRoomRun,
} from "../support/change-room-fixtures.js";
import {
  seedUnitProject,
  createUnitStore,
  UNIT_BASE_COMMIT,
  UNIT_PLAN,
  UNIT_RUN_ID,
  unitContextDigest,
  unitContextManifest,
} from "../support/unit-fixtures.js";

const cleanupRoots: string[] = [];

afterEach(() => {
  for (const root of cleanupRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function roomAt(store: IcarusStore, runId: string = UNIT_RUN_ID): ChangeRoomProjection {
  const project = store.getProject(store.getRun(runId).projectId);
  return buildChangeRoom(store.getChangeRoomSnapshot(runId), project);
}

function packetAt(
  store: IcarusStore,
  question: ChangeContextQuestion,
  runId: string = UNIT_RUN_ID,
) {
  return buildChangeContext(roomAt(store, runId), question);
}

function statements(packet: ReturnType<typeof packetAt>): string {
  return packet.components.map((entry) => entry.statement).join("\n");
}

function expectReceipts(packet: ReturnType<typeof packetAt>, room: ChangeRoomProjection): void {
  const cardIds = new Set(room.cards.map((card) => card.id));
  const sequences = new Set(room.timeline.map((event) => event.sequence));
  for (const component of packet.components) {
    expect(component.receipts.length).toBeGreaterThan(0);
    for (const receipt of component.receipts) {
      expect(cardIds.has(receipt.cardId)).toBe(true);
      for (const sequence of receipt.eventSequences) {
        expect(sequences.has(sequence)).toBe(true);
      }
      for (const digest of receipt.digests) {
        expect(digest).toMatch(/^[a-f0-9]{64}$/);
      }
    }
  }
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

describe("Change-context packet", () => {
  it("answers why_blocked at the context-egress gate with the exact digest", () => {
    const store = createUnitStore();
    cleanupRoots.push(store.root);
    const remoteProvider = createProviderConfig({
      kind: "openai",
      model: "remote-model",
      baseUrl: "https://api.openai.com/v1",
      inputUsdPerMillionTokens: 1,
      outputUsdPerMillionTokens: 2,
    });
    const { projectId } = seedUnitProject(store.store);
    store.store.createRun({
      id: UNIT_RUN_ID,
      projectId,
      task: "Update the greeting remotely",
      targets: UNIT_PLAN.targets,
      provider: remoteProvider,
    });
    store.store.pinRunBase(UNIT_RUN_ID, UNIT_BASE_COMMIT);
    const context = unitContextManifest();
    store.store.completePreparation(
      UNIT_RUN_ID,
      context,
      "/tmp/unit-context.json",
      unitContextDigest(context),
    );
    expect(store.store.getRun(UNIT_RUN_ID).state).toBe("awaiting_egress_approval");

    const packet = packetAt(store.store, "why_blocked");
    expect(packet.schema).toBe(CHANGE_CONTEXT_SCHEMA);
    expect(packet.generatedBy).toBe("deterministic_host_projection");
    const text = statements(packet);
    expect(text).toContain("context-egress approval");
    expect(text).toContain(unitContextDigest(context));
    expect(text).toContain("fenced browser mutation session");
    expect(text).toContain("read-only room cannot approve anything");
    expectReceipts(packet, roomAt(store.store));
    store.store.close();
  });

  it("answers why_blocked at the plan gate with the plan digest", () => {
    const fixture = createChangeRoomFixture();
    cleanupRoots.push(fixture.root);
    prepareChangeRoomRun(fixture.store);
    const projectRecord = fixture.store.getProject(fixture.projectId);
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

    const packet = packetAt(fixture.store, "why_blocked");
    const text = statements(packet);
    expect(text).toContain("plan approval");
    expect(text).toContain(digest);
    expect(text).toContain("no private worktree");
    expectReceipts(packet, roomAt(fixture.store));
    fixture.store.close();
  });

  it("answers why_blocked at review and warns a failed verification cannot be accepted", () => {
    const fixture = createChangeRoomFixture();
    cleanupRoots.push(fixture.root);
    const evidence = driveToAwaitingReview(fixture.store, "failed");
    const packet = packetAt(fixture.store, "why_blocked");
    const text = statements(packet);
    expect(text).toContain("Verification outcome is failed");
    expect(text).toContain(evidence.diffSha256);
    expect(text).toContain("cannot be accepted");
    expectReceipts(packet, roomAt(fixture.store));
    fixture.store.close();
  });

  it("answers why_blocked for a failed run with the recorded error and resume stage", () => {
    const fixture = createChangeRoomFixture();
    cleanupRoots.push(fixture.root);
    prepareChangeRoomRun(fixture.store);
    approveChangeRoomPlan(fixture.store);
    fixture.store.failRun(
      UNIT_RUN_ID,
      "running",
      new IcarusError("OPERATION_TIMEOUT", "Synthetic timeout"),
    );
    const packet = packetAt(fixture.store, "why_blocked");
    const text = statements(packet);
    expect(text).toContain("OPERATION_TIMEOUT");
    expect(text).toContain("Synthetic timeout");
    expect(text).toContain("explicit CLI resume");
    expect(text).toContain("running");
    expectReceipts(packet, roomAt(fixture.store));
    fixture.store.close();
  });

  it("answers why_blocked truthfully for a terminal run", () => {
    const fixture = createChangeRoomFixture();
    cleanupRoots.push(fixture.root);
    driveToCompleted(fixture.store);
    const packet = packetAt(fixture.store, "why_blocked");
    expect(statements(packet)).toContain("not blocked");
    expect(statements(packet)).toContain("completed");
    expectReceipts(packet, roomAt(fixture.store));
    fixture.store.close();
  });

  it("answers what_changed for a draft without inventing a change", () => {
    const fixture = createChangeRoomFixture();
    cleanupRoots.push(fixture.root);
    const packet = packetAt(fixture.store, "what_changed");
    expect(statements(packet)).toContain("No PatchSet proposal exists yet");
    expectReceipts(packet, roomAt(fixture.store));
    fixture.store.close();
  });

  it("answers what_changed for a completed run with digests and no landing claim", () => {
    const fixture = createChangeRoomFixture();
    cleanupRoots.push(fixture.root);
    const evidence = driveToCompleted(fixture.store);
    const packet = packetAt(fixture.store, "what_changed");
    const text = statements(packet);
    expect(text).toContain("a PatchSet of 1 file-scoped edit(s): modify src/greeting.txt");
    expect(text).toContain(evidence.diffSha256);
    expect(text).toContain("requires a separate recorded landing grant");
    expectReceipts(packet, roomAt(fixture.store));
    fixture.store.close();
  });

  it("answers what_passed without ever calling an absent result a pass", () => {
    const fixture = createChangeRoomFixture();
    cleanupRoots.push(fixture.root);
    const packet = packetAt(fixture.store, "what_passed");
    expect(statements(packet)).toContain("No verification has run");
    expect(statements(packet)).not.toContain("Latest verification outcome: passed");
    expectReceipts(packet, roomAt(fixture.store));
    fixture.store.close();
  });

  it("answers what_passed with per-check receipts after verification", () => {
    const fixture = createChangeRoomFixture();
    cleanupRoots.push(fixture.root);
    driveToAwaitingReview(fixture.store, "passed");
    const packet = packetAt(fixture.store, "what_passed");
    const text = statements(packet);
    expect(text).toContain("Latest verification outcome: passed");
    expect(text).toContain("Check unit (Unit check): passed, exit 0");
    expectReceipts(packet, roomAt(fixture.store));
    fixture.store.close();
  });

  it("answers what_remains_before_review across gates", () => {
    const fixture = createChangeRoomFixture();
    cleanupRoots.push(fixture.root);
    expect(statements(packetAt(fixture.store, "what_remains_before_review"))).toContain(
      "Planning must run first",
    );
    prepareChangeRoomRun(fixture.store);
    approveChangeRoomPlan(fixture.store);
    expect(statements(packetAt(fixture.store, "what_remains_before_review"))).toContain(
      "active execution stage",
    );
    finishToAwaitingReview(fixture.store, "failed");
    const reviewPacket = packetAt(fixture.store, "what_remains_before_review");
    expect(statements(reviewPacket)).toContain("Nothing remains before review");
    expect(statements(reviewPacket)).toContain("Review approval is impossible");
    fixture.store.close();
  });

  it("answers why_rolled_back with the rejecting review decision", () => {
    const fixture = createChangeRoomFixture();
    cleanupRoots.push(fixture.root);
    driveToRolledBack(fixture.store);
    const packet = packetAt(fixture.store, "why_rolled_back");
    const text = statements(packet);
    expect(text).toContain("Review rejected the change");
    expect(text).toContain("unit-operator");
    expect(text).toContain("checkpoint is preserved");
    expect(packet.uncertainty.join("\n")).toContain("not a free-text reason");
    expectReceipts(packet, roomAt(fixture.store));
    fixture.store.close();
  });

  it("answers why_rolled_back honestly when no rollback exists", () => {
    const fixture = createChangeRoomFixture();
    cleanupRoots.push(fixture.root);
    const packet = packetAt(fixture.store, "why_rolled_back");
    expect(statements(packet)).toContain("No rollback is recorded");
    expect(packet.omissions.join("\n")).toContain("has not recorded");
    expectReceipts(packet, roomAt(fixture.store));
    fixture.store.close();
  });

  it("keeps packets bounded, versioned, and cursor-pinned", () => {
    const fixture = createChangeRoomFixture();
    cleanupRoots.push(fixture.root);
    driveToCompleted(fixture.store);
    const room = roomAt(fixture.store);
    const packet = buildChangeContext(room, "what_changed");
    expect(packet.schema).toBe("icarus.change-context.v1");
    expect(packet.roomId).toBe(UNIT_RUN_ID);
    expect(packet.eventCursor).toBe(room.integrity.eventCursor);
    expect(packet.components.length).toBeLessThanOrEqual(8);
    expect(packet.generatedBy).toBe("deterministic_host_projection");
    fixture.store.close();
  });

  it("rejects an unknown question instead of guessing", () => {
    const fixture = createChangeRoomFixture();
    cleanupRoots.push(fixture.root);
    const room = roomAt(fixture.store);
    expectCode(
      () => buildChangeContext(room, "give_me_a_summary" as ChangeContextQuestion),
      "INVALID_REQUEST",
    );
    fixture.store.close();
  });
});
