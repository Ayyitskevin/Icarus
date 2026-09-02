import { spawnSync } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { ArtifactStore } from "../../packages/core/src/artifacts.js";
import { sha256 } from "../../packages/core/src/digest.js";
import { IcarusError } from "../../packages/core/src/errors.js";
import type {
  GitController,
  PrivateWorkspace,
  RepositoryInspection,
  TreeEntry,
} from "../../packages/core/src/git.js";
import {
  DEFAULT_CEILING,
  DEFAULT_SANDBOX_LIMITS,
  MAX_SESSION_ITERATIONS,
  planApprovalDigest,
} from "../../packages/core/src/policy.js";
import {
  createProviderConfig,
  type ModelGateway,
  type StructuredGenerationRequest,
} from "../../packages/core/src/provider.js";
import type { CheckRunInput, CheckRunner } from "../../packages/core/src/sandbox.js";
import { IcarusService } from "../../packages/core/src/service.js";
import { IcarusStore, SESSION_ITERATION_OPERATION_KIND } from "../../packages/core/src/store.js";
import type {
  CheckEvidence,
  CheckProfile,
  JsonValue,
  PlanProposal,
  ProviderConfig,
  SunCeiling,
} from "../../packages/core/src/types.js";
import { syntheticReportedIdentity } from "../support/provider-result.js";

const TARGET = "src/greeting.txt";
const LARGE_READ_TARGET = "src/large.txt";
const BASELINE = "Hello, world!\n";
/** The first attempt: applies cleanly but fails the registered check. */
const BROKEN = "Hello, Icrus!\n";
/** The revision the repair iteration is expected to converge on. */
const FIXED = "Hello, Icarus!\n";
const BASE_COMMIT = "b".repeat(40);
const IMAGE = `python@sha256:${"c".repeat(64)}`;
const LARGE_READ_OBJECT_ID = "e".repeat(40);
const CHECK_STDOUT_CANARY = "private-check-stdout-canary-icarus";
const CHECK_STDERR_CANARY = "private-check-stderr-canary-icarus";

interface TestDatabase {
  prepare(sql: string): {
    run(...parameters: readonly unknown[]): unknown;
    get(...parameters: readonly unknown[]): unknown;
  };
  close(): void;
}

const Database = createRequire(new URL("../../packages/core/package.json", import.meta.url))(
  "better-sqlite3",
) as new (
  filename: string,
) => TestDatabase;

// The shipped default tool-call ceiling is deliberately NOT raised here: a run
// that spends the whole repair grant must fit inside it, and the measured
// local/remote/resumed headroom is only meaningful if this suite re-measures it.
const CEILING: SunCeiling = {
  ...DEFAULT_CEILING,
  maxActiveRuntimeMs: 120_000,
  commandTimeoutMs: 5_000,
  providerTimeoutMs: 5_000,
  maxOutputTokensPerCall: 512,
  maxTotalTokens: 50_000,
};

const cleanupRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

/**
 * The smallest git surface `IcarusService` exercises, backed by a real
 * directory so patch-set application, baseline restoration, and drift
 * detection all run against actual bytes.
 */
class ControlledGit {
  #injectedDiffFailure = false;

  constructor(
    readonly repositoryPath: string,
    readonly failDiffOnceFor: string | null = null,
    readonly failDiffCode = "SYNTHETIC_DIFF_FAILURE",
    readonly readableManifestEntries = 1,
    readonly readableManifestPathBytes = 0,
    readonly readableFileContentBytes = 0,
  ) {}

  inspectRepository(): Promise<RepositoryInspection> {
    return Promise.resolve({
      canonicalPath: this.repositoryPath,
      device: 1,
      inode: 2,
      head: BASE_COMMIT,
    });
  }

  resolveCommit(): Promise<string> {
    return Promise.resolve(BASE_COMMIT);
  }

  assertCleanAtCommit(): Promise<void> {
    return Promise.resolve();
  }

  listTree(): Promise<TreeEntry[]> {
    const entries: TreeEntry[] = [
      { mode: "100644", type: "blob", objectId: "d".repeat(40), path: TARGET },
    ];
    if (this.readableFileContentBytes > 0) {
      entries.push({
        mode: "100644",
        type: "blob",
        objectId: LARGE_READ_OBJECT_ID,
        path: LARGE_READ_TARGET,
      });
    }
    for (let index = 1; index < this.readableManifestEntries; index += 1) {
      const prefix = `src/manifest-${String(index).padStart(3, "0")}-`;
      const suffix = "x".repeat(Math.max(1, this.readableManifestPathBytes - prefix.length - 4));
      entries.push({
        mode: "100644",
        type: "blob",
        objectId: "d".repeat(40),
        path: `${prefix}${suffix}.txt`,
      });
    }
    return Promise.resolve(entries);
  }

  readBlob(_repositoryPath: string, objectId: string): Promise<Buffer> {
    return Promise.resolve(
      objectId === LARGE_READ_OBJECT_ID
        ? Buffer.from("x".repeat(this.readableFileContentBytes), "utf8")
        : Buffer.from(BASELINE, "utf8"),
    );
  }

  async createPrivateWorkspace(
    _sourceRepository: string,
    _commit: string,
    runRoot: string,
  ): Promise<PrivateWorkspace> {
    const cachePath = path.join(runRoot, "git-cache.git");
    const worktreePath = path.join(runRoot, "worktree");
    await mkdir(cachePath, { recursive: true, mode: 0o700 });
    await mkdir(path.join(worktreePath, "src"), { recursive: true, mode: 0o700 });
    await writeFile(path.join(worktreePath, TARGET), BASELINE, "utf8");
    if (this.readableFileContentBytes > 0) {
      await writeFile(
        path.join(worktreePath, LARGE_READ_TARGET),
        "x".repeat(this.readableFileContentBytes),
        "utf8",
      );
    }
    return { cachePath, worktreePath };
  }

  readRegularUtf8File(worktreePath: string, target: string): Promise<string> {
    return readFile(path.join(worktreePath, target), "utf8");
  }

  async readOptionalRegularUtf8File(worktreePath: string, target: string): Promise<string | null> {
    try {
      return await readFile(path.join(worktreePath, target), "utf8");
    } catch {
      return null;
    }
  }

  atomicWriteUtf8(worktreePath: string, target: string, value: string): Promise<void> {
    return writeFile(path.join(worktreePath, target), value, "utf8");
  }

  async applyFileWrites(
    worktreePath: string,
    writes: readonly { readonly path: string; readonly content: string | null }[],
  ): Promise<void> {
    for (const write of writes) {
      const absolute = path.join(worktreePath, write.path);
      if (write.content === null) {
        await rm(absolute, { force: true });
      } else {
        await mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
        await writeFile(absolute, write.content, "utf8");
      }
    }
  }

  stageIntentToAdd(): Promise<void> {
    return Promise.resolve();
  }

  resetIndex(): Promise<void> {
    return Promise.resolve();
  }

  async changedPaths(worktreePath: string): Promise<string[]> {
    const current = await this.readRegularUtf8File(worktreePath, TARGET);
    return current === BASELINE ? [] : [TARGET];
  }

  async diff(worktreePath: string): Promise<string> {
    const current = await this.readRegularUtf8File(worktreePath, TARGET);
    if (!this.#injectedDiffFailure && current === this.failDiffOnceFor) {
      this.#injectedDiffFailure = true;
      throw new IcarusError(
        this.failDiffCode,
        "Synthetic interruption after the session patch reached the private worktree",
      );
    }
    if (current === BASELINE) {
      throw new IcarusError("EMPTY_DIFF", "Synthetic worktree is clean");
    }
    return [
      `diff --git a/${TARGET} b/${TARGET}`,
      `--- a/${TARGET}`,
      `+++ b/${TARGET}`,
      `-${BASELINE.trimEnd()}`,
      `+${current.trimEnd()}`,
      "",
    ].join("\n");
  }
}

/** Passes only once the private worktree holds the corrected greeting. */
class ConvergingChecks implements CheckRunner {
  readonly observed: string[] = [];
  reconciliations = 0;
  runCount = 0;

  constructor(
    readonly failRunAt: number | null = null,
    readonly onRun: ((runCount: number) => void) | null = null,
    readonly privateOutput: {
      readonly stdout: string;
      readonly stderr: string;
      readonly truncated?: boolean;
    } | null = null,
  ) {}

  reconcile(): Promise<void> {
    this.reconciliations += 1;
    return Promise.resolve();
  }

  async runChecks(input: CheckRunInput): Promise<readonly CheckEvidence[]> {
    this.runCount += 1;
    this.onRun?.(this.runCount);
    input.signal?.throwIfAborted();
    if (this.runCount === this.failRunAt) {
      throw new IcarusError(
        "CANCELLED",
        "Synthetic process death while the registered checks were running",
      );
    }
    const current = await readFile(path.join(input.worktreePath, TARGET), "utf8");
    this.observed.push(current);
    const passed = current === FIXED;
    return input.checks.map((check) => ({
      checkId: check.id,
      argv: check.argv,
      exitCode: passed ? 0 : 1,
      signal: null,
      durationMs: 1,
      stdout: `${
        passed ? "ok\n" : `expected ${JSON.stringify(FIXED)}, saw ${JSON.stringify(current)}\n`
      }${this.privateOutput?.stdout ?? ""}`,
      stderr: this.privateOutput?.stderr ?? "",
      truncated: this.privateOutput?.truncated ?? false,
      outcome: passed ? "passed" : "failed",
    }));
  }
}

function patchSetProducing(replaceText: string): JsonValue {
  return patchSetFor(TARGET, BASELINE, replaceText);
}

function patchSetFor(target: string, baseline: string, replaceText: string): JsonValue {
  return {
    summary: "Apply the approved greeting.",
    edits: [
      {
        op: "modify",
        path: target,
        expectedPreimageSha256: sha256(baseline),
        replacements: [{ findText: baseline, replaceText }],
        content: null,
        rationale: "Replace one operator-selected file.",
      },
    ],
  };
}

const REPAIR_GRANTS: readonly JsonValue[] = [
  { kind: "read.manifest", scope: ["src/"], maxCalls: 4 },
  { kind: "read.checks", scope: ["verify"], maxCalls: 20 },
  { kind: "mutation.patchset", scope: [TARGET], maxCalls: 2 },
  { kind: "exec.check", scope: ["verify"], maxCalls: 1 },
];

function planProposal(
  iterationCeiling: number,
  grants: readonly JsonValue[] = iterationCeiling > 0 ? REPAIR_GRANTS : [],
): JsonValue {
  return {
    summary: "Replace the greeting.",
    steps: ["Apply one exact replacement.", "Run verification."],
    risks: ["The preimage may differ."],
    target: TARGET,
    targets: [TARGET],
    iterationCeiling,
    checkIds: ["verify"],
    grants: [...grants],
  };
}

function toolEnvelope(toolCalls: readonly JsonValue[]): JsonValue {
  return { toolCalls: [...toolCalls] };
}

function proposePatchCall(replaceText: string): JsonValue {
  return {
    name: "propose_patch",
    arguments: { patchSet: patchSetProducing(replaceText) },
  };
}

function applyPatchCall(replaceText: string): JsonValue {
  return {
    name: "apply_patchset",
    arguments: { patchSet: patchSetProducing(replaceText) },
  };
}
function applyPatchCallFor(target: string, baseline: string, replaceText: string): JsonValue {
  return {
    name: "apply_patchset",
    arguments: { patchSet: patchSetFor(target, baseline, replaceText) },
  };
}
function runChecksCall(checkIds: readonly string[]): JsonValue {
  return { name: "run_checks", arguments: { checkIds: [...checkIds] } };
}

function readFileCall(target: string): JsonValue {
  return { name: "read_file", arguments: { path: target } };
}

const RUN_CHECKS_CALL = runChecksCall(["verify"]);
const CHECK_CATALOG_CALL: JsonValue = { name: "get_check_catalog", arguments: {} };

function reportDoneCall(summary = "The approved registered check passes."): JsonValue {
  return { name: "report_done", arguments: { summary } };
}

function requestHumanCall(question = "Which greeting should I use?"): JsonValue {
  return { name: "request_human_input", arguments: { question } };
}

function gatewayFactory(outputs: readonly JsonValue[]): (config: ProviderConfig) => ModelGateway {
  const queue = [...outputs];
  return (config) => ({
    config,
    generateStructured: () => {
      const value = queue.shift();
      if (value === undefined) throw new Error("Synthetic provider queue exhausted");
      return Promise.resolve({
        text: JSON.stringify(value),
        usage: { inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0, latencyMs: 1 },
        reportedIdentity: syntheticReportedIdentity(config.model),
      });
    },
  });
}

interface Fixture {
  readonly service: IcarusService;
  readonly store: IcarusStore;
  readonly provider: ProviderConfig;
  readonly checks: ConvergingChecks;
  readonly stateRoot: string;
  readonly repositoryPath: string;
  readonly requests: StructuredGenerationRequest[];
  close(): void;
}

interface FixtureOptions {
  readonly remote?: boolean;
  readonly failDiffOnceFor?: string;
  readonly failDiffCode?: string;
  readonly failSessionStartOnce?: boolean;
  readonly failAfterSessionStartOnce?: boolean;
  readonly failSessionBoundaryOnce?: boolean;
  readonly failAfterSessionBoundaryOnce?: boolean;
  readonly failCheckRunAt?: number;
  readonly failCheckSettlementOnce?: boolean;
  readonly onCheckRun?: (runCount: number) => void;
  readonly privateCheckOutput?: {
    readonly stdout: string;
    readonly stderr: string;
    readonly truncated?: boolean;
  };
  readonly ceiling?: SunCeiling;
  readonly checks?: readonly CheckProfile[];
  readonly readableManifestEntries?: number;
  readonly readableManifestPathBytes?: number;
  readonly readableFileContentBytes?: number;
}

async function fixtureWith(
  outputs: readonly JsonValue[],
  options: FixtureOptions = {},
): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "icarus-repair-"));
  cleanupRoots.push(root);
  const stateRoot = path.join(root, "state");
  const repositoryPath = path.join(root, "repository");
  await mkdir(stateRoot, { mode: 0o700 });
  await mkdir(path.join(repositoryPath, "src"), { recursive: true, mode: 0o700 });
  await writeFile(path.join(repositoryPath, TARGET), BASELINE, "utf8");
  const store = new IcarusStore(path.join(stateRoot, "icarus.sqlite3"));
  if (options.failSessionStartOnce) {
    const beginSessionIteration = store.beginSessionIteration.bind(store);
    let shouldFail = true;
    store.beginSessionIteration = (runId) => {
      if (shouldFail) {
        shouldFail = false;
        throw new IcarusError(
          "SYNTHETIC_SESSION_START_FAILURE",
          "Synthetic crash after failing verification was durably recorded",
        );
      }
      return beginSessionIteration(runId);
    };
  }
  if (options.failAfterSessionStartOnce) {
    const beginSessionIteration = store.beginSessionIteration.bind(store);
    let shouldFail = true;
    store.beginSessionIteration = (runId) => {
      const begun = beginSessionIteration(runId);
      if (shouldFail) {
        shouldFail = false;
        throw new IcarusError(
          "SYNTHETIC_SESSION_ENTRY_FAILURE",
          "Synthetic crash after the recoverable session transition",
        );
      }
      return begun;
    };
  }
  if (options.failSessionBoundaryOnce) {
    const recordSessionIterationBoundary = store.recordSessionIterationBoundary.bind(store);
    let shouldFail = true;
    store.recordSessionIterationBoundary = (runId, iterations) => {
      if (shouldFail) {
        shouldFail = false;
        throw new IcarusError(
          "SYNTHETIC_SESSION_BOUNDARY_FAILURE",
          "Synthetic crash after the terminal control settlement",
        );
      }
      return recordSessionIterationBoundary(runId, iterations);
    };
  }
  if (options.failAfterSessionBoundaryOnce) {
    const recordSessionIterationBoundary = store.recordSessionIterationBoundary.bind(store);
    let shouldFail = true;
    store.recordSessionIterationBoundary = (runId, iterations) => {
      const persisted = recordSessionIterationBoundary(runId, iterations);
      if (shouldFail) {
        shouldFail = false;
        throw new IcarusError(
          "SYNTHETIC_POST_SESSION_BOUNDARY_FAILURE",
          "Synthetic process death after the completed session boundary",
        );
      }
      return persisted;
    };
  }
  if (options.failCheckSettlementOnce) {
    const finishOperation = store.finishOperation.bind(store);
    let shouldFail = true;
    store.finishOperation = (operation, finish) => {
      if (shouldFail && operation.kind === "session.tool.exec.check") {
        shouldFail = false;
        throw new IcarusError(
          "SYNTHETIC_CHECK_SETTLEMENT_FAILURE",
          "Synthetic process death before the interrupted check could settle",
        );
      }
      return finishOperation(operation, finish);
    };
  }
  const checks = new ConvergingChecks(
    options.failCheckRunAt ?? null,
    options.onCheckRun ?? null,
    options.privateCheckOutput ?? null,
  );
  const requests: StructuredGenerationRequest[] = [];
  const baseGatewayFactory = gatewayFactory(outputs);
  const service = new IcarusService({
    stateRoot,
    store,
    artifacts: new ArtifactStore(stateRoot),
    git: new ControlledGit(
      repositoryPath,
      options.failDiffOnceFor ?? null,
      options.failDiffCode ?? "SYNTHETIC_DIFF_FAILURE",
      options.readableManifestEntries ?? 1,
      options.readableManifestPathBytes ?? 0,
      options.readableFileContentBytes ?? 0,
    ) as unknown as GitController,
    checks,
    gatewayFactory: (config) => {
      const gateway = baseGatewayFactory(config);
      return {
        ...gateway,
        generateStructured: (request, signal) => {
          requests.push(request);
          return gateway.generateStructured(request, signal);
        },
      };
    },
  });
  await service.initialize();
  await service.registerRepository("fixture", repositoryPath);
  service.createProject({
    name: "repair-test",
    repositoryName: "fixture",
    baseRef: "main",
    checks: options.checks ?? [
      { id: "verify", name: "Synthetic verification", argv: ["synthetic-check"] },
    ],
    sandbox: { image: IMAGE, ...DEFAULT_SANDBOX_LIMITS },
    ceiling: options.ceiling ?? CEILING,
  });
  const provider = options.remote
    ? createProviderConfig({
        kind: "openai",
        model: "synthetic-model",
        baseUrl: "https://api.openai.com/v1/",
        inputUsdPerMillionTokens: 1,
        outputUsdPerMillionTokens: 1,
      })
    : createProviderConfig({
        kind: "ollama",
        model: "synthetic-model",
        baseUrl: "http://127.0.0.1:11434/",
      });
  return {
    service,
    store,
    provider,
    checks,
    stateRoot,
    repositoryPath,
    requests,
    close: () => store.close(),
  };
}

async function expectSourceCheckoutUnchanged(fixture: Fixture): Promise<void> {
  expect(await readFile(path.join(fixture.repositoryPath, TARGET), "utf8")).toBe(BASELINE);
}

const RESTART_WORKER_TEST = "__adr_0026_completed_boundary_restart_worker__";
const RESTART_PHASE_ENV = "ICARUS_ADR_0026_RESTART_PHASE";
const RESTART_ROOT_ENV = "ICARUS_ADR_0026_RESTART_ROOT";

type RestartPhase = "persist-and-exit" | "resume-and-complete";

function restartPaths(root: string): {
  readonly stateRoot: string;
  readonly repositoryPath: string;
  readonly databasePath: string;
  readonly runIdPath: string;
  readonly providerLogPath: string;
  readonly checkLogPath: string;
  readonly resultPath: string;
} {
  const stateRoot = path.join(root, "state");
  return {
    stateRoot,
    repositoryPath: path.join(root, "repository"),
    databasePath: path.join(stateRoot, "icarus.sqlite3"),
    runIdPath: path.join(root, "run-id"),
    providerLogPath: path.join(root, "provider-effects.jsonl"),
    checkLogPath: path.join(root, "check-effects.jsonl"),
    resultPath: path.join(root, "restart-result.json"),
  };
}

class RestartRecordedChecks extends ConvergingChecks {
  constructor(
    readonly phase: RestartPhase,
    readonly effectLogPath: string,
  ) {
    super();
  }

  override async runChecks(input: CheckRunInput): Promise<readonly CheckEvidence[]> {
    const evidence = await super.runChecks(input);
    await appendFile(
      this.effectLogPath,
      `${JSON.stringify({
        phase: this.phase,
        observed: this.observed.at(-1),
        checkIds: input.checks.map((check) => check.id),
      })}\n`,
      "utf8",
    );
    return evidence;
  }
}

function restartGatewayFactory(
  outputs: readonly JsonValue[],
  phase: RestartPhase,
  effectLogPath: string,
): (config: ProviderConfig) => ModelGateway {
  const baseFactory = gatewayFactory(outputs);
  return (config) => {
    const gateway = baseFactory(config);
    return {
      ...gateway,
      generateStructured: async (request, signal) => {
        await appendFile(
          effectLogPath,
          `${JSON.stringify({ phase, schemaName: request.schemaName })}\n`,
          "utf8",
        );
        return gateway.generateStructured(request, signal);
      },
    };
  };
}

async function executeRestartWorker(phase: RestartPhase, root: string): Promise<void> {
  const paths = restartPaths(root);
  if (phase === "persist-and-exit") {
    await mkdir(paths.stateRoot, { recursive: true, mode: 0o700 });
    await mkdir(path.join(paths.repositoryPath, "src"), { recursive: true, mode: 0o700 });
    await writeFile(path.join(paths.repositoryPath, TARGET), BASELINE, "utf8");
  }

  const store = new IcarusStore(paths.databasePath);
  const checks = new RestartRecordedChecks(phase, paths.checkLogPath);
  const outputs =
    phase === "persist-and-exit"
      ? [
          planProposal(2),
          patchSetProducing(BROKEN),
          toolEnvelope([applyPatchCall(FIXED), RUN_CHECKS_CALL]),
        ]
      : [toolEnvelope([reportDoneCall("The restarted session retained its completed batch.")])];
  const service = new IcarusService({
    stateRoot: paths.stateRoot,
    store,
    artifacts: new ArtifactStore(paths.stateRoot),
    git: new ControlledGit(paths.repositoryPath) as unknown as GitController,
    checks,
    gatewayFactory: restartGatewayFactory(outputs, phase, paths.providerLogPath),
  });

  try {
    await service.initialize();
    if (phase === "persist-and-exit") {
      await service.registerRepository("restart-fixture", paths.repositoryPath);
      service.createProject({
        name: "restart-repair-test",
        repositoryName: "restart-fixture",
        baseRef: "main",
        checks: [{ id: "verify", name: "Synthetic verification", argv: ["synthetic-check"] }],
        sandbox: { image: IMAGE, ...DEFAULT_SANDBOX_LIMITS },
        ceiling: CEILING,
      });
      const provider = createProviderConfig({
        kind: "ollama",
        model: "synthetic-model",
        baseUrl: "http://127.0.0.1:11434/",
      });
      const planned = await service.planRun({
        projectName: "restart-repair-test",
        task: "Replace the greeting.",
        targets: [TARGET],
        provider,
      });
      await writeFile(paths.runIdPath, `${planned.id}\n`, "utf8");

      const recordBoundary = store.recordSessionIterationBoundary.bind(store);
      store.recordSessionIterationBoundary = (runId, iterations) => {
        const persisted = recordBoundary(runId, iterations);
        if (iterations === 1) {
          process.kill(process.pid, "SIGKILL");
          throw new Error("Restart worker survived SIGKILL");
        }
        return persisted;
      };

      await service.approvePlan(
        planned.id,
        planned.planSha256 ?? "",
        "process-restart-integration",
      );
      throw new Error("Restart worker returned without exiting after the completed boundary");
    }

    const runId = (await readFile(paths.runIdPath, "utf8")).trim();
    const resumed = await service.resume(runId);
    expect(resumed).toMatchObject({
      state: "awaiting_review",
      verification: { outcome: "passed" },
      usage: { toolCalls: 18 },
    });
    const completed = await service.review(
      runId,
      "approve",
      resumed.verification?.diffSha256 ?? "",
      "process-restart-integration",
    );
    expect(completed).toMatchObject({ state: "completed", usage: { toolCalls: 19 } });
    await writeFile(
      paths.resultPath,
      JSON.stringify({
        resumedState: resumed.state,
        resumedToolCalls: resumed.usage.toolCalls,
        completedState: completed.state,
        completedToolCalls: completed.usage.toolCalls,
        checkRuns: checks.runCount,
        reconciliations: checks.reconciliations,
      }),
      "utf8",
    );
  } finally {
    store.close();
  }
}

function launchRestartWorker(root: string, phase: RestartPhase) {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    [RESTART_PHASE_ENV]: phase,
    [RESTART_ROOT_ENV]: root,
  };
  delete environment.VITEST_POOL_ID;
  delete environment.VITEST_WORKER_ID;
  return spawnSync(
    process.execPath,
    [
      path.resolve("node_modules/vitest/vitest.mjs"),
      "run",
      "tests/integration/repair-convergence.test.ts",
      "-t",
      `^${RESTART_WORKER_TEST}$`,
      "--reporter=dot",
      "--pool=forks",
      "--maxWorkers=1",
      "--no-file-parallelism",
    ],
    {
      cwd: path.resolve("."),
      env: environment,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
}

const restartWorkerPhase = process.env[RESTART_PHASE_ENV];
if (restartWorkerPhase !== undefined) {
  test(RESTART_WORKER_TEST, async () => {
    expect(["persist-and-exit", "resume-and-complete"]).toContain(restartWorkerPhase);
    const root = process.env[RESTART_ROOT_ENV];
    expect(root).toBeDefined();
    await executeRestartWorker(restartWorkerPhase as RestartPhase, root ?? "");
  }, 120_000);
}

describe("bounded repair loop end to end", () => {
  test("converges on a passing revision without a second human approval", async () => {
    const fixture = await fixtureWith([
      planProposal(2),
      patchSetProducing(BROKEN),
      toolEnvelope([applyPatchCall(FIXED), RUN_CHECKS_CALL, reportDoneCall()]),
    ]);
    try {
      const planned = await fixture.service.planRun({
        projectName: "repair-test",
        task: "Replace the greeting.",
        targets: [TARGET],
        provider: fixture.provider,
      });
      expect(planned.state).toBe("awaiting_approval");
      expect(planned.plan?.iterationCeiling).toBe(2);

      const settled = await fixture.service.approvePlan(
        planned.id,
        planned.planSha256 ?? "",
        "integration-test",
      );

      expect(settled.state).toBe("awaiting_review");
      expect(settled.verification?.outcome).toBe("passed");
      // The check saw the defect first and the revision second.
      expect(fixture.checks.observed).toEqual([BROKEN, FIXED]);
      expect(await readFile(path.join(settled.worktreePath ?? "", TARGET), "utf8")).toBe(FIXED);
      await expectSourceCheckoutUnchanged(fixture);

      // Exactly one grant was spent, from the durable operation ledger.
      expect(fixture.store.countSessionIterations(planned.id)).toBe(1);
      expect(fixture.store.remainingIterationBudget(planned.id)).toBe(1);
      // Fixed first attempt: 12 operations. The session adds one provider and
      // three separately metered tools; no volatile preview is required.
      expect(settled.usage.toolCalls).toBe(16);

      const events = fixture.store.listEvents(planned.id);
      const types = events.map((event) => event.type);
      let chargedRuntimeMs = 0;
      let recoveryBoundOperations = 0;
      for (const event of events) {
        const payload = event.payload as Record<string, unknown>;
        if (event.type === "operation.started") {
          const kind = payload.kind;
          if (
            kind === SESSION_ITERATION_OPERATION_KIND ||
            (typeof kind === "string" && kind.startsWith("session."))
          ) {
            expect(typeof payload.reservedRuntimeMs).toBe("number");
            expect(
              chargedRuntimeMs + (payload.reservedRuntimeMs as number) + CEILING.commandTimeoutMs,
            ).toBeLessThanOrEqual(CEILING.maxActiveRuntimeMs);
            recoveryBoundOperations += 1;
          }
        }
        if (event.type === "operation.finished") {
          const detail = payload.detail;
          if (typeof detail === "object" && detail !== null && !Array.isArray(detail)) {
            const charged = (detail as Record<string, unknown>).chargedRuntimeMs;
            if (typeof charged === "number") chargedRuntimeMs += charged;
          }
        }
      }
      expect(recoveryBoundOperations).toBe(4);

      // The append-only log retains the initial failure, the atomically bound
      // applied-but-unchecked snapshot, and the final passing check evidence.
      expect(
        events
          .filter((event) => event.type === "verification.completed")
          .map((event) => (event.payload as Record<string, unknown>).outcome),
      ).toEqual(["failed", "unavailable", "passed"]);
      expect(types.filter((type) => type === "repair.requested")).toHaveLength(1);
      expect(types.filter((type) => type === "patch_set.superseded")).toHaveLength(1);
      expect(
        events.some(
          (event) =>
            event.type === "operation.finished" &&
            (event.payload as Record<string, unknown>).kind === SESSION_ITERATION_OPERATION_KIND &&
            (event.payload as Record<string, unknown>).outcome === "succeeded",
        ),
      ).toBe(true);
      expect(types.filter((type) => type === "session.completed")).toHaveLength(1);
      expect(types.filter((type) => type === "session.iteration_completed")).toHaveLength(1);
      // No second human gate was opened for the revision.
      expect(fixture.store.listApprovals(planned.id)).toHaveLength(1);
    } finally {
      fixture.close();
    }
  }, 60_000);

  test("reopens in a fresh process after a completed session iteration boundary", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "icarus-repair-restart-"));
    cleanupRoots.push(root);
    const paths = restartPaths(root);

    const phaseOne = launchRestartWorker(root, "persist-and-exit");
    expect(phaseOne.error).toBeUndefined();
    expect(phaseOne.signal).toBeNull();
    expect(phaseOne.status).not.toBe(0);

    const runId = (await readFile(paths.runIdPath, "utf8")).trim();
    const afterExitStore = new IcarusStore(paths.databasePath);
    try {
      const stranded = afterExitStore.getRun(runId);
      expect(stranded).toMatchObject({
        state: "running",
        resumeState: null,
        verification: { outcome: "passed" },
        usage: { toolCalls: 15 },
      });
      expect(afterExitStore.countSessionIterations(runId)).toBe(1);
      expect(afterExitStore.countOperationsByKind(runId, "session.tool.mutation.patchset")).toBe(1);
      expect(afterExitStore.countOperationsByKind(runId, "session.tool.exec.check")).toBe(1);
      expect(
        afterExitStore
          .listEvents(runId)
          .filter((event) => event.type === "session.iteration_completed")
          .map((event) => event.payload),
      ).toEqual([{ iterations: 1 }]);
      expect(
        afterExitStore.listEvents(runId).filter((event) => event.type === "operation.interrupted"),
      ).toEqual([]);
      expect(afterExitStore.listApprovals(runId)).toHaveLength(1);
      expect(await readFile(path.join(stranded.worktreePath ?? "", TARGET), "utf8")).toBe(FIXED);
      expect(await readFile(path.join(paths.repositoryPath, TARGET), "utf8")).toBe(BASELINE);
    } finally {
      afterExitStore.close();
    }

    const phaseTwo = launchRestartWorker(root, "resume-and-complete");
    expect(phaseTwo.error).toBeUndefined();
    if (phaseTwo.status !== 0) {
      throw new Error(
        [
          `Restart completion worker exited ${String(phaseTwo.status)} (${String(phaseTwo.signal)})`,
          phaseTwo.stdout,
          phaseTwo.stderr,
        ].join("\n"),
      );
    }

    const restartResult = JSON.parse(await readFile(paths.resultPath, "utf8")) as {
      readonly resumedState: string;
      readonly resumedToolCalls: number;
      readonly completedState: string;
      readonly completedToolCalls: number;
      readonly checkRuns: number;
      readonly reconciliations: number;
    };
    expect(restartResult).toEqual({
      resumedState: "awaiting_review",
      resumedToolCalls: 18,
      completedState: "completed",
      completedToolCalls: 19,
      checkRuns: 0,
      // Resume, report_done validation, and review each reconcile the host
      // runner without rerunning the registered check.
      reconciliations: 3,
    });

    const completedStore = new IcarusStore(paths.databasePath);
    try {
      const completed = completedStore.getRun(runId);
      expect(completed).toMatchObject({
        state: "completed",
        resumeState: null,
        verification: { outcome: "passed" },
        usage: { toolCalls: 19 },
      });
      expect(completedStore.countSessionIterations(runId)).toBe(2);
      expect(completedStore.countOperationsByKind(runId, "session.tool.mutation.patchset")).toBe(1);
      expect(completedStore.countOperationsByKind(runId, "session.tool.exec.check")).toBe(1);
      expect(completedStore.countOperationsByKind(runId, "session.control.report_done")).toBe(1);
      expect(completedStore.countOperationsByKind(runId, "session.reconcile")).toBe(1);
      const events = completedStore.listEvents(runId);
      expect(
        events
          .filter((event) => event.type === "session.iteration_completed")
          .map((event) => event.payload),
      ).toEqual([{ iterations: 1 }, { iterations: 2 }]);
      expect(events.filter((event) => event.type === "session.completed")).toHaveLength(1);
      expect(events.filter((event) => event.type === "operation.interrupted")).toEqual([]);
      expect(completedStore.listApprovals(runId)).toHaveLength(2);
      expect(await readFile(path.join(completed.worktreePath ?? "", TARGET), "utf8")).toBe(FIXED);
      expect(await readFile(path.join(paths.repositoryPath, TARGET), "utf8")).toBe(BASELINE);
    } finally {
      completedStore.close();
    }

    const providerEffects = (await readFile(paths.providerLogPath, "utf8"))
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            readonly phase: RestartPhase;
            readonly schemaName: string;
          },
      );
    expect(
      providerEffects.filter((effect) => effect.schemaName === "icarus_session_tools"),
    ).toEqual([
      { phase: "persist-and-exit", schemaName: "icarus_session_tools" },
      { phase: "resume-and-complete", schemaName: "icarus_session_tools" },
    ]);

    const checkEffects = (await readFile(paths.checkLogPath, "utf8"))
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            readonly phase: RestartPhase;
            readonly observed: string;
            readonly checkIds: readonly string[];
          },
      );
    expect(checkEffects).toEqual([
      { phase: "persist-and-exit", observed: BROKEN, checkIds: ["verify"] },
      { phase: "persist-and-exit", observed: FIXED, checkIds: ["verify"] },
    ]);
  }, 180_000);

  test.each([
    { name: "subset", requested: ["verify"] },
    { name: "reordered", requested: ["lint", "verify"] },
  ])(
    "refuses a $name session check list before invoking the CheckRunner",
    async ({ requested }) => {
      const checkIds = ["verify", "lint"];
      const grants: readonly JsonValue[] = [
        { kind: "read.checks", scope: checkIds, maxCalls: 4 },
        { kind: "mutation.patchset", scope: [TARGET], maxCalls: 1 },
        { kind: "exec.check", scope: checkIds, maxCalls: 1 },
      ];
      const plan = {
        ...(planProposal(1, grants) as Record<string, JsonValue>),
        checkIds,
      } as JsonValue;
      const fixture = await fixtureWith(
        [plan, patchSetProducing(BROKEN), toolEnvelope([runChecksCall(requested)])],
        {
          checks: [
            { id: "verify", name: "Synthetic verification", argv: ["synthetic-check"] },
            { id: "lint", name: "Synthetic lint", argv: ["synthetic-lint"] },
          ],
        },
      );
      try {
        const planned = await fixture.service.planRun({
          projectName: "repair-test",
          task: "Replace the greeting.",
          targets: [TARGET],
          provider: fixture.provider,
        });
        const settled = await fixture.service.approvePlan(
          planned.id,
          planned.planSha256 ?? "",
          "integration-test",
        );

        expect(settled).toMatchObject({
          state: "awaiting_review",
          verification: { outcome: "failed" },
        });
        // The initial full-plan verification ran once. The malformed session
        // request is refused by host policy before a second runner invocation.
        expect(fixture.checks.runCount).toBe(1);
        expect(
          fixture.store.listEvents(planned.id).some((event) => {
            const payload = event.payload as Record<string, unknown>;
            const detail = payload.detail as Record<string, unknown> | undefined;
            return (
              event.type === "operation.finished" &&
              payload.kind === "session.tool.exec.check" &&
              payload.outcome === "failed" &&
              detail?.code === "CHECK_MISMATCH"
            );
          }),
        ).toBe(true);
        expect(
          fixture.store
            .listEvents(planned.id)
            .filter((event) => event.type === "session.exhausted"),
        ).toHaveLength(1);
        await expectSourceCheckoutUnchanged(fixture);
      } finally {
        fixture.close();
      }
    },
    60_000,
  );

  test("compacts a near-ceiling readable manifest against the complete session request", async () => {
    const ceiling: SunCeiling = {
      ...CEILING,
      maxContextBytes: 192 * 1024,
      maxTotalTokens: 1_000_000,
    };
    const fixture = await fixtureWith(
      [
        planProposal(1),
        patchSetProducing(BROKEN),
        toolEnvelope([requestHumanCall("The bounded context is sufficient; should review pause?")]),
      ],
      {
        ceiling,
        readableManifestEntries: 512,
        readableManifestPathBytes: 320,
      },
    );
    try {
      const planned = await fixture.service.planRun({
        projectName: "repair-test",
        task: "Replace the greeting.",
        targets: [TARGET],
        provider: fixture.provider,
      });
      const settled = await fixture.service.approvePlan(
        planned.id,
        planned.planSha256 ?? "",
        "integration-test",
      );

      expect(settled.state).toBe("awaiting_review");
      const sessionRequest = fixture.requests.find(
        (request) => request.schemaName === "icarus_session_tools",
      );
      expect(sessionRequest).toBeDefined();
      const completeRequestBytes =
        Buffer.byteLength(sessionRequest?.instructions ?? "", "utf8") +
        Buffer.byteLength(sessionRequest?.input ?? "", "utf8") +
        Buffer.byteLength(JSON.stringify(sessionRequest?.schema ?? null), "utf8");
      expect(completeRequestBytes).toBeLessThanOrEqual(ceiling.maxContextBytes);
      expect(sessionRequest?.input).toContain('"entriesOmitted":true');
      expect(sessionRequest?.input).toContain(BASELINE);
      expect(fixture.store.countSessionIterations(planned.id)).toBe(1);
      await expectSourceCheckoutUnchanged(fixture);
    } finally {
      fixture.close();
    }
  }, 60_000);

  test("projects remote check diagnostics to metadata while retaining exact local evidence", async () => {
    const fixture = await fixtureWith(
      [
        planProposal(2),
        patchSetProducing(BROKEN),
        toolEnvelope([RUN_CHECKS_CALL]),
        toolEnvelope([requestHumanCall("The host retained the diagnostics; should review pause?")]),
      ],
      {
        remote: true,
        privateCheckOutput: {
          stdout: `${CHECK_STDOUT_CANARY}\n`,
          stderr: `${CHECK_STDERR_CANARY}\n`,
          truncated: true,
        },
      },
    );
    try {
      const awaitingEgress = await fixture.service.planRun({
        projectName: "repair-test",
        task: "Replace the greeting.",
        targets: [TARGET],
        provider: fixture.provider,
      });
      expect(JSON.stringify(awaitingEgress.context)).not.toContain(CHECK_STDOUT_CANARY);
      const planned = await fixture.service.approveEgress(
        awaitingEgress.id,
        awaitingEgress.contextSha256,
        "integration-test",
      );
      expect(JSON.stringify(fixture.store.readableManifest(planned.id))).not.toContain(
        CHECK_STDOUT_CANARY,
      );

      const settled = await fixture.service.approvePlan(
        planned.id,
        planned.planSha256 ?? "",
        "integration-test",
      );
      expect(settled.state).toBe("awaiting_review");

      const sessionRequests = fixture.requests.filter(
        (request) => request.schemaName === "icarus_session_tools",
      );
      expect(sessionRequests).toHaveLength(2);
      for (const request of sessionRequests) {
        expect(request.input).not.toContain(CHECK_STDOUT_CANARY);
        expect(request.input).not.toContain(CHECK_STDERR_CANARY);
        expect(request.input).not.toContain('"stdout":');
        expect(request.input).not.toContain('"stderr":');
        expect(request.input).toContain(
          '"checkId":"verify","outcome":"failed","exitCode":1,"truncated":true,"outputOmitted":true',
        );
      }
      expect(sessionRequests[1]?.input).toContain("BEGIN UNTRUSTED TOOL RESULT: run_checks");

      const stored = fixture.store.getRun(planned.id);
      expect(stored.verification?.checks[0]?.stdout).toContain(CHECK_STDOUT_CANARY);
      expect(stored.verification?.checks[0]?.stderr).toContain(CHECK_STDERR_CANARY);

      const raw = new Database(path.join(fixture.stateRoot, "icarus.sqlite3"));
      const row = raw
        .prepare("SELECT verification_json FROM runs WHERE id = ?")
        .get(planned.id) as { readonly verification_json: string };
      raw.close();
      expect(row.verification_json).toContain(CHECK_STDOUT_CANARY);
      expect(row.verification_json).toContain(CHECK_STDERR_CANARY);

      const runChecksFinished = fixture.store.listEvents(planned.id).find((event) => {
        const payload = event.payload as Record<string, unknown>;
        return (
          event.type === "operation.finished" &&
          payload.kind === "session.tool.exec.check" &&
          payload.outcome === "succeeded"
        );
      });
      const runChecksDetail = (
        runChecksFinished?.payload as
          | { readonly detail?: { readonly content?: string } }
          | undefined
      )?.detail;
      expect(runChecksDetail?.content).toContain('"outputOmitted":true');
      expect(runChecksDetail?.content).not.toContain(CHECK_STDOUT_CANARY);
      expect(runChecksDetail?.content).not.toContain(CHECK_STDERR_CANARY);
      expect(runChecksDetail?.content).not.toContain('"stdout":');
      expect(runChecksDetail?.content).not.toContain('"stderr":');
      await expectSourceCheckoutUnchanged(fixture);
    } finally {
      fixture.close();
    }
  }, 60_000);

  test("keeps raw check diagnostics available to a loopback repair provider", async () => {
    const fixture = await fixtureWith(
      [
        planProposal(1),
        patchSetProducing(BROKEN),
        toolEnvelope([requestHumanCall("The local diagnostics are sufficient; pause review?")]),
      ],
      {
        privateCheckOutput: {
          stdout: `${CHECK_STDOUT_CANARY}\n`,
          stderr: `${CHECK_STDERR_CANARY}\n`,
        },
      },
    );
    try {
      const planned = await fixture.service.planRun({
        projectName: "repair-test",
        task: "Replace the greeting.",
        targets: [TARGET],
        provider: fixture.provider,
      });
      const settled = await fixture.service.approvePlan(
        planned.id,
        planned.planSha256 ?? "",
        "integration-test",
      );

      expect(settled.state).toBe("awaiting_review");
      const sessionRequest = fixture.requests.find(
        (request) => request.schemaName === "icarus_session_tools",
      );
      expect(sessionRequest?.input).toContain(CHECK_STDOUT_CANARY);
      expect(sessionRequest?.input).toContain(CHECK_STDERR_CANARY);
      expect(sessionRequest?.input).not.toContain('"outputOmitted":true');
      expect(settled.verification?.checks[0]?.stdout).toContain(CHECK_STDOUT_CANARY);
      expect(settled.verification?.checks[0]?.stderr).toContain(CHECK_STDERR_CANARY);
      await expectSourceCheckoutUnchanged(fixture);
    } finally {
      fixture.close();
    }
  }, 60_000);

  test("keeps remote verification metadata-only after manifest compaction", async () => {
    const ceiling: SunCeiling = {
      ...CEILING,
      maxContextBytes: 192 * 1024,
      maxTotalTokens: 1_000_000,
    };
    const fixture = await fixtureWith(
      [
        planProposal(1),
        patchSetProducing(BROKEN),
        toolEnvelope([requestHumanCall("The bounded remote context is sufficient; pause?")]),
      ],
      {
        remote: true,
        ceiling,
        readableManifestEntries: 512,
        readableManifestPathBytes: 320,
        privateCheckOutput: {
          stdout: `${CHECK_STDOUT_CANARY}\n`,
          stderr: `${CHECK_STDERR_CANARY}\n`,
        },
      },
    );
    try {
      const awaitingEgress = await fixture.service.planRun({
        projectName: "repair-test",
        task: "Replace the greeting.",
        targets: [TARGET],
        provider: fixture.provider,
      });
      const planned = await fixture.service.approveEgress(
        awaitingEgress.id,
        awaitingEgress.contextSha256,
        "integration-test",
      );
      const settled = await fixture.service.approvePlan(
        planned.id,
        planned.planSha256 ?? "",
        "integration-test",
      );

      expect(settled.state).toBe("awaiting_review");
      const sessionRequest = fixture.requests.find(
        (request) => request.schemaName === "icarus_session_tools",
      );
      expect(sessionRequest?.input).toContain('"entriesOmitted":true');
      expect(sessionRequest?.input).toContain('"outputOmitted":true');
      expect(sessionRequest?.input).not.toContain(CHECK_STDOUT_CANARY);
      expect(sessionRequest?.input).not.toContain(CHECK_STDERR_CANARY);
      expect(sessionRequest?.input).not.toContain('"stdout":');
      expect(sessionRequest?.input).not.toContain('"stderr":');
      await expectSourceCheckoutUnchanged(fixture);
    } finally {
      fixture.close();
    }
  }, 60_000);

  test("reprojects legacy truncated check transcripts from atomic evidence on remote resume", async () => {
    const fixture = await fixtureWith(
      [
        planProposal(2),
        patchSetProducing(BROKEN),
        toolEnvelope([RUN_CHECKS_CALL]),
        toolEnvelope([
          requestHumanCall("The resumed metadata is sufficient; should review pause?"),
        ]),
      ],
      {
        remote: true,
        failAfterSessionBoundaryOnce: true,
        privateCheckOutput: {
          stdout: `${CHECK_STDOUT_CANARY}\n`,
          stderr: `${CHECK_STDERR_CANARY}\n`,
        },
      },
    );
    try {
      const awaitingEgress = await fixture.service.planRun({
        projectName: "repair-test",
        task: "Replace the greeting.",
        targets: [TARGET],
        provider: fixture.provider,
      });
      const planned = await fixture.service.approveEgress(
        awaitingEgress.id,
        awaitingEgress.contextSha256,
        "integration-test",
      );
      await expect(
        fixture.service.approvePlan(planned.id, planned.planSha256 ?? "", "integration-test"),
      ).rejects.toMatchObject({ code: "SYNTHETIC_POST_SESSION_BOUNDARY_FAILURE" });
      expect(fixture.store.getRun(planned.id)).toMatchObject({
        state: "failed",
        resumeState: "running",
      });
      expect(fixture.store.countSessionIterations(planned.id)).toBe(1);

      const completedCheck = fixture.store.listEvents(planned.id).find((event) => {
        const payload = event.payload as Record<string, unknown>;
        return (
          event.type === "operation.finished" &&
          payload.kind === "session.tool.exec.check" &&
          payload.outcome === "succeeded"
        );
      });
      expect(completedCheck).toBeDefined();
      const legacyPayload = structuredClone(
        completedCheck?.payload as Record<string, unknown>,
      ) as Record<string, unknown>;
      const legacyDetail = legacyPayload.detail as Record<string, unknown>;
      legacyDetail.content =
        `outcome: failed\n[{"checkId":"verify","stdout":"${CHECK_STDOUT_CANARY}",` +
        `"stderr":"${CHECK_STDERR_CANARY}"`;
      legacyDetail.truncated = true;

      const raw = new Database(path.join(fixture.stateRoot, "icarus.sqlite3"));
      raw
        .prepare("UPDATE run_events SET payload_json = ? WHERE run_id = ? AND sequence = ?")
        .run(JSON.stringify(legacyPayload), planned.id, completedCheck?.sequence);
      const operationId = legacyPayload.operationId;
      const operationRow = raw
        .prepare("SELECT result_json FROM operations WHERE id = ?")
        .get(operationId) as { readonly result_json: string };
      const legacyResult = JSON.parse(operationRow.result_json) as Record<string, unknown>;
      legacyResult.content = legacyDetail.content;
      legacyResult.truncated = true;
      raw
        .prepare("UPDATE operations SET result_json = ? WHERE id = ?")
        .run(JSON.stringify(legacyResult), operationId);
      raw.close();

      const settled = await fixture.service.resume(planned.id);
      expect(settled.state).toBe("awaiting_review");
      expect(fixture.checks.runCount).toBe(2);
      const sessionRequests = fixture.requests.filter(
        (request) => request.schemaName === "icarus_session_tools",
      );
      expect(sessionRequests).toHaveLength(2);
      const resumedRequest = sessionRequests[1]?.input ?? "";
      expect(resumedRequest).toContain("BEGIN UNTRUSTED TOOL RESULT: run_checks");
      expect(resumedRequest).toContain(
        '"checkId":"verify","outcome":"failed","exitCode":1,"truncated":false,"outputOmitted":true',
      );
      expect(resumedRequest).not.toContain(CHECK_STDOUT_CANARY);
      expect(resumedRequest).not.toContain(CHECK_STDERR_CANARY);
      expect(resumedRequest).not.toContain('"stdout":');
      expect(resumedRequest).not.toContain('"stderr":');
      expect(settled.verification?.checks[0]?.stdout).toContain(CHECK_STDOUT_CANARY);
      expect(settled.verification?.checks[0]?.stderr).toContain(CHECK_STDERR_CANARY);
      await expectSourceCheckoutUnchanged(fixture);
    } finally {
      fixture.close();
    }
  }, 120_000);

  test("rejects a legacy broad mutation grant before resume can alter either selected file", async () => {
    const secondaryBaseline = "x".repeat(64);
    const fixture = await fixtureWith(
      [
        planProposal(1),
        patchSetProducing(BROKEN),
        toolEnvelope([
          applyPatchCallFor(LARGE_READ_TARGET, secondaryBaseline, "secondary changed\n"),
        ]),
      ],
      {
        failSessionStartOnce: true,
        readableFileContentBytes: secondaryBaseline.length,
      },
    );
    try {
      const planned = await fixture.service.planRun({
        projectName: "repair-test",
        task: "Replace only the greeting.",
        targets: [TARGET, LARGE_READ_TARGET],
        provider: fixture.provider,
      });
      await expect(
        fixture.service.approvePlan(planned.id, planned.planSha256 ?? "", "integration-test"),
      ).rejects.toMatchObject({ code: "SYNTHETIC_SESSION_START_FAILURE" });

      const failed = fixture.store.getRun(planned.id);
      expect(failed).toMatchObject({
        state: "failed",
        resumeState: "verifying",
        verification: { outcome: "failed" },
      });
      expect(failed.plan).not.toBeNull();
      const originalPlan = failed.plan as PlanProposal;
      const widenedPlan: PlanProposal = {
        ...originalPlan,
        grants: originalPlan.grants.map((grant) =>
          grant.kind === "mutation.patchset"
            ? { ...grant, scope: [TARGET, LARGE_READ_TARGET] }
            : grant,
        ),
      };
      const project = fixture.store.getProject(failed.projectId);
      const readableManifest = fixture.store.readableManifest(planned.id);
      const widenedDigest = planApprovalDigest({
        task: failed.task,
        baseCommit: failed.baseCommit,
        contextSha256: failed.contextSha256,
        targets: failed.context.targets,
        provider: failed.provider,
        checks: project.checks,
        sandbox: project.sandbox,
        ceiling: project.ceiling,
        plan: widenedPlan,
        readableManifest,
      });
      const planApprovalEvent = fixture.store
        .listEvents(planned.id)
        .find((event) => event.type === "plan.approved");
      expect(planApprovalEvent).toBeDefined();
      const widenedApprovalPayload = structuredClone(
        planApprovalEvent?.payload as Record<string, unknown>,
      ) as Record<string, unknown>;
      widenedApprovalPayload.digest = widenedDigest;

      const raw = new Database(path.join(fixture.stateRoot, "icarus.sqlite3"));
      raw
        .prepare("UPDATE runs SET plan_json = ?, plan_sha256 = ? WHERE id = ?")
        .run(JSON.stringify(widenedPlan), widenedDigest, planned.id);
      raw
        .prepare("UPDATE approvals SET digest = ? WHERE run_id = ? AND kind = 'plan'")
        .run(widenedDigest, planned.id);
      raw
        .prepare("UPDATE run_events SET payload_json = ? WHERE run_id = ? AND sequence = ?")
        .run(JSON.stringify(widenedApprovalPayload), planned.id, planApprovalEvent?.sequence);
      raw.close();

      const beforeRun = fixture.store.getRun(planned.id);
      const beforePatch = structuredClone(beforeRun.patchSet);
      const beforeCheckpoint = structuredClone(fixture.store.listCheckpointFiles(planned.id));
      const worktreePath = beforeRun.worktreePath ?? "";
      const beforePrimaryBytes = await readFile(path.join(worktreePath, TARGET), "utf8");
      const beforeSecondaryBytes = await readFile(
        path.join(worktreePath, LARGE_READ_TARGET),
        "utf8",
      );
      expect(beforePrimaryBytes).toBe(BROKEN);
      expect(beforeSecondaryBytes).toBe(secondaryBaseline);
      expect(fixture.store.countSessionIterations(planned.id)).toBe(0);

      await expect(fixture.service.resume(planned.id)).rejects.toMatchObject({
        code: "TARGET_MISMATCH",
      });

      const afterRun = fixture.store.getRun(planned.id);
      expect(afterRun.patchSet).toEqual(beforePatch);
      expect(fixture.store.listCheckpointFiles(planned.id)).toEqual(beforeCheckpoint);
      expect(await readFile(path.join(worktreePath, TARGET), "utf8")).toBe(beforePrimaryBytes);
      expect(await readFile(path.join(worktreePath, LARGE_READ_TARGET), "utf8")).toBe(
        beforeSecondaryBytes,
      );
      expect(fixture.store.countSessionIterations(planned.id)).toBe(0);
      expect(fixture.store.countOperationsByKind(planned.id, "session.reconcile")).toBe(0);
      expect(fixture.checks.reconciliations).toBe(0);
      expect(
        fixture.requests.filter((request) => request.schemaName === "icarus_session_tools"),
      ).toHaveLength(0);
      await expectSourceCheckoutUnchanged(fixture);
    } finally {
      fixture.close();
    }
  }, 60_000);

  test("rehydrates only whole tool-result fences and persists read truncation", async () => {
    const readCalls = Array.from({ length: 4 }, () => readFileCall(LARGE_READ_TARGET));
    const fixture = await fixtureWith(
      [
        planProposal(2, [{ kind: "read.manifest", scope: ["src/"], maxCalls: 4 }]),
        patchSetProducing(BROKEN),
        toolEnvelope(readCalls),
        toolEnvelope([
          requestHumanCall("The bounded evidence is sufficient; should review pause?"),
        ]),
      ],
      {
        ceiling: { ...CEILING, maxTotalTokens: 1_000_000 },
        readableFileContentBytes: 80 * 1024,
      },
    );
    try {
      const planned = await fixture.service.planRun({
        projectName: "repair-test",
        task: "Replace the greeting.",
        targets: [TARGET],
        provider: fixture.provider,
      });
      const settled = await fixture.service.approvePlan(
        planned.id,
        planned.planSha256 ?? "",
        "integration-test",
      );

      expect(settled.state).toBe("awaiting_review");
      const sessionRequests = fixture.requests.filter(
        (request) => request.schemaName === "icarus_session_tools",
      );
      expect(sessionRequests).toHaveLength(2);
      const rehydrated = sessionRequests[1]?.input ?? "";
      const beginFences = rehydrated.match(/--- BEGIN UNTRUSTED TOOL RESULT:/g) ?? [];
      const endFences = rehydrated.match(/--- END UNTRUSTED TOOL RESULT:/g) ?? [];
      expect(rehydrated).toContain("earlier complete tool results were omitted");
      expect(rehydrated).toContain("truncated at the host output ceiling");
      expect(beginFences.length).toBeGreaterThan(0);
      expect(beginFences).toHaveLength(endFences.length);

      const persistedReads = fixture.store.listEvents(planned.id).filter((event) => {
        const payload = event.payload as Record<string, unknown>;
        return (
          event.type === "operation.finished" &&
          payload.kind === "session.tool.read.manifest" &&
          payload.outcome === "succeeded"
        );
      });
      expect(persistedReads).toHaveLength(4);
      for (const event of persistedReads) {
        expect((event.payload as Record<string, JsonValue>).detail).toMatchObject({
          tool: "read_file",
          truncated: true,
        });
      }
      await expectSourceCheckoutUnchanged(fixture);
    } finally {
      fixture.close();
    }
  }, 60_000);

  test("durably cancels during a session check and restores the private baseline", async () => {
    const controller = new AbortController();
    const cancellation = new IcarusError("CANCELLED", "Synthetic operator cancellation");
    const fixture = await fixtureWith(
      [
        planProposal(1),
        patchSetProducing(BROKEN),
        toolEnvelope([applyPatchCall(FIXED), RUN_CHECKS_CALL, reportDoneCall()]),
      ],
      {
        onCheckRun: (runCount) => {
          if (runCount === 2) controller.abort(cancellation);
        },
      },
    );
    try {
      const planned = await fixture.service.planRun({
        projectName: "repair-test",
        task: "Replace the greeting.",
        targets: [TARGET],
        provider: fixture.provider,
      });
      const cancelled = await fixture.service.approvePlan(
        planned.id,
        planned.planSha256 ?? "",
        "integration-test",
        controller.signal,
      );

      expect(cancelled.state).toBe("cancelled");
      expect(fixture.checks.runCount).toBe(2);
      expect(fixture.checks.reconciliations).toBe(1);
      expect(await readFile(path.join(cancelled.worktreePath ?? "", TARGET), "utf8")).toBe(
        BASELINE,
      );
      const events = fixture.store.listEvents(planned.id);
      expect(
        events
          .filter(
            (event) =>
              event.type === "cancellation.requested" || event.type === "cancellation.completed",
          )
          .map((event) => event.type),
      ).toEqual(["cancellation.requested", "cancellation.completed"]);
      expect(
        events.some((event) => {
          const payload = event.payload as Record<string, unknown>;
          return (
            event.type === "operation.finished" &&
            payload.kind === "session.tool.exec.check" &&
            payload.outcome === "cancelled"
          );
        }),
      ).toBe(true);
      await expectSourceCheckoutUnchanged(fixture);
    } finally {
      fixture.close();
    }
  }, 60_000);

  test("keeps the final ordinary slot for recovery before admitting a session tool", async () => {
    const fixture = await fixtureWith(
      [planProposal(1), patchSetProducing(BROKEN), toolEnvelope([applyPatchCall(FIXED)])],
      { ceiling: { ...CEILING, maxToolCalls: 14 } },
    );
    try {
      const planned = await fixture.service.planRun({
        projectName: "repair-test",
        task: "Replace the greeting.",
        targets: [TARGET],
        provider: fixture.provider,
      });
      const settled = await fixture.service.approvePlan(
        planned.id,
        planned.planSha256 ?? "",
        "integration-test",
      );

      expect(settled.state).toBe("awaiting_review");
      expect(settled.verification?.outcome).toBe("failed");
      expect(settled.usage.toolCalls).toBe(13);
      expect(await readFile(path.join(settled.worktreePath ?? "", TARGET), "utf8")).toBe(BROKEN);
      expect(
        fixture.store
          .listEvents(planned.id)
          .filter((event) => event.type === "patch_set.superseded"),
      ).toHaveLength(0);
      expect(
        fixture.store.countOperationsByKind(planned.id, "session.tool.mutation.patchset"),
      ).toBe(0);
      await expectSourceCheckoutUnchanged(fixture);
    } finally {
      fixture.close();
    }
  }, 60_000);

  test("keeps the final ordinary slot before admitting a session provider turn", async () => {
    const fixture = await fixtureWith([planProposal(1), patchSetProducing(BROKEN)], {
      ceiling: { ...CEILING, maxToolCalls: 13 },
    });
    try {
      const planned = await fixture.service.planRun({
        projectName: "repair-test",
        task: "Replace the greeting.",
        targets: [TARGET],
        provider: fixture.provider,
      });
      const settled = await fixture.service.approvePlan(
        planned.id,
        planned.planSha256 ?? "",
        "integration-test",
      );

      expect(settled.state).toBe("awaiting_review");
      expect(settled.verification?.outcome).toBe("failed");
      expect(settled.usage.toolCalls).toBe(12);
      expect(fixture.store.countSessionIterations(planned.id)).toBe(0);
      expect(
        fixture.store.countOperationsByKind(planned.id, SESSION_ITERATION_OPERATION_KIND),
      ).toBe(0);
      await expectSourceCheckoutUnchanged(fixture);
    } finally {
      fixture.close();
    }
  }, 60_000);

  test("does not enter a session that cannot retain its recovery margin", async () => {
    const fixture = await fixtureWith([planProposal(1), patchSetProducing(BROKEN)], {
      ceiling: { ...CEILING, maxToolCalls: 12 },
    });
    try {
      const planned = await fixture.service.planRun({
        projectName: "repair-test",
        task: "Replace the greeting.",
        targets: [TARGET],
        provider: fixture.provider,
      });
      const settled = await fixture.service.approvePlan(
        planned.id,
        planned.planSha256 ?? "",
        "integration-test",
      );

      expect(settled.state).toBe("awaiting_review");
      expect(settled.verification?.outcome).toBe("failed");
      expect(settled.usage.toolCalls).toBe(12);
      expect(fixture.store.countSessionIterations(planned.id)).toBe(0);
      const events = fixture.store.listEvents(planned.id);
      expect(events.filter((event) => event.type === "repair.requested")).toHaveLength(0);
      expect(events.find((event) => event.type === "session.exhausted")?.payload).toMatchObject({
        iterations: 0,
        reason: "recovery_margin",
      });
      expect((await fixture.service.resume(planned.id)).state).toBe("awaiting_review");
      expect(fixture.checks.reconciliations).toBe(0);
      await expectSourceCheckoutUnchanged(fixture);
    } finally {
      fixture.close();
    }
  }, 60_000);

  test("recovers a crash immediately after entering a tight session", async () => {
    const fixture = await fixtureWith([planProposal(1), patchSetProducing(BROKEN)], {
      ceiling: { ...CEILING, maxToolCalls: 13 },
      failAfterSessionStartOnce: true,
    });
    try {
      const planned = await fixture.service.planRun({
        projectName: "repair-test",
        task: "Replace the greeting.",
        targets: [TARGET],
        provider: fixture.provider,
      });
      await expect(
        fixture.service.approvePlan(planned.id, planned.planSha256 ?? "", "integration-test"),
      ).rejects.toMatchObject({ code: "SYNTHETIC_SESSION_ENTRY_FAILURE" });
      expect(fixture.store.getRun(planned.id)).toMatchObject({
        state: "failed",
        resumeState: "running",
      });

      const settled = await fixture.service.resume(planned.id);
      expect(settled.state).toBe("awaiting_review");
      expect(settled.verification?.outcome).toBe("failed");
      expect(settled.usage.toolCalls).toBe(13);
      expect(fixture.checks.reconciliations).toBe(1);
      expect(fixture.store.countSessionIterations(planned.id)).toBe(0);
      expect(
        fixture.store.listEvents(planned.id).filter((event) => event.type === "repair.requested"),
      ).toHaveLength(1);
      await expectSourceCheckoutUnchanged(fixture);
    } finally {
      fixture.close();
    }
  }, 60_000);

  test("lands an exhausted grant as a non-approvable failing review", async () => {
    const fixture = await fixtureWith([
      planProposal(1),
      patchSetProducing(BROKEN),
      toolEnvelope([CHECK_CATALOG_CALL]),
    ]);
    try {
      const planned = await fixture.service.planRun({
        projectName: "repair-test",
        task: "Replace the greeting.",
        targets: [TARGET],
        provider: fixture.provider,
      });
      const settled = await fixture.service.approvePlan(
        planned.id,
        planned.planSha256 ?? "",
        "integration-test",
      );

      expect(settled.state).toBe("awaiting_review");
      expect(settled.verification?.outcome).toBe("failed");
      expect(fixture.checks.observed).toEqual([BROKEN]);
      expect(fixture.store.countSessionIterations(planned.id)).toBe(1);
      expect(fixture.store.remainingIterationBudget(planned.id)).toBe(0);
      expect(settled.usage.toolCalls).toBe(14);
      expect(
        fixture.store
          .listEvents(planned.id)
          .filter((event) => event.type === "verification.completed"),
      ).toHaveLength(1);
      expect(
        fixture.store.listEvents(planned.id).filter((event) => event.type === "session.exhausted"),
      ).toHaveLength(1);
      await expect(
        fixture.service.review(
          planned.id,
          "approve",
          settled.verification?.diffSha256 ?? "",
          "integration-test",
        ),
      ).rejects.toMatchObject({ code: "SESSION_NOT_COMPLETED" });
      await expectSourceCheckoutUnchanged(fixture);
    } finally {
      fixture.close();
    }
  }, 60_000);

  test("spending the worst-case grant, then rolling back, exactly fits the shipped ceiling", async () => {
    const eightReadCalls = Array.from({ length: 8 }, () => CHECK_CATALOG_CALL);
    const fixture = await fixtureWith([
      planProposal(MAX_SESSION_ITERATIONS, [
        { kind: "read.manifest", scope: ["src/"], maxCalls: 4 },
        { kind: "read.checks", scope: ["verify"], maxCalls: 20 },
        { kind: "mutation.patchset", scope: [TARGET], maxCalls: 2 },
        { kind: "exec.check", scope: ["verify"], maxCalls: 1 },
      ]),
      patchSetProducing(BROKEN),
      toolEnvelope(eightReadCalls),
      toolEnvelope([
        ...Array.from({ length: 4 }, () => CHECK_CATALOG_CALL),
        proposePatchCall(FIXED),
        applyPatchCall(FIXED),
        RUN_CHECKS_CALL,
        reportDoneCall(),
      ]),
    ]);
    try {
      const planned = await fixture.service.planRun({
        projectName: "repair-test",
        task: "Replace the greeting.",
        targets: [TARGET],
        provider: fixture.provider,
      });
      const settled = await fixture.service.approvePlan(
        planned.id,
        planned.planSha256 ?? "",
        "integration-test",
      );

      expect(settled.verification?.outcome).toBe("passed");
      expect(fixture.store.countSessionIterations(planned.id)).toBe(MAX_SESSION_ITERATIONS);
      // Initial attempt: 12. Each maximum-size turn: one provider + eight
      // tools. Two turns land at 30 and preserve ten ordinary-operation slots.
      expect(settled.usage.toolCalls).toBe(12 + MAX_SESSION_ITERATIONS * 9);
      expect(CEILING.maxToolCalls - settled.usage.toolCalls).toBe(10);

      // Recovery must still be affordable after the grant is fully spent —
      // an operator who cannot roll back is worse off than one who never ran.
      const rolled = await fixture.service.rollback(
        planned.id,
        settled.verification?.diffSha256 ?? "",
        "integration-test",
      );
      expect(rolled.state).toBe("rolled_back");
      expect(rolled.usage.toolCalls).toBe(31);
      expect(await readFile(path.join(rolled.worktreePath ?? "", TARGET), "utf8")).toBe(BASELINE);
      await expectSourceCheckoutUnchanged(fixture);
    } finally {
      fixture.close();
    }
  }, 120_000);

  test("never repairs a run whose plan carries no grant", async () => {
    const fixture = await fixtureWith([planProposal(0), patchSetProducing(BROKEN)]);
    try {
      const planned = await fixture.service.planRun({
        projectName: "repair-test",
        task: "Replace the greeting.",
        targets: [TARGET],
        provider: fixture.provider,
      });
      const settled = await fixture.service.approvePlan(
        planned.id,
        planned.planSha256 ?? "",
        "integration-test",
      );

      expect(settled.state).toBe("awaiting_review");
      expect(settled.verification?.outcome).toBe("failed");
      // The provider was never asked for a revision, so the queue still holds none.
      expect(fixture.checks.observed).toEqual([BROKEN]);
      expect(fixture.store.countSessionIterations(planned.id)).toBe(0);
      expect(
        fixture.store.listEvents(planned.id).some((event) => event.type === "repair.requested"),
      ).toBe(false);
      await expectSourceCheckoutUnchanged(fixture);
    } finally {
      fixture.close();
    }
  }, 60_000);

  test("fences a premature completion report, meters it, and does not complete", async () => {
    const fixture = await fixtureWith([
      planProposal(1),
      patchSetProducing(BROKEN),
      toolEnvelope([reportDoneCall("Done without checking."), requestHumanCall()]),
    ]);
    try {
      const planned = await fixture.service.planRun({
        projectName: "repair-test",
        task: "Replace the greeting.",
        targets: [TARGET],
        provider: fixture.provider,
      });
      const settled = await fixture.service.approvePlan(
        planned.id,
        planned.planSha256 ?? "",
        "integration-test",
      );

      expect(settled.state).toBe("awaiting_review");
      expect(settled.verification?.outcome).toBe("failed");
      expect(settled.usage.toolCalls).toBe(15);
      const events = fixture.store.listEvents(planned.id);
      expect(events.filter((event) => event.type === "session.completed")).toHaveLength(0);
      expect(events.filter((event) => event.type === "session.awaiting_human")).toHaveLength(1);
      expect(
        events.some(
          (event) =>
            event.type === "operation.finished" &&
            (event.payload as Record<string, unknown>).kind === "session.control.report_done" &&
            (event.payload as Record<string, unknown>).outcome === "failed",
        ),
      ).toBe(true);
      await expectSourceCheckoutUnchanged(fixture);
    } finally {
      fixture.close();
    }
  }, 60_000);

  test("meters a refused mutation grant without invoking the patch host action", async () => {
    const fixture = await fixtureWith([
      planProposal(1, [{ kind: "read.checks", scope: ["verify"], maxCalls: 1 }]),
      patchSetProducing(BROKEN),
      toolEnvelope([applyPatchCall(FIXED), requestHumanCall()]),
    ]);
    try {
      const planned = await fixture.service.planRun({
        projectName: "repair-test",
        task: "Replace the greeting.",
        targets: [TARGET],
        provider: fixture.provider,
      });
      const settled = await fixture.service.approvePlan(
        planned.id,
        planned.planSha256 ?? "",
        "integration-test",
      );

      expect(settled.state).toBe("awaiting_review");
      expect(settled.usage.toolCalls).toBe(15);
      expect(await readFile(path.join(settled.worktreePath ?? "", TARGET), "utf8")).toBe(BROKEN);
      const events = fixture.store.listEvents(planned.id);
      expect(events.filter((event) => event.type === "patch_set.superseded")).toHaveLength(0);
      expect(
        events.some(
          (event) =>
            event.type === "operation.finished" &&
            (event.payload as Record<string, unknown>).kind === "session.tool.mutation.patchset" &&
            (event.payload as Record<string, unknown>).outcome === "failed",
        ),
      ).toBe(true);
      expect(events.filter((event) => event.type === "session.awaiting_human")).toHaveLength(1);
      await expectSourceCheckoutUnchanged(fixture);
    } finally {
      fixture.close();
    }
  }, 60_000);

  test("keeps an applied patch reviewable and rollbackable when the agent asks a human", async () => {
    const question = "Should the corrected greeting be accepted without running the check?";
    const fixture = await fixtureWith([
      planProposal(1),
      patchSetProducing(BROKEN),
      toolEnvelope([applyPatchCall(FIXED), requestHumanCall(question)]),
    ]);
    try {
      const planned = await fixture.service.planRun({
        projectName: "repair-test",
        task: "Replace the greeting.",
        targets: [TARGET],
        provider: fixture.provider,
      });
      const settled = await fixture.service.approvePlan(
        planned.id,
        planned.planSha256 ?? "",
        "integration-test",
      );

      expect(settled.state).toBe("awaiting_review");
      expect(settled.verification).toMatchObject({
        outcome: "unavailable",
        changedPaths: [TARGET],
      });
      expect(settled.verification?.checks).toEqual([
        expect.objectContaining({ checkId: "verify", outcome: "unavailable" }),
      ]);
      expect(settled.diff).toContain(`+${FIXED.trimEnd()}`);
      expect(settled.usage.toolCalls).toBe(15);
      expect(fixture.checks.observed).toEqual([BROKEN]);
      expect(await readFile(path.join(settled.worktreePath ?? "", TARGET), "utf8")).toBe(FIXED);
      const digest = settled.verification?.diffSha256 ?? "";
      expect(digest).not.toBe("");
      await expect(
        fixture.service.review(planned.id, "approve", digest, "integration-test"),
      ).rejects.toMatchObject({ code: "SESSION_NOT_COMPLETED" });

      const rolled = await fixture.service.rollback(planned.id, digest, "integration-test");
      expect(rolled.state).toBe("rolled_back");
      expect(rolled.usage.toolCalls).toBe(16);
      expect(await readFile(path.join(rolled.worktreePath ?? "", TARGET), "utf8")).toBe(BASELINE);
      expect(
        fixture.store
          .listEvents(planned.id)
          .find((event) => event.type === "session.awaiting_human")?.payload,
      ).toMatchObject({ question, iterations: 1 });
      await expectSourceCheckoutUnchanged(fixture);
    } finally {
      fixture.close();
    }
  }, 60_000);

  test("keeps an applied patch reviewable and rollbackable when the session exhausts", async () => {
    const fixture = await fixtureWith([
      planProposal(1),
      patchSetProducing(BROKEN),
      toolEnvelope([applyPatchCall(FIXED)]),
    ]);
    try {
      const planned = await fixture.service.planRun({
        projectName: "repair-test",
        task: "Replace the greeting.",
        targets: [TARGET],
        provider: fixture.provider,
      });
      const settled = await fixture.service.approvePlan(
        planned.id,
        planned.planSha256 ?? "",
        "integration-test",
      );

      expect(settled.state).toBe("awaiting_review");
      expect(settled.verification).toMatchObject({
        outcome: "unavailable",
        changedPaths: [TARGET],
      });
      expect(settled.diff).toContain(`+${FIXED.trimEnd()}`);
      expect(settled.usage.toolCalls).toBe(14);
      expect(fixture.checks.observed).toEqual([BROKEN]);
      const digest = settled.verification?.diffSha256 ?? "";
      expect(digest).not.toBe("");
      expect(
        fixture.store.listEvents(planned.id).filter((event) => event.type === "session.exhausted"),
      ).toHaveLength(1);
      await expect(
        fixture.service.review(planned.id, "approve", digest, "integration-test"),
      ).rejects.toMatchObject({ code: "SESSION_NOT_COMPLETED" });

      const rolled = await fixture.service.rollback(planned.id, digest, "integration-test");
      expect(rolled.state).toBe("rolled_back");
      expect(rolled.usage.toolCalls).toBe(15);
      expect(await readFile(path.join(rolled.worktreePath ?? "", TARGET), "utf8")).toBe(BASELINE);
      await expectSourceCheckoutUnchanged(fixture);
    } finally {
      fixture.close();
    }
  }, 60_000);

  test("recovers rollback evidence when apply hits its runtime ceiling after persisting intent", async () => {
    const fixture = await fixtureWith(
      [planProposal(1), patchSetProducing(BROKEN), toolEnvelope([applyPatchCall(FIXED)])],
      {
        failDiffOnceFor: FIXED,
        failDiffCode: "RUNTIME_BUDGET_EXCEEDED",
      },
    );
    try {
      const planned = await fixture.service.planRun({
        projectName: "repair-test",
        task: "Replace the greeting.",
        targets: [TARGET],
        provider: fixture.provider,
      });
      const settled = await fixture.service.approvePlan(
        planned.id,
        planned.planSha256 ?? "",
        "integration-test",
      );

      expect(settled.state).toBe("awaiting_review");
      expect(settled.verification).toMatchObject({
        outcome: "unavailable",
        changedPaths: [TARGET],
      });
      expect(settled.diff).toContain(`+${FIXED.trimEnd()}`);
      expect(settled.usage.toolCalls).toBe(15);
      expect(fixture.store.countOperationsByKind(planned.id, "session.reconcile")).toBe(1);
      expect(
        fixture.store
          .listEvents(planned.id)
          .some(
            (event) =>
              event.type === "operation.finished" &&
              (event.payload as Record<string, unknown>).kind ===
                "session.tool.mutation.patchset" &&
              (event.payload as Record<string, unknown>).outcome === "failed",
          ),
      ).toBe(true);
      const digest = settled.verification?.diffSha256 ?? "";
      expect(digest).not.toBe("");
      await expect(
        fixture.service.review(planned.id, "approve", digest, "integration-test"),
      ).rejects.toMatchObject({ code: "SESSION_NOT_COMPLETED" });

      const rolled = await fixture.service.rollback(planned.id, digest, "integration-test");
      expect(rolled.state).toBe("rolled_back");
      expect(rolled.usage.toolCalls).toBe(16);
      expect(await readFile(path.join(rolled.worktreePath ?? "", TARGET), "utf8")).toBe(BASELINE);
      await expectSourceCheckoutUnchanged(fixture);
    } finally {
      fixture.close();
    }
  }, 60_000);

  test("persists a bounded human question and makes the paused run non-approvable", async () => {
    const question = "Should the product name retain its current capitalization?";
    const fixture = await fixtureWith([
      planProposal(1),
      patchSetProducing(BROKEN),
      toolEnvelope([requestHumanCall(question)]),
    ]);
    try {
      const planned = await fixture.service.planRun({
        projectName: "repair-test",
        task: "Replace the greeting.",
        targets: [TARGET],
        provider: fixture.provider,
      });
      const settled = await fixture.service.approvePlan(
        planned.id,
        planned.planSha256 ?? "",
        "integration-test",
      );

      expect(settled.state).toBe("awaiting_review");
      expect(settled.usage.toolCalls).toBe(14);
      const paused = fixture.store
        .listEvents(planned.id)
        .find((event) => event.type === "session.awaiting_human");
      expect(paused?.payload).toMatchObject({ question, iterations: 1 });
      await expect(
        fixture.service.review(
          planned.id,
          "approve",
          settled.verification?.diffSha256 ?? "",
          "integration-test",
        ),
      ).rejects.toMatchObject({ code: "SESSION_NOT_COMPLETED" });
      await expectSourceCheckoutUnchanged(fixture);
    } finally {
      fixture.close();
    }
  }, 60_000);

  test("keeps a terminal human pause authoritative when its iteration boundary write fails", async () => {
    const question = "Should the paused repair wait for an operator?";
    const fixture = await fixtureWith(
      [planProposal(1), patchSetProducing(BROKEN), toolEnvelope([requestHumanCall(question)])],
      { failSessionBoundaryOnce: true },
    );
    try {
      const planned = await fixture.service.planRun({
        projectName: "repair-test",
        task: "Replace the greeting.",
        targets: [TARGET],
        provider: fixture.provider,
      });
      await expect(
        fixture.service.approvePlan(planned.id, planned.planSha256 ?? "", "integration-test"),
      ).rejects.toMatchObject({ code: "SYNTHETIC_SESSION_BOUNDARY_FAILURE" });

      const paused = fixture.store.getRun(planned.id);
      expect(paused).toMatchObject({ state: "awaiting_review", resumeState: null });
      expect(paused.usage.toolCalls).toBe(14);
      expect(
        fixture.store
          .listEvents(planned.id)
          .filter((event) => event.type === "session.awaiting_human"),
      ).toEqual([
        expect.objectContaining({
          payload: { question, iterations: 1, operationId: expect.any(String) },
        }),
      ]);
      expect(
        fixture.store
          .listEvents(planned.id)
          .filter((event) => event.type === "session.iteration_completed"),
      ).toEqual([]);

      const resumed = await fixture.service.resume(planned.id);
      expect(resumed).toMatchObject({ state: "awaiting_review", usage: { toolCalls: 14 } });
      expect(fixture.store.countSessionIterations(planned.id)).toBe(1);
      await expect(
        fixture.service.review(
          planned.id,
          "approve",
          resumed.verification?.diffSha256 ?? "",
          "integration-test",
        ),
      ).rejects.toMatchObject({ code: "SESSION_NOT_COMPLETED" });
      await expectSourceCheckoutUnchanged(fixture);
    } finally {
      fixture.close();
    }
  }, 60_000);

  test("reconciles an interrupted session check before the resumed provider turn", async () => {
    const question = "The interrupted check was reconciled; should review pause?";
    const fixture = await fixtureWith(
      [
        planProposal(2),
        patchSetProducing(BROKEN),
        toolEnvelope([RUN_CHECKS_CALL]),
        toolEnvelope([requestHumanCall(question)]),
      ],
      { failCheckRunAt: 2 },
    );
    try {
      const planned = await fixture.service.planRun({
        projectName: "repair-test",
        task: "Replace the greeting.",
        targets: [TARGET],
        provider: fixture.provider,
      });
      await expect(
        fixture.service.approvePlan(planned.id, planned.planSha256 ?? "", "integration-test"),
      ).rejects.toMatchObject({ code: "CANCELLED" });

      expect(fixture.store.getRun(planned.id)).toMatchObject({
        state: "failed",
        resumeState: "running",
      });
      expect(fixture.checks.reconciliations).toBe(0);
      expect(fixture.store.countSessionIterations(planned.id)).toBe(1);

      const settled = await fixture.service.resume(planned.id);
      expect(settled.state).toBe("awaiting_review");
      expect(fixture.checks.reconciliations).toBe(1);
      expect(fixture.store.countSessionIterations(planned.id)).toBe(2);
      expect(
        fixture.store
          .listEvents(planned.id)
          .find((event) => event.type === "session.awaiting_human")?.payload,
      ).toMatchObject({ question, iterations: 2 });
      await expectSourceCheckoutUnchanged(fixture);
    } finally {
      fixture.close();
    }
  }, 60_000);

  test("retains one operation and runtime reserve for an interrupted session check", async () => {
    const ceiling = { ...CEILING, maxToolCalls: 15 };
    const fixture = await fixtureWith(
      [planProposal(1), patchSetProducing(BROKEN), toolEnvelope([RUN_CHECKS_CALL])],
      {
        ceiling,
        failCheckRunAt: 2,
        failCheckSettlementOnce: true,
      },
    );
    try {
      const planned = await fixture.service.planRun({
        projectName: "repair-test",
        task: "Replace the greeting.",
        targets: [TARGET],
        provider: fixture.provider,
      });
      await expect(
        fixture.service.approvePlan(planned.id, planned.planSha256 ?? "", "integration-test"),
      ).rejects.toMatchObject({ code: "SYNTHETIC_CHECK_SETTLEMENT_FAILURE" });

      expect(fixture.checks.runCount).toBe(2);
      expect(fixture.store.getRun(planned.id)).toMatchObject({
        state: "failed",
        resumeState: "running",
      });

      const settled = await fixture.service.resume(planned.id);
      expect(settled.state).toBe("awaiting_review");
      expect(settled.verification?.outcome).toBe("failed");
      expect(settled.usage.toolCalls).toBe(15);
      expect(settled.usage.activeRuntimeMs).toBeLessThanOrEqual(ceiling.maxActiveRuntimeMs);
      expect(fixture.checks.reconciliations).toBe(1);
      expect(fixture.store.countSessionIterations(planned.id)).toBe(1);
      expect(
        fixture.store
          .listEvents(planned.id)
          .some(
            (event) =>
              event.type === "operation.interrupted" &&
              (event.payload as Record<string, unknown>).kind === "session.tool.exec.check",
          ),
      ).toBe(true);
      await expectSourceCheckoutUnchanged(fixture);
    } finally {
      fixture.close();
    }
  }, 60_000);

  test("reconciles a recorded failing verification handoff before starting the session", async () => {
    const question = "Should the failed repair wait for operator guidance?";
    const fixture = await fixtureWith(
      [planProposal(1), patchSetProducing(BROKEN), toolEnvelope([requestHumanCall(question)])],
      { failSessionStartOnce: true },
    );
    try {
      const planned = await fixture.service.planRun({
        projectName: "repair-test",
        task: "Replace the greeting.",
        targets: [TARGET],
        provider: fixture.provider,
      });
      await expect(
        fixture.service.approvePlan(planned.id, planned.planSha256 ?? "", "integration-test"),
      ).rejects.toMatchObject({ code: "SYNTHETIC_SESSION_START_FAILURE" });

      const failed = fixture.store.getRun(planned.id);
      expect(failed).toMatchObject({ state: "failed", resumeState: "verifying" });
      expect(fixture.checks.observed).toEqual([BROKEN]);
      expect(fixture.store.countSessionIterations(planned.id)).toBe(0);

      const settled = await fixture.service.resume(planned.id);
      expect(settled.state).toBe("awaiting_review");
      expect(fixture.checks.observed).toEqual([BROKEN]);
      expect(fixture.checks.reconciliations).toBe(1);
      expect(fixture.store.countSessionIterations(planned.id)).toBe(1);
      expect(settled.usage.toolCalls).toBe(15);
      expect(
        fixture.store
          .listEvents(planned.id)
          .find((event) => event.type === "session.awaiting_human")?.payload,
      ).toMatchObject({ question, iterations: 1 });
      await expectSourceCheckoutUnchanged(fixture);
    } finally {
      fixture.close();
    }
  }, 60_000);
});

describe("default session operation reserves", () => {
  test("fresh local worst case spends 30 and preserves ten ordinary operations", async () => {
    const eightReadCalls = Array.from({ length: 8 }, () => CHECK_CATALOG_CALL);
    const fixture = await fixtureWith([
      planProposal(MAX_SESSION_ITERATIONS, [
        { kind: "read.checks", scope: ["verify"], maxCalls: 16 },
      ]),
      patchSetProducing(BROKEN),
      toolEnvelope(eightReadCalls),
      toolEnvelope(eightReadCalls),
    ]);
    try {
      const planned = await fixture.service.planRun({
        projectName: "repair-test",
        task: "Replace the greeting.",
        targets: [TARGET],
        provider: fixture.provider,
      });
      const settled = await fixture.service.approvePlan(
        planned.id,
        planned.planSha256 ?? "",
        "integration-test",
      );

      expect(fixture.store.countSessionIterations(planned.id)).toBe(MAX_SESSION_ITERATIONS);
      expect(settled.state).toBe("awaiting_review");
      expect(settled.usage.toolCalls).toBe(30);
      expect(CEILING.maxToolCalls - settled.usage.toolCalls).toBe(10);
      expect(
        fixture.store.listEvents(planned.id).filter((event) => event.type === "session.exhausted"),
      ).toHaveLength(1);
    } finally {
      fixture.close();
    }
  }, 60_000);

  test("fresh remote worst case spends 31 and preserves nine ordinary operations", async () => {
    const eightReadCalls = Array.from({ length: 8 }, () => CHECK_CATALOG_CALL);
    const fixture = await fixtureWith(
      [
        planProposal(MAX_SESSION_ITERATIONS, [
          { kind: "read.checks", scope: ["verify"], maxCalls: 16 },
        ]),
        patchSetProducing(BROKEN),
        toolEnvelope(eightReadCalls),
        toolEnvelope(eightReadCalls),
      ],
      { remote: true },
    );
    try {
      const awaitingEgress = await fixture.service.planRun({
        projectName: "repair-test",
        task: "Replace the greeting.",
        targets: [TARGET],
        provider: fixture.provider,
      });
      expect(awaitingEgress.state).toBe("awaiting_egress_approval");
      const planned = await fixture.service.approveEgress(
        awaitingEgress.id,
        awaitingEgress.contextSha256,
        "integration-test",
      );
      const settled = await fixture.service.approvePlan(
        planned.id,
        planned.planSha256 ?? "",
        "integration-test",
      );

      expect(fixture.store.countSessionIterations(planned.id)).toBe(MAX_SESSION_ITERATIONS);
      expect(settled.state).toBe("awaiting_review");
      expect(settled.usage.toolCalls).toBe(31);
      expect(CEILING.maxToolCalls - settled.usage.toolCalls).toBe(9);
      expect(fixture.store.countOperationsByKind(planned.id, "egress.validate")).toBe(1);
    } finally {
      fixture.close();
    }
  }, 60_000);

  test("resumed remote worst case spends 32 and preserves eight ordinary operations", async () => {
    const sevenReadCalls = Array.from({ length: 7 }, () => CHECK_CATALOG_CALL);
    const question = "The interrupted patch is preserved; should a human inspect it?";
    const fixture = await fixtureWith(
      [
        planProposal(MAX_SESSION_ITERATIONS, [
          { kind: "read.checks", scope: ["verify"], maxCalls: 14 },
          { kind: "mutation.patchset", scope: [TARGET], maxCalls: 1 },
        ]),
        patchSetProducing(BROKEN),
        toolEnvelope([...sevenReadCalls, applyPatchCall(FIXED)]),
        toolEnvelope([...sevenReadCalls, requestHumanCall(question)]),
      ],
      { remote: true, failDiffOnceFor: FIXED },
    );
    try {
      const awaitingEgress = await fixture.service.planRun({
        projectName: "repair-test",
        task: "Replace the greeting.",
        targets: [TARGET],
        provider: fixture.provider,
      });
      const planned = await fixture.service.approveEgress(
        awaitingEgress.id,
        awaitingEgress.contextSha256,
        "integration-test",
      );
      await expect(
        fixture.service.approvePlan(planned.id, planned.planSha256 ?? "", "integration-test"),
      ).rejects.toMatchObject({ code: "SYNTHETIC_DIFF_FAILURE" });

      const failed = fixture.store.getRun(planned.id);
      expect(failed).toMatchObject({ state: "failed", resumeState: "running" });
      expect(failed.verification).toBeNull();
      expect(failed.diff).toBeNull();
      expect(await readFile(path.join(failed.worktreePath ?? "", TARGET), "utf8")).toBe(FIXED);

      const settled = await fixture.service.resume(planned.id);
      expect(settled.state).toBe("awaiting_review");
      expect(settled.verification).toMatchObject({
        outcome: "unavailable",
        changedPaths: [TARGET],
      });
      expect(settled.diff).toContain(`+${FIXED.trimEnd()}`);
      expect(fixture.store.countSessionIterations(planned.id)).toBe(MAX_SESSION_ITERATIONS);
      expect(settled.usage.toolCalls).toBe(32);
      expect(CEILING.maxToolCalls - settled.usage.toolCalls).toBe(8);
      expect(fixture.store.countOperationsByKind(planned.id, "session.reconcile")).toBe(1);
      expect(
        fixture.store
          .listEvents(planned.id)
          .find((event) => event.type === "session.awaiting_human")?.payload,
      ).toMatchObject({ question, iterations: 2 });
      await expectSourceCheckoutUnchanged(fixture);
    } finally {
      fixture.close();
    }
  }, 120_000);
});

describe("read grant resolution end to end", () => {
  test("resolves the requested scope and binds the enumerated set into the approval", async () => {
    const fixture = await fixtureWith([
      {
        ...(planProposal(0) as Record<string, JsonValue>),
        grants: [{ kind: "read.manifest", scope: ["src/"], maxCalls: 4 }],
      } as JsonValue,
    ]);
    try {
      const planned = await fixture.service.planRun({
        projectName: "repair-test",
        task: "Replace the greeting.",
        targets: [TARGET],
        provider: fixture.provider,
      });

      expect(planned.state).toBe("awaiting_approval");
      expect(planned.plan?.grants).toEqual([
        { kind: "read.manifest", scope: ["src/"], maxCalls: 4 },
      ]);

      // The operator is asked to approve an enumerated file list pinned by
      // content digest, not the scope string the model requested.
      const manifest = fixture.store.readableManifest(planned.id);
      expect(manifest?.baseCommit).toBe(BASE_COMMIT);
      expect(manifest?.entries).toEqual([{ path: TARGET, sha256: sha256(BASELINE) }]);
    } finally {
      fixture.close();
    }
  });

  test("refuses to record a plan whose read scope escapes the repository", async () => {
    const fixture = await fixtureWith([
      {
        ...(planProposal(0) as Record<string, JsonValue>),
        grants: [{ kind: "read.manifest", scope: ["../outside/"], maxCalls: 1 }],
      } as JsonValue,
    ]);
    try {
      await expect(
        fixture.service.planRun({
          projectName: "repair-test",
          task: "Replace the greeting.",
          targets: [TARGET],
          provider: fixture.provider,
        }),
      ).rejects.toBeInstanceOf(IcarusError);
    } finally {
      fixture.close();
    }
  });
});
