import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { lstat, mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";

import { IcarusError, invariant } from "./errors.js";

const RUN_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const FLOCK_EXECUTABLE = "/usr/bin/flock";
const FLOCK_CONFLICT_EXIT_CODE = 73;
const FLOCK_CHILD_FD = 3;
const MAX_LEASE_BYTES = 4_096;
const LEASE_PROTOCOL_VERSION = 2;

interface LeaseOwner {
  readonly protocolVersion: typeof LEASE_PROTOCOL_VERSION;
  readonly pid: number;
  readonly processStart: string | null;
  readonly nonce: string;
}

interface LegacyLeaseOwner {
  readonly pid: number;
  readonly processStart: string | null;
  readonly nonce: string;
}

type LeaseMetadata =
  | { readonly kind: "current"; readonly owner: LeaseOwner }
  | { readonly kind: "legacy"; readonly owner: LegacyLeaseOwner }
  | { readonly kind: "malformed" }
  | { readonly kind: "unsupported"; readonly protocolVersion: unknown };

interface LeaseSnapshot {
  readonly metadata: LeaseMetadata;
}

interface HeldLease {
  readonly handle: FileHandle;
  readonly owner: LeaseOwner;
}

type ProcessIdentity =
  | { readonly kind: "present"; readonly processStart: string }
  | { readonly kind: "missing" }
  | { readonly kind: "indeterminate" };

async function processIdentity(pid: number): Promise<ProcessIdentity> {
  try {
    const value = await readFile(`/proc/${pid}/stat`, "utf8");
    const closingParenthesis = value.lastIndexOf(")");
    if (closingParenthesis < 0) {
      return { kind: "indeterminate" };
    }
    const fields = value
      .slice(closingParenthesis + 2)
      .trim()
      .split(/\s+/);
    const processStart = fields[19];
    return processStart === undefined
      ? { kind: "indeterminate" }
      : { kind: "present", processStart };
  } catch (error) {
    return isSystemError(error, "ENOENT") || isSystemError(error, "ESRCH")
      ? { kind: "missing" }
      : { kind: "indeterminate" };
  }
}

async function processStart(pid: number): Promise<string | null> {
  const identity = await processIdentity(pid);
  return identity.kind === "present" ? identity.processStart : null;
}

function parseMetadata(value: string): LeaseMetadata {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { kind: "malformed" };
    }
    const object = parsed as Record<string, unknown>;
    if ("protocolVersion" in object && object.protocolVersion !== LEASE_PROTOCOL_VERSION) {
      return { kind: "unsupported", protocolVersion: object.protocolVersion };
    }
    if (
      Number.isSafeInteger(object.pid) &&
      (object.pid as number) > 0 &&
      typeof object.nonce === "string" &&
      object.nonce.length > 0 &&
      (object.processStart === null || typeof object.processStart === "string")
    ) {
      const owner = {
        pid: object.pid as number,
        processStart: object.processStart as string | null,
        nonce: object.nonce,
      };
      return object.protocolVersion === LEASE_PROTOCOL_VERSION
        ? {
            kind: "current",
            owner: { protocolVersion: LEASE_PROTOCOL_VERSION, ...owner },
          }
        : { kind: "legacy", owner };
    }
  } catch {
    // Malformed metadata may belong to a paused legacy initializer, so it fails closed.
  }
  return { kind: "malformed" };
}

function isSystemError(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

async function assertLeaseIdentity(
  handle: FileHandle,
  leasePath: string,
  code: string,
  message: string,
): Promise<void> {
  const handleStat = await handle.stat();
  const entryStat = await lstat(leasePath).catch((error: unknown) => {
    if (isSystemError(error, "ENOENT")) {
      return null;
    }
    throw error;
  });
  invariant(
    handleStat.isFile() &&
      handleStat.nlink === 1 &&
      handleStat.size <= MAX_LEASE_BYTES &&
      entryStat?.isFile() &&
      !entryStat.isSymbolicLink() &&
      entryStat.nlink === 1 &&
      entryStat.size <= MAX_LEASE_BYTES &&
      entryStat.dev === handleStat.dev &&
      entryStat.ino === handleStat.ino,
    code,
    message,
  );
}

async function readLeaseSnapshot(
  handle: FileHandle,
  code: string,
  message: string,
): Promise<LeaseSnapshot> {
  const before = await handle.stat();
  invariant(before.isFile() && before.nlink === 1 && before.size <= MAX_LEASE_BYTES, code, message);
  const bytes = Buffer.alloc(before.size);
  const result = await handle.read(bytes, 0, bytes.length, 0);
  const after = await handle.stat();
  invariant(
    result.bytesRead === bytes.length &&
      after.dev === before.dev &&
      after.ino === before.ino &&
      after.nlink === 1 &&
      after.size === before.size &&
      after.mtimeMs === before.mtimeMs &&
      after.ctimeMs === before.ctimeMs,
    code,
    message,
  );
  return { metadata: parseMetadata(bytes.toString("utf8")) };
}

async function acquireKernelLock(handle: FileHandle): Promise<boolean> {
  // flock(2) ownership follows the shared open-file description. The child receives a
  // duplicate as fd 3; after it locks and exits, the parent handle keeps that same lock
  // until close. No pathname removal is needed for crash recovery or stale takeover.
  const child = spawn(
    FLOCK_EXECUTABLE,
    [
      "--exclusive",
      "--nonblock",
      "--conflict-exit-code",
      String(FLOCK_CONFLICT_EXIT_CODE),
      String(FLOCK_CHILD_FD),
    ],
    {
      env: { LC_ALL: "C" },
      shell: false,
      stdio: ["ignore", "ignore", "pipe", handle.fd],
    },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderr = `${stderr}${typeof chunk === "string" ? chunk : chunk.toString("utf8")}`.slice(
      -MAX_LEASE_BYTES,
    );
  });
  const result = await new Promise<{
    readonly exitCode: number | null;
    readonly signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", (error) => {
      reject(
        new IcarusError("RUN_LEASE_UNAVAILABLE", "Linux run leases are unavailable", {
          error: error.message,
        }),
      );
    });
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
  });
  if (result.exitCode === 0) {
    return true;
  }
  if (result.exitCode === FLOCK_CONFLICT_EXIT_CODE) {
    return false;
  }
  throw new IcarusError("RUN_LEASE_UNAVAILABLE", "Linux flock failed", {
    exitCode: result.exitCode,
    signal: result.signal,
    stderr,
  });
}

interface OpenedLease {
  readonly handle: FileHandle;
  readonly created: boolean;
}

function unsafeLeaseError(): IcarusError {
  return new IcarusError("UNSAFE_RUN_LEASE", "Existing run lease is unsafe");
}

async function openLeaseFile(leasePath: string): Promise<OpenedLease> {
  const commonFlags = fsConstants.O_RDWR | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return { handle: await open(leasePath, commonFlags), created: false };
    } catch (error) {
      if (isSystemError(error, "ELOOP") || isSystemError(error, "EISDIR")) {
        throw unsafeLeaseError();
      }
      if (!isSystemError(error, "ENOENT")) {
        throw error;
      }
    }
    try {
      return {
        handle: await open(
          leasePath,
          commonFlags | fsConstants.O_CREAT | fsConstants.O_EXCL,
          0o600,
        ),
        created: true,
      };
    } catch (error) {
      if (isSystemError(error, "ELOOP") || isSystemError(error, "EISDIR")) {
        throw unsafeLeaseError();
      }
      if (!isSystemError(error, "EEXIST")) {
        throw error;
      }
    }
  }
  throw new IcarusError("RUN_BUSY", "Run lease path changed during acquisition");
}

async function legacyOwnerIsActive(owner: LegacyLeaseOwner): Promise<boolean> {
  const identity = await processIdentity(owner.pid);
  if (identity.kind === "missing") {
    return false;
  }
  if (identity.kind === "indeterminate" || owner.processStart === null) {
    return true;
  }
  return identity.processStart === owner.processStart;
}

async function reconcileExistingLease(handle: FileHandle): Promise<void> {
  const snapshot = await readLeaseSnapshot(
    handle,
    "RUN_BUSY",
    "Run lease metadata changed during acquisition",
  );
  if (snapshot.metadata.kind === "current") {
    return;
  }
  if (snapshot.metadata.kind === "unsupported") {
    throw new IcarusError(
      "RUN_LEASE_UNAVAILABLE",
      "Run lease uses an unsupported ownership protocol",
    );
  }
  if (snapshot.metadata.kind === "legacy") {
    if (await legacyOwnerIsActive(snapshot.metadata.owner)) {
      throw new IcarusError("RUN_BUSY", "A live legacy process holds the run execution lease");
    }
    return;
  }
  throw new IcarusError(
    "RUN_BUSY",
    "Run lease metadata is incomplete or malformed; operator recovery is required",
  );
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
    const lease = await this.#acquire(runId);
    try {
      return await action();
    } finally {
      await this.#release(runId, lease);
    }
  }

  async #acquire(runId: string): Promise<HeldLease> {
    invariant(RUN_ID_PATTERN.test(runId), "INVALID_RUN_ID", "Run ID is invalid");
    await this.initialize();
    const leasePath = path.join(this.#root, `${runId}.lock`);
    const owner: LeaseOwner = {
      protocolVersion: LEASE_PROTOCOL_VERSION,
      pid: process.pid,
      processStart: await processStart(process.pid),
      nonce: randomUUID(),
    };
    const opened = await openLeaseFile(leasePath);
    const { handle } = opened;
    try {
      await assertLeaseIdentity(
        handle,
        leasePath,
        "UNSAFE_RUN_LEASE",
        "Existing run lease is unsafe",
      );
      const acquired = await acquireKernelLock(handle);
      if (!acquired) {
        throw new IcarusError("RUN_BUSY", "Another live process holds this run's execution lease");
      }
      await assertLeaseIdentity(
        handle,
        leasePath,
        "RUN_BUSY",
        "Run lease changed during acquisition",
      );
      if (!opened.created) {
        await reconcileExistingLease(handle);
        await assertLeaseIdentity(
          handle,
          leasePath,
          "RUN_BUSY",
          "Run lease changed during legacy-owner reconciliation",
        );
      }
      await handle.truncate(0);
      await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
      await handle.sync();
      await assertLeaseIdentity(
        handle,
        leasePath,
        "RUN_BUSY",
        "Run lease changed during acquisition",
      );
      return { handle, owner };
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  async #release(runId: string, lease: HeldLease): Promise<void> {
    const leasePath = path.join(this.#root, `${runId}.lock`);
    try {
      await assertLeaseIdentity(
        lease.handle,
        leasePath,
        "RUN_LEASE_LOST",
        "Run execution lease identity changed",
      );
      const snapshot = await readLeaseSnapshot(
        lease.handle,
        "RUN_LEASE_LOST",
        "Run execution lease metadata changed while reading",
      );
      invariant(
        snapshot.metadata.kind === "current" &&
          snapshot.metadata.owner.protocolVersion === LEASE_PROTOCOL_VERSION &&
          snapshot.metadata.owner.nonce === lease.owner.nonce,
        "RUN_LEASE_LOST",
        "Run execution lease owner changed",
      );
    } finally {
      // Closing the held descriptor is the only unlock operation. In particular, never
      // unlink a pathname that another owner may have replaced while this lease was held.
      await lease.handle.close();
    }
  }
}
