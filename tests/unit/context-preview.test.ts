import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { assembleContext } from "../../packages/core/src/context.js";
import { createContextPreview } from "../../packages/core/src/context-preview.js";
import { DEFAULT_CEILING } from "../../packages/core/src/policy.js";
import type { TreeEntry } from "../../packages/core/src/git.js";
import { GitController } from "../../packages/core/src/git.js";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return result.stdout;
}

async function writeFixture(
  repositoryPath: string,
  relativePath: string,
  value: string | Uint8Array,
): Promise<void> {
  const destination = path.join(repositoryPath, relativePath);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, value);
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("project context preview", () => {
  it("is deterministic, read-only, and derived only from the filtered committed tree", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "icarus-context-preview-"));
    temporaryRoots.push(root);
    const repositoryPath = path.join(root, "repository");
    await mkdir(repositoryPath);
    await runGit(repositoryPath, ["init", "--quiet", "--initial-branch=main"]);
    await runGit(repositoryPath, ["config", "user.name", "Icarus Test"]);
    await runGit(repositoryPath, ["config", "user.email", "icarus@example.invalid"]);

    await writeFixture(repositoryPath, ".gitignore", "ignored.txt\nscratch/\n");
    await writeFixture(repositoryPath, "AGENTS.md", "# Root rules\n");
    await writeFixture(repositoryPath, "README.md", "# Preview fixture\n");
    await writeFixture(repositoryPath, "src/AGENTS.md", "# Source rules\n");
    await writeFixture(repositoryPath, "src/app.ts", 'export const greeting = "hello";\n');
    await writeFixture(repositoryPath, "src/helper.ts", "export const helper = true;\n");
    await writeFixture(repositoryPath, ".env.example", "API_TOKEN=example\n");
    await writeFixture(repositoryPath, "node_modules/pkg/index.js", "module.exports = {};\n");
    await writeFixture(repositoryPath, "dist/bundle.js", "generated bundle\n");
    await writeFixture(repositoryPath, "build/output.txt", "generated build\n");
    await writeFixture(repositoryPath, "coverage/report.txt", "generated coverage\n");
    await writeFixture(repositoryPath, "generated/client.ts", "generated client\n");
    await writeFixture(
      repositoryPath,
      "docs/runtime-config.txt",
      "NPM_TOKEN=preview-secret-value-1234567890\n",
    );
    await writeFixture(repositoryPath, "assets/binary.dat", Buffer.from([0, 1, 2, 3]));
    await writeFixture(repositoryPath, "assets/invalid.txt", Buffer.from([0xc3, 0x28]));
    await runGit(repositoryPath, ["add", "--all"]);
    await runGit(repositoryPath, ["commit", "--quiet", "-m", "preview fixture"]);

    await writeFixture(repositoryPath, "ignored.txt", "ignored working-tree file\n");
    await writeFixture(repositoryPath, "scratch/untracked.ts", "ignored untracked file\n");
    await writeFixture(repositoryPath, "local-only.txt", "ordinary untracked file\n");

    const controlHome = path.join(root, "control-home");
    const runsRoot = path.join(root, "runs");
    await mkdir(controlHome);
    await mkdir(runsRoot);
    const controller = new GitController(controlHome, runsRoot);
    const baseCommit = (await runGit(repositoryPath, ["rev-parse", "HEAD^{commit}"])).trim();
    const statusBefore = await runGit(repositoryPath, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]);

    const first = await createContextPreview(controller, repositoryPath, baseCommit, "src/app.ts");
    const second = await createContextPreview(controller, repositoryPath, baseCommit, "src/app.ts");

    expect(second).toEqual(first);
    expect(first.baseCommit).toBe(baseCommit);
    expect(first.target).toBe("src/app.ts");
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(first.repositoryDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(first.map.map((entry) => entry.path)).toEqual([
      ".gitignore",
      "AGENTS.md",
      "README.md",
      "src/AGENTS.md",
      "src/app.ts",
      "src/helper.ts",
    ]);
    expect(first.selected).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "AGENTS.md", reason: "root_rules" }),
        expect.objectContaining({ path: "README.md", reason: "seed" }),
        expect.objectContaining({ path: "src/AGENTS.md", reason: "target_rules" }),
        expect.objectContaining({ path: "src/app.ts", reason: "target" }),
      ]),
    );
    expect(first.counts).toMatchObject({
      trackedFiles: 15,
      includedFiles: 6,
      excludedFiles: 9,
      excludedPathFiles: 6,
      excludedBinaryFiles: 2,
      excludedSecretFiles: 1,
    });
    expect(first.warnings).toEqual([
      "6 tracked file(s) were hidden by context preview path policy.",
      "2 binary or invalid UTF-8 file(s) were omitted.",
      "1 file(s) with secret-shaped content were omitted.",
    ]);

    const serialized = JSON.stringify(first);
    for (const excludedPath of [
      ".env.example",
      "node_modules/pkg/index.js",
      "dist/bundle.js",
      "build/output.txt",
      "coverage/report.txt",
      "generated/client.ts",
      "docs/runtime-config.txt",
      "assets/binary.dat",
      "assets/invalid.txt",
      "ignored.txt",
      "scratch/untracked.ts",
      "local-only.txt",
    ]) {
      expect(serialized).not.toContain(excludedPath);
    }
    expect(serialized).not.toContain("preview-secret-value");
    expect(serialized).not.toContain("export const greeting");
    expect(statusBefore).toContain("local-only.txt");
    expect(
      await runGit(repositoryPath, ["status", "--porcelain=v1", "--untracked-files=all"]),
    ).toBe(statusBefore);
    expect((await runGit(repositoryPath, ["rev-parse", "HEAD^{commit}"])).trim()).toBe(baseCommit);

    await expect(
      createContextPreview(controller, repositoryPath, baseCommit, "dist/bundle.js"),
    ).rejects.toMatchObject({ code: "CONTEXT_PREVIEW_TARGET_EXCLUDED" });
  });

  it("keeps optional binary and symlink entries out of the actual model context", async () => {
    const tree: TreeEntry[] = [
      { mode: "100644", type: "blob", objectId: "target", path: "src/app.ts" },
      { mode: "120000", type: "blob", objectId: "readme-link", path: "README.md" },
      { mode: "100644", type: "blob", objectId: "binary-rules", path: "AGENTS.md" },
      { mode: "100644", type: "blob", objectId: "generated", path: "generated/client.ts" },
    ];
    const blobs = new Map<string, Buffer>([
      ["target", Buffer.from("export const value = 1;\n", "utf8")],
      ["readme-link", Buffer.from("docs/README.md", "utf8")],
      ["binary-rules", Buffer.from([0, 1, 2, 3])],
      ["generated", Buffer.from("export const generated = true;\n", "utf8")],
    ]);
    const git = {
      listTree: vi.fn(async () => tree),
      readBlob: vi.fn(async (_repositoryPath: string, objectId: string) => {
        const bytes = blobs.get(objectId);
        if (bytes === undefined) throw new Error(`Unknown object: ${objectId}`);
        return bytes;
      }),
    };

    const assembled = await assembleContext(
      git as unknown as GitController,
      "/repository",
      "a".repeat(40),
      "src/app.ts",
      DEFAULT_CEILING,
    );

    expect(assembled.bundle.repositoryMap).toEqual(["src/app.ts"]);
    expect(assembled.bundle.entries.map((entry) => entry.path)).toEqual([
      "<repository-map>",
      "src/app.ts",
    ]);
    expect(JSON.stringify(assembled.bundle)).not.toContain("README.md");
    expect(JSON.stringify(assembled.bundle)).not.toContain("AGENTS.md");
    expect(JSON.stringify(assembled.bundle)).not.toContain("generated/client.ts");
  });

  it("rejects hidden targets and never reads path- or mode-excluded blobs", async () => {
    const tree: TreeEntry[] = [
      { mode: "100644", type: "blob", objectId: "1", path: ".env.production" },
      { mode: "100644", type: "blob", objectId: "2", path: "credentials.json" },
      { mode: "100644", type: "blob", objectId: "3", path: "dist/output.js" },
      { mode: "100644", type: "blob", objectId: "4", path: "node_modules/pkg.js" },
      { mode: "100644", type: "blob", objectId: "5", path: "src/app.ts" },
      { mode: "120000", type: "blob", objectId: "6", path: "src/link.ts" },
      { mode: "100644", type: "blob", objectId: "7", path: "src/private.ts" },
      { mode: "100644", type: "blob", objectId: "8", path: "src/generated/client.ts" },
    ].reverse();
    const targetBytes = Buffer.from("export const value = 1;\n", "utf8");
    const secretBytes = Buffer.from("API_TOKEN=actual-secret-value-1234567890\n", "utf8");
    const readBlob = vi.fn(async (_repositoryPath: string, objectId: string) => {
      if (objectId === "5") return targetBytes;
      if (objectId === "7") return secretBytes;
      throw new Error(`Excluded blob ${objectId} must not be read`);
    });
    const git = {
      listTree: vi.fn(async () => tree),
      readBlob,
    };

    const preview = await createContextPreview(git, "/repository", "a".repeat(40), "src/app.ts");

    expect(readBlob.mock.calls.map((call) => call[1])).toEqual(["5", "7"]);
    expect(preview.map).toEqual([
      expect.objectContaining({ path: "src/app.ts", reason: "repository_map" }),
    ]);
    expect(preview.counts).toMatchObject({
      includedFiles: 1,
      excludedFiles: 7,
      excludedPathFiles: 6,
      excludedSecretFiles: 1,
      scannedBytes: targetBytes.length + secretBytes.length,
    });

    readBlob.mockClear();
    await expect(
      createContextPreview(git, "/repository", "a".repeat(40), ".env.production"),
    ).rejects.toMatchObject({ code: "PROTECTED_PATH" });
    expect(readBlob).not.toHaveBeenCalled();
  });
});
