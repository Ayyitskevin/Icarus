#!/usr/bin/env node

import os from "node:os";
import path from "node:path";

import {
  createIcarusRuntime,
  createProviderConfig,
  DEFAULT_CEILING,
  DEFAULT_SANDBOX_LIMITS,
  IcarusError,
  type CheckProfile,
  type IcarusRuntime,
  type RunRecord,
} from "@icarus/core";

interface ParsedOptions {
  readonly positionals: readonly string[];
  readonly values: ReadonlyMap<string, readonly string[]>;
  readonly booleans: ReadonlySet<string>;
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
    edit:
      run.edit === null
        ? null
        : {
            path: run.edit.path,
            expectedPreimageSha256: run.edit.expectedPreimageSha256,
            rationale: run.edit.rationale,
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

function usage(): never {
  fail(
    "USAGE",
    [
      "icarus init",
      "icarus repo add --name NAME --path PATH",
      "icarus repo list",
      "icarus project add --name NAME --repo REPO --base-ref REF --sandbox-image IMAGE --check JSON",
      "icarus project list",
      "icarus run plan --project NAME --task TEXT --target PATH --provider ollama|openai --model MODEL [provider options]",
      "icarus run approve-egress RUN --context-sha SHA --actor ACTOR",
      "icarus run approve RUN --plan-sha SHA --actor ACTOR",
      "icarus run status RUN",
      "icarus run list [--project NAME]",
      "icarus run history RUN",
      "icarus run review RUN --decision approve|reject --diff-sha SHA --actor ACTOR",
      "icarus run rollback RUN --diff-sha SHA --actor ACTOR",
      "icarus run restore RUN --checkpoint-sha SHA --actor ACTOR",
      "icarus run resume RUN",
      "icarus run cancel RUN --actor ACTOR",
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
    if (kind !== "ollama" && kind !== "openai") {
      fail("INVALID_PROVIDER", "--provider must be ollama or openai");
    }
    const baseUrl =
      optional(options, "--base-url") ??
      (kind === "ollama" ? "http://127.0.0.1:11434/" : "https://api.openai.com/v1/");
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
            target: required(options, "--target"),
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
    const options = parseOptions(rest, []);
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
  if (action === "cancel") {
    const options = parseOptions(rest, ["--actor"]);
    print(publicRun(await runtime.service.cancel(oneRunId(options), required(options, "--actor"))));
    return;
  }
  usage();
}

async function main(): Promise<void> {
  const controller = new AbortController();
  const abort = (): void => controller.abort(new Error("Operator interrupted Icarus"));
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  let runtime: IcarusRuntime | undefined;
  try {
    runtime = await createIcarusRuntime(stateRoot());
    await dispatch(runtime, process.argv.slice(2), controller.signal);
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

await main();
