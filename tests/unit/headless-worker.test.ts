import { afterEach, describe, expect, test, vi } from "vitest";

import { runCliMain } from "../../packages/cli/src/main.js";
import type { HeadlessExecutionBindingV1 } from "../../packages/core/src/headless-binding.js";
import { createHeadlessWorkerSettlementV1 } from "../../packages/core/src/headless-worker.js";
import { createProviderConfig } from "../../packages/core/src/provider.js";
import type { EventRecord, RunRecord } from "../../packages/core/src/types.js";
import type { IcarusRuntime } from "../../packages/core/src/runtime.js";

const RUN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const binding = {
  runId: RUN_ID,
  bindingDigestSha256: "b".repeat(64),
} as unknown as HeadlessExecutionBindingV1;

afterEach(() => vi.restoreAllMocks());

function run(
  state: RunRecord["state"],
  verification: "passed" | "failed" | "unavailable" | null,
): RunRecord {
  return {
    id: RUN_ID,
    projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    task: "Replace the greeting.",
    target: "src/greeting.txt",
    provider: createProviderConfig({
      kind: "ollama",
      model: "unit-model",
      baseUrl: "http://127.0.0.1:11434/",
    }),
    state,
    resumeState: null,
    baseCommit: "c".repeat(40),
    context: {
      auditPolicyVersion: "tracked-tree-secret-audit-v2",
      baseCommit: "c".repeat(40),
      targets: ["src/greeting.txt"],
      repositoryMap: ["src/greeting.txt"],
      entries: [],
      totalBytes: 0,
    },
    contextArtifactPath: "contexts/unit.json",
    contextSha256: "e".repeat(64),
    plan: null,
    planSha256: "f".repeat(64),
    patchSet: null,
    cachePath: null,
    worktreePath: null,
    baselineBase64: null,
    approvedBase64: null,
    diff: verification === null ? null : "diff",
    verification:
      verification === null
        ? null
        : {
            outcome: verification,
            checks: [],
            changedPaths: [],
            diffSha256: "d".repeat(64),
            checkpointSha256: "c".repeat(64),
          },
    usage: {
      toolCalls: 3,
      inputTokens: 10,
      outputTokens: 5,
      activeRuntimeMs: 20,
      estimatedCostUsd: 0,
      reservedCostUsd: 0,
    },
    lastError: null,
    createdAt: "2026-08-21T12:00:00.000Z",
    updatedAt: "2026-08-21T12:00:01.000Z",
  };
}

function event(sequence: number, type: string, payload: EventRecord["payload"] = {}): EventRecord {
  return { sequence, runId: RUN_ID, type, payload, createdAt: "2026-08-21T12:00:00.000Z" };
}

describe("headless worker settlement", () => {
  test("maps passing review evidence to success", () => {
    expect(
      createHeadlessWorkerSettlementV1({
        binding,
        run: run("awaiting_review", "passed"),
        events: [],
      }),
    ).toMatchObject({ outcome: "review_ready", exitCode: 0, error: null });
  });

  test("maps a human question to incomplete exit 3", () => {
    expect(
      createHeadlessWorkerSettlementV1({
        binding,
        run: run("awaiting_review", "failed"),
        events: [event(1, "session.awaiting_human", { question: "Choose" })],
      }),
    ).toMatchObject({ outcome: "awaiting_human", exitCode: 3 });
  });

  test("maps bounded exhaustion to non-success exit 2", () => {
    expect(
      createHeadlessWorkerSettlementV1({
        binding,
        run: run("awaiting_review", "failed"),
        events: [event(1, "session.exhausted", { iterations: 1 })],
      }),
    ).toMatchObject({ outcome: "exhausted", exitCode: 2 });
  });

  test("maps cancellation to conventional exit 130", () => {
    expect(
      createHeadlessWorkerSettlementV1({ binding, run: run("cancelled", null), events: [] }),
    ).toMatchObject({ outcome: "cancelled", exitCode: 130 });
  });

  test("requires an explicit error for failed settlement", () => {
    expect(() =>
      createHeadlessWorkerSettlementV1({ binding, run: run("failed", null), events: [] }),
    ).toThrowError(/requires an explicit error/);
    expect(
      createHeadlessWorkerSettlementV1({
        binding,
        run: run("failed", null),
        events: [],
        error: { code: "SYNTHETIC_FAILURE", message: "Synthetic failure" },
      }),
    ).toMatchObject({ outcome: "failed", exitCode: 1 });
  });

  test("refuses settlement while an operation remains active", () => {
    expect(() =>
      createHeadlessWorkerSettlementV1({
        binding,
        run: run("awaiting_review", "passed"),
        events: [event(1, "operation.started", { operationId: "operation-1" })],
      }),
    ).toThrowError(/active operation/);
  });

  test("accepts an interrupted operation as quiescent", () => {
    expect(
      createHeadlessWorkerSettlementV1({
        binding,
        run: run("cancelled", null),
        events: [
          event(1, "operation.started", { operationId: "operation-1" }),
          event(2, "operation.interrupted", { operationId: "operation-1" }),
        ],
      }),
    ).toMatchObject({ outcome: "cancelled", exitCode: 130 });
  });

  test("refuses a non-quiescent run state or changed identity", () => {
    expect(() =>
      createHeadlessWorkerSettlementV1({ binding, run: run("running", null), events: [] }),
    ).toThrowError(/non-quiescent state/);
    expect(() =>
      createHeadlessWorkerSettlementV1({
        binding,
        run: { ...run("cancelled", null), id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
        events: [],
      }),
    ).toThrowError(/identity changed/);
  });

  test("CLI prints checksum-terminated JSONL and propagates a non-success exit", async () => {
    const previousHome = process.env.ICARUS_HOME;
    const previousExitCode = process.exitCode;
    const currentRun = run("awaiting_review", "failed");
    const workerEvent = event(1, "headless.worker.settled", {
      bindingDigestSha256: binding.bindingDigestSha256,
      outcome: "awaiting_human",
      exitCode: 3,
    });
    const service = {
      approveHeadlessPlan: vi.fn(async () => ({
        binding,
        run: currentRun,
        settlement: {
          schema: "icarus.headless.worker.v1",
          runId: RUN_ID,
          bindingDigestSha256: binding.bindingDigestSha256,
          outcome: "awaiting_human",
          exitCode: 3,
          finalState: "awaiting_review",
          verificationOutcome: "failed",
          usage: currentRun.usage,
          error: null,
        },
      })),
      history: vi.fn(() => ({ run: currentRun, approvals: [], events: [workerEvent] })),
    };
    const close = vi.fn();
    const createRuntime = vi.fn(async () => ({ service, close }) as unknown as IcarusRuntime);
    const stdout: string[] = [];
    const stderr: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    process.env.ICARUS_HOME = "/tmp/icarus-headless-worker-cli-unit";
    process.exitCode = undefined;
    try {
      await runCliMain({
        args: [
          "run",
          "approve-headless",
          RUN_ID,
          "--plan-sha",
          "f".repeat(64),
          "--actor",
          "operator",
          "--profile-json",
          "{}",
          "--provider-catalog-json",
          "[]",
        ],
        platform: "linux",
        createRuntime,
      });
      const lines = stdout
        .join("")
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(stderr).toEqual([]);
      expect(lines[0]).toMatchObject({ schema: "icarus.headless.history.v1", kind: "run" });
      expect(lines.at(-1)).toMatchObject({ schema: "icarus.headless.history.v1", kind: "end" });
      expect(process.exitCode).toBe(3);
      expect(service.approveHeadlessPlan).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
    } finally {
      process.exitCode = previousExitCode;
      if (previousHome === undefined) delete process.env.ICARUS_HOME;
      else process.env.ICARUS_HOME = previousHome;
    }
  });
});
