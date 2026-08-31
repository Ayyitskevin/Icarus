import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { canonicalJson } from "../../packages/core/src/canonical-json.js";
import type { JsonValue } from "../../packages/core/src/types.js";
import { DEFAULT_CEILING } from "../../packages/core/src/index.js";
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
            model: String(requests.at(-1)?.model ?? "synthetic-ollama-model"),
            message: { content: JSON.stringify(planResponse().content) },
            done: true,
            done_reason: "stop",
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

describe("headless evidence reconstruction after a real crash", () => {
  test("reconstructs binding and crash tail read-only, before and after reconciliation", async () => {
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
    expect(provider.requests).toHaveLength(2);

    const databasePath = path.join(fixture.stateRoot, "icarus.sqlite3");
    const durableStartedDigest = (): string => {
      const store = new IcarusStore(databasePath);
      try {
        const started = store
          .listEvents(planned.id)
          .find((event) => event.type === "headless.worker.started");
        const payload = started?.payload as { bindingDigestSha256?: unknown } | undefined;
        expect(payload?.bindingDigestSha256).toEqual(expect.any(String));
        return payload?.bindingDigestSha256 as string;
      } finally {
        store.close();
      }
    };
    const eventCount = (): number => {
      const store = new IcarusStore(databasePath);
      try {
        return store.listEvents(planned.id).length;
      } finally {
        store.close();
      }
    };
    const expectedBindingDigest = durableStartedDigest();

    // Reconstruction over the raw crash tail: read-only, lifecycle still open.
    const beforeOpen = eventCount();
    const open = await runCli(fixture.stateRoot, ["run", "reconstruct-headless", planned.id]);
    expect(open.exitCode).toBe(0);
    expect(open.stderr).toBe("");
    expect(eventCount()).toBe(beforeOpen);
    const openRecord = JSON.parse(open.stdout) as Record<string, unknown>;
    expect(openRecord).toMatchObject({
      schema: "icarus.headless.reconstruction.v1",
      runId: planned.id,
      lifecycle: "started",
      bindingDigestSha256: expectedBindingDigest,
    });
    // The complete line is one canonical JSON record.
    expect(open.stdout).toBe(`${canonicalJson(openRecord as JsonValue)}\n`);
    const openEffects = openRecord.effects as readonly Record<string, unknown>[];
    const openEffect = openEffects.find((effect) => effect.kind === "provider.edit");
    expect(openEffect).toMatchObject({ settlement: null, disposition: "ambiguous" });
    // Finished tail operations settle durably; every open tail operation is
    // ambiguous because its remote or filesystem effect is unknown.
    for (const effect of openEffects) {
      expect(effect.disposition).toBe(
        effect.settlement === "finished" ? "durably_settled" : "ambiguous",
      );
    }

    // Reconcile the crash tail, then reconstruct the settled lifecycle.
    const reconciled = await runCli(fixture.stateRoot, ["run", "reconcile-headless", planned.id]);
    expect(reconciled.exitCode).toBe(1);

    const beforeSettled = eventCount();
    const settled = await runCli(fixture.stateRoot, ["run", "reconstruct-headless", planned.id]);
    expect(settled.exitCode).toBe(0);
    expect(settled.stderr).toBe("");
    const settledRecord = JSON.parse(settled.stdout) as Record<string, unknown>;
    expect(settledRecord).toMatchObject({
      schema: "icarus.headless.reconstruction.v1",
      runId: planned.id,
      lifecycle: "settled",
      startedEventSequence: openRecord.startedEventSequence,
      bindingDigestSha256: expectedBindingDigest,
    });
    const settledEffects = settledRecord.effects as readonly Record<string, unknown>[];
    const settledEffect = settledEffects.find((effect) => effect.kind === "provider.edit");
    expect(settledEffect).toMatchObject({ settlement: "interrupted", disposition: "ambiguous" });
    for (const effect of settledEffects) {
      expect(effect.disposition).toBe(
        effect.settlement === "finished" ? "durably_settled" : "ambiguous",
      );
    }

    // Repeated reconstruction is byte-identical and appends nothing.
    const repeated = await runCli(fixture.stateRoot, ["run", "reconstruct-headless", planned.id]);
    expect(repeated.exitCode).toBe(0);
    expect(repeated.stdout).toBe(settled.stdout);
    expect(eventCount()).toBe(beforeSettled);

    // Classification never recorded resume intent and never executed an effect.
    const store = new IcarusStore(databasePath);
    try {
      const events = store.listEvents(planned.id);
      expect(events.filter((event) => event.type === "resume.requested")).toHaveLength(0);
      const run = store.getRun(planned.id);
      expect(run.resumeState).toBeNull();
    } finally {
      store.close();
    }
    expect(provider.requests).toHaveLength(2);
    expect(await repositoryFingerprint(fixture.repository)).toEqual(sourceBefore);

    // Ordinary resume remains refused after reconstruction.
    const resume = await runCli(fixture.stateRoot, ["run", "resume", planned.id]);
    expect(resume.exitCode).toBe(1);
    expect(resume.stderr).toContain("HEADLESS_BINDING_RECONSTRUCTION_REQUIRED");
  }, 180_000);
});
