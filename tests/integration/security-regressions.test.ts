import { appendFile, readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  createFixtureRepository,
  git,
  planResponse,
  PYTHON_IMAGE,
  runCli,
  startOllamaQueue,
} from "../support/integration-cli.js";

async function configureProject(repository: string, stateRoot: string): Promise<void> {
  expect(
    (await runCli(stateRoot, ["repo", "add", "--name", "fixture", "--path", repository])).exitCode,
  ).toBe(0);
  expect(
    (
      await runCli(stateRoot, [
        "project",
        "add",
        "--name",
        "golden",
        "--repo",
        "fixture",
        "--base-ref",
        "main",
        "--sandbox-image",
        PYTHON_IMAGE,
        "--check",
        JSON.stringify({ id: "verify", name: "Verify", argv: ["python", "checks/verify.py"] }),
      ])
    ).exitCode,
  ).toBe(0);
}

async function treeContains(root: string, needle: Buffer): Promise<boolean> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (await treeContains(entryPath, needle)) return true;
    } else if (entry.isFile() && (await readFile(entryPath)).includes(needle)) {
      return true;
    }
  }
  return false;
}

describe("release security regressions", () => {
  test("rejects a state root hidden in a clean ignored descendant named ..state", async () => {
    const fixture = await createFixtureRepository();
    try {
      await appendFile(path.join(fixture.repository, ".gitignore"), "..state/\n", "utf8");
      await git(fixture.repository, ["add", ".gitignore"]);
      await git(fixture.repository, ["commit", "-m", "ignore nested state fixture"]);
      const nestedState = path.join(fixture.repository, "..state");

      const result = await runCli(nestedState, [
        "repo",
        "add",
        "--name",
        "fixture",
        "--path",
        fixture.repository,
      ]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("STATE_REPOSITORY_OVERLAP");
    } finally {
      await fixture.cleanup();
    }
  });

  test("discards secret-shaped successful provider output before persistence", async () => {
    const fixture = await createFixtureRepository();
    const secret = `sk-${"S".repeat(24)}`;
    const ordinaryPlan = planResponse().content ?? {};
    const encodedSecret = `sk-${Array.from({ length: 24 }, () => "\\u0053").join("")}`;
    const encodedPlan = JSON.stringify({
      ...ordinaryPlan,
      summary: `Do not persist ${encodedSecret}`,
    }).replaceAll("\\\\u0053", "\\u0053");
    const provider = await startOllamaQueue([
      {
        rawBody: JSON.stringify({
          message: { content: encodedPlan },
          prompt_eval_count: 12,
          eval_count: 8,
        }),
      },
    ]);
    try {
      await configureProject(fixture.repository, fixture.stateRoot);
      const result = await runCli(fixture.stateRoot, [
        "run",
        "plan",
        "--project",
        "golden",
        "--task",
        "Replace the greeting.",
        "--target",
        "src/greeting.txt",
        "--provider",
        "ollama",
        "--model",
        "contract-model",
        "--base-url",
        provider.baseUrl,
      ]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("PROVIDER_SECRET_DETECTED");
      expect(result.stderr).not.toContain(secret);
      expect(await treeContains(fixture.stateRoot, Buffer.from(secret, "utf8"))).toBe(false);
    } finally {
      await provider.close();
      await fixture.cleanup();
    }
  });
});
