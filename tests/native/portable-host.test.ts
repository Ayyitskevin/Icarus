import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createIcarusRuntime } from "../../packages/core/src/runtime.js";

const expectedPlatform = process.env.ICARUS_NATIVE_EXPECTED_PLATFORM;
const expectedArchitecture = process.env.ICARUS_NATIVE_EXPECTED_ARCHITECTURE;
const cleanupRoots: string[] = [];

afterEach(async () => {
  for (const root of cleanupRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("native portable host boundary", () => {
  it("runs only on the explicitly declared macOS or Windows host", () => {
    expect(["darwin", "win32"]).toContain(expectedPlatform);
    expect(process.platform).toBe(expectedPlatform);
    expect(process.arch).toBe(expectedArchitecture);
    expect(process.versions.node).toBe("22.23.0");
    expect(process.env.npm_config_user_agent).toMatch(/^pnpm\/9\.15\.4 /);
  });

  it("creates and reopens a real native state root beneath the user profile", async () => {
    const parent = await mkdtemp(path.join(os.homedir(), ".icarus-native-acceptance-"));
    cleanupRoots.push(parent);
    const stateRoot = path.join(parent, "state");

    const first = await createIcarusRuntime(stateRoot);
    first.close();
    expect(await readFile(path.join(stateRoot, ".icarus-state-v1"), "utf8")).toBe(
      '{"application":"icarus","format":1}\n',
    );

    const reopened = await createIcarusRuntime(stateRoot);
    reopened.close();
  });
});
