import { execFile } from "node:child_process";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { sha256 } from "../../packages/core/src/digest.js";
import { IcarusError } from "../../packages/core/src/errors.js";
import { GitController } from "../../packages/core/src/git.js";
import { DEFAULT_CEILING, MAX_READABLE_FILES } from "../../packages/core/src/policy.js";
import {
  pathMatchesScopeEntry,
  resolveReadableManifest,
} from "../../packages/core/src/read-manifest.js";

const run = promisify(execFile);
const temporaryRoots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  while (temporaryRoots.length > 0) {
    const root = temporaryRoots.pop();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }
});

async function repositoryWith(
  files: Readonly<Record<string, string>>,
  prepare?: (repositoryPath: string) => Promise<void>,
): Promise<{
  readonly repositoryPath: string;
  readonly commit: string;
  readonly git: GitController;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "icarus-read-manifest-"));
  temporaryRoots.push(root);
  const repositoryPath = path.join(root, "repository");
  await mkdir(repositoryPath, { recursive: true });
  await run("git", ["init", "--quiet", "--initial-branch=main"], { cwd: repositoryPath });
  await run("git", ["config", "user.email", "unit@example.com"], { cwd: repositoryPath });
  await run("git", ["config", "user.name", "Unit"], { cwd: repositoryPath });
  for (const [filePath, content] of Object.entries(files)) {
    const absolute = path.join(repositoryPath, filePath);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content, "utf8");
  }
  if (prepare !== undefined) await prepare(repositoryPath);
  await run("git", ["add", "-A"], { cwd: repositoryPath });
  await run("git", ["commit", "--quiet", "-m", "fixture"], { cwd: repositoryPath });
  const { stdout } = await run("git", ["rev-parse", "HEAD"], { cwd: repositoryPath });
  return {
    repositoryPath,
    commit: stdout.trim(),
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

describe("read scope matching", () => {
  it("treats a trailing slash as a directory prefix and anything else as an exact path", () => {
    expect(pathMatchesScopeEntry("src/a.ts", "src/")).toBe(true);
    expect(pathMatchesScopeEntry("src/deep/a.ts", "src/")).toBe(true);
    expect(pathMatchesScopeEntry("srcx/a.ts", "src/")).toBe(false);
    expect(pathMatchesScopeEntry("src/a.ts", "src")).toBe(true);
    expect(pathMatchesScopeEntry("src/a.ts", "src/a.ts")).toBe(true);
    expect(pathMatchesScopeEntry("src/ab.ts", "src/a.ts")).toBe(false);
  });

  it("does not honour wildcards, so a pattern cannot widen a scope silently", () => {
    expect(pathMatchesScopeEntry("src/a.ts", "src/*")).toBe(false);
    expect(pathMatchesScopeEntry("src/a.ts", "**")).toBe(false);
  });
});

describe("readable manifest resolution", () => {
  it("enumerates in-scope files pinned by content digest at the base commit", async () => {
    const fixture = await repositoryWith({
      "src/a.ts": "export const a = 1;\n",
      "src/deep/b.ts": "export const b = 2;\n",
      "docs/c.md": "# out of scope\n",
    });
    const { manifest, excluded } = await resolveReadableManifest(
      fixture.git,
      fixture.repositoryPath,
      fixture.commit,
      ["src/"],
      DEFAULT_CEILING,
    );

    expect(manifest.baseCommit).toBe(fixture.commit);
    expect(manifest.entries.map((entry) => entry.path)).toEqual(["src/a.ts", "src/deep/b.ts"]);
    expect(manifest.entries[0]?.sha256).toBe(sha256("export const a = 1;\n"));
    expect(excluded).toEqual([]);
  });

  it("admits nothing for an empty scope rather than everything", async () => {
    const fixture = await repositoryWith({ "src/a.ts": "export const a = 1;\n" });
    const { manifest } = await resolveReadableManifest(
      fixture.git,
      fixture.repositoryPath,
      fixture.commit,
      [],
      DEFAULT_CEILING,
    );
    expect(manifest.entries).toEqual([]);
  });

  it("refuses a scope admitting more than the host ceiling before reading any blob", async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index <= MAX_READABLE_FILES; index += 1) {
      files[`src/file-${String(index).padStart(4, "0")}.txt`] = `contents ${index}\n`;
    }
    const fixture = await repositoryWith(files);
    await expectCode(
      resolveReadableManifest(
        fixture.git,
        fixture.repositoryPath,
        fixture.commit,
        ["src/"],
        DEFAULT_CEILING,
      ),
      "READ_SCOPE_TOO_LARGE",
    );
  });

  it("excludes a symlink instead of following it, and reports why", async () => {
    const fixture = await repositoryWith({ "src/a.ts": "export const a = 1;\n" }, async (root) => {
      await symlink("../../../etc/passwd", path.join(root, "src", "escape.ts"));
    });
    const { manifest, excluded } = await resolveReadableManifest(
      fixture.git,
      fixture.repositoryPath,
      fixture.commit,
      ["src/"],
      DEFAULT_CEILING,
    );
    expect(manifest.entries.map((entry) => entry.path)).toEqual(["src/a.ts"]);
    expect(excluded).toEqual([{ path: "src/escape.ts", reason: "symlink" }]);
  });

  it("excludes binary content rather than admitting undecodable bytes", async () => {
    const fixture = await repositoryWith({ "src/a.ts": "export const a = 1;\n" }, async (root) => {
      await writeFile(path.join(root, "src", "blob.bin"), Buffer.from([0x00, 0x01, 0x02, 0x00]));
    });
    const { manifest, excluded } = await resolveReadableManifest(
      fixture.git,
      fixture.repositoryPath,
      fixture.commit,
      ["src/"],
      DEFAULT_CEILING,
    );
    expect(manifest.entries.map((entry) => entry.path)).toEqual(["src/a.ts"]);
    expect(excluded).toEqual([{ path: "src/blob.bin", reason: "not_utf8_text" }]);
  });

  it("excludes secret-shaped content, so a read grant cannot enumerate a credential", async () => {
    const fixture = await repositoryWith({
      "src/a.ts": "export const a = 1;\n",
      "src/creds.ts": 'export const key = "AKIAIOSFODNN7EXAMPLE";\n',
    });
    const { manifest, excluded } = await resolveReadableManifest(
      fixture.git,
      fixture.repositoryPath,
      fixture.commit,
      ["src/"],
      DEFAULT_CEILING,
    );
    expect(manifest.entries.map((entry) => entry.path)).not.toContain("src/creds.ts");
    expect(excluded).toEqual([{ path: "src/creds.ts", reason: "secret_shaped_content" }]);
  });

  it("resolves the same set to the same digest regardless of tree order", async () => {
    const fixture = await repositoryWith({
      "src/b.ts": "export const b = 2;\n",
      "src/a.ts": "export const a = 1;\n",
    });
    const { manifest } = await resolveReadableManifest(
      fixture.git,
      fixture.repositoryPath,
      fixture.commit,
      ["src/"],
      DEFAULT_CEILING,
    );
    expect(manifest.entries.map((entry) => entry.path)).toEqual(["src/a.ts", "src/b.ts"]);
  });
});
