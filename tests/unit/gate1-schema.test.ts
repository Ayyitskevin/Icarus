import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { sha256 } from "../../packages/core/src/digest.js";
import { IcarusError } from "../../packages/core/src/errors.js";
import {
  BROWSER_ACTION_LEDGER_MIGRATION,
  type Gate1MigrationToken,
  inspectGate1Schemas,
  LANDING_LEDGER_MIGRATION,
  migrateGate1Schema,
} from "../../packages/core/src/gate1-schema.js";
import { IcarusStore } from "../../packages/core/src/store.js";
import { createUnitStore } from "../support/unit-fixtures.js";

interface TestDatabase {
  exec(sql: string): void;
  close(): void;
}

const coreRequire = createRequire(new URL("../../packages/core/package.json", import.meta.url));
const betterSqlite3ModulePath = coreRequire.resolve("better-sqlite3");
const Database = coreRequire("better-sqlite3") as new (filename: string) => TestDatabase;

const cleanupRoots: string[] = [];

afterEach(() => {
  for (const root of cleanupRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function expectIcarusCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(IcarusError);
    expect((error as IcarusError).code).toBe(code);
  }
}

function databaseFamilyBytes(databasePath: string): Record<string, string> {
  const parent = path.dirname(databasePath);
  const basename = path.basename(databasePath);
  return Object.fromEntries(
    readdirSync(parent)
      .filter((name) => name === basename || name.startsWith(`${basename}-`))
      .sort()
      .map((name) => [name, sha256(readFileSync(path.join(parent, name)))]),
  );
}

function removeGate1Schemas(databasePath: string): void {
  const database = new Database(databasePath);
  database.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE landing_receipts;
    DROP TABLE landing_events;
    DROP TABLE landing_http_requests;
    DROP TABLE landing_operations;
    DROP TABLE landing_attempts;
    DROP TABLE landing_decisions;
    DROP TABLE landings;
    DROP TABLE landing_profiles;
    DROP TABLE browser_action_requests;
    PRAGMA wal_checkpoint(TRUNCATE);
  `);
  database.close();
}

function writeStateMarker(databasePath: string): void {
  writeFileSync(
    databasePath.replace(/icarus\.sqlite3$/, ".icarus-state-v1"),
    '{"application":"icarus","format":1}\n',
    { mode: 0o600 },
  );
}

function expectCoreSchemaRefusalWithoutWrite(databasePath: string, startupRefuses = true): void {
  const before = databaseFamilyBytes(databasePath);
  if (startupRefuses) {
    expectIcarusCode(() => inspectGate1Schemas(databasePath), "DATABASE_ERROR");
  } else {
    expect(inspectGate1Schemas(databasePath)).toEqual({
      browserActions: "missing",
      landing: "missing",
    });
  }
  expectIcarusCode(
    () => migrateGate1Schema(databasePath, BROWSER_ACTION_LEDGER_MIGRATION),
    "DATABASE_ERROR",
  );
  expect(databaseFamilyBytes(databasePath)).toEqual(before);
  expect(existsSync(`${databasePath}-wal`)).toBe(false);
  expect(existsSync(`${databasePath}-shm`)).toBe(false);
}

describe("Gate 1 schema maintenance", () => {
  test("creates both exact schema families for a new disposable database", () => {
    const fixture = createUnitStore();
    cleanupRoots.push(fixture.root);
    expect(inspectGate1Schemas(fixture.databasePath)).toEqual({
      browserActions: "valid",
      landing: "valid",
    });
    fixture.store.close();
  });

  test("requires browser then landing as separate one-shot migrations", () => {
    const fixture = createUnitStore();
    cleanupRoots.push(fixture.root);
    fixture.store.close();
    removeGate1Schemas(fixture.databasePath);
    writeFileSync(
      fixture.databasePath.replace(/icarus\.sqlite3$/, ".icarus-state-v1"),
      '{"application":"icarus","format":1}\n',
      { mode: 0o600 },
    );
    const beforeInspection = databaseFamilyBytes(fixture.databasePath);
    expect(inspectGate1Schemas(fixture.databasePath)).toEqual({
      browserActions: "missing",
      landing: "missing",
    });
    expect(databaseFamilyBytes(fixture.databasePath)).toEqual(beforeInspection);
    expect(existsSync(`${fixture.databasePath}-wal`)).toBe(false);
    expect(existsSync(`${fixture.databasePath}-shm`)).toBe(false);

    const beforeInvalidTokenRefusal = databaseFamilyBytes(fixture.databasePath);
    expectIcarusCode(
      () =>
        migrateGate1Schema(
          fixture.databasePath,
          "browser-action-ledger-v1,landing-ledger-v1" as Gate1MigrationToken,
        ),
      "INVALID_DATABASE_CONFIGURATION",
    );
    expect(databaseFamilyBytes(fixture.databasePath)).toEqual(beforeInvalidTokenRefusal);
    expect(existsSync(`${fixture.databasePath}-wal`)).toBe(false);
    expect(existsSync(`${fixture.databasePath}-shm`)).toBe(false);

    const beforeOrderRefusal = databaseFamilyBytes(fixture.databasePath);
    expectIcarusCode(
      () => migrateGate1Schema(fixture.databasePath, LANDING_LEDGER_MIGRATION),
      "MIGRATION_ORDER_REQUIRED",
    );
    expect(databaseFamilyBytes(fixture.databasePath)).toEqual(beforeOrderRefusal);
    expect(existsSync(`${fixture.databasePath}-wal`)).toBe(false);
    expect(existsSync(`${fixture.databasePath}-shm`)).toBe(false);

    migrateGate1Schema(fixture.databasePath, BROWSER_ACTION_LEDGER_MIGRATION);
    expect(inspectGate1Schemas(fixture.databasePath)).toEqual({
      browserActions: "valid",
      landing: "missing",
    });
    const beforeReuseRefusal = sha256(readFileSync(fixture.databasePath));
    expectIcarusCode(
      () => migrateGate1Schema(fixture.databasePath, BROWSER_ACTION_LEDGER_MIGRATION),
      "INVALID_DATABASE_CONFIGURATION",
    );
    expect(sha256(readFileSync(fixture.databasePath))).toBe(beforeReuseRefusal);

    migrateGate1Schema(fixture.databasePath, LANDING_LEDGER_MIGRATION);
    expect(inspectGate1Schemas(fixture.databasePath)).toEqual({
      browserActions: "valid",
      landing: "valid",
    });
    const reopened = new IcarusStore(fixture.databasePath);
    reopened.close();
  });

  test("inspects committed uncheckpointed WAL state without changing the source family", () => {
    const fixture = createUnitStore();
    cleanupRoots.push(fixture.root);
    fixture.store.close();
    const child = spawnSync(
      process.execPath,
      [
        "-e",
        `const Database = require(${JSON.stringify(betterSqlite3ModulePath)});
const database = new Database(${JSON.stringify(fixture.databasePath)});
database.pragma("wal_autocheckpoint = 0");
database.exec("BEGIN IMMEDIATE; DROP INDEX browser_action_requests_active_cancel; COMMIT;");
process.exit(0);`,
      ],
      { encoding: "utf8" },
    );
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(existsSync(`${fixture.databasePath}-wal`)).toBe(true);
    expect(existsSync(`${fixture.databasePath}-shm`)).toBe(true);
    const before = databaseFamilyBytes(fixture.databasePath);

    expectIcarusCode(() => inspectGate1Schemas(fixture.databasePath), "DATABASE_ERROR");

    expect(databaseFamilyBytes(fixture.databasePath)).toEqual(before);
  });

  test("refuses unexpected SQLite-family siblings without changing them", () => {
    const fixture = createUnitStore();
    cleanupRoots.push(fixture.root);
    fixture.store.close();
    writeFileSync(`${fixture.databasePath}-journal`, "unexpected", { mode: 0o600 });
    const before = databaseFamilyBytes(fixture.databasePath);

    expectIcarusCode(() => inspectGate1Schemas(fixture.databasePath), "DATABASE_ERROR");

    expect(databaseFamilyBytes(fixture.databasePath)).toEqual(before);
  });

  test.runIf(process.platform !== "win32")(
    "refuses migration from permissive state or database modes without writing",
    () => {
      const fixture = createUnitStore();
      cleanupRoots.push(fixture.root);
      fixture.store.close();
      removeGate1Schemas(fixture.databasePath);
      const markerPath = fixture.databasePath.replace(/icarus\.sqlite3$/, ".icarus-state-v1");
      writeFileSync(markerPath, '{"application":"icarus","format":1}\n', { mode: 0o600 });
      const stateRoot = path.dirname(fixture.databasePath);
      const before = sha256(readFileSync(fixture.databasePath));

      chmodSync(stateRoot, 0o750);
      expectIcarusCode(
        () => migrateGate1Schema(fixture.databasePath, BROWSER_ACTION_LEDGER_MIGRATION),
        "UNSAFE_STATE_ROOT",
      );
      expect(sha256(readFileSync(fixture.databasePath))).toBe(before);
      expect(existsSync(`${fixture.databasePath}-wal`)).toBe(false);

      chmodSync(stateRoot, 0o700);
      chmodSync(fixture.databasePath, 0o640);
      expectIcarusCode(
        () => migrateGate1Schema(fixture.databasePath, BROWSER_ACTION_LEDGER_MIGRATION),
        "UNSAFE_STATE_ROOT",
      );
      expect(sha256(readFileSync(fixture.databasePath))).toBe(before);
      expect(existsSync(`${fixture.databasePath}-wal`)).toBe(false);
    },
  );

  test("refuses migration from inside a Git checkout without writing", () => {
    const fixture = createUnitStore();
    cleanupRoots.push(fixture.root);
    fixture.store.close();
    removeGate1Schemas(fixture.databasePath);
    writeFileSync(
      fixture.databasePath.replace(/icarus\.sqlite3$/, ".icarus-state-v1"),
      '{"application":"icarus","format":1}\n',
      { mode: 0o600 },
    );
    mkdirSync(path.join(fixture.root, ".git"));
    const before = sha256(readFileSync(fixture.databasePath));

    expectIcarusCode(
      () => migrateGate1Schema(fixture.databasePath, BROWSER_ACTION_LEDGER_MIGRATION),
      "STATE_REPOSITORY_OVERLAP",
    );
    expect(sha256(readFileSync(fixture.databasePath))).toBe(before);
    expect(existsSync(`${fixture.databasePath}-wal`)).toBe(false);
  });

  test("refuses a partial family before a writable store opens", () => {
    const fixture = createUnitStore();
    cleanupRoots.push(fixture.root);
    fixture.store.close();
    const corruptor = new Database(fixture.databasePath);
    corruptor.exec(`
      DROP INDEX browser_action_requests_active_cancel;
      PRAGMA wal_checkpoint(TRUNCATE);
      PRAGMA journal_mode = DELETE;
    `);
    corruptor.close();
    const before = sha256(readFileSync(fixture.databasePath));

    expectIcarusCode(() => inspectGate1Schemas(fixture.databasePath), "DATABASE_ERROR");
    expectIcarusCode(() => new IcarusStore(fixture.databasePath), "DATABASE_ERROR");
    expect(sha256(readFileSync(fixture.databasePath))).toBe(before);
    expect(existsSync(`${fixture.databasePath}-wal`)).toBe(false);
  });

  test("refuses a partial landing family before a writable store opens", () => {
    const fixture = createUnitStore();
    cleanupRoots.push(fixture.root);
    fixture.store.close();
    const corruptor = new Database(fixture.databasePath);
    corruptor.exec(`
      DROP INDEX one_create_pr_post_per_landing;
      PRAGMA wal_checkpoint(TRUNCATE);
      PRAGMA journal_mode = DELETE;
    `);
    corruptor.close();
    const before = sha256(readFileSync(fixture.databasePath));

    expectIcarusCode(() => inspectGate1Schemas(fixture.databasePath), "DATABASE_ERROR");
    expectIcarusCode(() => new IcarusStore(fixture.databasePath), "DATABASE_ERROR");
    expect(sha256(readFileSync(fixture.databasePath))).toBe(before);
    expect(existsSync(`${fixture.databasePath}-wal`)).toBe(false);
  });

  test("refuses Gate 1 objects without the core schema before creating core tables", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "icarus-gate1-no-core-"));
    cleanupRoots.push(root);
    const databasePath = path.join(root, "icarus.sqlite3");
    const partial = new Database(databasePath);
    partial.exec("CREATE TABLE browser_action_requests (action_id TEXT PRIMARY KEY)");
    partial.close();
    const before = sha256(readFileSync(databasePath));

    expectIcarusCode(() => inspectGate1Schemas(databasePath), "DATABASE_ERROR");
    expectIcarusCode(() => new IcarusStore(databasePath), "DATABASE_ERROR");
    expect(sha256(readFileSync(databasePath))).toBe(before);
    expect(existsSync(`${databasePath}-wal`)).toBe(false);
  });

  test("refuses a lookalike runs table as an incomplete legacy schema without writing", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "icarus-gate1-lookalike-core-"));
    cleanupRoots.push(root);
    const databasePath = path.join(root, "icarus.sqlite3");
    const partial = new Database(databasePath);
    partial.exec("CREATE TABLE runs (id TEXT PRIMARY KEY)");
    partial.close();
    chmodSync(databasePath, 0o600);
    writeStateMarker(databasePath);

    expectCoreSchemaRefusalWithoutWrite(databasePath);
  });

  test.each([
    {
      label: "missing approval index",
      mutation: "DROP INDEX approvals_by_run;",
      startupRefuses: false,
    },
    {
      label: "missing patch-set table",
      mutation: "DROP TABLE checkpoint_files;",
      startupRefuses: true,
    },
    {
      label: "missing readable manifest",
      mutation: "DROP TABLE readable_manifests;",
      startupRefuses: false,
    },
    {
      label: "malformed started-operation index",
      mutation: `
        DROP INDEX one_started_operation_per_run;
        CREATE UNIQUE INDEX one_started_operation_per_run
        ON operations(kind)
        WHERE status = 'started';
      `,
      startupRefuses: true,
    },
    {
      label: "unknown core trigger",
      mutation: `
        CREATE TRIGGER unexpected_run_trigger
        AFTER INSERT ON runs
        BEGIN
          SELECT 1;
        END;
      `,
      startupRefuses: true,
    },
    {
      label: "wrong low user version",
      mutation: "PRAGMA user_version = 0;",
      startupRefuses: true,
    },
    {
      label: "wrong high user version",
      mutation: "PRAGMA user_version = 2;",
      startupRefuses: true,
    },
  ])("refuses $label before Gate 1 migration without writing", ({ mutation, startupRefuses }) => {
    const fixture = createUnitStore();
    cleanupRoots.push(fixture.root);
    fixture.store.close();
    removeGate1Schemas(fixture.databasePath);
    writeStateMarker(fixture.databasePath);
    const corruptor = new Database(fixture.databasePath);
    corruptor.exec(`
      ${mutation}
      PRAGMA wal_checkpoint(TRUNCATE);
      PRAGMA journal_mode = DELETE;
      `);
    corruptor.close();

    expectCoreSchemaRefusalWithoutWrite(fixture.databasePath, startupRefuses);
  });

  test("rejects arbitrary-named indexes and triggers attached to Gate 1 tables", () => {
    const fixture = createUnitStore();
    cleanupRoots.push(fixture.root);
    fixture.store.close();
    const corruptor = new Database(fixture.databasePath);
    corruptor.exec(`
      CREATE INDEX unrelated_browser_index
      ON browser_action_requests(actor);
      CREATE TRIGGER unrelated_landing_trigger
      AFTER INSERT ON landings
      BEGIN
        SELECT 1;
      END;
      PRAGMA wal_checkpoint(TRUNCATE);
      PRAGMA journal_mode = DELETE;
    `);
    corruptor.close();
    const before = sha256(readFileSync(fixture.databasePath));

    expectIcarusCode(() => inspectGate1Schemas(fixture.databasePath), "DATABASE_ERROR");
    expectIcarusCode(() => new IcarusStore(fixture.databasePath), "DATABASE_ERROR");
    expect(sha256(readFileSync(fixture.databasePath))).toBe(before);
    expect(existsSync(`${fixture.databasePath}-wal`)).toBe(false);
  });
});
