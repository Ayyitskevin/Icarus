#!/usr/bin/env node
import { randomUUID } from "node:crypto";

import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  approveLiveEvidenceProfileV1,
  assertExpectedChangeHandoffPreview,
  assertLiveEvidenceProfileApproved,
  assertLiveEvidenceProfileMatchesManifest,
  assertRegistrationStateSeparation,
  BROWSER_ACTION_LEDGER_MIGRATION,
  buildChangeHandoffPreview,
  CHANGE_HANDOFF_FILENAME,
  CHANGE_HANDOFF_MAX_BYTES,
  CHANGE_HANDOFF_RESULT_FILENAME,
  CHANGE_HANDOFF_RESULT_MAX_BYTES,
  type ChangeRoomAnnotationTarget,
  type CheckProfile,
  canonicalJsonLine,
  createChangeHandoffExportResult,
  type BenchTargetV1,
  createGateway,
  createHeadlessHistoryLines,
  createHeadlessStreamLines,
  createIcarusRuntime,
  createProbeRequest,
  createProviderConfig,
  PROBE_KINDS,
  runBenchComparison,
  DEFAULT_CEILING,
  DEFAULT_SANDBOX_LIMITS,
  decodeLiveEvidenceCaseRunMapV1,
  decodeLiveEvidenceProfileDraftV1,
  decodeLiveEvidenceProfileV1,
  ExistingRunsLiveEvidenceCaseDriver,
  encodeChangeHandoffExportResult,
  FileLiveEvidenceJournalStore,
  type Gate1MigrationToken,
  type GitHubLandingProfileV1,
  type HeadlessHostProviderProfileV1,
  IcarusError,
  type IcarusRuntime,
  inspectChangeHandoffDocuments,
  isUnsupportedProbeKind,
  type JsonValue,
  LANDING_LEDGER_MIGRATION,
  liveEvidenceProfileApprovalDigest,
  migrateGate1Schema,
  parseStrictJson,
  presentLandingStatusV1,
  RunLeaseManager,
  type RunRecord,
  readChangeHandoffSource,
  readSecureHandoffFile,
  runLiveEvidenceExecutor,
  runProbe,
  unsupportedProbeResult,
  verifyChangeHandoffDocuments,
  writeChangeHandoffFiles,
} from "@icarus/core";

interface ParsedOptions {
  readonly positionals: readonly string[];
  readonly values: ReadonlyMap<string, readonly string[]>;
  readonly booleans: ReadonlySet<string>;
}

export interface CliMainOptions {
  readonly args?: readonly string[];
  readonly platform?: NodeJS.Platform;
  readonly createRuntime?: typeof createIcarusRuntime;
  readonly now?: () => string;
}

function fail(code: string, message: string): never {
  throw new IcarusError(code, message);
}

function parseOptions(
  args: readonly string[],
  allowedValues: readonly string[],
  allowedBooleans: readonly string[] = [],
): ParsedOptions {
  const valueNames = new Set(allowedValues);
  const booleanNames = new Set(allowedBooleans);
  const values = new Map<string, string[]>();
  const booleans = new Set<string>();
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === undefined) {
      continue;
    }
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const equals = token.indexOf("=");
    const name = equals < 0 ? token : token.slice(0, equals);
    if (booleanNames.has(name)) {
      if (equals >= 0) {
        fail("INVALID_ARGUMENT", `${name} does not accept a value`);
      }
      booleans.add(name);
      continue;
    }
    if (!valueNames.has(name)) {
      fail("UNKNOWN_OPTION", `Unknown option: ${name}`);
    }
    const value = equals >= 0 ? token.slice(equals + 1) : args[index + 1];
    if (value === undefined || (equals < 0 && value.startsWith("--"))) {
      fail("MISSING_OPTION_VALUE", `${name} requires a value`);
    }
    if (equals < 0) {
      index += 1;
    }
    const entries = values.get(name) ?? [];
    entries.push(value);
    values.set(name, entries);
  }
  return { positionals, values, booleans };
}

function required(options: ParsedOptions, name: string): string {
  const values = options.values.get(name) ?? [];
  if (values.length !== 1 || values[0] === undefined || values[0].length === 0) {
    fail("INVALID_ARGUMENT", `${name} must be provided exactly once`);
  }
  return values[0];
}

/** Repeatable option requiring at least one non-empty value (ADR 0023). */
function requiredAll(options: ParsedOptions, name: string): readonly string[] {
  const values = options.values.get(name) ?? [];
  if (values.length === 0 || values.some((value) => value.length === 0)) {
    fail("INVALID_ARGUMENT", `${name} must be provided at least once`);
  }
  return values;
}

function optional(options: ParsedOptions, name: string): string | undefined {
  const values = options.values.get(name) ?? [];
  if (values.length > 1) {
    fail("INVALID_ARGUMENT", `${name} may be provided at most once`);
  }
  return values[0];
}

function boundedJsonOption(options: ParsedOptions, name: string, maximumBytes: number): unknown {
  const value = required(options, name);
  if (Buffer.byteLength(value, "utf8") > maximumBytes) {
    fail("INVALID_ARGUMENT", `${name} exceeds its byte ceiling`);
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    fail("INVALID_ARGUMENT", `${name} must be valid JSON`);
  }
}

function numberOption(options: ParsedOptions, name: string): number | undefined {
  const value = optional(options, name);
  if (value === undefined) {
    return undefined;
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    fail("INVALID_ARGUMENT", `${name} must be a finite nonnegative number`);
  }
  return number;
}

function noPositionals(options: ParsedOptions): void {
  if (options.positionals.length !== 0) {
    fail("INVALID_ARGUMENT", `Unexpected positional arguments: ${options.positionals.join(" ")}`);
  }
}

function oneRunId(options: ParsedOptions): string {
  if (options.positionals.length !== 1 || options.positionals[0] === undefined) {
    fail("INVALID_ARGUMENT", "Exactly one run ID is required");
  }
  return options.positionals[0];
}

function parseCheck(value: string): CheckProfile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    fail("INVALID_CHECK", "--check must be a JSON object");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    fail("INVALID_CHECK", "--check must be a JSON object");
  }
  const object = parsed as Record<string, unknown>;
  if (
    typeof object.id !== "string" ||
    typeof object.name !== "string" ||
    !Array.isArray(object.argv) ||
    !object.argv.every((entry) => typeof entry === "string")
  ) {
    fail("INVALID_CHECK", "--check requires string id/name and string[] argv");
  }
  return {
    id: object.id,
    name: object.name,
    argv: object.argv as string[],
  };
}

function stateRoot(): string {
  const explicit = process.env.ICARUS_HOME;
  if (explicit !== undefined && explicit.length > 0) {
    return path.resolve(explicit);
  }
  const stateHome = process.env.XDG_STATE_HOME;
  return path.resolve(
    stateHome !== undefined && stateHome.length > 0
      ? path.join(stateHome, "icarus")
      : path.join(os.homedir(), ".local", "state", "icarus"),
  );
}

/**
 * Each migration is approved by its own exact token, so approving one never
 * silently approves another. A database needing both is migrated by two
 * explicit invocations.
 */
function schemaMigrationApproval(): {
  readonly approvalIndex: boolean;
  readonly patchSet: boolean;
  readonly readableManifest: boolean;
  readonly annotation: boolean;
  readonly headlessChildren: boolean;
  readonly gate1: Gate1MigrationToken | null;
} {
  const none = {
    approvalIndex: false,
    patchSet: false,
    readableManifest: false,
    annotation: false,
    headlessChildren: false,
    gate1: null,
  };
  const approval = process.env.ICARUS_APPROVE_SCHEMA_MIGRATION;
  if (approval === undefined) return none;
  // One token approves exactly one migration. Approving several at once would
  // let an operator agree to a schema change they never read about.
  if (approval === "approval-index-v1") return { ...none, approvalIndex: true };
  if (approval === "patch-set-v2") return { ...none, patchSet: true };
  if (approval === "readable-manifest-v3") return { ...none, readableManifest: true };
  if (approval === "run-annotations-v1") return { ...none, annotation: true };
  if (approval === "headless-children-v1") return { ...none, headlessChildren: true };
  if (approval === BROWSER_ACTION_LEDGER_MIGRATION) {
    return { ...none, gate1: BROWSER_ACTION_LEDGER_MIGRATION };
  }
  if (approval === LANDING_LEDGER_MIGRATION) {
    return { ...none, gate1: LANDING_LEDGER_MIGRATION };
  }
  fail(
    "INVALID_DATABASE_CONFIGURATION",
    "ICARUS_APPROVE_SCHEMA_MIGRATION must equal one documented one-shot migration token",
  );
}

function registrationPathForPreflight(args: readonly string[]): string | undefined {
  const [group, action, ...rest] = args;
  if (group !== "repo" || action !== "add") {
    return undefined;
  }
  const options = parseOptions(rest, ["--name", "--path"]);
  noPositionals(options);
  required(options, "--name");
  return required(options, "--path");
}

function assertLandingMutationPlatform(args: readonly string[], platform: NodeJS.Platform): void {
  const [group, action] = args;
  if (
    (group === "landing" ||
      (group === "live-evidence" && (action === "execute" || action === "resume"))) &&
    action !== undefined &&
    action !== "profile-show" &&
    action !== "status" &&
    platform !== "linux"
  ) {
    fail("UNSUPPORTED_PLATFORM", "Git landing mutations require Linux");
  }
}

function landingCredentialEnvironmentAllowlist(): readonly string[] {
  const raw = process.env.ICARUS_GITHUB_TOKEN_ALLOWLIST;
  if (raw === undefined || raw.length === 0) return [];
  const names = raw.split(",");
  if (names.some((name) => name.length === 0 || name !== name.trim())) {
    fail(
      "INVALID_DATABASE_CONFIGURATION",
      "ICARUS_GITHUB_TOKEN_ALLOWLIST must be a comma-separated list without blank or padded names",
    );
  }
  if (new Set(names).size !== names.length) {
    fail("INVALID_DATABASE_CONFIGURATION", "ICARUS_GITHUB_TOKEN_ALLOWLIST contains duplicates");
  }
  return names;
}

function landingProfile(options: ParsedOptions): GitHubLandingProfileV1 {
  const disposition = required(options, "--derivative-effects-disposition");
  if (disposition !== "inert-repository" && disposition !== "operator-approved") {
    fail(
      "INVALID_ARGUMENT",
      "--derivative-effects-disposition must be inert-repository or operator-approved",
    );
  }
  return {
    version: 1,
    provider: "github",
    owner: required(options, "--owner"),
    repository: required(options, "--repository"),
    baseBranch: required(options, "--base-branch"),
    branchNamespace: "icarus/",
    credentialRef: {
      kind: "environment",
      name: required(options, "--credential-env"),
    },
    expectedActor: required(options, "--expected-actor"),
    commitIdentity: {
      name: required(options, "--commit-name"),
      email: required(options, "--commit-email"),
    },
    derivativeEffects: {
      version: 1,
      disposition,
      evidenceSha256: required(options, "--derivative-effects-evidence-sha"),
    },
  };
}

function publicRun(run: RunRecord): Record<string, unknown> {
  return {
    id: run.id,
    projectId: run.projectId,
    task: run.task,
    target: run.target,
    provider: run.provider,
    state: run.state,
    resumeState: run.resumeState,
    baseCommit: run.baseCommit,
    context: {
      sha256: run.contextSha256,
      totalBytes: run.context.totalBytes,
      entries: run.context.entries,
    },
    plan: run.plan,
    planSha256: run.planSha256,
    patchSet:
      run.patchSet === null
        ? null
        : {
            summary: run.patchSet.summary,
            edits: run.patchSet.edits.map((edit) => ({
              op: edit.op,
              path: edit.path,
              expectedPreimageSha256: edit.op === "create" ? null : edit.expectedPreimageSha256,
              rationale: edit.rationale,
            })),
          },
    diff: run.diff,
    verification: run.verification,
    usage: run.usage,
    lastError: run.lastError,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Opt-in headless output surface (ADR 0061): `history` is the checksum-
 * terminated H0 trajectory and stays the default; `stream-json` is the typed
 * receipt-bound NDJSON projection of the same authoritative snapshot.
 */
type HeadlessOutputFormat = "history" | "stream-json";

function headlessOutputFormat(options: ParsedOptions): HeadlessOutputFormat {
  const value = optional(options, "--output-format") ?? "history";
  if (value !== "history" && value !== "stream-json") {
    fail("INVALID_ARGUMENT", "--output-format must be history or stream-json");
  }
  return value;
}

function emitRunTrajectory(
  runtime: IcarusRuntime,
  runId: string,
  format: HeadlessOutputFormat,
): void {
  const history = runtime.service.history(runId);
  if (format === "stream-json") {
    for (const line of createHeadlessStreamLines(history)) {
      process.stdout.write(canonicalJsonLine(line));
    }
    return;
  }
  const lines = createHeadlessHistoryLines(
    history.run.id,
    publicRun(history.run) as JsonValue,
    history.approvals,
    history.events,
  );
  for (const line of lines) process.stdout.write(canonicalJsonLine(line));
}

function handoffInputPair(input: string): {
  readonly payload: Buffer;
  readonly result: Buffer;
} {
  const absoluteInput = path.resolve(input);
  if (path.basename(absoluteInput) !== CHANGE_HANDOFF_FILENAME) {
    fail("INVALID_HANDOFF_FILE", "Handoff input must use the fixed payload filename");
  }
  const payload = readSecureHandoffFile(absoluteInput, CHANGE_HANDOFF_MAX_BYTES).bytes;
  const result = readSecureHandoffFile(
    path.join(path.dirname(absoluteInput), CHANGE_HANDOFF_RESULT_FILENAME),
    CHANGE_HANDOFF_RESULT_MAX_BYTES,
  ).bytes;
  return { payload, result };
}

function dispatchFileOnlyHandoff(args: readonly string[]): boolean {
  const [group, action, ...rest] = args;
  if (group !== "handoff") return false;
  if (action !== "verify" && action !== "inspect") usage();
  const options = parseOptions(rest, ["--input"]);
  noPositionals(options);
  const files = handoffInputPair(required(options, "--input"));
  print(
    action === "verify"
      ? verifyChangeHandoffDocuments(files.payload, files.result)
      : inspectChangeHandoffDocuments(files.payload, files.result),
  );
  return true;
}

const LIVE_EVIDENCE_INPUT_MAX_BYTES = 2 * 1024 * 1024;

function readStableOwnedInput(input: string, requireNonSharedWrite = true): Buffer {
  const absolute = path.resolve(input);
  let descriptor: number;
  try {
    descriptor = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    fail("INVALID_LIVE_EVIDENCE_FILE", `Cannot safely open ${absolute}`);
  }
  try {
    const before = fstatSync(descriptor);
    const uid = process.getuid?.();
    if (!before.isFile() || before.nlink !== 1 || (uid !== undefined && before.uid !== uid)) {
      fail(
        "INVALID_LIVE_EVIDENCE_FILE",
        "Input must be a regular, singly linked, operator-owned file",
      );
    }
    if (requireNonSharedWrite && (before.mode & 0o022) !== 0) {
      fail("INVALID_LIVE_EVIDENCE_FILE", "Input must not be group- or world-writable");
    }
    if (before.size > LIVE_EVIDENCE_INPUT_MAX_BYTES) {
      fail("INVALID_LIVE_EVIDENCE_FILE", "Input exceeds the live-evidence file-size ceiling");
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      bytes.length !== after.size
    ) {
      fail("INVALID_LIVE_EVIDENCE_FILE", "Input changed while it was being read");
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function parseLiveEvidenceJson(input: string): unknown {
  const bytes = readStableOwnedInput(input);
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("INVALID_LIVE_EVIDENCE_FILE", "Input is not valid UTF-8");
  }
  return parseStrictJson(source);
}

function writeCanonical(value: unknown): void {
  process.stdout.write(canonicalJsonLine(value));
}

function dispatchFileOnlyLiveEvidence(args: readonly string[], now: () => string): boolean {
  const [group, action, ...rest] = args;
  if (group !== "live-evidence") return false;
  if (action === "execute" || action === "resume") return false;
  if (action !== "digest" && action !== "approve" && action !== "inspect" && action !== "verify") {
    usage();
  }
  if (action === "digest") {
    const options = parseOptions(rest, ["--input"]);
    noPositionals(options);
    const draft = decodeLiveEvidenceProfileDraftV1(
      parseLiveEvidenceJson(required(options, "--input")),
    );
    writeCanonical({ profileDigestSha256: liveEvidenceProfileApprovalDigest(draft) });
    return true;
  }
  if (action === "approve") {
    const options = parseOptions(rest, ["--input", "--manifest", "--actor"]);
    noPositionals(options);
    writeCanonical(
      approveLiveEvidenceProfileV1(
        parseLiveEvidenceJson(required(options, "--input")),
        readStableOwnedInput(required(options, "--manifest"), false),
        required(options, "--actor"),
        now(),
      ),
    );
    return true;
  }
  const options = parseOptions(rest, ["--input", "--manifest"]);
  noPositionals(options);
  const profile = decodeLiveEvidenceProfileV1(parseLiveEvidenceJson(required(options, "--input")));
  const manifestBytes = readStableOwnedInput(required(options, "--manifest"), false);
  assertLiveEvidenceProfileApproved(profile);
  assertLiveEvidenceProfileMatchesManifest(profile, manifestBytes);
  writeCanonical({
    status: action === "verify" ? "verified" : "approved",
    profileId: profile.profileId,
    profileDigestSha256: profile.approval.profileDigestSha256,
    actor: profile.approval.actor,
    approvedAt: profile.approval.approvedAt,
    authorizedEffects: profile.authorizedEffects,
    caseIds: profile.cases.map((entry) => entry.caseId),
    executionAuthority: "none",
  });
  return true;
}

function handoffRequest(options: ParsedOptions): {
  readonly correlationId: string;
  readonly externalTaskRef: string | null;
} {
  return {
    correlationId: required(options, "--correlation-id"),
    externalTaskRef: optional(options, "--external-task-ref") ?? null,
  };
}

function dispatchReadOnlyRunHandoff(args: readonly string[], root: string): boolean {
  const [group, action, ...rest] = args;
  if (group !== "run" || action === undefined || !action.startsWith("handoff-")) return false;
  if (action === "handoff-preview") {
    const options = parseOptions(rest, ["--correlation-id", "--external-task-ref"]);
    const runId = oneRunId(options);
    const source = readChangeHandoffSource(path.join(root, "icarus.sqlite3"), runId);
    const preview = buildChangeHandoffPreview(source, handoffRequest(options));
    process.stdout.write(preview.payloadBytes);
    process.stderr.write(
      `${JSON.stringify({
        payloadSha256: preview.payloadSha256,
        previewSha256: preview.previewSha256,
      })}\n`,
    );
    return true;
  }
  if (action === "handoff-export") {
    const options = parseOptions(rest, [
      "--correlation-id",
      "--external-task-ref",
      "--expected-preview-sha256",
      "--output-dir",
    ]);
    const runId = oneRunId(options);
    const source = readChangeHandoffSource(path.join(root, "icarus.sqlite3"), runId);
    const preview = buildChangeHandoffPreview(source, handoffRequest(options));
    assertExpectedChangeHandoffPreview(preview, required(options, "--expected-preview-sha256"));
    const result = createChangeHandoffExportResult(preview);
    writeChangeHandoffFiles(
      required(options, "--output-dir"),
      preview.payloadBytes,
      encodeChangeHandoffExportResult(result),
    );
    print(result);
    return true;
  }
  usage();
}

function usage(): never {
  fail(
    "USAGE",
    [
      "icarus init",
      "icarus repo add --name NAME --path PATH",
      "icarus repo list",
      "icarus project add --name NAME --repo REPO --base-ref REF --sandbox-image IMAGE --check JSON",
      "icarus project list",
      "icarus run plan --project NAME --task TEXT --target PATH [--target PATH ...] --provider ollama|openai|anthropic|vulcan --model MODEL [provider options]",
      "icarus run approve-egress RUN --context-sha SHA --actor ACTOR",
      "icarus run approve RUN --plan-sha SHA --actor ACTOR",
      "icarus run approve-headless RUN --plan-sha SHA --actor ACTOR --profile-json JSON --provider-catalog-json JSON [--output-format history|stream-json]",
      "icarus run reconcile-headless RUN [--output-format history|stream-json]",
      "icarus run reconstruct-headless RUN",
      "icarus run resume-headless RUN [--output-format history|stream-json]",
      "icarus run status RUN",
      "icarus run list [--project NAME]",
      "icarus run history RUN [--format json|jsonl|stream-json]",
      "icarus run handoff-preview RUN --correlation-id ID [--external-task-ref REF]",
      "icarus run handoff-export RUN --correlation-id ID [--external-task-ref REF] --expected-preview-sha256 SHA --output-dir DIR",
      "icarus handoff verify --input FILE",
      "icarus handoff inspect --input FILE",
      "icarus bench compare --target PROVIDER:MODEL [--target ...] [--kind KIND ...] [--base-url URL] [--repeat N]",
      "icarus live-evidence digest --input PROFILE_DRAFT",
      "icarus live-evidence approve --input PROFILE_DRAFT --manifest MANIFEST --actor ACTOR",
      "icarus live-evidence inspect --input APPROVED_PROFILE --manifest MANIFEST",
      "icarus live-evidence execute --input APPROVED_PROFILE --manifest MANIFEST --runs RUN_MAP",
      "icarus live-evidence resume RESUME_ID --input APPROVED_PROFILE --manifest MANIFEST --runs RUN_MAP",
      "icarus live-evidence verify --input APPROVED_PROFILE --manifest MANIFEST",
      "icarus run review RUN --decision approve|reject --diff-sha SHA --actor ACTOR",
      "icarus run rollback RUN --diff-sha SHA --actor ACTOR",
      "icarus run restore RUN --checkpoint-sha SHA --actor ACTOR",
      "icarus run resume RUN",
      "icarus run annotate RUN --card CARD|room --text TEXT --actor ACTOR",
      "icarus run annotations RUN",
      "icarus run cancel RUN --actor ACTOR",
      "icarus probe throughput|context|structured --model MODEL [--provider ollama|openai|anthropic|vulcan] [--base-url URL] [--repeat N] [--max-output-tokens N] [--timeout-ms MS] [--target-input-tokens N]",
      "icarus landing profile-set --project NAME --owner OWNER --repository REPOSITORY --base-branch BRANCH --credential-env ENV_NAME --expected-actor ACTOR --commit-name NAME --commit-email EMAIL --derivative-effects-disposition inert-repository|operator-approved --derivative-effects-evidence-sha SHA",
      "icarus landing profile-show --project NAME",
      "icarus landing prepare RUN --commit-message TEXT --pr-title TEXT --pr-body-prefix TEXT",
      "icarus landing status RUN",
      "icarus landing decide RUN --landing-sha SHA --decision approve|reject --actor ACTOR",
      "icarus landing resume RUN",
    ].join("\n"),
  );
}

// Probes run before runtime creation on purpose: a probe's entire effect is
// one HTTP conversation with the configured provider plus a printed row, so it
// must not create or open the state root, store, or controller directories.
async function dispatchProbe(args: readonly string[], signal: AbortSignal): Promise<boolean> {
  const [group, action, ...rest] = args;
  if (group !== "probe" || action === undefined) {
    return false;
  }
  const options = parseOptions(rest, [
    "--provider",
    "--model",
    "--base-url",
    "--repeat",
    "--max-output-tokens",
    "--timeout-ms",
    "--target-input-tokens",
  ]);
  noPositionals(options);
  const kind = optional(options, "--provider") ?? "ollama";
  if (kind !== "ollama" && kind !== "openai" && kind !== "anthropic" && kind !== "vulcan") {
    fail("INVALID_PROVIDER", "--provider must be ollama, openai, anthropic, or vulcan");
  }
  const defaultBaseUrls: Record<typeof kind, string> = {
    ollama: "http://127.0.0.1:11434/",
    openai: "https://api.openai.com/v1/",
    anthropic: "https://api.anthropic.com/v1/",
    vulcan: "http://127.0.0.1:8140/v1/",
  };
  const model = required(options, "--model");
  const baseUrl = optional(options, "--base-url") ?? defaultBaseUrls[kind];
  const request = createProbeRequest({
    kind: action,
    repeat: numberOption(options, "--repeat"),
    maxOutputTokens: numberOption(options, "--max-output-tokens"),
    timeoutMs: numberOption(options, "--timeout-ms"),
    targetInputTokens: numberOption(options, "--target-input-tokens") ?? null,
  });
  // Answer recognized-but-unsupported kinds before any provider construction.
  // createProviderConfig enforces pricing and credential policy for remote
  // providers, so building it first made the unsupported contract true only
  // for Ollama — the answer must not depend on the provider it never contacts.
  if (isUnsupportedProbeKind(request.kind)) {
    print(unsupportedProbeResult(request, { kind, baseUrl, model }));
    return true;
  }
  const provider = createProviderConfig({ kind, model, baseUrl });
  print(await runProbe(createGateway(provider, process.env), request, {}, signal));
  return true;
}

const PROBE_PROVIDER_KINDS = ["ollama", "openai", "anthropic", "vulcan"] as const;

type ProbeProviderKind = (typeof PROBE_PROVIDER_KINDS)[number];

const PROBE_DEFAULT_BASE_URLS: Record<ProbeProviderKind, string> = {
  ollama: "http://127.0.0.1:11434/",
  openai: "https://api.openai.com/v1/",
  anthropic: "https://api.anthropic.com/v1/",
  vulcan: "http://127.0.0.1:8140/v1/",
};

/**
 * `--target <provider>:<model>`, split on the FIRST colon only.
 *
 * Provider kinds are a closed set containing no colon, and model names very
 * often do (`qwen3.8:27b`), so first-colon is the only split that reads both
 * halves correctly. Splitting on the last colon would silently retarget
 * `ollama:qwen3.8:27b` at a provider named `ollama:qwen3.8`.
 *
 * Base URL defaults per kind. `--base-url` overrides it for the whole battery
 * and is refused when the targets span more than one provider kind, because one
 * URL cannot be correct for two different providers and silently applying it to
 * both would point half the document at the wrong machine.
 */
function parseBenchTarget(raw: string, baseUrlOverride: string | undefined): BenchTargetV1 {
  const separator = raw.indexOf(":");
  if (separator <= 0 || separator === raw.length - 1) {
    fail("INVALID_BENCH_TARGET", `--target must be <provider>:<model>, got ${raw}`);
  }
  const kind = raw.slice(0, separator);
  const model = raw.slice(separator + 1);
  if (!(PROBE_PROVIDER_KINDS as readonly string[]).includes(kind)) {
    fail(
      "INVALID_BENCH_TARGET",
      `--target provider must be one of ${PROBE_PROVIDER_KINDS.join(", ")}`,
    );
  }
  return {
    kind,
    baseUrl: baseUrlOverride ?? PROBE_DEFAULT_BASE_URLS[kind as ProbeProviderKind],
    model,
  };
}

async function dispatchBench(args: readonly string[], signal: AbortSignal): Promise<boolean> {
  const [group, action, ...rest] = args;
  if (group !== "bench" || action !== "compare") {
    return false;
  }
  const options = parseOptions(rest, [
    "--target",
    "--kind",
    "--base-url",
    "--repeat",
    "--max-output-tokens",
    "--timeout-ms",
    "--target-input-tokens",
  ]);
  noPositionals(options);
  const rawTargets = options.values.get("--target") ?? [];
  if (rawTargets.length === 0) {
    fail("INVALID_BENCH_TARGET", "bench compare needs at least one --target <provider>:<model>");
  }
  const baseUrlOverride = optional(options, "--base-url");
  if (baseUrlOverride !== undefined) {
    const kinds = new Set(rawTargets.map((raw) => raw.slice(0, Math.max(raw.indexOf(":"), 0))));
    if (kinds.size > 1) {
      fail(
        "INVALID_BENCH_TARGET",
        "--base-url applies to every target, so it cannot be used with mixed provider kinds",
      );
    }
  }
  const targets = rawTargets.map((raw) => parseBenchTarget(raw, baseUrlOverride));
  const kinds = options.values.get("--kind") ?? [...PROBE_KINDS];
  print(
    await runBenchComparison({
      targets,
      kinds,
      request: {
        repeat: numberOption(options, "--repeat"),
        maxOutputTokens: numberOption(options, "--max-output-tokens"),
        timeoutMs: numberOption(options, "--timeout-ms"),
        targetInputTokens: numberOption(options, "--target-input-tokens") ?? null,
      },
      // Constructed per row so a credential or pricing policy failure for one
      // target is that row's recorded failure, not a refusal of the battery.
      gatewayFor: (target) =>
        createGateway(
          createProviderConfig({
            kind: target.kind as ProbeProviderKind,
            model: target.model,
            baseUrl: target.baseUrl,
          }),
          process.env,
        ),
      signal,
    }),
  );
  return true;
}

async function dispatchLiveEvidenceExecution(
  runtime: IcarusRuntime,
  args: readonly string[],
  root: string,
  signal: AbortSignal,
): Promise<boolean> {
  const [group, action, ...rest] = args;
  if (group !== "live-evidence" || (action !== "execute" && action !== "resume")) return false;
  const options = parseOptions(rest, ["--input", "--manifest", "--runs"]);
  const resumeId = action === "resume" ? oneRunId(options) : randomUUID();
  if (action === "execute") noPositionals(options);
  const profile = decodeLiveEvidenceProfileV1(parseLiveEvidenceJson(required(options, "--input")));
  const manifestBytes = readStableOwnedInput(required(options, "--manifest"), false);
  const runMap = decodeLiveEvidenceCaseRunMapV1(
    parseLiveEvidenceJson(required(options, "--runs")),
    profile,
    manifestBytes,
  );
  const leases = new RunLeaseManager(root);
  await leases.initialize();
  const terminal = await leases.withLease(resumeId, () =>
    runLiveEvidenceExecutor({
      mode: action === "execute" ? "start" : "resume",
      ...(action === "execute" ? { createResumeId: () => resumeId } : { resumeId }),
      profile,
      manifestBytes,
      environment: process.env,
      journalStore: new FileLiveEvidenceJournalStore(root),
      driver: new ExistingRunsLiveEvidenceCaseDriver(runtime.service, runMap, manifestBytes),
      eventSink: (event) => process.stdout.write(canonicalJsonLine(event)),
      signal,
    }),
  );
  if (terminal.outcome === "blocked") process.exitCode = 3;
  if (terminal.outcome === "interrupted") process.exitCode = 130;
  if (terminal.outcome === "failed") process.exitCode = 1;
  return true;
}

async function dispatch(
  runtime: IcarusRuntime,
  args: readonly string[],
  signal: AbortSignal,
): Promise<void> {
  const [group, action, ...rest] = args;
  if (group === "init" && action === undefined) {
    print({ stateRoot: stateRoot(), initialized: true });
    return;
  }
  if (group === "repo" && action === "add") {
    const options = parseOptions(rest, ["--name", "--path"]);
    noPositionals(options);
    print(
      await runtime.service.registerRepository(
        required(options, "--name"),
        required(options, "--path"),
        signal,
      ),
    );
    return;
  }
  if (group === "repo" && action === "list") {
    const options = parseOptions(rest, []);
    noPositionals(options);
    print(runtime.service.listRepositories());
    return;
  }
  if (group === "project" && action === "add") {
    const options = parseOptions(rest, [
      "--name",
      "--repo",
      "--base-ref",
      "--sandbox-image",
      "--check",
    ]);
    noPositionals(options);
    const checks = (options.values.get("--check") ?? []).map(parseCheck);
    print(
      runtime.service.createProject({
        name: required(options, "--name"),
        repositoryName: required(options, "--repo"),
        baseRef: required(options, "--base-ref"),
        checks,
        sandbox: {
          image: required(options, "--sandbox-image"),
          ...DEFAULT_SANDBOX_LIMITS,
        },
        ceiling: DEFAULT_CEILING,
      }),
    );
    return;
  }
  if (group === "project" && action === "list") {
    const options = parseOptions(rest, []);
    noPositionals(options);
    print(runtime.service.listProjects());
    return;
  }
  if (group === "landing" && action === "profile-set") {
    const options = parseOptions(rest, [
      "--project",
      "--owner",
      "--repository",
      "--base-branch",
      "--credential-env",
      "--expected-actor",
      "--commit-name",
      "--commit-email",
      "--derivative-effects-disposition",
      "--derivative-effects-evidence-sha",
    ]);
    noPositionals(options);
    print(
      runtime.service.setLandingProfile(required(options, "--project"), landingProfile(options)),
    );
    return;
  }
  if (group === "landing" && action === "profile-show") {
    const options = parseOptions(rest, ["--project"]);
    noPositionals(options);
    print(runtime.service.getLandingProfile(required(options, "--project")));
    return;
  }
  if (group === "landing" && action === "prepare") {
    const options = parseOptions(rest, ["--commit-message", "--pr-title", "--pr-body-prefix"]);
    print(
      presentLandingStatusV1(
        await runtime.service.prepareLanding(
          {
            runId: oneRunId(options),
            commitMessage: required(options, "--commit-message"),
            pullRequestTitle: required(options, "--pr-title"),
            pullRequestBodyPrefix: required(options, "--pr-body-prefix"),
          },
          signal,
        ),
      ),
    );
    return;
  }
  if (group === "landing" && action === "status") {
    const options = parseOptions(rest, []);
    print(presentLandingStatusV1(runtime.service.getLandingStatus(oneRunId(options))));
    return;
  }
  if (group === "landing" && action === "decide") {
    const options = parseOptions(rest, ["--landing-sha", "--decision", "--actor"]);
    const decision = required(options, "--decision");
    if (decision !== "approve" && decision !== "reject") {
      fail("INVALID_DECISION", "--decision must be approve or reject");
    }
    print(
      presentLandingStatusV1(
        await runtime.service.decideLanding(
          oneRunId(options),
          required(options, "--landing-sha"),
          required(options, "--actor"),
          decision,
        ),
      ),
    );
    return;
  }
  if (group === "landing" && action === "resume") {
    const options = parseOptions(rest, []);
    print(presentLandingStatusV1(await runtime.service.resumeLanding(oneRunId(options), signal)));
    return;
  }
  if (group !== "run" || action === undefined) {
    usage();
  }
  if (action === "plan") {
    const options = parseOptions(rest, [
      "--project",
      "--task",
      "--target",
      "--provider",
      "--model",
      "--base-url",
      "--input-usd-per-million",
      "--output-usd-per-million",
    ]);
    noPositionals(options);
    const kind = required(options, "--provider");
    if (kind !== "ollama" && kind !== "openai" && kind !== "anthropic" && kind !== "vulcan") {
      fail("INVALID_PROVIDER", "--provider must be ollama, openai, anthropic, or vulcan");
    }
    const defaultBaseUrls: Record<typeof kind, string> = {
      ollama: "http://127.0.0.1:11434/",
      openai: "https://api.openai.com/v1/",
      anthropic: "https://api.anthropic.com/v1/",
      vulcan: "http://127.0.0.1:8140/v1/",
    };
    const baseUrl = optional(options, "--base-url") ?? defaultBaseUrls[kind];
    const inputRate = numberOption(options, "--input-usd-per-million");
    const outputRate = numberOption(options, "--output-usd-per-million");
    const provider = createProviderConfig({
      kind,
      model: required(options, "--model"),
      baseUrl,
      ...(inputRate === undefined ? {} : { inputUsdPerMillionTokens: inputRate }),
      ...(outputRate === undefined ? {} : { outputUsdPerMillionTokens: outputRate }),
    });
    print(
      publicRun(
        await runtime.service.planRun(
          {
            projectName: required(options, "--project"),
            task: required(options, "--task"),
            targets: requiredAll(options, "--target"),
            provider,
          },
          signal,
        ),
      ),
    );
    return;
  }
  if (action === "approve-egress") {
    const options = parseOptions(rest, ["--context-sha", "--actor"]);
    print(
      publicRun(
        await runtime.service.approveEgress(
          oneRunId(options),
          required(options, "--context-sha"),
          required(options, "--actor"),
          signal,
        ),
      ),
    );
    return;
  }
  if (action === "approve") {
    const options = parseOptions(rest, ["--plan-sha", "--actor"]);
    print(
      publicRun(
        await runtime.service.approvePlan(
          oneRunId(options),
          required(options, "--plan-sha"),
          required(options, "--actor"),
          signal,
        ),
      ),
    );
    return;
  }
  if (action === "approve-headless") {
    const options = parseOptions(rest, [
      "--plan-sha",
      "--actor",
      "--profile-json",
      "--provider-catalog-json",
      "--output-format",
    ]);
    const providerCatalog = boundedJsonOption(options, "--provider-catalog-json", 256 * 1024);
    if (!Array.isArray(providerCatalog)) {
      fail("INVALID_ARGUMENT", "--provider-catalog-json must be a JSON array");
    }
    // An invalid output format is an argument error and must fail before any
    // execution effect, never after the worker has settled.
    const outputFormat = headlessOutputFormat(options);
    const result = await runtime.service.approveHeadlessPlan(
      oneRunId(options),
      required(options, "--plan-sha"),
      required(options, "--actor"),
      boundedJsonOption(options, "--profile-json", 256 * 1024),
      providerCatalog as readonly HeadlessHostProviderProfileV1[],
      signal,
    );
    emitRunTrajectory(runtime, result.run.id, outputFormat);
    process.exitCode = result.settlement.exitCode;
    return;
  }
  if (action === "reconcile-headless") {
    const options = parseOptions(rest, ["--output-format"]);
    const outputFormat = headlessOutputFormat(options);
    const result = await runtime.service.reconcileHeadlessWorker(oneRunId(options));
    emitRunTrajectory(runtime, result.run.id, outputFormat);
    process.exitCode = result.settlement.exitCode;
    return;
  }
  if (action === "reconstruct-headless") {
    const options = parseOptions(rest, []);
    // H3b evidence reconstruction is a pure projection: it reads the durable
    // snapshot and prints one canonical metadata record without appending an
    // event, settling an operation, or recording resume intent (ADR 0057).
    const result = runtime.service.reconstructHeadlessEvidence(oneRunId(options));
    process.stdout.write(canonicalJsonLine(result as unknown as JsonValue));
    return;
  }
  if (action === "resume-headless") {
    const options = parseOptions(rest, ["--output-format"]);
    const outputFormat = headlessOutputFormat(options);
    // H3b governed continuation (ADR 0058): the service holds the run lease,
    // proves reconstruction and replay safety, records resume intent, and
    // settles exactly once. A settled worker returns its durable settlement.
    const result = await runtime.service.resumeHeadlessWorker(oneRunId(options), signal);
    emitRunTrajectory(runtime, result.run.id, outputFormat);
    process.exitCode = result.settlement.exitCode;
    return;
  }
  if (action === "status") {
    const options = parseOptions(rest, [], ["--json"]);
    print(publicRun(runtime.service.getRun(oneRunId(options))));
    return;
  }
  if (action === "list") {
    const options = parseOptions(rest, ["--project"]);
    noPositionals(options);
    print(runtime.service.listRuns(optional(options, "--project")).map(publicRun));
    return;
  }
  if (action === "history") {
    const options = parseOptions(rest, ["--format"]);
    const format = optional(options, "--format") ?? "json";
    if (format !== "json" && format !== "jsonl" && format !== "stream-json") {
      fail("INVALID_ARGUMENT", "--format must be json, jsonl, or stream-json");
    }
    if (format === "jsonl" || format === "stream-json") {
      emitRunTrajectory(
        runtime,
        oneRunId(options),
        format === "stream-json" ? "stream-json" : "history",
      );
      return;
    }
    const history = runtime.service.history(oneRunId(options));
    print({
      run: publicRun(history.run),
      approvals: history.approvals,
      events: history.events,
    });
    return;
  }
  if (action === "review") {
    const options = parseOptions(rest, ["--decision", "--diff-sha", "--actor"]);
    const decision = required(options, "--decision");
    if (decision !== "approve" && decision !== "reject") {
      fail("INVALID_DECISION", "--decision must be approve or reject");
    }
    print(
      publicRun(
        await runtime.service.review(
          oneRunId(options),
          decision,
          required(options, "--diff-sha"),
          required(options, "--actor"),
          signal,
        ),
      ),
    );
    return;
  }
  if (action === "rollback") {
    const options = parseOptions(rest, ["--diff-sha", "--actor"]);
    print(
      publicRun(
        await runtime.service.rollback(
          oneRunId(options),
          required(options, "--diff-sha"),
          required(options, "--actor"),
          signal,
        ),
      ),
    );
    return;
  }
  if (action === "restore") {
    const options = parseOptions(rest, ["--checkpoint-sha", "--actor"]);
    print(
      publicRun(
        await runtime.service.restore(
          oneRunId(options),
          required(options, "--checkpoint-sha"),
          required(options, "--actor"),
          signal,
        ),
      ),
    );
    return;
  }
  if (action === "resume") {
    const options = parseOptions(rest, []);
    print(publicRun(await runtime.service.resume(oneRunId(options), signal)));
    return;
  }
  if (action === "annotate") {
    const options = parseOptions(rest, ["--card", "--text", "--actor"]);
    print(
      runtime.service.annotateRun(
        oneRunId(options),
        required(options, "--card") as ChangeRoomAnnotationTarget,
        required(options, "--actor"),
        required(options, "--text"),
      ),
    );
    return;
  }
  if (action === "annotations") {
    const options = parseOptions(rest, []);
    print(runtime.service.listRunAnnotations(oneRunId(options)));
    return;
  }
  if (action === "cancel") {
    const options = parseOptions(rest, ["--actor"]);
    print(publicRun(await runtime.service.cancel(oneRunId(options), required(options, "--actor"))));
    return;
  }
  usage();
}

export async function runCliMain(options: CliMainOptions = {}): Promise<void> {
  const controller = new AbortController();
  const abort = (): void => controller.abort(new Error("Operator interrupted Icarus"));
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  let runtime: IcarusRuntime | undefined;
  try {
    const args = options.args ?? process.argv.slice(2);
    if (dispatchFileOnlyHandoff(args)) return;
    if (await dispatchProbe(args, controller.signal)) return;
    if (await dispatchBench(args, controller.signal)) return;
    assertLandingMutationPlatform(args, options.platform ?? process.platform);
    if (dispatchFileOnlyLiveEvidence(args, options.now ?? (() => new Date().toISOString()))) return;
    const root = stateRoot();
    if (dispatchReadOnlyRunHandoff(args, root)) return;
    const registrationPath = registrationPathForPreflight(args);
    if (registrationPath !== undefined) {
      await assertRegistrationStateSeparation(root, registrationPath);
    }
    const migrationApproval = schemaMigrationApproval();
    if (migrationApproval.gate1 !== null) {
      migrateGate1Schema(path.join(root, "icarus.sqlite3"), migrationApproval.gate1);
      print({ migration: migrationApproval.gate1, status: "applied" });
      return;
    }
    runtime = await (options.createRuntime ?? createIcarusRuntime)(root, {
      allowApprovalIndexMigration: migrationApproval.approvalIndex,
      allowPatchSetMigration: migrationApproval.patchSet,
      allowReadableManifestMigration: migrationApproval.readableManifest,
      allowAnnotationMigration: migrationApproval.annotation,
      allowHeadlessChildMigration: migrationApproval.headlessChildren,
      landingCredentialEnvironmentNames: landingCredentialEnvironmentAllowlist(),
    });
    if (await dispatchLiveEvidenceExecution(runtime, args, root, controller.signal)) return;
    await dispatch(runtime, args, controller.signal);
  } catch (error) {
    const code = error instanceof IcarusError ? error.code : "INTERNAL_ERROR";
    const message = error instanceof Error ? error.message : String(error);
    const runId = error instanceof IcarusError ? error.details.runId : undefined;
    const safeRunId =
      typeof runId === "string" &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(runId)
        ? runId
        : undefined;
    process.stderr.write(
      `${JSON.stringify({ error: { code, message, ...(safeRunId === undefined ? {} : { runId: safeRunId }) } }, null, 2)}\n`,
    );
    process.exitCode = code === "USAGE" || code.startsWith("INVALID") ? 2 : 1;
  } finally {
    runtime?.close();
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}

function isDirectExecution(): boolean {
  const entryPath = process.argv[1];
  if (entryPath === undefined) return false;
  try {
    return realpathSync(entryPath) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectExecution()) await runCliMain();
