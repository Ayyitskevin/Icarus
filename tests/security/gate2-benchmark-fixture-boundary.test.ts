import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
