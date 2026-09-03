import {
  cp,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadGate2BenchmarkContract } from "../../scripts/gate2-benchmark-contract.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const manifestV1Path = path.join(repositoryRoot, "fixtures/evals/gate2/manifest.v1.json");
const manifestV2Path = path.join(repositoryRoot, "fixtures/evals/gate2/manifest.v2.json");
const temporaryRoots: string[] = [];

async function fixtureCopy(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "icarus-gate2-contract-"));
  temporaryRoots.push(root);
  await cp(path.join(repositoryRoot, "fixtures"), path.join(root, "fixtures"), {
    recursive: true,
  });
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Gate 2 fixture boundary", () => {
  it("verifies every committed task and repository raw-byte pin", async () => {
    const result = await loadGate2BenchmarkContract(manifestV1Path, repositoryRoot);

    expect(result.manifest.cases).toHaveLength(30);
    expect(result.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.predecessorManifestSha256).toBeNull();
  });

  it("loads v2 only with its exact committed v1 predecessor", async () => {
    const result = await loadGate2BenchmarkContract(manifestV2Path, repositoryRoot);

    expect(result.manifest.schemaVersion).toBe(2);
    expect(result.manifest.cases).toHaveLength(30);
    expect(result.predecessorManifestSha256).toBe(
      "43159d8a174312e7fd720fbb625173601e7c90f6e5983c62c206b69ce99c9558",
    );

    const root = await fixtureCopy();
    const predecessor = path.join(root, "fixtures/evals/gate2/manifest.v1.json");
    await writeFile(predecessor, `${await readFile(predecessor, "utf8")} `, "utf8");
    await expect(
      loadGate2BenchmarkContract(path.join(root, "fixtures/evals/gate2/manifest.v2.json"), root),
    ).rejects.toThrow("predecessor manifest digest");
  });

  it("rejects a single-byte task mutation", async () => {
    const root = await fixtureCopy();
    const target = path.join(root, "fixtures/evals/gate2/tasks/repair-basic-greeting.md");
    await writeFile(target, `${await readFile(target, "utf8")}x`, "utf8");

    await expect(
      loadGate2BenchmarkContract(path.join(root, "fixtures/evals/gate2/manifest.v1.json"), root),
    ).rejects.toThrow("task digest");
  });

  it("rejects repository byte, inventory, and special-path drift", async () => {
    const byteRoot = await fixtureCopy();
    const source = path.join(byteRoot, "fixtures/evals/repos/basic/src/greeting.txt");
    await writeFile(source, "altered\n", "utf8");
    await expect(
      loadGate2BenchmarkContract(
        path.join(byteRoot, "fixtures/evals/gate2/manifest.v1.json"),
        byteRoot,
      ),
    ).rejects.toThrow("inventory drifted");

    const inventoryRoot = await fixtureCopy();
    await writeFile(
      path.join(inventoryRoot, "fixtures/evals/repos/basic/unpinned.txt"),
      "unpinned\n",
      "utf8",
    );
    await expect(
      loadGate2BenchmarkContract(
        path.join(inventoryRoot, "fixtures/evals/gate2/manifest.v1.json"),
        inventoryRoot,
      ),
    ).rejects.toThrow("inventory drifted");

    const gitRoot = await fixtureCopy();
    await mkdir(path.join(gitRoot, "fixtures/evals/repos/basic/.git"));
    await expect(
      loadGate2BenchmarkContract(
        path.join(gitRoot, "fixtures/evals/gate2/manifest.v1.json"),
        gitRoot,
      ),
    ).rejects.toThrow("cannot contain .git");

    const symlinkRoot = await fixtureCopy();
    await symlink("src/greeting.txt", path.join(symlinkRoot, "fixtures/evals/repos/basic/link"));
    await expect(
      loadGate2BenchmarkContract(
        path.join(symlinkRoot, "fixtures/evals/gate2/manifest.v1.json"),
        symlinkRoot,
      ),
    ).rejects.toThrow("special path");
  });
});

describe("Gate 2 fixture boundary, manifest v3", () => {
  const manifestV3Path = path.join(repositoryRoot, "fixtures/evals/gate2/manifest.v3.json");

  it("loads v3 only with its exact committed v2 predecessor", async () => {
    const result = await loadGate2BenchmarkContract(manifestV3Path, repositoryRoot);

    expect(result.manifest.schemaVersion).toBe(2);
    expect(result.manifest.benchmarkRevision).toBe("gate2-thirty-task-v3-task-entailed-targets");
    expect(result.manifest.cases).toHaveLength(30);
    expect(result.predecessorManifestSha256).toBe(
      "0eca6348be7848bac44922bcf426defdbd581af8ef790515e28c231b5fbc69c5",
    );

    const root = await fixtureCopy();
    const predecessor = path.join(root, "fixtures/evals/gate2/manifest.v2.json");
    await writeFile(predecessor, `${await readFile(predecessor, "utf8")} `, "utf8");
    await expect(
      loadGate2BenchmarkContract(path.join(root, "fixtures/evals/gate2/manifest.v3.json"), root),
    ).rejects.toThrow("predecessor manifest digest");
  });

  it("walks the lineage to v1: an edited v1 refuses v3 as well", async () => {
    const root = await fixtureCopy();
    const origin = path.join(root, "fixtures/evals/gate2/manifest.v1.json");
    await writeFile(origin, `${await readFile(origin, "utf8")} `, "utf8");
    await expect(
      loadGate2BenchmarkContract(path.join(root, "fixtures/evals/gate2/manifest.v3.json"), root),
    ).rejects.toThrow("predecessor manifest digest");
  });

  it("rejects a single-byte mutation of a successor task", async () => {
    const root = await fixtureCopy();
    const target = path.join(root, "fixtures/evals/gate2/tasks/scaffold-parser-cli-check.md");
    await writeFile(target, `${await readFile(target, "utf8")}x`, "utf8");
    await expect(
      loadGate2BenchmarkContract(path.join(root, "fixtures/evals/gate2/manifest.v3.json"), root),
    ).rejects.toThrow("task digest for scaffold-parser-cli-check");
  });
});

describe("Gate 2 fixture boundary, the read boundary and the registered digest", () => {
  const manifestV3Relative = "fixtures/evals/gate2/manifest.v3.json";

  it("refuses a whitespace-only edit of the current manifest: the bytes are not registered", async () => {
    const root = await fixtureCopy();
    const target = path.join(root, manifestV3Relative);
    await writeFile(target, `${await readFile(target, "utf8")} `, "utf8");
    await expect(loadGate2BenchmarkContract(target, root)).rejects.toThrow(
      "registered manifest digest for gate2-thirty-task-v3-task-entailed-targets",
    );
  });

  it("refuses a byte-identical symlink two links down the lineage", async () => {
    const root = await fixtureCopy();
    const outside = await mkdtemp(path.join(os.tmpdir(), "icarus-gate2-outside-"));
    temporaryRoots.push(outside);
    const origin = path.join(root, "fixtures/evals/gate2/manifest.v1.json");
    const moved = path.join(outside, "manifest.v1.json");
    await rename(origin, moved);
    await symlink(moved, origin);
    await expect(
      loadGate2BenchmarkContract(path.join(root, manifestV3Relative), root),
    ).rejects.toThrow(
      "predecessor manifest: fixtures/evals/gate2/manifest.v1.json passes through a symlink",
    );
  });

  it("refuses a symlinked task and a hard-linked task, even with the right bytes", async () => {
    const root = await fixtureCopy();
    const task = path.join(root, "fixtures/evals/gate2/tasks/scaffold-parser-cli-check.md");
    const aside = path.join(root, "fixtures/evals/gate2/tasks/aside.md");
    await rename(task, aside);
    await symlink(aside, task);
    await expect(
      loadGate2BenchmarkContract(path.join(root, manifestV3Relative), root),
    ).rejects.toThrow(
      "task scaffold-parser-cli-check: fixtures/evals/gate2/tasks/scaffold-parser-cli-check.md passes through a symlink",
    );

    await rm(task);
    await link(aside, task);
    await expect(
      loadGate2BenchmarkContract(path.join(root, manifestV3Relative), root),
    ).rejects.toThrow("is hard-linked");
  });

  it("refuses a manifest path outside the repository root and a symlinked directory component", async () => {
    const root = await fixtureCopy();
    const outside = await mkdtemp(path.join(os.tmpdir(), "icarus-gate2-outside-"));
    temporaryRoots.push(outside);
    await cp(path.join(root, manifestV3Relative), path.join(outside, "manifest.v3.json"));
    await expect(
      loadGate2BenchmarkContract(path.join(outside, "manifest.v3.json"), root),
    ).rejects.toThrow("escapes the repository root");

    const tasks = path.join(root, "fixtures/evals/gate2/tasks");
    const movedTasks = path.join(root, "fixtures/evals/gate2/tasks-real");
    await rename(tasks, movedTasks);
    await symlink(movedTasks, tasks);
    await expect(
      loadGate2BenchmarkContract(path.join(root, manifestV3Relative), root),
    ).rejects.toThrow("passes through a symlink");
  });
});

describe("Gate 2 fixture boundary, repository fixtures", () => {
  const manifestV3Relative = "fixtures/evals/gate2/manifest.v3.json";

  it("refuses a symlinked fixture root, even to a byte-identical tree outside the repository", async () => {
    const root = await fixtureCopy();
    const outside = await mkdtemp(path.join(os.tmpdir(), "icarus-gate2-outside-"));
    temporaryRoots.push(outside);
    const fixture = path.join(root, "fixtures/evals/repos/basic");
    const moved = path.join(outside, "basic");
    await rename(fixture, moved);
    await symlink(moved, fixture);
    await expect(
      loadGate2BenchmarkContract(path.join(root, manifestV3Relative), root),
    ).rejects.toThrow("repository basic: fixtures/evals/repos/basic passes through a symlink");
  });

  it("refuses a regular file offered as the repository root, by contract and not by ENOTDIR", async () => {
    const root = await fixtureCopy();
    const rootFile = path.join(root, "root.txt");
    await writeFile(rootFile, "not a directory\n", "utf8");
    await expect(
      loadGate2BenchmarkContract(path.join(rootFile, "manifest.v3.json"), rootFile),
    ).rejects.toThrow("manifest: repository root is not a directory");
  });

  it("refuses a hard-linked fixture file with the right bytes and the right name", async () => {
    const root = await fixtureCopy();
    const outside = await mkdtemp(path.join(os.tmpdir(), "icarus-gate2-outside-"));
    temporaryRoots.push(outside);
    await link(
      path.join(root, "fixtures/evals/repos/basic/src/greeting.txt"),
      path.join(outside, "greeting.txt"),
    );
    await expect(
      loadGate2BenchmarkContract(path.join(root, manifestV3Relative), root),
    ).rejects.toThrow("repository basic: src/greeting.txt is hard-linked");
  });
});

describe("Gate 2 fixture boundary, manifest v4", () => {
  const manifestV4Path = path.join(repositoryRoot, "fixtures/evals/gate2/manifest.v4.json");

  it("loads v4 only with its exact committed v3 predecessor, and an edited v1 three links down refuses it", async () => {
    const result = await loadGate2BenchmarkContract(manifestV4Path, repositoryRoot);
    expect(result.manifest.benchmarkRevision).toBe("gate2-thirty-task-v4-stated-contracts");
    expect(result.predecessorManifestSha256).toBe(
      "e1411ab97ee64c8dccb39868ae29a6774c3281c21a7bc81061c31ab22fae3134",
    );
    const root = await fixtureCopy();
    const predecessor = path.join(root, "fixtures/evals/gate2/manifest.v3.json");
    await writeFile(predecessor, `${await readFile(predecessor, "utf8")} `, "utf8");
    await expect(
      loadGate2BenchmarkContract(path.join(root, "fixtures/evals/gate2/manifest.v4.json"), root),
    ).rejects.toThrow("predecessor manifest digest");

    const deep = await fixtureCopy();
    const origin = path.join(deep, "fixtures/evals/gate2/manifest.v1.json");
    await writeFile(origin, `${await readFile(origin, "utf8")} `, "utf8");
    await expect(
      loadGate2BenchmarkContract(path.join(deep, "fixtures/evals/gate2/manifest.v4.json"), deep),
    ).rejects.toThrow("predecessor manifest digest");
  });
});
