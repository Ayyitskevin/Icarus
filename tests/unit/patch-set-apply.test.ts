import {
  access,
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { IcarusError } from "../../packages/core/src/errors.js";
import { GitController, type WorktreeFileWrite } from "../../packages/core/src/git.js";

const temporaryRoots: string[] = [];

async function fixture(): Promise<{
  readonly root: string;
  readonly worktree: string;
  readonly git: GitController;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "icarus-patch-set-apply-"));
  temporaryRoots.push(root);
  const worktree = path.join(root, "worktree");
  await mkdir(path.join(worktree, "src"), { recursive: true });
  await writeFile(path.join(worktree, "src", "app.ts"), "const value = 1;\n", { mode: 0o644 });
  await writeFile(path.join(worktree, "src", "helper.ts"), "export const helper = 1;\n", {
    mode: 0o644,
  });
  return {
    root,
    worktree,
    git: new GitController(path.join(root, "control"), path.join(root, "runs")),
  };
}

async function expectCode(action: Promise<unknown>, code: string): Promise<void> {
  try {
    await action;
  } catch (error) {
    expect(error).toBeInstanceOf(IcarusError);
    expect((error as IcarusError).code).toBe(code);
    return;
  }
  throw new Error(`Expected ${code}`);
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function strayTemporaries(root: string, worktree: string): Promise<string[]> {
  const inRunRoot = (await readdir(root)).filter((name) => name.startsWith(".icarus-"));
  const inWorktree = (await readdir(worktree)).filter((name) => name.startsWith(".icarus-"));
  const inSource = (await readdir(path.join(worktree, "src"))).filter((name) =>
    name.startsWith(".icarus-"),
  );
  return [...inRunRoot, ...inWorktree, ...inSource];
}

afterEach(async () => {
  while (temporaryRoots.length > 0) {
    const root = temporaryRoots.pop();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }
});

describe("multi-file patch application", () => {
  it("applies modify, create, and delete as one unit", async () => {
    const { root, git, worktree } = await fixture();
    const writes: readonly WorktreeFileWrite[] = [
      { path: "src/app.ts", content: "const value = 2;\n" },
      { path: "src/created.ts", content: "export const created = true;\n" },
      { path: "src/helper.ts", content: null },
    ];

    await git.applyFileWrites(worktree, writes, 4_096);

    expect(await readFile(path.join(worktree, "src", "app.ts"), "utf8")).toBe("const value = 2;\n");
    expect(await readFile(path.join(worktree, "src", "created.ts"), "utf8")).toBe(
      "export const created = true;\n",
    );
    expect(await exists(path.join(worktree, "src", "helper.ts"))).toBe(false);
    expect(await strayTemporaries(root, worktree)).toEqual([]);
  });

  it("creates missing parent directories inside the worktree only", async () => {
    const { git, worktree } = await fixture();

    await git.applyFileWrites(
      worktree,
      [{ path: "src/nested/deep/module.ts", content: "export const deep = true;\n" }],
      4_096,
    );

    expect(await readFile(path.join(worktree, "src", "nested", "deep", "module.ts"), "utf8")).toBe(
      "export const deep = true;\n",
    );
  });

  it("changes nothing when any path in the set is unsafe", async () => {
    const { root, git, worktree } = await fixture();

    await expectCode(
      git.applyFileWrites(
        worktree,
        [
          { path: "src/app.ts", content: "const value = 2;\n" },
          { path: "../escape.ts", content: "escaped\n" },
        ],
        4_096,
      ),
      "INVALID_PATH",
    );

    expect(await readFile(path.join(worktree, "src", "app.ts"), "utf8")).toBe("const value = 1;\n");
    expect(await exists(path.join(root, "escape.ts"))).toBe(false);
    expect(await strayTemporaries(root, worktree)).toEqual([]);
  });

  it("refuses to write through a symlinked parent and leaves the set unapplied", async () => {
    const { root, git, worktree } = await fixture();
    const outside = path.join(root, "outside");
    await mkdir(outside, { recursive: true });
    await symlink(outside, path.join(worktree, "linked"));

    await expectCode(
      git.applyFileWrites(
        worktree,
        [
          { path: "src/app.ts", content: "const value = 2;\n" },
          { path: "linked/escape.ts", content: "escaped\n" },
        ],
        4_096,
      ),
      "SYMLINK_DENIED",
    );

    expect(await readFile(path.join(worktree, "src", "app.ts"), "utf8")).toBe("const value = 1;\n");
    expect(await exists(path.join(outside, "escape.ts"))).toBe(false);
    expect(await strayTemporaries(root, worktree)).toEqual([]);
  });

  it("refuses to remove a path that does not exist", async () => {
    const { root, git, worktree } = await fixture();

    await expectCode(
      git.applyFileWrites(worktree, [{ path: "src/absent.ts", content: null }], 4_096),
      "SPECIAL_FILE_DENIED",
    );

    expect(await readFile(path.join(worktree, "src", "app.ts"), "utf8")).toBe("const value = 1;\n");
    expect(await strayTemporaries(root, worktree)).toEqual([]);
  });

  it("refuses a hard-linked target before writing any path in the set", async () => {
    const { root, git, worktree } = await fixture();
    await link(path.join(worktree, "src", "helper.ts"), path.join(root, "hardlink.ts"));

    await expectCode(
      git.applyFileWrites(
        worktree,
        [
          { path: "src/app.ts", content: "const value = 2;\n" },
          { path: "src/helper.ts", content: "export const helper = 2;\n" },
        ],
        4_096,
      ),
      "HARDLINK_DENIED",
    );

    expect(await readFile(path.join(worktree, "src", "app.ts"), "utf8")).toBe("const value = 1;\n");
    expect(await readFile(path.join(worktree, "src", "helper.ts"), "utf8")).toBe(
      "export const helper = 1;\n",
    );
    expect(await strayTemporaries(root, worktree)).toEqual([]);
  });

  it("refuses content above the byte ceiling before any path is applied", async () => {
    const { root, git, worktree } = await fixture();

    await expectCode(
      git.applyFileWrites(
        worktree,
        [
          { path: "src/app.ts", content: "const value = 2;\n" },
          { path: "src/helper.ts", content: `${"x".repeat(64)}\n` },
        ],
        16,
      ),
      "FILE_BUDGET_EXCEEDED",
    );

    expect(await readFile(path.join(worktree, "src", "app.ts"), "utf8")).toBe("const value = 1;\n");
    expect(await strayTemporaries(root, worktree)).toEqual([]);
  });

  it("is idempotent when replayed with the same desired bytes", async () => {
    const { root, git, worktree } = await fixture();
    const writes: readonly WorktreeFileWrite[] = [
      { path: "src/app.ts", content: "const value = 2;\n" },
      { path: "src/created.ts", content: "export const created = true;\n" },
    ];

    await git.applyFileWrites(worktree, writes, 4_096);
    await git.applyFileWrites(worktree, writes, 4_096);

    expect(await readFile(path.join(worktree, "src", "app.ts"), "utf8")).toBe("const value = 2;\n");
    expect(await readFile(path.join(worktree, "src", "created.ts"), "utf8")).toBe(
      "export const created = true;\n",
    );
    expect(await strayTemporaries(root, worktree)).toEqual([]);
  });

  it("restores baseline bytes and removes created paths on reversal", async () => {
    const { git, worktree } = await fixture();
    await git.applyFileWrites(
      worktree,
      [
        { path: "src/app.ts", content: "const value = 2;\n" },
        { path: "src/created.ts", content: "export const created = true;\n" },
        { path: "src/helper.ts", content: null },
      ],
      4_096,
    );

    await git.applyFileWrites(
      worktree,
      [
        { path: "src/app.ts", content: "const value = 1;\n" },
        { path: "src/created.ts", content: null },
        { path: "src/helper.ts", content: "export const helper = 1;\n" },
      ],
      4_096,
    );

    expect(await readFile(path.join(worktree, "src", "app.ts"), "utf8")).toBe("const value = 1;\n");
    expect(await exists(path.join(worktree, "src", "created.ts"))).toBe(false);
    expect(await readFile(path.join(worktree, "src", "helper.ts"), "utf8")).toBe(
      "export const helper = 1;\n",
    );
  });

  it("leaves no staging artifact inside the reviewed worktree", async () => {
    const { root, git, worktree } = await fixture();

    await git.applyFileWrites(
      worktree,
      [
        { path: "src/app.ts", content: "const value = 2;\n" },
        { path: "src/created.ts", content: "export const created = true;\n" },
      ],
      4_096,
    );

    // Replacement bytes are staged in the private run root, never beside the
    // target, so a crash cannot strand an unreviewed path in the review surface.
    expect((await readdir(path.join(worktree, "src"))).sort()).toEqual([
      "app.ts",
      "created.ts",
      "helper.ts",
    ]);
    expect(await strayTemporaries(root, worktree)).toEqual([]);
  });
});
