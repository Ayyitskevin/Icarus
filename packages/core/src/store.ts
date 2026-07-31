import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { containsSecretShapedContent } from "./context.js";
import { digestJson, sha256 } from "./digest.js";
import { IcarusError, invariant } from "./errors.js";
import {
  assertCheckProfiles,
  assertReadableManifest,
  assertRepositoryRelativePath,
  assertSandboxProfile,
  assertSunCeiling,
  checkpointDigest,
  MAX_SESSION_ITERATIONS,
  planApprovalDigest,
  readableManifestDigest,
  treeCheckpointDigest,
} from "./policy.js";
import { assertTransition } from "./state-machine.js";
import type {
  ApprovalRecord,
  CapabilityGrant,
  CheckProfile,
  CheckpointFile,
  ContextManifest,
  EditProposal,
  EventRecord,
  EventSummaryRecord,
  JsonValue,
  OperationFinish,
  OperationToken,
  PatchSet,
  PlanProposal,
  ProjectRecord,
  ProviderConfig,
  ReadableManifest,
  ReadableManifestEntry,
  RepositoryRecord,
  RunEventHistoryPage,
  RunEventPage,
  RunHistory,
  RunPresentationSnapshot,
  RunRecord,
  RunState,
  RunVerificationAttemptsSnapshot,
  SandboxProfile,
  SunCeiling,
  VerificationEvidence,
  WorkspaceProjectEntry,
  WorkspaceProjectPage,
  WorkspaceRunPage,
  WorkspaceRunSummary,
} from "./types.js";
import { CONTEXT_AUDIT_POLICY_VERSION } from "./types.js";
import { readRunVerificationAttempts } from "./verification-provenance.js";

type Row = Record<string, unknown>;

export const CANCELLATION_RECOVERY_OPERATION_KIND = "cancellation.recovery";
/** Operation kind whose ledger rows count spent repair attempts (ADR 0024). */
/**
 * The counted kind for a session iteration (ADR 0026, superseding the ADR 0024
 * repair grant). The exported name changed with the concept; the string did
 * not, because ledger rows already charged under it must keep counting. A
 * rename here would silently reset every in-flight run's spent iterations.
 */
export const SESSION_ITERATION_OPERATION_KIND = "provider.revise";
export const CANCELLATION_RECOVERY_RUNTIME_MS = 120_000;
export const MAX_CANCELLATION_RECOVERY_ATTEMPTS = 2;
const SESSION_CHECK_OPERATION_KIND = "session.tool.exec.check";
const SESSION_PATCH_OPERATION_KIND = "session.tool.mutation.patchset";
const SESSION_RECONCILE_OPERATION_KIND = "session.reconcile";
const SESSION_REPORT_DONE_OPERATION_KIND = "session.control.report_done";
const SESSION_REQUEST_HUMAN_OPERATION_KIND = "session.control.request_human_input";
const REVIEW_VALIDATION_OPERATION_KIND = "review.validate";
const CHECKPOINT_ROLLBACK_OPERATION_KIND = "checkpoint.rollback";
const CHECKPOINT_RESTORE_OPERATION_KIND = "checkpoint.restore";
export const RUN_EVENT_PAGE_LIMIT = 64;
export const RUN_PRESENTATION_EVENT_LIMIT = 200;
export const RUN_PRESENTATION_APPROVAL_LIMIT = 12;
export const WORKSPACE_RUN_PAGE_LIMIT = 12;
export const WORKSPACE_PROJECT_PAGE_LIMIT = 12;
export const WORKSPACE_PROJECT_CHECKS_MAX_BYTES = 1024 * 1024;
export const WORKSPACE_PROJECT_PROFILE_MAX_BYTES = 16 * 1024;
const APPROVAL_RUN_ID_MAX_BYTES = 64;
const APPROVAL_KIND_MAX_BYTES = 16;
const APPROVAL_DIGEST_MAX_BYTES = 64;
const APPROVAL_ACTOR_MAX_BYTES = 200;
const APPROVAL_DECISION_MAX_BYTES = 16;
const EVENT_TYPE_MAX_BYTES = 128;
const EVENT_TIMESTAMP_MAX_BYTES = 64;
const RUN_SUMMARY_TASK_MAX_BYTES = 8 * 1024;
const RUN_SUMMARY_TARGET_MAX_BYTES = 1_024;
const PROJECT_NAME_MAX_BYTES = 100;
const PROJECT_BASE_REF_MAX_BYTES = 256;
const REPOSITORY_PATH_MAX_BYTES = 4_096;
const BOUNDED_PROJECT_COLUMNS = `
  CASE WHEN typeof(p.id) = 'text' AND octet_length(p.id) <= 64
       THEN p.id END AS project_id,
  CASE WHEN typeof(p.name) = 'text' AND octet_length(p.name) <= ${PROJECT_NAME_MAX_BYTES}
       THEN p.name END AS project_name,
  CASE WHEN typeof(p.repository_id) = 'text' AND octet_length(p.repository_id) <= 64
       THEN p.repository_id END AS repository_id,
  CASE WHEN typeof(p.base_ref) = 'text' AND octet_length(p.base_ref) <= ${PROJECT_BASE_REF_MAX_BYTES}
       THEN p.base_ref END AS base_ref,
  CASE WHEN typeof(p.checks_json) = 'text'
         AND octet_length(p.checks_json) <= ${WORKSPACE_PROJECT_CHECKS_MAX_BYTES}
         AND json_valid(p.checks_json, 1)
       THEN p.checks_json END AS checks_json,
  CASE WHEN typeof(p.sandbox_json) = 'text'
         AND octet_length(p.sandbox_json) <= ${WORKSPACE_PROJECT_PROFILE_MAX_BYTES}
         AND json_valid(p.sandbox_json, 1)
       THEN p.sandbox_json END AS sandbox_json,
  CASE WHEN typeof(p.ceiling_json) = 'text'
         AND octet_length(p.ceiling_json) <= ${WORKSPACE_PROJECT_PROFILE_MAX_BYTES}
         AND json_valid(p.ceiling_json, 1)
       THEN p.ceiling_json END AS ceiling_json,
  CASE WHEN typeof(p.created_at) = 'text'
         AND octet_length(p.created_at) <= ${EVENT_TIMESTAMP_MAX_BYTES}
       THEN p.created_at END AS project_created_at`;
const BOUNDED_REPOSITORY_COLUMNS = `
  CASE WHEN typeof(r.id) = 'text' AND octet_length(r.id) <= 64
       THEN r.id END AS repository_record_id,
  CASE WHEN typeof(r.name) = 'text' AND octet_length(r.name) <= ${PROJECT_NAME_MAX_BYTES}
       THEN r.name END AS repository_name,
  CASE WHEN typeof(r.path) = 'text' AND octet_length(r.path) <= ${REPOSITORY_PATH_MAX_BYTES}
       THEN r.path END AS repository_path,
  CASE WHEN typeof(r.device) = 'integer' THEN r.device END AS repository_device,
  CASE WHEN typeof(r.inode) = 'integer' THEN r.inode END AS repository_inode,
  CASE WHEN typeof(r.created_at) = 'text'
         AND octet_length(r.created_at) <= ${EVENT_TIMESTAMP_MAX_BYTES}
       THEN r.created_at END AS repository_created_at`;
const RUN_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SAFE_WORKSPACE_SNAPSHOT_MAX = Number.MAX_SAFE_INTEGER - 1;
const PROJECT_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/;
const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const EVENT_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const RUN_STATES: ReadonlySet<string> = new Set<RunState>([
  "preparing",
  "planned",
  "awaiting_egress_approval",
  "awaiting_approval",
  "running",
  "verifying",
  "awaiting_review",
  "completed",
  "rolling_back",
  "cancelling",
  "failed",
  "cancelled",
  "rolled_back",
  "restoring",
]);
const RUN_PRESENTATION_ACTION_EVENT_LIMIT = 2;
const APPROVAL_KINDS: ReadonlySet<ApprovalRecord["kind"]> = new Set([
  "egress",
  "plan",
  "review",
  "rollback",
  "restore",
]);
const APPROVAL_DECISIONS: ReadonlySet<ApprovalRecord["decision"]> = new Set(["approve", "reject"]);
const RUN_PRESENTATION_ACTION_EVENT_TYPES = [
  "edit.materialized",
  "restore.completed",
  "rollback.completed",
  "cancellation.completed",
  "review.accepted",
] as const;

function isSqliteBusy(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { readonly code?: unknown }).code === "string" &&
    (error as { readonly code: string }).code.startsWith("SQLITE_BUSY")
  );
}

function emergencyOperationDetail(detail: JsonValue): JsonValue {
  if (typeof detail === "object" && detail !== null && !Array.isArray(detail)) {
    return { ...detail, budgetClass: "emergency" };
  }
  return { budgetClass: "emergency", detail };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS repositories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  path TEXT NOT NULL UNIQUE,
  device INTEGER NOT NULL,
  inode INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  repository_id TEXT NOT NULL REFERENCES repositories(id),
  base_ref TEXT NOT NULL,
  checks_json TEXT NOT NULL,
  sandbox_json TEXT NOT NULL,
  ceiling_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  task TEXT NOT NULL,
  target TEXT NOT NULL,
  provider_json TEXT NOT NULL,
  state TEXT NOT NULL,
  resume_state TEXT,
  base_commit TEXT NOT NULL,
  context_json TEXT NOT NULL,
  context_artifact_path TEXT NOT NULL,
  context_sha256 TEXT NOT NULL,
  plan_json TEXT,
  plan_sha256 TEXT,
  edit_json TEXT,
  cache_path TEXT,
  worktree_path TEXT,
  baseline_base64 TEXT,
  approved_base64 TEXT,
  diff TEXT,
  verification_json TEXT,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  active_runtime_ms INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd REAL NOT NULL DEFAULT 0,
  reserved_cost_usd REAL NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_run_per_project
ON runs(project_id)
WHERE state NOT IN ('completed', 'failed', 'cancelled', 'rolled_back');
CREATE TABLE IF NOT EXISTS run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id),
  sequence INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(run_id, sequence)
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  kind TEXT NOT NULL,
  digest TEXT NOT NULL,
  actor TEXT NOT NULL,
  decision TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK(decision IN ('approve', 'reject'))
);
CREATE TABLE IF NOT EXISTS operations (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  reserved_cost_usd REAL NOT NULL,
  reserved_tokens INTEGER NOT NULL,
  reserved_runtime_ms INTEGER NOT NULL,
  result_json TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS one_started_operation_per_run
ON operations(run_id)
WHERE status = 'started';
CREATE TABLE IF NOT EXISTS checkpoints (
  run_id TEXT PRIMARY KEY REFERENCES runs(id),
  baseline_base64 TEXT NOT NULL,
  approved_base64 TEXT NOT NULL,
  checkpoint_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL
);
PRAGMA user_version = 1;
`;

const APPROVAL_INDEX_SCHEMA = `
CREATE INDEX IF NOT EXISTS approvals_by_run
ON approvals(run_id);
`;

/**
 * ADR 0023 storage. Both objects are additive tables, so the migration never
 * rewrites or alters an existing row. Runs persisted under schema v1 keep their
 * single-file `edit_json` and checkpoint columns and remain readable.
 */
const PATCH_SET_SCHEMA = `
CREATE TABLE IF NOT EXISTS patch_sets (
  run_id TEXT PRIMARY KEY REFERENCES runs(id),
  patch_set_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS checkpoint_files (
  run_id TEXT NOT NULL REFERENCES runs(id),
  path TEXT NOT NULL,
  op TEXT NOT NULL,
  baseline_base64 TEXT,
  approved_base64 TEXT,
  PRIMARY KEY (run_id, path),
  CHECK (op IN ('modify', 'create', 'delete'))
);
`;

/**
 * ADR 0026 storage. One row per run holding the enumerated readable set its
 * approval bound. Additive, so the migration never rewrites an existing row —
 * but it is still operator-gated, because a state file that silently gains a
 * table is a state file whose shape nobody agreed to.
 */
const READABLE_MANIFEST_SCHEMA = `
CREATE TABLE IF NOT EXISTS readable_manifests (
  run_id TEXT PRIMARY KEY REFERENCES runs(id),
  base_commit TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL,
  entries_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

type ReadableManifestSchemaStatus = "not_applicable" | "missing" | "valid";

function inspectReadableManifestSchema(databasePath: string): ReadableManifestSchemaStatus {
  if (!existsSync(databasePath)) return "not_applicable";

  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const runsTableExists =
      database
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'runs'")
        .get() !== undefined;
    if (!runsTableExists) return "not_applicable";

    const present =
      database
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'readable_manifests'")
        .get() !== undefined;
    if (!present) return "missing";

    const expectedColumns = [
      "run_id",
      "base_commit",
      "manifest_sha256",
      "entries_json",
      "created_at",
    ];
    const columns = (
      database.prepare("PRAGMA table_info('readable_manifests')").all() as unknown[]
    ).map((entry) =>
      text(row(entry, "readable manifest column").name, "readable manifest column.name"),
    );
    invariant(
      columns.length === expectedColumns.length &&
        expectedColumns.every((column, index) => columns[index] === column),
      "DATABASE_ERROR",
      "Readable manifest table has an invalid shape",
    );
    return "valid";
  } finally {
    database.close();
  }
}

type ApprovalIndexStatus = "not_applicable" | "missing" | "valid";

function inspectApprovalIndex(databasePath: string): ApprovalIndexStatus {
  if (!existsSync(databasePath)) return "not_applicable";

  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const approvalTableExists =
      database
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'approvals'")
        .get() !== undefined;
    if (!approvalTableExists) return "not_applicable";

    const indexEntry = database
      .prepare(
        "SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND name = 'approvals_by_run'",
      )
      .get();
    if (indexEntry === undefined) return "missing";

    const index = row(indexEntry, "approval index");
    invariant(
      text(index.name, "approval index.name") === "approvals_by_run" &&
        text(index.tbl_name, "approval index.table") === "approvals",
      "DATABASE_ERROR",
      "Approval index metadata is invalid",
    );

    const indexList = database.prepare("PRAGMA index_list('approvals')").all() as unknown[];
    const definition = indexList
      .map((entry) => row(entry, "approval index definition"))
      .find((entry) => entry.name === "approvals_by_run");
    invariant(
      definition !== undefined &&
        definition.unique === 0 &&
        definition.origin === "c" &&
        definition.partial === 0,
      "DATABASE_ERROR",
      "Approval index definition is invalid",
    );

    const keyColumns = (
      database.prepare("PRAGMA index_xinfo('approvals_by_run')").all() as unknown[]
    )
      .map((entry) => row(entry, "approval index column"))
      .filter((entry) => entry.key === 1);
    const expectedColumns = [{ name: "run_id", desc: 0 }] as const;
    invariant(
      keyColumns.length === expectedColumns.length &&
        expectedColumns.every(
          (expected, index) =>
            keyColumns[index]?.seqno === index &&
            keyColumns[index]?.name === expected.name &&
            keyColumns[index]?.desc === expected.desc &&
            keyColumns[index]?.coll === "BINARY",
        ),
      "DATABASE_ERROR",
      "Approval index columns are invalid",
    );
    return "valid";
  } finally {
    database.close();
  }
}

type PatchSetSchemaStatus = "not_applicable" | "missing" | "valid";

/**
 * Read-only shape inspection performed before the writable handle is opened, so
 * a refusal cannot have mutated the database. A database that predates the
 * `runs` table is not a migration candidate; a database that has `runs` but
 * lacks the ADR 0023 tables requires explicit operator approval.
 */
function inspectPatchSetSchema(databasePath: string): PatchSetSchemaStatus {
  if (!existsSync(databasePath)) return "not_applicable";

  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const runsTableExists =
      database
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'runs'")
        .get() !== undefined;
    if (!runsTableExists) return "not_applicable";

    const present = new Set(
      (
        database
          .prepare(
            `SELECT name FROM sqlite_master WHERE type = 'table'
             AND name IN ('patch_sets', 'checkpoint_files')`,
          )
          .all() as unknown[]
      ).map((entry) => text(row(entry, "patch set table").name, "patch set table.name")),
    );
    if (present.size === 0) return "missing";
    invariant(
      present.has("patch_sets") && present.has("checkpoint_files"),
      "DATABASE_ERROR",
      "Patch-set schema is partially present",
    );

    const expectedTables = [
      { table: "patch_sets", columns: ["run_id", "patch_set_json", "created_at"] },
      {
        table: "checkpoint_files",
        columns: ["run_id", "path", "op", "baseline_base64", "approved_base64"],
      },
    ] as const;
    for (const expected of expectedTables) {
      const columns = (
        database.prepare(`PRAGMA table_info('${expected.table}')`).all() as unknown[]
      ).map((entry) =>
        text(row(entry, `${expected.table} column`).name, `${expected.table} column.name`),
      );
      invariant(
        columns.length === expected.columns.length &&
          expected.columns.every((column, index) => columns[index] === column),
        "DATABASE_ERROR",
        `Patch-set table ${expected.table} has an invalid shape`,
      );
    }
    return "valid";
  } finally {
    database.close();
  }
}

function row(value: unknown, name: string): Row {
  invariant(
    typeof value === "object" && value !== null,
    "DATABASE_ERROR",
    `${name} row is missing`,
  );
  return value as Row;
}

function text(value: unknown, name: string): string {
  invariant(typeof value === "string", "DATABASE_ERROR", `${name} is not text`);
  return value;
}

function nullableText(value: unknown, name: string): string | null {
  return value === null ? null : text(value, name);
}

function numberValue(value: unknown, name: string): number {
  invariant(
    typeof value === "number" && Number.isFinite(value),
    "DATABASE_ERROR",
    `${name} is not numeric`,
  );
  return value;
}

function parseJson<T>(value: unknown, name: string): T {
  try {
    return JSON.parse(text(value, name)) as T;
  } catch {
    throw new IcarusError("DATABASE_ERROR", `${name} contains invalid JSON`);
  }
}

function nullableJson<T>(value: unknown, name: string): T | null {
  return value === null ? null : parseJson<T>(value, name);
}

/**
 * Decodes a persisted plan without casting past its shape. Plans are stored as
 * JSON, so a row written before a plan field existed decodes with that field
 * absent while the type claims it is present — `plan.grants.length` then throws
 * and `Math.min(plan.iterationCeiling, n)` yields NaN.
 *
 * A pre-ADR 0026 row carries `repairIterations`; it decodes to the same
 * `iterationCeiling`, preserving exactly the allowance the operator approved
 * rather than widening it to the new default or discarding it.
 *
 * Both fields normalize to the no-capability reading, which is what a plan
 * authored before the field meant: no repair attempts and no granted
 * capability. Neither default can widen authority, so an old row stays
 * readable without becoming more permissive than it was approved to be.
 */
function decodeNullablePlan(value: unknown, name: string): PlanProposal | null {
  const decoded = nullableJson<Record<string, unknown>>(value, name);
  if (decoded === null) return null;
  const ceiling = decoded.iterationCeiling ?? decoded.repairIterations;
  const grants = decoded.grants;
  return {
    ...(decoded as unknown as PlanProposal),
    iterationCeiling: typeof ceiling === "number" ? ceiling : 0,
    grants: Array.isArray(grants) ? (grants as readonly CapabilityGrant[]) : [],
  };
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function asJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function isCanonicalTimestamp(value: string): boolean {
  const parsedTimestamp = Date.parse(value);
  const canonicalTimestamp = Number.isFinite(parsedTimestamp)
    ? new Date(parsedTimestamp).toISOString()
    : "";
  return (
    Buffer.byteLength(value, "utf8") <= EVENT_TIMESTAMP_MAX_BYTES &&
    EVENT_TIMESTAMP_PATTERN.test(value) &&
    (value === canonicalTimestamp ||
      (canonicalTimestamp.endsWith(".000Z") && value === canonicalTimestamp.replace(".000Z", "Z")))
  );
}

function containsUnsafeActorCharacter(value: string): boolean {
  return /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
}

function approvalRecordRow(entry: unknown, expectedRunId: string): ApprovalRecord {
  const value = row(entry, "approval");
  const runId = text(value.run_id, "approval.run_id");
  const kind = text(value.kind, "approval.kind");
  const digest = text(value.digest, "approval.digest");
  const actor = text(value.actor, "approval.actor");
  const decision = text(value.decision, "approval.decision");
  const createdAt = text(value.created_at, "approval.created_at");
  invariant(
    runId === expectedRunId && RUN_ID_PATTERN.test(runId),
    "DATABASE_ERROR",
    "Approval identity is invalid",
  );
  invariant(
    APPROVAL_KINDS.has(kind as ApprovalRecord["kind"]),
    "DATABASE_ERROR",
    "Approval kind is invalid",
  );
  invariant(/^[a-f0-9]{64}$/.test(digest), "DATABASE_ERROR", "Approval digest is invalid");
  invariant(
    actor.trim().length > 0 &&
      Buffer.byteLength(actor, "utf8") <= APPROVAL_ACTOR_MAX_BYTES &&
      !containsUnsafeActorCharacter(actor) &&
      !containsSecretShapedContent(Buffer.from(actor, "utf8")),
    "DATABASE_ERROR",
    "Approval actor is invalid",
  );
  invariant(
    APPROVAL_DECISIONS.has(decision as ApprovalRecord["decision"]),
    "DATABASE_ERROR",
    "Approval decision is invalid",
  );
  invariant(
    decision === "approve" || kind === "review",
    "DATABASE_ERROR",
    "Approval kind and decision are inconsistent",
  );
  invariant(isCanonicalTimestamp(createdAt), "DATABASE_ERROR", "Approval timestamp is invalid");
  return {
    runId,
    kind: kind as ApprovalRecord["kind"],
    digest,
    actor,
    decision: decision as ApprovalRecord["decision"],
    createdAt,
  };
}

function sqliteRowid(value: unknown, name: string, allowZero: boolean): number {
  const raw = text(value, name);
  invariant(
    (allowZero ? /^(0|[1-9][0-9]*)$/ : /^[1-9][0-9]*$/).test(raw),
    "DATABASE_ERROR",
    `${name} is not canonical decimal text`,
  );
  const parsed = BigInt(raw);
  invariant(parsed <= BigInt(Number.MAX_SAFE_INTEGER), "DATABASE_ERROR", `${name} is unsafe`);
  return Number(parsed);
}

function sqliteMaximumRowid(value: unknown, name: string): bigint {
  const raw = text(value, name);
  invariant(/^(0|[1-9][0-9]*)$/.test(raw), "DATABASE_ERROR", `${name} is invalid`);
  return BigInt(raw);
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  name: string,
): Record<string, unknown> {
  invariant(
    typeof value === "object" && value !== null && !Array.isArray(value),
    "DATABASE_ERROR",
    `${name} is not an object`,
  );
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record);
  invariant(
    actual.length === keys.length && keys.every((key) => actual.includes(key)),
    "DATABASE_ERROR",
    `${name} has invalid fields`,
  );
  return record;
}

function workspaceCheckProfiles(
  value: unknown,
  preservePolicyErrorCodes = false,
): readonly CheckProfile[] {
  if (preservePolicyErrorCodes) {
    const checks = value as readonly CheckProfile[];
    assertCheckProfiles(checks);
    return checks;
  }
  invariant(
    Array.isArray(value) && value.length > 0,
    "DATABASE_ERROR",
    "Project checks are invalid",
  );
  const checks = value.map((entry, index): CheckProfile => {
    const check = exactRecord(entry, ["id", "name", "argv"], `project.checks[${index}]`);
    invariant(
      typeof check.id === "string" &&
        check.id.length > 0 &&
        typeof check.name === "string" &&
        check.name.length > 0 &&
        Array.isArray(check.argv) &&
        check.argv.length > 0 &&
        check.argv.every(
          (part) =>
            typeof part === "string" &&
            part.length > 0 &&
            !part.includes("\0") &&
            !/[\r\n]/.test(part),
        ),
      "DATABASE_ERROR",
      "Project checks are invalid",
    );
    return {
      id: check.id,
      name: check.name,
      argv: check.argv as string[],
    };
  });
  try {
    assertCheckProfiles(checks);
  } catch {
    throw new IcarusError("DATABASE_ERROR", "Project checks are invalid");
  }
  return checks;
}

function workspaceSandboxProfile(value: unknown, preservePolicyErrorCodes = false): SandboxProfile {
  if (preservePolicyErrorCodes) {
    const sandbox = value as SandboxProfile;
    assertSandboxProfile(sandbox);
    return sandbox;
  }
  const profile = exactRecord(
    value,
    ["image", "cpus", "memoryMb", "pids", "tmpfsMb"],
    "project.sandbox",
  );
  invariant(
    typeof profile.image === "string" &&
      typeof profile.cpus === "number" &&
      typeof profile.memoryMb === "number" &&
      typeof profile.pids === "number" &&
      typeof profile.tmpfsMb === "number",
    "DATABASE_ERROR",
    "Project sandbox is invalid",
  );
  const sandbox: SandboxProfile = {
    image: profile.image,
    cpus: profile.cpus,
    memoryMb: profile.memoryMb,
    pids: profile.pids,
    tmpfsMb: profile.tmpfsMb,
  };
  try {
    assertSandboxProfile(sandbox);
  } catch {
    throw new IcarusError("DATABASE_ERROR", "Project sandbox is invalid");
  }
  return sandbox;
}

const SUN_CEILING_KEYS = [
  "maxToolCalls",
  "maxActiveRuntimeMs",
  "maxContextBytes",
  "maxOutputTokensPerCall",
  "maxTotalTokens",
  "maxCostUsd",
  "maxFilesChanged",
  "maxFileBytes",
  "maxDiffBytes",
  "maxCommandOutputBytes",
  "maxRawCommandOutputBytes",
  "providerTimeoutMs",
  "commandTimeoutMs",
] as const satisfies readonly (keyof SunCeiling)[];

function workspaceSunCeiling(value: unknown, preservePolicyErrorCodes = false): SunCeiling {
  if (preservePolicyErrorCodes) {
    const ceiling = value as SunCeiling;
    assertSunCeiling(ceiling);
    return ceiling;
  }
  const record = exactRecord(value, SUN_CEILING_KEYS, "project.ceiling");
  invariant(
    SUN_CEILING_KEYS.every((key) => typeof record[key] === "number"),
    "DATABASE_ERROR",
    "Project ceiling is invalid",
  );
  const ceiling = Object.fromEntries(
    SUN_CEILING_KEYS.map((key) => [key, record[key]]),
  ) as unknown as SunCeiling;
  try {
    assertSunCeiling(ceiling);
  } catch {
    throw new IcarusError("DATABASE_ERROR", "Project ceiling is invalid");
  }
  return ceiling;
}

function boundedRepositoryRow(value: Row): RepositoryRecord {
  const repositoryId = text(value.repository_record_id, "repository.id");
  const repositoryName = text(value.repository_name, "repository.name");
  const repositoryPath = text(value.repository_path, "repository.path");
  const repositoryCreatedAt = text(value.repository_created_at, "repository.created_at");
  const repositoryDevice = numberValue(value.repository_device, "repository.device");
  const repositoryInode = numberValue(value.repository_inode, "repository.inode");
  invariant(RUN_ID_PATTERN.test(repositoryId), "DATABASE_ERROR", "Repository identity is invalid");
  invariant(
    PROJECT_NAME_PATTERN.test(repositoryName),
    "DATABASE_ERROR",
    "Repository name metadata is invalid",
  );
  invariant(
    repositoryPath.trim().length > 0 &&
      !repositoryPath.includes("\0") &&
      Buffer.byteLength(repositoryPath, "utf8") <= REPOSITORY_PATH_MAX_BYTES,
    "DATABASE_ERROR",
    "Repository path is invalid",
  );
  invariant(
    Number.isSafeInteger(repositoryDevice) &&
      repositoryDevice >= 0 &&
      Number.isSafeInteger(repositoryInode) &&
      repositoryInode >= 0,
    "DATABASE_ERROR",
    "Repository identity metadata is invalid",
  );
  invariant(
    isCanonicalTimestamp(repositoryCreatedAt),
    "DATABASE_ERROR",
    "Repository timestamp metadata is invalid",
  );
  return {
    id: repositoryId,
    name: repositoryName,
    path: repositoryPath,
    device: repositoryDevice,
    inode: repositoryInode,
    createdAt: repositoryCreatedAt,
  };
}

function boundedProjectRow(value: Row, preservePolicyErrorCodes = false): ProjectRecord {
  const projectId = text(value.project_id, "project.id");
  const projectName = text(value.project_name, "project.name");
  const repositoryId = text(value.repository_id, "repository.id");
  const baseRef = text(value.base_ref, "project.base_ref");
  const projectCreatedAt = text(value.project_created_at, "project.created_at");
  invariant(
    RUN_ID_PATTERN.test(projectId) && RUN_ID_PATTERN.test(repositoryId),
    "DATABASE_ERROR",
    "Project identity is invalid",
  );
  invariant(
    PROJECT_NAME_PATTERN.test(projectName),
    "DATABASE_ERROR",
    "Project name metadata is invalid",
  );
  invariant(
    baseRef.length > 0 &&
      !baseRef.startsWith("-") &&
      !/[\r\n\0]/.test(baseRef) &&
      Buffer.byteLength(baseRef, "utf8") <= PROJECT_BASE_REF_MAX_BYTES,
    "DATABASE_ERROR",
    "Project base ref is invalid",
  );
  invariant(
    isCanonicalTimestamp(projectCreatedAt),
    "DATABASE_ERROR",
    "Project timestamp is invalid",
  );
  const checks = workspaceCheckProfiles(
    parseJson<unknown>(value.checks_json, "project.checks_json"),
    preservePolicyErrorCodes,
  );
  const sandbox = workspaceSandboxProfile(
    parseJson<unknown>(value.sandbox_json, "project.sandbox_json"),
    preservePolicyErrorCodes,
  );
  const ceiling = workspaceSunCeiling(
    parseJson<unknown>(value.ceiling_json, "project.ceiling_json"),
    preservePolicyErrorCodes,
  );
  return {
    id: projectId,
    name: projectName,
    repositoryId,
    baseRef,
    checks,
    sandbox,
    ceiling,
    createdAt: projectCreatedAt,
  };
}

function workspaceProjectEntryRow(
  entry: unknown,
  before: number,
  snapshot: number,
): { readonly cursor: number; readonly entry: WorkspaceProjectEntry } {
  const value = row(entry, "workspace project");
  const cursor = sqliteRowid(value.cursor, "project cursor", false);
  invariant(cursor < before && cursor <= snapshot, "DATABASE_ERROR", "Project cursor is invalid");
  const project = boundedProjectRow(value);
  const repository = boundedRepositoryRow(value);
  invariant(
    project.repositoryId === repository.id,
    "DATABASE_ERROR",
    "Project repository identity is inconsistent",
  );
  return { cursor, entry: { project, repository } };
}

function workspaceRunSummaryRow(
  entry: unknown,
  before: number,
  snapshot: number,
): { readonly cursor: number; readonly summary: WorkspaceRunSummary } {
  const value = row(entry, "workspace run summary");
  const cursor = sqliteRowid(value.cursor, "run cursor", false);
  const id = text(value.id, "run.id");
  const projectId = text(value.project_id, "run.project_id");
  const task = text(value.task, "run.task");
  const target = text(value.target, "run.target");
  const state = text(value.state, "run.state");
  const createdAt = text(value.created_at, "run.created_at");
  const updatedAt = text(value.updated_at, "run.updated_at");
  invariant(cursor < before && cursor <= snapshot, "DATABASE_ERROR", "Run cursor is invalid");
  invariant(
    RUN_ID_PATTERN.test(id) && RUN_ID_PATTERN.test(projectId),
    "DATABASE_ERROR",
    "Run summary identity is invalid",
  );
  invariant(
    task.trim().length > 0 &&
      !task.includes("\0") &&
      Buffer.byteLength(task, "utf8") <= RUN_SUMMARY_TASK_MAX_BYTES,
    "DATABASE_ERROR",
    "Run task is invalid",
  );
  invariant(
    target.trim().length > 0 &&
      !target.includes("\0") &&
      Buffer.byteLength(target, "utf8") <= RUN_SUMMARY_TARGET_MAX_BYTES,
    "DATABASE_ERROR",
    "Run target is invalid",
  );
  invariant(RUN_STATES.has(state), "DATABASE_ERROR", "Run state is invalid");
  invariant(
    isCanonicalTimestamp(createdAt) && isCanonicalTimestamp(updatedAt),
    "DATABASE_ERROR",
    "Run timestamp is invalid",
  );
  return {
    cursor,
    summary: {
      id,
      projectId,
      task,
      target,
      state: state as RunState,
      createdAt,
      updatedAt,
    },
  };
}

function eventSummaryRow(entry: unknown, name: string, expectedRunId: string): EventSummaryRecord {
  const value = row(entry, name);
  const sequence = numberValue(value.sequence, "event.sequence");
  const runId = text(value.run_id, "event.run_id");
  const type = text(value.type, "event.type");
  const createdAt = text(value.created_at, "event.created_at");
  invariant(
    Number.isSafeInteger(sequence) && sequence > 0 && runId === expectedRunId,
    "DATABASE_ERROR",
    "Event summary identity is invalid",
  );
  invariant(
    Buffer.byteLength(type, "utf8") <= EVENT_TYPE_MAX_BYTES && EVENT_TYPE_PATTERN.test(type),
    "DATABASE_ERROR",
    "Event type is invalid",
  );
  invariant(isCanonicalTimestamp(createdAt), "DATABASE_ERROR", "Event timestamp is invalid");
  return { sequence, runId, type, createdAt };
}

export interface NewRunInput {
  readonly id: string;
  readonly projectId: string;
  readonly task: string;
  /**
   * The operator's candidate selection (ADR 0023). The first entry anchors the
   * rules chain and is persisted as the run's target column; the complete
   * selection travels in the context manifest.
   */
  readonly targets: readonly string[];
  readonly provider: ProviderConfig;
}

export interface CheckpointRecord {
  readonly runId: string;
  readonly baselineBase64: string;
  readonly approvedBase64: string;
  readonly checkpointSha256: string;
  readonly createdAt: string;
}

interface ApprovalTransition {
  readonly kind: ApprovalRecord["kind"];
  readonly digest: string;
  readonly actor: string;
  readonly decision: ApprovalRecord["decision"];
  readonly expectedState: RunState;
  readonly to: RunState;
  readonly expectedDigest: (run: RunRecord) => string | null;
  readonly eventType: string;
}

function egressApprovalTransition(digest: string, actor: string): ApprovalTransition {
  return {
    kind: "egress",
    digest,
    actor,
    decision: "approve",
    expectedState: "awaiting_egress_approval",
    to: "planned",
    expectedDigest: (run) => run.contextSha256,
    eventType: "egress.approved",
  };
}

function planApprovalTransition(digest: string, actor: string): ApprovalTransition {
  return {
    kind: "plan",
    digest,
    actor,
    decision: "approve",
    expectedState: "awaiting_approval",
    to: "running",
    expectedDigest: (run) => run.planSha256,
    eventType: "plan.approved",
  };
}

function reviewApprovalTransition(
  digest: string,
  actor: string,
  decision: "approve" | "reject",
): ApprovalTransition {
  return {
    kind: "review",
    digest,
    actor,
    decision,
    expectedState: "awaiting_review",
    to: decision === "approve" ? "completed" : "rolling_back",
    expectedDigest: (current) => {
      invariant(
        current.verification !== null,
        "MISSING_VERIFICATION",
        "Run has no verification evidence",
      );
      if (decision === "approve") {
        invariant(
          current.verification.outcome === "passed",
          "VERIFICATION_NOT_PASSED",
          "Only a fully passing verification can be accepted",
        );
      }
      return current.verification.diffSha256;
    },
    eventType: decision === "approve" ? "review.accepted" : "review.rejected",
  };
}

export class IcarusStore {
  readonly #database: Database.Database;
  readonly #now: () => string;
  readonly #id: () => string;

  constructor(
    databasePath: string,
    options: {
      now?: () => string;
      id?: () => string;
      busyTimeoutMs?: number;
      allowApprovalIndexMigration?: boolean;
      allowPatchSetMigration?: boolean;
      allowReadableManifestMigration?: boolean;
    } = {},
  ) {
    const parent = path.dirname(databasePath);
    const parentStat = lstatSync(parent);
    invariant(
      parentStat.isDirectory() && !parentStat.isSymbolicLink(),
      "UNSAFE_STATE_ROOT",
      "Database parent must be a real directory",
    );
    const busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
    invariant(
      Number.isSafeInteger(busyTimeoutMs) && busyTimeoutMs >= 0 && busyTimeoutMs <= 60_000,
      "INVALID_DATABASE_CONFIGURATION",
      "SQLite busy timeout is invalid",
    );
    const approvalIndexStatus = inspectApprovalIndex(databasePath);
    if (approvalIndexStatus === "missing" && options.allowApprovalIndexMigration !== true) {
      throw new IcarusError(
        "DATABASE_MIGRATION_REQUIRED",
        "Approval index migration requires a state backup and explicit operator approval",
      );
    }
    const patchSetStatus = inspectPatchSetSchema(databasePath);
    if (patchSetStatus === "missing" && options.allowPatchSetMigration !== true) {
      throw new IcarusError(
        "DATABASE_MIGRATION_REQUIRED",
        "Patch-set migration requires a state backup and explicit operator approval",
      );
    }
    const readableManifestStatus = inspectReadableManifestSchema(databasePath);
    if (readableManifestStatus === "missing" && options.allowReadableManifestMigration !== true) {
      throw new IcarusError(
        "DATABASE_MIGRATION_REQUIRED",
        "Readable manifest migration requires a state backup and explicit operator approval",
      );
    }
    this.#database = new Database(databasePath);
    chmodSync(databasePath, 0o600);
    this.#database.pragma(`busy_timeout = ${busyTimeoutMs}`);
    this.#database.pragma("foreign_keys = ON");
    this.#database.pragma("journal_mode = WAL");
    this.#database.pragma("synchronous = FULL");
    this.#database.exec(SCHEMA);
    this.#database.exec(APPROVAL_INDEX_SCHEMA);
    this.#database.exec(PATCH_SET_SCHEMA);
    this.#database.exec(READABLE_MANIFEST_SCHEMA);
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#id = options.id ?? randomUUID;
  }

  close(): void {
    this.#database.close();
  }

  addRepository(input: {
    name: string;
    path: string;
    device: number;
    inode: number;
  }): RepositoryRecord {
    const record: RepositoryRecord = {
      id: this.#id(),
      name: input.name,
      path: input.path,
      device: input.device,
      inode: input.inode,
      createdAt: this.#now(),
    };
    this.#database
      .prepare(
        "INSERT INTO repositories (id, name, path, device, inode, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(record.id, record.name, record.path, record.device, record.inode, record.createdAt);
    return record;
  }

  getRepository(id: string): RepositoryRecord {
    const result = this.#database
      .prepare(`SELECT ${BOUNDED_REPOSITORY_COLUMNS} FROM repositories AS r WHERE r.id = ?`)
      .get(id);
    invariant(result !== undefined, "NOT_FOUND", "Repository was not found");
    return boundedRepositoryRow(row(result, "repository"));
  }

  listRepositories(): RepositoryRecord[] {
    return (
      this.#database
        .prepare(
          `SELECT CASE WHEN typeof(id) = 'text' AND octet_length(id) <= 64 THEN id END AS id
           FROM repositories ORDER BY created_at, id`,
        )
        .all() as unknown[]
    ).map((value) => this.getRepository(text(row(value, "repository list").id, "repository.id")));
  }

  getRepositoryByName(name: string): RepositoryRecord {
    const repository = this.findRepositoryByName(name);
    invariant(repository !== null, "NOT_FOUND", "Repository was not found");
    return repository;
  }

  findRepositoryByName(name: string): RepositoryRecord | null {
    const value = this.#database
      .prepare(
        `SELECT CASE WHEN typeof(id) = 'text' AND octet_length(id) <= 64 THEN id END AS id
         FROM repositories WHERE name = ?`,
      )
      .get(name);
    return value === undefined
      ? null
      : this.getRepository(text(row(value, "repository").id, "repository.id"));
  }

  addProject(input: {
    name: string;
    repositoryId: string;
    baseRef: string;
    checks: readonly CheckProfile[];
    sandbox: SandboxProfile;
    ceiling: SunCeiling;
  }): ProjectRecord {
    assertCheckProfiles(input.checks);
    assertSandboxProfile(input.sandbox);
    assertSunCeiling(input.ceiling);
    const checksJson = json(input.checks);
    const sandboxJson = json(input.sandbox);
    const ceilingJson = json(input.ceiling);
    invariant(
      Buffer.byteLength(checksJson, "utf8") <= WORKSPACE_PROJECT_CHECKS_MAX_BYTES &&
        Buffer.byteLength(sandboxJson, "utf8") <= WORKSPACE_PROJECT_PROFILE_MAX_BYTES &&
        Buffer.byteLength(ceilingJson, "utf8") <= WORKSPACE_PROJECT_PROFILE_MAX_BYTES,
      "PROJECT_CONFIGURATION_TOO_LARGE",
      "Project configuration exceeds the persisted workspace byte limits",
    );
    this.getRepository(input.repositoryId);
    const record: ProjectRecord = {
      id: this.#id(),
      name: input.name,
      repositoryId: input.repositoryId,
      baseRef: input.baseRef,
      checks: input.checks,
      sandbox: input.sandbox,
      ceiling: input.ceiling,
      createdAt: this.#now(),
    };
    this.#database
      .prepare(
        `INSERT INTO projects
          (id, name, repository_id, base_ref, checks_json, sandbox_json, ceiling_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.name,
        record.repositoryId,
        record.baseRef,
        checksJson,
        sandboxJson,
        ceilingJson,
        record.createdAt,
      );
    return record;
  }

  addRepositoryAndProject(input: {
    repository: {
      name: string;
      path: string;
      device: number;
      inode: number;
    };
    project: {
      name: string;
      baseRef: string;
      checks: readonly CheckProfile[];
      sandbox: SandboxProfile;
      ceiling: SunCeiling;
    };
  }): { readonly repository: RepositoryRecord; readonly project: ProjectRecord } {
    assertCheckProfiles(input.project.checks);
    assertSandboxProfile(input.project.sandbox);
    assertSunCeiling(input.project.ceiling);
    const transaction = this.#database.transaction(() => {
      const repository = this.addRepository(input.repository);
      const project = this.addProject({
        ...input.project,
        repositoryId: repository.id,
      });
      return { repository, project };
    });
    return transaction();
  }

  getProject(id: string): ProjectRecord {
    const result = this.#database
      .prepare(`SELECT ${BOUNDED_PROJECT_COLUMNS} FROM projects AS p WHERE p.id = ?`)
      .get(id);
    invariant(result !== undefined, "NOT_FOUND", "Project was not found");
    return boundedProjectRow(row(result, "project"), true);
  }

  listProjects(): ProjectRecord[] {
    return (
      this.#database
        .prepare(
          `SELECT CASE WHEN typeof(id) = 'text' AND octet_length(id) <= 64 THEN id END AS id
           FROM projects ORDER BY created_at, id`,
        )
        .all() as unknown[]
    ).map((value) => this.getProject(text(row(value, "project list").id, "project.id")));
  }

  getProjectByName(name: string): ProjectRecord {
    const project = this.findProjectByName(name);
    invariant(project !== null, "NOT_FOUND", "Project was not found");
    return project;
  }

  findProjectByName(name: string): ProjectRecord | null {
    const value = this.#database
      .prepare(
        `SELECT CASE WHEN typeof(id) = 'text' AND octet_length(id) <= 64 THEN id END AS id
         FROM projects WHERE name = ?`,
      )
      .get(name);
    return value === undefined
      ? null
      : this.getProject(text(row(value, "project").id, "project.id"));
  }

  openWorkspaceProjectPage(): WorkspaceProjectPage {
    return this.#workspaceProjectPage(null);
  }

  listWorkspaceProjectPage(before: number, snapshot: number): WorkspaceProjectPage {
    invariant(
      Number.isSafeInteger(before) && before > 0,
      "INVALID_PROJECT_CURSOR",
      "Workspace project cursor must be a positive safe integer",
    );
    invariant(
      Number.isSafeInteger(snapshot) && snapshot >= 0 && snapshot <= SAFE_WORKSPACE_SNAPSHOT_MAX,
      "INVALID_PROJECT_CURSOR",
      "Workspace project snapshot must be a nonnegative safe integer",
    );
    return this.#workspaceProjectPage({ before, snapshot });
  }

  #workspaceProjectPage(
    requested: { readonly before: number; readonly snapshot: number } | null,
  ): WorkspaceProjectPage {
    const transaction = this.#database.transaction((): WorkspaceProjectPage => {
      const maximum = sqliteMaximumRowid(
        row(
          this.#database
            .prepare("SELECT CAST(COALESCE(MAX(rowid), 0) AS TEXT) AS snapshot FROM projects")
            .get(),
          "project snapshot",
        ).snapshot,
        "project snapshot",
      );
      let before: number;
      let snapshot: number;
      if (requested === null) {
        invariant(
          maximum <= BigInt(SAFE_WORKSPACE_SNAPSHOT_MAX),
          "DATABASE_ERROR",
          "Workspace project snapshot is unsafe",
        );
        snapshot = Number(maximum);
        before = snapshot + 1;
      } else {
        before = requested.before;
        snapshot = requested.snapshot;
        invariant(
          BigInt(snapshot) <= maximum,
          "INVALID_PROJECT_CURSOR",
          "Workspace project snapshot is ahead of persisted history",
        );
        if (snapshot > 0) {
          invariant(
            this.#database.prepare("SELECT 1 FROM projects WHERE rowid = ?").get(snapshot) !==
              undefined,
            "INVALID_PROJECT_CURSOR",
            "Workspace project snapshot anchor is missing",
          );
        }
        const pageOneBefore = snapshot + 1;
        if (before !== pageOneBefore) {
          invariant(
            before <= snapshot &&
              this.#database.prepare("SELECT 1 FROM projects WHERE rowid = ?").get(before) !==
                undefined,
            "INVALID_PROJECT_CURSOR",
            "Workspace project cursor anchor is missing",
          );
        }
      }
      const rows = this.#database
        .prepare(
          `SELECT CAST(p.rowid AS TEXT) AS cursor,
                  ${BOUNDED_PROJECT_COLUMNS},
                  ${BOUNDED_REPOSITORY_COLUMNS}
           FROM projects AS p
           LEFT JOIN repositories AS r ON r.id = p.repository_id
           WHERE p.rowid < ? AND p.rowid <= ?
           ORDER BY p.rowid DESC
           LIMIT 13`,
        )
        .all(before, snapshot) as unknown[];
      const entries = rows.map((entry) => workspaceProjectEntryRow(entry, before, snapshot));
      const hasMore = entries.length > WORKSPACE_PROJECT_PAGE_LIMIT;
      const retained = entries.slice(0, WORKSPACE_PROJECT_PAGE_LIMIT);
      return {
        before,
        snapshot,
        nextBefore: retained.at(-1)?.cursor ?? before,
        hasMore,
        projects: retained.map((entry) => entry.entry),
      };
    });
    return transaction();
  }

  createRun(input: NewRunInput): RunRecord {
    const project = this.getProject(input.projectId);
    const id = input.id;
    invariant(
      /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id),
      "INVALID_RUN_ID",
      "Run ID is invalid",
    );
    const now = this.#now();
    const targets = [...new Set(input.targets)].sort();
    const anchor = input.targets[0];
    invariant(
      anchor !== undefined && targets.length === input.targets.length,
      "INVALID_TARGET_SELECTION",
      "Run target selection must be a non-empty set of unique paths",
    );
    invariant(
      targets.length <= project.ceiling.maxFilesChanged,
      "FILE_BUDGET_EXCEEDED",
      "Run selects more targets than the ceiling permits",
    );
    const emptyContext: ContextManifest = {
      auditPolicyVersion: CONTEXT_AUDIT_POLICY_VERSION,
      baseCommit: "",
      targets,
      repositoryMap: [],
      entries: [],
      totalBytes: 0,
    };
    const transaction = this.#database.transaction(() => {
      this.#assertNoOtherActiveRun(project.id, id);
      this.#database
        .prepare(
          `INSERT INTO runs
            (id, project_id, task, target, provider_json, state, base_commit, context_json,
             context_artifact_path, context_sha256, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'preparing', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.projectId,
          input.task,
          anchor,
          json(input.provider),
          "",
          json(emptyContext),
          "",
          "",
          now,
          now,
        );
      this.#appendEvent(id, "run.created", {
        state: "preparing",
        target: anchor,
      });
    });
    transaction();
    return this.getRun(id);
  }

  pinRunBase(runId: string, baseCommit: string): RunRecord {
    invariant(/^[a-f0-9]{40,64}$/.test(baseCommit), "INVALID_REF", "Base commit is invalid");
    const transaction = this.#database.transaction(() => {
      const current = this.getRun(runId);
      invariant(current.state === "preparing", "INVALID_STATE", "Run is not being prepared");
      if (current.baseCommit.length > 0) {
        invariant(
          current.baseCommit === baseCommit,
          "STALE_HEAD",
          "Prepared run is already pinned to another commit",
        );
        return;
      }
      const now = this.#now();
      const result = this.#database
        .prepare(
          `UPDATE runs SET base_commit = ?, version = version + 1, updated_at = ?
           WHERE id = ? AND state = 'preparing' AND base_commit = ''`,
        )
        .run(baseCommit, now, runId);
      invariant(result.changes === 1, "CONCURRENT_RUN_UPDATE", "Run base changed concurrently");
      this.#appendEvent(runId, "base.pinned", { baseCommit });
    });
    transaction();
    return this.getRun(runId);
  }

  completePreparation(
    runId: string,
    context: ContextManifest,
    contextArtifactPath: string,
    contextSha256: string,
  ): RunRecord {
    invariant(
      /^[a-f0-9]{64}$/.test(contextSha256),
      "CONTEXT_MISMATCH",
      "Context digest is invalid",
    );
    invariant(
      contextArtifactPath.length > 0,
      "CONTEXT_MISMATCH",
      "Context artifact path is missing",
    );
    const transaction = this.#database.transaction(() => {
      const current = this.getRun(runId);
      invariant(current.state === "preparing", "INVALID_STATE", "Run is not being prepared");
      invariant(current.baseCommit.length > 0, "MISSING_BASE", "Run base is not pinned");
      invariant(
        context.baseCommit === current.baseCommit &&
          context.targets.length === current.context.targets.length &&
          context.targets.every((target, index) => target === current.context.targets[index]),
        "CONTEXT_MISMATCH",
        "Context does not match the prepared run",
      );
      invariant(
        digestJson(asJsonValue(context)) === contextSha256,
        "CONTEXT_MISMATCH",
        "Context digest does not match its manifest",
      );
      const nextState: RunState =
        current.provider.capabilities.locality === "remote"
          ? "awaiting_egress_approval"
          : "planned";
      assertTransition(current.state, nextState);
      const now = this.#now();
      const result = this.#database
        .prepare(
          `UPDATE runs SET context_json = ?, context_artifact_path = ?, context_sha256 = ?,
           state = ?, version = version + 1, updated_at = ?
           WHERE id = ? AND state = 'preparing'`,
        )
        .run(json(context), contextArtifactPath, contextSha256, nextState, now, runId);
      invariant(result.changes === 1, "CONCURRENT_RUN_UPDATE", "Run state changed concurrently");
      this.#appendEvent(runId, "context.assembled", {
        from: "preparing",
        to: nextState,
        contextSha256,
      });
      if (nextState === "awaiting_egress_approval") {
        this.#appendEvent(runId, "egress.requested", { contextSha256 });
      }
    });
    transaction();
    return this.getRun(runId);
  }

  getRun(id: string): RunRecord {
    const result = this.#database.prepare("SELECT * FROM runs WHERE id = ?").get(id);
    invariant(result !== undefined, "NOT_FOUND", "Run was not found");
    const value = row(result, "run");
    const errorCode = nullableText(value.error_code, "run.error_code");
    const errorMessage = nullableText(value.error_message, "run.error_message");
    return {
      id: text(value.id, "run.id"),
      projectId: text(value.project_id, "run.project_id"),
      task: text(value.task, "run.task"),
      target: text(value.target, "run.target"),
      provider: parseJson<ProviderConfig>(value.provider_json, "run.provider_json"),
      state: text(value.state, "run.state") as RunState,
      resumeState: nullableText(value.resume_state, "run.resume_state") as RunState | null,
      baseCommit: text(value.base_commit, "run.base_commit"),
      context: parseJson<ContextManifest>(value.context_json, "run.context_json"),
      contextArtifactPath: text(value.context_artifact_path, "run.context_artifact_path"),
      contextSha256: text(value.context_sha256, "run.context_sha256"),
      plan: decodeNullablePlan(value.plan_json, "run.plan_json"),
      planSha256: nullableText(value.plan_sha256, "run.plan_sha256"),
      patchSet: this.#readPatchSet(id, value),
      cachePath: nullableText(value.cache_path, "run.cache_path"),
      worktreePath: nullableText(value.worktree_path, "run.worktree_path"),
      baselineBase64: nullableText(value.baseline_base64, "run.baseline_base64"),
      approvedBase64: nullableText(value.approved_base64, "run.approved_base64"),
      diff: nullableText(value.diff, "run.diff"),
      verification: nullableJson<VerificationEvidence>(
        value.verification_json,
        "run.verification_json",
      ),
      usage: {
        toolCalls: numberValue(value.tool_calls, "run.tool_calls"),
        inputTokens: numberValue(value.input_tokens, "run.input_tokens"),
        outputTokens: numberValue(value.output_tokens, "run.output_tokens"),
        activeRuntimeMs: numberValue(value.active_runtime_ms, "run.active_runtime_ms"),
        estimatedCostUsd: numberValue(value.estimated_cost_usd, "run.estimated_cost_usd"),
        reservedCostUsd: numberValue(value.reserved_cost_usd, "run.reserved_cost_usd"),
      },
      lastError:
        errorCode === null || errorMessage === null
          ? null
          : { code: errorCode, message: errorMessage },
      createdAt: text(value.created_at, "run.created_at"),
      updatedAt: text(value.updated_at, "run.updated_at"),
    };
  }

  listRuns(projectId?: string): RunRecord[] {
    const values =
      projectId === undefined
        ? (this.#database
            .prepare("SELECT id FROM runs ORDER BY created_at DESC, id DESC")
            .all() as unknown[])
        : (this.#database
            .prepare("SELECT id FROM runs WHERE project_id = ? ORDER BY created_at DESC, id DESC")
            .all(projectId) as unknown[]);
    return values.map((value) => this.getRun(text(row(value, "run list").id, "run.id")));
  }

  openWorkspaceRunPage(): WorkspaceRunPage {
    return this.#workspaceRunPage(null);
  }

  listWorkspaceRunPage(before: number, snapshot: number): WorkspaceRunPage {
    invariant(
      Number.isSafeInteger(before) && before > 0,
      "INVALID_RUN_CURSOR",
      "Workspace run cursor must be a positive safe integer",
    );
    invariant(
      Number.isSafeInteger(snapshot) && snapshot >= 0 && snapshot <= SAFE_WORKSPACE_SNAPSHOT_MAX,
      "INVALID_RUN_CURSOR",
      "Workspace run snapshot must be a nonnegative safe integer",
    );
    return this.#workspaceRunPage({ before, snapshot });
  }

  #workspaceRunPage(
    requested: { readonly before: number; readonly snapshot: number } | null,
  ): WorkspaceRunPage {
    const transaction = this.#database.transaction((): WorkspaceRunPage => {
      const maximum = sqliteMaximumRowid(
        row(
          this.#database
            .prepare("SELECT CAST(COALESCE(MAX(rowid), 0) AS TEXT) AS snapshot FROM runs")
            .get(),
          "run snapshot",
        ).snapshot,
        "run snapshot",
      );
      let before: number;
      let snapshot: number;
      if (requested === null) {
        invariant(
          maximum <= BigInt(SAFE_WORKSPACE_SNAPSHOT_MAX),
          "DATABASE_ERROR",
          "Workspace run snapshot is unsafe",
        );
        snapshot = Number(maximum);
        before = snapshot + 1;
      } else {
        before = requested.before;
        snapshot = requested.snapshot;
        invariant(
          BigInt(snapshot) <= maximum,
          "INVALID_RUN_CURSOR",
          "Workspace run snapshot is ahead of persisted history",
        );
        if (snapshot > 0) {
          invariant(
            this.#database.prepare("SELECT 1 FROM runs WHERE rowid = ?").get(snapshot) !==
              undefined,
            "INVALID_RUN_CURSOR",
            "Workspace run snapshot anchor is missing",
          );
        }
        const pageOneBefore = snapshot + 1;
        if (before !== pageOneBefore) {
          invariant(
            before <= snapshot &&
              this.#database.prepare("SELECT 1 FROM runs WHERE rowid = ?").get(before) !==
                undefined,
            "INVALID_RUN_CURSOR",
            "Workspace run cursor anchor is missing",
          );
        }
      }
      const rows = this.#database
        .prepare(
          `SELECT CAST(rowid AS TEXT) AS cursor,
                  id, project_id, task, target, state, created_at, updated_at
           FROM runs
           WHERE rowid < ? AND rowid <= ?
           ORDER BY rowid DESC
           LIMIT 13`,
        )
        .all(before, snapshot) as unknown[];
      const summaries = rows.map((entry) => workspaceRunSummaryRow(entry, before, snapshot));
      const hasMore = summaries.length > WORKSPACE_RUN_PAGE_LIMIT;
      const retained = summaries.slice(0, WORKSPACE_RUN_PAGE_LIMIT);
      return {
        before,
        snapshot,
        nextBefore: retained.at(-1)?.cursor ?? before,
        hasMore,
        runs: retained.map((entry) => entry.summary),
      };
    });
    return transaction();
  }

  transition(
    runId: string,
    to: RunState,
    type: string,
    payload: JsonValue = {},
    resumeState: RunState | null = null,
  ): RunRecord {
    const transaction = this.#database.transaction(() => {
      const current = this.getRun(runId);
      const isUngatedTransition =
        (current.state === "running" && to === "verifying") || to === "cancelling";
      invariant(
        isUngatedTransition,
        "GATED_TRANSITION",
        "This state change requires a dedicated approval or evidence method",
      );
      assertTransition(current.state, to);
      const now = this.#now();
      const result = this.#database
        .prepare(
          `UPDATE runs SET state = ?, resume_state = ?, error_code = NULL, error_message = NULL,
           version = version + 1, updated_at = ? WHERE id = ? AND state = ?`,
        )
        .run(to, resumeState, now, runId, current.state);
      invariant(result.changes === 1, "CONCURRENT_RUN_UPDATE", "Run state changed concurrently");
      this.#appendEvent(runId, type, { from: current.state, to, detail: payload });
    });
    transaction();
    return this.getRun(runId);
  }

  /**
   * `readableManifest` is the resolved enumeration backing a `read.manifest`
   * grant (ADR 0026). The two must agree: a plan that requests the capability
   * without a resolved manifest would put a glob in front of the operator
   * instead of a file list, and a manifest with no grant asking for it would
   * bind authority nobody requested.
   */
  recordPlanAndAwaitApproval(
    runId: string,
    plan: PlanProposal,
    planSha256: string,
    readableManifest: ReadableManifest | null = null,
  ): RunRecord {
    const transaction = this.#database.transaction(() => {
      const current = this.getRun(runId);
      invariant(current.state === "planned", "INVALID_STATE", "Run is not ready to store a plan");
      const requestsRead = plan.grants.some((grant) => grant.kind === "read.manifest");
      invariant(
        requestsRead === (readableManifest !== null),
        "READ_MANIFEST_UNRESOLVED",
        "A read.manifest grant requires exactly one resolved readable manifest",
      );
      if (readableManifest !== null) {
        assertReadableManifest(readableManifest);
        invariant(
          readableManifest.baseCommit === current.baseCommit,
          "READ_MANIFEST_UNRESOLVED",
          "Readable manifest was resolved against a different base commit",
        );
      }
      if (current.provider.capabilities.locality === "remote") {
        invariant(
          this.#hasApproval(runId, "egress", current.contextSha256, "approve"),
          "MISSING_EGRESS_APPROVAL",
          "Remote planning requires approval for the exact context digest",
        );
      }
      const project = this.getProject(current.projectId);
      invariant(
        planApprovalDigest({
          task: current.task,
          baseCommit: current.baseCommit,
          contextSha256: current.contextSha256,
          targets: current.context.targets,
          provider: current.provider,
          checks: project.checks,
          sandbox: project.sandbox,
          ceiling: project.ceiling,
          plan,
          readableManifest,
        }) === planSha256,
        "PLAN_DIGEST_MISMATCH",
        "Plan approval digest does not bind the complete persisted manifest",
      );
      assertTransition(current.state, "awaiting_approval");
      const now = this.#now();
      this.#database
        .prepare(
          `UPDATE runs SET plan_json = ?, plan_sha256 = ?, state = 'awaiting_approval',
           version = version + 1, updated_at = ? WHERE id = ? AND state = 'planned'`,
        )
        .run(json(plan), planSha256, now, runId);
      if (readableManifest !== null) {
        // Persisted in the same transaction that records the plan, so a run
        // can never reach `awaiting_approval` carrying a grant whose manifest
        // is absent — the state the store refuses to accept on the way in must
        // also be unreachable by a crash on the way out.
        this.#database
          .prepare(
            `INSERT INTO readable_manifests
              (run_id, base_commit, manifest_sha256, entries_json, created_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            runId,
            readableManifest.baseCommit,
            readableManifestDigest(readableManifest),
            json(readableManifest.entries),
            now,
          );
      }
      this.#appendEvent(runId, "plan.created", {
        from: "planned",
        to: "awaiting_approval",
        planSha256,
        readableFiles: readableManifest === null ? 0 : readableManifest.entries.length,
      });
    });
    transaction();
    return this.getRun(runId);
  }

  /**
   * The enumerated readable set this run's approval bound, or null when the
   * run was approved with no read grant (ADR 0026).
   *
   * The stored digest is recomputed from the stored entries rather than
   * trusted, so a row edited underneath Icarus fails closed instead of
   * silently widening what a read may return. Callers still hold the returned
   * manifest to `assertReadableBytes`; this only guarantees the manifest is
   * the one that was approved.
   */
  readableManifest(runId: string): ReadableManifest | null {
    const stored = this.#database
      .prepare(
        `SELECT base_commit, manifest_sha256, entries_json FROM readable_manifests
         WHERE run_id = ?`,
      )
      .get(runId);
    if (stored === undefined) return null;
    const value = row(stored, "readable manifest");
    const manifest: ReadableManifest = {
      baseCommit: text(value.base_commit, "readable_manifests.base_commit"),
      entries: parseJson<readonly ReadableManifestEntry[]>(
        value.entries_json,
        "readable_manifests.entries_json",
      ),
    };
    invariant(
      readableManifestDigest(manifest) ===
        text(value.manifest_sha256, "readable_manifests.manifest_sha256"),
      "READ_MANIFEST_DRIFT",
      "Persisted readable manifest does not match its recorded digest",
    );
    assertReadableManifest(manifest);
    return manifest;
  }

  preflightEgressApproval(runId: string, digest: string, actor: string): RunRecord {
    return this.#validateApprovalRequest(runId, egressApprovalTransition(digest, actor));
  }

  approveEgress(runId: string, digest: string, actor: string): RunRecord {
    return this.#approveAndTransition(runId, egressApprovalTransition(digest, actor));
  }

  preflightPlanApproval(runId: string, digest: string, actor: string): RunRecord {
    return this.#validateApprovalRequest(runId, planApprovalTransition(digest, actor));
  }

  approvePlan(runId: string, digest: string, actor: string): RunRecord {
    return this.#approveAndTransition(runId, planApprovalTransition(digest, actor));
  }

  preflightReviewDecision(
    runId: string,
    digest: string,
    actor: string,
    decision: "approve" | "reject",
  ): RunRecord {
    if (decision === "approve") {
      this.#assertSessionCompletedForApproval(runId);
    }
    return this.#validateApprovalRequest(runId, reviewApprovalTransition(digest, actor, decision));
  }

  decideReview(
    runId: string,
    digest: string,
    actor: string,
    decision: "approve" | "reject",
  ): RunRecord {
    return this.#approveAndTransition(
      runId,
      reviewApprovalTransition(digest, actor, decision),
      decision === "approve" ? () => this.#assertSessionCompletedForApproval(runId) : undefined,
    );
  }

  approveRollback(runId: string, digest: string, actor: string): RunRecord {
    const current = this.getRun(runId);
    invariant(
      current.state === "awaiting_review" || current.state === "completed",
      "INVALID_STATE",
      "Run cannot be rolled back from its current state",
    );
    return this.#approveAndTransition(runId, {
      kind: "rollback",
      digest,
      actor,
      decision: "approve",
      expectedState: current.state,
      to: "rolling_back",
      expectedDigest: (run) => run.verification?.diffSha256 ?? null,
      eventType: "rollback.approved",
    });
  }

  approveRestore(runId: string, digest: string, actor: string): RunRecord {
    const checkpoint = this.getCheckpoint(runId);
    return this.#approveAndTransition(runId, {
      kind: "restore",
      digest,
      actor,
      decision: "approve",
      expectedState: "rolled_back",
      to: "restoring",
      expectedDigest: () => checkpoint.checkpointSha256,
      eventType: "restore.approved",
    });
  }

  finishRollback(runId: string): RunRecord {
    return this.#finishInternalTransition(
      runId,
      "rolling_back",
      "rolled_back",
      "rollback.completed",
    );
  }

  finishRestore(runId: string): RunRecord {
    return this.#finishInternalTransition(runId, "restoring", "verifying", "restore.completed");
  }

  finishCancellation(runId: string): RunRecord {
    return this.#finishInternalTransition(
      runId,
      "cancelling",
      "cancelled",
      "cancellation.completed",
    );
  }

  recordResumeRequested(runId: string): RunRecord {
    const transaction = this.#database.transaction(() => {
      const current = this.getRun(runId);
      this.#appendEvent(runId, "resume.requested", {
        state: current.state,
        resumeState: current.resumeState,
      });
    });
    transaction();
    return this.getRun(runId);
  }

  listApprovals(runId: string): ApprovalRecord[] {
    return (
      this.#database
        .prepare("SELECT * FROM approvals WHERE run_id = ? ORDER BY rowid")
        .all(runId) as unknown[]
    ).map((entry) => approvalRecordRow(entry, runId));
  }

  recordWorkspace(
    runId: string,
    cachePath: string,
    worktreePath: string,
    baselineBase64: string | null,
  ): RunRecord {
    const transaction = this.#database.transaction(() => {
      const current = this.getRun(runId);
      invariant(current.state === "running", "INVALID_STATE", "Run is not executing");
      const result = this.#database
        .prepare(
          `UPDATE runs SET cache_path = ?, worktree_path = ?, baseline_base64 = ?,
           version = version + 1, updated_at = ? WHERE id = ? AND state = 'running'`,
        )
        .run(cachePath, worktreePath, baselineBase64, this.#now(), runId);
      invariant(result.changes === 1, "CONCURRENT_RUN_UPDATE", "Run state changed concurrently");
      this.#appendEvent(runId, "workspace.created", { cachePath, worktreePath });
    });
    transaction();
    return this.getRun(runId);
  }

  /**
   * Persists the proposed change and every affected path's baseline and
   * approved bytes in one transaction, before any worktree byte is written, so
   * an interrupted application is always recoverable from durable state.
   */
  recordPatchSetIntent(
    runId: string,
    patchSet: PatchSet,
    files: readonly CheckpointFile[],
  ): RunRecord {
    const transaction = this.#database.transaction(() => {
      const current = this.getRun(runId);
      invariant(current.state === "running", "INVALID_STATE", "Run is not executing");
      invariant(
        current.plan !== null,
        "MISSING_PLAN",
        "Patch set intent requires an approved plan",
      );
      const approved = new Set(current.plan.targets);
      invariant(
        patchSet.edits.every((edit) => approved.has(edit.path)),
        "TARGET_MISMATCH",
        "Patch set changes a path outside the approved targets",
      );
      const project = this.getProject(current.projectId);
      invariant(
        patchSet.edits.length <= project.ceiling.maxFilesChanged,
        "FILE_BUDGET_EXCEEDED",
        "Patch set changes more files than the ceiling permits",
      );
      const editPaths = patchSet.edits.map((edit) => edit.path).sort();
      const filePaths = files.map((file) => file.path).sort();
      invariant(
        editPaths.length === filePaths.length &&
          editPaths.every((editPath, index) => editPath === filePaths[index]),
        "CHECKPOINT_MISMATCH",
        "Checkpoint files do not match the patch set paths",
      );

      // A patch set is immutable within its revision. A repair iteration
      // (ADR 0024) supersedes it, and the superseded digest is appended to the
      // event stream before the replacement is written so the history stays in
      // the append-only log rather than in a second table.
      const existing = this.#database
        .prepare("SELECT patch_set_json FROM patch_sets WHERE run_id = ?")
        .get(runId);
      const supersedes = existing === undefined ? null : current.patchSet;
      invariant(
        existing === undefined || this.#supersessionIsAuthorized(current),
        "IMMUTABLE_ARTIFACT_CONFLICT",
        "A patch set is already recorded for this run",
      );
      const now = this.#now();
      if (supersedes !== null) {
        this.#appendEvent(runId, "patch_set.superseded", {
          digest: digestJson(asJsonValue(supersedes)),
          paths: supersedes.edits.map((edit) => edit.path).sort(),
        });
        this.#database.prepare("DELETE FROM patch_sets WHERE run_id = ?").run(runId);
        this.#database.prepare("DELETE FROM checkpoint_files WHERE run_id = ?").run(runId);
        this.#database.prepare("DELETE FROM checkpoints WHERE run_id = ?").run(runId);
      }
      this.#database
        .prepare("INSERT INTO patch_sets (run_id, patch_set_json, created_at) VALUES (?, ?, ?)")
        .run(runId, json(patchSet), now);
      const insertFile = this.#database.prepare(
        `INSERT INTO checkpoint_files (run_id, path, op, baseline_base64, approved_base64)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const file of files) {
        insertFile.run(runId, file.path, file.op, file.baselineBase64, file.approvedBase64);
      }
      const result = this.#database
        .prepare(
          `UPDATE runs SET diff = CASE WHEN ? THEN NULL ELSE diff END,
           verification_json = CASE WHEN ? THEN NULL ELSE verification_json END,
           version = version + 1, updated_at = ?
           WHERE id = ? AND state = 'running'`,
        )
        .run(supersedes === null ? 0 : 1, supersedes === null ? 0 : 1, now, runId);
      invariant(result.changes === 1, "CONCURRENT_RUN_UPDATE", "Run state changed concurrently");
      this.#appendEvent(runId, "patch_set.intent_recorded", {
        paths: editPaths,
        operations: patchSet.edits.map((edit) => edit.op),
      });
    });
    transaction();
    return this.getRun(runId);
  }

  /**
   * Repair attempts already spent, counted from the durable operation ledger
   * (ADR 0024) so the count survives a crash and cannot drift from the work
   * actually charged.
   */
  countSessionIterations(runId: string): number {
    const value = row(
      this.#database
        .prepare(
          `SELECT COUNT(*) AS used FROM operations
           WHERE run_id = ? AND kind = '${SESSION_ITERATION_OPERATION_KIND}'`,
        )
        .get(runId),
      "repair iteration count",
    );
    return numberValue(value.used, "repair.used");
  }

  /** Remaining approved repair attempts for a run (ADR 0024). */
  remainingIterationBudget(runId: string): number {
    return this.#iterationBudgetRemaining(this.getRun(runId));
  }
  /**
   * True only when a completed failing verification is the latest event that
   * established the verifying state. This lets crash recovery enter the
   * already-earned repair session without rerunning checks, while a later
   * restore still forces fresh verification.
   */
  sessionRepairReady(runId: string): boolean {
    const run = this.getRun(runId);
    if (
      run.state !== "verifying" ||
      run.verification?.outcome !== "failed" ||
      this.#iterationBudgetRemaining(run) === 0
    ) {
      return false;
    }
    const latest = this.#database
      .prepare(
        `SELECT type, payload_json FROM run_events
         WHERE run_id = ?
           AND type IN ('verification.completed', 'restore.completed')
         ORDER BY sequence DESC LIMIT 1`,
      )
      .get(runId);
    if (latest === undefined) return false;
    const event = row(latest, "session repair boundary");
    if (text(event.type, "run_events.type") !== "verification.completed") return false;
    const payload = parseJson<unknown>(event.payload_json, "run_events.payload_json");
    invariant(
      typeof payload === "object" && payload !== null && !Array.isArray(payload),
      "DATABASE_ERROR",
      "Session repair boundary payload is invalid",
    );
    const boundary = payload as Record<string, unknown>;
    return boundary.to === "verifying" && boundary.outcome === "failed";
  }

  #iterationBudgetRemaining(run: RunRecord): number {
    if (run.plan === null) return 0;
    const granted = Math.min(run.plan.iterationCeiling, MAX_SESSION_ITERATIONS);
    return Math.max(0, granted - this.countSessionIterations(run.id));
  }

  /**
   * A recorded patch set may be replaced only by a repair iteration that has
   * already been charged (ADR 0024). The grant is spent by the revise call
   * itself, so the replacement is authorized by that charge rather than by the
   * grant still remaining after it — otherwise a grant of one could never
   * record the revision it paid for. Exactly one supersession per charged
   * iteration, and never more iterations than the approved plan granted.
   */
  #supersessionIsAuthorized(run: RunRecord): boolean {
    if (run.plan === null) return false;
    const granted = Math.min(run.plan.iterationCeiling, MAX_SESSION_ITERATIONS);
    const charged = this.countSessionIterations(run.id);
    if (charged < 1 || charged > granted) return false;
    return this.#countEvents(run.id, "patch_set.superseded") < charged;
  }

  #countEvents(runId: string, type: string): number {
    const value = row(
      this.#database
        .prepare("SELECT COUNT(*) AS total FROM run_events WHERE run_id = ? AND type = ?")
        .get(runId, type),
      "run event count",
    );
    return numberValue(value.total, "run_events.total");
  }

  /**
   * Tool-grant spend is derived from durable operation admission, including
   * refused, failed, and interrupted calls. Counting started rows means a
   * process crash cannot resurrect capability budget.
   */
  countOperationsByKind(runId: string, kind: string): number {
    invariant(
      kind.length > 0 && kind.length <= 128 && !/[\r\n\0]/.test(kind),
      "INVALID_OPERATION_KIND",
      "Operation kind is invalid",
    );
    this.getRun(runId);
    const value = row(
      this.#database
        .prepare("SELECT COUNT(*) AS total FROM operations WHERE run_id = ? AND kind = ?")
        .get(runId, kind),
      "operation kind count",
    );
    return numberValue(value.total, "operations.total");
  }

  /**
   * Appends an iteration boundary only after its complete emitted batch has
   * settled. Provider/tool operations remain the source of spend; this event
   * is resumable evidence, not another counter.
   */
  recordSessionIterationBoundary(runId: string, iterations: number): RunRecord {
    invariant(
      Number.isSafeInteger(iterations) && iterations > 0,
      "INVALID_SESSION_ITERATION",
      "Session iteration boundary is invalid",
    );
    const transaction = this.#database.transaction(() => {
      const current = this.getRun(runId);
      invariant(
        current.state === "running" || current.state === "awaiting_review",
        "INVALID_STATE",
        "Session iteration is not active",
      );
      invariant(
        iterations === this.countSessionIterations(runId),
        "INVALID_SESSION_ITERATION",
        "Session iteration boundary does not match durable provider admission",
      );
      const latest = this.#latestSessionIterationBoundary(runId);
      invariant(
        latest === null || latest < iterations,
        "INVALID_SESSION_ITERATION",
        "Session iteration boundary is duplicate or nonmonotonic",
      );
      this.#appendEvent(runId, "session.iteration_completed", { iterations });
    });
    transaction();
    return this.getRun(runId);
  }
  /**
   * Lands a failed verification directly in non-approvable review when a
   * session cannot retain the ordinary reconciliation margin at entry.
   */
  recordSessionAdmissionExhausted(runId: string): RunRecord {
    const transaction = this.#database.transaction(() => {
      const current = this.getRun(runId);
      invariant(current.state === "verifying", "INVALID_STATE", "Run is not verifying");
      invariant(
        current.verification !== null && current.verification.outcome === "failed",
        "VERIFICATION_NOT_PASSED",
        "Session admission exhaustion requires failing verification",
      );
      invariant(
        this.#iterationBudgetRemaining(current) > 0,
        "ITERATION_BUDGET_EXHAUSTED",
        "Session admission has no approved iteration remaining",
      );
      assertTransition(current.state, "awaiting_review");
      const now = this.#now();
      const result = this.#database
        .prepare(
          `UPDATE runs SET state = 'awaiting_review', version = version + 1, updated_at = ?
           WHERE id = ? AND state = 'verifying'`,
        )
        .run(now, runId);
      invariant(result.changes === 1, "CONCURRENT_RUN_UPDATE", "Run state changed concurrently");
      this.#appendEvent(runId, "session.exhausted", {
        iterations: this.countSessionIterations(runId),
        reason: "recovery_margin",
      });
    });
    transaction();
    return this.getRun(runId);
  }

  /**
   * Lands a terminal agent-session disposition. A human question or exhausted
   * budget is intentionally non-approvable; review approval checks the latest
   * disposition before accepting otherwise-passing evidence.
   */
  recordSessionOutcome(
    runId: string,
    kind: "completed" | "awaiting_human" | "exhausted",
    textValue: string | null,
    iterations: number,
  ): RunRecord {
    this.#assertSessionOutcomeInput(kind, textValue, iterations);
    const transaction = this.#database.transaction(() => {
      this.#recordSessionOutcomeInTransaction(runId, kind, textValue, iterations);
    });
    transaction();
    return this.getRun(runId);
  }

  #assertSessionOutcomeInput(
    kind: "completed" | "awaiting_human" | "exhausted",
    textValue: string | null,
    iterations: number,
  ): void {
    invariant(
      Number.isSafeInteger(iterations) && iterations >= 0,
      "INVALID_SESSION_ITERATION",
      "Session outcome iteration count is invalid",
    );
    invariant(
      (kind === "exhausted" && textValue === null) ||
        (kind !== "exhausted" &&
          textValue !== null &&
          textValue.trim().length > 0 &&
          Buffer.byteLength(textValue, "utf8") <= 2_000 &&
          !/[\r\0]/.test(textValue)),
      "INVALID_SESSION_OUTCOME",
      "Session outcome text is invalid",
    );
  }

  #recordSessionOutcomeInTransaction(
    runId: string,
    kind: "completed" | "awaiting_human" | "exhausted",
    textValue: string | null,
    iterations: number,
    operationId?: string,
  ): void {
    const current = this.getRun(runId);
    invariant(current.state === "running", "INVALID_STATE", "Agent session is not running");
    invariant(
      iterations === this.countSessionIterations(runId),
      "INVALID_SESSION_ITERATION",
      "Session outcome does not match durable provider admission",
    );
    if (kind === "completed") {
      invariant(
        current.verification !== null &&
          current.verification.outcome === "passed" &&
          current.diff !== null,
        "VERIFICATION_NOT_PASSED",
        "Agent session cannot complete without current passing verification",
      );
      invariant(
        this.getCheckpoint(runId).checkpointSha256 === current.verification.checkpointSha256,
        "CHECKPOINT_MISMATCH",
        "Agent session verification is not bound to the current checkpoint",
      );
    }
    const now = this.#now();
    const result = this.#database
      .prepare(
        `UPDATE runs SET state = 'awaiting_review', version = version + 1, updated_at = ?
         WHERE id = ? AND state = 'running'`,
      )
      .run(now, runId);
    invariant(result.changes === 1, "CONCURRENT_RUN_UPDATE", "Run state changed concurrently");
    const eventType =
      kind === "completed"
        ? "session.completed"
        : kind === "awaiting_human"
          ? "session.awaiting_human"
          : "session.exhausted";
    this.#appendEvent(runId, eventType, {
      iterations,
      ...(operationId === undefined ? {} : { operationId }),
      ...(kind === "completed"
        ? { summary: textValue as string }
        : kind === "awaiting_human"
          ? { question: textValue as string }
          : {}),
    });
  }

  #latestSessionIterationBoundary(runId: string): number | null {
    const latest = this.#database
      .prepare(
        `SELECT payload_json FROM run_events
         WHERE run_id = ? AND type = 'session.iteration_completed'
         ORDER BY sequence DESC LIMIT 1`,
      )
      .get(runId);
    if (latest === undefined) return null;
    const payload = parseJson<unknown>(
      row(latest, "session iteration boundary").payload_json,
      "run_events.payload_json",
    );
    invariant(
      typeof payload === "object" && payload !== null && !Array.isArray(payload),
      "DATABASE_ERROR",
      "Session iteration boundary payload is invalid",
    );
    const iterations = (payload as Record<string, unknown>).iterations;
    invariant(
      typeof iterations === "number" && Number.isSafeInteger(iterations) && iterations > 0,
      "DATABASE_ERROR",
      "Session iteration boundary count is invalid",
    );
    return iterations;
  }

  #assertSessionCompletedForApproval(runId: string): void {
    const latest = this.#database
      .prepare(
        `SELECT sequence, type, payload_json FROM run_events
         WHERE run_id = ?
           AND type IN ('session.completed', 'session.awaiting_human', 'session.exhausted')
         ORDER BY sequence DESC LIMIT 1`,
      )
      .get(runId);
    if (latest === undefined) {
      invariant(
        this.countSessionIterations(runId) === 0,
        "SESSION_NOT_COMPLETED",
        "This agent session has no completed terminal disposition",
      );
      return;
    }
    const disposition = row(latest, "session disposition");
    invariant(
      text(disposition.type, "run_events.type") === "session.completed",
      "SESSION_NOT_COMPLETED",
      "This agent session paused or exhausted its budget and cannot be approved",
    );
    const sequence = numberValue(disposition.sequence, "run_events.sequence");
    const payload = parseJson<unknown>(disposition.payload_json, "run_events.payload_json");
    invariant(
      typeof payload === "object" && payload !== null && !Array.isArray(payload),
      "DATABASE_ERROR",
      "Session completion payload is invalid",
    );
    const completion = payload as Record<string, unknown>;
    invariant(
      Number.isSafeInteger(completion.iterations) &&
        (completion.iterations as number) > 0 &&
        completion.iterations === this.countSessionIterations(runId) &&
        typeof completion.operationId === "string" &&
        completion.operationId.length > 0,
      "SESSION_NOT_COMPLETED",
      "Session completion is not bound to its durable provider iteration",
    );
    const operation = this.#database
      .prepare("SELECT kind, status FROM operations WHERE id = ? AND run_id = ?")
      .get(completion.operationId, runId);
    invariant(
      operation !== undefined &&
        text(row(operation, "session completion operation").kind, "operations.kind") ===
          SESSION_REPORT_DONE_OPERATION_KIND &&
        text(row(operation, "session completion operation").status, "operations.status") ===
          "succeeded",
      "SESSION_NOT_COMPLETED",
      "Session completion is not paired with a succeeded report_done operation",
    );
    const finished = this.#database
      .prepare(
        `SELECT type, payload_json FROM run_events
         WHERE run_id = ? AND sequence = ?`,
      )
      .get(runId, sequence - 1);
    const finishedPayload =
      finished === undefined
        ? null
        : parseJson<unknown>(
            row(finished, "session completion operation event").payload_json,
            "run_events.payload_json",
          );
    invariant(
      finished !== undefined &&
        text(row(finished, "session completion operation event").type, "run_events.type") ===
          "operation.finished" &&
        typeof finishedPayload === "object" &&
        finishedPayload !== null &&
        !Array.isArray(finishedPayload) &&
        (finishedPayload as Record<string, unknown>).operationId === completion.operationId &&
        (finishedPayload as Record<string, unknown>).kind === SESSION_REPORT_DONE_OPERATION_KIND &&
        (finishedPayload as Record<string, unknown>).outcome === "succeeded",
      "SESSION_NOT_COMPLETED",
      "Session completion was not atomically paired after report_done settlement",
    );
  }

  /**
   * Re-enters execution after a failed verification. Requires an approved plan
   * carrying an unspent repair grant and a recorded failing verification; the
   * generic transition path stays closed to this edge.
   */
  beginSessionIteration(runId: string): RunRecord {
    const transaction = this.#database.transaction(() => {
      const current = this.getRun(runId);
      invariant(current.state === "verifying", "INVALID_STATE", "Run is not verifying");
      invariant(current.plan !== null, "MISSING_PLAN", "Repair requires an approved plan");
      invariant(
        current.planSha256 !== null &&
          this.#hasApproval(runId, "plan", current.planSha256, "approve"),
        "MISSING_APPROVAL",
        "Repair requires the exact approved plan",
      );
      invariant(
        current.verification !== null && current.verification.outcome === "failed",
        "VERIFICATION_NOT_PASSED",
        "Repair requires a recorded failing verification",
      );
      const remaining = this.#iterationBudgetRemaining(current);
      invariant(
        remaining > 0,
        "ITERATION_BUDGET_EXHAUSTED",
        "The approved iteration budget is exhausted",
      );
      const project = this.getProject(current.projectId);
      invariant(
        current.usage.toolCalls + 1 <= project.ceiling.maxToolCalls,
        "TOOL_BUDGET_EXCEEDED",
        "Session entry requires one ordinary operation slot for recovery",
      );
      invariant(
        current.usage.activeRuntimeMs + project.ceiling.commandTimeoutMs <=
          project.ceiling.maxActiveRuntimeMs,
        "RUNTIME_BUDGET_EXCEEDED",
        "Session entry requires command runtime for recovery",
      );
      assertTransition(current.state, "running");
      const now = this.#now();
      const result = this.#database
        .prepare(
          `UPDATE runs SET state = 'running', resume_state = NULL, error_code = NULL,
           error_message = NULL, version = version + 1, updated_at = ?
           WHERE id = ? AND state = 'verifying'`,
        )
        .run(now, runId);
      invariant(result.changes === 1, "CONCURRENT_RUN_UPDATE", "Run state changed concurrently");
      this.#appendEvent(runId, "repair.requested", {
        from: "verifying",
        to: "running",
        remaining,
      });
    });
    transaction();
    return this.getRun(runId);
  }

  listCheckpointFiles(runId: string): CheckpointFile[] {
    const rows = this.#database
      .prepare(
        `SELECT path, op, baseline_base64, approved_base64 FROM checkpoint_files
         WHERE run_id = ? ORDER BY path ASC`,
      )
      .all(runId) as unknown[];
    return rows.map((entry) => {
      const value = row(entry, "checkpoint file");
      const op = text(value.op, "checkpoint file.op");
      invariant(
        op === "modify" || op === "create" || op === "delete",
        "DATABASE_ERROR",
        "checkpoint file.op is invalid",
      );
      return {
        path: assertRepositoryRelativePath(text(value.path, "checkpoint file.path")),
        op,
        baselineBase64: nullableText(value.baseline_base64, "checkpoint file.baseline_base64"),
        approvedBase64: nullableText(value.approved_base64, "checkpoint file.approved_base64"),
      };
    });
  }

  #readPatchSet(runId: string, value: Row): PatchSet | null {
    const stored = this.#database
      .prepare("SELECT patch_set_json FROM patch_sets WHERE run_id = ?")
      .get(runId);
    if (stored !== undefined) {
      return parseJson<PatchSet>(
        row(stored, "patch set").patch_set_json,
        "patch_sets.patch_set_json",
      );
    }
    // Schema v1 rows are presented as the equivalent single modify edit rather
    // than rewritten in place (ADR 0023).
    const legacy = nullableJson<EditProposal>(value.edit_json, "run.edit_json");
    if (legacy === null) return null;
    return {
      summary: legacy.rationale,
      edits: [
        {
          op: "modify",
          path: legacy.path,
          expectedPreimageSha256: legacy.expectedPreimageSha256,
          replacements: [{ findText: legacy.findText, replaceText: legacy.replaceText }],
          rationale: legacy.rationale,
        },
      ],
    };
  }

  /**
   * Records a completed verification attempt. `nextState` is `awaiting_review`
   * for a landing attempt, `verifying` for an initial failure an approved
   * session will retry, and `running` for a tool-led session check. Either way
   * the complete evidence and diff are appended to the event stream.
   */
  recordVerificationAndAwaitReview(
    runId: string,
    diff: string,
    verification: VerificationEvidence,
    nextState: "awaiting_review" | "verifying" | "running" = "awaiting_review",
  ): RunRecord {
    const transaction = this.#database.transaction(() => {
      this.#recordVerificationInTransaction(runId, diff, verification, nextState);
    });
    transaction();
    return this.getRun(runId);
  }

  #recordVerificationInTransaction(
    runId: string,
    diff: string,
    verification: VerificationEvidence,
    nextState: "awaiting_review" | "verifying" | "running",
  ): void {
    const current = this.getRun(runId);
    invariant(
      current.state === "verifying" || (current.state === "running" && nextState === "running"),
      "INVALID_STATE",
      "Run is not verifying",
    );
    invariant(current.plan !== null, "MISSING_PLAN", "Run has no approved plan");
    const project = this.getProject(current.projectId);
    invariant(diff.length > 0, "EMPTY_DIFF", "Verification diff is empty");
    invariant(
      Buffer.byteLength(diff, "utf8") <= project.ceiling.maxDiffBytes,
      "DIFF_BUDGET_EXCEEDED",
      "Verification diff exceeds the byte ceiling",
    );
    invariant(
      sha256(diff) === verification.diffSha256,
      "VERIFICATION_DIGEST_MISMATCH",
      "Verification digest does not match the persisted diff",
    );
    invariant(
      this.#changedPathsMatchPatchSet(current, verification.changedPaths),
      "CHANGED_PATH_MISMATCH",
      "Verification must contain exactly the patch-set paths",
    );
    const expectedChecks = current.plan.checkIds.map((checkId) => {
      const check = project.checks.find((candidate) => candidate.id === checkId);
      invariant(check !== undefined, "CHECK_MISMATCH", "Approved plan references an unknown check");
      return check;
    });
    invariant(
      verification.checks.length === expectedChecks.length &&
        verification.checks.every(
          (evidence, index) =>
            evidence.checkId === expectedChecks[index]?.id &&
            JSON.stringify(evidence.argv) === JSON.stringify(expectedChecks[index]?.argv) &&
            Buffer.byteLength(evidence.stdout, "utf8") +
              Buffer.byteLength(evidence.stderr, "utf8") <=
              project.ceiling.maxCommandOutputBytes,
        ),
      "CHECK_EVIDENCE_MISMATCH",
      "Verification evidence does not match the approved check profile",
    );
    const derivedOutcome = verification.checks.every((evidence) => evidence.outcome === "passed")
      ? "passed"
      : verification.checks.some((evidence) => evidence.outcome === "failed")
        ? "failed"
        : "unavailable";
    invariant(
      verification.outcome === derivedOutcome,
      "VERIFICATION_OUTCOME_MISMATCH",
      "Verification outcome does not match its check evidence",
    );
    invariant(
      this.getCheckpoint(runId).checkpointSha256 === verification.checkpointSha256,
      "CHECKPOINT_MISMATCH",
      "Verification is not bound to the immutable checkpoint",
    );
    if (nextState === "verifying") {
      invariant(
        verification.outcome === "failed",
        "VERIFICATION_OUTCOME_MISMATCH",
        "Only a failing verification may be retained for repair",
      );
      invariant(
        this.#iterationBudgetRemaining(current) > 0,
        "ITERATION_BUDGET_EXHAUSTED",
        "The approved iteration budget is exhausted",
      );
    }
    const now = this.#now();
    const result = this.#database
      .prepare(
        `UPDATE runs SET diff = ?, verification_json = ?, state = ?,
         version = version + 1, updated_at = ? WHERE id = ? AND state = ?`,
      )
      .run(diff, json(verification), nextState, now, runId, current.state);
    invariant(result.changes === 1, "CONCURRENT_RUN_UPDATE", "Run state changed concurrently");
    this.#appendEvent(runId, "verification.completed", {
      from: current.state,
      to: nextState,
      outcome: verification.outcome,
      diffSha256: verification.diffSha256,
      diff,
      verification,
    });
  }

  /**
   * A patch-set run's changed paths must equal its patch-set paths exactly. A
   * run recorded before ADR 0023 keeps the single-target rule.
   */
  #changedPathsMatchPatchSet(run: RunRecord, changedPaths: readonly string[]): boolean {
    if (run.patchSet === null) {
      return changedPaths.length === 1 && changedPaths[0] === run.target;
    }
    const expected = [...run.patchSet.edits.map((edit) => edit.path)].sort();
    const observed = [...changedPaths].sort();
    return (
      expected.length === observed.length &&
      expected.every((expectedPath, index) => expectedPath === observed[index])
    );
  }

  /**
   * Anchors a patch-set run's restorable state. Per-path bytes live in
   * `checkpoint_files`; the legacy byte columns are stored empty because they
   * describe a shape this run does not have.
   */
  saveTreeCheckpoint(runId: string, checkpointSha256: string): CheckpointRecord {
    const run = this.getRun(runId);
    invariant(run.patchSet !== null, "MISSING_EDIT_STATE", "Run has no recorded patch set");
    const files = this.listCheckpointFiles(runId);
    invariant(files.length > 0, "MISSING_CHECKPOINT", "Run has no persisted checkpoint files");
    invariant(
      treeCheckpointDigest({ runId, baseCommit: run.baseCommit, files }) === checkpointSha256,
      "CHECKPOINT_MISMATCH",
      "Checkpoint digest does not match its persisted bytes",
    );
    const existing = this.#database
      .prepare("SELECT * FROM checkpoints WHERE run_id = ?")
      .get(runId);
    if (existing !== undefined) {
      const checkpoint = this.getCheckpoint(runId);
      invariant(
        checkpoint.checkpointSha256 === checkpointSha256,
        "CHECKPOINT_MISMATCH",
        "An immutable checkpoint already exists with different contents",
      );
      return checkpoint;
    }
    const createdAt = this.#now();
    const transaction = this.#database.transaction(() => {
      this.#database
        .prepare(
          `INSERT INTO checkpoints (run_id, baseline_base64, approved_base64, checkpoint_sha256, created_at)
           VALUES (?, '', '', ?, ?)`,
        )
        .run(runId, checkpointSha256, createdAt);
      this.#appendEvent(runId, "checkpoint.saved", { checkpointSha256 });
    });
    transaction();
    return { runId, baselineBase64: "", approvedBase64: "", checkpointSha256, createdAt };
  }

  /** Retained for runs recorded before ADR 0023. */
  saveCheckpoint(
    runId: string,
    baselineBase64: string,
    approvedBase64: string,
    checkpointSha256: string,
  ): CheckpointRecord {
    const run = this.getRun(runId);
    invariant(
      run.baselineBase64 === baselineBase64 && run.approvedBase64 === approvedBase64,
      "CHECKPOINT_MISMATCH",
      "Checkpoint bytes do not match the persisted edit intent",
    );
    invariant(
      checkpointDigest({
        runId,
        baseCommit: run.baseCommit,
        target: run.target,
        baselineBase64,
        approvedBase64,
      }) === checkpointSha256,
      "CHECKPOINT_MISMATCH",
      "Checkpoint digest does not match its persisted bytes",
    );
    const existing = this.#database
      .prepare("SELECT * FROM checkpoints WHERE run_id = ?")
      .get(runId);
    if (existing !== undefined) {
      const checkpoint = this.getCheckpoint(runId);
      invariant(
        checkpoint.baselineBase64 === baselineBase64 &&
          checkpoint.approvedBase64 === approvedBase64 &&
          checkpoint.checkpointSha256 === checkpointSha256,
        "CHECKPOINT_MISMATCH",
        "An immutable checkpoint already exists with different contents",
      );
      return checkpoint;
    }
    const createdAt = this.#now();
    const transaction = this.#database.transaction(() => {
      this.#database
        .prepare(
          `INSERT INTO checkpoints (run_id, baseline_base64, approved_base64, checkpoint_sha256, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(runId, baselineBase64, approvedBase64, checkpointSha256, createdAt);
      this.#appendEvent(runId, "checkpoint.saved", { checkpointSha256 });
    });
    transaction();
    return { runId, baselineBase64, approvedBase64, checkpointSha256, createdAt };
  }

  getCheckpoint(runId: string): CheckpointRecord {
    const value = row(
      this.#database.prepare("SELECT * FROM checkpoints WHERE run_id = ?").get(runId),
      "checkpoint",
    );
    return {
      runId: text(value.run_id, "checkpoint.run_id"),
      baselineBase64: text(value.baseline_base64, "checkpoint.baseline_base64"),
      approvedBase64: text(value.approved_base64, "checkpoint.approved_base64"),
      checkpointSha256: text(value.checkpoint_sha256, "checkpoint.checkpoint_sha256"),
      createdAt: text(value.created_at, "checkpoint.created_at"),
    };
  }

  failRun(runId: string, resumeState: RunState, error: IcarusError): RunRecord {
    const transaction = this.#database.transaction(() => {
      const current = this.getRun(runId);
      if (current.state !== "failed") {
        assertTransition(current.state, "failed");
      }
      const now = this.#now();
      this.#database
        .prepare(
          `UPDATE runs SET state = 'failed', resume_state = ?, error_code = ?, error_message = ?,
           version = version + 1, updated_at = ? WHERE id = ?`,
        )
        .run(resumeState, error.code, error.message, now, runId);
      this.#appendEvent(runId, "run.failed", {
        from: current.state,
        to: "failed",
        resumeState,
        code: error.code,
        message: error.message,
      });
    });
    transaction();
    return this.getRun(runId);
  }

  resumeFailed(runId: string): RunRecord {
    const transaction = this.#database.transaction(() => {
      const current = this.getRun(runId);
      invariant(current.state === "failed", "INVALID_STATE", "Only a failed run can be resumed");
      invariant(
        current.resumeState === "preparing" ||
          current.resumeState === "planned" ||
          current.resumeState === "running" ||
          current.resumeState === "verifying" ||
          current.resumeState === "rolling_back" ||
          current.resumeState === "restoring" ||
          current.resumeState === "cancelling",
        "INVALID_RESUME_STATE",
        "Failed run has no safe resume state",
      );
      this.#assertNoOtherActiveRun(current.projectId, runId);
      if (current.resumeState === "running" || current.resumeState === "verifying") {
        invariant(
          current.planSha256 !== null &&
            this.#hasApproval(runId, "plan", current.planSha256, "approve"),
          "MISSING_APPROVAL",
          "Run cannot resume execution without its exact plan approval",
        );
      }
      if (
        current.resumeState === "verifying" ||
        current.resumeState === "rolling_back" ||
        current.resumeState === "restoring"
      ) {
        invariant(
          current.worktreePath !== null,
          "MISSING_CHECKPOINT",
          "Run cannot resume recovery without its private worktree",
        );
        const modernPatchSet =
          this.#database.prepare("SELECT 1 FROM patch_sets WHERE run_id = ?").get(runId) !==
          undefined;
        if (modernPatchSet) {
          const checkpointFileCount = numberValue(
            row(
              this.#database
                .prepare("SELECT COUNT(*) AS total FROM checkpoint_files WHERE run_id = ?")
                .get(runId),
              "checkpoint file count",
            ).total,
            "checkpoint_files.total",
          );
          invariant(
            checkpointFileCount > 0,
            "MISSING_CHECKPOINT",
            "Patch-set run cannot resume without persisted checkpoint files",
          );
        } else {
          const legacy = row(
            this.#database.prepare("SELECT edit_json FROM runs WHERE id = ?").get(runId),
            "legacy edit state",
          );
          invariant(
            typeof legacy.edit_json === "string" &&
              current.baselineBase64 !== null &&
              current.approvedBase64 !== null,
            "MISSING_CHECKPOINT",
            "Legacy run cannot resume without its applied edit bytes",
          );
        }
        if (current.resumeState === "rolling_back" || current.resumeState === "restoring") {
          invariant(
            this.#database.prepare("SELECT 1 FROM checkpoints WHERE run_id = ?").get(runId) !==
              undefined,
            "MISSING_CHECKPOINT",
            "Recovery state cannot resume without its immutable checkpoint",
          );
        }
      }
      const now = this.#now();
      const result = this.#database
        .prepare(
          `UPDATE runs SET state = resume_state, resume_state = NULL, error_code = NULL,
           error_message = NULL, version = version + 1, updated_at = ?
           WHERE id = ? AND state = 'failed'`,
        )
        .run(now, runId);
      invariant(result.changes === 1, "CONCURRENT_RUN_UPDATE", "Run state changed concurrently");
      this.#appendEvent(runId, "run.resumed", {
        from: "failed",
        to: current.resumeState,
      });
    });
    transaction();
    return this.getRun(runId);
  }

  beginOperation(
    runId: string,
    kind: string,
    reservedCostUsd: number,
    reservedTokens: number,
    reservedRuntimeMs: number,
    expectedState?: RunState,
  ): OperationToken {
    return this.#beginOperation(
      runId,
      kind,
      reservedCostUsd,
      reservedTokens,
      reservedRuntimeMs,
      "ordinary",
      expectedState,
    );
  }

  beginCancellationRecoveryOperation(runId: string): OperationToken {
    return this.#beginOperation(
      runId,
      CANCELLATION_RECOVERY_OPERATION_KIND,
      0,
      0,
      CANCELLATION_RECOVERY_RUNTIME_MS,
      "emergency",
    );
  }

  #beginOperation(
    runId: string,
    kind: string,
    reservedCostUsd: number,
    reservedTokens: number,
    reservedRuntimeMs: number,
    budgetClass: "ordinary" | "emergency",
    expectedState?: RunState,
  ): OperationToken {
    invariant(
      Number.isFinite(reservedCostUsd) && reservedCostUsd >= 0,
      "INVALID_RESERVATION",
      "Reserved cost must be finite and nonnegative",
    );
    invariant(
      Number.isSafeInteger(reservedTokens) && reservedTokens >= 0,
      "INVALID_RESERVATION",
      "Reserved tokens must be a nonnegative integer",
    );
    invariant(
      Number.isSafeInteger(reservedRuntimeMs) && reservedRuntimeMs > 0,
      "INVALID_RESERVATION",
      "Reserved runtime must be a positive integer",
    );
    let token: OperationToken | undefined;
    const transaction = this.#database.transaction(() => {
      const run = this.getRun(runId);
      invariant(
        expectedState === undefined || run.state === expectedState,
        "RUN_BUSY",
        "Run state changed before operation admission",
      );
      invariant(
        this.#database
          .prepare("SELECT 1 FROM operations WHERE run_id = ? AND status = 'started' LIMIT 1")
          .get(runId) === undefined,
        "RUN_BUSY",
        "Another process is already executing this run",
      );
      let recoveryAttempt: number | undefined;
      if (budgetClass === "emergency") {
        invariant(
          run.state === "cancelling" &&
            kind === CANCELLATION_RECOVERY_OPERATION_KIND &&
            reservedCostUsd === 0 &&
            reservedTokens === 0 &&
            reservedRuntimeMs === CANCELLATION_RECOVERY_RUNTIME_MS,
          "INVALID_EMERGENCY_OPERATION",
          "Emergency budget is restricted to fixed cancellation recovery",
        );
        const attempts = numberValue(
          row(
            this.#database
              .prepare("SELECT COUNT(*) AS count FROM operations WHERE run_id = ? AND kind = ?")
              .get(runId, CANCELLATION_RECOVERY_OPERATION_KIND),
            "cancellation recovery attempts",
          ).count,
          "cancellation recovery attempts.count",
        );
        invariant(
          attempts < MAX_CANCELLATION_RECOVERY_ATTEMPTS,
          "RECOVERY_ATTEMPTS_EXHAUSTED",
          "Cancellation recovery attempt limit exhausted",
        );
        recoveryAttempt = attempts + 1;
      } else {
        const project = this.getProject(run.projectId);
        invariant(
          kind !== CANCELLATION_RECOVERY_OPERATION_KIND,
          "INVALID_EMERGENCY_OPERATION",
          "Cancellation recovery kind is reserved for its emergency operation",
        );
        invariant(
          run.usage.toolCalls + 1 <= project.ceiling.maxToolCalls,
          "TOOL_BUDGET_EXCEEDED",
          "Tool-call ceiling exhausted",
        );
        invariant(
          run.usage.activeRuntimeMs + reservedRuntimeMs <= project.ceiling.maxActiveRuntimeMs,
          "RUNTIME_BUDGET_EXCEEDED",
          "Active-runtime reservation would exceed the ceiling",
        );
        invariant(
          run.usage.inputTokens + run.usage.outputTokens + reservedTokens <=
            project.ceiling.maxTotalTokens,
          "TOKEN_BUDGET_EXCEEDED",
          "Token ceiling would be exceeded",
        );
        invariant(
          run.usage.estimatedCostUsd + run.usage.reservedCostUsd + reservedCostUsd <=
            project.ceiling.maxCostUsd,
          "COST_BUDGET_EXCEEDED",
          "Cost ceiling would be exceeded",
        );
      }
      const id = this.#id();
      const now = this.#now();
      this.#database
        .prepare(
          `INSERT INTO operations
           (id, run_id, kind, status, reserved_cost_usd, reserved_tokens,
            reserved_runtime_ms, started_at)
           VALUES (?, ?, ?, 'started', ?, ?, ?, ?)`,
        )
        .run(id, runId, kind, reservedCostUsd, reservedTokens, reservedRuntimeMs, now);
      this.#database
        .prepare(
          `UPDATE runs SET tool_calls = tool_calls + 1,
           reserved_cost_usd = reserved_cost_usd + ?, updated_at = ? WHERE id = ?`,
        )
        .run(reservedCostUsd, now, runId);
      this.#appendEvent(runId, "operation.started", {
        operationId: id,
        kind,
        reservedCostUsd,
        reservedTokens,
        reservedRuntimeMs,
        ...(budgetClass === "emergency"
          ? { budgetClass: "emergency", attempt: recoveryAttempt ?? 0 }
          : {}),
      });
      token = {
        id,
        runId,
        kind,
        reservedCostUsd,
        reservedTokens,
        reservedRuntimeMs,
      };
    });
    try {
      transaction.immediate();
    } catch (error) {
      if (isSqliteBusy(error)) {
        throw new IcarusError("RUN_BUSY", "Another process is updating run state");
      }
      throw error;
    }
    invariant(token !== undefined, "DATABASE_ERROR", "Operation token was not created");
    return token;
  }

  finishOperation(token: OperationToken, finish: OperationFinish): RunRecord {
    return this.#finishOperation(token, finish, false);
  }

  /**
   * Atomically settles a session check or patch application and persists the
   * resulting current verification snapshot. A validation failure rolls the
   * operation back to `started` together with every usage/event write.
   */
  finishSessionVerificationOperation(
    token: OperationToken,
    finish: OperationFinish,
    diff: string,
    verification: VerificationEvidence,
  ): RunRecord {
    this.#assertAtomicOperationSettlementInput(token, finish, [
      SESSION_CHECK_OPERATION_KIND,
      SESSION_PATCH_OPERATION_KIND,
      SESSION_RECONCILE_OPERATION_KIND,
    ]);
    const transaction = this.#database.transaction(() => {
      invariant(
        this.getRun(token.runId).state === "running",
        "INVALID_STATE",
        "Session verification can only settle while the session is running",
      );
      this.#finishOperationInTransaction(token, finish, false);
      this.#recordVerificationInTransaction(token.runId, diff, verification, "running");
    });
    transaction();
    return this.getRun(token.runId);
  }
  /**
   * Atomically records a patch action that changed durable intent but missed
   * its operation boundary. Only an unavailable snapshot may accompany the
   * failed/cancelled patch operation, so the state remains non-authoritative
   * while still exposing a rollback digest.
   */
  finishFailedSessionPatchVerificationOperation(
    token: OperationToken,
    finish: OperationFinish,
    diff: string,
    verification: VerificationEvidence,
  ): RunRecord {
    invariant(
      token.kind === SESSION_PATCH_OPERATION_KIND,
      "OPERATION_TOKEN_MISMATCH",
      "Only a session patch operation can settle a failed patch snapshot",
    );
    invariant(
      finish.outcome === "failed" || finish.outcome === "cancelled",
      "INVALID_OPERATION_OUTCOME",
      "Failed patch settlement requires a failed or cancelled operation",
    );
    invariant(
      verification.outcome === "unavailable",
      "VERIFICATION_OUTCOME_MISMATCH",
      "Failed patch settlement can only persist unavailable verification",
    );
    this.#assertOperationFinishInput(finish);
    const transaction = this.#database.transaction(() => {
      invariant(
        this.getRun(token.runId).state === "running",
        "INVALID_STATE",
        "Failed session patch can only settle while the session is running",
      );
      this.#finishOperationInTransaction(token, finish, false);
      this.#recordVerificationInTransaction(token.runId, diff, verification, "running");
    });
    transaction();
    return this.getRun(token.runId);
  }

  /** Atomically settles report_done/request_human_input and its disposition. */
  finishSessionControlOperation(
    token: OperationToken,
    finish: OperationFinish,
    kind: "completed" | "awaiting_human",
    textValue: string,
    iterations: number,
  ): RunRecord {
    const expectedKind =
      kind === "completed"
        ? SESSION_REPORT_DONE_OPERATION_KIND
        : SESSION_REQUEST_HUMAN_OPERATION_KIND;
    this.#assertAtomicOperationSettlementInput(token, finish, [expectedKind]);
    this.#assertSessionOutcomeInput(kind, textValue, iterations);
    const transaction = this.#database.transaction(() => {
      invariant(
        this.getRun(token.runId).state === "running",
        "INVALID_STATE",
        "Session control can only settle while the session is running",
      );
      this.#finishOperationInTransaction(token, finish, false);
      this.#recordSessionOutcomeInTransaction(token.runId, kind, textValue, iterations, token.id);
    });
    transaction();
    return this.getRun(token.runId);
  }

  /** Atomically settles review.validate and records the bound approval. */
  finishReviewValidationAndApprove(
    token: OperationToken,
    finish: OperationFinish,
    digest: string,
    actor: string,
  ): RunRecord {
    this.#assertAtomicOperationSettlementInput(token, finish, [REVIEW_VALIDATION_OPERATION_KIND]);
    const approval = reviewApprovalTransition(digest, actor, "approve");
    const transaction = this.#database.transaction(() => {
      invariant(
        this.getRun(token.runId).state === "awaiting_review",
        "INVALID_STATE",
        "Review validation can only settle at the review gate",
      );
      this.#finishOperationInTransaction(token, finish, false);
      this.#assertSessionCompletedForApproval(token.runId);
      this.#approveAndTransitionInTransaction(token.runId, approval);
    });
    transaction();
    return this.getRun(token.runId);
  }

  /** Atomically settles checkpoint rollback/restore and its state transition. */
  finishCheckpointRecoveryOperation(token: OperationToken, finish: OperationFinish): RunRecord {
    this.#assertAtomicOperationSettlementInput(token, finish, [
      CHECKPOINT_ROLLBACK_OPERATION_KIND,
      CHECKPOINT_RESTORE_OPERATION_KIND,
    ]);
    const rollback = token.kind === CHECKPOINT_ROLLBACK_OPERATION_KIND;
    const expectedState: RunState = rollback ? "rolling_back" : "restoring";
    const to: RunState = rollback ? "rolled_back" : "verifying";
    const eventType = rollback ? "rollback.completed" : "restore.completed";
    const transaction = this.#database.transaction(() => {
      invariant(
        this.getRun(token.runId).state === expectedState,
        "INVALID_STATE",
        "Checkpoint recovery operation is not at its expected state",
      );
      this.#finishOperationInTransaction(token, finish, false);
      this.#finishInternalTransitionInTransaction(token.runId, expectedState, to, eventType);
    });
    transaction();
    return this.getRun(token.runId);
  }

  finishCancellationRecoveryOperation(token: OperationToken, finish: OperationFinish): RunRecord {
    invariant(
      token.kind === CANCELLATION_RECOVERY_OPERATION_KIND,
      "INVALID_EMERGENCY_OPERATION",
      "Emergency finish is restricted to cancellation recovery",
    );
    return this.#finishOperation(
      token,
      {
        ...finish,
        detail: emergencyOperationDetail(finish.detail),
      },
      true,
    );
  }

  #assertAtomicOperationSettlementInput(
    token: OperationToken,
    finish: OperationFinish,
    expectedKinds: readonly string[],
  ): void {
    invariant(
      expectedKinds.includes(token.kind),
      "OPERATION_TOKEN_MISMATCH",
      "Operation token kind cannot settle this durable action",
    );
    invariant(
      finish.outcome === "succeeded",
      "INVALID_OPERATION_OUTCOME",
      "Only a succeeded operation can settle a durable action",
    );
    this.#assertOperationFinishInput(finish);
  }

  #finishOperation(token: OperationToken, finish: OperationFinish, emergency: boolean): RunRecord {
    this.#assertOperationFinishInput(finish);
    const transaction = this.#database.transaction(() => {
      this.#finishOperationInTransaction(token, finish, emergency);
    });
    transaction();
    return this.getRun(token.runId);
  }

  #assertOperationFinishInput(finish: OperationFinish): void {
    invariant(
      Number.isFinite(finish.activeRuntimeMs) && finish.activeRuntimeMs >= 0,
      "INVALID_OPERATION_USAGE",
      "Operation runtime is invalid",
    );
    for (const [name, value] of [
      ["inputTokens", finish.inputTokens],
      ["outputTokens", finish.outputTokens],
    ] as const) {
      invariant(
        value === null || (Number.isSafeInteger(value) && value >= 0),
        "INVALID_OPERATION_USAGE",
        `${name} is invalid`,
      );
    }
    invariant(
      finish.estimatedCostUsd === null ||
        (Number.isFinite(finish.estimatedCostUsd) && finish.estimatedCostUsd >= 0),
      "INVALID_OPERATION_USAGE",
      "Operation cost is invalid",
    );
  }

  #finishOperationInTransaction(
    token: OperationToken,
    finish: OperationFinish,
    emergency: boolean,
  ): void {
    const operation = row(
      this.#database
        .prepare("SELECT * FROM operations WHERE id = ? AND run_id = ?")
        .get(token.id, token.runId),
      "operation",
    );
    const persistedKind = text(operation.kind, "operation.kind");
    invariant(
      persistedKind === token.kind &&
        numberValue(operation.reserved_cost_usd, "operation.reserved_cost_usd") ===
          token.reservedCostUsd &&
        numberValue(operation.reserved_tokens, "operation.reserved_tokens") ===
          token.reservedTokens &&
        numberValue(operation.reserved_runtime_ms, "operation.reserved_runtime_ms") ===
          token.reservedRuntimeMs,
      "OPERATION_TOKEN_MISMATCH",
      "Operation token does not match its persisted reservation",
    );
    invariant(
      emergency === (persistedKind === CANCELLATION_RECOVERY_OPERATION_KIND),
      "INVALID_EMERGENCY_OPERATION",
      "Cancellation recovery must use its dedicated finish path",
    );
    invariant(
      text(operation.status, "operation.status") === "started",
      "OPERATION_ALREADY_FINISHED",
      "Operation is not active",
    );
    const actualCost = finish.estimatedCostUsd ?? token.reservedCostUsd;
    invariant(
      actualCost <= token.reservedCostUsd + Number.EPSILON,
      "OPERATION_COST_EXCEEDED",
      "Provider reported a cost above its reserved worst case",
    );
    const actualTokens =
      finish.inputTokens === null || finish.outputTokens === null
        ? token.reservedTokens
        : finish.inputTokens + finish.outputTokens;
    invariant(
      actualTokens <= token.reservedTokens,
      "OPERATION_TOKENS_EXCEEDED",
      "Provider reported token usage above its reservation",
    );
    invariant(
      finish.activeRuntimeMs <= token.reservedRuntimeMs,
      "OPERATION_RUNTIME_EXCEEDED",
      "Operation exceeded its runtime reservation",
    );
    const run = this.getRun(token.runId);
    if (emergency) {
      invariant(
        run.state === "cancelling",
        "INVALID_STATE",
        "Cancellation recovery can only finish while the run is cancelling",
      );
    } else {
      const project = this.getProject(run.projectId);
      invariant(
        run.usage.activeRuntimeMs + finish.activeRuntimeMs <= project.ceiling.maxActiveRuntimeMs,
        "RUNTIME_BUDGET_EXCEEDED",
        "Operation exceeded the active-runtime ceiling",
      );
    }
    const now = this.#now();
    this.#database
      .prepare("UPDATE operations SET status = ?, result_json = ?, finished_at = ? WHERE id = ?")
      .run(finish.outcome, json(finish.detail), now, token.id);
    this.#database
      .prepare(
        `UPDATE runs SET reserved_cost_usd = MAX(0, reserved_cost_usd - ?),
         estimated_cost_usd = estimated_cost_usd + ?, input_tokens = input_tokens + ?,
         output_tokens = output_tokens + ?, active_runtime_ms = active_runtime_ms + ?,
         updated_at = ? WHERE id = ?`,
      )
      .run(
        token.reservedCostUsd,
        actualCost,
        finish.inputTokens === null || finish.outputTokens === null
          ? actualTokens
          : finish.inputTokens,
        finish.inputTokens === null || finish.outputTokens === null ? 0 : finish.outputTokens,
        finish.activeRuntimeMs,
        now,
        token.runId,
      );
    this.#appendEvent(token.runId, "operation.finished", {
      operationId: token.id,
      kind: token.kind,
      outcome: finish.outcome,
      detail: finish.detail,
    });
  }

  markStartedOperationsInterrupted(runId: string): RunRecord {
    const transaction = this.#database.transaction(() => {
      const operations = this.#database
        .prepare("SELECT * FROM operations WHERE run_id = ? AND status = 'started'")
        .all(runId) as unknown[];
      for (const entry of operations) {
        const operation = row(entry, "operation");
        const operationId = text(operation.id, "operation.id");
        const operationKind = text(operation.kind, "operation.kind");
        const reservedCost = numberValue(
          operation.reserved_cost_usd,
          "operation.reserved_cost_usd",
        );
        const now = this.#now();
        this.#database
          .prepare("UPDATE operations SET status = 'interrupted', finished_at = ? WHERE id = ?")
          .run(now, operationId);
        this.#database
          .prepare(
            `UPDATE runs SET reserved_cost_usd = MAX(0, reserved_cost_usd - ?),
             estimated_cost_usd = estimated_cost_usd + ?, updated_at = ? WHERE id = ?`,
          )
          .run(reservedCost, reservedCost, now, runId);
        const reservedTokens = numberValue(operation.reserved_tokens, "operation.reserved_tokens");
        const reservedRuntimeMs = numberValue(
          operation.reserved_runtime_ms,
          "operation.reserved_runtime_ms",
        );
        this.#database
          .prepare(
            `UPDATE runs SET input_tokens = input_tokens + ?,
             active_runtime_ms = active_runtime_ms + ?, updated_at = ? WHERE id = ?`,
          )
          .run(reservedTokens, reservedRuntimeMs, now, runId);
        this.#appendEvent(runId, "operation.interrupted", {
          operationId,
          kind: operationKind,
          reservedCostUsd: reservedCost,
          reservedTokens,
          reservedRuntimeMs,
          ...(operationKind === CANCELLATION_RECOVERY_OPERATION_KIND
            ? { budgetClass: "emergency" }
            : {}),
        });
      }
    });
    transaction();
    return this.getRun(runId);
  }

  listEvents(runId: string): EventRecord[] {
    this.getRun(runId);
    return (
      this.#database
        .prepare("SELECT * FROM run_events WHERE run_id = ? ORDER BY sequence")
        .all(runId) as unknown[]
    ).map((entry) => {
      const value = row(entry, "event");
      return {
        sequence: numberValue(value.sequence, "event.sequence"),
        runId: text(value.run_id, "event.run_id"),
        type: text(value.type, "event.type"),
        payload: parseJson<JsonValue>(value.payload_json, "event.payload_json"),
        createdAt: text(value.created_at, "event.created_at"),
      };
    });
  }

  getRunHistory(runId: string): RunHistory {
    const transaction = this.#database.transaction(() => ({
      run: this.getRun(runId),
      approvals: this.listApprovals(runId),
      events: this.listEvents(runId),
    }));
    return transaction();
  }

  getRunPresentationSnapshot(runId: string): RunPresentationSnapshot {
    const summary = (entry: unknown, name: string): EventSummaryRecord => {
      const value = row(entry, name);
      const event = {
        sequence: numberValue(value.sequence, "event.sequence"),
        runId: text(value.run_id, "event.run_id"),
        type: text(value.type, "event.type"),
        createdAt: text(value.created_at, "event.created_at"),
      };
      invariant(
        Number.isSafeInteger(event.sequence) && event.sequence > 0 && event.runId === runId,
        "DATABASE_ERROR",
        "Event summary is invalid",
      );
      return event;
    };
    const transaction = this.#database.transaction((): RunPresentationSnapshot => {
      const run = this.getRun(runId);
      const approvalRows = this.#database
        .prepare(
          `SELECT
             CASE WHEN typeof(run_id) = 'text'
                    AND octet_length(run_id) <= ${APPROVAL_RUN_ID_MAX_BYTES}
                  THEN run_id ELSE NULL END AS run_id,
             CASE WHEN typeof(kind) = 'text'
                    AND octet_length(kind) <= ${APPROVAL_KIND_MAX_BYTES}
                  THEN kind ELSE NULL END AS kind,
             CASE WHEN typeof(digest) = 'text'
                    AND octet_length(digest) <= ${APPROVAL_DIGEST_MAX_BYTES}
                  THEN digest ELSE NULL END AS digest,
             CASE WHEN typeof(actor) = 'text'
                    AND octet_length(actor) <= ${APPROVAL_ACTOR_MAX_BYTES}
                  THEN actor ELSE NULL END AS actor,
             CASE WHEN typeof(decision) = 'text'
                    AND octet_length(decision) <= ${APPROVAL_DECISION_MAX_BYTES}
                  THEN decision ELSE NULL END AS decision,
             CASE WHEN typeof(created_at) = 'text'
                    AND octet_length(created_at) <= ${EVENT_TIMESTAMP_MAX_BYTES}
                  THEN created_at ELSE NULL END AS created_at
           FROM approvals WHERE run_id = ?
           ORDER BY approvals.rowid DESC LIMIT ?`,
        )
        .all(runId, RUN_PRESENTATION_APPROVAL_LIMIT + 1) as unknown[];
      const earlierApprovalsExcluded = approvalRows.length > RUN_PRESENTATION_APPROVAL_LIMIT;
      const validatedApprovalRows = approvalRows.map((entry) => approvalRecordRow(entry, runId));
      const approvals = validatedApprovalRows.slice(0, RUN_PRESENTATION_APPROVAL_LIMIT).reverse();
      const approvalCoverage = {
        limit: RUN_PRESENTATION_APPROVAL_LIMIT,
        loaded: approvals.length,
        earlierApprovalsExcluded,
      } as const;
      const aggregate = row(
        this.#database
          .prepare(
            `SELECT COALESCE(MAX(sequence), 0) AS event_cursor
             FROM run_events WHERE run_id = ?`,
          )
          .get(runId),
        "event aggregate",
      );
      const eventCursor = numberValue(aggregate.event_cursor, "event.event_cursor");
      invariant(
        Number.isSafeInteger(eventCursor) && eventCursor >= 0,
        "DATABASE_ERROR",
        "Event aggregate is invalid",
      );
      // Per-run sequences are allocated append-only as MAX(sequence) + 1 and begin at 1,
      // so the high-water mark is also the total. Avoid a history-sized COUNT on every poll.
      const eventCount = eventCursor;
      const events = (
        this.#database
          .prepare(
            `SELECT sequence, run_id, type, created_at
             FROM run_events WHERE run_id = ?
             ORDER BY sequence DESC LIMIT ?`,
          )
          .all(runId, RUN_PRESENTATION_EVENT_LIMIT) as unknown[]
      )
        .map((entry) => summary(entry, "presentation event"))
        .reverse();
      const firstExpectedSequence = eventCursor - events.length + 1;
      invariant(
        events.every((event, index) => event.sequence === firstExpectedSequence + index),
        "DATABASE_ERROR",
        "Presentation event sequence is not contiguous",
      );
      // Derive action state from the already bounded presentation tail. A separate
      // type-filtered query can walk an arbitrarily old per-run history when action
      // events are absent or sparse because the sequence index cannot satisfy both
      // the type predicate and LIMIT.
      const actionEvents = events
        .filter((event) =>
          RUN_PRESENTATION_ACTION_EVENT_TYPES.includes(
            event.type as (typeof RUN_PRESENTATION_ACTION_EVENT_TYPES)[number],
          ),
        )
        .slice(-RUN_PRESENTATION_ACTION_EVENT_LIMIT);
      return {
        run,
        approvals,
        approvalCoverage,
        events,
        eventCursor,
        eventCount,
        actionEvents,
      };
    });
    return transaction();
  }

  listEventPage(runId: string, after: number): RunEventPage {
    invariant(
      Number.isSafeInteger(after) && after >= 0,
      "INVALID_EVENT_CURSOR",
      "Event cursor must be a nonnegative safe integer",
    );
    const transaction = this.#database.transaction(() => {
      const exists = this.#database.prepare("SELECT 1 FROM runs WHERE id = ?").get(runId);
      invariant(exists !== undefined, "NOT_FOUND", "Run was not found");
      const revision = numberValue(
        row(
          this.#database
            .prepare(
              "SELECT COALESCE(MAX(sequence), 0) AS revision FROM run_events WHERE run_id = ?",
            )
            .get(runId),
          "event revision",
        ).revision,
        "event.revision",
      );
      invariant(
        Number.isSafeInteger(revision) && revision >= 0,
        "DATABASE_ERROR",
        "Event revision is invalid",
      );
      invariant(
        after <= revision,
        "INVALID_EVENT_CURSOR",
        "Event cursor is ahead of the persisted revision",
      );
      const rows = this.#database
        .prepare(
          `SELECT sequence, run_id, type, created_at
           FROM run_events
           WHERE run_id = ? AND sequence > ?
           ORDER BY sequence
           LIMIT ?`,
        )
        .all(runId, after, RUN_EVENT_PAGE_LIMIT + 1) as unknown[];
      const summaries = rows.map((entry, index): EventSummaryRecord => {
        const value = row(entry, "event summary");
        const sequence = numberValue(value.sequence, "event.sequence");
        invariant(
          Number.isSafeInteger(sequence) && sequence === after + index + 1,
          "DATABASE_ERROR",
          "Event sequence is not contiguous",
        );
        return {
          sequence,
          runId: text(value.run_id, "event.run_id"),
          type: text(value.type, "event.type"),
          createdAt: text(value.created_at, "event.created_at"),
        };
      });
      const hasMore = summaries.length > RUN_EVENT_PAGE_LIMIT;
      const events = summaries.slice(0, RUN_EVENT_PAGE_LIMIT);
      return {
        runId,
        revision,
        nextAfter: events.at(-1)?.sequence ?? after,
        hasMore,
        events,
      };
    });
    return transaction();
  }

  getRunVerificationAttempts(runId: string, snapshot: number): RunVerificationAttemptsSnapshot {
    return readRunVerificationAttempts(this.#database, runId, snapshot);
  }

  listEventHistoryPage(runId: string, before: number, snapshot: number): RunEventHistoryPage {
    invariant(
      Number.isSafeInteger(before) && before > 0,
      "INVALID_EVENT_CURSOR",
      "Historical event cursor must be a positive safe integer",
    );
    invariant(
      Number.isSafeInteger(snapshot) && snapshot > 0,
      "INVALID_EVENT_CURSOR",
      "Historical event snapshot must be a positive safe integer",
    );
    const transaction = this.#database.transaction((): RunEventHistoryPage => {
      const exists = this.#database.prepare("SELECT 1 FROM runs WHERE id = ?").get(runId);
      invariant(exists !== undefined, "NOT_FOUND", "Run was not found");
      const currentRevision = numberValue(
        row(
          this.#database
            .prepare(
              "SELECT COALESCE(MAX(sequence), 0) AS revision FROM run_events WHERE run_id = ?",
            )
            .get(runId),
          "historical event revision",
        ).revision,
        "event.revision",
      );
      invariant(
        Number.isSafeInteger(currentRevision) && currentRevision > 0,
        "DATABASE_ERROR",
        "Historical event revision is invalid",
      );
      invariant(
        snapshot <= currentRevision,
        "INVALID_EVENT_CURSOR",
        "Historical event snapshot is ahead of the persisted revision",
      );
      const maximumBefore =
        snapshot === Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : snapshot + 1;
      invariant(
        before <= maximumBefore,
        "INVALID_EVENT_CURSOR",
        "Historical event cursor is ahead of the pinned snapshot",
      );
      const rows = this.#database
        .prepare(
          `SELECT sequence, run_id, type, created_at
           FROM run_events
           WHERE run_id = ? AND sequence < ? AND sequence <= ?
           ORDER BY sequence DESC
           LIMIT ?`,
        )
        .all(runId, before, snapshot, RUN_EVENT_PAGE_LIMIT + 1) as unknown[];
      const expectedRows = Math.min(RUN_EVENT_PAGE_LIMIT + 1, before - 1);
      invariant(
        rows.length === expectedRows,
        "DATABASE_ERROR",
        "Historical event sequence has a gap",
      );
      const summaries = rows.map((entry, index) => {
        const event = eventSummaryRow(entry, "historical event summary", runId);
        invariant(
          event.sequence === before - index - 1 && event.sequence <= snapshot,
          "DATABASE_ERROR",
          "Historical event sequence is not contiguous",
        );
        return event;
      });
      const hasMore = summaries.length > RUN_EVENT_PAGE_LIMIT;
      const events = summaries.slice(0, RUN_EVENT_PAGE_LIMIT).reverse();
      return {
        runId,
        before,
        snapshot,
        nextBefore: events.at(0)?.sequence ?? before,
        hasMore,
        events,
      };
    });
    return transaction();
  }

  #appendEvent(runId: string, type: string, payload: unknown): void {
    const sequenceRow = row(
      this.#database
        .prepare(
          "SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM run_events WHERE run_id = ?",
        )
        .get(runId),
      "event sequence",
    );
    this.#database
      .prepare(
        "INSERT INTO run_events (run_id, sequence, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        runId,
        numberValue(sequenceRow.next_sequence, "event.next_sequence"),
        type,
        json(asJsonValue(payload)),
        this.#now(),
      );
  }

  #hasApproval(
    runId: string,
    kind: ApprovalRecord["kind"],
    digest: string,
    decision: ApprovalRecord["decision"],
  ): boolean {
    return (
      this.#database
        .prepare(
          "SELECT 1 FROM approvals WHERE run_id = ? AND kind = ? AND digest = ? AND decision = ? LIMIT 1",
        )
        .get(runId, kind, digest, decision) !== undefined
    );
  }

  #approveAndTransition(
    runId: string,
    approval: ApprovalTransition,
    precondition?: () => void,
  ): RunRecord {
    const transaction = this.#database.transaction(() => {
      precondition?.();
      this.#approveAndTransitionInTransaction(runId, approval);
    });
    transaction();
    return this.getRun(runId);
  }

  #approveAndTransitionInTransaction(runId: string, approval: ApprovalTransition): void {
    this.#assertApprovalInput(approval);
    const current = this.getRun(runId);
    this.#assertApprovalGate(runId, current, approval);
    assertTransition(current.state, approval.to);
    const now = this.#now();
    this.#database
      .prepare(
        `INSERT INTO approvals
         (id, run_id, kind, digest, actor, decision, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.#id(),
        runId,
        approval.kind,
        approval.digest,
        approval.actor,
        approval.decision,
        now,
      );
    const result = this.#database
      .prepare(
        `UPDATE runs SET state = ?, resume_state = NULL, error_code = NULL,
         error_message = NULL, version = version + 1, updated_at = ?
         WHERE id = ? AND state = ?`,
      )
      .run(approval.to, now, runId, approval.expectedState);
    invariant(result.changes === 1, "CONCURRENT_RUN_UPDATE", "Run state changed concurrently");
    this.#appendEvent(runId, approval.eventType, {
      from: current.state,
      to: approval.to,
      kind: approval.kind,
      digest: approval.digest,
      actor: approval.actor,
      decision: approval.decision,
    });
  }

  #validateApprovalRequest(runId: string, approval: ApprovalTransition): RunRecord {
    this.#assertApprovalInput(approval);
    const current = this.getRun(runId);
    this.#assertApprovalGate(runId, current, approval);
    return current;
  }

  #assertApprovalInput(approval: ApprovalTransition): void {
    invariant(
      /^[a-f0-9]{64}$/.test(approval.digest),
      "INVALID_APPROVAL",
      "Approval digest is invalid",
    );
    invariant(
      approval.actor.trim().length > 0 &&
        Buffer.byteLength(approval.actor, "utf8") <= APPROVAL_ACTOR_MAX_BYTES &&
        !containsUnsafeActorCharacter(approval.actor),
      "INVALID_APPROVAL",
      "Approval actor is invalid",
    );
    invariant(
      !containsSecretShapedContent(Buffer.from(approval.actor, "utf8")),
      "SECRET_INPUT_DETECTED",
      "Approval actor contains recognizable credential material",
    );
  }

  #assertApprovalGate(runId: string, current: RunRecord, approval: ApprovalTransition): void {
    invariant(
      current.state === approval.expectedState,
      "INVALID_STATE",
      "Run is not at the requested approval gate",
    );
    invariant(
      approval.expectedDigest(current) === approval.digest,
      "STALE_APPROVAL",
      "Approval digest does not match the persisted gate",
    );
    this.#assertNoOtherActiveRun(current.projectId, runId);
  }

  #finishInternalTransition(
    runId: string,
    expectedState: RunState,
    to: RunState,
    eventType: string,
  ): RunRecord {
    const transaction = this.#database.transaction(() => {
      this.#finishInternalTransitionInTransaction(runId, expectedState, to, eventType);
    });
    transaction();
    return this.getRun(runId);
  }

  #finishInternalTransitionInTransaction(
    runId: string,
    expectedState: RunState,
    to: RunState,
    eventType: string,
  ): void {
    const current = this.getRun(runId);
    invariant(
      current.state === expectedState,
      "INVALID_STATE",
      "Run is not at the expected recovery step",
    );
    assertTransition(current.state, to);
    const now = this.#now();
    const result = this.#database
      .prepare(
        `UPDATE runs SET state = ?, resume_state = NULL, error_code = NULL,
         error_message = NULL, version = version + 1, updated_at = ?
         WHERE id = ? AND state = ?`,
      )
      .run(to, now, runId, expectedState);
    invariant(result.changes === 1, "CONCURRENT_RUN_UPDATE", "Run state changed concurrently");
    this.#appendEvent(runId, eventType, { from: expectedState, to });
  }

  #assertNoOtherActiveRun(projectId: string, runId: string): void {
    const conflict = this.#database
      .prepare(
        `SELECT id FROM runs
         WHERE project_id = ? AND id <> ?
           AND state NOT IN ('completed', 'failed', 'cancelled', 'rolled_back')
         LIMIT 1`,
      )
      .get(projectId, runId) as { readonly id: string } | undefined;
    invariant(
      conflict === undefined,
      "PROJECT_RUN_CONFLICT",
      "Another run is active for this project",
      conflict === undefined ? {} : { activeRunId: conflict.id },
    );
  }
}
