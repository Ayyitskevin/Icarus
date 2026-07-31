import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { startWorkspaceServerWithBindingHooks } from "../../packages/api/src/server.js";
import { createIcarusRuntime, type IcarusRuntime } from "../../packages/core/src/index.js";

const cleanups: Array<() => Promise<void>> = [];
let root: string;
let runtime: IcarusRuntime;
let options: {
  readonly runtime: IcarusRuntime;
  readonly stateRoot: string;
  readonly workspaceDist: string;
};

function errno(code: string): Error {
  return Object.assign(new Error(`forced ${code}`), { code });
}

async function listen(server: Server, port: number, host: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "icarus-binding-test-"));
  const stateRoot = path.join(root, "state");
  const workspaceDist = path.join(root, "workspace");
  await mkdir(workspaceDist);
  await writeFile(path.join(workspaceDist, "index.html"), "<!doctype html>");
  runtime = await createIcarusRuntime(stateRoot);
  options = { runtime, stateRoot, workspaceDist };
  cleanups.push(async () => {
    runtime.close();
    await rm(root, { recursive: true, force: true });
  });
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("workspace exact binding", () => {
  test.each(["EADDRNOTAVAIL", "EINVAL"])(
    "falls back once without a bearer when a fresh loopback bind returns %s",
    async (code) => {
      const calls: Array<{ readonly port: number; readonly host: string }> = [];
      const workspace = await startWorkspaceServerWithBindingHooks(options, 0, {
        createMutationHostname: () => "127.31.32.33",
        listen: async (server, port, host) => {
          calls.push({ port, host });
          if (calls.length === 1) throw errno(code);
          await listen(server, port, host);
        },
      });
      cleanups.push(workspace.close);

      expect(calls).toEqual([
        { port: 0, host: "127.31.32.33" },
        { port: 0, host: "127.0.0.1" },
      ]);
      expect(workspace).toMatchObject({
        host: "127.0.0.1",
        mode: "review-only",
        reviewOnlyReason: "fresh-loopback-unavailable",
      });
      expect(new URL(workspace.launchUrl).hash).toBe("");

      const snapshot = (await (await fetch(`${workspace.url}/api/workspace`)).json()) as Record<
        string,
        unknown
      >;
      expect(snapshot).toMatchObject({
        capabilities: {
          mutation: {
            status: "review_only",
            reason:
              "This platform could not bind a fresh numeric-loopback origin, so this workspace is review-only.",
          },
        },
      });
      const rejected = await fetch(`${workspace.url}/api/future-mutation`, {
        method: "POST",
        body: "{",
      });
      expect(rejected.status).toBe(403);
      expect(await rejected.json()).toMatchObject({
        error: { code: "WORKSPACE_REVIEW_ONLY" },
      });
      expect(runtime.service.listProjects()).toEqual([]);
    },
  );

  test.each(["EADDRINUSE", "EPERM"])("does not fall back for %s", async (code) => {
    const failure = errno(code);
    let calls = 0;
    await expect(
      startWorkspaceServerWithBindingHooks(options, 0, {
        createMutationHostname: () => "127.41.42.43",
        listen: async () => {
          calls += 1;
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
    expect(calls).toBe(1);
  });

  test("propagates a failed review-only fallback without leaving a listener", async () => {
    const fallbackFailure = errno("EACCES");
    let calls = 0;
    let fallbackPort = 0;
    await expect(
      startWorkspaceServerWithBindingHooks(options, 0, {
        createMutationHostname: () => "127.51.52.53",
        listen: async (server, port, host) => {
          calls += 1;
          if (calls === 1) throw errno("EADDRNOTAVAIL");
          await listen(server, port, host);
          const address = server.address();
          if (address === null || typeof address === "string") {
            throw new Error("fallback test listener did not expose an IP address");
          }
          fallbackPort = address.port;
          throw fallbackFailure;
        },
      }),
    ).rejects.toBe(fallbackFailure);
    expect(calls).toBe(2);
    expect(fallbackPort).toBeGreaterThan(0);

    const probe = createServer();
    await listen(probe, fallbackPort, "127.0.0.1");
    await new Promise<void>((resolve, reject) =>
      probe.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  });

  test.each([
    { actualHost: "127.0.0.1", expectedFamily: "IPv4" },
    { actualHost: "::1", expectedFamily: "IPv6" },
  ])(
    "closes a mismatched $expectedFamily listener before creating a session",
    async ({ actualHost }) => {
      let observedPort = 0;
      await expect(
        startWorkspaceServerWithBindingHooks(options, 0, {
          createMutationHostname: () => "127.61.62.63",
          listen: async (server, port) => {
            await listen(server, port, actualHost);
            const address = server.address();
            if (address === null || typeof address === "string") {
              throw new Error("test listener did not expose an IP address");
            }
            observedPort = address.port;
          },
        }),
      ).rejects.toMatchObject({ code: "UNSAFE_BINDING" });
      expect(observedPort).toBeGreaterThan(0);

      const probe = createServer();
      await listen(probe, observedPort, actualHost);
      await new Promise<void>((resolve, reject) =>
        probe.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    },
  );

  test("rejects an invalid generated host before any listen attempt", async () => {
    let listened = false;
    await expect(
      startWorkspaceServerWithBindingHooks(options, 0, {
        createMutationHostname: () => "192.0.2.1",
        listen: async () => {
          listened = true;
        },
      }),
    ).rejects.toMatchObject({ code: "INVALID_ORIGIN" });
    expect(listened).toBe(false);
  });
});
