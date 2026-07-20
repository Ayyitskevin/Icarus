import { spawn } from "node:child_process";
import { link, lstat, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RunLeaseManager } from "../../packages/core/src/lease.js";
import { UNIT_RUN_ID } from "../support/unit-fixtures.js";

const temporaryRoots: string[] = [];

interface Gate {
  readonly promise: Promise<void>;
  readonly release: () => void;
}

function createGate(): Gate {
  let release = (): void => {
    throw new Error("Gate was released before initialization");
  };
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release: () => release() };
}

async function makeTemporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "icarus-unit-lease-"));
  temporaryRoots.push(root);
  return root;
}

interface LeaseFixtureProcess {
  readonly stop: () => Promise<void>;
}

async function startLeaseFixtureProcess(
  leasePath: string,
  script: string,
  description: string,
): Promise<LeaseFixtureProcess> {
  const child = spawn(process.execPath, ["-e", script, leasePath], {
    shell: false,
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderr = (stderr + (typeof chunk === "string" ? chunk : chunk.toString("utf8"))).slice(-4_096);
  });
  const exit = new Promise<{
    readonly code?: number | null;
    readonly signal?: NodeJS.Signals | null;
    readonly error?: Error;
  }>((resolve) => {
    child.once("error", (error) => resolve({ error }));
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const ready = new Promise<void>((resolve) => {
    child.once("message", () => resolve());
  });
  const outcome = await Promise.race([
    ready.then(() => "ready" as const),
    exit.then(() => "exit" as const),
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 2_000).unref()),
  ]);
  if (outcome !== "ready") {
    child.kill("SIGKILL");
    const result = await exit;
    throw new Error(`${description} did not become ready: ${JSON.stringify(result)} ${stderr}`);
  }
  return {
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await exit;
    },
  };
}

async function startLegacyOwner(leasePath: string): Promise<LeaseFixtureProcess> {
  const script = [
    'const fs = require("node:fs");',
    'const value = fs.readFileSync("/proc/" + process.pid + "/stat", "utf8");',
    'const closingParenthesis = value.lastIndexOf(")");',
    "const processStart = value.slice(closingParenthesis + 2).trim().split(/\\s+/)[19];",
    'fs.writeFileSync(process.argv[1], JSON.stringify({ pid: process.pid, processStart, nonce: "legacy-live" }) + "\\n", { mode: 0o600 });',
    'if (process.send) process.send("ready");',
    "setInterval(() => undefined, 1_000);",
  ].join("\n");
  return startLeaseFixtureProcess(leasePath, script, "Legacy lease owner");
}

async function startPartialLegacyInitializer(leasePath: string): Promise<LeaseFixtureProcess> {
  const script = [
    'const fs = require("node:fs");',
    "const flags = fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL;",
    "const fd = fs.openSync(process.argv[1], flags, 0o600);",
    `fs.writeSync(fd, '{"pid":');`,
    "const aged = new Date(Date.now() - 60_000);",
    "fs.futimesSync(fd, aged, aged);",
    'if (process.send) process.send("ready");',
    "setInterval(() => undefined, 1_000);",
  ].join("\n");
  return startLeaseFixtureProcess(leasePath, script, "Partial legacy initializer");
}

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("run execution leases", () => {
  it("rejects a second live owner until the kernel lease is released", async () => {
    const root = await makeTemporaryRoot();
    const first = new RunLeaseManager(root);
    const second = new RunLeaseManager(root);
    const entered = createGate();
    const release = createGate();
    const firstLease = first.withLease(UNIT_RUN_ID, async () => {
      entered.release();
      await release.promise;
    });

    await entered.promise;
    try {
      await expect(second.withLease(UNIT_RUN_ID, async () => undefined)).rejects.toMatchObject({
        code: "RUN_BUSY",
      });
    } finally {
      release.release();
    }
    await firstLease;
  });

  it("refuses a live legacy owner that does not hold a kernel lock", async () => {
    const root = await makeTemporaryRoot();
    const manager = new RunLeaseManager(root);
    await manager.initialize();
    const leasePath = path.join(root, "locks", `${UNIT_RUN_ID}.lock`);
    const legacyOwner = await startLegacyOwner(leasePath);
    const before = await readFile(leasePath, "utf8");
    let executed = false;

    try {
      await expect(
        manager.withLease(UNIT_RUN_ID, async () => {
          executed = true;
        }),
      ).rejects.toMatchObject({ code: "RUN_BUSY" });
    } finally {
      await legacyOwner.stop();
    }

    expect(executed).toBe(false);
    expect(await readFile(leasePath, "utf8")).toBe(before);
  });

  it("reacquires unlocked version 2 metadata even while its prior PID is live", async () => {
    const root = await makeTemporaryRoot();
    const manager = new RunLeaseManager(root);
    const leasePath = path.join(root, "locks", `${UNIT_RUN_ID}.lock`);
    await manager.withLease(UNIT_RUN_ID, async () => undefined);
    const firstOwner = JSON.parse(await readFile(leasePath, "utf8")) as {
      readonly protocolVersion: number;
      readonly pid: number;
      readonly nonce: string;
    };
    let executed = false;

    await manager.withLease(UNIT_RUN_ID, async () => {
      executed = true;
    });

    const secondOwner = JSON.parse(await readFile(leasePath, "utf8")) as {
      readonly protocolVersion: number;
      readonly pid: number;
      readonly nonce: string;
    };
    expect(executed).toBe(true);
    expect(firstOwner).toMatchObject({ protocolVersion: 2, pid: process.pid });
    expect(secondOwner).toMatchObject({ protocolVersion: 2, pid: process.pid });
    expect(secondOwner.nonce).not.toBe(firstOwner.nonce);
  });

  it("refuses an aged partial lease held open by a paused legacy initializer", async () => {
    const root = await makeTemporaryRoot();
    const manager = new RunLeaseManager(root);
    await manager.initialize();
    const leasePath = path.join(root, "locks", `${UNIT_RUN_ID}.lock`);
    const initializer = await startPartialLegacyInitializer(leasePath);
    const beforeBytes = await readFile(leasePath);
    const beforeStat = await lstat(leasePath);
    let executed = false;

    try {
      await expect(
        manager.withLease(UNIT_RUN_ID, async () => {
          executed = true;
        }),
      ).rejects.toMatchObject({ code: "RUN_BUSY" });

      const afterBytes = await readFile(leasePath);
      const afterStat = await lstat(leasePath);
      expect(executed).toBe(false);
      expect(Date.now() - beforeStat.mtimeMs).toBeGreaterThan(30_000);
      expect(afterBytes).toEqual(beforeBytes);
      expect({
        dev: afterStat.dev,
        ino: afterStat.ino,
        size: afterStat.size,
        mtimeMs: afterStat.mtimeMs,
      }).toEqual({
        dev: beforeStat.dev,
        ino: beforeStat.ino,
        size: beforeStat.size,
        mtimeMs: beforeStat.mtimeMs,
      });
    } finally {
      await initializer.stop();
    }
  });

  it("refuses an unknown lease protocol version without mutation", async () => {
    const root = await makeTemporaryRoot();
    const manager = new RunLeaseManager(root);
    await manager.initialize();
    const leasePath = path.join(root, "locks", `${UNIT_RUN_ID}.lock`);
    const metadata = `${JSON.stringify({
      protocolVersion: 3,
      pid: process.pid,
      processStart: null,
      nonce: "future-owner",
    })}\n`;
    await writeFile(leasePath, metadata, { mode: 0o600 });
    const beforeStat = await lstat(leasePath);
    let executed = false;

    await expect(
      manager.withLease(UNIT_RUN_ID, async () => {
        executed = true;
      }),
    ).rejects.toMatchObject({ code: "RUN_LEASE_UNAVAILABLE" });

    const afterStat = await lstat(leasePath);
    expect(executed).toBe(false);
    expect(await readFile(leasePath, "utf8")).toBe(metadata);
    expect({ dev: afterStat.dev, ino: afterStat.ino }).toEqual({
      dev: beforeStat.dev,
      ino: beforeStat.ino,
    });
  });

  it("recovers an unlocked lease whose metadata was left by a crashed owner", async () => {
    const root = await makeTemporaryRoot();
    const manager = new RunLeaseManager(root);
    await manager.initialize();
    const leasePath = path.join(root, "locks", `${UNIT_RUN_ID}.lock`);
    const staleOwner = {
      pid: 2_147_483_647,
      processStart: "stale-process-start",
      nonce: "stale-owner",
    };
    await writeFile(leasePath, `${JSON.stringify(staleOwner)}\n`, { mode: 0o600 });
    const before = await lstat(leasePath);
    let executed = false;

    await manager.withLease(UNIT_RUN_ID, async () => {
      executed = true;
    });

    const after = await lstat(leasePath);
    const currentOwner = JSON.parse(await readFile(leasePath, "utf8")) as {
      readonly protocolVersion: number;
      readonly pid: number;
      readonly nonce: string;
    };
    expect(executed).toBe(true);
    expect(currentOwner.protocolVersion).toBe(2);
    expect({ dev: after.dev, ino: after.ino }).toEqual({ dev: before.dev, ino: before.ino });
    expect(currentOwner.pid).toBe(process.pid);
    expect(currentOwner.nonce).not.toBe(staleOwner.nonce);
  });

  it("migrates a legacy owner whose live PID has a different process start", async () => {
    const root = await makeTemporaryRoot();
    const manager = new RunLeaseManager(root);
    await manager.initialize();
    const leasePath = path.join(root, "locks", `${UNIT_RUN_ID}.lock`);
    const staleOwner = {
      pid: process.pid,
      processStart: "not-the-current-process-start",
      nonce: "reused-pid-owner",
    };
    await writeFile(leasePath, `${JSON.stringify(staleOwner)}\n`, { mode: 0o600 });
    const before = await lstat(leasePath);
    let executed = false;

    await manager.withLease(UNIT_RUN_ID, async () => {
      executed = true;
    });

    const after = await lstat(leasePath);
    const currentOwner = JSON.parse(await readFile(leasePath, "utf8")) as {
      readonly protocolVersion: number;
      readonly pid: number;
      readonly nonce: string;
    };
    expect(executed).toBe(true);
    expect(currentOwner).toMatchObject({
      protocolVersion: 2,
      pid: process.pid,
    });
    expect(currentOwner.nonce).not.toBe(staleOwner.nonce);
    expect({ dev: after.dev, ino: after.ino }).toEqual({
      dev: before.dev,
      ino: before.ino,
    });
  });

  it("allows exactly one concurrent stale-owner recovery", async () => {
    const root = await makeTemporaryRoot();
    const first = new RunLeaseManager(root);
    const second = new RunLeaseManager(root);
    await first.initialize();
    const leasePath = path.join(root, "locks", `${UNIT_RUN_ID}.lock`);
    await writeFile(
      leasePath,
      `${JSON.stringify({ pid: 2_147_483_647, processStart: "stale", nonce: "stale" })}\n`,
      { mode: 0o600 },
    );
    const winnerEntered = createGate();
    const releaseWinner = createGate();
    let winner = -1;
    const contend = async (
      manager: RunLeaseManager,
      index: number,
    ): Promise<{ readonly error: unknown }> => {
      try {
        await manager.withLease(UNIT_RUN_ID, async () => {
          winner = index;
          winnerEntered.release();
          await releaseWinner.promise;
        });
        return { error: null };
      } catch (error) {
        return { error };
      }
    };
    const firstResult = contend(first, 0);
    const secondResult = contend(second, 1);

    await winnerEntered.promise;
    const loser = winner === 0 ? secondResult : firstResult;
    const acquired = winner === 0 ? firstResult : secondResult;
    try {
      expect((await loser).error).toMatchObject({ code: "RUN_BUSY" });
    } finally {
      releaseWinner.release();
    }
    expect((await acquired).error).toBeNull();
  });

  it("rejects a symlink lease without touching its target", async () => {
    const root = await makeTemporaryRoot();
    const manager = new RunLeaseManager(root);
    await manager.initialize();
    const leasePath = path.join(root, "locks", `${UNIT_RUN_ID}.lock`);
    const targetPath = path.join(root, "symlink-target");
    await writeFile(targetPath, "sentinel", { mode: 0o600 });
    await symlink(targetPath, leasePath);
    let executed = false;

    await expect(
      manager.withLease(UNIT_RUN_ID, async () => {
        executed = true;
      }),
    ).rejects.toMatchObject({ code: "UNSAFE_RUN_LEASE" });

    expect(executed).toBe(false);
    expect(await readFile(targetPath, "utf8")).toBe("sentinel");
  });

  it("rejects a hard-linked lease inode", async () => {
    const root = await makeTemporaryRoot();
    const manager = new RunLeaseManager(root);
    await manager.initialize();
    const leasePath = path.join(root, "locks", `${UNIT_RUN_ID}.lock`);
    const backingPath = path.join(root, "hardlink-backing");
    await writeFile(backingPath, "sentinel", { mode: 0o600 });
    await link(backingPath, leasePath);
    let executed = false;

    await expect(
      manager.withLease(UNIT_RUN_ID, async () => {
        executed = true;
      }),
    ).rejects.toMatchObject({ code: "UNSAFE_RUN_LEASE" });

    expect(executed).toBe(false);
    expect((await lstat(backingPath)).nlink).toBe(2);
    expect(await readFile(backingPath, "utf8")).toBe("sentinel");
  });

  it("rejects oversized lease metadata before reading it", async () => {
    const root = await makeTemporaryRoot();
    const manager = new RunLeaseManager(root);
    await manager.initialize();
    const leasePath = path.join(root, "locks", `${UNIT_RUN_ID}.lock`);
    await writeFile(leasePath, "x".repeat(4_097), { mode: 0o600 });
    let executed = false;

    await expect(
      manager.withLease(UNIT_RUN_ID, async () => {
        executed = true;
      }),
    ).rejects.toMatchObject({ code: "UNSAFE_RUN_LEASE" });

    expect(executed).toBe(false);
    expect((await lstat(leasePath)).size).toBe(4_097);
  });

  it("never removes a replacement lease when the pathname is swapped during ownership", async () => {
    const root = await makeTemporaryRoot();
    const first = new RunLeaseManager(root);
    const replacement = new RunLeaseManager(root);
    const leasePath = path.join(root, "locks", `${UNIT_RUN_ID}.lock`);
    const displacedPath = `${leasePath}.displaced`;
    const replacementEntered = createGate();
    const releaseReplacement = createGate();
    let replacementLease: Promise<void> | undefined;

    await expect(
      first.withLease(UNIT_RUN_ID, async () => {
        await rename(leasePath, displacedPath);
        replacementLease = replacement.withLease(UNIT_RUN_ID, async () => {
          replacementEntered.release();
          await releaseReplacement.promise;
        });
        await replacementEntered.promise;
      }),
    ).rejects.toMatchObject({ code: "RUN_LEASE_LOST" });

    if (replacementLease === undefined) {
      throw new Error("Replacement lease did not start");
    }
    const activeReplacement = replacementLease;
    let liveReplacement = "";
    try {
      liveReplacement = await readFile(leasePath, "utf8");
      expect(JSON.parse(liveReplacement)).toMatchObject({ pid: process.pid });
    } finally {
      releaseReplacement.release();
      await activeReplacement;
    }
    expect(await readFile(leasePath, "utf8")).toBe(liveReplacement);
  });
});
