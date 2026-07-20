import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  containsSecretShapedContent,
  isIntrinsicallySecretPath,
  isProtectedEditPath,
  MAX_TRACKED_TREE_FILE_BYTES,
  shouldHidePathFromModel,
} from "../../packages/core/src/context.js";
import { IcarusError } from "../../packages/core/src/errors.js";
import type { GitController, TreeEntry } from "../../packages/core/src/git.js";
import {
  assertAllowedTarget,
  assertCheckProfiles,
  assertSunCeiling,
  DEFAULT_CEILING,
  DEFAULT_SANDBOX_LIMITS,
} from "../../packages/core/src/policy.js";
import { sanitizeText } from "../../packages/core/src/redaction.js";
import { DockerSandboxRunner } from "../../packages/core/src/sandbox.js";
import { createRecordingDocker } from "../support/sandbox-fake-docker.js";

function rejectedCode(target: string): string | null {
  try {
    assertAllowedTarget(target);
    return null;
  } catch (error) {
    return error instanceof IcarusError ? error.code : "UNKNOWN";
  }
}

function assignment(key: string, value: string, separator = "="): string {
  return [key, separator, value].join("");
}

function credentialValue(label: string): string {
  return [label, "credential", "7".repeat(24)].join("-");
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

describe("host-owned policy boundaries", () => {
  test.each([
    "../escape",
    "/absolute/path",
    ".git/config",
    ".env.production",
    "migrations/001.sql",
    "AGENTS.md",
    "Dockerfile",
    "package.json",
    "pnpm-lock.yaml",
    "keys/private.pem",
  ])("rejects protected or escaping target %s", (target) => {
    expect(rejectedCode(target)).not.toBeNull();
  });

  test.each([
    ".env",
    ".env.production",
    ".npmrc",
    ".yarnrc.yml",
    ".bundle/config",
    "nested/.netrc",
    ".pypirc",
    ".ssh/config",
    ".ssh/id_ed25519",
    ".docker/config.json",
    ".aws/config",
    ".aws/credentials",
    ".config/gcloud/application_default_credentials.json",
    ".config/rclone/rclone.conf",
    ".azure/accessTokens.json",
    ".kube/config",
    ".config/containers/auth.json",
    ".terraform.d/credentials.tfrc.json",
    ".terraformrc",
    "credentials.tfrc.json",
    "config/prod-secrets.json",
    "keys/service-account.json",
    "secrets/prod.yaml",
    ".secrets/prod.yaml",
    "credentials/aws",
    "private-keys/prod.pem.enc",
  ])("hides and protects common credential-prone path %s", (target) => {
    expect(shouldHidePathFromModel(target)).toBe(true);
    expect(isProtectedEditPath(target)).toBe(true);
    expect(rejectedCode(target)).toBe("PROTECTED_PATH");
  });

  test.each([
    ".env",
    "nested/.env",
    ".netrc",
    ".ssh/id_ed25519",
    ".aws/credentials",
    ".kube/config",
    "secrets/prod.yaml",
    "credentials/aws",
    "private-keys/prod.pem.enc",
  ])("classifies intrinsically secret path %s for snapshot denial", (target) => {
    expect(isIntrinsicallySecretPath(target)).toBe(true);
  });

  test("separates exact environment secrets from safe configuration templates", () => {
    expect(shouldHidePathFromModel(".npmrc")).toBe(true);
    expect(isProtectedEditPath(".npmrc")).toBe(true);
    expect(isIntrinsicallySecretPath(".npmrc")).toBe(false);
    expect(shouldHidePathFromModel("secrets/.env.example")).toBe(true);
    expect(isProtectedEditPath("secrets/.env.example")).toBe(true);
    expect(isIntrinsicallySecretPath("secrets/.env.example")).toBe(true);
    expect(rejectedCode("secrets/.env.example")).toBe("PROTECTED_PATH");
    expect(shouldHidePathFromModel(".env.example")).toBe(false);
    expect(isProtectedEditPath(".env.example")).toBe(false);
    expect(isIntrinsicallySecretPath(".env.example")).toBe(false);
    expect(isIntrinsicallySecretPath(".env.production")).toBe(false);
  });

  test.each([
    ".env.example",
    "nested/.env.sample",
    "src/tokenizer.ts",
    "src/password-reset.ts",
    "src/credential-parser.ts",
    "src/private-key-types.ts",
    "docs/secret-management.md",
    "src/secrets/manager.ts",
    "src/token/index.ts",
    "config/docker/config-schema.json",
    ".docker/README.md",
  ])("preserves ordinary source or documentation path %s", (target) => {
    expect(shouldHidePathFromModel(target)).toBe(false);
    expect(isProtectedEditPath(target)).toBe(false);
    expect(isIntrinsicallySecretPath(target)).toBe(false);
    expect(rejectedCode(target)).toBeNull();
  });

  const positiveContent = [
    assignment("//registry.npmjs.org/:_authToken", "npm-value-123456"),
    assignment("NPM_TOKEN", "npm-value-123456"),
    assignment("Authorization", "Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature", ": "),
    assignment("password", '"correct horse battery staple"', " = "),
    assignment("password", "P@ssw0rd!"),
    assignment("spring.datasource.password", "P@ssw0rd!"),
    assignment("storePassword", "P@ssw0rd!"),
    assignment("clientSecret", "s3cr3t-value"),
    assignment("PASSWORD", "SuperSecretValue"),
    assignment("AWS_SECRET_ACCESS_KEY", "abcdEFGH1234+/xyz="),
    assignment("npmAuthToken", ["npm", "_", "abcdefghijklmnopqrstuvwxyz012345"].join(""), ": "),
    assignment("auth", "dXNlcjpwYXNzd29yZA=="),
    assignment("apiToken", '"live-value-1234"', " = "),
    assignment("token", ["sk-", "a".repeat(24)].join(""), " = "),
  ];

  test.each(positiveContent)(
    "detects auth-bearing literal content before context or sandbox export",
    (content) => {
      expect(containsSecretShapedContent(Buffer.from(content))).toBe(true);
    },
  );

  test.each([
    "ordinary fixture text",
    "const token = parseToken(input);",
    "const token = token_123;",
    "token=tokenvalue",
    "token=placeholder",
    "password=notconfigured",
    'const password = "fixture-password-value";',
    'const password = "mock-password-value";',
    'const password = "redacted";',
    "NPM_TOKEN=NPM_TOKEN",
    "NPM_TOKEN=process.env.NPM_TOKEN",
    "password: string",
    "_authToken=" + "$" + "{NPM_TOKEN}",
    "DATABASE_PASSWORD=DATABASE_PASSWORD",
    "Authorization: Bearer " + "$" + "{ACCESS_TOKEN}",
    'const sampleToken = "test-token-value";',
    "const passwordHash = hash(password);",
    "token: response.token",
    'token_type: "bearer"',
    'token_url: "https://example.test/oauth/token"',
    'private_key_id: "0123456789abcdef"',
    'credential_type: "service_account"',
    "password: z.string().min(12)",
  ])(
    "does not classify reference, placeholder, metadata, or ordinary code %s as credentials",
    (content) => {
      expect(containsSecretShapedContent(Buffer.from(content))).toBe(false);
    },
  );

  test("scans a maximum-size unterminated credential line without throwing or recursion", () => {
    const prefix = Buffer.from(assignment("password", '"'));
    const suspicious = Buffer.concat([
      prefix,
      Buffer.alloc(MAX_TRACKED_TREE_FILE_BYTES - prefix.length, 0x61),
    ]);
    expect(suspicious).toHaveLength(MAX_TRACKED_TREE_FILE_BYTES);
    expect(containsSecretShapedContent(suspicious)).toBe(true);

    const ordinary = Buffer.alloc(MAX_TRACKED_TREE_FILE_BYTES, 0x61);
    expect(containsSecretShapedContent(ordinary)).toBe(false);
  });

  test("fails closed across an unterminated private-key body", () => {
    const privateKeyBody = credentialValue("unterminated-private-key-body");
    const privateKey = [
      "-----BEGIN ",
      "PRIVATE KEY-----\n",
      privateKeyBody,
      "\ntrailing private material",
    ].join("");
    expect(containsSecretShapedContent(Buffer.from(privateKey))).toBe(true);

    const result = sanitizeText(`prefix ${privateKey}`);
    expect(result).toBe("prefix <redacted:private-key>");
    expect(result).not.toContain(privateKeyBody);
    expect(result).not.toContain("trailing private material");
  });

  test("bounds dense scanner and known-secret span accumulation", () => {
    const credential = credentialValue("dense");
    const segment = `${assignment("password", credential)};`;
    const denseAssignments = segment
      .repeat(Math.ceil(MAX_TRACKED_TREE_FILE_BYTES / segment.length))
      .slice(0, MAX_TRACKED_TREE_FILE_BYTES);
    expect(denseAssignments).toHaveLength(MAX_TRACKED_TREE_FILE_BYTES);
    expect(containsSecretShapedContent(Buffer.from(denseAssignments))).toBe(true);
    expect(sanitizeText(denseAssignments)).not.toContain(credential);

    const denseKnownSecrets = credential.repeat(8_192);
    expect(sanitizeText(denseKnownSecrets, [credential])).not.toContain(credential);
  });

  test("redacts scanner credentials even when known secrets overlap their assignment keys", () => {
    const authorizationCredential = credentialValue("authorization-overlap");
    const passwordCredential = credentialValue("password-overlap");
    const input = [
      assignment("Authorization", `Bearer ${authorizationCredential}`, ": "),
      assignment("PASSWORD", passwordCredential),
    ].join("\n");

    const result = sanitizeText(input, ["Authorization", "PASSWORD"]);

    expect(result).not.toContain(authorizationCredential);
    expect(result).not.toContain(passwordCredential);
    expect(result).toContain("<redacted:authorization>");
    expect(result).toContain("<redacted:credential>");
  });

  test.each(["postgres", "redis"])(
    "detects and redacts credentialed %s data-source URLs",
    (scheme) => {
      const username = `${scheme}-user`;
      const password = credentialValue(`${scheme}-dsn`);
      const dsn = [scheme, "://", username, ":", password, "@database.internal:5432/app"].join("");

      expect(containsSecretShapedContent(Buffer.from(dsn))).toBe(true);
      const result = sanitizeText(dsn);
      expect(result).toContain("<redacted:credentialed-url>");
      expect(result).not.toContain(username);
      expect(result).not.toContain(password);
      expect(result).not.toContain(String.fromCharCode(0x1b));
    },
  );

  test("sanitizes a maximum-size sequence of unterminated OSC controls in bounded space", () => {
    const oscPrefix = `${String.fromCharCode(0x1b)}]8;;unterminated`;
    const input = oscPrefix
      .repeat(Math.ceil(MAX_TRACKED_TREE_FILE_BYTES / oscPrefix.length))
      .slice(0, MAX_TRACKED_TREE_FILE_BYTES);

    expect(input).toHaveLength(MAX_TRACKED_TREE_FILE_BYTES);
    const result = sanitizeText(input);
    expect(result).toBe("<escaped-control>");
    expect(result).not.toContain(String.fromCharCode(0x1b));
  });

  test("redacts known and scanner-recognized credentials with constant markers", () => {
    const key = ["sk-", "b".repeat(24)].join("");
    const shortSecret = String.fromCharCode(113, 55, 33);
    const npmSecret = credentialValue("npm");
    const bearerSecret = credentialValue("bearer");
    const result = sanitizeText(
      [
        "before",
        key,
        "secret-value",
        shortSecret,
        assignment("NPM_TOKEN", npmSecret),
        assignment("Authorization", `Bearer ${bearerSecret}`, ": "),
        "\u0000after",
      ].join(" "),
      ["secret-value", shortSecret],
    );

    for (const secret of [key, "secret-value", shortSecret, npmSecret, bearerSecret]) {
      expect(result).not.toContain(secret);
    }
    expect(result).not.toContain("\u0000");
    expect(result).toContain("<redacted:token>");
    expect(result).toContain("<redacted:known-secret>");
    expect(result).toContain("<redacted:credential>");
    expect(result).not.toMatch(/<redacted:[^>]+:[a-f0-9]{12}>/);

    const authorizationResult = sanitizeText(
      assignment("Authorization", `Bearer ${bearerSecret}`, ": "),
    );
    expect(authorizationResult).not.toContain(bearerSecret);
    expect(authorizationResult).toContain("<redacted:authorization>");
    expect(sanitizeText("\u0000after")).toContain("<escaped-control>");
  });

  test.each(["maxActiveRuntimeMs", "providerTimeoutMs", "commandTimeoutMs"] as const)(
    "rejects timer-facing ceiling %s above the Node timer range",
    (field) => {
      expect(() =>
        assertSunCeiling({
          ...DEFAULT_CEILING,
          [field]: 2_147_483_648,
        }),
      ).toThrow(expect.objectContaining({ code: "INVALID_CEILING" }));
    },
  );

  test.each(["id", "name"] as const)(
    "rejects secret-shaped check %s metadata without echoing it",
    (field) => {
      const secret = ["sk-", "a".repeat(24)].join("");
      try {
        assertCheckProfiles([
          {
            id: field === "id" ? secret : "verify",
            name: field === "name" ? secret : "Synthetic verification",
            argv: ["synthetic-check"],
          },
        ]);
        throw new Error("Expected secret-shaped check metadata rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(IcarusError);
        expect(error).toEqual(expect.objectContaining({ code: "CHECK_SECRET_DETECTED" }));
        expect((error as Error).message).not.toContain(secret);
      }
    },
  );

  test("materializes a content-safe .npmrc in the no-network sandbox", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "icarus-safe-npmrc-snapshot-"));
    const target = "src/greeting.txt";
    const targetObjectId = "1".repeat(40);
    const npmrcObjectId = "2".repeat(40);
    const tree: readonly TreeEntry[] = [
      { mode: "100644", type: "blob", objectId: targetObjectId, path: target },
      { mode: "100644", type: "blob", objectId: npmrcObjectId, path: ".npmrc" },
    ];
    const npmrc = "engine-strict=true\nsave-exact=true\n";
    const fakeGit = {
      async listTree(): Promise<readonly TreeEntry[]> {
        return tree;
      },
      async readRegularUtf8File(): Promise<string> {
        return "ordinary target text\n";
      },
      async readBlob(_repository: string, objectId: string): Promise<Buffer> {
        if (objectId !== npmrcObjectId) throw new Error("Unexpected sandbox blob");
        return Buffer.from(npmrc);
      },
    } as unknown as GitController;

    try {
      const docker = await createRecordingDocker(root, { observePaths: [".npmrc"] });
      const runner = new DockerSandboxRunner(root, fakeGit, docker.binary);
      const evidence = await runner.runChecks({
        runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        worktreePath: path.join(root, "worktree"),
        baseCommit: "b".repeat(40),
        target,
        checks: [{ id: "verify", name: "Verify", argv: ["node", "--version"] }],
        sandbox: {
          image: `node:test@sha256:${"c".repeat(64)}`,
          ...DEFAULT_SANDBOX_LIMITS,
        },
        ceiling: DEFAULT_CEILING,
      });

      expect(evidence).toEqual([expect.objectContaining({ outcome: "passed" })]);
      const runCall = (await docker.calls()).find((call) => call.argv[0] === "run");
      expect(runCall?.snapshot?.entries[".npmrc"]).toEqual(
        expect.objectContaining({ content: npmrc, mode: 0o444 }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("discards credential bytes before sandbox snapshot materialization", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "icarus-secret-snapshot-"));
    const secret = credentialValue("snapshot");
    const target = "src/greeting.txt";
    const targetObjectId = "1".repeat(40);
    const secretObjectId = "2".repeat(40);
    const tree: readonly TreeEntry[] = [
      { mode: "100644", type: "blob", objectId: targetObjectId, path: target },
      { mode: "100644", type: "blob", objectId: secretObjectId, path: "docs/runtime-notes.txt" },
    ];
    const fakeGit = {
      async listTree(): Promise<readonly TreeEntry[]> {
        return tree;
      },
      async readRegularUtf8File(): Promise<string> {
        return "ordinary target text\n";
      },
      async readBlob(_repository: string, objectId: string): Promise<Buffer> {
        if (objectId !== secretObjectId) throw new Error("Unexpected sandbox blob");
        return Buffer.from(`${assignment("NPM_TOKEN", secret)}\n`);
      },
    } as unknown as GitController;

    try {
      const docker = await createRecordingDocker(root);
      const runner = new DockerSandboxRunner(root, fakeGit, docker.binary);
      const evidence = await runner.runChecks({
        runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        worktreePath: path.join(root, "worktree"),
        baseCommit: "b".repeat(40),
        target,
        checks: [{ id: "verify", name: "Verify", argv: ["node", "--version"] }],
        sandbox: {
          image: `node:test@sha256:${"c".repeat(64)}`,
          ...DEFAULT_SANDBOX_LIMITS,
        },
        ceiling: DEFAULT_CEILING,
      });

      expect(evidence).toEqual([
        expect.objectContaining({
          outcome: "unavailable",
          stderr: expect.stringContaining("Secret-shaped tracked content is denied"),
        }),
      ]);
      expect((await docker.calls()).some((call) => call.argv[0] === "run")).toBe(false);
      expect(await treeContains(root, Buffer.from(secret))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
