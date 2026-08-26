import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { sha256 } from "../../packages/core/src/digest.js";
import {
  DEFAULT_CEILING,
  HEADLESS_HISTORY_SCHEMA,
  headlessChildSpecDigestV1,
  type HeadlessChildSpecV1,
} from "../../packages/core/src/index.js";
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

function withStore<T>(stateRoot: string, read: (store: IcarusStore) => T): T {
  const store = new IcarusStore(path.join(stateRoot, "icarus.sqlite3"));
  try {
    return read(store);
  } finally {
    store.close();
  }
}

function childSpec(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    childId: "c1",
    task: "Replace the greeting in the child workspace.",
    targets: ["src/greeting.txt"],
    toolIds: [],
    budgets: {
      ...DEFAULT_CEILING,
      maxToolCalls: 16,
      maxTotalTokens: 50_000,
      maxActiveRuntimeMs: 60_000,
      maxCostUsd: 1,
      iterationCeiling: 0,
    },
    ...overrides,
  };
}

function childProfile(children: readonly Record<string, unknown>[]): Record<string, unknown> {
  return {
    schemaVersion: 1,
    profileId: "local-headless",
    providerProfileId: "local-provider",
    toolIds: [],
    budgets: { ...DEFAULT_CEILING, iterationCeiling: 0 },
    output: { format: "jsonl" },
    worker: {
      mode: "one_task",
      maxConcurrency: 1,
      childRuns: { maxDepth: 1, maxChildren: 2 },
      scheduledRuns: "deny",
    },
    children,
  };
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

function approveHeadlessArgs(
  planned: RunRecord,
  providerBaseUrl: string,
  profile: Record<string, unknown>,
): readonly string[] {
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
  return [
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
  ];
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

describe("headless isolated child runs", () => {
  test("executes a declared child with recorded lineage and an isolated workspace", async () => {
    const fixture = await createFixtureRepository();
    cleanups.push(fixture.cleanup);
    const preimageSha = sha256("Hello, world!\n");
    const provider = await startOllamaQueue([
      planResponse(),
      editResponse(preimageSha),
      planResponse(),
      editResponse(preimageSha),
    ]);
    cleanups.push(provider.close);
    const sourceBefore = await repositoryFingerprint(fixture.repository);
    const planned = await setupRun(provider, fixture);
    const spec = childSpec();

    const approved = await runCli(
      fixture.stateRoot,
      approveHeadlessArgs(planned, provider.baseUrl, childProfile([spec])),
    );
    if (approved.exitCode !== 0 || approved.stderr !== "") {
      for (const line of approved.stdout.trimEnd().split("\n").slice(-14)) {
        const parsed = JSON.parse(line);
        if (parsed.kind === "event" && String(parsed.type).startsWith("headless."))
          console.log("EVT", line);
        if (
          parsed.kind === "event" &&
          parsed.type === "operation.finished" &&
          parsed.payload?.outcome === "failed"
        )
          console.log("OPF", line);
      }
      console.log("STDERR", approved.stderr);
    }
    expect(stderrWithoutLandlockNotices(approved.stderr)).toBe("");
    expect(approved.exitCode).toBe(0);
    const lines = historyLines(approved.stdout);
    expect(lines.every((line) => line.schema === HEADLESS_HISTORY_SCHEMA)).toBe(true);
    const parentEvents = lines.filter((line) => line.kind === "event");

    // The parent settles review-ready only after its declared child settles.
    const childSettled = parentEvents.filter((line) => line.type === "headless.child.settled");
    expect(childSettled).toHaveLength(1);
    const childSettlementPayload = childSettled[0]?.payload as {
      readonly childId?: unknown;
      readonly childRunId?: unknown;
      readonly outcome?: unknown;
      readonly childBindingDigestSha256?: unknown;
    };
    expect(childSettlementPayload).toMatchObject({
      childId: "c1",
      outcome: "review_ready",
      exitCode: 0,
    });
    const childRunId = childSettlementPayload.childRunId as string;
    expect(childRunId).toEqual(expect.any(String));
    expect(childRunId).not.toBe(planned.id);
    expect(childSettlementPayload.childBindingDigestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(parentEvents.filter((line) => line.type === "headless.worker.settled")).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          schema: "icarus.headless.worker.v1",
          outcome: "review_ready",
          exitCode: 0,
        }),
      }),
    ]);

    // The child is an ordinary run with recorded lineage and its own worker
    // lifecycle, never new authority.
    const child = jsonOutput<RunRecord>(
      await runCli(fixture.stateRoot, ["run", "status", childRunId, "--json"]),
    );
    expect(child.state).toBe("awaiting_review");
    expect(child.verification?.outcome).toBe("passed");
    const childEvents = withStore(fixture.stateRoot, (store) =>
      store.listEvents(childRunId),
    ) as readonly EventRecord[];
    const link = childEvents.find((event) => event.type === "headless.child.linked");
    expect(link).toBeDefined();
    const decodedSpec = childSpec() as unknown as HeadlessChildSpecV1;
    expect(link?.payload).toMatchObject({
      schema: "icarus.headless.child-link.v1",
      runId: childRunId,
      parentRunId: planned.id,
      depth: 1,
      childId: "c1",
      specDigestSha256: headlessChildSpecDigestV1(decodedSpec),
    });
    expect(childEvents.filter((event) => event.type === "headless.worker.started")).toHaveLength(1);
    expect(childEvents.filter((event) => event.type === "headless.worker.settled")).toHaveLength(1);

    // Isolation: the child wrote only its own workspace; the source checkout
    // never moved; both runs consumed their own bounded provider calls.
    expect(
      await readFile(
        path.join(fixture.stateRoot, "runs", childRunId, "worktree", "src/greeting.txt"),
        "utf8",
      ),
    ).toBe("Hello, Icarus!\n");
    expect(
      await readFile(
        path.join(fixture.stateRoot, "runs", planned.id, "worktree", "src/greeting.txt"),
        "utf8",
      ),
    ).toBe("Hello, Icarus!\n");
    expect(provider.requests).toHaveLength(4);
    expect(await repositoryFingerprint(fixture.repository)).toEqual(sourceBefore);
  }, 180_000);

  test("refuses child specifications that widen parent authority before any effect", async () => {
    const fixture = await createFixtureRepository();
    cleanups.push(fixture.cleanup);
    const provider = await startOllamaQueue([planResponse()]);
    cleanups.push(provider.close);
    const planned = await setupRun(provider, fixture);

    const widenedTarget = childProfile([childSpec({ targets: ["src/other.txt"] })]);
    const widenedTool = childProfile([childSpec({ toolIds: ["read_file"] })]);
    const widenedBudget = childProfile([
      childSpec({
        budgets: {
          ...DEFAULT_CEILING,
          maxToolCalls: DEFAULT_CEILING.maxToolCalls + 1,
          iterationCeiling: 0,
        },
      }),
    ]);
    const deniedChildren = {
      ...childProfile([childSpec()]),
      worker: {
        mode: "one_task",
        maxConcurrency: 1,
        childRuns: "deny",
        scheduledRuns: "deny",
      },
    };
    for (const profile of [widenedTarget, widenedTool, widenedBudget, deniedChildren]) {
      const refused = await runCli(
        fixture.stateRoot,
        approveHeadlessArgs(planned, provider.baseUrl, profile),
      );
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr).toContain("HEADLESS_PROFILE_AUTHORITY_DENIED");
    }
    // Every refusal happened at resolution preflight: no approval, no effect.
    expect(provider.requests).toHaveLength(1);
    expect(
      withStore(
        fixture.stateRoot,
        (store) =>
          store.listEvents(planned.id).filter((event) => event.type === "headless.worker.started")
            .length,
      ),
    ).toBe(0);
  }, 180_000);

  test("reconciles a dead parent and child through the existing crash paths", async () => {
    const fixture = await createFixtureRepository();
    cleanups.push(fixture.cleanup);
    const preimageSha = sha256("Hello, world!\n");
    const provider = await startOllamaQueue([
      planResponse(),
      editResponse(preimageSha),
      planResponse(),
      editResponse(preimageSha),
    ]);
    cleanups.push(provider.close);
    const planned = await setupRun(provider, fixture);

    const poll = new IcarusStore(path.join(fixture.stateRoot, "icarus.sqlite3"));
    const worker = spawnCli(
      fixture.stateRoot,
      approveHeadlessArgs(planned, provider.baseUrl, childProfile([childSpec()])),
    );
    let childRunId: string | undefined;
    try {
      const deadline = Date.now() + 120_000;
      for (;;) {
        const parentEvents = poll.listEvents(planned.id);
        const spanStarted = parentEvents.some(
          (event) =>
            event.type === "operation.started" &&
            (event.payload as { readonly kind?: unknown }).kind === "headless.child",
        );
        if (spanStarted) {
          const child = poll.listRuns().find((candidate) => candidate.id !== planned.id);
          if (
            child !== undefined &&
            poll.listEvents(child.id).some((event) => event.type === "headless.worker.started")
          ) {
            childRunId = child.id;
            break;
          }
        }
        if (Date.now() > deadline) {
          throw new Error(
            `Timed out waiting for the child worker; stderr=${worker.output().stderr}`,
          );
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(worker.child.kill("SIGSTOP")).toBe(true);
      expect(worker.child.kill("SIGKILL")).toBe(true);
    } finally {
      poll.close();
    }
    expect(await worker.exit).toEqual({ code: null, signal: "SIGKILL" });
    expect(childRunId).toEqual(expect.any(String));
    const childId = childRunId as string;

    // Both tails are closed by the unchanged H3a path, child first.
    const childReconciled = await runCli(fixture.stateRoot, ["run", "reconcile-headless", childId]);
    expect(childReconciled.exitCode).toBe(1);
    const parentReconciled = await runCli(fixture.stateRoot, [
      "run",
      "reconcile-headless",
      planned.id,
    ]);
    expect(parentReconciled.exitCode).toBe(1);

    // A dead child's open span leaves the parent's tail ambiguous; a
    // child-bearing worker is refused either way, before any resume intent.
    const resumed = await runCli(fixture.stateRoot, ["run", "resume-headless", planned.id]);
    expect(resumed.exitCode).toBe(1);
    expect(resumed.stderr).toContain("HEADLESS_CONTINUATION_DENIED");
    expect(
      withStore(
        fixture.stateRoot,
        (store) =>
          store
            .listEvents(planned.id)
            .filter((event) => event.type === "headless.worker.resume_requested").length,
      ),
    ).toBe(0);
  }, 180_000);
});
