import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  DEFAULT_CEILING,
  HEADLESS_HISTORY_SCHEMA,
  type HeadlessHistoryContentLine,
  headlessHistoryContentSha256,
} from "../../packages/core/src/index.js";
import { IcarusStore } from "../../packages/core/src/store.js";
import type { RunRecord } from "../../packages/core/src/types.js";
import {
  createFixtureRepository,
  jsonOutput,
  planResponse,
  PYTHON_IMAGE,
  repositoryFingerprint,
  runCli,
} from "../support/integration-cli.js";

const cleanups: Array<() => Promise<void>> = [];
let forceColor: string | undefined;
let noColor: string | undefined;

beforeEach(() => {
  forceColor = process.env.FORCE_COLOR;
  noColor = process.env.NO_COLOR;
  delete process.env.FORCE_COLOR;
  delete process.env.NO_COLOR;
});

afterEach(async () => {
  try {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  } finally {
    if (forceColor === undefined) delete process.env.FORCE_COLOR;
    else process.env.FORCE_COLOR = forceColor;
    if (noColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = noColor;
  }
});

async function interruptibleProvider(): Promise<{
  readonly baseUrl: string;
  readonly requests: readonly Record<string, unknown>[];
  readonly effectStarted: Promise<void>;
  close(): Promise<void>;
}> {
  const requests: Record<string, unknown>[] = [];
  let resolveEffectStarted: (() => void) | undefined;
  const effectStarted = new Promise<void>((resolve) => {
    resolveEffectStarted = resolve;
  });
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      if (requests.length === 1) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            message: { content: JSON.stringify(planResponse().content) },
            prompt_eval_count: 12,
            eval_count: 8,
          }),
        );
        return;
      }
      resolveEffectStarted?.();
      // Deliberately keep the effect request open until the worker is killed.
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing provider address");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/`,
    requests,
    effectStarted,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function spawnCli(stateRoot: string, args: readonly string[]) {
  const child = spawn(process.execPath, ["packages/cli/dist/main.js", ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      // Crash-fidelity tests kill the worker by pid; the ADR 0062 sandbox
      // wrapper would orphan the real worker grandchild, so they run unsandboxed.
      ICARUS_SANDBOX_PROFILE: "off",
      ICARUS_HOME: stateRoot,
    },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  return {
    child,
    exit: new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      },
    ),
    output: () => ({
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }),
  };
}

describe("headless worker crash-tail recovery", () => {
  test("kills after operation start, appends one interrupted settlement, and refuses unbound resume", async () => {
    const fixture = await createFixtureRepository();
    cleanups.push(fixture.cleanup);
    const provider = await interruptibleProvider();
    cleanups.push(provider.close);
    const sourceBefore = await repositoryFingerprint(fixture.repository);

    expect(
      (
        await runCli(fixture.stateRoot, [
          "repo",
          "add",
          "--name",
          "fixture",
          "--path",
          fixture.repository,
        ])
      ).exitCode,
    ).toBe(0);
    expect(
      (
        await runCli(fixture.stateRoot, [
          "project",
          "add",
          "--name",
          "golden",
          "--repo",
          "fixture",
          "--base-ref",
          "main",
          "--sandbox-image",
          PYTHON_IMAGE,
          "--check",
          JSON.stringify({ id: "verify", name: "verify", argv: ["python", "checks/verify.py"] }),
        ])
      ).exitCode,
    ).toBe(0);
    const planned = jsonOutput<RunRecord>(
      await runCli(fixture.stateRoot, [
        "run",
        "plan",
        "--project",
        "golden",
        "--task",
        "Replace the greeting.",
        "--target",
        "src/greeting.txt",
        "--provider",
        "ollama",
        "--model",
        "contract-model",
        "--base-url",
        provider.baseUrl,
      ]),
    );
    const profile = {
      schemaVersion: 1,
      profileId: "local-headless",
      providerProfileId: "local-provider",
      toolIds: [],
      budgets: { ...DEFAULT_CEILING, iterationCeiling: 0 },
      output: { format: "jsonl" },
      worker: {
        mode: "one_task",
        maxConcurrency: 1,
        childRuns: "deny",
        scheduledRuns: "deny",
        mutation: "apply",
      },
    };
    const catalog = [
      {
        id: "local-provider",
        kind: "ollama",
        model: "contract-model",
        baseUrl: provider.baseUrl,
        inputUsdPerMillionTokens: null,
        outputUsdPerMillionTokens: null,
      },
    ];
    const worker = spawnCli(fixture.stateRoot, [
      "run",
      "approve-headless",
      planned.id,
      "--plan-sha",
      planned.planSha256 ?? "",
      "--actor",
      "integration-test",
      "--profile-json",
      JSON.stringify(profile),
      "--provider-catalog-json",
      JSON.stringify(catalog),
    ]);

    await provider.effectStarted;
    expect(worker.child.kill("SIGKILL")).toBe(true);
    expect(await worker.exit).toEqual({ code: null, signal: "SIGKILL" });
    expect(worker.output().stdout).toBe("");
    expect(provider.requests).toHaveLength(2);
    const crashed = jsonOutput<RunRecord>(
      await runCli(fixture.stateRoot, ["run", "status", planned.id, "--json"]),
    );

    const interruptedStore = new IcarusStore(path.join(fixture.stateRoot, "icarus.sqlite3"));
    try {
      interruptedStore.markStartedOperationsInterrupted(planned.id);
      const interruptedEvents = interruptedStore.listEvents(planned.id);
      expect(
        interruptedEvents.filter((event) => event.type === "operation.interrupted"),
      ).toHaveLength(1);
      expect(
        interruptedEvents.filter((event) => event.type === "headless.worker.settled"),
      ).toHaveLength(0);
    } finally {
      interruptedStore.close();
    }

    const recovered = await runCli(fixture.stateRoot, ["run", "reconcile-headless", planned.id]);
    expect(recovered.exitCode).toBe(1);
    expect(recovered.stderr).toBe("");
    const lines = recovered.stdout
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.every((line) => line.schema === HEADLESS_HISTORY_SCHEMA)).toBe(true);
    expect((lines.at(-1) as { readonly contentSha256?: string }).contentSha256).toBe(
      headlessHistoryContentSha256(
        lines.slice(0, -1) as unknown as readonly HeadlessHistoryContentLine[],
      ),
    );
    const events = lines.filter((line) => line.kind === "event");
    const interrupted = events.filter((line) => line.type === "operation.interrupted");
    expect(interrupted).toHaveLength(1);
    const interruptedPayload = interrupted[0]?.payload as
      | {
          readonly operationId?: unknown;
          readonly reservedCostUsd?: unknown;
          readonly reservedTokens?: unknown;
          readonly reservedRuntimeMs?: unknown;
        }
      | undefined;
    const interruptedOperationId = interruptedPayload?.operationId;
    expect(interruptedOperationId).toEqual(expect.any(String));
    expect(interruptedPayload).toEqual(
      expect.objectContaining({
        reservedCostUsd: expect.any(Number),
        reservedTokens: expect.any(Number),
        reservedRuntimeMs: expect.any(Number),
      }),
    );
    const recoveredRun = (
      lines.find((line) => line.kind === "run") as
        | { readonly run?: { readonly usage?: RunRecord["usage"] } }
        | undefined
    )?.run;
    const recoveredUsage = recoveredRun?.usage;
    expect(recoveredUsage).toBeDefined();
    expect(crashed.usage.reservedCostUsd).toBe(interruptedPayload?.reservedCostUsd);
    expect(recoveredUsage?.reservedCostUsd).toBe(
      crashed.usage.reservedCostUsd - (interruptedPayload?.reservedCostUsd as number),
    );
    expect(recoveredUsage?.toolCalls).toBe(crashed.usage.toolCalls);
    expect(recoveredUsage?.inputTokens).toBe(
      crashed.usage.inputTokens + (interruptedPayload?.reservedTokens as number),
    );
    expect(recoveredUsage?.outputTokens).toBe(crashed.usage.outputTokens);
    expect(recoveredUsage?.activeRuntimeMs).toBe(
      crashed.usage.activeRuntimeMs + (interruptedPayload?.reservedRuntimeMs as number),
    );
    expect(recoveredUsage?.estimatedCostUsd).toBeCloseTo(
      crashed.usage.estimatedCostUsd + (interruptedPayload?.reservedCostUsd as number),
    );
    expect(events.filter((line) => line.type === "headless.worker.settled")).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          schema: "icarus.headless.worker-interruption.v1",
          outcome: "interrupted",
          exitCode: 1,
          error: expect.objectContaining({ code: "HEADLESS_WORKER_INTERRUPTED" }),
          reconciliation: expect.objectContaining({
            interruptedOperationIds: [interruptedOperationId],
            continuation: "requires_binding_reconstruction",
          }),
        }),
      }),
    ]);

    const repeated = await runCli(fixture.stateRoot, ["run", "reconcile-headless", planned.id]);
    expect(repeated.exitCode).toBe(1);
    expect(repeated.stdout).toBe(recovered.stdout);
    const resume = await runCli(fixture.stateRoot, ["run", "resume", planned.id]);
    expect(resume.exitCode).toBe(1);
    expect(resume.stderr).toContain("HEADLESS_BINDING_RECONSTRUCTION_REQUIRED");
    expect(provider.requests).toHaveLength(2);
    expect(await repositoryFingerprint(fixture.repository)).toEqual(sourceBefore);
  }, 180_000);
});
