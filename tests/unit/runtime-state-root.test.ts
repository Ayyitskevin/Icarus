import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { IcarusError } from "../../packages/core/src/errors.js";
import {
  assertRegistrationStateSeparation,
  createIcarusRuntime,
} from "../../packages/core/src/runtime.js";

const temporaryRoots: string[] = [];

async function makeTemporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "icarus-unit-root-"));
  temporaryRoots.push(root);
  return root;
}

async function expectUnsafe(action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
    throw new Error("Expected unsafe state root rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(IcarusError);
    expect((error as IcarusError).code).toBe("UNSAFE_STATE_ROOT");
  }
}

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("state-root ownership boundary", () => {
  it("creates a dedicated private root and safely reopens its marker", async () => {
    const parent = await makeTemporaryRoot();
    const stateRoot = path.join(parent, "state");

    const first = await createIcarusRuntime(stateRoot);
    first.close();
    expect(await readFile(path.join(stateRoot, ".icarus-state-v1"), "utf8")).toBe(
      '{"application":"icarus","format":1}\n',
    );
    expect((await lstat(stateRoot)).mode & 0o077).toBe(0);
    expect((await lstat(path.join(stateRoot, ".icarus-state-v1"))).mode & 0o077).toBe(0);

    const reopened = await createIcarusRuntime(stateRoot);
    reopened.close();
  });

  it("rejects preexisting nonempty, permissive, and symlinked roots", async () => {
    const parent = await makeTemporaryRoot();

    const nonempty = path.join(parent, "nonempty");
    await mkdir(nonempty, { mode: 0o700 });
    await writeFile(path.join(nonempty, "foreign"), "not Icarus");
    await expectUnsafe(() => createIcarusRuntime(nonempty));

    const permissive = path.join(parent, "permissive");
    await mkdir(permissive, { mode: 0o700 });
    await chmod(permissive, 0o755);
    await expectUnsafe(() => createIcarusRuntime(permissive));

    const real = path.join(parent, "real");
    const linked = path.join(parent, "linked");
    await mkdir(real, { mode: 0o700 });
    await symlink(real, linked);
    await expectUnsafe(() => createIcarusRuntime(linked));
  });

  it("confines Windows state beneath the current user profile", async () => {
    const parent = await makeTemporaryRoot();
    const profile = path.join(parent, "profile");
    const stateRoot = path.join(profile, "windows-state");
    const outsideState = path.join(parent, "outside-state");
    await mkdir(profile, { mode: 0o700 });
    await mkdir(stateRoot, { mode: 0o755 });
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
    if (platformDescriptor === undefined) throw new Error("process.platform descriptor is missing");
    const homedir = vi.spyOn(os, "homedir").mockReturnValue(profile);
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });

    try {
      await expect(createIcarusRuntime(outsideState)).rejects.toMatchObject({
        code: "UNSAFE_STATE_ROOT",
      });
      await expect(lstat(outsideState)).rejects.toMatchObject({ code: "ENOENT" });
      const first = await createIcarusRuntime(stateRoot);
      first.close();
      expect(await readFile(path.join(stateRoot, ".icarus-state-v1"), "utf8")).toBe(
        '{"application":"icarus","format":1}\n',
      );
      const reopened = await createIcarusRuntime(stateRoot);
      reopened.close();
    } finally {
      Object.defineProperty(process, "platform", platformDescriptor);
      homedir.mockRestore();
    }
  });

  it("rejects a state root reached through a symlinked parent", async () => {
    const parent = await makeTemporaryRoot();
    const realParent = path.join(parent, "real-parent");
    const linkedParent = path.join(parent, "linked-parent");
    await mkdir(realParent, { mode: 0o700 });
    await symlink(realParent, linkedParent);

    await expectUnsafe(() => createIcarusRuntime(path.join(linkedParent, "state")));
  });

  it("detects a prospective state root inside a repository through a symlink alias", async () => {
    const parent = await makeTemporaryRoot();
    const repository = path.join(parent, "repository");
    const alias = path.join(parent, "repository-alias");
    const nestedState = path.join(alias, ".state");
    await mkdir(repository, { mode: 0o700 });
    await mkdir(path.join(repository, ".git"), { mode: 0o700 });
    await symlink(repository, alias);

    await expect(createIcarusRuntime(nestedState)).rejects.toMatchObject({
      code: "STATE_REPOSITORY_OVERLAP",
    });
    await expect(lstat(path.join(repository, ".state"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(assertRegistrationStateSeparation(nestedState, repository)).rejects.toMatchObject({
      code: "STATE_REPOSITORY_OVERLAP",
    });
    await expect(lstat(path.join(repository, ".state"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
