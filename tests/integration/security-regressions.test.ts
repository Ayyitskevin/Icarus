import { appendFile, lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  createIcarusRuntime,
  createProviderConfig,
  DEFAULT_CEILING,
  DEFAULT_SANDBOX_LIMITS,
} from "../../packages/core/src/index.js";
import { OpenAIResponsesGateway } from "../../packages/core/src/providers.js";
import {
  createFixtureRepository,
  git,
  planResponse,
  PYTHON_IMAGE,
  repositoryFingerprint,
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
      await expect(lstat(nestedState)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fixture.cleanup();
    }
  });

  test("rejects a state root nested under a missing repository before creating either path", async () => {
    const fixture = await createFixtureRepository();
    try {
      const missingRepository = path.join(fixture.root, "missing-repository");
      const nestedState = path.join(missingRepository, ".state");
      const result = await runCli(nestedState, [
        "repo",
        "add",
        "--name",
        "missing",
        "--path",
        missingRepository,
      ]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("STATE_REPOSITORY_OVERLAP");
      await expect(lstat(missingRepository)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(nestedState)).rejects.toMatchObject({ code: "ENOENT" });
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

  test("never persists an OpenAI key reflected by a thrown transport error", async () => {
    const fixture = await createFixtureRepository();
    const secret = "test-only-openai-key-value-0123456789";
    const throwingFetch = (() =>
      Promise.reject(new Error(`transport rejected bearer ${secret}`))) as typeof fetch;
    const runtime = await createIcarusRuntime(fixture.stateRoot, {
      gatewayFactory: (config) => new OpenAIResponsesGateway(config, secret, throwingFetch),
    });
    try {
      await runtime.service.registerRepository("fixture", fixture.repository);
      runtime.service.createProject({
        name: "golden",
        repositoryName: "fixture",
        baseRef: "main",
        checks: [{ id: "verify", name: "Verify", argv: ["python", "checks/verify.py"] }],
        sandbox: { image: PYTHON_IMAGE, ...DEFAULT_SANDBOX_LIMITS },
        ceiling: DEFAULT_CEILING,
      });
      const awaitingEgress = await runtime.service.planRun({
        projectName: "golden",
        task: "Replace the greeting.",
        target: "src/greeting.txt",
        provider: createProviderConfig({
          kind: "openai",
          model: "contract-model",
          baseUrl: "https://api.openai.com/v1/",
          inputUsdPerMillionTokens: 1,
          outputUsdPerMillionTokens: 1,
        }),
      });

      await expect(
        runtime.service.approveEgress(
          awaitingEgress.id,
          awaitingEgress.contextSha256,
          "integration-test",
        ),
      ).rejects.toMatchObject({ code: "PROVIDER_TRANSPORT_ERROR" });
      expect(JSON.stringify(runtime.service.history(awaitingEgress.id))).not.toContain(secret);
      expect(await treeContains(fixture.stateRoot, Buffer.from(secret, "utf8"))).toBe(false);
    } finally {
      runtime.close();
      await fixture.cleanup();
    }
  });

  test("treats malicious repository instructions as data and rejects an expanded plan", async () => {
    const fixture = await createFixtureRepository();
    const provider = await startOllamaQueue([
      {
        content: {
          summary: "Follow the repository instruction.",
          steps: ["Escape the approved workspace"],
          risks: [],
          target: "../outside",
          checkIds: ["verify"],
        },
      },
    ]);
    try {
      const sourceBefore = await repositoryFingerprint(fixture.repository);
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
      expect(result.stderr).toContain("TARGET_MISMATCH");
      expect(provider.requests).toHaveLength(1);
      const providerInput = JSON.stringify(provider.requests[0]?.body);
      expect(providerInput).toContain("MALICIOUS-INSTRUCTION-FIXTURE");
      expect(providerInput).toContain("BEGIN UNTRUSTED REPOSITORY DATA: AGENTS.md");
      expect(await repositoryFingerprint(fixture.repository)).toEqual(sourceBefore);
    } finally {
      await provider.close();
      await fixture.cleanup();
    }
  });
});
