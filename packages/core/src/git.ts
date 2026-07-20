import { randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

import { IcarusError, invariant } from "./errors.js";
import { assertRepositoryRelativePath } from "./policy.js";
import { runControllerProcess, type ControllerProcessResult } from "./process.js";

const GIT_OUTPUT_LIMIT = 8 * 1024 * 1024;
const GIT_CONFIG_NAME_OUTPUT_LIMIT = 64 * 1024;

function nullDevice(): string {
  return process.platform === "win32" ? "NUL" : "/dev/null";
}

export interface TreeEntry {
  readonly mode: string;
  readonly type: "blob" | "tree" | "commit";
  readonly objectId: string;
  readonly path: string;
}

export interface RepositoryInspection {
  readonly canonicalPath: string;
  readonly device: number;
  readonly inode: number;
  readonly head: string;
}

export interface RepositoryIdentity {
  readonly canonicalPath: string;
  readonly device: number;
  readonly inode: number;
}

export interface RepositoryStatusInspection extends RepositoryInspection {
  readonly branch: string | null;
  readonly clean: boolean;
  readonly baseCommit: string | null;
}

export interface PrivateWorkspace {
  readonly cachePath: string;
  readonly worktreePath: string;
}

function gitEnvironment(home: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: home,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: nullDevice(),
    GIT_ALLOW_PROTOCOL: "file",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_LAZY_FETCH: "1",
    GIT_PROTOCOL_FROM_USER: "0",
    GIT_ASKPASS: process.platform === "win32" ? process.execPath : "/bin/false",
    GIT_SSH_COMMAND:
      process.platform === "win32" ? `"${process.execPath.replaceAll('"', '\\"')}"` : "false",
    GIT_PAGER: "",
    GIT_OPTIONAL_LOCKS: "0",
  };
}

const UNSAFE_REPOSITORY_CONFIG_PATTERN =
  "^(filter\\..*\\.(clean|smudge|process)|core\\.alternaterefscommand|hook\\..*\\.command)$";

export class GitController {
  readonly #controlHome: string;
  readonly #managedRunsRoot: string;
  readonly #gitExecutable: string;

  constructor(
    controlHome: string,
    managedRunsRoot = path.join(path.dirname(controlHome), "runs"),
    gitExecutable = "git",
  ) {
    this.#controlHome = path.resolve(controlHome);
    this.#managedRunsRoot = path.resolve(managedRunsRoot);
    this.#gitExecutable = gitExecutable;
  }

  async #execute(
    cwd: string,
    args: readonly string[],
    signal: AbortSignal | undefined,
    maxOutputBytes = GIT_OUTPUT_LIMIT,
  ): Promise<ControllerProcessResult> {
    const guardedArgs = [
      "-c",
      "core.fsmonitor=false",
      "-c",
      `core.hooksPath=${nullDevice()}`,
      "-c",
      "hook.post-checkout.enabled=false",
      "-c",
      "credential.helper=",
      "-c",
      "protocol.allow=never",
      "-c",
      "protocol.file.allow=always",
      "-c",
      "protocol.ext.allow=never",
      ...args,
    ];
    try {
      return await runControllerProcess(this.#gitExecutable, guardedArgs, {
        cwd,
        env: gitEnvironment(this.#controlHome),
        timeoutMs: 60_000,
        maxOutputBytes,
        maxRawOutputBytes: maxOutputBytes,
        signal,
      });
    } catch (error) {
      if (error instanceof IcarusError && error.code === "CANCELLED") {
        throw error;
      }
      throw new IcarusError("GIT_FAILED", "Git operation failed", {
        operation: args[0] ?? "unknown",
        reason: "spawn",
      });
    }
  }

  #assertAccepted(
    result: ControllerProcessResult,
    args: readonly string[],
    acceptedExitCodes: readonly number[],
  ): void {
    if (
      result.exitCode === null ||
      !acceptedExitCodes.includes(result.exitCode) ||
      result.cancelled ||
      result.timedOut ||
      result.rawLimitExceeded ||
      result.truncated
    ) {
      const reason = result.cancelled
        ? "cancelled"
        : result.timedOut
          ? "timeout"
          : result.rawLimitExceeded || result.truncated
            ? "output_limit"
            : "exit";
      throw new IcarusError("GIT_FAILED", "Git operation failed", {
        exitCode: result.exitCode,
        signal: result.signal,
        operation: args[0] ?? "unknown",
        reason,
      });
    }
  }

  #output(
    result: ControllerProcessResult,
    args: readonly string[],
    acceptedExitCodes: readonly number[],
  ): string {
    this.#assertAccepted(result, args, acceptedExitCodes);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(result.stdoutBytes);
    } catch {
      throw new IcarusError("GIT_OUTPUT_INVALID", "Git returned non-UTF-8 machine output");
    }
  }

  async #run(cwd: string, args: readonly string[], signal?: AbortSignal): Promise<string> {
    return this.#output(await this.#execute(cwd, args, signal), args, [0]);
  }

  async #runAllowingNoMatch(
    cwd: string,
    args: readonly string[],
    signal?: AbortSignal,
    maxOutputBytes = GIT_OUTPUT_LIMIT,
  ): Promise<0 | 1> {
    const result = await this.#execute(cwd, args, signal, maxOutputBytes);
    this.#assertAccepted(result, args, [0, 1]);
    invariant(result.exitCode === 0 || result.exitCode === 1, "GIT_FAILED", "Git operation failed");
    return result.exitCode;
  }

  async #assertNoUnsafeRepositoryConfiguration(
    repositoryPath: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const exitCode = await this.#runAllowingNoMatch(
      repositoryPath,
      ["config", "--includes", "--name-only", "--get-regexp", UNSAFE_REPOSITORY_CONFIG_PATTERN],
      signal,
      GIT_CONFIG_NAME_OUTPUT_LIMIT,
    );
    if (exitCode === 0) {
      throw new IcarusError(
        "GIT_UNSAFE_CONFIGURATION",
        "Repository Git configuration is not safe to inspect",
      );
    }
  }

  async inspectRepository(
    repositoryPath: string,
    signal?: AbortSignal,
  ): Promise<RepositoryInspection> {
    const inspection = await this.#inspectRepositoryState(repositoryPath, null, null, signal);
    invariant(inspection.clean, "DIRTY_REPOSITORY", "Milestone 1 requires a clean repository");
    return {
      canonicalPath: inspection.canonicalPath,
      device: inspection.device,
      inode: inspection.inode,
      head: inspection.head,
    };
  }

  async inspectRepositoryStatus(
    repositoryPath: string,
    baseRef: string,
    expectedIdentity: RepositoryIdentity,
    signal?: AbortSignal,
  ): Promise<RepositoryStatusInspection> {
    return this.#inspectRepositoryState(repositoryPath, baseRef, expectedIdentity, signal);
  }

  async #repositoryIdentity(repositoryPath: string): Promise<RepositoryIdentity> {
    let canonicalPath: string;
    let repositoryStat: Stats;
    try {
      canonicalPath = await realpath(repositoryPath);
      repositoryStat = await stat(canonicalPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      throw new IcarusError(
        "INVALID_REPOSITORY",
        "Repository path could not be inspected as a local directory",
        { reason: code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unavailable" },
      );
    }
    invariant(
      repositoryStat.isDirectory(),
      "INVALID_REPOSITORY",
      "Repository path is not a directory",
    );

    return {
      canonicalPath,
      device: repositoryStat.dev,
      inode: repositoryStat.ino,
    };
  }

  #assertRepositoryIdentity(actual: RepositoryIdentity, expected: RepositoryIdentity): void {
    invariant(
      actual.canonicalPath === expected.canonicalPath &&
        actual.device === expected.device &&
        actual.inode === expected.inode,
      "REPOSITORY_IDENTITY_CHANGED",
      "Registered repository identity changed",
    );
  }

  async #inspectRepositoryState(
    repositoryPath: string,
    baseRef: string | null,
    expectedIdentity: RepositoryIdentity | null,
    signal?: AbortSignal,
  ): Promise<RepositoryStatusInspection> {
    const before = await this.#repositoryIdentity(repositoryPath);
    if (expectedIdentity !== null) {
      this.#assertRepositoryIdentity(before, expectedIdentity);
    }

    const outcome = await (async (): Promise<RepositoryStatusInspection> => {
      const topLevel = (
        await this.#run(before.canonicalPath, ["rev-parse", "--show-toplevel"], signal)
      ).trim();
      invariant(
        (await realpath(topLevel)) === before.canonicalPath,
        "INVALID_REPOSITORY",
        "Register the repository root, not a nested directory",
      );
      const bare = (
        await this.#run(before.canonicalPath, ["rev-parse", "--is-bare-repository"], signal)
      ).trim();
      invariant(bare === "false", "INVALID_REPOSITORY", "Bare repositories cannot be registered");
      await this.#assertNoUnsafeRepositoryConfiguration(before.canonicalPath, signal);
      const statusOutput = await this.#run(
        before.canonicalPath,
        [
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
          "--ignore-submodules=all",
          "--no-renames",
        ],
        signal,
      );
      const head = (
        await this.#run(before.canonicalPath, ["rev-parse", "HEAD^{commit}"], signal)
      ).trim();
      invariant(
        /^[a-f0-9]{40,64}$/.test(head),
        "INVALID_REPOSITORY",
        "Repository has no valid HEAD commit",
      );
      const branchText = (
        await this.#run(before.canonicalPath, ["rev-parse", "--abbrev-ref", "HEAD"], signal)
      ).trim();
      invariant(
        branchText.length > 0 && Buffer.byteLength(branchText, "utf8") <= 1_024,
        "GIT_OUTPUT_INVALID",
        "Git returned an invalid branch name",
      );

      let baseCommit: string | null = null;
      if (baseRef !== null) {
        invariant(
          baseRef.length > 0 && !baseRef.startsWith("-"),
          "INVALID_REF",
          "Base ref is invalid",
        );
        const existenceExitCode = await this.#runAllowingNoMatch(
          before.canonicalPath,
          ["rev-parse", "--verify", "--quiet", baseRef],
          signal,
        );
        if (existenceExitCode === 0) {
          const resolved = (
            await this.#run(
              before.canonicalPath,
              ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`],
              signal,
            )
          ).trim();
          invariant(
            /^[a-f0-9]{40,64}$/.test(resolved),
            "GIT_OUTPUT_INVALID",
            "Git returned an invalid base commit",
          );
          baseCommit = resolved;
        }
      }

      return {
        canonicalPath: before.canonicalPath,
        device: before.device,
        inode: before.inode,
        head,
        branch: branchText === "HEAD" ? null : branchText,
        clean: statusOutput.length === 0,
        baseCommit,
      };
    })().then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    let after: RepositoryIdentity;
    try {
      after = await this.#repositoryIdentity(repositoryPath);
    } catch {
      throw new IcarusError(
        "REPOSITORY_IDENTITY_CHANGED",
        "Registered repository identity changed during inspection",
      );
    }
    this.#assertRepositoryIdentity(after, expectedIdentity ?? before);
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  async resolveCommit(repositoryPath: string, ref: string, signal?: AbortSignal): Promise<string> {
    invariant(ref.length > 0 && !ref.startsWith("-"), "INVALID_REF", "Base ref is invalid");
    const commit = (
      await this.#run(repositoryPath, ["rev-parse", `${ref}^{commit}`], signal)
    ).trim();
    invariant(
      /^[a-f0-9]{40,64}$/.test(commit),
      "INVALID_REF",
      "Base ref did not resolve to a commit",
    );
    return commit;
  }

  async assertCleanAtCommit(
    repositoryPath: string,
    ref: string,
    expectedCommit: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const inspection = await this.inspectRepository(repositoryPath, signal);
    invariant(
      inspection.head === expectedCommit,
      "STALE_HEAD",
      "Repository HEAD changed after planning",
      {
        expectedCommit,
        currentHead: inspection.head,
      },
    );
    const current = await this.resolveCommit(repositoryPath, ref, signal);
    invariant(current === expectedCommit, "STALE_HEAD", "Repository ref changed after planning", {
      expectedCommit,
      currentCommit: current,
    });
    invariant(
      inspection.canonicalPath === repositoryPath,
      "REPOSITORY_MOVED",
      "Repository canonical path changed",
    );
  }

  async listTree(
    repositoryPath: string,
    commit: string,
    signal?: AbortSignal,
  ): Promise<TreeEntry[]> {
    const output = await this.#run(
      repositoryPath,
      ["ls-tree", "-r", "-z", "--full-tree", commit],
      signal,
    );
    return output
      .split("\0")
      .filter((line) => line.length > 0)
      .map((line) => {
        const tab = line.indexOf("\t");
        invariant(tab > 0, "GIT_OUTPUT_INVALID", "Git tree entry is malformed");
        const metadata = line.slice(0, tab).split(" ");
        invariant(metadata.length === 3, "GIT_OUTPUT_INVALID", "Git tree metadata is malformed");
        const [mode, type, objectId] = metadata;
        invariant(
          mode !== undefined && objectId !== undefined,
          "GIT_OUTPUT_INVALID",
          "Git tree metadata is incomplete",
        );
        invariant(
          type === "blob" || type === "tree" || type === "commit",
          "GIT_OUTPUT_INVALID",
          "Git tree type is unsupported",
        );
        const entryPath = assertRepositoryRelativePath(line.slice(tab + 1));
        return { mode, type, objectId, path: entryPath };
      });
  }

  async readBlob(
    repositoryPath: string,
    objectId: string,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    invariant(/^[a-f0-9]{40,64}$/.test(objectId), "INVALID_OBJECT", "Git object ID is invalid");
    const sizeText = (await this.#run(repositoryPath, ["cat-file", "-s", objectId], signal)).trim();
    const size = Number.parseInt(sizeText, 10);
    invariant(
      Number.isSafeInteger(size) && size >= 0,
      "GIT_OUTPUT_INVALID",
      "Git object size is invalid",
    );
    invariant(size <= maxBytes, "FILE_BUDGET_EXCEEDED", "Git object exceeds the read ceiling");
    const args = ["cat-file", "blob", objectId] as const;
    const result = await this.#execute(repositoryPath, args, signal, maxBytes);
    this.#assertAccepted(result, args, [0]);
    return Buffer.from(result.stdoutBytes);
  }

  async createPrivateWorkspace(
    sourceRepository: string,
    commit: string,
    runRoot: string,
    signal?: AbortSignal,
  ): Promise<PrivateWorkspace> {
    const resolvedRunRoot = path.resolve(runRoot);
    invariant(
      path.dirname(resolvedRunRoot) === this.#managedRunsRoot &&
        /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
          path.basename(resolvedRunRoot),
        ),
      "UNSAFE_RUN_ROOT",
      "Private workspace root is not an Icarus-managed run path",
    );
    await mkdir(this.#managedRunsRoot, { recursive: true, mode: 0o700 });
    const runsRootStat = await lstat(this.#managedRunsRoot);
    invariant(
      runsRootStat.isDirectory() && !runsRootStat.isSymbolicLink(),
      "UNSAFE_RUN_ROOT",
      "Managed runs root is unsafe",
    );
    const cachePath = path.join(resolvedRunRoot, "git-cache.git");
    const worktreePath = path.join(resolvedRunRoot, "worktree");
    let runRootCreated = false;
    try {
      await mkdir(resolvedRunRoot, { recursive: false, mode: 0o700 });
      runRootCreated = true;
    } catch {
      const runRootStat = await lstat(resolvedRunRoot).catch(() => null);
      invariant(
        runRootStat?.isDirectory() === true && !runRootStat.isSymbolicLink(),
        "UNSAFE_RUN_ROOT",
        "Existing private workspace root is unsafe",
      );
      const entries = await readdir(resolvedRunRoot);
      const unexpected = entries.filter(
        (entry) =>
          entry !== "git-cache.git" &&
          entry !== "worktree" &&
          !/^\.git-cache-[a-f0-9-]+\.tmp$/.test(entry),
      );
      invariant(
        unexpected.length === 0,
        "WORKSPACE_RECONCILIATION_REQUIRED",
        "Managed run root contains unexpected files and was preserved",
      );
      if (entries.includes("worktree")) {
        invariant(
          entries.includes("git-cache.git"),
          "WORKSPACE_RECONCILIATION_REQUIRED",
          "Partial worktree has no matching private cache and was preserved",
        );
        const cacheStat = await lstat(cachePath);
        const worktreeStat = await lstat(worktreePath);
        invariant(
          cacheStat.isDirectory() &&
            !cacheStat.isSymbolicLink() &&
            worktreeStat.isDirectory() &&
            !worktreeStat.isSymbolicLink() &&
            (await realpath(cachePath)) === cachePath &&
            (await realpath(worktreePath)) === worktreePath,
          "WORKSPACE_RECONCILIATION_REQUIRED",
          "Private cache or worktree identity is unsafe and was preserved",
        );
        const commonDirectory = (
          await this.#run(
            worktreePath,
            ["rev-parse", "--path-format=absolute", "--git-common-dir"],
            signal,
          )
        ).trim();
        invariant(
          (await realpath(commonDirectory)) === cachePath,
          "WORKSPACE_RECONCILIATION_REQUIRED",
          "Private worktree is not bound to its Icarus cache",
        );
        const bare = (
          await this.#run(
            this.#controlHome,
            ["--git-dir", cachePath, "rev-parse", "--is-bare-repository"],
            signal,
          )
        ).trim();
        const actualHead = (
          await this.#run(worktreePath, ["rev-parse", "HEAD^{commit}"], signal)
        ).trim();
        await this.#assertNoUnsafeRepositoryConfiguration(worktreePath, signal);
        const statusOutput = await this.#run(
          worktreePath,
          ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"],
          signal,
        );
        invariant(
          bare === "true" && actualHead === commit && statusOutput.length === 0,
          "WORKSPACE_RECONCILIATION_REQUIRED",
          "Existing private worktree has unexpected state and was preserved",
        );
        return { cachePath, worktreePath };
      }
    }

    const existingEntries = runRootCreated ? [] : await readdir(resolvedRunRoot);
    if (!existingEntries.includes("git-cache.git")) {
      const stagingCache = path.join(resolvedRunRoot, `.git-cache-${randomUUID()}.tmp`);
      await this.#assertNoUnsafeRepositoryConfiguration(sourceRepository, signal);
      await this.#run(
        this.#controlHome,
        [
          "clone",
          "--bare",
          "--no-local",
          "--no-hardlinks",
          "--no-tags",
          sourceRepository,
          stagingCache,
        ],
        signal,
      );
      await rename(stagingCache, cachePath);
    }
    const cacheStat = await lstat(cachePath);
    invariant(
      cacheStat.isDirectory() &&
        !cacheStat.isSymbolicLink() &&
        (await realpath(cachePath)) === cachePath,
      "WORKSPACE_RECONCILIATION_REQUIRED",
      "Private Git cache identity is unsafe",
    );
    const bare = (
      await this.#run(
        this.#controlHome,
        ["--git-dir", cachePath, "rev-parse", "--is-bare-repository"],
        signal,
      )
    ).trim();
    invariant(
      bare === "true",
      "WORKSPACE_RECONCILIATION_REQUIRED",
      "Private Git cache is incomplete",
    );
    await this.#run(
      this.#controlHome,
      ["--git-dir", cachePath, "config", "core.hooksPath", nullDevice()],
      signal,
    );
    await this.#run(
      this.#controlHome,
      ["--git-dir", cachePath, "config", "core.autocrlf", "false"],
      signal,
    );
    const currentEntries = await readdir(resolvedRunRoot);
    if (!currentEntries.includes("worktree")) {
      await this.#assertNoUnsafeRepositoryConfiguration(cachePath, signal);
      await this.#run(
        this.#controlHome,
        ["--git-dir", cachePath, "worktree", "add", "--detach", worktreePath, commit],
        signal,
      );
    }
    const worktreeStat = await lstat(worktreePath);
    invariant(
      worktreeStat.isDirectory() &&
        !worktreeStat.isSymbolicLink() &&
        (await realpath(worktreePath)) === worktreePath,
      "WORKSPACE_RECONCILIATION_REQUIRED",
      "Private worktree identity is unsafe",
    );
    await this.#run(
      this.#controlHome,
      ["--git-dir", cachePath, "worktree", "lock", "--reason", "Icarus managed run", worktreePath],
      signal,
    );
    const actualHead = (
      await this.#run(worktreePath, ["rev-parse", "HEAD^{commit}"], signal)
    ).trim();
    invariant(actualHead === commit, "WORKTREE_MISMATCH", "Private worktree has the wrong commit");
    await this.#assertNoUnsafeRepositoryConfiguration(worktreePath, signal);
    const statusOutput = await this.#run(
      worktreePath,
      ["status", "--porcelain=v1", "-z", "--no-renames"],
      signal,
    );
    invariant(statusOutput.length === 0, "WORKTREE_MISMATCH", "Private worktree is not clean");
    return { cachePath, worktreePath };
  }

  async readRegularUtf8File(
    worktreePath: string,
    target: string,
    maxBytes: number,
  ): Promise<string> {
    const rootStat = await lstat(worktreePath);
    invariant(
      rootStat.isDirectory() &&
        !rootStat.isSymbolicLink() &&
        (await realpath(worktreePath)) === path.resolve(worktreePath),
      "WORKSPACE_IDENTITY_CHANGED",
      "Private worktree root is unsafe",
    );
    const safeTarget = assertRepositoryRelativePath(target);
    const targetPath = path.join(worktreePath, ...safeTarget.split("/"));
    let current = worktreePath;
    for (const component of safeTarget.split("/")) {
      current = path.join(current, component);
      const componentStat = await lstat(current);
      invariant(
        !componentStat.isSymbolicLink(),
        "SYMLINK_DENIED",
        "Symlink paths are not supported",
      );
    }
    const handle = await open(targetPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    let bytes: Buffer;
    try {
      const openedStat = await handle.stat();
      invariant(openedStat.isFile(), "SPECIAL_FILE_DENIED", "Target is not a regular file");
      invariant(openedStat.nlink === 1, "HARDLINK_DENIED", "Hard-linked targets are not supported");
      invariant(
        (openedStat.mode & 0o111) === 0,
        "MODE_DENIED",
        "Executable targets are not supported",
      );
      invariant(
        openedStat.size <= maxBytes,
        "FILE_BUDGET_EXCEEDED",
        "Target exceeds the byte ceiling",
      );
      invariant(
        (await realpath(targetPath)) === targetPath,
        "SYMLINK_DENIED",
        "Target path changed during validation",
      );
      const currentStat = await lstat(targetPath);
      invariant(
        currentStat.dev === openedStat.dev && currentStat.ino === openedStat.ino,
        "WORKSPACE_IDENTITY_CHANGED",
        "Target identity changed during validation",
      );

      const chunks: Buffer[] = [];
      let total = 0;
      while (total <= maxBytes) {
        const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - total));
        const result = await handle.read(chunk, 0, chunk.length, total);
        if (result.bytesRead === 0) {
          break;
        }
        chunks.push(chunk.subarray(0, result.bytesRead));
        total += result.bytesRead;
      }
      invariant(total <= maxBytes, "FILE_BUDGET_EXCEEDED", "Target exceeds the byte ceiling");
      const finishedStat = await handle.stat();
      invariant(
        finishedStat.dev === openedStat.dev &&
          finishedStat.ino === openedStat.ino &&
          finishedStat.size === openedStat.size &&
          finishedStat.mtimeMs === openedStat.mtimeMs &&
          finishedStat.ctimeMs === openedStat.ctimeMs,
        "WORKSPACE_IDENTITY_CHANGED",
        "Target changed while it was being read",
      );
      bytes = Buffer.concat(chunks, total);
    } finally {
      await handle.close();
    }
    invariant(!bytes.includes(0), "BINARY_DENIED", "Binary targets are not supported");
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new IcarusError("INVALID_UTF8", "Target is not valid UTF-8");
    }
  }

  async atomicWriteUtf8(worktreePath: string, target: string, content: string): Promise<void> {
    const rootStat = await lstat(worktreePath);
    invariant(
      rootStat.isDirectory() &&
        !rootStat.isSymbolicLink() &&
        (await realpath(worktreePath)) === path.resolve(worktreePath),
      "WORKSPACE_IDENTITY_CHANGED",
      "Private worktree root is unsafe",
    );
    const safeTarget = assertRepositoryRelativePath(target);
    const targetPath = path.join(worktreePath, ...safeTarget.split("/"));
    let current = worktreePath;
    for (const component of safeTarget.split("/").slice(0, -1)) {
      current = path.join(current, component);
      const componentStat = await lstat(current);
      invariant(
        componentStat.isDirectory() && !componentStat.isSymbolicLink(),
        "SYMLINK_DENIED",
        "Target parent is unsafe",
      );
    }
    const targetStat = await lstat(targetPath);
    invariant(
      targetStat.isFile() && !targetStat.isSymbolicLink(),
      "SPECIAL_FILE_DENIED",
      "Target is unsafe",
    );
    invariant(targetStat.nlink === 1, "HARDLINK_DENIED", "Hard-linked targets are not supported");

    const privateRunRoot = path.dirname(path.resolve(worktreePath));
    const privateRunRootStat = await lstat(privateRunRoot);
    invariant(
      privateRunRootStat.isDirectory() &&
        !privateRunRootStat.isSymbolicLink() &&
        (await realpath(privateRunRoot)) === privateRunRoot,
      "WORKSPACE_IDENTITY_CHANGED",
      "Private run root is unsafe",
    );
    // Keep the pre-rename file outside the Git worktree. A process death can
    // strand the file, but it cannot create an extra changed path that blocks
    // deterministic resume or rollback.
    const temporaryPath = path.join(privateRunRoot, `.icarus-write-${randomUUID()}.tmp`);
    const handle = await open(
      temporaryPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600,
    );
    let closed = false;
    try {
      await handle.writeFile(content, "utf8");
      await handle.chmod(targetStat.mode & 0o777);
      await handle.sync();
      await handle.close();
      closed = true;
      await rename(temporaryPath, targetPath);
    } finally {
      if (!closed) {
        await handle.close().catch(() => undefined);
      }
      await unlink(temporaryPath).catch(() => undefined);
    }
  }

  async changedPaths(worktreePath: string, signal?: AbortSignal): Promise<string[]> {
    await this.#assertNoUnsafeRepositoryConfiguration(worktreePath, signal);
    const output = await this.#run(
      worktreePath,
      ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"],
      signal,
    );
    const entries = output.split("\0").filter((entry) => entry.length > 0);
    return entries.map((entry) => assertRepositoryRelativePath(entry.slice(3)));
  }

  async diff(
    worktreePath: string,
    target: string,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<string> {
    await this.#assertNoUnsafeRepositoryConfiguration(worktreePath, signal);
    const output = await this.#run(
      worktreePath,
      ["diff", "--binary", "--no-ext-diff", "--no-textconv", "--no-renames", "--", target],
      signal,
    );
    invariant(
      Buffer.byteLength(output, "utf8") <= maxBytes,
      "DIFF_BUDGET_EXCEEDED",
      "Diff exceeds the byte ceiling",
    );
    invariant(output.length > 0, "EMPTY_DIFF", "Git produced an empty diff");
    return output;
  }
}
