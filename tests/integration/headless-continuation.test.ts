import { spawn } from "node:child_process";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { sha256 } from "../../packages/core/src/digest.js";
import { DEFAULT_CEILING, HEADLESS_HISTORY_SCHEMA } from "../../packages/core/src/index.js";
import { IcarusStore } from "../../packages/core/src/store.js";
import type { EventRecord, RunRecord } from "../../packages/core/src/types.js";
import {
  createFixtureRepository,
  editResponse,
  jsonOutput,
  planResponse,
  PYTHON_IMAGE,
  repositoryFingerprint,
  runCli,
  startOllamaQueue,
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

function spawnCli(stateRoot: string, args: readonly string[], extraEnv: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, ["packages/cli/dist/main.js", ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...extraEnv,
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

function withStore<T>(stateRoot: string, read: (store: IcarusStore) => T): T {
  const store = new IcarusStore(path.join(stateRoot, "icarus.sqlite3"));
  try {
    return read(store);
  } finally {
    store.close();
  }
}

/**
 * One long-lived read connection for crash-point polling. It must be opened
 * while the database is quiet and held for the whole worker lifetime:
 * reopening per poll races the worker's own schema inspection, which fails
 * closed (RUN_BUSY) when the SQLite family changes mid-check. WAL readers do
 * not block or perturb the writer.
 */
function openPollStore(stateRoot: string): IcarusStore {
  return new IcarusStore(path.join(stateRoot, "icarus.sqlite3"));
}

/** Poll durable events until the predicate holds, then stop and kill the child. */
async function killAfter(
  poll: IcarusStore,
  runId: string,
  child: {
    readonly child: { kill(signal: NodeJS.Signals): boolean };
    output(): { readonly stdout: string; readonly stderr: string };
  },
  predicate: (events: readonly EventRecord[]) => boolean,
): Promise<void> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    if (predicate(poll.listEvents(runId))) {
      // SIGSTOP first so the kill cannot lose a race against the next durable
      // transition; then SIGKILL is a real process death.
      expect(child.child.kill("SIGSTOP")).toBe(true);
      expect(predicate(poll.listEvents(runId))).toBe(true);
      expect(child.child.kill("SIGKILL")).toBe(true);
      return;
    }
    if (Date.now() > deadline) {
      const seen = poll.listEvents(runId).map((event) => `${event.sequence}:${event.type}`);
      throw new Error(
        `Timed out waiting for the durable crash point; seen=${seen.join(",")} stdout=${child.output().stdout} stderr=${child.output().stderr}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * Deterministic clean-crash kill at the exact edit boundary. The worker is
 * spawned with `ICARUS_TEST_PAUSE_AFTER_PATCH_SET_INTENT_FILE` naming a
 * sentinel the fixture never creates, so the runtime's test-seam hook suspends
 * it after patch-set intent is durable and before materialization can begin —
 * no wall-clock race, on any runner speed. The durable sighting plus the
 * frozen-position assertion below prove the kill landed in the boundary.
 */
async function killAtCleanEditBoundary(
  poll: IcarusStore,
  runId: string,
  child: {
    readonly child: { kill(signal: NodeJS.Signals): boolean };
    output(): { readonly stdout: string; readonly stderr: string };
  },
): Promise<void> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const events = poll.listEvents(runId);
    if (events.some((event) => event.type === "patch_set.intent_recorded")) {
      expect(child.child.kill("SIGSTOP")).toBe(true);
      const frozen = poll.listEvents(runId);
      expect(frozen.some((event) => event.type === "patch_set.intent_recorded")).toBe(true);
      expect(
        frozen.some(
          (event) =>
            event.type === "operation.started" &&
            (event.payload as { readonly kind?: unknown }).kind === "edit.materialize",
        ),
      ).toBe(false);
      expect(child.child.kill("SIGKILL")).toBe(true);
      return;
    }
    if (Date.now() > deadline) {
      const seen = events.map((event) => `${event.sequence}:${event.type}`);
      throw new Error(
        `Timed out waiting for the edit boundary; seen=${seen.join(",")} stdout=${child.output().stdout} stderr=${child.output().stderr}`,
      );
    }
    // Yield so the in-process loopback provider's event loop can turn.
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function setupRun(
  provider: { readonly baseUrl: string },
  fixture: { readonly stateRoot: string; readonly repository: string },
): Promise<RunRecord> {
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
  return jsonOutput<RunRecord>(
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
}

async function spawnHeadlessWorker(
  stateRoot: string,
  planned: RunRecord,
  providerBaseUrl: string,
  extraEnv: NodeJS.ProcessEnv = {},
) {
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
      baseUrl: providerBaseUrl,
      inputUsdPerMillionTokens: null,
      outputUsdPerMillionTokens: null,
    },
  ];
  return spawnCli(
    stateRoot,
    [
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
    ],
    extraEnv,
  );
}

/** ADR 0062: hosts without Landlock emit one canonical no-op notice on stderr. */
function stderrWithoutLandlockNotices(stderr: string): string {
  return stderr
    .split("\n")
    .filter((line) => {
      try {
        return (JSON.parse(line) as { schema?: unknown }).schema !== "icarus.landlock-notice.v1";
      } catch {
        return true;
      }
    })
    .join("\n");
}

function historyLines(stdout: string): readonly Record<string, unknown>[] {
  return stdout
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("headless exactly-once continuation", () => {
  test("resumes a reconciled crash exactly once, then returns byte-identical evidence", async () => {
    const fixture = await createFixtureRepository();
    cleanups.push(fixture.cleanup);
    const preimageSha = sha256("Hello, world!\n");
    const provider = await startOllamaQueue([planResponse(), editResponse(preimageSha)]);
    cleanups.push(provider.close);
    const sourceBefore = await repositoryFingerprint(fixture.repository);
    const planned = await setupRun(provider, fixture);
    expect(provider.requests).toHaveLength(1);

    // Deterministic clean crash: the runtime's test-seam hook suspends the
    // worker at the exact edit boundary (intent durable, materialization not
    // started) because the sentinel file is never created.
    const poll = openPollStore(fixture.stateRoot);
    const worker = await spawnHeadlessWorker(fixture.stateRoot, planned, provider.baseUrl, {
      ICARUS_TEST_PAUSE_AFTER_PATCH_SET_INTENT_FILE: path.join(fixture.stateRoot, "pause-sentinel"),
    });
    try {
      await killAtCleanEditBoundary(poll, planned.id, worker);
    } finally {
      poll.close();
    }
    expect(await worker.exit).toEqual({ code: null, signal: "SIGKILL" });
    expect(provider.requests).toHaveLength(2);

    const reconciled = await runCli(fixture.stateRoot, ["run", "reconcile-headless", planned.id]);
    expect(reconciled.exitCode).toBe(1);

    // The evidence boundary proves the crash tail clean before continuation.
    const evidence = await runCli(fixture.stateRoot, ["run", "reconstruct-headless", planned.id]);
    expect(evidence.exitCode).toBe(0);
    const record = JSON.parse(evidence.stdout) as {
      readonly lifecycle: string;
      readonly effects: readonly { readonly disposition: string }[];
    };
    expect(record.lifecycle).toBe("settled");
    expect(record.effects.length).toBeGreaterThan(0);
    expect(record.effects.every((effect) => effect.disposition !== "ambiguous")).toBe(true);

    const eventCountBefore = withStore(
      fixture.stateRoot,
      (store) => store.listEvents(planned.id).length,
    );
    const resumed = await runCli(fixture.stateRoot, ["run", "resume-headless", planned.id]);
    expect(resumed.exitCode).toBe(0);
    expect(stderrWithoutLandlockNotices(resumed.stderr)).toBe("");
    const lines = historyLines(resumed.stdout);
    expect(lines.every((line) => line.schema === HEADLESS_HISTORY_SCHEMA)).toBe(true);
    const events = lines.filter((line) => line.kind === "event");
    expect(events.filter((line) => line.type === "headless.worker.resume_requested")).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          schema: "icarus.headless.worker-resume.v1",
          bindingDigestSha256: expect.any(String),
          reconstructionDigestSha256: expect.any(String),
        }),
      }),
    ]);
    const settlements = events.filter((line) => line.type === "headless.worker.settled");
    expect(settlements).toHaveLength(2);
    expect(settlements[0]).toMatchObject({
      payload: { schema: "icarus.headless.worker-interruption.v1", outcome: "interrupted" },
    });
    expect(settlements[1]).toMatchObject({
      payload: {
        schema: "icarus.headless.worker-continuation.v1",
        outcome: "review_ready",
        exitCode: 0,
      },
    });

    // Exactly once: the settled provider edit was never re-executed, the work
    // completed from durable intent, and the source checkout is untouched.
    expect(provider.requests).toHaveLength(2);
    expect(
      events.filter(
        (line) =>
          line.type === "operation.started" &&
          (line.payload as { readonly kind?: unknown }).kind === "provider.edit",
      ),
    ).toHaveLength(1);
    const resumedRun = jsonOutput<RunRecord>(
      await runCli(fixture.stateRoot, ["run", "status", planned.id, "--json"]),
    );
    expect(resumedRun.state).toBe("awaiting_review");
    expect(resumedRun.verification?.outcome).toBe("passed");
    expect(await repositoryFingerprint(fixture.repository)).toEqual(sourceBefore);

    // A double resume returns byte-identical evidence and appends nothing.
    const eventCountAfter = withStore(
      fixture.stateRoot,
      (store) => store.listEvents(planned.id).length,
    );
    expect(eventCountAfter).toBeGreaterThan(eventCountBefore);
    const repeated = await runCli(fixture.stateRoot, ["run", "resume-headless", planned.id]);
    expect(repeated.exitCode).toBe(0);
    expect(repeated.stdout).toBe(resumed.stdout);
    expect(withStore(fixture.stateRoot, (store) => store.listEvents(planned.id).length)).toBe(
      eventCountAfter,
    );
    expect(provider.requests).toHaveLength(2);
  }, 180_000);

  test("refuses continuation when the crash tail is ambiguous", async () => {
    const fixture = await createFixtureRepository();
    cleanups.push(fixture.cleanup);
    const provider = await startOllamaQueue([planResponse()]);
    cleanups.push(provider.close);
    const sourceBefore = await repositoryFingerprint(fixture.repository);
    const planned = await setupRun(provider, fixture);

    // The edit request never answers; the worker dies with the provider
    // operation open, so its remote outcome is unknowable.
    const poll = openPollStore(fixture.stateRoot);
    const worker = await spawnHeadlessWorker(fixture.stateRoot, planned, provider.baseUrl);
    try {
      await killAfter(poll, planned.id, worker, (events) =>
        events.some(
          (event) =>
            event.type === "operation.started" &&
            (event.payload as { readonly kind?: unknown }).kind === "provider.edit",
        ),
      );
    } finally {
      poll.close();
    }
    expect(await worker.exit).toEqual({ code: null, signal: "SIGKILL" });
    // The provider edit operation died open; whether its request reached the
    // provider at all is unknowable, which is exactly why the tail is
    // ambiguous. The plan request is the only observed call.
    expect(provider.requests).toHaveLength(1);

    const reconciled = await runCli(fixture.stateRoot, ["run", "reconcile-headless", planned.id]);
    expect(reconciled.exitCode).toBe(1);

    const eventCount = withStore(fixture.stateRoot, (store) => store.listEvents(planned.id).length);
    const resumed = await runCli(fixture.stateRoot, ["run", "resume-headless", planned.id]);
    expect(resumed.exitCode).toBe(1);
    expect(resumed.stderr).toContain("HEADLESS_CONTINUATION_DENIED");
    // No resume intent, no effect, no state change.
    expect(withStore(fixture.stateRoot, (store) => store.listEvents(planned.id).length)).toBe(
      eventCount,
    );
    expect(
      withStore(
        fixture.stateRoot,
        (store) =>
          store
            .listEvents(planned.id)
            .filter((event) => event.type === "headless.worker.resume_requested").length,
      ),
    ).toBe(0);
    expect(provider.requests).toHaveLength(1);
    expect(await repositoryFingerprint(fixture.repository)).toEqual(sourceBefore);
  }, 180_000);

  test("closes a crashed continuation once and refuses a second resume", async () => {
    const fixture = await createFixtureRepository();
    cleanups.push(fixture.cleanup);
    const preimageSha = sha256("Hello, world!\n");
    const provider = await startOllamaQueue([planResponse(), editResponse(preimageSha)]);
    cleanups.push(provider.close);
    const planned = await setupRun(provider, fixture);

    // Same deterministic boundary kill for the first crash.
    const poll = openPollStore(fixture.stateRoot);
    const worker = await spawnHeadlessWorker(fixture.stateRoot, planned, provider.baseUrl, {
      ICARUS_TEST_PAUSE_AFTER_PATCH_SET_INTENT_FILE: path.join(fixture.stateRoot, "pause-sentinel"),
    });
    await killAtCleanEditBoundary(poll, planned.id, worker);
    expect(await worker.exit).toEqual({ code: null, signal: "SIGKILL" });
    expect(
      (await runCli(fixture.stateRoot, ["run", "reconcile-headless", planned.id])).exitCode,
    ).toBe(1);

    // The continuation begins and dies inside the sandboxed check.
    const continuation = spawnCli(fixture.stateRoot, ["run", "resume-headless", planned.id]);
    try {
      await killAfter(poll, planned.id, continuation, (events) =>
        events.some(
          (event) =>
            event.type === "operation.started" &&
            (event.payload as { readonly kind?: unknown }).kind === "sandbox.verify" &&
            events.some((candidate) => candidate.type === "headless.worker.resume_requested"),
        ),
      );
    } finally {
      poll.close();
    }
    expect(await continuation.exit).toEqual({ code: null, signal: "SIGKILL" });
    expect(provider.requests).toHaveLength(2);

    // H3a closes the crashed continuation epoch with a second interruption.
    const reconciled = await runCli(fixture.stateRoot, ["run", "reconcile-headless", planned.id]);
    expect(reconciled.exitCode).toBe(1);
    const lines = historyLines(reconciled.stdout);
    const settlements = lines.filter(
      (line) => line.kind === "event" && line.type === "headless.worker.settled",
    );
    expect(settlements).toHaveLength(2);
    expect(
      settlements.every(
        (line) =>
          (line.payload as { readonly schema?: unknown }).schema ===
          "icarus.headless.worker-interruption.v1",
      ),
    ).toBe(true);

    // The single continuation allowance is spent; a second resume fails closed.
    const second = await runCli(fixture.stateRoot, ["run", "resume-headless", planned.id]);
    expect(second.exitCode).toBe(1);
    expect(second.stderr).toContain("HEADLESS_WORKER_CONTINUATION_EXHAUSTED");
    expect(provider.requests).toHaveLength(2);
  }, 180_000);
});
