import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import path from "node:path";

import { IcarusError, invariant } from "./errors.js";

const RUN_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

interface LeaseOwner {
  readonly pid: number;
  readonly processStart: string | null;
  readonly nonce: string;
}

async function processStart(pid: number): Promise<string | null> {
  try {
    const value = await readFile(`/proc/${pid}/stat`, "utf8");
    const closingParenthesis = value.lastIndexOf(")");
    if (closingParenthesis < 0) {
      return null;
    }
    const fields = value
      .slice(closingParenthesis + 2)
      .trim()
      .split(/\s+/);
    return fields[19] ?? null;
  } catch {
    return null;
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "EPERM"
    );
  }
}

function parseOwner(value: string): LeaseOwner | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      Number.isSafeInteger((parsed as Record<string, unknown>).pid) &&
      typeof (parsed as Record<string, unknown>).nonce === "string" &&
      ((parsed as Record<string, unknown>).processStart === null ||
        typeof (parsed as Record<string, unknown>).processStart === "string")
    ) {
      return parsed as LeaseOwner;
    }
  } catch {
    // A partially written lease is treated as busy until its grace window elapses.
  }
  return null;
}

export class RunLeaseManager {
  readonly #root: string;

  constructor(stateRoot: string) {
    this.#root = path.join(path.resolve(stateRoot), "locks");
  }

  async initialize(): Promise<void> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const rootStat = await lstat(this.#root);
    invariant(
      rootStat.isDirectory() && !rootStat.isSymbolicLink(),
      "UNSAFE_LEASE_ROOT",
      "Run lease root is unsafe",
    );
  }

  async withLease<T>(runId: string, action: () => Promise<T>): Promise<T> {
    const owner = await this.#acquire(runId);
    try {
      return await action();
    } finally {
      await this.#release(runId, owner);
    }
  }

  async #acquire(runId: string): Promise<LeaseOwner> {
    invariant(RUN_ID_PATTERN.test(runId), "INVALID_RUN_ID", "Run ID is invalid");
    await this.initialize();
    const leasePath = path.join(this.#root, `${runId}.lock`);
    const owner: LeaseOwner = {
      pid: process.pid,
      processStart: await processStart(process.pid),
      nonce: randomUUID(),
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(
          leasePath,
          fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
          0o600,
        );
        try {
          await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        return owner;
      } catch (error) {
        if (
          typeof error !== "object" ||
          error === null ||
          !("code" in error) ||
          (error as { code?: unknown }).code !== "EEXIST"
        ) {
          throw error;
        }
        const leaseStat = await lstat(leasePath);
        invariant(
          leaseStat.isFile() &&
            !leaseStat.isSymbolicLink() &&
            leaseStat.nlink === 1 &&
            leaseStat.size <= 4_096,
          "UNSAFE_RUN_LEASE",
          "Existing run lease is unsafe",
        );
        const existing = parseOwner(await readFile(leasePath, "utf8"));
        let active = Date.now() - leaseStat.mtimeMs < 5_000;
        if (existing !== null && processExists(existing.pid)) {
          const currentStart = await processStart(existing.pid);
          active =
            existing.processStart === null ||
            currentStart === null ||
            existing.processStart === currentStart;
        } else if (existing !== null) {
          active = false;
        }
        if (active) {
          throw new IcarusError(
            "RUN_BUSY",
            "Another live process holds this run's execution lease",
          );
        }
        const currentStat = await stat(leasePath);
        invariant(
          currentStat.dev === leaseStat.dev && currentStat.ino === leaseStat.ino,
          "RUN_BUSY",
          "Run lease changed during stale-owner reconciliation",
        );
        await unlink(leasePath);
      }
    }
    throw new IcarusError("RUN_BUSY", "Unable to acquire the run execution lease");
  }

  async #release(runId: string, owner: LeaseOwner): Promise<void> {
    const leasePath = path.join(this.#root, `${runId}.lock`);
    const entryStat = await lstat(leasePath).catch(() => null);
    if (entryStat === null) {
      throw new IcarusError("RUN_LEASE_LOST", "Run execution lease disappeared");
    }
    invariant(
      entryStat.isFile() && !entryStat.isSymbolicLink() && entryStat.nlink === 1,
      "RUN_LEASE_LOST",
      "Run execution lease identity changed",
    );
    const current = parseOwner(await readFile(leasePath, "utf8"));
    invariant(
      current?.nonce === owner.nonce,
      "RUN_LEASE_LOST",
      "Run execution lease owner changed",
    );
    await unlink(leasePath);
  }
}
