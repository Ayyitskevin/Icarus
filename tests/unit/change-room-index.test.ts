import { rmSync } from "node:fs";
import { createRequire } from "node:module";

import { afterEach, describe, expect, it } from "vitest";

import { IcarusError } from "../../packages/core/src/errors.js";
import {
  createChangeRoomFixture,
  driveToAwaitingReview,
  driveToCompleted,
  driveToRolledBack,
} from "../support/change-room-fixtures.js";
import {
  createUnitStore,
  seedUnitProject,
  UNIT_PROVIDER,
  UNIT_RUN_ID,
} from "../support/unit-fixtures.js";

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

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(IcarusError);
    expect((error as IcarusError).code).toBe(code);
  }
}

function indexRunId(index: number): string {
  return `20000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function insertIndexRun(
  database: TestDatabase,
  projectId: string,
  index: number,
  options: { readonly state?: string; readonly errorCode?: string | null } = {},
): void {
  database
    .prepare(
      `INSERT INTO runs
        (id, project_id, task, target, provider_json, state, base_commit, context_json,
         context_artifact_path, context_sha256, error_code, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, '', '{}', '/tmp/context.json', '', ?, ?, ?)`,
    )
    .run(
      indexRunId(index),
      projectId,
      `Change Room index task ${index}`,
      `src/run-${index}.txt`,
      JSON.stringify(UNIT_PROVIDER),
      options.state ?? "completed",
      options.errorCode ?? null,
      "2026-07-20T12:00:00.000Z",
      "2026-07-20T12:01:00.000Z",
    );
}

describe("Change Room index page", () => {
  it("returns an empty truthful page for empty history", () => {
    const bare = createUnitStore();
    cleanupRoots.push(bare.root);
    seedUnitProject(bare.store);
    const page = bare.store.openChangeRoomPage();
    expect(page).toEqual({ before: 1, snapshot: 0, nextBefore: 1, hasMore: false, rooms: [] });
    bare.store.close();
  });

  it("projects provider, verification, state, and terminal metadata per room", () => {
    const fixture = createChangeRoomFixture();
    cleanupRoots.push(fixture.root);
    driveToCompleted(fixture.store);
    const page = fixture.store.openChangeRoomPage();
    expect(page.rooms).toHaveLength(1);
    const room = page.rooms[0];
    expect(room?.roomId).toBe(UNIT_RUN_ID);
    expect(room?.state).toBe("completed");
    expect(room?.verificationOutcome).toBe("passed");
    expect(room?.provider).toEqual({
      kind: "ollama",
      model: "unit-model",
      locality: "loopback",
      privacyClass: "local_process",
    });
    expect(room?.terminalReason).toBe("completed");
    expect(room?.createdAt).toBe("2026-07-19T12:00:00.000Z");
    expect(room?.updatedAt).toBe("2026-07-19T12:00:00.000Z");
    fixture.store.close();
  });

  it("reports not_run verification and no terminal reason for active runs", () => {
    const fixture = createChangeRoomFixture();
    cleanupRoots.push(fixture.root);
    const page = fixture.store.openChangeRoomPage();
    expect(page.rooms[0]?.verificationOutcome).toBe("not_run");
    expect(page.rooms[0]?.terminalReason).toBeNull();
    fixture.store.close();
  });

  it("derives terminal reasons for failed and rolled-back runs", () => {
    const fixture = createChangeRoomFixture();
    cleanupRoots.push(fixture.root);
    driveToRolledBack(fixture.store);
    expect(fixture.store.openChangeRoomPage().rooms[0]?.terminalReason).toBe("rolled_back");

    const failed = createChangeRoomFixture();
    cleanupRoots.push(failed.root);
    driveToAwaitingReview(failed.store, "failed");
    failed.store.failRun(
      UNIT_RUN_ID,
      "awaiting_review",
      new IcarusError("SANDBOX_UNAVAILABLE", "Synthetic sandbox loss"),
    );
    const page = failed.store.openChangeRoomPage();
    expect(page.rooms[0]?.state).toBe("failed");
    expect(page.rooms[0]?.terminalReason).toBe("failed:SANDBOX_UNAVAILABLE");
    expect(page.rooms[0]?.verificationOutcome).toBe("failed");
    failed.store.close();
    fixture.store.close();
  });

  it("pages newest-first within a pinned snapshot and validates cursors", () => {
    const fixture = createChangeRoomFixture();
    cleanupRoots.push(fixture.root);
    const database = new Database(fixture.databasePath);
    for (let index = 1; index <= 13; index += 1) {
      insertIndexRun(database, fixture.projectId, index);
    }
    database.close();

    const first = fixture.store.openChangeRoomPage();
    expect(first.rooms).toHaveLength(12);
    expect(first.hasMore).toBe(true);
    expect(first.rooms[0]?.roomId).toBe(indexRunId(13));
    expect(first.rooms.at(-1)?.roomId).toBe(indexRunId(2));

    const second = fixture.store.listChangeRoomPage(first.nextBefore, first.snapshot);
    expect(second.rooms).toHaveLength(2);
    expect(second.rooms.map((room) => room.roomId)).toEqual([indexRunId(2 - 1), UNIT_RUN_ID]);
    expect(second.hasMore).toBe(false);

    expectCode(() => fixture.store.listChangeRoomPage(0, first.snapshot), "INVALID_RUN_CURSOR");
    expectCode(
      () => fixture.store.listChangeRoomPage(first.snapshot + 2, first.snapshot),
      "INVALID_RUN_CURSOR",
    );
    expectCode(
      () => fixture.store.listChangeRoomPage(first.nextBefore, first.snapshot + 100),
      "INVALID_RUN_CURSOR",
    );
    fixture.store.close();
  });

  it("fails closed when provider or verification columns cannot be projected", () => {
    const fixture = createChangeRoomFixture();
    cleanupRoots.push(fixture.root);
    const database = new Database(fixture.databasePath);
    database
      .prepare("UPDATE runs SET provider_json = ? WHERE id = ?")
      .run("not-json-at-all", UNIT_RUN_ID);
    database.close();
    // A corrupted provider identity is database corruption, not a room with an
    // unknown model: the page must fail rather than guess.
    expectCode(() => fixture.store.openChangeRoomPage(), "DATABASE_ERROR");
    fixture.store.close();
  });

  it("fails closed when verification evidence exceeds the projection ceiling", () => {
    const fixture = createChangeRoomFixture();
    cleanupRoots.push(fixture.root);
    driveToCompleted(fixture.store);
    const oversized = `{"outcome":"passed","pad":"${"x".repeat(4_200_000)}"}`;
    const database = new Database(fixture.databasePath);
    database
      .prepare("UPDATE runs SET verification_json = ? WHERE id = ?")
      .run(oversized, UNIT_RUN_ID);
    database.close();
    expectCode(() => fixture.store.openChangeRoomPage(), "DATABASE_ERROR");
    fixture.store.close();
  });

  it("fails closed on an invalid persisted verification outcome or error code", () => {
    const fixture = createChangeRoomFixture();
    cleanupRoots.push(fixture.root);
    const database = new Database(fixture.databasePath);
    database
      .prepare("UPDATE runs SET verification_json = ? WHERE id = ?")
      .run('{"outcome":"maybe"}', UNIT_RUN_ID);
    database.close();
    expectCode(() => fixture.store.openChangeRoomPage(), "DATABASE_ERROR");
    fixture.store.close();

    const second = createChangeRoomFixture();
    cleanupRoots.push(second.root);
    const tampered = new Database(second.databasePath);
    tampered
      .prepare("UPDATE runs SET state = 'failed', error_code = 'lowercase' WHERE id = ?")
      .run(UNIT_RUN_ID);
    tampered.close();
    expectCode(() => second.store.openChangeRoomPage(), "DATABASE_ERROR");
    second.store.close();
  });
});
