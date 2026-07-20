import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { ArtifactStore } from "../../packages/core/src/artifacts.js";
import { sha256 } from "../../packages/core/src/digest.js";
import { IcarusError } from "../../packages/core/src/errors.js";
import type {
  GitController,
  PrivateWorkspace,
  RepositoryInspection,
  TreeEntry,
} from "../../packages/core/src/git.js";
import { DEFAULT_CEILING, DEFAULT_SANDBOX_LIMITS } from "../../packages/core/src/policy.js";
import { createProviderConfig, type ModelGateway } from "../../packages/core/src/provider.js";
import type { CheckRunInput, CheckRunner } from "../../packages/core/src/sandbox.js";
import { IcarusService } from "../../packages/core/src/service.js";
import {
  CANCELLATION_RECOVERY_OPERATION_KIND,
  CANCELLATION_RECOVERY_RUNTIME_MS,
  IcarusStore,
} from "../../packages/core/src/store.js";
import type {
  CheckEvidence,
  JsonValue,
  ProviderConfig,
  RunRecord,
  SunCeiling,
} from "../../packages/core/src/types.js";

const BASELINE = "Hello, world!\n";
const APPROVED = "Hello, Icarus!\n";
const TARGET = "src/greeting.txt";
const BASE_COMMIT = "b".repeat(40);
const IMAGE = `python@sha256:${"c".repeat(64)}`;

interface TestDatabase {
  prepare(sql: string): { run(...parameters: unknown[]): unknown };
  close(): void;
}

const Database = createRequire(new URL("../../packages/core/package.json", import.meta.url))(
  "better-sqlite3",
) as new (
  filename: string,
) => TestDatabase;

const cleanupRoots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    cleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function waitForAbort(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_, reject) => {
    const cancelled = (): void => reject(new IcarusError("CANCELLED", "Synthetic stage cancelled"));
    if (signal?.aborted) {
      cancelled();
      return;
    }
    signal?.addEventListener("abort", cancelled, { once: true });
  });
}

class ControlledGit {
  readonly repositoryPath: string;
  createWorkspaceCalls = 0;
  #sourceValidationCalls = 0;
  #sourceFailureCall: number | null = null;
  #sourceDelayCall: number | null = null;
  #sourceDelayMs = 0;
  #sourceStarted: Promise<void> = Promise.resolve();
  #resolveSourceStarted: (() => void) | null = null;
  #changedPathsHook: (() => void) | null = null;

  constructor(repositoryPath: string) {
    this.repositoryPath = repositoryPath;
  }

  failNextSourceValidation(): void {
    this.#sourceFailureCall = this.#sourceValidationCalls + 1;
  }

  delaySourceValidationAfter(callsFromNow: number, delayMs: number): void {
    this.#sourceDelayCall = this.#sourceValidationCalls + callsFromNow;
    this.#sourceDelayMs = delayMs;
    this.#sourceStarted = new Promise((resolve) => {
      this.#resolveSourceStarted = resolve;
    });
  }

  sourceValidationStarted(): Promise<void> {
    return this.#sourceStarted;
  }

  onNextChangedPaths(action: () => void): void {
    this.#changedPathsHook = action;
  }

  inspectRepository(_repositoryPath: string, _signal?: AbortSignal): Promise<RepositoryInspection> {
    return Promise.resolve({
      canonicalPath: this.repositoryPath,
      device: 1,
      inode: 2,
      head: BASE_COMMIT,
    });
  }

  resolveCommit(_repositoryPath: string, _ref: string, _signal?: AbortSignal): Promise<string> {
    return Promise.resolve(BASE_COMMIT);
  }

  async assertCleanAtCommit(
    _repositoryPath: string,
    _ref: string,
    _expectedCommit: string,
    _signal?: AbortSignal,
  ): Promise<void> {
    this.#sourceValidationCalls += 1;
    if (this.#sourceFailureCall === this.#sourceValidationCalls) {
      this.#sourceFailureCall = null;
      throw new IcarusError("DIRTY_REPOSITORY", "Synthetic source checkout is dirty");
    }
    if (this.#sourceDelayCall !== this.#sourceValidationCalls) {
      return;
    }
    this.#sourceDelayCall = null;
    this.#resolveSourceStarted?.();
    const delayMs = this.#sourceDelayMs;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, delayMs);
    });
  }

  listTree(_repositoryPath: string, _commit: string, _signal?: AbortSignal): Promise<TreeEntry[]> {
    return Promise.resolve([
      {
        mode: "100644",
        type: "blob",
        objectId: "d".repeat(40),
        path: TARGET,
      },
    ]);
  }

  readBlob(
    _repositoryPath: string,
    _objectId: string,
    _maxBytes: number,
    _signal?: AbortSignal,
  ): Promise<Buffer> {
    return Promise.resolve(Buffer.from(BASELINE, "utf8"));
  }

  async createPrivateWorkspace(
    _sourceRepository: string,
    _commit: string,
    runRoot: string,
    _signal?: AbortSignal,
  ): Promise<PrivateWorkspace> {
    this.createWorkspaceCalls += 1;
    const cachePath = path.join(runRoot, "git-cache.git");
    const worktreePath = path.join(runRoot, "worktree");
    await mkdir(cachePath, { recursive: true, mode: 0o700 });
    await mkdir(path.join(worktreePath, "src"), { recursive: true, mode: 0o700 });
    await writeFile(path.join(worktreePath, TARGET), BASELINE, "utf8");
    return { cachePath, worktreePath };
  }

  readRegularUtf8File(worktreePath: string, target: string, _maxBytes: number): Promise<string> {
    return readFile(path.join(worktreePath, target), "utf8");
  }

  atomicWriteUtf8(worktreePath: string, target: string, value: string): Promise<void> {
    return writeFile(path.join(worktreePath, target), value, "utf8");
  }

  async changedPaths(worktreePath: string, _signal?: AbortSignal): Promise<string[]> {
    const hook = this.#changedPathsHook;
    this.#changedPathsHook = null;
    hook?.();
    return (await this.readRegularUtf8File(worktreePath, TARGET, 1024)) === BASELINE
      ? []
      : [TARGET];
  }

  async diff(
    worktreePath: string,
    _target: string,
    _maxBytes: number,
    _signal?: AbortSignal,
  ): Promise<string> {
    const current = await this.readRegularUtf8File(worktreePath, TARGET, 1024);
    if (current === BASELINE) {
      throw new IcarusError("EMPTY_DIFF", "Synthetic worktree is clean");
    }
    return [
      "diff --git a/src/greeting.txt b/src/greeting.txt",
      "--- a/src/greeting.txt",
      "+++ b/src/greeting.txt",
      "-Hello, world!",
      "+Hello, Icarus!",
      "",
    ].join("\n");
  }
}

class ControlledChecks implements CheckRunner {
  reconcileCalls = 0;
  #stall = false;
  #reconcileFailure = false;
  #started: Promise<void> = Promise.resolve();
  #resolveStarted: (() => void) | null = null;
  #reconcileDelayMs: number | null = null;
  #reconcileStarted: Promise<void> = Promise.resolve();
  #resolveReconcileStarted: (() => void) | null = null;

  stallVerification(): void {
    this.#stall = true;
    this.#started = new Promise((resolve) => {
      this.#resolveStarted = resolve;
    });
  }

  verificationStarted(): Promise<void> {
    return this.#started;
  }

  delayNextReconciliation(delayMs: number): void {
    this.#reconcileDelayMs = delayMs;
    this.#reconcileStarted = new Promise((resolve) => {
      this.#resolveReconcileStarted = resolve;
    });
  }

  failNextReconciliation(): void {
    this.#reconcileFailure = true;
  }

  reconciliationStarted(): Promise<void> {
    return this.#reconcileStarted;
  }

  async reconcile(_runId: string, _signal?: AbortSignal): Promise<void> {
    this.reconcileCalls += 1;
    if (this.#reconcileFailure) {
      this.#reconcileFailure = false;
      throw new IcarusError("RECONCILIATION_FAILED", "Synthetic reconciliation failed");
    }
    if (this.#reconcileDelayMs === null) {
      return;
    }
    const delayMs = this.#reconcileDelayMs;
    this.#reconcileDelayMs = null;
    this.#resolveReconcileStarted?.();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, delayMs);
    });
  }

  async runChecks(input: CheckRunInput): Promise<readonly CheckEvidence[]> {
    if (this.#stall) {
      this.#stall = false;
      this.#resolveStarted?.();
      await waitForAbort(input.signal);
    }
    return [
      {
        checkId: "verify",
        argv: ["synthetic-check"],
        exitCode: 0,
        signal: null,
        durationMs: 1,
        stdout: "ok\n",
        stderr: "",
        truncated: false,
        outcome: "passed",
      },
    ];
  }
}

function gatewayFactory(outputs: JsonValue[]): (config: ProviderConfig) => ModelGateway {
  return (config) => ({
    config,
    generateStructured: () => {
      const value = outputs.shift();
      if (value === undefined) {
        throw new Error("Synthetic provider queue exhausted");
      }
      return Promise.resolve({
        text: JSON.stringify(value),
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          estimatedCostUsd: 0,
          latencyMs: 1,
        },
      });
    },
  });
}

interface ServiceFixture {
  readonly root: string;
  readonly stateRoot: string;
  readonly git: ControlledGit;
  readonly checks: ControlledChecks;
  readonly service: IcarusService;
  readonly store: IcarusStore;
  readonly provider: ProviderConfig;
  close(): void;
}

async function serviceFixture(
  ceiling: SunCeiling,
  providerGatewayFactory?: (config: ProviderConfig) => ModelGateway,
): Promise<ServiceFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "icarus-runtime-ceiling-"));
  cleanupRoots.push(root);
  const stateRoot = path.join(root, "state");
  const repositoryPath = path.join(root, "repository");
  await mkdir(stateRoot, { mode: 0o700 });
  await mkdir(repositoryPath, { mode: 0o700 });
  const store = new IcarusStore(path.join(stateRoot, "icarus.sqlite3"));
  const git = new ControlledGit(repositoryPath);
  const checks = new ControlledChecks();
  const provider = createProviderConfig({
    kind: "ollama",
    model: "synthetic-model",
    baseUrl: "http://127.0.0.1:11434/",
  });
  const service = new IcarusService({
    stateRoot,
    store,
    artifacts: new ArtifactStore(stateRoot),
    git: git as unknown as GitController,
    checks,
    gatewayFactory:
      providerGatewayFactory ??
      gatewayFactory([
        {
          summary: "Replace the greeting.",
          steps: ["Apply one exact replacement.", "Run verification."],
          risks: ["The preimage may differ."],
          target: TARGET,
          checkIds: ["verify"],
        },
        {
          path: TARGET,
          expectedPreimageSha256: sha256(BASELINE),
          findText: BASELINE,
          replaceText: APPROVED,
          rationale: "Apply the approved greeting.",
        },
      ]),
  });
  await service.initialize();
  await service.registerRepository("fixture", repositoryPath);
  service.createProject({
    name: "runtime-test",
    repositoryName: "fixture",
    baseRef: "main",
    checks: [{ id: "verify", name: "Synthetic verification", argv: ["synthetic-check"] }],
    sandbox: { image: IMAGE, ...DEFAULT_SANDBOX_LIMITS },
    ceiling,
  });
  return {
    root,
    stateRoot,
    git,
    checks,
    service,
    store,
    provider,
    close: () => store.close(),
  };
}

async function plan(service: IcarusService, provider: ProviderConfig): Promise<RunRecord> {
  const planned = await service.planRun({
    projectName: "runtime-test",
    task: "Replace the greeting.",
    target: TARGET,
    provider,
  });
  expect(planned.state).toBe("awaiting_approval");
  return planned;
}

async function executeToReview(fixture: ServiceFixture, planned: RunRecord): Promise<RunRecord> {
  const awaitingReview = await fixture.service.approvePlan(
    planned.id,
    planned.planSha256 ?? "",
    "integration-test",
  );
  expect(awaitingReview.state).toBe("awaiting_review");
  return awaitingReview;
}

function exhaustOrdinaryBudgets(
  fixture: ServiceFixture,
  runId: string,
  ceiling: SunCeiling,
): RunRecord {
  let run = fixture.store.getRun(runId);
  const remainingToolCalls = ceiling.maxToolCalls - run.usage.toolCalls;
  expect(remainingToolCalls).toBeGreaterThan(0);
  for (let index = 0; index < remainingToolCalls - 1; index += 1) {
    const operation = fixture.store.beginOperation(runId, `exhaust-tool-${index}`, 0, 0, 1);
    fixture.store.finishOperation(operation, {
      outcome: "succeeded",
      activeRuntimeMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
      detail: {},
    });
  }
  run = fixture.store.getRun(runId);
  const remainingRuntime = ceiling.maxActiveRuntimeMs - run.usage.activeRuntimeMs;
  expect(remainingRuntime).toBeGreaterThan(0);
  const operation = fixture.store.beginOperation(
    runId,
    "exhaust-runtime-and-tool",
    0,
    0,
    remainingRuntime,
  );
  fixture.store.finishOperation(operation, {
    outcome: "succeeded",
    activeRuntimeMs: remainingRuntime,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
    detail: {},
  });
  run = fixture.store.getRun(runId);
  expect(run.usage.toolCalls).toBe(ceiling.maxToolCalls);
  expect(run.usage.activeRuntimeMs).toBe(ceiling.maxActiveRuntimeMs);
  return run;
}

describe("aggregate runtime ceilings and signal cancellation", () => {
  test("fails a provider call that returns after its effective timeout and lies about latency", async () => {
    const ceiling: SunCeiling = {
      ...DEFAULT_CEILING,
      maxActiveRuntimeMs: 10_000,
      commandTimeoutMs: 500,
      providerTimeoutMs: 20,
      maxOutputTokensPerCall: 200,
      maxTotalTokens: 5_000,
    };
    let clock = 0;
    let receivedTimeoutMs: number | null = null;
    let receivedSignal: AbortSignal | undefined;
    const clockSpy = vi.spyOn(performance, "now").mockImplementation(() => clock);
    const lateGatewayFactory = (config: ProviderConfig): ModelGateway => ({
      config,
      generateStructured(request, providerSignal) {
        receivedTimeoutMs = request.timeoutMs;
        receivedSignal = providerSignal;
        clock = 60;
        return Promise.resolve({
          text: JSON.stringify({
            summary: "Replace the greeting.",
            steps: ["Apply one exact replacement.", "Run verification."],
            risks: ["The preimage may differ."],
            target: TARGET,
            checkIds: ["verify"],
          }),
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            estimatedCostUsd: 0,
            latencyMs: 1,
          },
        });
      },
    });
    const fixture = await serviceFixture(ceiling, lateGatewayFactory);
    try {
      await expect(
        fixture.service.planRun({
          projectName: "runtime-test",
          task: "Replace the greeting.",
          target: TARGET,
          provider: fixture.provider,
        }),
      ).rejects.toEqual(expect.objectContaining({ code: "RUNTIME_BUDGET_EXCEEDED" }));

      expect(receivedTimeoutMs).toBe(ceiling.providerTimeoutMs);
      expect(receivedSignal).toBeDefined();
      const failed = fixture.service.listRuns("runtime-test")[0];
      expect(failed).toEqual(expect.objectContaining({ state: "failed", resumeState: "planned" }));
      expect(failed?.usage.activeRuntimeMs).toBeGreaterThan(1);
      const event = fixture.store
        .listEvents(failed?.id ?? "")
        .find(
          (candidate) =>
            candidate.type === "operation.finished" &&
            (candidate.payload as Record<string, unknown>).kind === "provider.plan",
        );
      expect(event).toEqual(
        expect.objectContaining({
          payload: expect.objectContaining({
            outcome: "failed",
            detail: expect.objectContaining({
              code: "RUNTIME_BUDGET_EXCEEDED",
              observedRuntimeMs: 60,
              chargedRuntimeMs: 60,
            }),
          }),
        }),
      );
    } finally {
      clockSpy.mockRestore();
      fixture.close();
    }
  });

  test("charges and rejects provider post-processing that overruns its reservation", async () => {
    const ceiling: SunCeiling = {
      ...DEFAULT_CEILING,
      maxActiveRuntimeMs: 10_000,
      commandTimeoutMs: 500,
      providerTimeoutMs: 20,
      maxOutputTokensPerCall: 200,
      maxTotalTokens: 5_000,
    };
    let clock = 0;
    const clockSpy = vi.spyOn(performance, "now").mockImplementation(() => clock);
    const postProcessingGatewayFactory = (config: ProviderConfig): ModelGateway => ({
      config,
      generateStructured() {
        return Promise.resolve({
          get text() {
            clock = 2_500;
            return JSON.stringify({
              summary: "Replace the greeting.",
              steps: ["Apply one exact replacement.", "Run verification."],
              risks: ["The preimage may differ."],
              target: TARGET,
              checkIds: ["verify"],
            });
          },
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            estimatedCostUsd: 0,
            latencyMs: 1,
          },
        });
      },
    });
    const fixture = await serviceFixture(ceiling, postProcessingGatewayFactory);
    try {
      await expect(
        fixture.service.planRun({
          projectName: "runtime-test",
          task: "Replace the greeting.",
          target: TARGET,
          provider: fixture.provider,
        }),
      ).rejects.toEqual(expect.objectContaining({ code: "RUNTIME_BUDGET_EXCEEDED" }));

      const failed = fixture.service.listRuns("runtime-test")[0];
      const event = fixture.store
        .listEvents(failed?.id ?? "")
        .find(
          (candidate) =>
            candidate.type === "operation.finished" &&
            (candidate.payload as Record<string, unknown>).kind === "provider.plan",
        );
      expect(event).toEqual(
        expect.objectContaining({
          payload: expect.objectContaining({
            outcome: "failed",
            detail: expect.objectContaining({
              code: "RUNTIME_BUDGET_EXCEEDED",
              observedRuntimeMs: 2_500,
              chargedRuntimeMs: ceiling.providerTimeoutMs + 2_000,
            }),
          }),
        }),
      );
    } finally {
      clockSpy.mockRestore();
      fixture.close();
    }
  });

  test("cancels a pre-workspace run without reconciling an impossible sandbox", async () => {
    const ceiling: SunCeiling = {
      ...DEFAULT_CEILING,
      maxActiveRuntimeMs: 10_000,
      commandTimeoutMs: 500,
      providerTimeoutMs: 500,
      maxOutputTokensPerCall: 200,
      maxTotalTokens: 5_000,
    };
    const fixture = await serviceFixture(ceiling);
    try {
      const planned = await plan(fixture.service, fixture.provider);
      expect(planned.worktreePath).toBeNull();
      fixture.checks.failNextReconciliation();

      const cancelled = await fixture.service.cancel(planned.id, "integration-test");

      expect(cancelled.state).toBe("cancelled");
      expect(cancelled.worktreePath).toBeNull();
      expect(fixture.checks.reconcileCalls).toBe(0);
      expect(
        fixture.store
          .listEvents(planned.id)
          .filter(
            (event) =>
              event.type === "operation.finished" &&
              (event.payload as Record<string, unknown>).kind ===
                CANCELLATION_RECOVERY_OPERATION_KIND,
          ),
      ).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({ outcome: "succeeded" }),
        }),
      ]);
    } finally {
      fixture.close();
    }
  });

  test("restores and cancels a worktree even when persisted project policy becomes invalid", async () => {
    const ceiling: SunCeiling = {
      ...DEFAULT_CEILING,
      maxActiveRuntimeMs: 10_000,
      commandTimeoutMs: 500,
      providerTimeoutMs: 500,
      maxOutputTokensPerCall: 200,
      maxTotalTokens: 5_000,
    };
    const fixture = await serviceFixture(ceiling);
    try {
      const planned = await plan(fixture.service, fixture.provider);
      const awaitingReview = await executeToReview(fixture, planned);
      if (awaitingReview.worktreePath === null) {
        throw new Error("Expected a private worktree before cancellation");
      }
      const projectId = fixture.store.getRun(planned.id).projectId;
      const database = new Database(path.join(fixture.stateRoot, "icarus.sqlite3"));
      try {
        database
          .prepare("UPDATE projects SET ceiling_json = ? WHERE id = ?")
          .run(JSON.stringify({ ...ceiling, providerTimeoutMs: 2_147_483_648 }), projectId);
      } finally {
        database.close();
      }
      expect(() => fixture.store.getProject(projectId)).toThrow(
        expect.objectContaining({ code: "INVALID_CEILING" }),
      );

      const cancelled = await fixture.service.cancel(planned.id, "integration-test");

      expect(cancelled.state).toBe("cancelled");
      expect(fixture.checks.reconcileCalls).toBe(1);
      expect(await readFile(path.join(awaitingReview.worktreePath, TARGET), "utf8")).toBe(BASELINE);
      expect(
        fixture.store
          .listEvents(planned.id)
          .some(
            (event) =>
              event.type === "operation.finished" &&
              (event.payload as Record<string, unknown>).kind ===
                CANCELLATION_RECOVERY_OPERATION_KIND,
          ),
      ).toBe(true);
    } finally {
      fixture.close();
    }
  });

  test("rejects dirty source before recording plan approval", async () => {
    const ceiling: SunCeiling = {
      ...DEFAULT_CEILING,
      maxActiveRuntimeMs: 10_000,
      commandTimeoutMs: 500,
      providerTimeoutMs: 500,
      maxOutputTokensPerCall: 200,
      maxTotalTokens: 5_000,
    };
    const fixture = await serviceFixture(ceiling);
    try {
      const planned = await plan(fixture.service, fixture.provider);
      fixture.git.failNextSourceValidation();

      await expect(
        fixture.service.approvePlan(planned.id, planned.planSha256 ?? "", "integration-test"),
      ).rejects.toEqual(expect.objectContaining({ code: "DIRTY_REPOSITORY" }));

      const current = fixture.service.getRun(planned.id);
      expect(current.state).toBe("awaiting_approval");
      expect(current.resumeState).toBeNull();
      expect(fixture.store.listApprovals(planned.id)).toEqual([]);
      expect(fixture.git.createWorkspaceCalls).toBe(0);
      expect(
        fixture.store.listEvents(planned.id).some((event) => event.type === "plan.approved"),
      ).toBe(false);
    } finally {
      fixture.close();
    }
  });

  test("charges a late non-cooperative aggregate stage and keeps execution revalidation", async () => {
    const ceiling: SunCeiling = {
      ...DEFAULT_CEILING,
      maxActiveRuntimeMs: 5_000,
      commandTimeoutMs: 20,
      providerTimeoutMs: 100,
      maxOutputTokensPerCall: 200,
      maxTotalTokens: 5_000,
    };
    const fixture = await serviceFixture(ceiling);
    try {
      const planned = await plan(fixture.service, fixture.provider);
      fixture.git.delaySourceValidationAfter(2, 60);

      const approval = fixture.service.approvePlan(
        planned.id,
        planned.planSha256 ?? "",
        "integration-test",
      );
      await fixture.git.sourceValidationStarted();
      await expect(approval).rejects.toEqual(
        expect.objectContaining({ code: "RUNTIME_BUDGET_EXCEEDED" }),
      );

      const failed = fixture.service.getRun(planned.id);
      expect(failed.state).toBe("failed");
      expect(failed.resumeState).toBe("running");
      expect(fixture.store.listApprovals(planned.id)).toHaveLength(1);
      expect(fixture.git.createWorkspaceCalls).toBe(0);
      expect(failed.usage.toolCalls).toBe(planned.usage.toolCalls + 2);
      expect(failed.usage.activeRuntimeMs).toBeGreaterThan(planned.usage.activeRuntimeMs);
      expect(failed.usage.activeRuntimeMs).toBeLessThanOrEqual(ceiling.maxActiveRuntimeMs);

      const stageEvent = fixture.store
        .listEvents(planned.id)
        .find(
          (event) =>
            event.type === "operation.finished" &&
            (event.payload as Record<string, unknown>).kind === "execution.prepare",
        );
      expect(stageEvent).toEqual(
        expect.objectContaining({
          payload: expect.objectContaining({
            outcome: "failed",
            detail: expect.objectContaining({
              code: "RUNTIME_BUDGET_EXCEEDED",
              chargedRuntimeMs: ceiling.commandTimeoutMs,
              observedRuntimeMs: expect.any(Number),
            }),
          }),
        }),
      );
      if (stageEvent === undefined) {
        throw new Error("Expected execution.prepare operation event");
      }
      const detail = (stageEvent.payload as Record<string, unknown>).detail as Record<
        string,
        unknown
      >;
      expect(detail.observedRuntimeMs).toBeGreaterThan(ceiling.commandTimeoutMs);
    } finally {
      fixture.close();
    }
  });

  test("fails a rollback whose synchronous collaborator overruns the reservation", async () => {
    const ceiling: SunCeiling = {
      ...DEFAULT_CEILING,
      maxActiveRuntimeMs: 10_000,
      commandTimeoutMs: 500,
      providerTimeoutMs: 500,
      maxOutputTokensPerCall: 200,
      maxTotalTokens: 5_000,
    };
    const fixture = await serviceFixture(ceiling);
    let clock = 0;
    const clockSpy = vi.spyOn(performance, "now").mockImplementation(() => clock);
    try {
      const planned = await plan(fixture.service, fixture.provider);
      const awaitingReview = await executeToReview(fixture, planned);
      fixture.git.onNextChangedPaths(() => {
        clock = 10_000;
      });

      await expect(
        fixture.service.rollback(
          planned.id,
          awaitingReview.verification?.diffSha256 ?? "",
          "integration-test",
        ),
      ).rejects.toEqual(expect.objectContaining({ code: "RUNTIME_BUDGET_EXCEEDED" }));

      const failed = fixture.service.getRun(planned.id);
      expect(failed.state).toBe("failed");
      expect(failed.resumeState).toBe("rolling_back");
      const event = fixture.store
        .listEvents(planned.id)
        .find(
          (candidate) =>
            candidate.type === "operation.finished" &&
            (candidate.payload as Record<string, unknown>).kind === "checkpoint.rollback",
        );
      expect(event).toEqual(
        expect.objectContaining({
          payload: expect.objectContaining({
            outcome: "failed",
            detail: expect.objectContaining({
              code: "RUNTIME_BUDGET_EXCEEDED",
              observedRuntimeMs: 10_000,
              chargedRuntimeMs: expect.any(Number),
            }),
          }),
        }),
      );
      const detail = (event?.payload as Record<string, unknown> | undefined)?.detail as
        | Record<string, unknown>
        | undefined;
      expect(detail?.chargedRuntimeMs).toBeLessThan(detail?.observedRuntimeMs as number);
    } finally {
      clockSpy.mockRestore();
      fixture.close();
    }
  });

  test("lands an externally aborted verification as cancelled with baseline restored", async () => {
    const ceiling: SunCeiling = {
      ...DEFAULT_CEILING,
      maxActiveRuntimeMs: 10_000,
      commandTimeoutMs: 500,
      providerTimeoutMs: 500,
      maxOutputTokensPerCall: 200,
      maxTotalTokens: 5_000,
    };
    const fixture = await serviceFixture(ceiling);
    try {
      const planned = await plan(fixture.service, fixture.provider);
      fixture.checks.stallVerification();
      const controller = new AbortController();
      const approval = fixture.service.approvePlan(
        planned.id,
        planned.planSha256 ?? "",
        "integration-test",
        controller.signal,
      );
      await fixture.checks.verificationStarted();
      controller.abort(new Error("Synthetic operator interrupt"));

      const cancelled = await approval;
      expect(cancelled.state).toBe("cancelled");
      expect(cancelled.usage.toolCalls).toBeGreaterThan(planned.usage.toolCalls);
      expect(cancelled.usage.activeRuntimeMs).toBeGreaterThan(planned.usage.activeRuntimeMs);
      expect(
        await readFile(
          path.join(fixture.stateRoot, "runs", planned.id, "worktree", TARGET),
          "utf8",
        ),
      ).toBe(BASELINE);

      const events = fixture.store.listEvents(planned.id);
      const eventTypes = events.map((event) => event.type);
      const cancelledVerificationIndex = events.findIndex(
        (event) =>
          event.type === "operation.finished" &&
          (event.payload as Record<string, unknown>).kind === "sandbox.verify" &&
          (event.payload as Record<string, unknown>).outcome === "cancelled",
      );
      expect(cancelledVerificationIndex).toBeGreaterThanOrEqual(0);
      expect(eventTypes.indexOf("cancellation.requested")).toBeGreaterThan(
        cancelledVerificationIndex,
      );
      expect(eventTypes.indexOf("cancellation.completed")).toBeGreaterThan(
        eventTypes.indexOf("cancellation.requested"),
      );
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "operation.started",
            payload: expect.objectContaining({
              kind: CANCELLATION_RECOVERY_OPERATION_KIND,
              budgetClass: "emergency",
            }),
          }),
        ]),
      );
    } finally {
      fixture.close();
    }
  });

  test("uses emergency recovery after ordinary tool and runtime ceilings are exhausted", async () => {
    const ceiling: SunCeiling = {
      ...DEFAULT_CEILING,
      maxActiveRuntimeMs: 10_000,
      commandTimeoutMs: 500,
      providerTimeoutMs: 500,
      maxOutputTokensPerCall: 200,
      maxTotalTokens: 5_000,
    };
    const fixture = await serviceFixture(ceiling);
    try {
      const planned = await plan(fixture.service, fixture.provider);
      await executeToReview(fixture, planned);
      exhaustOrdinaryBudgets(fixture, planned.id, ceiling);

      const cancelled = await fixture.service.cancel(planned.id, "integration-test");
      expect(cancelled.state).toBe("cancelled");
      expect(cancelled.usage.toolCalls).toBe(ceiling.maxToolCalls + 1);
      expect(cancelled.usage.activeRuntimeMs).toBeGreaterThan(ceiling.maxActiveRuntimeMs);
      expect(
        await readFile(
          path.join(fixture.stateRoot, "runs", planned.id, "worktree", TARGET),
          "utf8",
        ),
      ).toBe(BASELINE);

      const recoveryEvents = fixture.store
        .listEvents(planned.id)
        .filter(
          (event) =>
            (event.payload as Record<string, unknown>).kind ===
            CANCELLATION_RECOVERY_OPERATION_KIND,
        );
      expect(recoveryEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "operation.started",
            payload: expect.objectContaining({
              budgetClass: "emergency",
              attempt: 1,
              reservedRuntimeMs: CANCELLATION_RECOVERY_RUNTIME_MS,
            }),
          }),
          expect.objectContaining({
            type: "operation.finished",
            payload: expect.objectContaining({
              outcome: "succeeded",
              detail: expect.objectContaining({ budgetClass: "emergency" }),
            }),
          }),
        ]),
      );
    } finally {
      fixture.close();
    }
  });

  test("times out recovery fail-closed and performs no work after two attempts", async () => {
    const ceiling: SunCeiling = {
      ...DEFAULT_CEILING,
      maxActiveRuntimeMs: 10_000,
      commandTimeoutMs: 500,
      providerTimeoutMs: 500,
      maxOutputTokensPerCall: 200,
      maxTotalTokens: 5_000,
    };
    const fixture = await serviceFixture(ceiling);
    try {
      const planned = await plan(fixture.service, fixture.provider);
      const awaitingReview = await executeToReview(fixture, planned);
      vi.useFakeTimers();

      fixture.checks.delayNextReconciliation(CANCELLATION_RECOVERY_RUNTIME_MS + 1);
      const firstCancellation = fixture.service.cancel(planned.id, "integration-test");
      const firstRejection = expect(firstCancellation).rejects.toEqual(
        expect.objectContaining({ code: "RECOVERY_TIMEOUT" }),
      );
      await fixture.checks.reconciliationStarted();
      await vi.advanceTimersByTimeAsync(CANCELLATION_RECOVERY_RUNTIME_MS + 1);
      await firstRejection;

      let failed = fixture.service.getRun(planned.id);
      expect(failed.state).toBe("failed");
      expect(failed.resumeState).toBe("cancelling");
      expect(
        await readFile(
          path.join(fixture.stateRoot, "runs", planned.id, "worktree", TARGET),
          "utf8",
        ),
      ).toBe(APPROVED);

      fixture.checks.delayNextReconciliation(CANCELLATION_RECOVERY_RUNTIME_MS + 1);
      const secondCancellation = fixture.service.resume(planned.id);
      const secondRejection = expect(secondCancellation).rejects.toEqual(
        expect.objectContaining({ code: "RECOVERY_TIMEOUT" }),
      );
      await fixture.checks.reconciliationStarted();
      await vi.advanceTimersByTimeAsync(CANCELLATION_RECOVERY_RUNTIME_MS + 1);
      await secondRejection;

      await expect(fixture.service.resume(planned.id)).rejects.toEqual(
        expect.objectContaining({ code: "RECOVERY_ATTEMPTS_EXHAUSTED" }),
      );
      failed = fixture.service.getRun(planned.id);
      expect(failed.state).toBe("failed");
      expect(failed.resumeState).toBe("cancelling");
      expect(failed.lastError?.code).toBe("RECOVERY_ATTEMPTS_EXHAUSTED");
      expect(fixture.checks.reconcileCalls).toBe(2);
      expect(failed.usage.toolCalls).toBe(awaitingReview.usage.toolCalls + 2);
      expect(failed.usage.activeRuntimeMs).toBe(
        awaitingReview.usage.activeRuntimeMs + CANCELLATION_RECOVERY_RUNTIME_MS * 2,
      );

      const recoveryEvents = fixture.store
        .listEvents(planned.id)
        .filter(
          (event) =>
            event.type === "operation.finished" &&
            (event.payload as Record<string, unknown>).kind ===
              CANCELLATION_RECOVERY_OPERATION_KIND,
        );
      expect(recoveryEvents).toHaveLength(2);
      for (const event of recoveryEvents) {
        expect(event.payload).toEqual(
          expect.objectContaining({
            outcome: "failed",
            detail: expect.objectContaining({
              budgetClass: "emergency",
              code: "RECOVERY_TIMEOUT",
              chargedRuntimeMs: CANCELLATION_RECOVERY_RUNTIME_MS,
              observedRuntimeMs: expect.any(Number),
            }),
          }),
        );
        const detail = (event.payload as Record<string, unknown>).detail as Record<string, unknown>;
        expect(detail.observedRuntimeMs).toBeGreaterThan(CANCELLATION_RECOVERY_RUNTIME_MS);
      }
    } finally {
      vi.useRealTimers();
      fixture.close();
    }
  });
});
