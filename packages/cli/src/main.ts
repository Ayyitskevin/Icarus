#!/usr/bin/env node

import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertExpectedChangeHandoffPreview,
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
  createHeadlessHistoryLines,
  createIcarusRuntime,
  createProviderConfig,
  DEFAULT_CEILING,
  DEFAULT_SANDBOX_LIMITS,
  encodeChangeHandoffExportResult,
  type Gate1MigrationToken,
  type GitHubLandingProfileV1,
  IcarusError,
  type IcarusRuntime,
  inspectChangeHandoffDocuments,
  type JsonValue,
  LANDING_LEDGER_MIGRATION,
  migrateGate1Schema,
  presentLandingStatusV1,
  type RunRecord,
  readChangeHandoffSource,
  readSecureHandoffFile,
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
  readonly gate1: Gate1MigrationToken | null;
} {
  const none = {
    approvalIndex: false,
    patchSet: false,
    readableManifest: false,
    annotation: false,
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
    group === "landing" &&
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
      "icarus run plan --project NAME --task TEXT --target PATH [--target PATH ...] --provider ollama|openai|anthropic --model MODEL [provider options]",
      "icarus run approve-egress RUN --context-sha SHA --actor ACTOR",
      "icarus run approve RUN --plan-sha SHA --actor ACTOR",
      "icarus run status RUN",
      "icarus run list [--project NAME]",
      "icarus run history RUN [--format json|jsonl]",
      "icarus run handoff-preview RUN --correlation-id ID [--external-task-ref REF]",
      "icarus run handoff-export RUN --correlation-id ID [--external-task-ref REF] --expected-preview-sha256 SHA --output-dir DIR",
      "icarus handoff verify --input FILE",
      "icarus handoff inspect --input FILE",
      "icarus run review RUN --decision approve|reject --diff-sha SHA --actor ACTOR",
      "icarus run rollback RUN --diff-sha SHA --actor ACTOR",
      "icarus run restore RUN --checkpoint-sha SHA --actor ACTOR",
      "icarus run resume RUN",
      "icarus run annotate RUN --card CARD|room --text TEXT --actor ACTOR",
      "icarus run annotations RUN",
      "icarus run cancel RUN --actor ACTOR",
      "icarus landing profile-set --project NAME --owner OWNER --repository REPOSITORY --base-branch BRANCH --credential-env ENV_NAME --expected-actor ACTOR --commit-name NAME --commit-email EMAIL --derivative-effects-disposition inert-repository|operator-approved --derivative-effects-evidence-sha SHA",
      "icarus landing profile-show --project NAME",
      "icarus landing prepare RUN --commit-message TEXT --pr-title TEXT --pr-body-prefix TEXT",
      "icarus landing status RUN",
      "icarus landing decide RUN --landing-sha SHA --decision approve|reject --actor ACTOR",
      "icarus landing resume RUN",
    ].join("\n"),
  );
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
    if (kind !== "ollama" && kind !== "openai" && kind !== "anthropic") {
      fail("INVALID_PROVIDER", "--provider must be ollama, openai, or anthropic");
    }
    const defaultBaseUrls: Record<typeof kind, string> = {
      ollama: "http://127.0.0.1:11434/",
      openai: "https://api.openai.com/v1/",
      anthropic: "https://api.anthropic.com/v1/",
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
    const history = runtime.service.history(oneRunId(options));
    const format = optional(options, "--format") ?? "json";
    if (format === "jsonl") {
      const lines = createHeadlessHistoryLines(
        history.run.id,
        publicRun(history.run) as JsonValue,
        history.approvals,
        history.events,
      );
      for (const line of lines) process.stdout.write(canonicalJsonLine(line));
      return;
    }
    if (format !== "json") {
      fail("INVALID_ARGUMENT", "--format must be json or jsonl");
    }
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
    assertLandingMutationPlatform(args, options.platform ?? process.platform);
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
      landingCredentialEnvironmentNames: landingCredentialEnvironmentAllowlist(),
    });
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
