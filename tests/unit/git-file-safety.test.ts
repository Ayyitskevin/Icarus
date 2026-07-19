import { chmod, link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { IcarusError } from "../../packages/core/src/errors.js";
import { GitController } from "../../packages/core/src/git.js";

const temporaryRoots: string[] = [];

async function fixture(): Promise<{
  readonly root: string;
  readonly worktree: string;
  readonly git: GitController;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "icarus-git-file-safety-"));
  temporaryRoots.push(root);
  const worktree = path.join(root, "worktree");
  await mkdir(path.join(worktree, "src"), { recursive: true });
  return {
    root,
    worktree,
    git: new GitController(path.join(root, "control"), path.join(root, "runs")),
  };
}

async function expectCode(action: Promise<unknown>, code: string): Promise<void> {
  try {
    await action;
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(IcarusError);
    expect((error as IcarusError).code).toBe(code);
  }
}

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("private worktree file boundaries", () => {
  it("reads an ordinary bounded UTF-8 file", async () => {
    const { git, worktree } = await fixture();
    await writeFile(path.join(worktree, "src", "greeting.txt"), "Hello, Icarus!\n", {
      mode: 0o644,
    });

    await expect(git.readRegularUtf8File(worktree, "src/greeting.txt", 1024)).resolves.toBe(
      "Hello, Icarus!\n",
    );
  });

  it("rejects a symlink target before opening it", async () => {
    const { root, git, worktree } = await fixture();
    await writeFile(path.join(root, "outside.txt"), "outside\n");
    await symlink(path.join(root, "outside.txt"), path.join(worktree, "src", "greeting.txt"));

    await expectCode(git.readRegularUtf8File(worktree, "src/greeting.txt", 1024), "SYMLINK_DENIED");
  });

  it("rejects a symlink in the target's parent chain", async () => {
    const { root, git, worktree } = await fixture();
    await mkdir(path.join(root, "outside"));
    await writeFile(path.join(root, "outside", "greeting.txt"), "outside\n");
    await symlink(path.join(root, "outside"), path.join(worktree, "linked"));

    await expectCode(
      git.readRegularUtf8File(worktree, "linked/greeting.txt", 1024),
      "SYMLINK_DENIED",
    );
  });

  it("rejects hard-linked and executable targets", async () => {
    const { root, git, worktree } = await fixture();
    const original = path.join(root, "original.txt");
    const hardlink = path.join(worktree, "src", "hardlink.txt");
    const executable = path.join(worktree, "src", "executable.txt");
    await writeFile(original, "shared\n");
    await link(original, hardlink);
    await writeFile(executable, "#!/bin/sh\n");
    await chmod(executable, 0o755);

    await expectCode(
      git.readRegularUtf8File(worktree, "src/hardlink.txt", 1024),
      "HARDLINK_DENIED",
    );
    await expectCode(git.readRegularUtf8File(worktree, "src/executable.txt", 1024), "MODE_DENIED");
  });
});
