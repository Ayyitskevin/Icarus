import { rmSync } from "node:fs";
import { createRequire } from "node:module";

import { afterEach, describe, expect, it } from "vitest";

import { IcarusError } from "../../packages/core/src/errors.js";
import { IcarusStore } from "../../packages/core/src/store.js";
import { createChangeRoomFixture, driveToCompleted } from "../support/change-room-fixtures.js";
import { makeUnitIdGenerator, UNIT_RUN_ID } from "../support/unit-fixtures.js";

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

describe("Run annotations", () => {
  it("appends and lists bounded operator annotations in insertion order", () => {
    const fixture = createChangeRoomFixture();
    cleanupRoots.push(fixture.root);
    const first = fixture.store.addRunAnnotation(
      UNIT_RUN_ID,
      "provider_plan",
      "kevin",
      "Plan omits the rollback note; watch it.",
    );
    const second = fixture.store.addRunAnnotation(UNIT_RUN_ID, "room", "kevin", "Second note.");
    expect(first.card).toBe("provider_plan");
    expect(first.runId).toBe(UNIT_RUN_ID);

    const annotations = fixture.store.listRunAnnotations(UNIT_RUN_ID);
    expect(annotations.map((annotation) => annotation.id)).toEqual([first.id, second.id]);
    expect(annotations.map((annotation) => annotation.card)).toEqual(["provider_plan", "room"]);
    fixture.store.close();
  });

  it("accepts annotations on a terminal run without touching lifecycle state", () => {
    const fixture = createChangeRoomFixture();
    cleanupRoots.push(fixture.root);
    driveToCompleted(fixture.store);
    const before = fixture.store.getRun(UNIT_RUN_ID);
    const cursorBefore = fixture.store.getChangeRoomSnapshot(UNIT_RUN_ID).eventCursor;

    fixture.store.addRunAnnotation(UNIT_RUN_ID, "review_decision", "kevin", "Accepted as-is.");

    const after = fixture.store.getRun(UNIT_RUN_ID);
    // An annotation is durable operator context, never lifecycle input: the run
    // row, the event stream, and approvals must remain byte-identical.
    expect(after).toEqual(before);
    expect(fixture.store.getChangeRoomSnapshot(UNIT_RUN_ID).eventCursor).toBe(cursorBefore);
    expect(fixture.store.listApprovals(UNIT_RUN_ID)).toHaveLength(2);
    fixture.store.close();
  });

  it("rejects unknown cards, invalid actors, and invalid bodies before any write", () => {
    const fixture = createChangeRoomFixture();
    cleanupRoots.push(fixture.root);
    expectCode(
      () => fixture.store.addRunAnnotation(UNIT_RUN_ID, "summary" as never, "kevin", "text"),
      "INVALID_ANNOTATION",
    );
    expectCode(
      () => fixture.store.addRunAnnotation(UNIT_RUN_ID, "room", "", "text"),
      "INVALID_ANNOTATION",
    );
    expectCode(
      () => fixture.store.addRunAnnotation(UNIT_RUN_ID, "room", "a".repeat(201), "text"),
      "INVALID_ANNOTATION",
    );
    expectCode(
      () => fixture.store.addRunAnnotation(UNIT_RUN_ID, "room", "ke\nvin", "text"),
      "INVALID_ANNOTATION",
    );
    expectCode(
      () => fixture.store.addRunAnnotation(UNIT_RUN_ID, "room", "kevin", ""),
      "INVALID_ANNOTATION",
    );
    expectCode(
      () => fixture.store.addRunAnnotation(UNIT_RUN_ID, "room", "kevin", "   "),
      "INVALID_ANNOTATION",
    );
    expectCode(
      () => fixture.store.addRunAnnotation(UNIT_RUN_ID, "room", "kevin", `bad\0body`),
      "INVALID_ANNOTATION",
    );
    expectCode(
      () => fixture.store.addRunAnnotation(UNIT_RUN_ID, "room", "kevin", "x".repeat(1_025)),
      "INVALID_ANNOTATION",
    );
    expect(fixture.store.listRunAnnotations(UNIT_RUN_ID)).toHaveLength(0);
    fixture.store.close();
  });

  it("rejects secret-shaped actor or body content instead of persisting it", () => {
    const fixture = createChangeRoomFixture();
    cleanupRoots.push(fixture.root);
    const secret = `sk-${"a".repeat(24)}`;
    expectCode(
      () => fixture.store.addRunAnnotation(UNIT_RUN_ID, "room", secret, "text"),
      "SECRET_INPUT_DETECTED",
    );
    expectCode(
      () => fixture.store.addRunAnnotation(UNIT_RUN_ID, "room", "kevin", `token is ${secret}`),
      "SECRET_INPUT_DETECTED",
    );
    expect(fixture.store.listRunAnnotations(UNIT_RUN_ID)).toHaveLength(0);
    fixture.store.close();
  });

  it("caps annotations per run to keep room responses bounded", () => {
    const fixture = createChangeRoomFixture();
    cleanupRoots.push(fixture.root);
    for (let index = 0; index < 32; index += 1) {
      fixture.store.addRunAnnotation(UNIT_RUN_ID, "room", "kevin", `note ${index}`);
    }
    expectCode(
      () => fixture.store.addRunAnnotation(UNIT_RUN_ID, "room", "kevin", "one too many"),
      "ANNOTATION_LIMIT_REACHED",
    );
    expect(fixture.store.listRunAnnotations(UNIT_RUN_ID)).toHaveLength(32);
    fixture.store.close();
  });

  it("requires the run to exist for both writing and listing", () => {
    const fixture = createChangeRoomFixture();
    cleanupRoots.push(fixture.root);
    const missing = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    expectCode(() => fixture.store.addRunAnnotation(missing, "room", "kevin", "text"), "NOT_FOUND");
    expectCode(() => fixture.store.listRunAnnotations(missing), "NOT_FOUND");
    fixture.store.close();
  });

  it("fails closed on a corrupt persisted annotation", () => {
    const fixture = createChangeRoomFixture();
    cleanupRoots.push(fixture.root);
    fixture.store.addRunAnnotation(UNIT_RUN_ID, "room", "kevin", "fine");
    const database = new Database(fixture.databasePath);
    database
      .prepare("UPDATE run_annotations SET card = ? WHERE run_id = ?")
      .run("not-a-card", UNIT_RUN_ID);
    database.close();
    expectCode(() => fixture.store.listRunAnnotations(UNIT_RUN_ID), "DATABASE_ERROR");
    fixture.store.close();
  });

  it("migrates a version-1 database forward without losing existing state", () => {
    const fixture = createChangeRoomFixture();
    cleanupRoots.push(fixture.root);
    driveToCompleted(fixture.store);
    const runBefore = fixture.store.getRun(UNIT_RUN_ID);
    fixture.store.close();

    // Simulate the version-1 layout: no annotation table and user_version 1.
    const database = new Database(fixture.databasePath);
    database.prepare("DROP TABLE run_annotations").run();
    database.prepare("PRAGMA user_version = 1").run();
    database.close();

    const reopened = new IcarusStore(fixture.databasePath, {
      now: () => "2026-07-19T12:05:00.000Z",
      id: makeUnitIdGenerator(),
    });
    const version = new Database(fixture.databasePath).prepare("PRAGMA user_version").get() as {
      readonly user_version: number;
    };
    expect(version.user_version).toBe(2);
    expect(reopened.getRun(UNIT_RUN_ID)).toEqual(runBefore);
    const annotation = reopened.addRunAnnotation(UNIT_RUN_ID, "room", "kevin", "post-migration");
    expect(reopened.listRunAnnotations(UNIT_RUN_ID)).toHaveLength(1);
    expect(reopened.listRunAnnotations(UNIT_RUN_ID)[0]?.id).toBe(annotation.id);
    reopened.close();
  });

  it("refuses a database from a newer schema version", () => {
    const fixture = createChangeRoomFixture();
    cleanupRoots.push(fixture.root);
    fixture.store.close();
    const database = new Database(fixture.databasePath);
    database.prepare("PRAGMA user_version = 99").run();
    database.close();
    expectCode(
      () =>
        new IcarusStore(fixture.databasePath, {
          now: () => "2026-07-19T12:05:00.000Z",
          id: makeUnitIdGenerator(),
        }),
      "UNSUPPORTED_DATABASE_VERSION",
    );
  });
});
