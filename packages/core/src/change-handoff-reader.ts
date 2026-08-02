import { createHash } from "node:crypto";
import {
  type BigIntStats,
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
} from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import { parseStrictJson } from "./canonical-json.js";
import type { ChangeHandoffSourceSnapshot } from "./change-handoff.js";
import { digestJson, sha256, stableJson } from "./digest.js";
import { IcarusError } from "./errors.js";
import {
  applyExactReplacement,
  assertCheckProfiles,
  assertReadableManifest,
  assertRepositoryRelativePath,
  assertSandboxProfile,
  assertSunCeiling,
  checkpointDigest,
  MAX_READABLE_FILES,
  MAX_SESSION_ITERATIONS,
  parseEditProposal,
  parsePatchSet,
  parsePlanProposal,
  planApprovalDigest,
  readableManifestDigest,
  treeCheckpointDigest,
} from "./policy.js";
import { createProviderConfig } from "./provider.js";
import type {
  ApprovalRecord,
  CheckEvidence,
  CheckProfile,
  CheckpointFile,
  ContextManifest,
  JsonValue,
  ProviderConfig,
  ReadableManifest,
  RunState,
  SandboxProfile,
  SunCeiling,
  VerificationEvidence,
} from "./types.js";
import { CONTEXT_AUDIT_POLICY_VERSION } from "./types.js";

const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40,64}$/;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const RUN_STATES = new Set<RunState>([
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
const RESUME_STATES = new Set<RunState>([
  "preparing",
  "planned",
  "running",
  "verifying",
  "rolling_back",
  "restoring",
  "cancelling",
]);
const APPROVAL_KINDS = new Set<ApprovalRecord["kind"]>([
  "egress",
  "plan",
  "review",
  "rollback",
  "restore",
]);
const MAX_APPROVALS = 64;
const MAX_EVENTS = 4_096;
const MAX_CHECKPOINT_FILES = 16;
const MAX_PROVIDER_JSON_BYTES = 16 * 1024;
const MAX_CONTEXT_JSON_BYTES = 2 * 1024 * 1024;
const MAX_PLAN_JSON_BYTES = 128 * 1024;
const MAX_PATCH_JSON_BYTES = 4 * 1024 * 1024;
const MAX_VERIFICATION_JSON_BYTES = 16 * 1024 * 1024;
const MAX_PROJECT_JSON_BYTES = 1024 * 1024;
const MAX_DIFF_BYTES = 2 * 1024 * 1024;
const MAX_CHECKPOINT_ENCODED_BYTES = 4 * 1024 * 1024;
const MAX_DATABASE_FAMILY_BYTES = 1024n * 1024n * 1024n;
const MAX_OPERATIONS = 4_096;
const MAX_VERIFICATION_EVENT_JSON_BYTES = 32 * 1024 * 1024;
// These are persisted icarus.change-handoff.v1 ledger values. Keep the
// projection independent from the mutable Store runtime and validate them
// explicitly at the offline trust boundary.
const CANCELLATION_RECOVERY_OPERATION_KIND = "cancellation.recovery";
const CANCELLATION_RECOVERY_RUNTIME_MS = 120_000;
const MAX_CANCELLATION_RECOVERY_ATTEMPTS = 2;
const BROWSER_ACTION_KINDS: ReadonlySet<string> = new Set([
  "egress.approve",
  "plan.approve",
  "review.approve",
  "review.reject",
  "rollback.approve",
  "restore.approve",
  "run.resume",
  "run.cancel",
]);
const SESSION_ITERATION_OPERATION_KIND = "provider.revise";
const SESSION_READ_MANIFEST_OPERATION_KIND = "session.tool.read.manifest";
const SESSION_READ_CHECKS_OPERATION_KIND = "session.tool.read.checks";
const SESSION_CHECK_OPERATION_KIND = "session.tool.exec.check";
const SESSION_PATCH_OPERATION_KIND = "session.tool.mutation.patchset";
const SESSION_RECONCILE_OPERATION_KIND = "session.reconcile";
const REPAIR_SESSION_OPERATION_KINDS: ReadonlySet<string> = new Set([
  SESSION_ITERATION_OPERATION_KIND,
  SESSION_READ_MANIFEST_OPERATION_KIND,
  SESSION_READ_CHECKS_OPERATION_KIND,
  SESSION_CHECK_OPERATION_KIND,
  SESSION_PATCH_OPERATION_KIND,
  SESSION_RECONCILE_OPERATION_KIND,
  "session.control.report_done",
  "session.control.request_human_input",
]);
const ATOMIC_OPERATION_SUCCESSORS: ReadonlyMap<string, string> = new Map([
  [SESSION_CHECK_OPERATION_KIND, "verification.completed"],
  ["session.control.report_done", "session.completed"],
  ["session.control.request_human_input", "session.awaiting_human"],
  ["review.validate", "review.accepted"],
  ["checkpoint.rollback", "rollback.completed"],
  ["checkpoint.restore", "restore.completed"],
]);
const ACTIVE_OPERATION_EVENT_TYPES: ReadonlySet<string> = new Set([
  "base.pinned",
  "browser.action.admitted",
  "checkpoint.saved",
  "context.assembled",
  "edit.intent_recorded",
  "egress.requested",
  "operation.finished",
  "operation.interrupted",
  "patch_set.intent_recorded",
  "patch_set.superseded",
  "plan.created",
  "run.failed",
  "resume.requested",
  "workspace.created",
]);
const KNOWN_HANDOFF_EVENT_TYPES: ReadonlySet<string> = new Set([
  "base.pinned",
  "browser.action.admitted",
  "cancellation.completed",
  "cancellation.requested",
  "checkpoint.saved",
  "context.assembled",
  "edit.intent_recorded",
  "edit.materialized",
  "egress.approved",
  "egress.requested",
  "execution.completed",
  "operation.finished",
  "operation.interrupted",
  "operation.started",
  "patch_set.intent_recorded",
  "patch_set.superseded",
  "plan.approved",
  "plan.created",
  "repair.requested",
  "restore.approved",
  "restore.completed",
  "resume.requested",
  "review.accepted",
  "review.rejected",
  "rollback.approved",
  "rollback.completed",
  "run.created",
  "run.failed",
  "run.resumed",
  "session.awaiting_human",
  "session.completed",
  "session.exhausted",
  "session.iteration_completed",
  "session.verification_requested",
  "verification.completed",
  "workspace.created",
]);
const EVENT_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const SMALL_HANDOFF_EVENT_PAYLOAD_TYPES = [
  "browser.action.admitted",
  "cancellation.completed",
  "cancellation.requested",
  "checkpoint.saved",
  "context.assembled",
  "edit.intent_recorded",
  "edit.materialized",
  "egress.approved",
  "execution.completed",
  "operation.started",
  "operation.interrupted",
  "patch_set.intent_recorded",
  "patch_set.superseded",
  "plan.approved",
  "plan.created",
  "repair.requested",
  "restore.approved",
  "restore.completed",
  "review.accepted",
  "review.rejected",
  "rollback.approved",
  "rollback.completed",
  "run.created",
  "run.failed",
  "run.resumed",
  "session.awaiting_human",
  "session.completed",
  "session.exhausted",
  "session.iteration_completed",
  "session.verification_requested",
] as const;

type Row = Record<string, unknown>;

function sourceInvalid(message = "Icarus run evidence cannot be represented safely"): never {
  throw new IcarusError("HANDOFF_SOURCE_INVALID", message);
}

function row(value: unknown): Row {
  if (typeof value !== "object" || value === null || Array.isArray(value)) sourceInvalid();
  return value as Row;
}

function exactRecord(value: unknown, keys: readonly string[]): Row {
  const object = row(value);
  const expected = [...keys].sort();
  const actual = Object.keys(object).sort();
  if (expected.length !== actual.length || !expected.every((key, index) => key === actual[index])) {
    sourceInvalid();
  }
  return object;
}

interface BrowserActionAdmissionEvidence {
  readonly kind: string;
  readonly actionDigest: string;
}

function actionLinkedRecord(
  value: unknown,
  keys: readonly string[],
  admittedBrowserActions: ReadonlyMap<string, BrowserActionAdmissionEvidence>,
): Row {
  const unshaped = row(value);
  const actionIdPresent = Object.hasOwn(unshaped, "browserActionId");
  const payload = exactRecord(unshaped, [...keys, ...(actionIdPresent ? ["browserActionId"] : [])]);
  if (actionIdPresent) {
    const actionId = text(payload.browserActionId, 64);
    if (!UUID_PATTERN.test(actionId) || !admittedBrowserActions.has(actionId)) {
      sourceInvalid();
    }
  }
  return payload;
}

function text(value: unknown, maxBytes: number): string {
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > maxBytes
  ) {
    sourceInvalid();
  }
  return value;
}

function nonemptyText(value: unknown, maxBytes: number): string {
  const result = text(value, maxBytes);
  if (result.length === 0) sourceInvalid();
  return result;
}

function operationKind(value: unknown): string {
  const result = nonemptyText(value, 128);
  if (/[\r\n]/.test(result)) sourceInvalid();
  return result;
}

function nullableText(value: unknown, maxBytes: number): string | null {
  return value === null ? null : text(value, maxBytes);
}

function safeInteger(value: unknown, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) sourceInvalid();
  return value;
}

function finiteNumber(value: unknown, minimum = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) sourceInvalid();
  return value;
}

function booleanValue(value: unknown): boolean {
  if (typeof value !== "boolean") sourceInvalid();
  return value;
}

function digest(value: unknown): string {
  const result = text(value, 64);
  if (!SHA256_PATTERN.test(result)) sourceInvalid();
  return result;
}

function boundedJson(value: unknown, maxBytes: number): unknown {
  const encoded = text(value, maxBytes);
  try {
    return parseStrictJson(encoded, 64);
  } catch {
    sourceInvalid();
  }
}

function jsonArray(value: unknown, max: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > max) sourceInvalid();
  return value;
}

function stringArray(
  value: unknown,
  maxEntries: number,
  maxEntryBytes: number,
  paths = false,
): readonly string[] {
  const array = jsonArray(value, maxEntries).map((entry) => text(entry, maxEntryBytes));
  if (new Set(array).size !== array.length) sourceInvalid();
  if (paths) {
    try {
      array.forEach((entry) => {
        assertRepositoryRelativePath(entry);
      });
    } catch {
      sourceInvalid();
    }
  }
  return array;
}

function asJsonValue(value: unknown): JsonValue {
  return value as JsonValue;
}

function decodeProvider(value: unknown): ProviderConfig {
  const object = exactRecord(value, [
    "kind",
    "model",
    "baseUrl",
    "inputUsdPerMillionTokens",
    "outputUsdPerMillionTokens",
    "capabilities",
  ]);
  const kind = text(object.kind, 16);
  if (kind !== "ollama" && kind !== "openai" && kind !== "anthropic") sourceInvalid();
  const model = nonemptyText(object.model, 256);
  const baseUrl = nonemptyText(object.baseUrl, 2_048);
  const inputRate =
    object.inputUsdPerMillionTokens === null ? null : finiteNumber(object.inputUsdPerMillionTokens);
  const outputRate =
    object.outputUsdPerMillionTokens === null
      ? null
      : finiteNumber(object.outputUsdPerMillionTokens);
  exactRecord(object.capabilities, [
    "contextSize",
    "toolSupport",
    "visionSupport",
    "structuredOutputSupport",
    "streamingSupport",
    "costClass",
    "latencyClass",
    "privacyClass",
    "reasoningQuality",
    "locality",
  ]);
  let rebuilt: ProviderConfig;
  try {
    rebuilt = createProviderConfig({
      kind,
      model,
      baseUrl,
      inputUsdPerMillionTokens: inputRate,
      outputUsdPerMillionTokens: outputRate,
    });
  } catch {
    sourceInvalid();
  }
  if (stableJson(asJsonValue(value)) !== stableJson(asJsonValue(rebuilt))) sourceInvalid();
  return rebuilt;
}

function decodeChecks(value: unknown): readonly CheckProfile[] {
  return jsonArray(value, 32).map((entry) => {
    const object = exactRecord(entry, ["id", "name", "argv"]);
    const id = nonemptyText(object.id, 128);
    const name = nonemptyText(object.name, 256);
    const argv = stringArray(object.argv, 64, 4_096);
    if (argv.length === 0) sourceInvalid();
    return { id, name, argv };
  });
}

function decodeSandbox(value: unknown): SandboxProfile {
  const object = exactRecord(value, ["image", "cpus", "memoryMb", "pids", "tmpfsMb"]);
  return {
    image: nonemptyText(object.image, 1_024),
    cpus: finiteNumber(object.cpus),
    memoryMb: safeInteger(object.memoryMb),
    pids: safeInteger(object.pids),
    tmpfsMb: safeInteger(object.tmpfsMb),
  };
}

function decodeCeiling(value: unknown): SunCeiling {
  const object = exactRecord(value, [
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
  ]);
  return {
    maxToolCalls: safeInteger(object.maxToolCalls),
    maxActiveRuntimeMs: safeInteger(object.maxActiveRuntimeMs),
    maxContextBytes: safeInteger(object.maxContextBytes),
    maxOutputTokensPerCall: safeInteger(object.maxOutputTokensPerCall),
    maxTotalTokens: safeInteger(object.maxTotalTokens),
    maxCostUsd: finiteNumber(object.maxCostUsd),
    maxFilesChanged: safeInteger(object.maxFilesChanged, 1),
    maxFileBytes: safeInteger(object.maxFileBytes, 1),
    maxDiffBytes: safeInteger(object.maxDiffBytes, 1),
    maxCommandOutputBytes: safeInteger(object.maxCommandOutputBytes, 1),
    maxRawCommandOutputBytes: safeInteger(object.maxRawCommandOutputBytes, 1),
    providerTimeoutMs: safeInteger(object.providerTimeoutMs, 1),
    commandTimeoutMs: safeInteger(object.commandTimeoutMs, 1),
  };
}

function decodeContext(value: unknown): ContextManifest {
  const object = exactRecord(value, [
    "auditPolicyVersion",
    "baseCommit",
    "targets",
    "repositoryMap",
    "entries",
    "totalBytes",
  ]);
  const auditPolicyVersion = text(object.auditPolicyVersion, 128);
  if (auditPolicyVersion !== CONTEXT_AUDIT_POLICY_VERSION) sourceInvalid();
  const baseCommit = text(object.baseCommit, 64);
  if (baseCommit.length > 0 && !COMMIT_PATTERN.test(baseCommit)) sourceInvalid();
  const targets = stringArray(object.targets, 16, 1_024, true);
  if (
    targets.length === 0 ||
    [...targets].sort().some((entry, index) => entry !== targets[index])
  ) {
    sourceInvalid();
  }
  const repositoryMap = stringArray(object.repositoryMap, 2_000, 1_024, true);
  const entries = jsonArray(object.entries, 4_096).map((entry) => {
    const item = exactRecord(entry, ["path", "reason", "bytes", "sha256"]);
    const entryPath = text(item.path, 1_024);
    try {
      assertRepositoryRelativePath(entryPath);
    } catch {
      sourceInvalid();
    }
    const reason = text(item.reason, 64);
    if (
      reason !== "repository_map" &&
      reason !== "root_rules" &&
      reason !== "target_rules" &&
      reason !== "seed" &&
      reason !== "target"
    ) {
      sourceInvalid();
    }
    return {
      path: entryPath,
      reason: reason as "repository_map" | "root_rules" | "target_rules" | "seed" | "target",
      bytes: safeInteger(item.bytes),
      sha256: digest(item.sha256),
    };
  });
  return {
    auditPolicyVersion,
    baseCommit,
    targets,
    repositoryMap,
    entries,
    totalBytes: safeInteger(object.totalBytes),
  };
}
function validateContextManifest(context: ContextManifest, ceiling: SunCeiling): void {
  const expectedTargets = [...new Set(context.targets)].sort();
  const expectedRepositoryMap = [...new Set(context.repositoryMap)].sort((left, right) =>
    left.localeCompare(right),
  );
  if (
    expectedTargets.length !== context.targets.length ||
    expectedTargets.some((entry, index) => entry !== context.targets[index]) ||
    expectedRepositoryMap.length !== context.repositoryMap.length ||
    expectedRepositoryMap.some((entry, index) => entry !== context.repositoryMap[index])
  ) {
    sourceInvalid();
  }
  try {
    for (const entry of [...context.targets, ...context.repositoryMap]) {
      assertRepositoryRelativePath(entry);
    }
  } catch {
    sourceInvalid();
  }

  const targetSet = new Set(context.targets);
  const entryPaths = new Set<string>();
  let totalBytes = 0;
  for (const entry of context.entries) {
    if (
      entryPaths.has(entry.path) ||
      (entry.reason === "target" && !targetSet.has(entry.path)) ||
      (entry.reason !== "repository_map" && entry.bytes > ceiling.maxFileBytes)
    ) {
      sourceInvalid();
    }
    entryPaths.add(entry.path);
    totalBytes += entry.bytes + Buffer.byteLength(entry.path, "utf8");
    if (!Number.isSafeInteger(totalBytes)) sourceInvalid();
  }
  if (totalBytes !== context.totalBytes || totalBytes > ceiling.maxContextBytes) {
    sourceInvalid();
  }
}

function decodeReadableManifest(
  baseCommitValue: unknown,
  digestValue: unknown,
  entriesValue: unknown,
): ReadableManifest {
  const baseCommit = text(baseCommitValue, 64);
  if (!COMMIT_PATTERN.test(baseCommit)) sourceInvalid();
  const entries = jsonArray(boundedJson(entriesValue, MAX_CONTEXT_JSON_BYTES), 512).map((entry) => {
    const object = exactRecord(entry, ["path", "sha256"]);
    return { path: text(object.path, 1_024), sha256: digest(object.sha256) };
  });
  const manifest: ReadableManifest = { baseCommit, entries };
  try {
    assertReadableManifest(manifest);
  } catch {
    sourceInvalid();
  }
  if (readableManifestDigest(manifest) !== digest(digestValue)) sourceInvalid();
  return manifest;
}

function canonicalBase64(value: unknown): string | null {
  if (value === null) return null;
  const encoded = text(value, MAX_CHECKPOINT_ENCODED_BYTES);
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.toString("base64") !== encoded) sourceInvalid();
  return encoded;
}

function decodeCheckpointFiles(rows: readonly unknown[], runId: string): readonly CheckpointFile[] {
  if (rows.length > MAX_CHECKPOINT_FILES) sourceInvalid();
  const files = rows.map((entry) => {
    const object = row(entry);
    if (text(object.run_id, 64) !== runId) sourceInvalid();
    const filePath = text(object.path, 1_024);
    try {
      assertRepositoryRelativePath(filePath);
    } catch {
      sourceInvalid();
    }
    const op = text(object.op, 16);
    if (op !== "modify" && op !== "create" && op !== "delete") sourceInvalid();
    const baselineBase64 = canonicalBase64(object.baseline_base64);
    const approvedBase64 = canonicalBase64(object.approved_base64);
    if (
      (op === "modify" && (baselineBase64 === null || approvedBase64 === null)) ||
      (op === "create" && (baselineBase64 !== null || approvedBase64 === null)) ||
      (op === "delete" && (baselineBase64 === null || approvedBase64 !== null))
    ) {
      sourceInvalid();
    }
    return { path: filePath, op: op as CheckpointFile["op"], baselineBase64, approvedBase64 };
  });
  const paths = files.map((file) => file.path);
  if (new Set(paths).size !== paths.length) sourceInvalid();
  return files;
}

function persistedPatchSetAsProviderWire(value: unknown): unknown {
  const object = exactRecord(value, ["summary", "edits"]);
  const edits = jsonArray(object.edits, MAX_CHECKPOINT_FILES).map((entry) => {
    const candidate = row(entry);
    const op = text(candidate.op, 16);
    if (op === "modify") {
      const edit = exactRecord(candidate, [
        "op",
        "path",
        "expectedPreimageSha256",
        "replacements",
        "rationale",
      ]);
      return {
        op: edit.op,
        path: edit.path,
        expectedPreimageSha256: edit.expectedPreimageSha256,
        replacements: edit.replacements,
        content: null,
        rationale: edit.rationale,
      };
    }
    if (op === "create") {
      const edit = exactRecord(candidate, ["op", "path", "content", "rationale"]);
      return {
        op: edit.op,
        path: edit.path,
        expectedPreimageSha256: null,
        replacements: null,
        content: edit.content,
        rationale: edit.rationale,
      };
    }
    if (op === "delete") {
      const edit = exactRecord(candidate, ["op", "path", "expectedPreimageSha256", "rationale"]);
      return {
        op: edit.op,
        path: edit.path,
        expectedPreimageSha256: edit.expectedPreimageSha256,
        replacements: null,
        content: null,
        rationale: edit.rationale,
      };
    }
    return sourceInvalid();
  });
  return { summary: object.summary, edits };
}

function decodeCheckEvidence(value: unknown): CheckEvidence {
  const object = exactRecord(value, [
    "checkId",
    "argv",
    "exitCode",
    "signal",
    "durationMs",
    "stdout",
    "stderr",
    "truncated",
    "outcome",
  ]);
  const outcome = text(object.outcome, 16);
  if (
    outcome !== "passed" &&
    outcome !== "failed" &&
    outcome !== "unavailable" &&
    outcome !== "cancelled"
  ) {
    sourceInvalid();
  }
  const exitCode = object.exitCode === null ? null : safeInteger(object.exitCode);
  const signal = object.signal === null ? null : text(object.signal, 64);
  if (outcome === "passed" && (exitCode !== 0 || signal !== null)) {
    sourceInvalid();
  }
  return {
    checkId: nonemptyText(object.checkId, 128),
    argv: stringArray(object.argv, 64, 4_096),
    exitCode,
    signal,
    durationMs: safeInteger(object.durationMs),
    stdout: text(object.stdout, 8 * 1024 * 1024),
    stderr: text(object.stderr, 8 * 1024 * 1024),
    truncated: booleanValue(object.truncated),
    outcome,
  };
}

function decodeVerification(value: unknown): VerificationEvidence {
  const object = exactRecord(value, [
    "outcome",
    "checks",
    "changedPaths",
    "diffSha256",
    "checkpointSha256",
  ]);
  const outcome = text(object.outcome, 16);
  if (outcome !== "passed" && outcome !== "failed" && outcome !== "unavailable") sourceInvalid();
  return {
    outcome,
    checks: jsonArray(object.checks, 32).map(decodeCheckEvidence),
    changedPaths: stringArray(object.changedPaths, 16, 1_024, true),
    diffSha256: digest(object.diffSha256),
    checkpointSha256: digest(object.checkpointSha256),
  };
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((entry, index) => entry === b[index]);
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function validateVerification(
  verification: VerificationEvidence,
  diff: string,
  checkpointSha256: string,
  expectedPaths: readonly string[],
  planCheckIds: readonly string[],
  checks: readonly CheckProfile[],
  ceiling: SunCeiling,
): void {
  if (
    diff.length === 0 ||
    Buffer.byteLength(diff, "utf8") > ceiling.maxDiffBytes ||
    sha256(diff) !== verification.diffSha256 ||
    verification.checkpointSha256 !== checkpointSha256 ||
    !sameStringSet(verification.changedPaths, expectedPaths)
  ) {
    sourceInvalid();
  }
  const expectedChecks = planCheckIds.map((id) => checks.find((check) => check.id === id));
  if (
    expectedChecks.some((check) => check === undefined) ||
    verification.checks.length !== expectedChecks.length
  ) {
    sourceInvalid();
  }
  verification.checks.forEach((evidence, index) => {
    const expected = expectedChecks[index];
    if (
      expected === undefined ||
      evidence.checkId !== expected.id ||
      stableJson(asJsonValue(evidence.argv)) !== stableJson(asJsonValue(expected.argv)) ||
      Buffer.byteLength(evidence.stdout, "utf8") + Buffer.byteLength(evidence.stderr, "utf8") >
        ceiling.maxCommandOutputBytes
    ) {
      sourceInvalid();
    }
  });
  const derived = verification.checks.every((check) => check.outcome === "passed")
    ? "passed"
    : verification.checks.some((check) => check.outcome === "failed")
      ? "failed"
      : "unavailable";
  if (derived !== verification.outcome) sourceInvalid();
}

interface FamilyFile {
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

interface FamilyFingerprint {
  readonly files: readonly FamilyFile[];
}

function metadata(stat: BigIntStats): string {
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

function safeFamilyStat(filePath: string): BigIntStats {
  const stat = lstatSync(filePath, { bigint: true });
  const currentUid = process.getuid?.();
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1n ||
    stat.size > MAX_DATABASE_FAMILY_BYTES ||
    (currentUid !== undefined && stat.uid !== BigInt(currentUid)) ||
    (process.platform !== "win32" && (stat.mode & 0o022n) !== 0n)
  ) {
    sourceInvalid("Icarus database files are unsafe for handoff preview");
  }
  return stat;
}

interface StableFamilyFileRead {
  readonly stat: BigIntStats;
  readonly digest: string;
  readonly bytes: Buffer | null;
}

function readStableFamilyFile(filePath: string, captureBytes: boolean): StableFamilyFileRead {
  const before = safeFamilyStat(filePath);
  const descriptor = openSync(filePath, fsConstants.O_RDONLY | noFollowFlag());
  const hash = createHash("sha256");
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (metadata(before) !== metadata(opened)) {
      throw new IcarusError("RUN_BUSY", "Icarus database changed during handoff preview");
    }
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    while (true) {
      const read = readSync(descriptor, buffer, 0, buffer.length, null);
      if (read === 0) break;
      total += read;
      if (BigInt(total) > MAX_DATABASE_FAMILY_BYTES) {
        sourceInvalid("Icarus database family exceeds the handoff preview byte limit");
      }
      const chunk = buffer.subarray(0, read);
      hash.update(chunk);
      if (captureBytes) chunks.push(Buffer.from(chunk));
    }
    const finished = fstatSync(descriptor, { bigint: true });
    const after = safeFamilyStat(filePath);
    if (
      metadata(before) !== metadata(finished) ||
      metadata(before) !== metadata(after) ||
      total !== Number(before.size)
    ) {
      throw new IcarusError("RUN_BUSY", "Icarus database changed during handoff preview");
    }
    return {
      stat: after,
      digest: hash.digest("hex"),
      bytes: captureBytes ? Buffer.concat(chunks, total) : null,
    };
  } finally {
    closeSync(descriptor);
  }
}

function fingerprintFile(filePath: string, name: string): FamilyFile {
  const read = readStableFamilyFile(filePath, false);
  return {
    name,
    device: String(read.stat.dev),
    inode: String(read.stat.ino),
    mode: String(read.stat.mode),
    links: String(read.stat.nlink),
    owner: String(read.stat.uid),
    size: String(read.stat.size),
    modifiedAt: String(read.stat.mtimeNs),
    changedAt: String(read.stat.ctimeNs),
    digest: read.digest,
  };
}

function fingerprintFamily(databasePath: string): FamilyFingerprint {
  const parent = path.dirname(databasePath);
  const basename = path.basename(databasePath);
  const allowed = new Set([basename, `${basename}-wal`, `${basename}-shm`]);
  const names = readdirSync(parent)
    .filter((name) => name === basename || name.startsWith(`${basename}-`))
    .sort();
  if (!names.includes(basename) || names.some((name) => !allowed.has(name))) {
    sourceInvalid("Icarus database family is unsafe for handoff preview");
  }
  const family = names.map((name) => ({
    name,
    path: path.join(parent, name),
    stat: safeFamilyStat(path.join(parent, name)),
  }));
  if (family.reduce((total, entry) => total + entry.stat.size, 0n) > MAX_DATABASE_FAMILY_BYTES) {
    sourceInvalid("Icarus database family exceeds the handoff preview byte limit");
  }
  return {
    files: family.map((entry) => fingerprintFile(entry.path, entry.name)),
  };
}

function sameFamily(left: FamilyFingerprint, right: FamilyFingerprint): boolean {
  return stableJson(asJsonValue(left)) === stableJson(asJsonValue(right));
}

function assertDatabasePath(databasePath: string): string {
  const absolute = path.resolve(databasePath);
  const parent = path.dirname(absolute);
  const parentStat = lstatSync(parent, { bigint: true });
  const currentUid = process.getuid?.();
  if (
    !parentStat.isDirectory() ||
    parentStat.isSymbolicLink() ||
    realpathSync(parent) !== parent ||
    (currentUid !== undefined && parentStat.uid !== BigInt(currentUid)) ||
    (process.platform !== "win32" && (parentStat.mode & 0o077n) !== 0n)
  ) {
    sourceInvalid("Icarus state directory is unsafe for handoff preview");
  }
  const requested = lstatSync(absolute, { bigint: true });
  if (!requested.isFile() || requested.isSymbolicLink() || realpathSync(absolute) !== absolute) {
    sourceInvalid("Icarus database path is unsafe for handoff preview");
  }
  return absolute;
}

function readDatabaseImage(databasePath: string, source: FamilyFingerprint): Buffer {
  const basename = path.basename(databasePath);
  const databaseEntry = source.files.find((entry) => entry.name === basename);
  const walEntry = source.files.find((entry) => entry.name === `${basename}-wal`);
  if (databaseEntry === undefined) sourceInvalid();
  if (walEntry !== undefined && BigInt(walEntry.size) !== 0n) {
    throw new IcarusError(
      "RUN_BUSY",
      "Icarus database has uncheckpointed WAL evidence and cannot be previewed read-only",
    );
  }

  const read = readStableFamilyFile(databasePath, true);
  if (
    read.bytes === null ||
    String(read.stat.size) !== databaseEntry.size ||
    read.digest !== databaseEntry.digest
  ) {
    throw new IcarusError("RUN_BUSY", "Icarus database changed during handoff preview");
  }
  const image = read.bytes;
  if (
    image.length < 100 ||
    !image.subarray(0, 16).equals(Buffer.from("SQLite format 3\0", "ascii")) ||
    (image[18] !== 1 && image[18] !== 2) ||
    (image[19] !== 1 && image[19] !== 2) ||
    image[18] !== image[19]
  ) {
    sourceInvalid("Icarus database image is invalid");
  }

  // The source is WAL-clean above. Normalize only the private in-memory image
  // so SQLite never opens or creates source-side journal companion files.
  image[18] = 1;
  image[19] = 1;
  return image;
}

interface HandoffApprovalEvidence {
  readonly kind: ApprovalRecord["kind"];
  readonly digest: string;
  readonly decision: ApprovalRecord["decision"];
  readonly actor: string;
  readonly createdAt: string;
}

function readApprovals(
  database: Database.Database,
  runId: string,
): readonly HandoffApprovalEvidence[] {
  const entries = database
    .prepare(
      "SELECT " +
        "CASE WHEN typeof(kind)='text' AND octet_length(kind)<=16 THEN kind END AS kind, " +
        "CASE WHEN typeof(digest)='text' AND octet_length(digest)<=64 THEN digest END AS digest, " +
        "CASE WHEN typeof(decision)='text' AND octet_length(decision)<=16 THEN decision END AS decision, " +
        "CASE WHEN typeof(actor)='text' AND octet_length(actor)<=200 THEN actor END AS actor, " +
        "CASE WHEN typeof(created_at)='text' AND octet_length(created_at)<=64 THEN created_at END AS created_at " +
        "FROM approvals WHERE run_id = ? ORDER BY rowid LIMIT " +
        String(MAX_APPROVALS + 1),
    )
    .all(runId) as unknown[];
  if (entries.length > MAX_APPROVALS) sourceInvalid();
  return entries.map((entry) => {
    const object = row(entry);
    const kind = text(object.kind, 16);
    if (!APPROVAL_KINDS.has(kind as ApprovalRecord["kind"])) sourceInvalid();
    const decision = text(object.decision, 16);
    const actor = nonemptyText(object.actor, 200);
    const createdAt = text(object.created_at, 64);
    if (
      (decision !== "approve" && decision !== "reject") ||
      (decision === "reject" && kind !== "review") ||
      /[\r\n]/.test(actor) ||
      !EVENT_TIMESTAMP_PATTERN.test(createdAt)
    ) {
      sourceInvalid();
    }
    return {
      kind: kind as ApprovalRecord["kind"],
      digest: digest(object.digest),
      decision,
      actor,
      createdAt,
    };
  });
}

interface ApprovalTransitionEvidence {
  readonly type: string;
  readonly sequence: number;
  readonly from: RunState;
  readonly to: RunState;
  readonly kind: ApprovalRecord["kind"];
  readonly digest: string;
  readonly actor: string;
  readonly decision: ApprovalRecord["decision"];
  readonly createdAt: string;
}

interface VerificationTransitionEvidence {
  readonly sequence: number;
  readonly from: "running" | "verifying";
  readonly to: "awaiting_review" | "running" | "verifying";
  readonly outcome: VerificationEvidence["outcome"];
  readonly diffSha256: string;
  readonly checkpointSha256: string;
  readonly verificationEvidenceSha256: string;
}

interface FailureTransitionEvidence {
  readonly sequence: number;
  readonly from: RunState;
  readonly resumeState: RunState;
  readonly code: string;
}

interface ResumeTransitionEvidence {
  readonly sequence: number;
  readonly to: RunState;
}

interface CancellationTransitionEvidence {
  readonly sequence: number;
  readonly from: RunState;
  readonly to: "cancelling";
}

interface OperationStartEvidence {
  readonly sequence: number;
  readonly operationId: string;
  readonly kind: string;
  readonly reservedCostUsd: number;
  readonly reservedTokens: number;
  readonly reservedRuntimeMs: number;
  readonly budgetClass: "ordinary" | "emergency";
  readonly attempt: number | null;
}

interface OperationFinishEvidence {
  readonly sequence: number;
  readonly operationId: string;
  readonly kind: string;
  readonly outcome: "succeeded" | "failed" | "cancelled";
  readonly detailTool: string | null;
}

interface OperationTerminalEvidence {
  readonly sequence: number;
  readonly operationId: string;
  readonly kind: string;
  readonly status: "succeeded" | "failed" | "cancelled" | "interrupted";
  readonly detailTool: string | null;
  readonly editIntentCount: number;
  readonly patchIntentCount: number;
  readonly checkpointCount: number;
}

function hasNoPatchEffects(terminal: OperationTerminalEvidence): boolean {
  return (
    terminal.editIntentCount === 0 &&
    terminal.patchIntentCount === 0 &&
    terminal.checkpointCount === 0
  );
}

function isAdvisoryPatchTerminal(terminal: OperationTerminalEvidence): boolean {
  return (
    terminal.status === "succeeded" &&
    terminal.detailTool === "propose_patch" &&
    hasNoPatchEffects(terminal)
  );
}

function isAppliedPatchTerminal(terminal: OperationTerminalEvidence): boolean {
  return (
    terminal.status === "succeeded" &&
    terminal.detailTool === "apply_patchset" &&
    terminal.editIntentCount === 0 &&
    terminal.patchIntentCount === 1 &&
    terminal.checkpointCount === 1
  );
}

function terminalCanProduceVerification(
  terminal: OperationTerminalEvidence,
  outcome: VerificationEvidence["outcome"],
): boolean {
  if (terminal.kind === SESSION_CHECK_OPERATION_KIND) {
    return (
      terminal.status === "succeeded" &&
      terminal.editIntentCount === 0 &&
      terminal.patchIntentCount === 0 &&
      terminal.checkpointCount === 0
    );
  }
  if (terminal.kind === SESSION_PATCH_OPERATION_KIND) {
    const effectfulPatch =
      terminal.detailTool === "apply_patchset" &&
      terminal.editIntentCount === 0 &&
      terminal.patchIntentCount === 1 &&
      terminal.checkpointCount === 1;
    return (
      effectfulPatch &&
      outcome === "unavailable" &&
      (terminal.status === "succeeded" ||
        terminal.status === "failed" ||
        terminal.status === "cancelled")
    );
  }
  return (
    terminal.kind === SESSION_RECONCILE_OPERATION_KIND &&
    terminal.status === "succeeded" &&
    outcome === "unavailable" &&
    terminal.editIntentCount === 0 &&
    terminal.patchIntentCount === 0 &&
    terminal.checkpointCount <= 1
  );
}

interface SessionDispositionEvidence {
  readonly type: "session.completed" | "session.awaiting_human" | "session.exhausted";
  readonly sequence: number;
  readonly iterations: number;
  readonly operationId: string | null;
  readonly revisionSequence: number | null;
  readonly diffSha256: string | null;
  readonly checkpointSha256: string | null;
}

type IntentEvidence =
  | {
      readonly type: "edit.intent_recorded";
      readonly sequence: number;
      readonly path: string;
      readonly expectedPreimageSha256: string;
    }
  | {
      readonly type: "patch_set.intent_recorded";
      readonly sequence: number;
      readonly paths: readonly string[];
      readonly operations: readonly ("modify" | "create" | "delete")[];
    };

interface ReadEventSummary {
  readonly snapshot: ChangeHandoffSourceSnapshot["events"];
  readonly approvalTransitions: readonly ApprovalTransitionEvidence[];
  readonly verificationTransitions: readonly VerificationTransitionEvidence[];
  readonly failureTransitions: readonly FailureTransitionEvidence[];
  readonly resumeTransitions: readonly ResumeTransitionEvidence[];
  readonly cancellationRequests: readonly CancellationTransitionEvidence[];
  readonly intentEvidence: readonly IntentEvidence[];
  readonly operationStarts: readonly OperationStartEvidence[];
  readonly operationTerminals: readonly OperationTerminalEvidence[];
  readonly rollbackCompletionSequences: readonly number[];
  readonly restoreCompletionSequences: readonly number[];
  readonly latestIntentSequence: number | null;
  readonly contextAssembledDigest: string | null;
  readonly planCreatedSequence: number | null;
  readonly planCreatedDigest: string | null;
  readonly planCreatedReadableFiles: number | null;
  readonly runCreatedTarget: string;
  readonly replayedState: RunState;
  readonly verificationRequestSequence: number | null;
  readonly activeCheckpointSha256: string | null;
}
function readVerificationTransition(
  database: Database.Database,
  runId: string,
  sequence: number,
  admittedBrowserActions: ReadonlyMap<string, BrowserActionAdmissionEvidence>,
): VerificationTransitionEvidence {
  const preflight = row(
    database
      .prepare(
        "SELECT typeof(payload_json) AS storage_type, " +
          "octet_length(payload_json) AS payload_bytes " +
          "FROM run_events WHERE run_id=? AND sequence=? AND type='verification.completed'",
      )
      .get(runId, sequence),
  );
  if (preflight.storage_type !== "text") sourceInvalid();
  const payloadBytes = safeInteger(preflight.payload_bytes);
  if (payloadBytes > MAX_VERIFICATION_EVENT_JSON_BYTES) sourceInvalid();

  const validity = row(
    database
      .prepare(
        "SELECT json_valid(payload_json,1) AS valid FROM run_events " +
          "WHERE run_id=? AND sequence=? AND type='verification.completed'",
      )
      .get(runId, sequence),
  );
  if (safeInteger(validity.valid) !== 1) sourceInvalid();

  const projected = row(
    database
      .prepare(
        "SELECT " +
          "(SELECT COUNT(*) FROM json_each(payload_json)) AS root_count, " +
          "(SELECT COUNT(*) FROM json_each(payload_json) WHERE key='from') AS from_count, " +
          "(SELECT COUNT(*) FROM json_each(payload_json) WHERE key='to') AS to_count, " +
          "(SELECT COUNT(*) FROM json_each(payload_json) WHERE key='outcome') AS outcome_count, " +
          "(SELECT COUNT(*) FROM json_each(payload_json) WHERE key='diffSha256') AS diff_count, " +
          "(SELECT COUNT(*) FROM json_each(payload_json) WHERE key='diff') AS diff_body_count, " +
          "(SELECT COUNT(*) FROM json_each(payload_json) WHERE key='verification') AS verification_count, " +
          "(SELECT COUNT(*) FROM json_each(payload_json) WHERE key='browserActionId') AS browser_action_id_count, " +
          "(SELECT COUNT(*) FROM json_each(payload_json,'$.verification')) AS nested_root_count, " +
          "(SELECT COUNT(*) FROM json_each(payload_json,'$.verification') WHERE key='outcome') AS nested_outcome_count, " +
          "(SELECT COUNT(*) FROM json_each(payload_json,'$.verification') WHERE key='diffSha256') AS nested_diff_count, " +
          "(SELECT COUNT(*) FROM json_each(payload_json,'$.verification') WHERE key='checkpointSha256') AS nested_checkpoint_count, " +
          "(SELECT COUNT(*) FROM json_each(payload_json,'$.verification') WHERE key='checks') AS nested_checks_count, " +
          "(SELECT COUNT(*) FROM json_each(payload_json,'$.verification') WHERE key='changedPaths') AS nested_changed_paths_count, " +
          "json_type(payload_json,'$.from') AS from_type, " +
          "json_type(payload_json,'$.to') AS to_type, " +
          "json_type(payload_json,'$.outcome') AS outcome_type, " +
          "json_type(payload_json,'$.detail.tool') AS detail_tool_type, " +
          "json_type(payload_json,'$.diffSha256') AS diff_type, " +
          "json_type(payload_json,'$.diff') AS diff_body_type, " +
          "json_type(payload_json,'$.verification') AS verification_type, " +
          "json_type(payload_json,'$.browserActionId') AS browser_action_id_type, " +
          "json_type(payload_json,'$.verification.outcome') AS nested_outcome_type, " +
          "json_type(payload_json,'$.verification.diffSha256') AS nested_diff_type, " +
          "json_type(payload_json,'$.verification.checkpointSha256') AS nested_checkpoint_type, " +
          "json_type(payload_json,'$.verification.checks') AS nested_checks_type, " +
          "json_type(payload_json,'$.verification.changedPaths') AS nested_changed_paths_type, " +
          "json_extract(payload_json,'$.from') AS from_value, " +
          "json_extract(payload_json,'$.to') AS to_value, " +
          "json_extract(payload_json,'$.outcome') AS outcome_value, " +
          "json_extract(payload_json,'$.diffSha256') AS diff_value, " +
          "json_extract(payload_json,'$.verification.outcome') AS nested_outcome_value, " +
          "json_extract(payload_json,'$.verification.diffSha256') AS nested_diff_value, " +
          "json_extract(payload_json,'$.verification.checkpointSha256') AS nested_checkpoint_value, " +
          "json_extract(payload_json,'$.diff') AS diff_body_value, " +
          "json_extract(payload_json,'$.browserActionId') AS browser_action_id_value, " +
          "json_extract(payload_json,'$.verification') AS nested_verification_value " +
          "FROM run_events WHERE run_id=? AND sequence=? " +
          "AND type='verification.completed' AND json_type(payload_json,'$')='object'",
      )
      .get(runId, sequence),
  );
  const browserActionIdCount = safeInteger(projected.browser_action_id_count);
  if (
    browserActionIdCount > 1 ||
    safeInteger(projected.root_count) !== 6 + browserActionIdCount ||
    safeInteger(projected.from_count) !== 1 ||
    safeInteger(projected.to_count) !== 1 ||
    safeInteger(projected.outcome_count) !== 1 ||
    safeInteger(projected.diff_count) !== 1 ||
    safeInteger(projected.diff_body_count) !== 1 ||
    safeInteger(projected.verification_count) !== 1 ||
    safeInteger(projected.nested_root_count) !== 5 ||
    safeInteger(projected.nested_outcome_count) !== 1 ||
    safeInteger(projected.nested_diff_count) !== 1 ||
    safeInteger(projected.nested_checkpoint_count) !== 1 ||
    safeInteger(projected.nested_checks_count) !== 1 ||
    safeInteger(projected.nested_changed_paths_count) !== 1 ||
    projected.from_type !== "text" ||
    projected.to_type !== "text" ||
    projected.outcome_type !== "text" ||
    projected.diff_type !== "text" ||
    projected.diff_body_type !== "text" ||
    projected.verification_type !== "object" ||
    projected.nested_outcome_type !== "text" ||
    projected.nested_diff_type !== "text" ||
    projected.nested_checkpoint_type !== "text" ||
    projected.nested_checks_type !== "array" ||
    projected.nested_changed_paths_type !== "array"
  ) {
    sourceInvalid();
  }

  if (browserActionIdCount === 0) {
    if (projected.browser_action_id_type !== null || projected.browser_action_id_value !== null) {
      sourceInvalid();
    }
  } else {
    const browserActionId = text(projected.browser_action_id_value, 64);
    if (
      projected.browser_action_id_type !== "text" ||
      !UUID_PATTERN.test(browserActionId) ||
      !admittedBrowserActions.has(browserActionId)
    ) {
      sourceInvalid();
    }
  }

  const from = text(projected.from_value, 32);
  const to = text(projected.to_value, 32);
  const outcome = text(projected.outcome_value, 16);
  const diffSha256 = digest(projected.diff_value);
  const checkpointSha256 = digest(projected.nested_checkpoint_value);
  const diffBody = text(projected.diff_body_value, MAX_DIFF_BYTES);
  const nestedVerification = decodeVerification(
    boundedJson(projected.nested_verification_value, MAX_VERIFICATION_JSON_BYTES),
  );
  const verificationEvidenceSha256 = digestJson(asJsonValue(nestedVerification));
  const validTransition =
    (from === "verifying" &&
      (to === "awaiting_review" || to === "running" || to === "verifying")) ||
    (from === "running" && to === "running");
  if (
    !validTransition ||
    (outcome !== "passed" && outcome !== "failed" && outcome !== "unavailable") ||
    (from === "verifying" && to === "verifying" && outcome !== "failed") ||
    sha256(diffBody) !== diffSha256 ||
    text(projected.nested_outcome_value, 16) !== outcome ||
    digest(projected.nested_diff_value) !== diffSha256 ||
    nestedVerification.outcome !== outcome ||
    nestedVerification.diffSha256 !== diffSha256 ||
    nestedVerification.checkpointSha256 !== checkpointSha256
  ) {
    sourceInvalid();
  }
  return {
    sequence,
    from: from as "running" | "verifying",
    to: to as "awaiting_review" | "running" | "verifying",
    outcome,
    diffSha256,
    checkpointSha256,
    verificationEvidenceSha256,
  };
}

function readOperationFinishEvidence(
  database: Database.Database,
  runId: string,
  sequence: number,
): OperationFinishEvidence {
  const preflight = row(
    database
      .prepare(
        "SELECT typeof(payload_json) AS storage_type, " +
          "octet_length(payload_json) AS payload_bytes " +
          "FROM run_events WHERE run_id=? AND sequence=? AND type='operation.finished'",
      )
      .get(runId, sequence),
  );
  if (preflight.storage_type !== "text") sourceInvalid();
  const payloadBytes = safeInteger(preflight.payload_bytes);
  if (payloadBytes > MAX_VERIFICATION_EVENT_JSON_BYTES) sourceInvalid();

  const validity = row(
    database
      .prepare(
        "SELECT json_valid(payload_json,1) AS valid FROM run_events " +
          "WHERE run_id=? AND sequence=? AND type='operation.finished'",
      )
      .get(runId, sequence),
  );
  if (safeInteger(validity.valid) !== 1) sourceInvalid();

  const projected = row(
    database
      .prepare(
        "SELECT " +
          "(SELECT COUNT(*) FROM json_each(payload_json)) AS root_count, " +
          "(SELECT COUNT(*) FROM json_each(payload_json) WHERE key='operationId') AS operation_id_count, " +
          "(SELECT COUNT(*) FROM json_each(payload_json) WHERE key='kind') AS kind_count, " +
          "(SELECT COUNT(*) FROM json_each(payload_json) WHERE key='outcome') AS outcome_count, " +
          "(SELECT COUNT(*) FROM json_each(payload_json) WHERE key='detail') AS detail_count, " +
          "(SELECT COUNT(*) FROM json_each(payload_json,'$.detail') WHERE key='tool') AS detail_tool_count, " +
          "json_type(payload_json,'$.operationId') AS operation_id_type, " +
          "json_type(payload_json,'$.kind') AS kind_type, " +
          "json_type(payload_json,'$.outcome') AS outcome_type, " +
          "json_type(payload_json,'$.detail') AS detail_type, " +
          "json_type(payload_json,'$.detail.tool') AS detail_tool_type, " +
          "json_extract(payload_json,'$.operationId') AS operation_id_value, " +
          "json_extract(payload_json,'$.kind') AS kind_value, " +
          "json_extract(payload_json,'$.outcome') AS outcome_value " +
          ", json_extract(payload_json,'$.detail.tool') AS detail_tool_value " +
          "FROM run_events WHERE run_id=? AND sequence=? " +
          "AND type='operation.finished' AND json_type(payload_json,'$')='object'",
      )
      .get(runId, sequence),
  );
  if (
    safeInteger(projected.root_count) !== 4 ||
    safeInteger(projected.operation_id_count) !== 1 ||
    safeInteger(projected.kind_count) !== 1 ||
    safeInteger(projected.outcome_count) !== 1 ||
    safeInteger(projected.detail_count) !== 1 ||
    projected.operation_id_type !== "text" ||
    projected.kind_type !== "text" ||
    projected.outcome_type !== "text"
  ) {
    sourceInvalid();
  }
  const operationId = text(projected.operation_id_value, 64);
  const kind = operationKind(projected.kind_value);
  const outcome = text(projected.outcome_value, 16);
  if (
    !UUID_PATTERN.test(operationId) ||
    (outcome !== "succeeded" && outcome !== "failed" && outcome !== "cancelled")
  ) {
    sourceInvalid();
  }
  const patchMutation = kind === SESSION_PATCH_OPERATION_KIND;
  const detailTool =
    patchMutation &&
    projected.detail_type === "object" &&
    safeInteger(projected.detail_tool_count) === 1 &&
    projected.detail_tool_type === "text"
      ? text(projected.detail_tool_value, 64)
      : null;
  if (patchMutation && detailTool !== "propose_patch" && detailTool !== "apply_patchset") {
    sourceInvalid();
  }
  return {
    sequence,
    operationId,
    kind,
    outcome,
    detailTool,
  };
}

function assertAtomicSessionControlEvidence(
  database: Database.Database,
  runId: string,
  dispositionSequence: number,
  operationId: string,
  expectedKind: "session.control.report_done" | "session.control.request_human_input",
): void {
  const finished = readOperationFinishEvidence(database, runId, dispositionSequence - 1);
  if (
    finished.operationId !== operationId ||
    finished.kind !== expectedKind ||
    finished.outcome !== "succeeded"
  ) {
    sourceInvalid();
  }
  const operation = row(
    database
      .prepare(
        "SELECT " +
          "CASE WHEN typeof(id)='text' AND octet_length(id)<=64 THEN id END AS id, " +
          "CASE WHEN typeof(kind)='text' AND octet_length(kind)<=128 THEN kind END AS kind, " +
          "CASE WHEN typeof(status)='text' AND octet_length(status)<=16 THEN status END AS status " +
          "FROM operations WHERE id=? AND run_id=?",
      )
      .get(operationId, runId),
  );
  if (
    text(operation.id, 64) !== operationId ||
    operationKind(operation.kind) !== expectedKind ||
    text(operation.status, 16) !== "succeeded"
  ) {
    sourceInvalid();
  }
}

function readEventSummary(
  database: Database.Database,
  runId: string,
  iterationCeiling: number | null,
): ReadEventSummary {
  const smallPayloadPlaceholders = SMALL_HANDOFF_EVENT_PAYLOAD_TYPES.map(() => "?").join(",");
  const entries = database
    .prepare(
      "SELECT " +
        "CASE WHEN typeof(sequence)='integer' THEN sequence END AS sequence, " +
        "CASE WHEN typeof(type)='text' AND octet_length(type)<=128 THEN type END AS type, " +
        "CASE WHEN type IN (" +
        smallPayloadPlaceholders +
        ") THEN CASE WHEN typeof(payload_json)='text' AND octet_length(payload_json)<=65536 " +
        "AND json_valid(payload_json,1)=1 THEN payload_json END ELSE '{}' END AS bounded_payload, " +
        "CASE WHEN typeof(created_at)='text' AND octet_length(created_at)<=64 THEN created_at END AS created_at " +
        "FROM run_events WHERE run_id=? ORDER BY sequence LIMIT " +
        String(MAX_EVENTS + 1),
    )
    .all(...SMALL_HANDOFF_EVENT_PAYLOAD_TYPES, runId) as unknown[];
  if (entries.length < 1 || entries.length > MAX_EVENTS) sourceInvalid();

  const counts = new Map<string, { count: number; last: number; sequences: number[] }>();
  const approvalTransitions: ApprovalTransitionEvidence[] = [];
  const verificationTransitions: VerificationTransitionEvidence[] = [];
  const failureTransitions: FailureTransitionEvidence[] = [];
  const resumeTransitions: ResumeTransitionEvidence[] = [];
  const cancellationRequests: CancellationTransitionEvidence[] = [];
  const operationStarts: OperationStartEvidence[] = [];
  const operationTerminals: OperationTerminalEvidence[] = [];
  const operationIds = new Set<string>();
  const terminalOperationIds = new Set<string>();
  const admittedBrowserActions = new Map<string, BrowserActionAdmissionEvidence>();
  const sessionDispositions: SessionDispositionEvidence[] = [];
  const intentEvidence: IntentEvidence[] = [];
  const safeTransitions: JsonValue[] = [];
  const grantedIterations =
    iterationCeiling === null ? 0 : Math.min(iterationCeiling, MAX_SESSION_ITERATIONS);
  let activeVerification: VerificationTransitionEvidence | null = null;
  let activeCheckpointSha256: string | null = null;
  let activeIntentSequence: number | null = null;
  let activeIntentKind: "edit" | "patch" | null = null;
  let activeIntentPaths: readonly string[] | null = null;
  let activeOperation: OperationStartEvidence | null = null;
  let activeOperationEditIntents = 0;
  let activeOperationPatchIntents = 0;
  let activeOperationCheckpoints = 0;
  let repairSessionOpen = false;
  let repairEpochSuccessfulRevisions = 0;
  let repairEpochReplacementIntents = 0;
  let pendingPatchReplacement = false;
  let emergencyAttemptCount = 0;
  let sessionIterationCount = 0;
  let latestIterationBoundary = 0;
  let replayedState: RunState | null = null;
  let runCreatedTarget: string | null = null;
  let contextAssembledDigest: string | null = null;
  let planCreatedSequence: number | null = null;
  let planCreatedDigest: string | null = null;
  let planCreatedReadableFiles: number | null = null;
  let verificationRequestSequence: number | null = null;

  const replayTransition = (from: RunState, to: RunState): void => {
    if (replayedState !== from) sourceInvalid();
    replayedState = to;
  };

  entries.forEach((entry, index) => {
    const object = row(entry);
    const sequence = safeInteger(object.sequence, 1);
    const type = text(object.type, 128);
    const createdAt = text(object.created_at, 64);
    if (
      sequence !== index + 1 ||
      !KNOWN_HANDOFF_EVENT_TYPES.has(type) ||
      !EVENT_TIMESTAMP_PATTERN.test(createdAt)
    ) {
      sourceInvalid();
    }
    const existing = counts.get(type);
    counts.set(type, {
      count: (existing?.count ?? 0) + 1,
      last: sequence,
      sequences: [...(existing?.sequences ?? []), sequence],
    });

    if (activeOperation !== null && !ACTIVE_OPERATION_EVENT_TYPES.has(type)) {
      sourceInvalid();
    }
    if (
      activeOperation !== null &&
      (type === "edit.intent_recorded" || type === "patch_set.intent_recorded") &&
      activeOperation.kind !== "session.tool.mutation.patchset"
    ) {
      sourceInvalid();
    }
    if (activeOperation !== null) {
      if (type === "edit.intent_recorded") activeOperationEditIntents += 1;
      if (type === "patch_set.intent_recorded") activeOperationPatchIntents += 1;
      if (type === "checkpoint.saved") activeOperationCheckpoints += 1;
    }
    if (pendingPatchReplacement && type !== "patch_set.intent_recorded") {
      sourceInvalid();
    }

    if (type === "browser.action.admitted") {
      const payload = exactRecord(boundedJson(object.bounded_payload, 65_536), [
        "browserActionId",
        "kind",
        "actionDigest",
      ]);
      const browserActionId = text(payload.browserActionId, 64);
      const kind = text(payload.kind, 32);
      const actionDigest = digest(payload.actionDigest);
      if (
        !UUID_PATTERN.test(browserActionId) ||
        !BROWSER_ACTION_KINDS.has(kind) ||
        admittedBrowserActions.has(browserActionId)
      ) {
        sourceInvalid();
      }
      admittedBrowserActions.set(browserActionId, { kind, actionDigest });
      return;
    }

    if (type === "operation.started") {
      const unshaped = row(boundedJson(object.bounded_payload, 65_536));
      const emergency =
        Object.hasOwn(unshaped, "budgetClass") || Object.hasOwn(unshaped, "attempt");
      const payload = actionLinkedRecord(
        unshaped,
        emergency
          ? [
              "operationId",
              "kind",
              "reservedCostUsd",
              "reservedTokens",
              "reservedRuntimeMs",
              "budgetClass",
              "attempt",
            ]
          : ["operationId", "kind", "reservedCostUsd", "reservedTokens", "reservedRuntimeMs"],
        admittedBrowserActions,
      );
      const operationId = text(payload.operationId, 64);
      const kind = operationKind(payload.kind);
      const reservedCostUsd = finiteNumber(payload.reservedCostUsd);
      const reservedTokens = safeInteger(payload.reservedTokens);
      const reservedRuntimeMs = safeInteger(payload.reservedRuntimeMs, 1);
      const attempt = emergency ? safeInteger(payload.attempt, 1) : null;
      if (
        !UUID_PATTERN.test(operationId) ||
        operationIds.has(operationId) ||
        activeOperation !== null ||
        (emergency &&
          (payload.budgetClass !== "emergency" ||
            attempt !== emergencyAttemptCount + 1 ||
            attempt > MAX_CANCELLATION_RECOVERY_ATTEMPTS ||
            kind !== CANCELLATION_RECOVERY_OPERATION_KIND ||
            reservedCostUsd !== 0 ||
            reservedTokens !== 0 ||
            reservedRuntimeMs !== CANCELLATION_RECOVERY_RUNTIME_MS ||
            replayedState !== "cancelling")) ||
        (!emergency && kind === CANCELLATION_RECOVERY_OPERATION_KIND) ||
        (REPAIR_SESSION_OPERATION_KINDS.has(kind) &&
          (!repairSessionOpen || replayedState !== "running"))
      ) {
        sourceInvalid();
      }
      if (emergency) emergencyAttemptCount += 1;
      const started: OperationStartEvidence = {
        sequence,
        operationId,
        kind,
        reservedCostUsd,
        reservedTokens,
        reservedRuntimeMs,
        budgetClass: emergency ? "emergency" : "ordinary",
        attempt,
      };
      operationIds.add(operationId);
      operationStarts.push(started);
      activeOperation = started;
      activeOperationEditIntents = 0;
      activeOperationPatchIntents = 0;
      activeOperationCheckpoints = 0;
      if (kind === SESSION_ITERATION_OPERATION_KIND) {
        sessionIterationCount += 1;
        if (iterationCeiling === null || sessionIterationCount > grantedIterations) {
          sourceInvalid();
        }
      }
      safeTransitions.push(
        asJsonValue({
          type,
          sequence,
          operationId,
          kind,
          reservedCostUsd,
          reservedTokens,
          reservedRuntimeMs,
          budgetClass: started.budgetClass,
          attempt,
        }),
      );
      return;
    }

    if (type === "operation.finished") {
      const terminal = readOperationFinishEvidence(database, runId, sequence);
      if (
        activeOperation === null ||
        terminalOperationIds.has(terminal.operationId) ||
        terminal.operationId !== activeOperation.operationId ||
        terminal.kind !== activeOperation.kind
      ) {
        sourceInvalid();
      }
      terminalOperationIds.add(terminal.operationId);
      operationTerminals.push({
        sequence,
        operationId: terminal.operationId,
        kind: terminal.kind,
        status: terminal.outcome,
        detailTool: terminal.detailTool,
        editIntentCount: activeOperationEditIntents,
        patchIntentCount: activeOperationPatchIntents,
        checkpointCount: activeOperationCheckpoints,
      });
      if (terminal.kind === SESSION_ITERATION_OPERATION_KIND && terminal.outcome === "succeeded") {
        if (!repairSessionOpen) sourceInvalid();
        repairEpochSuccessfulRevisions += 1;
      }
      activeOperation = null;
      activeOperationEditIntents = 0;
      activeOperationPatchIntents = 0;
      activeOperationCheckpoints = 0;
      safeTransitions.push(
        asJsonValue({
          type,
          sequence,
          operationId: terminal.operationId,
          kind: terminal.kind,
          outcome: terminal.outcome,
        }),
      );
      return;
    }

    if (type === "operation.interrupted") {
      const unshaped = row(boundedJson(object.bounded_payload, 65_536));
      const kindPresent = Object.hasOwn(unshaped, "kind");
      const emergency = Object.hasOwn(unshaped, "budgetClass");
      const payload = actionLinkedRecord(
        unshaped,
        [
          "operationId",
          ...(kindPresent ? ["kind"] : []),
          "reservedCostUsd",
          "reservedTokens",
          "reservedRuntimeMs",
          ...(emergency ? ["budgetClass"] : []),
        ],
        admittedBrowserActions,
      );
      const operationId = text(payload.operationId, 64);
      const kind =
        activeOperation === null
          ? ""
          : kindPresent
            ? operationKind(payload.kind)
            : activeOperation.kind;
      const reservedCostUsd = finiteNumber(payload.reservedCostUsd);
      const reservedTokens = safeInteger(payload.reservedTokens);
      const reservedRuntimeMs = safeInteger(payload.reservedRuntimeMs, 1);
      if (
        !UUID_PATTERN.test(operationId) ||
        activeOperation === null ||
        terminalOperationIds.has(operationId) ||
        operationId !== activeOperation.operationId ||
        kind !== activeOperation.kind ||
        reservedCostUsd !== activeOperation.reservedCostUsd ||
        reservedTokens !== activeOperation.reservedTokens ||
        reservedRuntimeMs !== activeOperation.reservedRuntimeMs ||
        (!kindPresent && activeOperation.budgetClass !== "ordinary") ||
        (emergency
          ? payload.budgetClass !== "emergency" ||
            activeOperation.budgetClass !== "emergency" ||
            kind !== CANCELLATION_RECOVERY_OPERATION_KIND
          : kindPresent && activeOperation.budgetClass !== "ordinary")
      ) {
        sourceInvalid();
      }
      terminalOperationIds.add(operationId);
      operationTerminals.push({
        sequence,
        operationId,
        kind,
        status: "interrupted",
        detailTool: null,
        editIntentCount: activeOperationEditIntents,
        patchIntentCount: activeOperationPatchIntents,
        checkpointCount: activeOperationCheckpoints,
      });
      activeOperation = null;
      activeOperationEditIntents = 0;
      activeOperationPatchIntents = 0;
      activeOperationCheckpoints = 0;
      safeTransitions.push(
        asJsonValue({ type, sequence, operationId, kind, status: "interrupted" }),
      );
      return;
    }

    if (type === "checkpoint.saved") {
      const payload = exactRecord(boundedJson(object.bounded_payload, 65_536), [
        "checkpointSha256",
      ]);
      if (
        activeCheckpointSha256 !== null ||
        activeIntentSequence === null ||
        (repairSessionOpen &&
          activeOperation?.kind !== SESSION_PATCH_OPERATION_KIND &&
          activeOperation?.kind !== SESSION_RECONCILE_OPERATION_KIND)
      ) {
        sourceInvalid();
      }
      activeCheckpointSha256 = digest(payload.checkpointSha256);
      activeVerification = null;
      safeTransitions.push(
        asJsonValue({ type, sequence, checkpointSha256: activeCheckpointSha256 }),
      );
      return;
    }

    if (type === "context.assembled") {
      const payload = exactRecord(boundedJson(object.bounded_payload, 65_536), [
        "from",
        "to",
        "contextSha256",
      ]);
      const from = text(payload.from, 32);
      const to = text(payload.to, 32);
      const contextSha256 = digest(payload.contextSha256);
      if (
        from !== "preparing" ||
        (to !== "planned" && to !== "awaiting_egress_approval") ||
        contextAssembledDigest !== null
      ) {
        sourceInvalid();
      }
      replayTransition(from, to);
      contextAssembledDigest = contextSha256;
      safeTransitions.push(asJsonValue({ type, sequence, from, to, contextSha256 }));
      return;
    }

    if (type === "edit.intent_recorded") {
      const payload = exactRecord(boundedJson(object.bounded_payload, 65_536), [
        "path",
        "expectedPreimageSha256",
      ]);
      const editPath = nonemptyText(payload.path, 1_024);
      try {
        assertRepositoryRelativePath(editPath);
      } catch {
        sourceInvalid();
      }
      if (replayedState !== "running" || activeIntentKind !== null) {
        sourceInvalid();
      }
      intentEvidence.push({
        type,
        sequence,
        path: editPath,
        expectedPreimageSha256: digest(payload.expectedPreimageSha256),
      });
      activeIntentSequence = sequence;
      activeIntentKind = "edit";
      activeIntentPaths = [editPath];
      activeCheckpointSha256 = null;
      activeVerification = null;
      safeTransitions.push(asJsonValue({ type, sequence }));
      return;
    }

    if (type === "patch_set.superseded") {
      const payload = exactRecord(boundedJson(object.bounded_payload, 65_536), ["digest", "paths"]);
      digest(payload.digest);
      const paths = stringArray(payload.paths, MAX_CHECKPOINT_FILES, 1_024, true);
      if (
        paths.length === 0 ||
        activeIntentKind !== "patch" ||
        activeIntentPaths === null ||
        !sameStringArray(paths, activeIntentPaths) ||
        replayedState !== "running" ||
        !repairSessionOpen ||
        repairEpochSuccessfulRevisions <= repairEpochReplacementIntents
      ) {
        sourceInvalid();
      }
      pendingPatchReplacement = true;
      activeCheckpointSha256 = null;
      activeVerification = null;
      safeTransitions.push(asJsonValue({ type, sequence }));
      return;
    }

    if (type === "patch_set.intent_recorded") {
      const payload = exactRecord(boundedJson(object.bounded_payload, 65_536), [
        "paths",
        "operations",
      ]);
      const paths = stringArray(payload.paths, MAX_CHECKPOINT_FILES, 1_024, true);
      const operations = jsonArray(payload.operations, MAX_CHECKPOINT_FILES).map((value) => {
        const operation = text(value, 16);
        if (operation !== "modify" && operation !== "create" && operation !== "delete") {
          sourceInvalid();
        }
        return operation;
      });
      if (
        paths.length === 0 ||
        paths.length !== operations.length ||
        [...paths].sort().some((value, position) => value !== paths[position]) ||
        replayedState !== "running" ||
        (activeIntentKind === "patch" && !pendingPatchReplacement) ||
        (activeIntentKind !== "patch" && pendingPatchReplacement) ||
        (activeIntentKind !== null && activeOperation?.kind !== SESSION_PATCH_OPERATION_KIND) ||
        (activeIntentKind !== null &&
          (!repairSessionOpen || repairEpochSuccessfulRevisions <= repairEpochReplacementIntents))
      ) {
        sourceInvalid();
      }
      if (activeIntentKind !== null) repairEpochReplacementIntents += 1;
      pendingPatchReplacement = false;
      intentEvidence.push({ type, sequence, paths, operations });
      activeIntentSequence = sequence;
      activeIntentKind = "patch";
      activeIntentPaths = paths;
      activeCheckpointSha256 = null;
      activeVerification = null;
      safeTransitions.push(asJsonValue({ type, sequence }));
      return;
    }

    if (
      type === "edit.materialized" ||
      type === "execution.completed" ||
      type === "session.verification_requested"
    ) {
      const payload = exactRecord(boundedJson(object.bounded_payload, 65_536), [
        "from",
        "to",
        "detail",
      ]);
      const from = text(payload.from, 32);
      const to = text(payload.to, 32);
      row(payload.detail);
      if (from !== "running" || to !== "verifying" || activeOperation !== null) sourceInvalid();
      replayTransition(from, to);
      activeVerification = null;
      repairSessionOpen = false;
      verificationRequestSequence = sequence;
      safeTransitions.push(asJsonValue({ type, sequence, from, to }));
      return;
    }

    if (
      type === "egress.approved" ||
      type === "plan.approved" ||
      type === "review.accepted" ||
      type === "review.rejected" ||
      type === "rollback.approved" ||
      type === "restore.approved"
    ) {
      const payload = actionLinkedRecord(
        boundedJson(object.bounded_payload, 65_536),
        ["from", "to", "kind", "digest", "actor", "decision"],
        admittedBrowserActions,
      );
      const from = text(payload.from, 32);
      const to = text(payload.to, 32);
      const kind = text(payload.kind, 16);
      const decision = text(payload.decision, 16);
      if (
        !RUN_STATES.has(from as RunState) ||
        !RUN_STATES.has(to as RunState) ||
        !APPROVAL_KINDS.has(kind as ApprovalRecord["kind"]) ||
        (decision !== "approve" && decision !== "reject")
      ) {
        sourceInvalid();
      }
      if (type === "review.accepted") {
        const disposition = sessionDispositions.at(-1) ?? null;
        if (
          (disposition === null && sessionIterationCount !== 0) ||
          (disposition !== null &&
            (disposition.type !== "session.completed" ||
              disposition.iterations <= 0 ||
              disposition.iterations !== sessionIterationCount ||
              disposition.operationId === null ||
              disposition.revisionSequence === null ||
              disposition.revisionSequence !== activeIntentSequence ||
              disposition.diffSha256 === null ||
              disposition.checkpointSha256 === null ||
              activeVerification === null ||
              disposition.diffSha256 !== activeVerification.diffSha256 ||
              disposition.checkpointSha256 !== activeVerification.checkpointSha256 ||
              disposition.sequence >= sequence))
        ) {
          sourceInvalid();
        }
      }
      const transition: ApprovalTransitionEvidence = {
        type,
        sequence,
        from: from as RunState,
        to: to as RunState,
        kind: kind as ApprovalRecord["kind"],
        digest: digest(payload.digest),
        actor: nonemptyText(payload.actor, 200),
        decision,
        createdAt,
      };
      replayTransition(transition.from, transition.to);
      if (
        type === "review.accepted" ||
        type === "review.rejected" ||
        type === "rollback.approved" ||
        type === "restore.approved"
      ) {
        repairSessionOpen = false;
      }
      approvalTransitions.push(transition);
      safeTransitions.push(
        asJsonValue({
          type,
          sequence,
          from: transition.from,
          to: transition.to,
          kind: transition.kind,
          digest: transition.digest,
          decision: transition.decision,
        }),
      );
      return;
    }

    if (type === "plan.created") {
      const payload = actionLinkedRecord(
        boundedJson(object.bounded_payload, 65_536),
        ["from", "to", "planSha256", "readableFiles"],
        admittedBrowserActions,
      );
      const from = text(payload.from, 32);
      const to = text(payload.to, 32);
      const planDigest = digest(payload.planSha256);
      const readableFiles = safeInteger(payload.readableFiles);
      if (
        from !== "planned" ||
        to !== "awaiting_approval" ||
        readableFiles > MAX_READABLE_FILES ||
        planCreatedSequence !== null
      ) {
        sourceInvalid();
      }
      replayTransition(from, to);
      planCreatedSequence = sequence;
      planCreatedDigest = planDigest;
      planCreatedReadableFiles = readableFiles;
      safeTransitions.push(
        asJsonValue({ type, sequence, from, to, planSha256: planDigest, readableFiles }),
      );
      return;
    }

    if (type === "run.created") {
      const payload = exactRecord(boundedJson(object.bounded_payload, 65_536), ["state", "target"]);
      const createdState = text(payload.state, 16);
      if (createdState !== "preparing" || runCreatedTarget !== null) sourceInvalid();
      if (replayedState !== null) sourceInvalid();
      replayedState = "preparing";
      runCreatedTarget = nonemptyText(payload.target, 1_024);
      safeTransitions.push(asJsonValue({ type, sequence, state: "preparing" }));
      return;
    }

    if (
      type === "rollback.completed" ||
      type === "restore.completed" ||
      type === "cancellation.completed"
    ) {
      const payload = actionLinkedRecord(
        boundedJson(object.bounded_payload, 65_536),
        ["from", "to"],
        admittedBrowserActions,
      );
      const from = text(payload.from, 32);
      const to = text(payload.to, 32);
      const expected =
        type === "rollback.completed"
          ? ["rolling_back", "rolled_back"]
          : type === "restore.completed"
            ? ["restoring", "verifying"]
            : ["cancelling", "cancelled"];
      if (from !== expected[0] || to !== expected[1]) sourceInvalid();
      replayTransition(from as RunState, to as RunState);
      if (type === "restore.completed") activeVerification = null;
      repairSessionOpen = false;
      safeTransitions.push(asJsonValue({ type, sequence, from, to }));
      return;
    }

    if (type === "repair.requested") {
      const payload = exactRecord(boundedJson(object.bounded_payload, 65_536), [
        "from",
        "to",
        "remaining",
      ]);
      const from = text(payload.from, 32);
      const to = text(payload.to, 32);
      const remaining = safeInteger(payload.remaining, 1);
      if (
        from !== "verifying" ||
        to !== "running" ||
        activeVerification === null ||
        activeVerification.to !== "verifying" ||
        activeVerification.outcome !== "failed" ||
        repairSessionOpen ||
        activeOperation !== null ||
        remaining !== grantedIterations - sessionIterationCount ||
        remaining <= 0
      ) {
        sourceInvalid();
      }
      replayTransition(from, to);
      repairSessionOpen = true;
      repairEpochSuccessfulRevisions = 0;
      repairEpochReplacementIntents = 0;
      safeTransitions.push(
        asJsonValue({
          type,
          sequence,
          from,
          to,
          remaining,
          verificationSequence: activeVerification.sequence,
        }),
      );
      return;
    }

    if (type === "session.iteration_completed") {
      const payload = exactRecord(boundedJson(object.bounded_payload, 65_536), ["iterations"]);
      const iterations = safeInteger(payload.iterations, 1);
      const iterationStart = operationStarts.filter(
        (operation) => operation.kind === SESSION_ITERATION_OPERATION_KIND,
      )[iterations - 1];
      const iterationTerminal =
        iterationStart === undefined
          ? undefined
          : operationTerminals.find(
              (terminal) => terminal.operationId === iterationStart.operationId,
            );
      if (
        iterations !== sessionIterationCount ||
        iterations <= latestIterationBoundary ||
        iterationStart === undefined ||
        iterationTerminal === undefined ||
        iterationTerminal.status !== "succeeded" ||
        iterationTerminal.sequence >= sequence ||
        activeOperation !== null ||
        (replayedState !== "running" && replayedState !== "awaiting_review")
      ) {
        sourceInvalid();
      }
      latestIterationBoundary = iterations;
      safeTransitions.push(asJsonValue({ type, sequence, iterations }));
      return;
    }

    if (
      type === "session.completed" ||
      type === "session.awaiting_human" ||
      type === "session.exhausted"
    ) {
      const unshaped = row(boundedJson(object.bounded_payload, 65_536));
      const operationIdPresent = Object.hasOwn(unshaped, "operationId");
      const admissionExhausted = type === "session.exhausted" && Object.hasOwn(unshaped, "reason");
      const fromPresent = Object.hasOwn(unshaped, "from");
      const toPresent = Object.hasOwn(unshaped, "to");
      const actionIdPresent = Object.hasOwn(unshaped, "browserActionId");
      if (fromPresent !== toPresent || fromPresent !== actionIdPresent) sourceInvalid();
      const expectedKeys = admissionExhausted
        ? [...(fromPresent ? ["from", "to"] : []), "iterations", "reason"]
        : [
            ...(fromPresent ? ["from", "to"] : []),
            "iterations",
            ...(operationIdPresent ? ["operationId"] : []),
            ...(type === "session.completed"
              ? ["summary"]
              : type === "session.awaiting_human"
                ? ["question"]
                : []),
          ];
      const payload = actionLinkedRecord(unshaped, expectedKeys, admittedBrowserActions);
      const iterations = safeInteger(payload.iterations);
      const operationId = operationIdPresent ? text(payload.operationId, 64) : null;
      if (
        iterations !== sessionIterationCount ||
        (operationId !== null && !UUID_PATTERN.test(operationId)) ||
        (type === "session.exhausted" && operationId !== null) ||
        (type === "session.completed" && operationId === null) ||
        (!admissionExhausted &&
          ((type !== "session.exhausted" && iterations <= 0) || !repairSessionOpen))
      ) {
        sourceInvalid();
      }
      if (admissionExhausted) {
        if (
          payload.reason !== "recovery_margin" ||
          activeVerification === null ||
          activeVerification.to !== "verifying" ||
          activeVerification.outcome !== "failed" ||
          activeCheckpointSha256 === null ||
          activeVerification.checkpointSha256 !== activeCheckpointSha256 ||
          grantedIterations - sessionIterationCount <= 0
        ) {
          sourceInvalid();
        }
      } else if (type === "session.completed" || type === "session.awaiting_human") {
        const sessionText = nonemptyText(
          type === "session.completed" ? payload.summary : payload.question,
          2_000,
        );
        if (sessionText.trim().length === 0 || /[\r\0]/.test(sessionText)) sourceInvalid();
      }
      if (
        type === "session.completed" &&
        (activeVerification === null ||
          activeVerification.from !== "running" ||
          activeVerification.to !== "running" ||
          activeVerification.outcome !== "passed" ||
          activeCheckpointSha256 === null ||
          activeVerification.checkpointSha256 !== activeCheckpointSha256)
      ) {
        sourceInvalid();
      }
      if (operationId !== null) {
        const controlStart = operationStarts.find(
          (operation) => operation.operationId === operationId,
        );
        if (
          controlStart === undefined ||
          (type === "session.completed" &&
            (activeVerification === null || controlStart.sequence <= activeVerification.sequence))
        ) {
          sourceInvalid();
        }
        assertAtomicSessionControlEvidence(
          database,
          runId,
          sequence,
          operationId,
          type === "session.completed"
            ? "session.control.report_done"
            : "session.control.request_human_input",
        );
      }
      const from: RunState = admissionExhausted ? "verifying" : "running";
      if (
        fromPresent &&
        (text(payload.from, 32) !== from || text(payload.to, 32) !== "awaiting_review")
      ) {
        sourceInvalid();
      }
      const revisionSequence = type === "session.completed" ? activeIntentSequence : null;
      const diffSha256 =
        type === "session.completed" ? (activeVerification?.diffSha256 ?? null) : null;
      const dispositionCheckpointSha256 =
        type === "session.completed" ? (activeVerification?.checkpointSha256 ?? null) : null;
      replayTransition(from, "awaiting_review");
      repairSessionOpen = false;
      sessionDispositions.push({
        type,
        sequence,
        iterations,
        operationId,
        revisionSequence,
        diffSha256,
        checkpointSha256: dispositionCheckpointSha256,
      });
      safeTransitions.push(
        asJsonValue({
          type,
          sequence,
          from,
          to: "awaiting_review",
          iterations,
          operationBound: operationId !== null,
          revisionSequence,
          diffSha256,
          checkpointSha256: dispositionCheckpointSha256,
        }),
      );
      return;
    }

    if (type === "cancellation.requested") {
      const payload = actionLinkedRecord(
        boundedJson(object.bounded_payload, 65_536),
        ["from", "to", "detail"],
        admittedBrowserActions,
      );
      const from = text(payload.from, 32);
      const to = text(payload.to, 32);
      const allowedFrom = new Set([
        "preparing",
        "planned",
        "awaiting_egress_approval",
        "awaiting_approval",
        "running",
        "verifying",
        "awaiting_review",
        "failed",
      ]);
      const detail = exactRecord(payload.detail, ["actor"]);
      if (!allowedFrom.has(from) || to !== "cancelling") sourceInvalid();
      nonemptyText(detail.actor, 200);
      const transition: CancellationTransitionEvidence = {
        sequence,
        from: from as RunState,
        to,
      };
      replayTransition(transition.from, transition.to);
      repairSessionOpen = false;
      cancellationRequests.push(transition);
      safeTransitions.push(asJsonValue({ type, sequence, from, to }));
      return;
    }

    if (type === "run.failed") {
      const payload = actionLinkedRecord(
        boundedJson(object.bounded_payload, 65_536),
        ["from", "to", "resumeState", "code", "message"],
        admittedBrowserActions,
      );
      const from = text(payload.from, 32);
      const to = text(payload.to, 32);
      const resumeState = text(payload.resumeState, 32);
      const code = text(payload.code, 64);
      text(payload.message, 32 * 1024);
      if (
        !RUN_STATES.has(from as RunState) ||
        to !== "failed" ||
        !RESUME_STATES.has(resumeState as RunState) ||
        (from !== "failed" && from !== resumeState) ||
        !ERROR_CODE_PATTERN.test(code)
      ) {
        sourceInvalid();
      }
      replayTransition(from as RunState, "failed");
      failureTransitions.push({
        sequence,
        from: from as RunState,
        resumeState: resumeState as RunState,
        code,
      });
      safeTransitions.push(asJsonValue({ type, sequence, from, to, resumeState, code }));
      return;
    }

    if (type === "run.resumed") {
      const payload = actionLinkedRecord(
        boundedJson(object.bounded_payload, 65_536),
        ["from", "to"],
        admittedBrowserActions,
      );
      const from = text(payload.from, 32);
      const to = text(payload.to, 32);
      if (from !== "failed" || !RESUME_STATES.has(to as RunState) || activeOperation !== null) {
        sourceInvalid();
      }
      replayTransition(from, to as RunState);
      const transition: ResumeTransitionEvidence = { sequence, to: to as RunState };
      resumeTransitions.push(transition);
      safeTransitions.push(asJsonValue({ type, ...transition, from }));
      return;
    }

    if (type === "verification.completed") {
      const transition = readVerificationTransition(
        database,
        runId,
        sequence,
        admittedBrowserActions,
      );
      const predecessor = operationTerminals.at(-1);
      if (
        activeCheckpointSha256 === null ||
        transition.checkpointSha256 !== activeCheckpointSha256 ||
        (transition.from === "running" &&
          (predecessor === undefined ||
            predecessor.sequence !== sequence - 1 ||
            !terminalCanProduceVerification(predecessor, transition.outcome)))
      ) {
        sourceInvalid();
      }
      replayTransition(transition.from, transition.to);
      activeVerification = transition;
      verificationTransitions.push(transition);
      safeTransitions.push(
        asJsonValue({
          type,
          sequence: transition.sequence,
          from: transition.from,
          to: transition.to,
          outcome: transition.outcome,
          diffSha256: transition.diffSha256,
          checkpointSha256: transition.checkpointSha256,
        }),
      );
      return;
    }
  });

  if (pendingPatchReplacement) sourceInvalid();

  for (const terminal of operationTerminals) {
    if (
      terminal.kind === SESSION_PATCH_OPERATION_KIND &&
      terminal.status !== "succeeded" &&
      terminal.status !== "interrupted"
    ) {
      const failedProposal = terminal.detailTool === "propose_patch" && hasNoPatchEffects(terminal);
      const partialFailedApply =
        terminal.detailTool === "apply_patchset" &&
        terminal.editIntentCount === 0 &&
        terminal.patchIntentCount <= 1 &&
        terminal.checkpointCount <= terminal.patchIntentCount;
      if (!failedProposal && !partialFailedApply) sourceInvalid();
    }
    let expectedSuccessor: string | undefined;
    if (terminal.status !== "succeeded") {
      expectedSuccessor = undefined;
    } else if (terminal.kind === "session.tool.mutation.patchset") {
      const advisoryProposal = isAdvisoryPatchTerminal(terminal);
      const appliedPatch = isAppliedPatchTerminal(terminal);
      if (!advisoryProposal && !appliedPatch) sourceInvalid();
      expectedSuccessor = appliedPatch ? "verification.completed" : undefined;
    } else {
      expectedSuccessor = ATOMIC_OPERATION_SUCCESSORS.get(terminal.kind);
    }
    if (expectedSuccessor !== undefined) {
      const successor = entries[terminal.sequence];
      if (successor === undefined || text(row(successor).type, 128) !== expectedSuccessor) {
        sourceInvalid();
      }
    }
  }

  const summary = (type: string): { readonly count: number; readonly sequence: number | null } => {
    const value = counts.get(type);
    return { count: value?.count ?? 0, sequence: value?.last ?? null };
  };
  const sequences = (type: string): readonly number[] => counts.get(type)?.sequences ?? [];
  const sequenceSummary = (
    values: readonly number[],
  ): { readonly count: number; readonly sequence: number | null } => ({
    count: values.length,
    sequence: values.at(-1) ?? null,
  });
  const allRollbackCompletions = sequences("rollback.completed");
  const allRestoreCompletions = sequences("restore.completed");
  const cancellation = summary("cancellation.completed");
  const cancellationRequestSequences = sequences("cancellation.requested");
  const reviewAccepted = summary("review.accepted");
  const reviewRejected = summary("review.rejected");
  const runCreated = summary("run.created");
  if (
    runCreated.count !== 1 ||
    runCreated.sequence !== 1 ||
    runCreatedTarget === null ||
    cancellation.count > 1 ||
    (cancellation.count === 1 &&
      (cancellationRequestSequences.length === 0 ||
        (cancellation.sequence ?? 0) <= (cancellationRequestSequences.at(-1) ?? 0)))
  ) {
    sourceInvalid();
  }
  let previousResumeSequence = 0;
  for (const transition of resumeTransitions) {
    const failure = failureTransitions
      .filter(
        (candidate) =>
          candidate.sequence > previousResumeSequence && candidate.sequence < transition.sequence,
      )
      .at(-1);
    if (failure === undefined || failure.resumeState !== transition.to) sourceInvalid();
    previousResumeSequence = transition.sequence;
  }
  const intentSequences = intentEvidence.map((intent) => intent.sequence);
  const latestIntentSequence = intentSequences.length === 0 ? null : Math.max(...intentSequences);
  const revisionStart = latestIntentSequence ?? 0;
  const rollback = sequenceSummary(
    allRollbackCompletions.filter((sequence) => sequence > revisionStart),
  );
  const restoration = sequenceSummary(
    allRestoreCompletions.filter((sequence) => sequence > revisionStart),
  );
  if (replayedState === null) sourceInvalid();
  return {
    snapshot: {
      count: entries.length,
      highWater: entries.length,
      rollbackCompletedCount: rollback.count,
      rollbackCompletedSequence: rollback.sequence,
      restoreCompletedCount: restoration.count,
      restoreCompletedSequence: restoration.sequence,
      cancellationCompletedCount: cancellation.count,
      cancellationCompletedSequence: cancellation.sequence,
      reviewAcceptedCount: reviewAccepted.count,
      reviewAcceptedSequence: reviewAccepted.sequence,
      reviewRejectedCount: reviewRejected.count,
      reviewRejectedSequence: reviewRejected.sequence,
      transitionEvidenceSha256: digestJson(asJsonValue(safeTransitions)),
    },
    approvalTransitions,
    verificationTransitions,
    resumeTransitions,
    failureTransitions,
    cancellationRequests,
    intentEvidence,
    operationStarts,
    operationTerminals,
    rollbackCompletionSequences: allRollbackCompletions,
    restoreCompletionSequences: allRestoreCompletions,
    planCreatedSequence,
    planCreatedDigest,
    planCreatedReadableFiles,
    latestIntentSequence,
    contextAssembledDigest,
    runCreatedTarget,
    replayedState,
    verificationRequestSequence,
    activeCheckpointSha256,
  };
}

function readOpenDatabase(database: Database.Database, runId: string): ChangeHandoffSourceSnapshot {
  const schemaVersion = row(database.prepare("PRAGMA user_version").get()).user_version;
  if (safeInteger(schemaVersion) !== 1) sourceInvalid("Icarus database schema is unsupported");
  const requiredTables = [
    "runs",
    "projects",
    "approvals",
    "operations",
    "run_events",
    "checkpoints",
    "patch_sets",
    "checkpoint_files",
    "readable_manifests",
  ];
  const present = new Set(
    (
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (" +
            requiredTables.map(() => "?").join(",") +
            ")",
        )
        .all(...requiredTables) as unknown[]
    ).map((entry) => text(row(entry).name, 64)),
  );
  if (requiredTables.some((table) => !present.has(table))) {
    sourceInvalid("Icarus database is missing required handoff evidence tables");
  }

  const raw = database
    .prepare(
      "SELECT " +
        "CASE WHEN typeof(r.id)='text' AND octet_length(r.id)<=64 THEN r.id END AS run_id, " +
        "CASE WHEN typeof(r.project_id)='text' AND octet_length(r.project_id)<=64 THEN r.project_id END AS project_id, " +
        "CASE WHEN typeof(r.state)='text' AND octet_length(r.state)<=32 THEN r.state END AS state, " +
        "CASE WHEN r.resume_state IS NULL OR (typeof(r.resume_state)='text' AND octet_length(r.resume_state)<=32) THEN r.resume_state END AS resume_state, " +
        "CASE WHEN typeof(r.version)='integer' THEN r.version END AS run_version, " +
        "CASE WHEN typeof(r.provider_json)='text' AND octet_length(r.provider_json)<=" +
        String(MAX_PROVIDER_JSON_BYTES) +
        " AND json_valid(r.provider_json,1) THEN r.provider_json END AS provider_json, " +
        "CASE WHEN typeof(r.task)='text' AND octet_length(r.task)<=8192 THEN r.task END AS task, " +
        "CASE WHEN typeof(r.target)='text' AND octet_length(r.target)<=1024 THEN r.target END AS target, " +
        "CASE WHEN typeof(r.base_commit)='text' AND octet_length(r.base_commit)<=64 THEN r.base_commit END AS base_commit, " +
        "CASE WHEN typeof(r.context_json)='text' AND octet_length(r.context_json)<=" +
        String(MAX_CONTEXT_JSON_BYTES) +
        " AND json_valid(r.context_json,1) THEN r.context_json END AS context_json, " +
        "CASE WHEN typeof(r.context_sha256)='text' AND octet_length(r.context_sha256)<=64 THEN r.context_sha256 END AS context_sha256, " +
        "CASE WHEN r.plan_json IS NULL OR (typeof(r.plan_json)='text' AND octet_length(r.plan_json)<=" +
        String(MAX_PLAN_JSON_BYTES) +
        " AND json_valid(r.plan_json,1)) THEN r.plan_json END AS plan_json, " +
        "CASE WHEN r.plan_sha256 IS NULL OR (typeof(r.plan_sha256)='text' AND octet_length(r.plan_sha256)<=64) THEN r.plan_sha256 END AS plan_sha256, " +
        "CASE WHEN r.edit_json IS NULL OR (typeof(r.edit_json)='text' AND octet_length(r.edit_json)<=" +
        String(MAX_PATCH_JSON_BYTES) +
        " AND json_valid(r.edit_json,1)) THEN r.edit_json END AS edit_json, " +
        "CASE WHEN r.baseline_base64 IS NULL OR (typeof(r.baseline_base64)='text' AND octet_length(r.baseline_base64)<=" +
        String(MAX_CHECKPOINT_ENCODED_BYTES) +
        ") THEN r.baseline_base64 END AS baseline_base64, " +
        "CASE WHEN r.approved_base64 IS NULL OR (typeof(r.approved_base64)='text' AND octet_length(r.approved_base64)<=" +
        String(MAX_CHECKPOINT_ENCODED_BYTES) +
        ") THEN r.approved_base64 END AS approved_base64, " +
        "CASE WHEN r.diff IS NULL OR (typeof(r.diff)='text' AND octet_length(r.diff)<=" +
        String(MAX_DIFF_BYTES) +
        ") THEN r.diff END AS diff, " +
        "CASE WHEN r.verification_json IS NULL OR (typeof(r.verification_json)='text' AND octet_length(r.verification_json)<=" +
        String(MAX_VERIFICATION_JSON_BYTES) +
        " AND json_valid(r.verification_json,1)) THEN r.verification_json END AS verification_json, " +
        "CASE WHEN typeof(r.tool_calls)='integer' THEN r.tool_calls END AS tool_calls, " +
        "CASE WHEN typeof(r.input_tokens)='integer' THEN r.input_tokens END AS input_tokens, " +
        "CASE WHEN typeof(r.output_tokens)='integer' THEN r.output_tokens END AS output_tokens, " +
        "CASE WHEN typeof(r.active_runtime_ms)='integer' THEN r.active_runtime_ms END AS active_runtime_ms, " +
        "CASE WHEN typeof(r.estimated_cost_usd) IN ('integer','real') THEN r.estimated_cost_usd END AS estimated_cost_usd, " +
        "CASE WHEN typeof(r.reserved_cost_usd) IN ('integer','real') THEN r.reserved_cost_usd END AS reserved_cost_usd, " +
        "CASE WHEN r.error_code IS NULL OR (typeof(r.error_code)='text' AND octet_length(r.error_code)<=64) THEN r.error_code END AS error_code, " +
        "CASE WHEN typeof(p.checks_json)='text' AND octet_length(p.checks_json)<=" +
        String(MAX_PROJECT_JSON_BYTES) +
        " AND json_valid(p.checks_json,1) THEN p.checks_json END AS checks_json, " +
        "CASE WHEN typeof(p.sandbox_json)='text' AND octet_length(p.sandbox_json)<=" +
        String(MAX_PROJECT_JSON_BYTES) +
        " AND json_valid(p.sandbox_json,1) THEN p.sandbox_json END AS sandbox_json, " +
        "CASE WHEN typeof(p.ceiling_json)='text' AND octet_length(p.ceiling_json)<=" +
        String(MAX_PROJECT_JSON_BYTES) +
        " AND json_valid(p.ceiling_json,1) THEN p.ceiling_json END AS ceiling_json " +
        "FROM runs r JOIN projects p ON p.id=r.project_id WHERE r.id=?",
    )
    .get(runId);
  if (raw === undefined) {
    throw new IcarusError("RUN_NOT_FOUND", "Run does not exist", { runId });
  }
  const value = row(raw);
  const persistedRunId = text(value.run_id, 64);
  const projectId = text(value.project_id, 64);
  if (persistedRunId !== runId || !UUID_PATTERN.test(projectId)) sourceInvalid();
  const stateText = text(value.state, 32);
  if (!RUN_STATES.has(stateText as RunState)) sourceInvalid();
  const state = stateText as RunState;
  const resumeText = nullableText(value.resume_state, 32);
  const resumeState = resumeText as RunState | null;
  if (
    (state === "failed" && (resumeState === null || !RESUME_STATES.has(resumeState))) ||
    (state !== "failed" && resumeState !== null)
  ) {
    sourceInvalid();
  }
  const effectiveState = state === "failed" && resumeState !== null ? resumeState : state;
  const runVersion = safeInteger(value.run_version);
  const task = nonemptyText(value.task, 8_192);
  const target = nonemptyText(value.target, 1_024);
  try {
    assertRepositoryRelativePath(target);
  } catch {
    sourceInvalid();
  }
  const baseCommit = text(value.base_commit, 64);
  if (baseCommit.length > 0 && !COMMIT_PATTERN.test(baseCommit)) sourceInvalid();

  const provider = decodeProvider(boundedJson(value.provider_json, MAX_PROVIDER_JSON_BYTES));
  const checks = decodeChecks(boundedJson(value.checks_json, MAX_PROJECT_JSON_BYTES));
  const sandbox = decodeSandbox(boundedJson(value.sandbox_json, MAX_PROJECT_JSON_BYTES));
  const ceiling = decodeCeiling(boundedJson(value.ceiling_json, MAX_PROJECT_JSON_BYTES));
  const runUsage = {
    toolCalls: safeInteger(value.tool_calls),
    inputTokens: safeInteger(value.input_tokens),
    outputTokens: safeInteger(value.output_tokens),
    activeRuntimeMs: safeInteger(value.active_runtime_ms),
    estimatedCostUsd: finiteNumber(value.estimated_cost_usd),
    reservedCostUsd: finiteNumber(value.reserved_cost_usd),
  };
  try {
    assertCheckProfiles(checks);
    assertSandboxProfile(sandbox);
    assertSunCeiling(ceiling);
  } catch {
    sourceInvalid();
  }
  const contextValue = boundedJson(value.context_json, MAX_CONTEXT_JSON_BYTES);
  const context = decodeContext(contextValue);
  validateContextManifest(context, ceiling);
  const contextShaText = text(value.context_sha256, 64);
  const hasContext = contextShaText.length > 0;
  if (
    hasContext &&
    (!SHA256_PATTERN.test(contextShaText) ||
      context.baseCommit !== baseCommit ||
      digestJson(asJsonValue(contextValue)) !== contextShaText)
  ) {
    sourceInvalid();
  }
  const contextMayBeAbsent =
    effectiveState === "preparing" ||
    effectiveState === "cancelling" ||
    effectiveState === "cancelled";
  if (
    (!hasContext &&
      (!contextMayBeAbsent ||
        context.baseCommit !== "" ||
        context.repositoryMap.length !== 0 ||
        context.entries.length !== 0)) ||
    (hasContext && baseCommit.length === 0)
  ) {
    sourceInvalid();
  }

  const readableRow = database
    .prepare(
      "SELECT " +
        "CASE WHEN typeof(base_commit)='text' AND octet_length(base_commit)<=64 THEN base_commit END AS base_commit, " +
        "CASE WHEN typeof(manifest_sha256)='text' AND octet_length(manifest_sha256)<=64 THEN manifest_sha256 END AS manifest_sha256, " +
        "CASE WHEN typeof(entries_json)='text' AND octet_length(entries_json)<=" +
        String(MAX_CONTEXT_JSON_BYTES) +
        " AND json_valid(entries_json,1) THEN entries_json END AS entries_json " +
        "FROM readable_manifests WHERE run_id=?",
    )
    .get(runId);
  const readable =
    readableRow === undefined
      ? null
      : decodeReadableManifest(
          row(readableRow).base_commit,
          row(readableRow).manifest_sha256,
          row(readableRow).entries_json,
        );
  if (readable !== null && readable.baseCommit !== baseCommit) sourceInvalid();

  const rawPlan = value.plan_json;
  const rawPlanSha = value.plan_sha256;
  if ((rawPlan === null) !== (rawPlanSha === null)) sourceInvalid();
  let plan = null;
  let planSha256: string | null = null;
  if (rawPlan !== null) {
    const parsedPlan = boundedJson(rawPlan, MAX_PLAN_JSON_BYTES);
    try {
      plan = parsePlanProposal(parsedPlan, context.targets, checks);
    } catch {
      sourceInvalid();
    }
    const requestsRead = plan.grants.some((grant) => grant.kind === "read.manifest");
    if (requestsRead !== (readable !== null)) sourceInvalid();
    planSha256 = digest(rawPlanSha);
    const expected = planApprovalDigest({
      task,
      baseCommit,
      contextSha256: contextShaText,
      targets: context.targets,
      provider,
      checks,
      sandbox,
      ceiling,
      plan,
      readableManifest: readable,
    });
    if (expected !== planSha256) sourceInvalid();
  } else if (readable !== null) {
    sourceInvalid();
  }

  const patchRow = database
    .prepare(
      "SELECT CASE WHEN typeof(patch_set_json)='text' AND octet_length(patch_set_json)<=" +
        String(MAX_PATCH_JSON_BYTES) +
        " AND json_valid(patch_set_json,1) THEN patch_set_json END AS patch_set_json " +
        "FROM patch_sets WHERE run_id=?",
    )
    .get(runId);
  const checkpointFileRows = database
    .prepare(
      "SELECT " +
        "CASE WHEN typeof(run_id)='text' AND octet_length(run_id)<=64 THEN run_id END AS run_id, " +
        "CASE WHEN typeof(path)='text' AND octet_length(path)<=1024 THEN path END AS path, " +
        "CASE WHEN typeof(op)='text' AND octet_length(op)<=16 THEN op END AS op, " +
        "CASE WHEN baseline_base64 IS NULL OR (typeof(baseline_base64)='text' AND octet_length(baseline_base64)<=" +
        String(MAX_CHECKPOINT_ENCODED_BYTES) +
        ") THEN baseline_base64 END AS baseline_base64, " +
        "CASE WHEN approved_base64 IS NULL OR (typeof(approved_base64)='text' AND octet_length(approved_base64)<=" +
        String(MAX_CHECKPOINT_ENCODED_BYTES) +
        ") THEN approved_base64 END AS approved_base64 " +
        "FROM checkpoint_files WHERE run_id=? ORDER BY path LIMIT " +
        String(MAX_CHECKPOINT_FILES + 1),
    )
    .all(runId) as unknown[];
  const checkpointFiles = decodeCheckpointFiles(checkpointFileRows, runId);
  let expectedPaths: readonly string[] = [];
  let expectedIntent:
    | {
        readonly type: "edit.intent_recorded";
        readonly path: string;
        readonly expectedPreimageSha256: string;
      }
    | {
        readonly type: "patch_set.intent_recorded";
        readonly paths: readonly string[];
        readonly operations: readonly ("modify" | "create" | "delete")[];
      }
    | null = null;
  if (patchRow !== undefined) {
    if (checkpointFiles.length === 0 || plan === null) sourceInvalid();
    const preimages = new Map(
      checkpointFiles.map((file) => [
        file.path,
        {
          exists: file.baselineBase64 !== null,
          sha256:
            file.baselineBase64 === null
              ? null
              : sha256(Buffer.from(file.baselineBase64, "base64")),
        },
      ]),
    );
    let patchSet: ReturnType<typeof parsePatchSet>;
    try {
      patchSet = parsePatchSet(
        persistedPatchSetAsProviderWire(
          boundedJson(row(patchRow).patch_set_json, MAX_PATCH_JSON_BYTES),
        ),
        plan.targets,
        preimages,
        ceiling.maxFilesChanged,
      );
    } catch {
      sourceInvalid();
    }
    expectedPaths = patchSet.edits.map((edit) => edit.path);
    expectedIntent = {
      type: "patch_set.intent_recorded",
      paths: [...expectedPaths].sort(),
      operations: patchSet.edits.map((edit) => edit.op),
    };
    if (
      !sameStringSet(
        expectedPaths,
        checkpointFiles.map((file) => file.path),
      )
    )
      sourceInvalid();
  } else if (checkpointFiles.length > 0) {
    sourceInvalid();
  } else if (value.edit_json !== null) {
    const baselineBase64 = canonicalBase64(value.baseline_base64);
    const approvedBase64 = canonicalBase64(value.approved_base64);
    if (baselineBase64 === null || approvedBase64 === null) sourceInvalid();
    const baselineBytes = Buffer.from(baselineBase64, "base64");
    const baseline = baselineBytes.toString("utf8");
    const approvedBytes = Buffer.from(approvedBase64, "base64");
    if (!Buffer.from(baseline, "utf8").equals(baselineBytes)) sourceInvalid();
    let edit: ReturnType<typeof parseEditProposal>;
    try {
      edit = parseEditProposal(
        boundedJson(value.edit_json, MAX_PATCH_JSON_BYTES),
        target,
        sha256(baselineBytes),
      );
      const approved = applyExactReplacement(baseline, edit, ceiling.maxFileBytes);
      if (!Buffer.from(approved, "utf8").equals(approvedBytes)) sourceInvalid();
    } catch {
      sourceInvalid();
    }
    expectedPaths = [edit.path];
    expectedIntent = {
      type: "edit.intent_recorded",
      path: edit.path,
      expectedPreimageSha256: edit.expectedPreimageSha256,
    };
  }

  const checkpointRow = database
    .prepare(
      "SELECT " +
        "CASE WHEN typeof(run_id)='text' AND octet_length(run_id)<=64 THEN run_id END AS run_id, " +
        "CASE WHEN typeof(baseline_base64)='text' AND octet_length(baseline_base64)<=" +
        String(MAX_CHECKPOINT_ENCODED_BYTES) +
        " THEN baseline_base64 END AS baseline_base64, " +
        "CASE WHEN typeof(approved_base64)='text' AND octet_length(approved_base64)<=" +
        String(MAX_CHECKPOINT_ENCODED_BYTES) +
        " THEN approved_base64 END AS approved_base64, " +
        "CASE WHEN typeof(checkpoint_sha256)='text' AND octet_length(checkpoint_sha256)<=64 THEN checkpoint_sha256 END AS checkpoint_sha256 " +
        "FROM checkpoints WHERE run_id=?",
    )
    .get(runId);
  let checkpointSha256: string | null = null;
  if (checkpointRow !== undefined) {
    const checkpoint = row(checkpointRow);
    if (text(checkpoint.run_id, 64) !== runId) sourceInvalid();
    checkpointSha256 = digest(checkpoint.checkpoint_sha256);
    if (patchRow !== undefined) {
      if (
        text(checkpoint.baseline_base64, MAX_CHECKPOINT_ENCODED_BYTES) !== "" ||
        text(checkpoint.approved_base64, MAX_CHECKPOINT_ENCODED_BYTES) !== "" ||
        treeCheckpointDigest({ runId, baseCommit, files: checkpointFiles }) !== checkpointSha256
      ) {
        sourceInvalid();
      }
    } else {
      const baselineBase64 = canonicalBase64(checkpoint.baseline_base64);
      const approvedBase64 = canonicalBase64(checkpoint.approved_base64);
      const runBaseline = canonicalBase64(value.baseline_base64);
      const runApproved = canonicalBase64(value.approved_base64);
      if (
        baselineBase64 === null ||
        approvedBase64 === null ||
        baselineBase64 !== runBaseline ||
        approvedBase64 !== runApproved ||
        checkpointDigest({
          runId,
          baseCommit,
          target,
          baselineBase64,
          approvedBase64,
        }) !== checkpointSha256
      ) {
        sourceInvalid();
      }
    }
  }

  const rawVerification = value.verification_json;
  const rawDiff = value.diff;
  if ((rawVerification === null) !== (rawDiff === null)) sourceInvalid();
  let persistedVerificationSummary: ChangeHandoffSourceSnapshot["verification"] = null;
  let persistedVerificationEvidenceSha256: string | null = null;
  if (rawVerification !== null) {
    if (plan === null || checkpointSha256 === null || expectedPaths.length === 0) sourceInvalid();
    const verification = decodeVerification(
      boundedJson(rawVerification, MAX_VERIFICATION_JSON_BYTES),
    );
    const diff = text(rawDiff, MAX_DIFF_BYTES);
    validateVerification(
      verification,
      diff,
      checkpointSha256,
      expectedPaths,
      plan.checkIds,
      checks,
      ceiling,
    );
    persistedVerificationEvidenceSha256 = digestJson(asJsonValue(verification));
    persistedVerificationSummary = {
      outcome: verification.outcome,
      diffSha256: verification.diffSha256,
      checkpointSha256: verification.checkpointSha256,
      changedFiles: verification.changedPaths.length,
      checks: verification.checks.length,
    };
  }

  const errorCode = nullableText(value.error_code, 64);
  if (
    (state === "failed" && (errorCode === null || !ERROR_CODE_PATTERN.test(errorCode))) ||
    (state !== "failed" && errorCode !== null)
  ) {
    sourceInvalid();
  }

  const approvals = readApprovals(database, runId);
  const eventRead = readEventSummary(database, runId, plan?.iterationCeiling ?? null);
  const events = eventRead.snapshot;
  const latestIntent = eventRead.intentEvidence.at(-1) ?? null;
  const intentMatches =
    expectedIntent === null
      ? latestIntent === null
      : latestIntent !== null &&
        (expectedIntent.type === "edit.intent_recorded"
          ? latestIntent.type === "edit.intent_recorded" &&
            latestIntent.path === expectedIntent.path &&
            latestIntent.expectedPreimageSha256 === expectedIntent.expectedPreimageSha256
          : latestIntent.type === "patch_set.intent_recorded" &&
            sameStringArray(latestIntent.paths, expectedIntent.paths) &&
            sameStringArray(latestIntent.operations, expectedIntent.operations));
  if (
    eventRead.runCreatedTarget !== target ||
    eventRead.replayedState !== state ||
    (hasContext
      ? eventRead.contextAssembledDigest !== contextShaText
      : eventRead.contextAssembledDigest !== null) ||
    eventRead.activeCheckpointSha256 !== checkpointSha256 ||
    !intentMatches ||
    approvals.length !== eventRead.approvalTransitions.length
  ) {
    sourceInvalid();
  }
  approvals.forEach((approval, index) => {
    const transition = eventRead.approvalTransitions[index];
    if (transition === undefined) sourceInvalid();
    const expected =
      approval.kind === "egress"
        ? { type: "egress.approved", from: "awaiting_egress_approval", to: "planned" }
        : approval.kind === "plan"
          ? { type: "plan.approved", from: "awaiting_approval", to: "running" }
          : approval.kind === "review"
            ? {
                type: approval.decision === "approve" ? "review.accepted" : "review.rejected",
                from: "awaiting_review",
                to: approval.decision === "approve" ? "completed" : "rolling_back",
              }
            : approval.kind === "restore"
              ? { type: "restore.approved", from: "rolled_back", to: "restoring" }
              : { type: "rollback.approved", from: null, to: "rolling_back" };
    if (
      transition.type !== expected.type ||
      (expected.from === null
        ? transition.from !== "awaiting_review" && transition.from !== "completed"
        : transition.from !== expected.from) ||
      transition.to !== expected.to ||
      transition.kind !== approval.kind ||
      transition.digest !== approval.digest ||
      transition.actor !== approval.actor ||
      transition.decision !== approval.decision
    ) {
      sourceInvalid();
    }
  });
  const planApprovalTransitions = eventRead.approvalTransitions.filter(
    (transition) => transition.type === "plan.approved",
  );
  if (
    (plan === null) !== (eventRead.planCreatedSequence === null) ||
    (plan === null) !== (eventRead.planCreatedDigest === null) ||
    (plan === null) !== (eventRead.planCreatedReadableFiles === null) ||
    (plan !== null &&
      (eventRead.planCreatedDigest !== planSha256 ||
        eventRead.planCreatedReadableFiles !== (readable?.entries.length ?? 0) ||
        planApprovalTransitions.some(
          (transition) => transition.sequence <= (eventRead.planCreatedSequence ?? 0),
        )))
  ) {
    sourceInvalid();
  }

  const latestFailure = eventRead.failureTransitions.at(-1) ?? null;
  const latestResume = eventRead.resumeTransitions.at(-1) ?? null;
  if (
    state === "failed" &&
    (latestFailure === null ||
      latestFailure.sequence <= (latestResume?.sequence ?? 0) ||
      latestFailure.resumeState !== resumeState ||
      latestFailure.code !== errorCode)
  ) {
    sourceInvalid();
  }
  if (
    state !== "failed" &&
    latestFailure !== null &&
    latestFailure.sequence > (latestResume?.sequence ?? 0)
  ) {
    const cancellationRequest = eventRead.cancellationRequests.at(-1) ?? null;
    if (
      (state !== "cancelling" && state !== "cancelled") ||
      cancellationRequest === null ||
      cancellationRequest.from !== "failed" ||
      cancellationRequest.sequence <= latestFailure.sequence
    ) {
      sourceInvalid();
    }
  }

  const operationRows = database
    .prepare(
      "SELECT " +
        "CASE WHEN typeof(id)='text' AND octet_length(id)<=64 THEN id END AS id, " +
        "CASE WHEN typeof(kind)='text' AND octet_length(kind)<=128 THEN kind END AS kind, " +
        "CASE WHEN typeof(status)='text' AND octet_length(status)<=16 THEN status END AS status, " +
        "CASE WHEN typeof(reserved_cost_usd) IN ('integer','real') THEN reserved_cost_usd END AS reserved_cost_usd, " +
        "CASE WHEN typeof(reserved_tokens)='integer' THEN reserved_tokens END AS reserved_tokens, " +
        "CASE WHEN typeof(reserved_runtime_ms)='integer' THEN reserved_runtime_ms END AS reserved_runtime_ms, " +
        "CASE WHEN result_json IS NULL THEN 1 " +
        "WHEN typeof(result_json)='text' AND octet_length(result_json)<=" +
        String(MAX_VERIFICATION_EVENT_JSON_BYTES) +
        " AND json_valid(result_json,1)=1 THEN 0 END AS result_json_is_null, " +
        "CASE WHEN kind='session.tool.mutation.patchset' " +
        "AND status IN ('succeeded','failed','cancelled') " +
        "THEN json_type(result_json,'$') END AS mutation_result_root_type, " +
        "CASE WHEN kind='session.tool.mutation.patchset' " +
        "AND status IN ('succeeded','failed','cancelled') " +
        "THEN (SELECT COUNT(*) FROM json_each(result_json) WHERE key='tool') " +
        "END AS mutation_result_tool_count, " +
        "CASE WHEN kind='session.tool.mutation.patchset' " +
        "AND status IN ('succeeded','failed','cancelled') " +
        "THEN json_type(result_json,'$.tool') END AS mutation_result_tool_type, " +
        "CASE WHEN kind='session.tool.mutation.patchset' " +
        "AND status IN ('succeeded','failed','cancelled') " +
        "AND json_type(result_json,'$.tool')='text' " +
        "AND octet_length(json_extract(result_json,'$.tool'))<=64 " +
        "THEN json_extract(result_json,'$.tool') END AS mutation_result_tool, " +
        "CASE WHEN finished_at IS NULL THEN 1 " +
        "WHEN typeof(finished_at)='text' AND octet_length(finished_at)<=64 THEN 0 END " +
        "AS finished_at_is_null FROM operations WHERE run_id=? LIMIT " +
        String(MAX_OPERATIONS + 1),
    )
    .all(runId) as unknown[];
  if (
    operationRows.length > MAX_OPERATIONS ||
    operationRows.length !== eventRead.operationStarts.length
  ) {
    sourceInvalid();
  }
  const startsById = new Map(
    eventRead.operationStarts.map((started) => [started.operationId, started] as const),
  );
  const terminalsById = new Map(
    eventRead.operationTerminals.map((terminal) => [terminal.operationId, terminal] as const),
  );
  if (
    startsById.size !== eventRead.operationStarts.length ||
    terminalsById.size !== eventRead.operationTerminals.length
  ) {
    sourceInvalid();
  }
  let activeOperations = 0;
  let activeReservedCostUsd = 0;
  for (const entry of operationRows) {
    const operation = row(entry);
    const operationId = text(operation.id, 64);
    const kind = operationKind(operation.kind);
    const status = text(operation.status, 16);
    const reservedCostUsd = finiteNumber(operation.reserved_cost_usd);
    const reservedTokens = safeInteger(operation.reserved_tokens);
    const reservedRuntimeMs = safeInteger(operation.reserved_runtime_ms, 1);
    const resultJsonIsNull = safeInteger(operation.result_json_is_null);
    const finishedAtIsNull = safeInteger(operation.finished_at_is_null);
    const started = startsById.get(operationId);
    const terminal = terminalsById.get(operationId);
    const mutationResultTool =
      kind === SESSION_PATCH_OPERATION_KIND &&
      (status === "succeeded" || status === "failed" || status === "cancelled") &&
      operation.mutation_result_root_type === "object" &&
      safeInteger(operation.mutation_result_tool_count) === 1 &&
      operation.mutation_result_tool_type === "text"
        ? text(operation.mutation_result_tool, 64)
        : null;
    const terminalMatches =
      status === "started"
        ? terminal === undefined && finishedAtIsNull === 1 && resultJsonIsNull === 1
        : status === "interrupted"
          ? terminal?.status === "interrupted" && finishedAtIsNull === 0 && resultJsonIsNull === 1
          : (status === "succeeded" || status === "failed" || status === "cancelled") &&
            terminal?.status === status &&
            finishedAtIsNull === 0 &&
            resultJsonIsNull === 0;
    const mutationToolMatches =
      kind !== SESSION_PATCH_OPERATION_KIND ||
      status === "started" ||
      status === "interrupted" ||
      terminal?.detailTool === mutationResultTool;
    if (
      !UUID_PATTERN.test(operationId) ||
      started === undefined ||
      started.operationId !== operationId ||
      started.kind !== kind ||
      started.reservedCostUsd !== reservedCostUsd ||
      started.reservedTokens !== reservedTokens ||
      started.reservedRuntimeMs !== reservedRuntimeMs ||
      (status !== "started" &&
        status !== "succeeded" &&
        status !== "failed" &&
        status !== "cancelled" &&
        status !== "interrupted") ||
      (finishedAtIsNull !== 0 && finishedAtIsNull !== 1) ||
      (resultJsonIsNull !== 0 && resultJsonIsNull !== 1) ||
      !terminalMatches ||
      !mutationToolMatches
    ) {
      sourceInvalid();
    }
    if (status === "started") {
      activeOperations += 1;
      activeReservedCostUsd += reservedCostUsd;
    }
  }
  const ordinaryOperations = eventRead.operationStarts.filter(
    (started) => started.budgetClass === "ordinary",
  ).length;
  const emergencyOperations = eventRead.operationStarts.length - ordinaryOperations;
  const totalTokens = runUsage.inputTokens + runUsage.outputTokens;
  if (
    eventRead.operationTerminals.length !== operationRows.length - activeOperations ||
    activeOperations > 1 ||
    runUsage.toolCalls !== operationRows.length ||
    ordinaryOperations > ceiling.maxToolCalls ||
    !Number.isSafeInteger(totalTokens) ||
    totalTokens > ceiling.maxTotalTokens ||
    runUsage.estimatedCostUsd > ceiling.maxCostUsd + Number.EPSILON ||
    runUsage.activeRuntimeMs >
      ceiling.maxActiveRuntimeMs + emergencyOperations * CANCELLATION_RECOVERY_RUNTIME_MS ||
    Math.abs(runUsage.reservedCostUsd - activeReservedCostUsd) > Number.EPSILON
  ) {
    sourceInvalid();
  }
  if (activeOperations !== 0) {
    throw new IcarusError("RUN_BUSY", "Run has an active operation and cannot be handed off");
  }

  const hasApproval = (
    kind: ApprovalRecord["kind"],
    subject: string | null,
    decision: "approve" | "reject" = "approve",
  ): boolean =>
    subject !== null &&
    approvals.some(
      (approval) =>
        approval.kind === kind && approval.digest === subject && approval.decision === decision,
    );

  const afterPlanGate = new Set<RunState>([
    "running",
    "verifying",
    "awaiting_review",
    "completed",
    "rolling_back",
    "rolled_back",
    "restoring",
  ]);
  const cancellationLike = effectiveState === "cancelling" || effectiveState === "cancelled";
  if (
    (provider.capabilities.locality === "remote" &&
      effectiveState !== "preparing" &&
      effectiveState !== "awaiting_egress_approval" &&
      !cancellationLike &&
      !hasApproval("egress", hasContext ? contextShaText : null)) ||
    (afterPlanGate.has(effectiveState) && !hasApproval("plan", planSha256))
  ) {
    sourceInvalid();
  }

  const latestVerificationEvent = eventRead.verificationTransitions.at(-1) ?? null;
  const verificationWasSuperseded =
    latestVerificationEvent !== null &&
    (eventRead.latestIntentSequence ?? 0) > latestVerificationEvent.sequence;
  if (
    (latestVerificationEvent === null && persistedVerificationSummary !== null) ||
    (verificationWasSuperseded && persistedVerificationSummary !== null) ||
    (!verificationWasSuperseded &&
      latestVerificationEvent !== null &&
      (persistedVerificationSummary === null ||
        latestVerificationEvent.diffSha256 !== persistedVerificationSummary.diffSha256 ||
        latestVerificationEvent.outcome !== persistedVerificationSummary.outcome ||
        latestVerificationEvent.checkpointSha256 !==
          persistedVerificationSummary.checkpointSha256 ||
        latestVerificationEvent.verificationEvidenceSha256 !== persistedVerificationEvidenceSha256))
  ) {
    sourceInvalid();
  }

  const verificationBoundary = Math.max(
    eventRead.latestIntentSequence ?? 0,
    eventRead.restoreCompletionSequences.at(-1) ?? 0,
    eventRead.verificationRequestSequence ?? 0,
  );
  const currentVerificationEvent =
    latestVerificationEvent !== null && latestVerificationEvent.sequence > verificationBoundary
      ? latestVerificationEvent
      : null;
  const verificationSummary =
    currentVerificationEvent === null ? null : persistedVerificationSummary;
  const verificationSequence = currentVerificationEvent?.sequence ?? null;
  const currentDiffSha256 = verificationSummary?.diffSha256 ?? null;
  const currentReviewTransitions =
    verificationSequence === null
      ? []
      : eventRead.approvalTransitions.filter(
          (transition) =>
            transition.kind === "review" && transition.sequence > verificationSequence,
        );
  if (
    currentReviewTransitions.length > 1 ||
    currentReviewTransitions.some((transition) => transition.digest !== currentDiffSha256)
  ) {
    sourceInvalid();
  }
  const currentReviewTransition = currentReviewTransitions[0] ?? null;
  const currentReviewDecision = currentReviewTransition?.decision ?? null;
  const reviewApprovedSequence =
    currentReviewDecision === "approve" ? (currentReviewTransition?.sequence ?? null) : null;
  const reviewRejectedSequence =
    currentReviewDecision === "reject" ? (currentReviewTransition?.sequence ?? null) : null;

  if (
    state === "completed" &&
    (verificationSummary?.outcome !== "passed" ||
      currentReviewDecision !== "approve" ||
      reviewApprovedSequence === null ||
      verificationSequence === null ||
      reviewApprovedSequence <= verificationSequence)
  ) {
    sourceInvalid();
  }
  if (
    effectiveState === "awaiting_review" &&
    (reviewApprovedSequence !== null || reviewRejectedSequence !== null)
  ) {
    sourceInvalid();
  }

  const rollbackAuthorizations = eventRead.approvalTransitions.filter(
    (transition) =>
      transition.type === "review.rejected" || transition.type === "rollback.approved",
  );
  const restoreAuthorizations = eventRead.approvalTransitions.filter(
    (transition) => transition.type === "restore.approved",
  );
  let previousRollbackCompletion = 0;
  for (const completion of eventRead.rollbackCompletionSequences) {
    const authorization = rollbackAuthorizations
      .filter(
        (transition) =>
          transition.sequence > previousRollbackCompletion && transition.sequence < completion,
      )
      .at(-1);
    if (
      authorization === undefined ||
      !eventRead.verificationTransitions.some(
        (transition) =>
          transition.sequence > previousRollbackCompletion &&
          transition.sequence < authorization.sequence &&
          transition.diffSha256 === authorization.digest,
      )
    ) {
      sourceInvalid();
    }
    previousRollbackCompletion = completion;
  }

  let previousRestoreCompletion = 0;
  for (const completion of eventRead.restoreCompletionSequences) {
    const rollbackCompletion = eventRead.rollbackCompletionSequences
      .filter((sequence) => sequence > previousRestoreCompletion && sequence < completion)
      .at(-1);
    const authorization = restoreAuthorizations
      .filter(
        (transition) =>
          rollbackCompletion !== undefined &&
          transition.sequence > rollbackCompletion &&
          transition.sequence < completion,
      )
      .at(-1);
    if (rollbackCompletion === undefined || authorization === undefined) sourceInvalid();
    previousRestoreCompletion = completion;
  }

  const latestRollbackCompletion = eventRead.rollbackCompletionSequences.at(-1) ?? 0;
  const latestRestoreCompletion = eventRead.restoreCompletionSequences.at(-1) ?? 0;
  const latestRollbackAuthorization = rollbackAuthorizations.at(-1) ?? null;
  const latestRestoreAuthorization = restoreAuthorizations.at(-1) ?? null;
  const outstandingRollbackAuthorization =
    latestRollbackAuthorization !== null &&
    latestRollbackAuthorization.sequence > latestRollbackCompletion
      ? latestRollbackAuthorization
      : null;
  const outstandingRestoreAuthorization =
    latestRestoreAuthorization !== null &&
    latestRestoreAuthorization.sequence > latestRestoreCompletion
      ? latestRestoreAuthorization
      : null;

  const rollbackInProgress = effectiveState === "rolling_back";
  const rollbackSettled = state === "rolled_back" || effectiveState === "restoring";
  if (
    (rollbackInProgress || rollbackSettled) &&
    (checkpointSha256 === null ||
      verificationSequence === null ||
      latestRollbackAuthorization === null ||
      latestRollbackAuthorization.digest !== currentDiffSha256 ||
      latestRollbackAuthorization.sequence <= verificationSequence ||
      (rollbackInProgress && latestRollbackAuthorization.sequence <= latestRollbackCompletion) ||
      (rollbackSettled && latestRollbackCompletion <= latestRollbackAuthorization.sequence))
  ) {
    sourceInvalid();
  }
  if (
    state === "rolled_back" &&
    (latestRollbackCompletion === 0 || latestRollbackCompletion <= latestRestoreCompletion)
  ) {
    sourceInvalid();
  }

  const restorationInProgress = effectiveState === "restoring";
  if (
    restorationInProgress &&
    (checkpointSha256 === null ||
      latestRollbackCompletion === 0 ||
      latestRestoreAuthorization === null ||
      latestRestoreAuthorization.digest !== checkpointSha256 ||
      latestRestoreAuthorization.sequence <= latestRollbackCompletion ||
      latestRestoreAuthorization.sequence <= latestRestoreCompletion)
  ) {
    sourceInvalid();
  }

  const latestCancellationRequest = eventRead.cancellationRequests.at(-1) ?? null;
  const cancellationLineage = effectiveState === "cancelling" || state === "cancelled";
  const interruptedRecoveryWasCancelled = (
    resumeStateValue: "rolling_back" | "restoring",
    authorizationSequence: number,
  ): boolean => {
    if (
      !cancellationLineage ||
      latestCancellationRequest === null ||
      latestFailure === null ||
      latestFailure.sequence <= (latestResume?.sequence ?? 0)
    ) {
      return false;
    }
    if (
      latestCancellationRequest.from !== "failed" ||
      latestFailure.from !== resumeStateValue ||
      latestFailure.resumeState !== resumeStateValue ||
      latestFailure.sequence <= authorizationSequence ||
      latestFailure.sequence >= latestCancellationRequest.sequence
    ) {
      return false;
    }
    return (
      state !== "cancelled" ||
      (events.cancellationCompletedSequence !== null &&
        events.cancellationCompletedSequence > latestCancellationRequest.sequence)
    );
  };
  const cancelledRollbackInterruption =
    outstandingRollbackAuthorization !== null &&
    interruptedRecoveryWasCancelled("rolling_back", outstandingRollbackAuthorization.sequence);
  const cancelledRestoreInterruption =
    outstandingRestoreAuthorization !== null &&
    interruptedRecoveryWasCancelled("restoring", outstandingRestoreAuthorization.sequence);

  if (
    outstandingRollbackAuthorization !== null &&
    !rollbackInProgress &&
    !cancelledRollbackInterruption
  ) {
    sourceInvalid();
  }
  if (
    outstandingRestoreAuthorization !== null &&
    !restorationInProgress &&
    !cancelledRestoreInterruption
  ) {
    sourceInvalid();
  }
  const failedRollbackInterruption =
    state === "failed" &&
    resumeState === "rolling_back" &&
    outstandingRollbackAuthorization !== null &&
    latestFailure?.from === "rolling_back" &&
    latestFailure.sequence > outstandingRollbackAuthorization.sequence;
  const failedRestoreInterruption =
    state === "failed" &&
    resumeState === "restoring" &&
    outstandingRestoreAuthorization !== null &&
    latestFailure?.from === "restoring" &&
    latestFailure.sequence > outstandingRestoreAuthorization.sequence;
  if (
    (state === "failed" && resumeState === "rolling_back" && !failedRollbackInterruption) ||
    (state === "failed" && resumeState === "restoring" && !failedRestoreInterruption)
  ) {
    sourceInvalid();
  }
  const interruptedRecovery =
    failedRollbackInterruption || cancelledRollbackInterruption
      ? "rolling_back"
      : failedRestoreInterruption || cancelledRestoreInterruption
        ? "restoring"
        : null;

  if (
    events.restoreCompletedCount > events.rollbackCompletedCount ||
    events.cancellationCompletedCount > 1 ||
    (state === "cancelled") !== (events.cancellationCompletedCount === 1) ||
    (cancellationLineage && latestCancellationRequest === null)
  ) {
    sourceInvalid();
  }

  return {
    runId,
    projectId,
    state,
    resumeState,
    runVersion,
    provider: {
      kind: provider.kind,
      model: provider.model,
      locality: provider.capabilities.locality,
      privacyClass: provider.capabilities.privacyClass,
    },
    contextSha256: hasContext ? contextShaText : null,
    planSha256,
    verification: verificationSummary,
    reviewDecision: currentReviewDecision,
    interruptedRecovery,
    checkpointSha256,
    approvals,
    events,
    activeOperations,
  };
}

export function readChangeHandoffSource(
  databasePath: string,
  runId: string,
): ChangeHandoffSourceSnapshot {
  if (process.platform !== "linux") {
    throw new IcarusError(
      "HANDOFF_SOURCE_UNSUPPORTED",
      "Secure handoff source preview is unsupported on this platform",
    );
  }
  noFollowFlag();
  if (!UUID_PATTERN.test(runId)) {
    throw new IcarusError("INVALID_RUN_ID", "Run ID is invalid");
  }
  try {
    const sourcePath = assertDatabasePath(databasePath);
    const source = fingerprintFamily(sourcePath);
    const databaseImage = readDatabaseImage(sourcePath, source);
    if (!sameFamily(source, fingerprintFamily(sourcePath))) {
      throw new IcarusError("RUN_BUSY", "Icarus database changed during handoff snapshot");
    }

    let database: Database.Database | undefined;
    try {
      database = new Database(databaseImage, { readonly: true });
      database.pragma("query_only = ON");
      const openedDatabase = database;
      const read = openedDatabase.transaction(() => readOpenDatabase(openedDatabase, runId));
      const result = read.deferred();
      database.close();
      database = undefined;
      if (!sameFamily(source, fingerprintFamily(sourcePath))) {
        throw new IcarusError("RUN_BUSY", "Icarus database changed during handoff preview");
      }
      return result;
    } finally {
      database?.close();
    }
  } catch (error) {
    if (error instanceof IcarusError) throw error;
    return sourceInvalid();
  }
}

function noFollowFlag(): number {
  const flag = fsConstants.O_NOFOLLOW;
  if (typeof flag === "number" && flag !== 0) return flag;
  throw new IcarusError(
    "HANDOFF_SOURCE_UNSUPPORTED",
    "This platform cannot safely open handoff source files without following links",
  );
}
