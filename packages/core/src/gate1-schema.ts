import { createHash } from "node:crypto";
import {
  type BigIntStats,
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  constants as fsConstants,
  lstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  type Stats,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

import {
  ICARUS_ANNOTATION_OBJECTS,
  ICARUS_APPROVAL_INDEX_OBJECTS,
  ICARUS_BASE_SCHEMA_OBJECTS,
  ICARUS_PATCH_SET_OBJECTS,
  ICARUS_PRE_GATE1_OBJECTS,
  ICARUS_PRE_GATE1_SCHEMA,
  ICARUS_READABLE_MANIFEST_OBJECTS,
  ICARUS_SCHEMA_USER_VERSION,
} from "./core-schema.js";
import { IcarusError, invariant } from "./errors.js";

export const BROWSER_ACTION_LEDGER_MIGRATION = "browser-action-ledger-v1";
export const LANDING_LEDGER_MIGRATION = "landing-ledger-v1";

export type Gate1MigrationToken =
  | typeof BROWSER_ACTION_LEDGER_MIGRATION
  | typeof LANDING_LEDGER_MIGRATION;

export type Gate1SchemaStatus = "not_applicable" | "missing" | "valid";

export interface Gate1SchemaInspection {
  readonly browserActions: Gate1SchemaStatus;
  readonly landing: Gate1SchemaStatus;
}

const ICARUS_STATE_MARKER = '{"application":"icarus","format":1}\n';

export const BROWSER_ACTION_LEDGER_SCHEMA = `
CREATE TABLE IF NOT EXISTS browser_action_requests (
  action_id TEXT NOT NULL PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  kind TEXT NOT NULL CHECK (kind IN (
    'egress.approve', 'plan.approve', 'review.approve', 'review.reject',
    'rollback.approve', 'restore.approve', 'run.resume', 'run.cancel'
  )),
  expected_state TEXT NOT NULL,
  expected_event_revision INTEGER NOT NULL CHECK (
    typeof(expected_event_revision) = 'integer' AND
    expected_event_revision BETWEEN 1 AND 9007199254740991
  ),
  subject_digest TEXT CHECK (
    subject_digest IS NULL OR (
      length(subject_digest) = 64 AND
      subject_digest NOT GLOB '*[^0-9a-f]*'
    )
  ),
  action_digest TEXT NOT NULL CHECK (
    length(action_digest) = 64 AND
    action_digest NOT GLOB '*[^0-9a-f]*'
  ),
  parent_action_id TEXT,
  parent_action_digest TEXT CHECK (
    parent_action_digest IS NULL OR (
      length(parent_action_digest) = 64 AND
      parent_action_digest NOT GLOB '*[^0-9a-f]*'
    )
  ),
  actor TEXT NOT NULL CHECK (
    length(CAST(actor AS BLOB)) BETWEEN 1 AND 200 AND
    instr(actor, char(0)) = 0 AND instr(actor, char(10)) = 0 AND
    instr(actor, char(13)) = 0
  ),
  status TEXT NOT NULL CHECK (status IN ('prepared', 'admitted', 'settled')),
  outcome TEXT CHECK (outcome IS NULL OR outcome IN (
    'succeeded', 'refused', 'failed', 'cancelled',
    'reconciliation_required'
  )),
  admission_event_sequence INTEGER CHECK (
    admission_event_sequence IS NULL OR (
      typeof(admission_event_sequence) = 'integer' AND
      admission_event_sequence BETWEEN 1 AND 9007199254740991
    )
  ),
  domain_event_sequence INTEGER CHECK (
    domain_event_sequence IS NULL OR (
      typeof(domain_event_sequence) = 'integer' AND
      domain_event_sequence BETWEEN 1 AND 9007199254740991
    )
  ),
  domain_operation_id TEXT REFERENCES operations(id),
  error_code TEXT CHECK (
    error_code IS NULL OR (
      length(error_code) BETWEEN 2 AND 128 AND
      error_code NOT GLOB '*[^A-Z0-9_]*'
    )
  ),
  created_at TEXT NOT NULL CHECK (length(CAST(created_at AS BLOB)) BETWEEN 20 AND 35),
  updated_at TEXT NOT NULL CHECK (length(CAST(updated_at AS BLOB)) BETWEEN 20 AND 35),
  UNIQUE(action_id, action_digest, run_id),
  FOREIGN KEY (run_id, admission_event_sequence)
    REFERENCES run_events(run_id, sequence),
  FOREIGN KEY (run_id, domain_event_sequence)
    REFERENCES run_events(run_id, sequence),
  FOREIGN KEY (parent_action_id, parent_action_digest, run_id)
    REFERENCES browser_action_requests(action_id, action_digest, run_id),
  CHECK (
    length(action_id) = 36 AND
    substr(action_id, 9, 1) = '-' AND substr(action_id, 14, 1) = '-' AND
    substr(action_id, 19, 1) = '-' AND substr(action_id, 24, 1) = '-' AND
    substr(action_id, 15, 1) IN ('1','2','3','4','5','6','7','8') AND
    substr(action_id, 20, 1) IN ('8','9','a','b') AND
    length(replace(action_id, '-', '')) = 32 AND
    replace(action_id, '-', '') NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (
    (kind = 'egress.approve' AND expected_state = 'awaiting_egress_approval' AND subject_digest IS NOT NULL AND parent_action_id IS NULL AND parent_action_digest IS NULL) OR
    (kind = 'plan.approve' AND expected_state = 'awaiting_approval' AND subject_digest IS NOT NULL AND parent_action_id IS NULL AND parent_action_digest IS NULL) OR
    (kind IN ('review.approve', 'review.reject') AND expected_state = 'awaiting_review' AND subject_digest IS NOT NULL AND parent_action_id IS NULL AND parent_action_digest IS NULL) OR
    (kind = 'rollback.approve' AND expected_state = 'completed' AND subject_digest IS NOT NULL AND parent_action_id IS NULL AND parent_action_digest IS NULL) OR
    (kind = 'restore.approve' AND expected_state = 'rolled_back' AND subject_digest IS NOT NULL AND parent_action_id IS NULL AND parent_action_digest IS NULL) OR
    (kind = 'run.resume' AND expected_state IN ('preparing', 'planned', 'running', 'verifying', 'rolling_back', 'restoring', 'cancelling', 'failed') AND subject_digest IS NULL AND parent_action_id IS NULL AND parent_action_digest IS NULL) OR
    (kind = 'run.cancel' AND expected_state IN ('preparing', 'planned', 'awaiting_egress_approval', 'awaiting_approval', 'running', 'verifying', 'awaiting_review', 'failed') AND subject_digest IS NULL AND ((parent_action_id IS NULL AND parent_action_digest IS NULL) OR (parent_action_id IS NOT NULL AND parent_action_digest IS NOT NULL)))
  ),
  CHECK (
    (status = 'prepared' AND outcome IS NULL AND admission_event_sequence IS NULL AND domain_event_sequence IS NULL AND domain_operation_id IS NULL AND error_code IS NULL) OR
    (status = 'admitted' AND outcome IS NULL AND admission_event_sequence IS NOT NULL AND error_code IS NULL) OR
    (status = 'settled' AND outcome IS NOT NULL)
  ),
  CHECK (
    status <> 'settled' OR
    (outcome = 'refused' AND admission_event_sequence IS NULL AND domain_event_sequence IS NULL AND domain_operation_id IS NULL AND error_code IS NOT NULL) OR
    (outcome IN ('succeeded', 'cancelled') AND admission_event_sequence IS NOT NULL AND domain_event_sequence IS NOT NULL AND error_code IS NULL) OR
    (outcome IN ('failed', 'reconciliation_required') AND admission_event_sequence IS NOT NULL AND error_code IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS browser_action_requests_active_non_cancel
ON browser_action_requests(run_id)
WHERE status IN ('prepared', 'admitted') AND kind <> 'run.cancel';

CREATE UNIQUE INDEX IF NOT EXISTS browser_action_requests_active_cancel
ON browser_action_requests(run_id)
WHERE status IN ('prepared', 'admitted') AND kind = 'run.cancel';
`;

export const LANDING_LEDGER_SCHEMA = `
CREATE TABLE landing_profiles (
  project_id TEXT PRIMARY KEY REFERENCES projects(id),
  profile_version INTEGER NOT NULL CHECK(profile_version = 1),
  provider TEXT NOT NULL CHECK(provider = 'github'),
  owner TEXT NOT NULL,
  repository TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  branch_namespace TEXT NOT NULL CHECK(branch_namespace = 'icarus/'),
  credential_env TEXT NOT NULL,
  expected_actor TEXT NOT NULL,
  commit_name TEXT NOT NULL,
  commit_email TEXT NOT NULL,
  derivative_effects_disposition TEXT NOT NULL CHECK(
    derivative_effects_disposition IN ('inert-repository', 'operator-approved')
  ),
  derivative_effects_evidence_sha256 TEXT NOT NULL,
  profile_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE landings (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE REFERENCES runs(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  policy_version INTEGER NOT NULL CHECK(policy_version = 1),
  state TEXT NOT NULL CHECK(state IN (
    'preparing_candidate',
    'awaiting_approval',
    'approved',
    'creating_local_ref',
    'local_ready',
    'uploading_objects',
    'objects_ready',
    'creating_remote_ref',
    'remote_ready',
    'opening_draft_pr',
    'landed',
    'reconciliation_required',
    'rejected',
    'abandoned',
    'failed'
  )),
  resume_state TEXT CHECK(resume_state IS NULL OR resume_state IN (
    'preparing_candidate',
    'approved',
    'local_ready',
    'objects_ready',
    'remote_ready'
  )),
  profile_json TEXT NOT NULL,
  profile_sha256 TEXT NOT NULL,
  base_commit_sha1 TEXT NOT NULL,
  base_tree_sha1 TEXT NOT NULL,
  plan_sha256 TEXT NOT NULL,
  diff_sha256 TEXT NOT NULL,
  checkpoint_sha256 TEXT NOT NULL,
  verification_sha256 TEXT NOT NULL,
  review_decision_id TEXT NOT NULL REFERENCES approvals(id),
  review_decision_sha256 TEXT NOT NULL,
  changed_paths_json TEXT NOT NULL,
  changed_paths_sha256 TEXT NOT NULL,
  credential_audit_sha256 TEXT,
  head_ref TEXT NOT NULL,
  commit_message TEXT NOT NULL,
  commit_message_sha256 TEXT NOT NULL,
  commit_epoch_seconds INTEGER NOT NULL,
  commit_iso8601 TEXT NOT NULL,
  pull_request_title TEXT NOT NULL,
  pull_request_title_sha256 TEXT NOT NULL,
  pull_request_body_prefix TEXT NOT NULL,
  pull_request_body_prefix_sha256 TEXT NOT NULL,
  pull_request_body_sha256 TEXT,
  candidate_tree_sha1 TEXT,
  candidate_commit_sha1 TEXT,
  candidate_commit_payload_sha256 TEXT,
  landing_sha256 TEXT,
  error_code TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(
    typeof(attempt_count) = 'integer' AND attempt_count BETWEEN 0 AND 8
  ),
  version INTEGER NOT NULL DEFAULT 0 CHECK(
    typeof(version) = 'integer' AND
    version BETWEEN 0 AND 9007199254740991
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(
    (state NOT IN ('failed', 'reconciliation_required') AND
      resume_state IS NULL) OR
    (state = 'failed' AND resume_state IS NOT NULL AND resume_state IN (
      'preparing_candidate', 'approved', 'local_ready',
      'objects_ready', 'remote_ready'
    )) OR
    (state = 'reconciliation_required' AND resume_state IS NOT NULL AND
      resume_state IN (
      'approved', 'local_ready', 'objects_ready', 'remote_ready'
    ))
  )
);

CREATE INDEX landings_by_project_updated
ON landings(project_id, updated_at DESC, id DESC);

CREATE TABLE landing_decisions (
  id TEXT PRIMARY KEY,
  landing_id TEXT NOT NULL UNIQUE REFERENCES landings(id),
  landing_sha256 TEXT NOT NULL,
  actor TEXT NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('approve', 'reject')),
  created_at TEXT NOT NULL
);

CREATE TABLE landing_attempts (
  landing_id TEXT NOT NULL REFERENCES landings(id),
  ordinal INTEGER NOT NULL CHECK(
    typeof(ordinal) = 'integer' AND ordinal BETWEEN 1 AND 8
  ),
  status TEXT NOT NULL CHECK(status IN (
    'started', 'completed', 'failed', 'interrupted'
  )),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error_code TEXT,
  PRIMARY KEY(landing_id, ordinal),
  CHECK(
    (status = 'started' AND finished_at IS NULL AND error_code IS NULL) OR
    (status = 'completed' AND finished_at IS NOT NULL AND
      error_code IS NULL) OR
    (status IN ('failed', 'interrupted') AND finished_at IS NOT NULL AND
      error_code IS NOT NULL)
  )
);

CREATE UNIQUE INDEX one_started_landing_attempt
ON landing_attempts(landing_id)
WHERE status = 'started';

CREATE TABLE landing_operations (
  id TEXT PRIMARY KEY,
  landing_id TEXT NOT NULL REFERENCES landings(id),
  coordinator_attempt INTEGER NOT NULL CHECK(
    typeof(coordinator_attempt) = 'integer' AND
    coordinator_attempt BETWEEN 1 AND 8
  ),
  kind TEXT NOT NULL CHECK(kind IN (
    'candidate.prepare',
    'local_ref.create',
    'github.preflight',
    'github.objects.upload',
    'github.ref.create',
    'github.pull_request.create',
    'landing.reconcile'
  )),
  kind_attempt INTEGER NOT NULL CHECK(
    typeof(kind_attempt) = 'integer' AND kind_attempt BETWEEN 1 AND 9
  ),
  status TEXT NOT NULL CHECK(status IN (
    'started',
    'completed',
    'failed',
    'interrupted'
  )),
  request_sha256 TEXT NOT NULL,
  request_json TEXT NOT NULL,
  observation_sha256 TEXT,
  observation_json TEXT,
  result_sha256 TEXT,
  result_json TEXT,
  error_code TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE(landing_id, kind, kind_attempt),
  UNIQUE(id, landing_id, coordinator_attempt),
  UNIQUE(id, landing_id, coordinator_attempt, kind),
  FOREIGN KEY(landing_id, coordinator_attempt)
    REFERENCES landing_attempts(landing_id, ordinal),
  CHECK(
    (status = 'started' AND finished_at IS NULL) OR
    (status IN ('completed', 'failed', 'interrupted') AND finished_at IS NOT NULL)
  ),
  CHECK(
    (observation_sha256 IS NULL AND observation_json IS NULL) OR
    (observation_sha256 IS NOT NULL AND observation_json IS NOT NULL)
  ),
  CHECK(
    (status = 'started' AND result_sha256 IS NULL AND result_json IS NULL AND
      error_code IS NULL) OR
    (status = 'completed' AND result_sha256 IS NOT NULL AND
      result_json IS NOT NULL AND error_code IS NULL) OR
    (status IN ('failed', 'interrupted') AND result_sha256 IS NOT NULL AND
      result_json IS NOT NULL AND error_code IS NOT NULL)
  )
);

CREATE INDEX landing_operations_by_landing
ON landing_operations(landing_id, coordinator_attempt, kind_attempt, started_at);

CREATE UNIQUE INDEX one_started_landing_operation
ON landing_operations(landing_id)
WHERE status = 'started';

CREATE TABLE landing_http_requests (
  id TEXT PRIMARY KEY,
  landing_id TEXT NOT NULL REFERENCES landings(id),
  operation_id TEXT NOT NULL,
  coordinator_attempt INTEGER NOT NULL CHECK(
    typeof(coordinator_attempt) = 'integer' AND
    coordinator_attempt BETWEEN 1 AND 8
  ),
  operation_kind TEXT NOT NULL CHECK(operation_kind IN (
    'candidate.prepare',
    'local_ref.create',
    'github.preflight',
    'github.objects.upload',
    'github.ref.create',
    'github.pull_request.create',
    'landing.reconcile'
  )),
  request_ordinal INTEGER NOT NULL CHECK(
    typeof(request_ordinal) = 'integer' AND request_ordinal >= 1
  ),
  kind TEXT NOT NULL CHECK(kind IN (
    'github.actor.get',
    'github.base_ref.get',
    'github.head_ref.get',
    'github.pull_requests.get',
    'github.blob.post',
    'github.tree.post',
    'github.commit.post',
    'github.ref.post',
    'github.pull_request.post'
  )),
  method TEXT NOT NULL CHECK(method IN ('GET', 'POST')),
  request_sha256 TEXT NOT NULL,
  request_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('admitted', 'settled')),
  outcome TEXT CHECK(outcome IS NULL OR outcome IN (
    'succeeded', 'failed', 'ambiguous'
  )),
  http_status INTEGER CHECK(
    http_status IS NULL OR (
      typeof(http_status) = 'integer' AND http_status BETWEEN 100 AND 599
    )
  ),
  result_sha256 TEXT,
  result_json TEXT,
  error_code TEXT,
  admitted_at TEXT NOT NULL,
  settled_at TEXT,
  UNIQUE(landing_id, coordinator_attempt, request_ordinal),
  UNIQUE(id, landing_id, coordinator_attempt),
  FOREIGN KEY(operation_id, landing_id, coordinator_attempt, operation_kind)
    REFERENCES landing_operations(id, landing_id, coordinator_attempt, kind),
  CHECK(
    (operation_kind = 'github.preflight' AND method = 'GET' AND kind IN (
      'github.actor.get', 'github.base_ref.get', 'github.head_ref.get',
      'github.pull_requests.get'
    )) OR
    (operation_kind = 'github.objects.upload' AND (
      (method = 'GET' AND kind = 'github.actor.get') OR
      (method = 'POST' AND kind IN (
        'github.blob.post', 'github.tree.post', 'github.commit.post'
      ))
    )) OR
    (operation_kind = 'github.ref.create' AND (
      (method = 'GET' AND kind IN (
        'github.actor.get', 'github.base_ref.get', 'github.head_ref.get'
      )) OR
      (method = 'POST' AND kind = 'github.ref.post')
    )) OR
    (operation_kind = 'github.pull_request.create' AND (
      (method = 'GET' AND kind IN (
        'github.actor.get', 'github.base_ref.get', 'github.head_ref.get',
        'github.pull_requests.get'
      )) OR
      (method = 'POST' AND kind = 'github.pull_request.post')
    )) OR
    (operation_kind = 'landing.reconcile' AND method = 'GET' AND kind IN (
      'github.actor.get', 'github.base_ref.get', 'github.head_ref.get',
      'github.pull_requests.get'
    ))
  ),
  CHECK(
    (status = 'admitted' AND outcome IS NULL AND http_status IS NULL AND
      result_sha256 IS NULL AND result_json IS NULL AND error_code IS NULL AND
      settled_at IS NULL) OR
    (status = 'settled' AND outcome IS NOT NULL AND
      result_sha256 IS NOT NULL AND result_json IS NOT NULL AND
      settled_at IS NOT NULL)
  ),
  CHECK(
    outcome IS NULL OR
    (outcome = 'succeeded' AND http_status IS NOT NULL AND (
      http_status BETWEEN 200 AND 299 OR
      (kind = 'github.head_ref.get' AND http_status = 404)
    ) AND error_code IS NULL) OR
    (outcome = 'failed' AND error_code IS NOT NULL) OR
    (outcome = 'ambiguous' AND http_status IS NULL AND error_code IS NOT NULL)
  )
);

CREATE INDEX landing_http_requests_by_operation
ON landing_http_requests(operation_id, request_ordinal);

CREATE UNIQUE INDEX one_create_pr_post_per_landing
ON landing_http_requests(landing_id)
WHERE kind = 'github.pull_request.post';

CREATE TABLE landing_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  landing_id TEXT NOT NULL REFERENCES landings(id),
  sequence INTEGER NOT NULL CHECK(
    typeof(sequence) = 'integer' AND
    sequence BETWEEN 1 AND 9007199254740991
  ),
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(landing_id, sequence)
);

CREATE TABLE landing_receipts (
  landing_id TEXT PRIMARY KEY REFERENCES landings(id),
  receipt_json TEXT NOT NULL,
  receipt_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

const BROWSER_ACTION_OBJECTS = [
  "browser_action_requests",
  "browser_action_requests_active_non_cancel",
  "browser_action_requests_active_cancel",
] as const;

const LANDING_OBJECTS = [
  "landing_profiles",
  "landings",
  "landings_by_project_updated",
  "landing_decisions",
  "landing_attempts",
  "one_started_landing_attempt",
  "landing_operations",
  "landing_operations_by_landing",
  "one_started_landing_operation",
  "landing_http_requests",
  "landing_http_requests_by_operation",
  "one_create_pr_post_per_landing",
  "landing_events",
  "landing_receipts",
] as const;

type SchemaObject = {
  readonly type: "table" | "index";
  readonly name: string;
  readonly table: string;
  readonly sql: string;
};

function normalizeSchemaSql(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function schemaObjects(database: Database.Database, names: readonly string[]): SchemaObject[] {
  if (names.length === 0) return [];
  const placeholders = names.map(() => "?").join(",");
  return (
    database
      .prepare(
        `SELECT type, name, tbl_name, sql
         FROM sqlite_master
         WHERE type IN ('table', 'index') AND name IN (${placeholders})
         ORDER BY name`,
      )
      .all(...names) as Array<{
      readonly type: "table" | "index";
      readonly name: string;
      readonly tbl_name: string;
      readonly sql: string | null;
    }>
  ).map((entry) => {
    invariant(entry.sql !== null, "DATABASE_ERROR", `Schema object ${entry.name} has no SQL`);
    return {
      type: entry.type,
      name: entry.name,
      table: entry.tbl_name,
      sql: entry.sql,
    };
  });
}

function expectedSchemaObjects(schema: string, names: readonly string[]): SchemaObject[] {
  const database = new Database(":memory:");
  try {
    database.exec(schema);
    return schemaObjects(database, names);
  } finally {
    database.close();
  }
}

let expectedBrowserActionObjectsCache: readonly SchemaObject[] | undefined;
let expectedLandingObjectsCache: readonly SchemaObject[] | undefined;
let expectedPreGate1ObjectsCache: readonly SchemaObject[] | undefined;

function expectedBrowserActionObjects(): readonly SchemaObject[] {
  expectedBrowserActionObjectsCache ??= expectedSchemaObjects(
    BROWSER_ACTION_LEDGER_SCHEMA,
    BROWSER_ACTION_OBJECTS,
  );
  return expectedBrowserActionObjectsCache;
}

function expectedLandingObjects(): readonly SchemaObject[] {
  expectedLandingObjectsCache ??= expectedSchemaObjects(LANDING_LEDGER_SCHEMA, LANDING_OBJECTS);
  return expectedLandingObjectsCache;
}

function expectedPreGate1Objects(): readonly SchemaObject[] {
  expectedPreGate1ObjectsCache ??= expectedSchemaObjects(
    ICARUS_PRE_GATE1_SCHEMA,
    ICARUS_PRE_GATE1_OBJECTS,
  );
  return expectedPreGate1ObjectsCache;
}
const KNOWN_SCHEMA_OBJECTS: ReadonlySet<string> = new Set([
  ...ICARUS_PRE_GATE1_OBJECTS,
  ...BROWSER_ACTION_OBJECTS,
  ...LANDING_OBJECTS,
  ...ICARUS_ANNOTATION_OBJECTS,
]);

function assertClosedSchemaObjectSet(database: Database.Database): void {
  const entries = database
    .prepare(
      `SELECT type, name
       FROM sqlite_master
       WHERE name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    )
    .all() as Array<{ readonly type: string; readonly name: string }>;
  invariant(
    entries.every(
      (entry) =>
        (entry.type === "table" || entry.type === "index") && KNOWN_SCHEMA_OBJECTS.has(entry.name),
    ),
    "DATABASE_ERROR",
    "Icarus schema contains an unknown object",
  );
}

function assertExactPreGate1ObjectGroup(
  database: Database.Database,
  names: readonly string[],
  label: string,
): "missing" | "valid" {
  const expectedNames = new Set(names);
  const expected = expectedPreGate1Objects().filter((entry) => expectedNames.has(entry.name));
  const actual = schemaObjects(database, names);
  if (actual.length === 0) return "missing";
  invariant(actual.length === expected.length, "DATABASE_ERROR", `${label} schema is incomplete`);
  for (let index = 0; index < expected.length; index += 1) {
    const left = actual[index];
    const right = expected[index];
    invariant(
      left !== undefined &&
        right !== undefined &&
        left.type === right.type &&
        left.name === right.name &&
        left.table === right.table &&
        normalizeSchemaSql(left.sql) === normalizeSchemaSql(right.sql),
      "DATABASE_ERROR",
      `${label} schema object is malformed`,
    );
  }
  return "valid";
}

function assertExactPreGate1Schema(
  database: Database.Database,
  requireComplete: boolean,
): "not_applicable" | "valid" {
  const baseStatus = assertExactPreGate1ObjectGroup(
    database,
    ICARUS_BASE_SCHEMA_OBJECTS,
    "Icarus base",
  );
  const anyPreGate1Objects = schemaObjects(database, ICARUS_PRE_GATE1_OBJECTS);
  if (baseStatus === "missing") {
    invariant(
      anyPreGate1Objects.length === 0,
      "DATABASE_ERROR",
      "Icarus additive schema exists without its base schema",
    );
    return "not_applicable";
  }
  const version = database.prepare("PRAGMA user_version").get() as
    | { readonly user_version?: unknown }
    | undefined;
  invariant(
    version?.user_version === ICARUS_SCHEMA_USER_VERSION,
    "DATABASE_ERROR",
    "Icarus core schema user version is invalid",
  );
  for (const [names, label] of [
    [ICARUS_APPROVAL_INDEX_OBJECTS, "Icarus approval index"],
    [ICARUS_PATCH_SET_OBJECTS, "Icarus patch-set"],
    [ICARUS_READABLE_MANIFEST_OBJECTS, "Icarus readable manifest"],
  ] as const) {
    const status = assertExactPreGate1ObjectGroup(database, names, label);
    invariant(
      !requireComplete || status === "valid",
      "DATABASE_ERROR",
      "Gate 1 migration requires the complete pre-Gate 1 Icarus schema",
    );
  }
  return "valid";
}

function assertExactFamily(
  database: Database.Database,
  names: readonly string[],
  expected: readonly SchemaObject[],
  label: string,
): Gate1SchemaStatus {
  const actual = schemaObjects(database, names);
  const familyTables = expected
    .filter((entry) => entry.type === "table")
    .map((entry) => entry.name);
  const tablePlaceholders = familyTables.map(() => "?").join(",");
  const relatedRows = database
    .prepare(
      `SELECT type, name, tbl_name
       FROM sqlite_master
       WHERE name NOT LIKE 'sqlite_%'
         AND (
           name LIKE ? OR
           name LIKE ? OR
           (type IN ('index', 'trigger') AND tbl_name IN (${tablePlaceholders}))
         )
       ORDER BY name`,
    )
    .all(
      label === "browser action" ? "browser_action%" : "landing_%",
      label === "browser action" ? "browser_action%" : "one_%landing%",
      ...familyTables,
    ) as Array<{
    readonly type: string;
    readonly name: string;
    readonly tbl_name: string;
  }>;
  const allowed = new Set(names);
  invariant(
    relatedRows.every((entry) => allowed.has(entry.name)),
    "DATABASE_ERROR",
    `${label} schema contains an unknown object`,
  );
  if (actual.length === 0) return "missing";
  invariant(
    actual.length === expected.length,
    "DATABASE_ERROR",
    `${label} schema is partially present`,
  );
  for (let index = 0; index < expected.length; index += 1) {
    const left = actual[index];
    const right = expected[index];
    invariant(
      left !== undefined &&
        right !== undefined &&
        left.type === right.type &&
        left.name === right.name &&
        left.table === right.table &&
        normalizeSchemaSql(left.sql) === normalizeSchemaSql(right.sql),
      "DATABASE_ERROR",
      `${label} schema object is malformed`,
    );
  }
  return "valid";
}

function inspectOpenDatabase(
  database: Database.Database,
  requireCompleteCore: boolean,
): Gate1SchemaInspection {
  const browserActions = assertExactFamily(
    database,
    BROWSER_ACTION_OBJECTS,
    expectedBrowserActionObjects(),
    "browser action",
  );
  const landing = assertExactFamily(database, LANDING_OBJECTS, expectedLandingObjects(), "landing");
  assertClosedSchemaObjectSet(database);
  const core = assertExactPreGate1Schema(database, requireCompleteCore);
  if (core === "not_applicable") {
    invariant(
      browserActions === "missing" && landing === "missing",
      "DATABASE_ERROR",
      "Gate 1 schema objects exist without the Icarus core schema",
    );
    return { browserActions: "not_applicable", landing: "not_applicable" };
  }
  return { browserActions, landing };
}

interface SqliteFamilyFileFingerprint {
  readonly name: string;
  readonly device: string;
  readonly inode: string;
  readonly mode: string;
  readonly links: string;
  readonly owner: string;
  readonly size: string;
  readonly modifiedAt: string;
  readonly changedAt: string;
  readonly digest: string;
}

interface SqliteFamilyFingerprint {
  readonly files: readonly SqliteFamilyFileFingerprint[];
}

function sqliteFileMetadata(stat: BigIntStats): string {
  return [
    stat.dev,
    stat.ino,
    stat.mode,
    stat.nlink,
    stat.uid,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
  ].join(":");
}

function assertSafeSqliteFamilyFile(filePath: string): BigIntStats {
  const stat = lstatSync(filePath, { bigint: true });
  const currentUid = process.getuid?.();
  invariant(
    stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.nlink === 1n &&
      (currentUid === undefined || stat.uid === BigInt(currentUid)),
    "DATABASE_ERROR",
    "SQLite schema inspection requires owned, regular, unlinked database-family files",
  );
  if (process.platform !== "win32") {
    invariant(
      (stat.mode & 0o022n) === 0n,
      "DATABASE_ERROR",
      "SQLite schema inspection refuses group- or world-writable database-family files",
    );
  }
  return stat;
}

function hashSqliteFamilyFile(filePath: string): string {
  const descriptor = openSync(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

function fingerprintSqliteFamilyFile(filePath: string, name: string): SqliteFamilyFileFingerprint {
  const before = assertSafeSqliteFamilyFile(filePath);
  const digest = hashSqliteFamilyFile(filePath);
  const after = assertSafeSqliteFamilyFile(filePath);
  invariant(
    sqliteFileMetadata(before) === sqliteFileMetadata(after),
    "RUN_BUSY",
    "SQLite state changed while it was being inspected",
  );
  return {
    name,
    device: String(after.dev),
    inode: String(after.ino),
    mode: String(after.mode),
    links: String(after.nlink),
    owner: String(after.uid),
    size: String(after.size),
    modifiedAt: String(after.mtimeNs),
    changedAt: String(after.ctimeNs),
    digest,
  };
}

function isSqliteBusy(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { readonly code?: unknown }).code === "string" &&
    (error as { readonly code: string }).code.startsWith("SQLITE_BUSY")
  );
}

function fingerprintSqliteFamily(databasePath: string): SqliteFamilyFingerprint {
  const parent = path.dirname(databasePath);
  const basename = path.basename(databasePath);
  const rollbackJournal = `${basename}-journal`;
  const allowed = new Set([basename, `${basename}-wal`, `${basename}-shm`]);
  const names = readdirSync(parent)
    .filter((name) => name === basename || name.startsWith(`${basename}-`))
    .sort();
  invariant(names.includes(basename), "DATABASE_ERROR", "SQLite database disappeared");
  invariant(
    !names.includes(rollbackJournal),
    "RUN_BUSY",
    "SQLite schema inspection found an active rollback journal",
  );
  invariant(
    names.every((name) => allowed.has(name)),
    "DATABASE_ERROR",
    "SQLite schema inspection refuses an unexpected database-family sibling",
  );
  return {
    files: names.map((name) => fingerprintSqliteFamilyFile(path.join(parent, name), name)),
  };
}

function sqliteFamilyMatches(
  left: SqliteFamilyFingerprint,
  right: SqliteFamilyFingerprint,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertPrivateSnapshotRoot(snapshotRoot: string): void {
  chmodSync(snapshotRoot, 0o700);
  const stat = lstatSync(snapshotRoot);
  const currentUid = process.getuid?.();
  invariant(
    stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      realpathSync(snapshotRoot) === snapshotRoot &&
      (currentUid === undefined || stat.uid === currentUid),
    "DATABASE_ERROR",
    "SQLite inspection snapshot directory is unsafe",
  );
  if (process.platform !== "win32") {
    invariant(
      (stat.mode & 0o777) === 0o700,
      "DATABASE_ERROR",
      "SQLite inspection snapshot directory is not private",
    );
  }
}

function copySqliteSnapshot(
  databasePath: string,
  snapshotRoot: string,
  source: SqliteFamilyFingerprint,
): string {
  const basename = path.basename(databasePath);
  const sourceParent = path.dirname(databasePath);
  for (const entry of source.files) {
    if (entry.name.endsWith("-shm")) continue;
    const destination = path.join(snapshotRoot, entry.name);
    try {
      copyFileSync(path.join(sourceParent, entry.name), destination, fsConstants.COPYFILE_EXCL);
      chmodSync(destination, 0o600);
    } catch {
      throw new IcarusError("RUN_BUSY", "SQLite state changed while it was being snapshotted");
    }
    const copied = fingerprintSqliteFamilyFile(destination, entry.name);
    if (process.platform !== "win32") {
      invariant(
        (BigInt(copied.mode) & 0o777n) === 0o600n,
        "DATABASE_ERROR",
        "SQLite inspection snapshot files are not private",
      );
    }
    invariant(
      copied.size === entry.size && copied.digest === entry.digest,
      "RUN_BUSY",
      "SQLite state changed while it was being snapshotted",
    );
  }
  return path.join(snapshotRoot, basename);
}

function assertSqliteFamilyUnchanged(
  databasePath: string,
  expected: SqliteFamilyFingerprint,
): void {
  let actual: SqliteFamilyFingerprint;
  try {
    actual = fingerprintSqliteFamily(databasePath);
  } catch {
    throw new IcarusError("RUN_BUSY", "SQLite state changed during schema inspection");
  }
  invariant(
    sqliteFamilyMatches(actual, expected),
    "RUN_BUSY",
    "SQLite state changed during schema inspection",
  );
}

function inspectGate1SchemasWithCoreRequirement(
  databasePath: string,
  requireCompleteCore: boolean,
): Gate1SchemaInspection {
  if (!existsSync(databasePath)) {
    return { browserActions: "not_applicable", landing: "not_applicable" };
  }
  const requestedDatabasePath = path.resolve(databasePath);
  let requestedDatabaseStat: Stats;
  let resolvedDatabasePath: string;
  try {
    requestedDatabaseStat = lstatSync(requestedDatabasePath);
    resolvedDatabasePath = realpathSync(requestedDatabasePath);
  } catch {
    throw new IcarusError("RUN_BUSY", "SQLite state changed before schema inspection");
  }
  invariant(
    requestedDatabaseStat.isFile() && !requestedDatabaseStat.isSymbolicLink(),
    "DATABASE_ERROR",
    "SQLite schema inspection refuses a non-regular or symbolic-link database path",
  );
  const source = fingerprintSqliteFamily(resolvedDatabasePath);
  const snapshotRoot = mkdtempSync(path.join(realpathSync(os.tmpdir()), "icarus-gate1-inspect-"));
  try {
    assertPrivateSnapshotRoot(snapshotRoot);
    const snapshotPath = copySqliteSnapshot(resolvedDatabasePath, snapshotRoot, source);
    assertSqliteFamilyUnchanged(resolvedDatabasePath, source);

    let inspection: Gate1SchemaInspection | undefined;
    let inspectionFailed = false;
    let inspectionFailure: unknown;
    let database: Database.Database | undefined;
    try {
      database = new Database(snapshotPath, { readonly: true, fileMustExist: true });
      inspection = inspectOpenDatabase(database, requireCompleteCore);
    } catch (error) {
      inspectionFailed = true;
      inspectionFailure = error;
    }
    try {
      database?.close();
    } catch (error) {
      if (!inspectionFailed) {
        inspectionFailed = true;
        inspectionFailure = error;
      }
    }

    assertSqliteFamilyUnchanged(resolvedDatabasePath, source);
    if (inspectionFailed) throw inspectionFailure;
    invariant(inspection !== undefined, "DATABASE_ERROR", "Schema inspection produced no result");
    return inspection;
  } finally {
    rmSync(snapshotRoot, { recursive: true, force: true });
  }
}

export function inspectGate1Schemas(databasePath: string): Gate1SchemaInspection {
  return inspectGate1SchemasWithCoreRequirement(databasePath, false);
}

export function assertGate1SchemasForStartup(databasePath: string): Gate1SchemaInspection {
  const inspection = inspectGate1Schemas(databasePath);
  invariant(
    inspection.browserActions !== "missing" && inspection.landing !== "missing",
    "DATABASE_MIGRATION_REQUIRED",
    "Gate 1 ledgers require explicit CLI migration after a verified state backup",
  );
  return inspection;
}

export function createGate1Schemas(database: Database.Database): void {
  const create = database.transaction(() => {
    database.exec(BROWSER_ACTION_LEDGER_SCHEMA);
    database.exec(LANDING_LEDGER_SCHEMA);
    const inspection = inspectOpenDatabase(database, true);
    invariant(
      inspection.browserActions === "valid" && inspection.landing === "valid",
      "DATABASE_ERROR",
      "New Gate 1 ledger schemas failed exact verification",
    );
  });
  create();
}

function assertMigrationPrecondition(
  inspection: Gate1SchemaInspection,
  token: Gate1MigrationToken,
): void {
  invariant(
    inspection.browserActions !== "not_applicable" && inspection.landing !== "not_applicable",
    "DATABASE_MIGRATION_REQUIRED",
    "Gate 1 migration requires an existing initialized Icarus database",
  );
  if (token === LANDING_LEDGER_MIGRATION) {
    invariant(
      inspection.browserActions === "valid",
      "MIGRATION_ORDER_REQUIRED",
      "The browser action ledger must be migrated before the landing ledger",
    );
    invariant(
      inspection.landing === "missing",
      "INVALID_DATABASE_CONFIGURATION",
      "The landing ledger migration token has already been used",
    );
    return;
  }
  invariant(
    inspection.browserActions === "missing",
    "INVALID_DATABASE_CONFIGURATION",
    "The browser action ledger migration token has already been used",
  );
  invariant(
    inspection.landing === "missing",
    "MIGRATION_ORDER_REQUIRED",
    "The landing ledger cannot precede the browser action ledger",
  );
}

function assertGate1MigrationPath(databasePath: string): void {
  const resolvedDatabasePath = path.resolve(databasePath);
  const parent = path.dirname(resolvedDatabasePath);
  const parentStat = lstatSync(parent);
  const databaseStat = lstatSync(resolvedDatabasePath);
  const markerPath = path.join(parent, ".icarus-state-v1");
  const markerStat = lstatSync(markerPath);
  const currentUid = process.getuid?.();
  let current = parent;
  while (true) {
    try {
      lstatSync(path.join(current, ".git"));
      throw new IcarusError(
        "STATE_REPOSITORY_OVERLAP",
        "Icarus state may not be migrated inside a Git worktree",
      );
    } catch (error) {
      if (
        error instanceof IcarusError ||
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        (error as NodeJS.ErrnoException).code !== "ENOENT"
      ) {
        throw error;
      }
    }
    const ancestor = path.dirname(current);
    if (ancestor === current) break;
    current = ancestor;
  }
  if (process.platform === "win32") {
    const profile = realpathSync(os.homedir());
    const relative = path.relative(profile, parent);
    invariant(
      relative.length > 0 &&
        relative !== ".." &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative),
      "UNSAFE_STATE_ROOT",
      "On Windows, Icarus state must be inside the current user profile",
    );
  }
  invariant(
    resolvedDatabasePath === databasePath &&
      path.basename(resolvedDatabasePath) === "icarus.sqlite3" &&
      parent !== path.parse(parent).root &&
      parentStat.isDirectory() &&
      !parentStat.isSymbolicLink() &&
      realpathSync(parent) === parent &&
      databaseStat.isFile() &&
      !databaseStat.isSymbolicLink() &&
      databaseStat.nlink === 1 &&
      markerStat.isFile() &&
      !markerStat.isSymbolicLink() &&
      markerStat.nlink === 1 &&
      readFileSync(markerPath, "utf8") === ICARUS_STATE_MARKER &&
      (currentUid === undefined ||
        (parentStat.uid === currentUid &&
          databaseStat.uid === currentUid &&
          markerStat.uid === currentUid)),
    "UNSAFE_STATE_ROOT",
    "Gate 1 migration requires an owned canonical Icarus state root",
  );
  if (process.platform !== "win32") {
    invariant(
      (parentStat.mode & 0o777) === 0o700 &&
        (databaseStat.mode & 0o777) === 0o600 &&
        (markerStat.mode & 0o777) === 0o600,
      "UNSAFE_STATE_ROOT",
      "Gate 1 migration requires private 0700 state and 0600 database/marker modes",
    );
  }
}

export function migrateGate1Schema(databasePath: string, token: Gate1MigrationToken): void {
  invariant(
    token === BROWSER_ACTION_LEDGER_MIGRATION || token === LANDING_LEDGER_MIGRATION,
    "INVALID_DATABASE_CONFIGURATION",
    "Gate 1 migration requires one exact documented migration token",
  );
  assertGate1MigrationPath(databasePath);
  const inspection = inspectGate1SchemasWithCoreRequirement(databasePath, true);
  assertMigrationPrecondition(inspection, token);

  const database = new Database(databasePath, { fileMustExist: true });
  try {
    database.pragma("foreign_keys = ON");
    database.pragma("synchronous = FULL");
    const apply = database.transaction(() => {
      assertMigrationPrecondition(inspectOpenDatabase(database, true), token);
      database.exec(
        token === BROWSER_ACTION_LEDGER_MIGRATION
          ? BROWSER_ACTION_LEDGER_SCHEMA
          : LANDING_LEDGER_SCHEMA,
      );
      const applied = inspectOpenDatabase(database, true);
      invariant(
        (token === BROWSER_ACTION_LEDGER_MIGRATION ? applied.browserActions : applied.landing) ===
          "valid",
        "DATABASE_ERROR",
        "Gate 1 ledger migration verification failed",
      );
    });
    apply.immediate();
  } catch (error) {
    if (isSqliteBusy(error)) {
      throw new IcarusError("RUN_BUSY", "Another process is migrating the Gate 1 schema");
    }
    throw error;
  } finally {
    database.close();
  }

  const after = inspectGate1SchemasWithCoreRequirement(databasePath, true);
  const applied = token === BROWSER_ACTION_LEDGER_MIGRATION ? after.browserActions : after.landing;
  if (applied !== "valid") {
    throw new IcarusError("DATABASE_ERROR", "Gate 1 ledger migration verification failed");
  }
}
