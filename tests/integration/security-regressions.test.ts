import { createHash } from "node:crypto";
import { appendFile, lstat, readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import { describe, expect, test } from "vitest";
import { digestJson } from "../../packages/core/src/digest.js";
import {
  createIcarusRuntime,
  createProviderConfig,
  DEFAULT_CEILING,
  DEFAULT_SANDBOX_LIMITS,
} from "../../packages/core/src/index.js";
import { OpenAIResponsesGateway } from "../../packages/core/src/providers.js";
import type { JsonValue } from "../../packages/core/src/types.js";
import {
  createFixtureRepository,
  git,
  PYTHON_IMAGE,
  planResponse,
  repositoryFingerprint,
  runCli,
  startOllamaQueue,
} from "../support/integration-cli.js";

interface TestDatabase {
  prepare(sql: string): { run(...parameters: unknown[]): unknown };
  close(): void;
}

const Database = createRequire(new URL("../../packages/core/package.json", import.meta.url))(
  "better-sqlite3",
) as new (
  filename: string,
) => TestDatabase;

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

function fixtureCredential(label: string): string {
  return [label, 'credential"segment\\', "9".repeat(24)].join("-");
}

function fixtureToken(character: string): string {
  return ["sk-", character.repeat(24)].join("");
}

function escapedFixtureToken(character: string): string {
  const escapedCharacter = `\\u00${character.codePointAt(0)?.toString(16)}`;
  return ["sk-", Array.from({ length: 24 }, () => escapedCharacter).join("")].join("");
}

function credentialVariants(secret: string): readonly Buffer[] {
  const digestPrefix = createHash("sha256").update(secret).digest("hex").slice(0, 12);
  return [
    Buffer.from(secret, "utf8"),
    Buffer.from(Buffer.from(secret, "utf8").toString("base64"), "utf8"),
    Buffer.from(JSON.stringify(secret).slice(1, -1), "utf8"),
    Buffer.from(digestPrefix, "utf8"),
  ];
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

  test("rejects a recognizable credential in check argv before project persistence", async () => {
    const fixture = await createFixtureRepository();
    const secret = fixtureToken("C");
    try {
      const repositoryResult = await runCli(fixture.stateRoot, [
        "repo",
        "add",
        "--name",
        "fixture",
        "--path",
        fixture.repository,
      ]);
      expect(repositoryResult.exitCode).toBe(0);

      const result = await runCli(fixture.stateRoot, [
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
        JSON.stringify({
          id: "verify",
          name: "Verify",
          argv: ["python", "checks/verify.py", secret],
        }),
      ]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("CHECK_SECRET_DETECTED");
      expect(result.stderr).not.toContain(secret);
      const reopened = await createIcarusRuntime(fixture.stateRoot);
      try {
        expect(reopened.service.listProjects()).toEqual([]);
      } finally {
        reopened.close();
      }
      expect(await readdir(path.join(fixture.stateRoot, "runs"))).toEqual([]);
      expect(await treeContains(fixture.stateRoot, Buffer.from(secret))).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  test.each(["id", "name"] as const)(
    "rejects a recognizable credential in check %s before project persistence",
    async (field) => {
      const fixture = await createFixtureRepository();
      const secret = fixtureToken("D");
      try {
        const repositoryResult = await runCli(fixture.stateRoot, [
          "repo",
          "add",
          "--name",
          "fixture",
          "--path",
          fixture.repository,
        ]);
        expect(repositoryResult.exitCode).toBe(0);

        const result = await runCli(fixture.stateRoot, [
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
          JSON.stringify({
            id: field === "id" ? secret : "verify",
            name: field === "name" ? secret : "Verify",
            argv: ["python", "--version"],
          }),
        ]);

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("CHECK_SECRET_DETECTED");
        expect(result.stderr).not.toContain(secret);
        const reopened = await createIcarusRuntime(fixture.stateRoot);
        try {
          expect(reopened.service.listProjects()).toEqual([]);
        } finally {
          reopened.close();
        }
        expect(await readdir(path.join(fixture.stateRoot, "runs"))).toEqual([]);
        expect(await treeContains(fixture.stateRoot, Buffer.from(secret))).toBe(false);
      } finally {
        await fixture.cleanup();
      }
    },
  );

  test("rejects a common credential target before run state, provider, or workspace creation", async () => {
    const fixture = await createFixtureRepository();
    const secret = fixtureCredential("target");
    const provider = await startOllamaQueue([planResponse()]);
    try {
      await appendFile(
        path.join(fixture.repository, ".npmrc"),
        `${["_authToken", secret].join("=")}\n`,
        "utf8",
      );
      await git(fixture.repository, ["add", ".npmrc"]);
      await git(fixture.repository, ["commit", "-m", "credential target fixture"]);
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
        ".npmrc",
        "--provider",
        "ollama",
        "--model",
        "contract-model",
        "--base-url",
        provider.baseUrl,
      ]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("PROTECTED_PATH");
      expect(result.stderr).not.toContain(secret);
      expect(provider.requests).toHaveLength(0);
      expect(await treeContains(fixture.stateRoot, Buffer.from(secret))).toBe(false);
      expect(await readdir(path.join(fixture.stateRoot, "runs")).catch(() => [])).toEqual([]);
      expect(await repositoryFingerprint(fixture.repository)).toEqual(sourceBefore);
    } finally {
      await provider.close();
      await fixture.cleanup();
    }
  });

  test.each([
    { selectedPath: "src/greeting.txt", boundary: "target" },
    { selectedPath: "README.md", boundary: "seed" },
    { selectedPath: "AGENTS.md", boundary: "rules" },
  ])(
    "rejects auth-bearing $boundary content before persistence, provider, or workspace creation",
    async ({ selectedPath, boundary }) => {
      const fixture = await createFixtureRepository();
      const secret = fixtureCredential(`selected-${boundary}`);
      const provider = await startOllamaQueue([planResponse()]);
      try {
        await appendFile(
          path.join(fixture.repository, selectedPath),
          `\n${["NPM_TOKEN", secret].join("=")}\n`,
          "utf8",
        );
        await git(fixture.repository, ["add", selectedPath]);
        await git(fixture.repository, ["commit", "-m", `auth-bearing ${boundary} fixture`]);
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
        expect(result.stderr).toContain("REPOSITORY_SECRET_DETECTED");
        expect(result.stderr).not.toContain(secret);
        expect(provider.requests).toHaveLength(0);
        expect(await treeContains(fixture.stateRoot, Buffer.from(secret))).toBe(false);
        expect(await readdir(path.join(fixture.stateRoot, "runs")).catch(() => [])).toEqual([]);
        expect(await repositoryFingerprint(fixture.repository)).toEqual(sourceBefore);
      } finally {
        await provider.close();
        await fixture.cleanup();
      }
    },
  );

  test("rejects an unrelated tracked credential before artifact, provider, or workspace creation", async () => {
    const fixture = await createFixtureRepository();
    const secret = fixtureCredential("unselected");
    const provider = await startOllamaQueue([planResponse()]);
    try {
      const secretPath = "runtime-notes.txt";
      await appendFile(
        path.join(fixture.repository, secretPath),
        `${["NPM_TOKEN", secret].join("=")}\n`,
        "utf8",
      );
      await git(fixture.repository, ["add", secretPath]);
      await git(fixture.repository, ["commit", "-m", "unselected credential fixture"]);
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
      expect(result.stderr).toContain("REPOSITORY_SECRET_DETECTED");
      expect(result.stderr).not.toContain(secret);
      expect(provider.requests).toHaveLength(0);

      const reopened = await createIcarusRuntime(fixture.stateRoot);
      try {
        const runs = reopened.service.listRuns("golden");
        expect(runs).toHaveLength(1);
        expect(runs[0]).toEqual(
          expect.objectContaining({
            state: "failed",
            contextArtifactPath: "",
            cachePath: null,
            worktreePath: null,
          }),
        );
      } finally {
        reopened.close();
      }

      expect(await readdir(path.join(fixture.stateRoot, "artifacts"))).toEqual([]);
      expect(await readdir(path.join(fixture.stateRoot, "runs"))).toEqual([]);
      for (const variant of credentialVariants(secret)) {
        expect(await treeContains(fixture.stateRoot, variant)).toBe(false);
      }
      expect(await repositoryFingerprint(fixture.repository)).toEqual(sourceBefore);
    } finally {
      await provider.close();
      await fixture.cleanup();
    }
  });

  test("discards secret-shaped successful provider output before persistence", async () => {
    const fixture = await createFixtureRepository();
    const secret = fixtureToken("S");
    const ordinaryPlan = planResponse().content ?? {};
    const encodedSecret = escapedFixtureToken("S");
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

  test("rejects a legacy prepared context without the current audit policy before egress", async () => {
    const fixture = await createFixtureRepository();
    let providerCreations = 0;
    const gatewayFactory = (config: ReturnType<typeof createProviderConfig>) => {
      providerCreations += 1;
      return {
        config,
        async generateStructured(): Promise<never> {
          throw new Error("provider must not be reached for a legacy context");
        },
      };
    };
    const runtime = await createIcarusRuntime(fixture.stateRoot, { gatewayFactory });
    let runtimeIsOpen = true;
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
      const { auditPolicyVersion: _auditPolicyVersion, ...legacyManifest } = awaitingEgress.context;
      const legacyContextSha256 = digestJson(legacyManifest as unknown as JsonValue);
      const artifact = JSON.parse(
        await readFile(awaitingEgress.contextArtifactPath, "utf8"),
      ) as Record<string, unknown>;
      delete artifact.auditPolicyVersion;
      await writeFile(awaitingEgress.contextArtifactPath, `${JSON.stringify(artifact)}\n`, "utf8");
      runtime.close();
      runtimeIsOpen = false;

      const database = new Database(path.join(fixture.stateRoot, "icarus.sqlite3"));
      try {
        database
          .prepare("UPDATE runs SET context_json = ?, context_sha256 = ? WHERE id = ?")
          .run(JSON.stringify(legacyManifest), legacyContextSha256, awaitingEgress.id);
      } finally {
        database.close();
      }

      const reopened = await createIcarusRuntime(fixture.stateRoot, { gatewayFactory });
      try {
        await expect(
          reopened.service.approveEgress(
            awaitingEgress.id,
            legacyContextSha256,
            "integration-test",
          ),
        ).rejects.toEqual(expect.objectContaining({ code: "CONTEXT_POLICY_OUTDATED" }));
        const history = reopened.service.history(awaitingEgress.id);
        expect(history.run).toEqual(
          expect.objectContaining({
            state: "awaiting_egress_approval",
            cachePath: null,
            worktreePath: null,
          }),
        );
        expect(history.approvals).toEqual([]);
        expect(providerCreations).toBe(0);
        expect(await readdir(path.join(fixture.stateRoot, "runs"))).toEqual([]);
      } finally {
        reopened.close();
      }
    } finally {
      if (runtimeIsOpen) runtime.close();
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
