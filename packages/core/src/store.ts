import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { containsSecretShapedContent } from "./context.js";
import { digestJson, sha256 } from "./digest.js";
import { IcarusError, invariant } from "./errors.js";
import {
  assertCheckProfiles,
  assertSandboxProfile,
  assertSunCeiling,
  checkpointDigest,
  planApprovalDigest,
} from "./policy.js";
import { assertTransition } from "./state-machine.js";
import { CONTEXT_AUDIT_POLICY_VERSION } from "./types.js";
import type {
  ApprovalRecord,
  CheckProfile,
  ContextManifest,
  EditProposal,
  EventRecord,
  JsonValue,
  OperationFinish,
  OperationToken,
  PlanProposal,
  ProjectRecord,
  ProviderConfig,
  RepositoryRecord,
  RunRecord,
  RunState,
  SandboxProfile,
  SunCeiling,
  VerificationEvidence,
} from "./types.js";

type Row = Record<string, unknown>;

export const CANCELLATION_RECOVERY_OPERATION_KIND = "cancellation.recovery";
export const CANCELLATION_RECOVERY_RUNTIME_MS = 120_000;
export const MAX_CANCELLATION_RECOVERY_ATTEMPTS = 2;

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

function json(value: unknown): string {
  return JSON.stringify(value);
}

function asJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

export interface NewRunInput {
  readonly id: string;
  readonly projectId: string;
  readonly task: string;
  readonly target: string;
  readonly provider: ProviderConfig;
}

export interface CheckpointRecord {
  readonly runId: string;
  readonly baselineBase64: string;
  readonly approvedBase64: string;
  readonly checkpointSha256: string;
  readonly createdAt: string;
}

export class IcarusStore {
  readonly #database: Database.Database;
  readonly #now: () => string;
  readonly #id: () => string;

  constructor(
    databasePath: string,
    options: { now?: () => string; id?: () => string; busyTimeoutMs?: number } = {},
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
    this.#database = new Database(databasePath);
    chmodSync(databasePath, 0o600);
    this.#database.pragma(`busy_timeout = ${busyTimeoutMs}`);
    this.#database.pragma("foreign_keys = ON");
    this.#database.pragma("journal_mode = WAL");
    this.#database.pragma("synchronous = FULL");
    this.#database.exec(SCHEMA);
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
    const value = row(
      this.#database.prepare("SELECT * FROM repositories WHERE id = ?").get(id),
      "repository",
    );
    return {
      id: text(value.id, "repository.id"),
      name: text(value.name, "repository.name"),
      path: text(value.path, "repository.path"),
      device: numberValue(value.device, "repository.device"),
      inode: numberValue(value.inode, "repository.inode"),
      createdAt: text(value.created_at, "repository.created_at"),
    };
  }

  listRepositories(): RepositoryRecord[] {
    return (
      this.#database
        .prepare("SELECT id FROM repositories ORDER BY created_at, id")
        .all() as unknown[]
    ).map((value) => this.getRepository(text(row(value, "repository list").id, "repository.id")));
  }

  getRepositoryByName(name: string): RepositoryRecord {
    const value = row(
      this.#database.prepare("SELECT id FROM repositories WHERE name = ?").get(name),
      "repository",
    );
    return this.getRepository(text(value.id, "repository.id"));
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
        json(record.checks),
        json(record.sandbox),
        json(record.ceiling),
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
    const value = row(
      this.#database.prepare("SELECT * FROM projects WHERE id = ?").get(id),
      "project",
    );
    const checks = parseJson<CheckProfile[]>(value.checks_json, "project.checks_json");
    const sandbox = parseJson<SandboxProfile>(value.sandbox_json, "project.sandbox_json");
    const ceiling = parseJson<SunCeiling>(value.ceiling_json, "project.ceiling_json");
    assertCheckProfiles(checks);
    assertSandboxProfile(sandbox);
    assertSunCeiling(ceiling);
    return {
      id: text(value.id, "project.id"),
      name: text(value.name, "project.name"),
      repositoryId: text(value.repository_id, "project.repository_id"),
      baseRef: text(value.base_ref, "project.base_ref"),
      checks,
      sandbox,
      ceiling,
      createdAt: text(value.created_at, "project.created_at"),
    };
  }

  listProjects(): ProjectRecord[] {
    return (
      this.#database.prepare("SELECT id FROM projects ORDER BY created_at, id").all() as unknown[]
    ).map((value) => this.getProject(text(row(value, "project list").id, "project.id")));
  }

  getProjectByName(name: string): ProjectRecord {
    const value = row(
      this.#database.prepare("SELECT id FROM projects WHERE name = ?").get(name),
      "project",
    );
    return this.getProject(text(value.id, "project.id"));
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
    const emptyContext: ContextManifest = {
      auditPolicyVersion: CONTEXT_AUDIT_POLICY_VERSION,
      baseCommit: "",
      target: input.target,
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
          input.target,
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
        target: input.target,
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
        context.baseCommit === current.baseCommit && context.target === current.target,
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
    const value = row(this.#database.prepare("SELECT * FROM runs WHERE id = ?").get(id), "run");
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
      plan: nullableJson<PlanProposal>(value.plan_json, "run.plan_json"),
      planSha256: nullableText(value.plan_sha256, "run.plan_sha256"),
      edit: nullableJson<EditProposal>(value.edit_json, "run.edit_json"),
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

  recordPlanAndAwaitApproval(runId: string, plan: PlanProposal, planSha256: string): RunRecord {
    const transaction = this.#database.transaction(() => {
      const current = this.getRun(runId);
      invariant(current.state === "planned", "INVALID_STATE", "Run is not ready to store a plan");
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
          target: current.target,
          provider: current.provider,
          checks: project.checks,
          sandbox: project.sandbox,
          ceiling: project.ceiling,
          plan,
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
      this.#appendEvent(runId, "plan.created", {
        from: "planned",
        to: "awaiting_approval",
        planSha256,
      });
    });
    transaction();
    return this.getRun(runId);
  }

  approveEgress(runId: string, digest: string, actor: string): RunRecord {
    return this.#approveAndTransition(runId, {
      kind: "egress",
      digest,
      actor,
      decision: "approve",
      expectedState: "awaiting_egress_approval",
      to: "planned",
      expectedDigest: (run) => run.contextSha256,
      eventType: "egress.approved",
    });
  }

  approvePlan(runId: string, digest: string, actor: string): RunRecord {
    return this.#approveAndTransition(runId, {
      kind: "plan",
      digest,
      actor,
      decision: "approve",
      expectedState: "awaiting_approval",
      to: "running",
      expectedDigest: (run) => run.planSha256,
      eventType: "plan.approved",
    });
  }

  decideReview(
    runId: string,
    digest: string,
    actor: string,
    decision: "approve" | "reject",
  ): RunRecord {
    return this.#approveAndTransition(runId, {
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
    });
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
        .prepare("SELECT * FROM approvals WHERE run_id = ? ORDER BY created_at, id")
        .all(runId) as unknown[]
    ).map((entry) => {
      const value = row(entry, "approval");
      return {
        runId: text(value.run_id, "approval.run_id"),
        kind: text(value.kind, "approval.kind") as ApprovalRecord["kind"],
        digest: text(value.digest, "approval.digest"),
        actor: text(value.actor, "approval.actor"),
        decision: text(value.decision, "approval.decision") as ApprovalRecord["decision"],
        createdAt: text(value.created_at, "approval.created_at"),
      };
    });
  }

  recordWorkspace(
    runId: string,
    cachePath: string,
    worktreePath: string,
    baselineBase64: string,
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

  recordEditIntent(runId: string, edit: EditProposal, approvedBase64: string): RunRecord {
    const transaction = this.#database.transaction(() => {
      const current = this.getRun(runId);
      invariant(current.state === "running", "INVALID_STATE", "Run is not executing");
      const result = this.#database
        .prepare(
          `UPDATE runs SET edit_json = ?, approved_base64 = ?, version = version + 1,
           updated_at = ? WHERE id = ? AND state = 'running'`,
        )
        .run(json(edit), approvedBase64, this.#now(), runId);
      invariant(result.changes === 1, "CONCURRENT_RUN_UPDATE", "Run state changed concurrently");
      this.#appendEvent(runId, "edit.intent_recorded", {
        path: edit.path,
        expectedPreimageSha256: edit.expectedPreimageSha256,
      });
    });
    transaction();
    return this.getRun(runId);
  }

  recordVerificationAndAwaitReview(
    runId: string,
    diff: string,
    verification: VerificationEvidence,
  ): RunRecord {
    const transaction = this.#database.transaction(() => {
      const current = this.getRun(runId);
      invariant(current.state === "verifying", "INVALID_STATE", "Run is not verifying");
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
        verification.changedPaths.length === 1 && verification.changedPaths[0] === current.target,
        "CHANGED_PATH_MISMATCH",
        "Verification must contain exactly the approved target",
      );
      const expectedChecks = current.plan.checkIds.map((checkId) => {
        const check = project.checks.find((candidate) => candidate.id === checkId);
        invariant(
          check !== undefined,
          "CHECK_MISMATCH",
          "Approved plan references an unknown check",
        );
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
      const now = this.#now();
      this.#database
        .prepare(
          `UPDATE runs SET diff = ?, verification_json = ?, state = 'awaiting_review',
           version = version + 1, updated_at = ? WHERE id = ? AND state = 'verifying'`,
        )
        .run(diff, json(verification), now, runId);
      this.#appendEvent(runId, "verification.completed", {
        from: "verifying",
        to: "awaiting_review",
        outcome: verification.outcome,
        diffSha256: verification.diffSha256,
        diff,
        verification,
      });
    });
    transaction();
    return this.getRun(runId);
  }

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
          current.worktreePath !== null &&
            current.baselineBase64 !== null &&
            current.approvedBase64 !== null,
          "MISSING_CHECKPOINT",
          "Run cannot resume verification without applied edit state",
        );
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

  #finishOperation(token: OperationToken, finish: OperationFinish, emergency: boolean): RunRecord {
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
    const transaction = this.#database.transaction(() => {
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
    });
    transaction();
    return this.getRun(token.runId);
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
    approval: {
      kind: ApprovalRecord["kind"];
      digest: string;
      actor: string;
      decision: ApprovalRecord["decision"];
      expectedState: RunState;
      to: RunState;
      expectedDigest: (run: RunRecord) => string | null;
      eventType: string;
    },
  ): RunRecord {
    invariant(
      /^[a-f0-9]{64}$/.test(approval.digest),
      "INVALID_APPROVAL",
      "Approval digest is invalid",
    );
    invariant(
      approval.actor.trim().length > 0 &&
        approval.actor.length <= 200 &&
        !/[\r\n\0]/.test(approval.actor),
      "INVALID_APPROVAL",
      "Approval actor is invalid",
    );
    invariant(
      !containsSecretShapedContent(Buffer.from(approval.actor, "utf8")),
      "SECRET_INPUT_DETECTED",
      "Approval actor contains recognizable credential material",
    );
    const transaction = this.#database.transaction(() => {
      const current = this.getRun(runId);
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
    });
    transaction();
    return this.getRun(runId);
  }

  #finishInternalTransition(
    runId: string,
    expectedState: RunState,
    to: RunState,
    eventType: string,
  ): RunRecord {
    const transaction = this.#database.transaction(() => {
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
    });
    transaction();
    return this.getRun(runId);
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
