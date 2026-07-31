/**
 * Canonical SQLite objects that must predate the Gate 1 browser and landing
 * ledgers. This module is deliberately data-only so both normal store startup
 * and the CLI-only Gate 1 migration preflight compare against the same DDL.
 */
export const ICARUS_CORE_SCHEMA = `
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

export const ICARUS_APPROVAL_INDEX_SCHEMA = `
CREATE INDEX IF NOT EXISTS approvals_by_run
ON approvals(run_id);
`;

/**
 * ADR 0023 storage. These additive tables preserve the original `runs`
 * columns for legacy records while making multi-file intent authoritative.
 */
export const ICARUS_PATCH_SET_SCHEMA = `
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

/** ADR 0026's exact approved readable-file manifest. */
export const ICARUS_READABLE_MANIFEST_SCHEMA = `
CREATE TABLE IF NOT EXISTS readable_manifests (
  run_id TEXT PRIMARY KEY REFERENCES runs(id),
  base_commit TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL,
  entries_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

export const ICARUS_PRE_GATE1_SCHEMA = [
  ICARUS_CORE_SCHEMA,
  ICARUS_APPROVAL_INDEX_SCHEMA,
  ICARUS_PATCH_SET_SCHEMA,
  ICARUS_READABLE_MANIFEST_SCHEMA,
].join("\n");

export const ICARUS_BASE_SCHEMA_OBJECTS = [
  "repositories",
  "projects",
  "runs",
  "one_active_run_per_project",
  "run_events",
  "approvals",
  "operations",
  "one_started_operation_per_run",
  "checkpoints",
] as const;

export const ICARUS_APPROVAL_INDEX_OBJECTS = ["approvals_by_run"] as const;

export const ICARUS_PATCH_SET_OBJECTS = ["patch_sets", "checkpoint_files"] as const;

export const ICARUS_READABLE_MANIFEST_OBJECTS = ["readable_manifests"] as const;

export const ICARUS_PRE_GATE1_OBJECTS = [
  ...ICARUS_BASE_SCHEMA_OBJECTS,
  ...ICARUS_APPROVAL_INDEX_OBJECTS,
  ...ICARUS_PATCH_SET_OBJECTS,
  ...ICARUS_READABLE_MANIFEST_OBJECTS,
] as const;

export const ICARUS_SCHEMA_USER_VERSION = 1;
