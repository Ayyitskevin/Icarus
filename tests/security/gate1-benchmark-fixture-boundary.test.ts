import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { validateGate1BenchmarkReport } from "../../scripts/gate1-benchmark-result-contract.mjs";

const runnerPath = fileURLToPath(new URL("../../scripts/gate1-benchmark.mjs", import.meta.url));
const fixtureSource = fileURLToPath(new URL("../../fixtures/evals/gate1", import.meta.url));
const temporaryRoots: string[] = [];

async function temporaryBenchmarkRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "icarus-gate1-fixture-test-"));
  temporaryRoots.push(root);
  await mkdir(path.join(root, "fixtures", "evals"), { recursive: true });
  await cp(fixtureSource, path.join(root, "fixtures", "evals", "gate1"), { recursive: true });
  return root;
}

function runBenchmark(root: string) {
  return spawnSync(process.execPath, [runnerPath], {
    cwd: root,
    encoding: "utf8",
    env: {
      HOME: root,
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      PATH: "/usr/bin:/bin",
    },
    maxBuffer: 1024 * 1024,
    shell: false,
    timeout: 30_000,
  });
}

async function assertRejectedBeforeFixtureGit(root: string): Promise<void> {
  const result = runBenchmark(root);
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).toBe(1);
  const [reportBytes, manifestBytes] = await Promise.all([
    readFile(path.join(root, ".local", "gate1-benchmark-report.json")),
    readFile(path.join(root, "fixtures/evals/gate1/manifest.v1.json")),
  ]);
  const report = JSON.parse(reportBytes.toString("utf8")) as Record<string, unknown>;
  const failure = report.failure as Record<string, unknown>;
  const manifest =
    failure.stage === "manifest_or_fixture_preflight"
      ? null
      : (JSON.parse(manifestBytes.toString("utf8")) as Record<string, unknown>);
  const manifestDigest = createHash("sha256").update(manifestBytes).digest("hex");
  expect(validateGate1BenchmarkReport(report, manifest, manifestDigest)).toBe(report);
  expect(report).toMatchObject({
    assessment: "offline_contract_failed_gate1_incomplete",
    counts: { contractPassed: 0, failed: 1, liveEvidenceNotRun: 3 },
  });
  expect(["manifest_or_fixture_preflight", "case_execution"]).toContain(failure.stage);
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Gate 1 fixture Git trust boundary", () => {
  it("rejects a root .git directory before copied-fixture Git commands", async () => {
    const root = await temporaryBenchmarkRoot();
    await mkdir(path.join(root, "fixtures/evals/gate1/repos/typescript-library/.git"));
    await assertRejectedBeforeFixtureGit(root);
  });

  it("rejects a root .git file before copied-fixture Git commands", async () => {
    const root = await temporaryBenchmarkRoot();
    await writeFile(
      path.join(root, "fixtures/evals/gate1/repos/typescript-library/.git"),
      "gitdir: /tmp/not-a-repository\n",
    );
    await assertRejectedBeforeFixtureGit(root);
  });

  it("rejects a root .git symlink before copied-fixture Git commands", async () => {
    const root = await temporaryBenchmarkRoot();
    const outside = path.join(root, "outside-git");
    await mkdir(outside);
    await symlink(outside, path.join(root, "fixtures/evals/gate1/repos/typescript-library/.git"));
    await assertRejectedBeforeFixtureGit(root);
  });

  it("does not execute a malicious local clean filter hidden in fixture Git metadata", async () => {
    const root = await temporaryBenchmarkRoot();
    const marker = path.join(root, "filter-executed");
    const gitDirectory = path.join(root, "fixtures/evals/gate1/repos/typescript-library/.git");
    await mkdir(path.join(gitDirectory, "info"), { recursive: true });
    await writeFile(
      path.join(gitDirectory, "config"),
      `[core]\n\trepositoryformatversion = 0\n[filter "owned"]\n\tclean = /usr/bin/touch ${marker}\n\trequired = true\n`,
    );
    await writeFile(path.join(gitDirectory, "info", "attributes"), "* filter=owned\n");
    await assertRejectedBeforeFixtureGit(root);
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
