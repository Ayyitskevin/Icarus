import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

import { IcarusError, invariant } from "./errors.js";
import { assertRepositoryRelativePath } from "./policy.js";
import { runControllerProcess } from "./process.js";

const GIT_OUTPUT_LIMIT = 8 * 1024 * 1024;

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

export interface PrivateWorkspace {
  readonly cachePath: string;
  readonly worktreePath: string;
}

function gitEnvironment(home: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: home,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/bin/false",
    GIT_SSH_COMMAND: "false",
    GIT_PAGER: "cat",
    GIT_OPTIONAL_LOCKS: "0",
  };
}

export class GitController {
  readonly #controlHome: string;
  readonly #managedRunsRoot: string;

  constructor(controlHome: string, managedRunsRoot = path.join(path.dirname(controlHome), "runs")) {
    this.#controlHome = path.resolve(controlHome);
    this.#managedRunsRoot = path.resolve(managedRunsRoot);
  }

  async #run(cwd: string, args: readonly string[], signal?: AbortSignal): Promise<string> {
    const guardedArgs = [
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "credential.helper=",
      "-c",
      "protocol.ext.allow=never",
      ...args,
    ];
    const result = await runControllerProcess("git", guardedArgs, {
      cwd,
      env: gitEnvironment(this.#controlHome),
      timeoutMs: 60_000,
      maxOutputBytes: GIT_OUTPUT_LIMIT,
      maxRawOutputBytes: GIT_OUTPUT_LIMIT,
      signal,
    });
    if (result.exitCode !== 0 || result.rawLimitExceeded || result.truncated) {
      throw new IcarusError("GIT_FAILED", `Git command failed: ${result.stderr || result.stdout}`, {
        exitCode: result.exitCode,
        signal: result.signal,
        operation: args[0] ?? "unknown",
      });
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(result.stdoutBytes);
    } catch {
      throw new IcarusError("GIT_OUTPUT_INVALID", "Git returned non-UTF-8 machine output");
    }
  }

  async inspectRepository(
    repositoryPath: string,
    signal?: AbortSignal,
  ): Promise<RepositoryInspection> {
    const canonicalPath = await realpath(repositoryPath);
    const repositoryStat = await stat(canonicalPath);
    invariant(
      repositoryStat.isDirectory(),
      "INVALID_REPOSITORY",
      "Repository path is not a directory",
    );

    const topLevel = (
      await this.#run(canonicalPath, ["rev-parse", "--show-toplevel"], signal)
    ).trim();
    invariant(
      (await realpath(topLevel)) === canonicalPath,
      "INVALID_REPOSITORY",
      "Register the repository root, not a nested directory",
    );
    const bare = (
      await this.#run(canonicalPath, ["rev-parse", "--is-bare-repository"], signal)
    ).trim();
    invariant(bare === "false", "INVALID_REPOSITORY", "Bare repositories cannot be registered");
    const statusOutput = await this.#run(
      canonicalPath,
      ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=all"],
      signal,
    );
    invariant(
      statusOutput.length === 0,
      "DIRTY_REPOSITORY",
      "Milestone 1 requires a clean repository",
    );
    const head = (await this.#run(canonicalPath, ["rev-parse", "HEAD^{commit}"], signal)).trim();
    invariant(
      /^[a-f0-9]{40,64}$/.test(head),
      "INVALID_REPOSITORY",
      "Repository has no valid HEAD commit",
    );

    return {
      canonicalPath,
      device: repositoryStat.dev,
      inode: repositoryStat.ino,
      head,
    };
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
    const result = await runControllerProcess("git", ["cat-file", "blob", objectId], {
      cwd: repositoryPath,
      env: gitEnvironment(this.#controlHome),
      timeoutMs: 60_000,
      maxOutputBytes: maxBytes,
      maxRawOutputBytes: maxBytes,
      signal,
    });
    if (result.exitCode !== 0 || result.truncated || result.rawLimitExceeded) {
      throw new IcarusError("GIT_FAILED", "Unable to read bounded Git object");
    }
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
        const statusOutput = await this.#run(
          worktreePath,
          ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
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
      ["--git-dir", cachePath, "config", "core.hooksPath", "/dev/null"],
      signal,
    );
    await this.#run(
      this.#controlHome,
      ["--git-dir", cachePath, "config", "core.autocrlf", "false"],
      signal,
    );
    const currentEntries = await readdir(resolvedRunRoot);
    if (!currentEntries.includes("worktree")) {
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
    const statusOutput = await this.#run(worktreePath, ["status", "--porcelain=v1", "-z"], signal);
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
    const parentPath = path.dirname(targetPath);
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

    const temporaryPath = path.join(parentPath, `.icarus-${randomUUID()}.tmp`);
    const handle = await open(
      temporaryPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600,
    );
    try {
      await handle.writeFile(content, "utf8");
      await handle.chmod(targetStat.mode & 0o777);
      await handle.sync();
    } catch (error) {
      await handle.close();
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
    await handle.close();
    await rename(temporaryPath, targetPath);
  }

  async changedPaths(worktreePath: string, signal?: AbortSignal): Promise<string[]> {
    const output = await this.#run(
      worktreePath,
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
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
    const output = await this.#run(
      worktreePath,
      ["diff", "--binary", "--no-ext-diff", "--no-textconv", "--", target],
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
