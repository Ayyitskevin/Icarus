import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { DEFAULT_CEILING, HEADLESS_HISTORY_SCHEMA } from "../../packages/core/src/index.js";
import { sha256 } from "../../packages/core/src/digest.js";
import {
  buildLandlockSandboxSpec,
  defaultLandlockHelperSourcePath,
  detectLandlockSupport,
  landlockHelperArgv,
} from "../../packages/core/src/landlock.js";
import type { RunRecord } from "../../packages/core/src/types.js";
import {
  createFixtureRepository,
  editResponse,
  jsonOutput,
  planResponse,
  PYTHON_IMAGE,
  runCli,
  startOllamaQueue,
} from "../support/integration-cli.js";

const RUN_TIMEOUT_MS = 240_000;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

interface HelperHandle {
  readonly status: "supported";
  readonly helperPath: string;
  readonly abi: number;
}

interface HelperUnavailable {
  readonly status: "unavailable";
  readonly reason: string;
}

type HelperProbe = HelperHandle | HelperUnavailable;

const REQUIRE_LANDLOCK_TESTS_ENV = "ICARUS_REQUIRE_LANDLOCK_TESTS";

function unavailable(reason: string): HelperUnavailable {
  if (process.env[REQUIRE_LANDLOCK_TESTS_ENV] === "1") {
    throw new Error(`The Landlock release gate could not exercise the kernel boundary: ${reason}`);
  }
  return { status: "unavailable", reason };
}

function run(
  command: string,
  argv: readonly string[],
  options: { readonly env?: NodeJS.ProcessEnv } = {},
): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      ...(options.env === undefined ? {} : { env: options.env }),
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) =>
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }),
    );
  });
}

/**
 * Compiles the helper and probes the kernel ABI. Returns the concrete reason
 * when the host cannot exercise the real path so tests can report a real skip
 * instead of silently returning as though the boundary passed.
 */
async function compileAndProbe(): Promise<HelperProbe> {
  if (process.platform !== "linux") {
    return unavailable(`Landlock is Linux-only; platform is ${process.platform}`);
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), "icarus-landlock-test-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const helperPath = path.join(directory, "landlock-sandbox");
  const compiler =
    process.env.CC !== undefined && process.env.CC.length > 0 ? process.env.CC : "cc";
  const compiled = await run(compiler, [
    "-O2",
    "-Wall",
    "-Wextra",
    "-o",
    helperPath,
    defaultLandlockHelperSourcePath(),
  ]);
  if (compiled.code !== 0) {
    return unavailable(
      `Landlock helper compilation failed with exit ${String(compiled.code)}: ${compiled.stderr.trim()}`,
    );
  }
  const probed = await run(helperPath, ["--probe"]);
  if (probed.code !== 0) {
    return unavailable(
      `Landlock helper probe failed with exit ${String(probed.code)}: ${probed.stderr.trim()}`,
    );
  }
  const abi = Number(probed.stdout.trim());
  const support = detectLandlockSupport({
    platform: process.platform,
    kernelRelease: os.release(),
    abi: Number.isSafeInteger(abi) ? abi : null,
  });
  if (support.status !== "supported") {
    return unavailable(support.reason);
  }
  return { status: "supported", helperPath, abi: support.abi };
}

async function sandboxed(
  helper: HelperHandle,
  spec: ReturnType<typeof buildLandlockSandboxSpec>,
  command: readonly string[],
): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
  const argv = landlockHelperArgv(helper.helperPath, spec, command);
  return run(argv[0] ?? helper.helperPath, argv.slice(1));
}

describe("landlock sandbox kernel enforcement", () => {
  test("workspace rules: writes confined to the rw root, host read-only", async ({ skip }) => {
    const helper = await compileAndProbe();
    if (helper.status === "unavailable") {
      skip(helper.reason);
      return;
    }
    const root = await mkdtemp(path.join(os.tmpdir(), "icarus-landlock-ws-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const stateRoot = path.join(root, "state");
    const outside = path.join(root, "outside");
    await run("mkdir", ["-p", stateRoot, outside]);
    const spec = buildLandlockSandboxSpec("workspace", {
      stateRoot,
      executablePath: process.execPath,
    });
    const script = [
      `echo ok > '${stateRoot}/written' && echo rw-write-ok`,
      `cat /etc/hostname > /dev/null && echo host-read-ok`,
      `echo nope > '${outside}/denied' 2> /dev/null || echo outside-write-blocked`,
    ].join("; ");
    const result = await sandboxed(helper, spec, ["/bin/sh", "-c", script]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("rw-write-ok");
    expect(result.stdout).toContain("host-read-ok");
    expect(result.stdout).toContain("outside-write-blocked");
  });

  test("read-only rules: paths outside the allowlist are not even readable", async ({ skip }) => {
    const helper = await compileAndProbe();
    if (helper.status === "unavailable") {
      skip(helper.reason);
      return;
    }
    const root = await mkdtemp(path.join(os.tmpdir(), "icarus-landlock-ro-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const stateRoot = path.join(root, "state");
    const secret = path.join(root, "secret");
    await run("mkdir", ["-p", stateRoot, secret]);
    await writeFile(path.join(secret, "value.txt"), "classified");
    const spec = buildLandlockSandboxSpec("read-only", {
      stateRoot,
      executablePath: process.execPath,
    });
    const script = [
      `cat '${secret}/value.txt' > /dev/null 2>&1 || echo unlisted-read-blocked`,
      `cat /etc/hostname > /dev/null && echo allowlist-read-ok`,
      `echo ok > '${stateRoot}/written' && echo state-write-ok`,
      `echo nope > /usr/icarus-denied 2> /dev/null || echo system-write-blocked`,
    ].join("; ");
    const result = await sandboxed(helper, spec, ["/bin/sh", "-c", script]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("unlisted-read-blocked");
    expect(result.stdout).toContain("allowlist-read-ok");
    expect(result.stdout).toContain("state-write-ok");
    expect(result.stdout).toContain("system-write-blocked");
  });

  test("strict rules: meta lifecycle without content writes, WAL store survives", async ({
    skip,
  }) => {
    const helper = await compileAndProbe();
    if (helper.status === "unavailable") {
      skip(helper.reason);
      return;
    }
    const root = await mkdtemp(path.join(os.tmpdir(), "icarus-landlock-strict-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const stateRoot = path.join(root, "state");
    const runId = "123e4567-e89b-12d3-a456-426614174000";
    await run("mkdir", [
      "-p",
      path.join(stateRoot, "runs", runId),
      path.join(stateRoot, "snapshots"),
      path.join(stateRoot, "artifacts"),
      path.join(stateRoot, "controller-home"),
      path.join(stateRoot, "tmp"),
      path.join(stateRoot, "locks"),
    ]);
    const databasePath = path.join(stateRoot, "icarus.sqlite3");
    const betterSqlite = path.resolve("packages/core/node_modules/better-sqlite3");
    const prepare = await run(process.execPath, [
      "-e",
      `const D=require(${JSON.stringify(betterSqlite)});` +
        `const db=new D(${JSON.stringify(databasePath)});` +
        `db.pragma("journal_mode = WAL");db.exec("CREATE TABLE t (x TEXT)");db.close();`,
    ]);
    expect(prepare.code).toBe(0);
    // Clean closes remove WAL sidecars; rules can only reference existing paths.
    await writeFile(`${databasePath}-wal`, "");
    await writeFile(`${databasePath}-shm`, "");
    const spec = buildLandlockSandboxSpec("strict", {
      stateRoot,
      runId,
      executablePath: process.execPath,
      // The sqlite probe loads better-sqlite3 from the repository tree.
      extraReadOnlyPaths: [realpathSync(path.resolve("."))],
    });
    const metaCreate = await sandboxed(helper, spec, [
      process.execPath,
      "--input-type=module",
      "-e",
      `import { closeSync, constants, openSync } from "node:fs";` +
        `closeSync(openSync(${JSON.stringify(path.join(stateRoot, "top-level"))}, constants.O_CREAT | constants.O_RDONLY, 0o600));`,
    ]);
    expect(metaCreate.code).toBe(0);
    const script = [
      `echo x > '${stateRoot}/top-level' 2> /dev/null || echo meta-content-blocked`,
      `rm '${stateRoot}/top-level' 2> /dev/null && echo meta-rm-ok`,
      `echo y > '${stateRoot}/runs/${runId}/scratch.txt' 2> /dev/null && echo run-scratch-rw-ok`,
      `mkdir '${stateRoot}/runs/00000000-0000-1000-8000-000000000000' 2> /dev/null && echo other-run-mkdir-ok`,
      `echo z > '${stateRoot}/runs/00000000-0000-1000-8000-000000000000/evil.txt' 2> /dev/null || echo other-run-content-blocked`,
    ].join("; ");
    const shell = await sandboxed(helper, spec, ["/bin/sh", "-c", script]);
    expect(shell.code).toBe(0);
    expect(shell.stdout).toContain("meta-content-blocked");
    expect(shell.stdout).toContain("meta-rm-ok");
    expect(shell.stdout).toContain("run-scratch-rw-ok");
    expect(shell.stdout).toContain("other-run-mkdir-ok");
    expect(shell.stdout).toContain("other-run-content-blocked");
    // The SQLite WAL lifecycle (create, write, checkpoint, unlink on close)
    // must survive the meta confinement or strict runs cannot persist events.
    await writeFile(`${databasePath}-wal`, "");
    await writeFile(`${databasePath}-shm`, "");
    const sqlite = await sandboxed(helper, spec, [
      process.execPath,
      "-e",
      `const D=require(${JSON.stringify(betterSqlite)});` +
        `const db=new D(${JSON.stringify(databasePath)});` +
        `db.exec("INSERT INTO t VALUES ('sandboxed')");` +
        `console.log("wal-write-ok rows="+db.prepare("SELECT COUNT(*) AS n FROM t").get().n);` +
        `db.close();console.log("wal-close-ok");`,
    ]);
    expect(sqlite.code).toBe(0);
    expect(sqlite.stdout).toContain("wal-write-ok");
    expect(sqlite.stdout).toContain("wal-close-ok");
  });
});

describe("landlock sandbox CLI wiring", () => {
  test("an unknown profile value is rejected before any execution", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "icarus-landlock-cli-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const result = await runCli(root, [
      "run",
      "approve-headless",
      "123e4567-e89b-12d3-a456-426614174000",
      "--plan-sha",
      "f".repeat(64),
      "--actor",
      "operator",
      "--profile-json",
      "{}",
      "--provider-catalog-json",
      "[]",
      "--sandbox-profile",
      "danger-full-access",
    ]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("INVALID_ARGUMENT");
    expect(result.stderr).toContain("--sandbox-profile");
  });

  test(
    "a full headless run settles review-ready under the strict profile",
    async ({ skip }) => {
      const helper = await compileAndProbe();
      if (helper.status === "unavailable") {
        skip(helper.reason);
        return;
      }
      const fixture = await createFixtureRepository();
      cleanups.push(fixture.cleanup);
      const provider = await startOllamaQueue([
        planResponse(),
        editResponse(sha256("Hello, world!\n")),
      ]);
      cleanups.push(() => provider.close());
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
      const approved = await runCli(
        fixture.stateRoot,
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
          "--sandbox-profile",
          "strict",
        ],
        { FORCE_COLOR: undefined, NO_COLOR: "1" },
      );
      expect(approved.exitCode, approved.stderr).toBe(0);
      expect(approved.stderr).toBe("");
      const lines = approved.stdout
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(lines.every((line) => line.schema === HEADLESS_HISTORY_SCHEMA)).toBe(true);
      expect(lines.at(-1)).toMatchObject({ kind: "end", runId: planned.id });
    },
    RUN_TIMEOUT_MS,
  );
});
