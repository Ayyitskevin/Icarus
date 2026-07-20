import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { IcarusError } from "../../packages/core/src/errors.js";
import { GitController } from "../../packages/core/src/git.js";
import { createFixtureRepository, git, repositoryFingerprint } from "../support/integration-cli.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function capturedError(action: Promise<unknown>): Promise<IcarusError> {
  try {
    await action;
    throw new Error("Expected IcarusError");
  } catch (error) {
    expect(error).toBeInstanceOf(IcarusError);
    return error as IcarusError;
  }
}

describe("Git controller transport hardening", () => {
  test("keeps local file cloning compatible and blocks source alternate-ref commands", async () => {
    const fixture = await createFixtureRepository();
    cleanups.push(fixture.cleanup);
    await writeFile(
      path.join(fixture.repository, ".gitattributes"),
      "src/greeting.txt filter=cache-sentinel\n",
    );
    await git(fixture.repository, ["add", ".gitattributes"]);
    await git(fixture.repository, ["commit", "-m", "declare cache smudge test filter"]);
    const controllerHome = path.join(fixture.root, "controller-home");
    const runsRoot = path.join(fixture.root, "runs");
    await mkdir(controllerHome, { recursive: true, mode: 0o700 });
    await mkdir(runsRoot, { recursive: true, mode: 0o700 });
    const controller = new GitController(controllerHome, runsRoot);
    const inspection = await controller.inspectRepository(fixture.repository);
    const sourceBefore = await repositoryFingerprint(fixture.repository);

    const safeRunRoot = path.join(runsRoot, randomUUID());
    const workspace = await controller.createPrivateWorkspace(
      fixture.repository,
      inspection.head,
      safeRunRoot,
    );
    expect(await readFile(path.join(workspace.worktreePath, "src/greeting.txt"), "utf8")).toBe(
      "Hello, world!\n",
    );
    expect(
      await git(workspace.worktreePath, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--no-renames",
      ]),
    ).toBe("");
    expect(await repositoryFingerprint(fixture.repository)).toEqual(sourceBefore);

    const cacheMarker = path.join(fixture.root, "cache-smudge-invoked");
    const tamperedRunRoot = path.join(runsRoot, randomUUID());
    const tamperedCache = path.join(tamperedRunRoot, "git-cache.git");
    await mkdir(tamperedRunRoot, { mode: 0o700 });
    await git(fixture.root, [
      "clone",
      "--bare",
      "--no-local",
      "--no-hardlinks",
      fixture.repository,
      tamperedCache,
    ]);
    const smudgeKey = "filter.cache-sentinel.smudge";
    await git(fixture.root, [
      "--git-dir",
      tamperedCache,
      "config",
      smudgeKey,
      `sh -c 'printf invoked > "${cacheMarker}"; cat'`,
    ]);
    const smudgeDenied = await capturedError(
      controller.createPrivateWorkspace(fixture.repository, inspection.head, tamperedRunRoot),
    );
    expect(smudgeDenied).toMatchObject({
      code: "GIT_UNSAFE_CONFIGURATION",
      message: "Repository Git configuration is not safe to inspect",
      details: {},
    });
    expect(JSON.stringify(smudgeDenied)).not.toContain(smudgeKey);
    expect(JSON.stringify(smudgeDenied)).not.toContain(cacheMarker);
    await expect(access(cacheMarker)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(path.join(tamperedRunRoot, "worktree"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    const hookMarker = path.join(fixture.root, "config-hook-invoked");
    const hookRunRoot = path.join(runsRoot, randomUUID());
    const hookCache = path.join(hookRunRoot, "git-cache.git");
    await mkdir(hookRunRoot, { mode: 0o700 });
    await git(fixture.root, [
      "clone",
      "--bare",
      "--no-local",
      "--no-hardlinks",
      fixture.repository,
      hookCache,
    ]);
    const hookCommandKey = "hook.icarus-sentinel.command";
    await git(fixture.root, [
      "--git-dir",
      hookCache,
      "config",
      hookCommandKey,
      `sh -c 'printf invoked > "${hookMarker}"'`,
    ]);
    await git(fixture.root, [
      "--git-dir",
      hookCache,
      "config",
      "hook.icarus-sentinel.event",
      "post-checkout",
    ]);
    const hookDenied = await capturedError(
      controller.createPrivateWorkspace(fixture.repository, inspection.head, hookRunRoot),
    );
    expect(hookDenied).toMatchObject({
      code: "GIT_UNSAFE_CONFIGURATION",
      message: "Repository Git configuration is not safe to inspect",
      details: {},
    });
    expect(JSON.stringify(hookDenied)).not.toContain(hookCommandKey);
    expect(JSON.stringify(hookDenied)).not.toContain(hookMarker);
    await expect(access(hookMarker)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(path.join(hookRunRoot, "worktree"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    const marker = path.join(fixture.root, "alternate-refs-command-invoked");
    const unsafeKey = "core.alternateRefsCommand";
    await git(fixture.repository, ["config", unsafeKey, `sh -c 'printf invoked > "${marker}"'`]);
    const sourceBytes = await readFile(path.join(fixture.repository, "src/greeting.txt"));
    const sourceHead = (await git(fixture.repository, ["rev-parse", "HEAD"])).trim();
    const deniedRunRoot = path.join(runsRoot, randomUUID());
    const denied = await capturedError(
      controller.createPrivateWorkspace(fixture.repository, inspection.head, deniedRunRoot),
    );
    expect(denied).toMatchObject({
      code: "GIT_UNSAFE_CONFIGURATION",
      message: "Repository Git configuration is not safe to inspect",
      details: {},
    });
    expect(JSON.stringify(denied)).not.toContain(unsafeKey);
    expect(JSON.stringify(denied)).not.toContain(marker);
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(deniedRunRoot)).toEqual([]);
    expect(await readFile(path.join(fixture.repository, "src/greeting.txt"))).toEqual(sourceBytes);
    expect((await git(fixture.repository, ["rev-parse", "HEAD"])).trim()).toBe(sourceHead);
  });

  test("maps Git spawn errors to a stable sanitized failure", async () => {
    const fixture = await createFixtureRepository();
    cleanups.push(fixture.cleanup);
    const controllerHome = path.join(fixture.root, "controller-home");
    const runsRoot = path.join(fixture.root, "runs");
    await mkdir(controllerHome, { recursive: true, mode: 0o700 });
    await mkdir(runsRoot, { recursive: true, mode: 0o700 });
    const missingExecutable = `icarus-missing-git-${randomUUID()}`;
    const controller = new GitController(controllerHome, runsRoot, missingExecutable);

    const failure = await capturedError(controller.inspectRepository(fixture.repository));
    expect(failure).toMatchObject({
      code: "GIT_FAILED",
      message: "Git operation failed",
      details: { operation: "rev-parse", reason: "spawn" },
    });
    expect(JSON.stringify(failure)).not.toContain(missingExecutable);
    expect(JSON.stringify(failure)).not.toContain(fixture.repository);
  });
});
