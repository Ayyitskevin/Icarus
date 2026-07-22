import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  validateNativeAcceptanceWorkflow,
  validateNativeHost,
} from "../../scripts/native-acceptance-policy.mjs";

const workflowPath = new URL("../../.github/workflows/native-acceptance.yml", import.meta.url);

async function workflow(): Promise<string> {
  return readFile(workflowPath, "utf8");
}

describe("native acceptance workflow policy", () => {
  it("accepts the reviewed exact manual portable lane", async () => {
    const result = validateNativeAcceptanceWorkflow(await workflow());

    expect(result.runners).toEqual(["macos-15", "windows-2025"]);
    expect(result.actions).toEqual([
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      "pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271",
      "actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e",
    ]);
    expect(result.commands).toBe(11);
  });

  it("rejects a mutable action reference before hosted execution", async () => {
    const changed = (await workflow()).replace(
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      "actions/checkout@v7",
    );

    expect(() => validateNativeAcceptanceWorkflow(changed)).toThrow(
      "actions must match the reviewed immutable commit pins",
    );
  });

  it("rejects widened token permissions", async () => {
    const changed = (await workflow()).replace("contents: read", "contents: write");

    expect(() => validateNativeAcceptanceWorkflow(changed)).toThrow(
      "must remain manual and read-only",
    );
  });

  it("rejects automatic triggers and secret references", async () => {
    const automatic = (await workflow()).replace(
      "  workflow_dispatch:\n",
      "  workflow_dispatch:\n  pull_request:\n",
    );
    const secretBearing = (await workflow()).replace(
      "    steps:\n",
      `    env:\n      TOKEN: \${{ secrets.NATIVE_TOKEN }}\n    steps:\n`,
    );

    expect(() => validateNativeAcceptanceWorkflow(automatic)).toThrow(
      "forbidden automatic or privileged trigger",
    );
    expect(() => validateNativeAcceptanceWorkflow(secretBearing)).toThrow(
      "forbidden secret reference",
    );
  });

  it("rejects Linux-only or widened release commands", async () => {
    const changed = (await workflow()).replace("run: pnpm build", "run: pnpm check");

    expect(() => validateNativeAcceptanceWorkflow(changed)).toThrow(
      "forbidden Linux-only or out-of-scope command",
    );
  });

  it("rejects shared Actions cache enablement", async () => {
    const changed = (await workflow()).replace(
      "          node-version: 22.23.0",
      "          cache: pnpm\n          node-version: 22.23.0",
    );

    expect(() => validateNativeAcceptanceWorkflow(changed)).toThrow(
      "forbidden shared cache mutation",
    );
  });

  it("rejects runner drift and otherwise harmless byte drift", async () => {
    const runnerDrift = (await workflow()).replace("os: macos-15", "os: macos-latest");
    const byteDrift = `${await workflow()}# unreviewed drift\n`;

    expect(() => validateNativeAcceptanceWorkflow(runnerDrift)).toThrow(
      "must retain the exact macOS and Windows host matrix",
    );
    expect(() => validateNativeAcceptanceWorkflow(byteDrift)).toThrow("workflow digest mismatch");
  });
});

describe("native host attestation policy", () => {
  const darwin = {
    architecture: "arm64",
    configuredArchitecture: "arm64",
    configuredPlatform: "darwin",
    nodeVersion: "22.23.0",
    platform: "darwin",
    userAgent: "pnpm/9.15.4 npm/? node/v22.23.0 darwin arm64",
  };

  it("accepts only the exact declared native identities", () => {
    expect(validateNativeHost(darwin)).toEqual({
      architecture: "arm64",
      platform: "darwin",
      runner: "macos-15",
    });
    expect(
      validateNativeHost({
        ...darwin,
        architecture: "x64",
        configuredArchitecture: "x64",
        configuredPlatform: "win32",
        platform: "win32",
      }),
    ).toEqual({ architecture: "x64", platform: "win32", runner: "windows-2025" });
  });

  it("rejects Linux, matrix mismatch, architecture drift, and toolchain drift", () => {
    expect(() =>
      validateNativeHost({ ...darwin, configuredPlatform: "linux", platform: "linux" }),
    ).toThrow("supports only darwin or win32");
    expect(() => validateNativeHost({ ...darwin, configuredPlatform: "win32" })).toThrow(
      "native host identity mismatch",
    );
    expect(() =>
      validateNativeHost({
        ...darwin,
        architecture: "x64",
        configuredArchitecture: "x64",
      }),
    ).toThrow("native runner architecture drifted");
    expect(() => validateNativeHost({ ...darwin, nodeVersion: "22.23.1" })).toThrow(
      "native Node.js version drifted",
    );
    expect(() => validateNativeHost({ ...darwin, userAgent: "pnpm/9.15.5 npm/?" })).toThrow(
      "native pnpm version drifted",
    );
  });
});
