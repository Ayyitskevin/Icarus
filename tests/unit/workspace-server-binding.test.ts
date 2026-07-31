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
  test("binds exact 127.0.0.1 before creating the random public origin", async () => {
    const calls: Array<{ readonly port: number; readonly host: string }> = [];
    const order: string[] = [];
    const originHostname = "0123456789abcdef0123456789abcdef.localhost";
    const workspace = await startWorkspaceServerWithBindingHooks(options, 0, {
      createMutationHostname: () => {
        order.push("origin");
        return originHostname;
      },
      listen: async (server, port, host) => {
        calls.push({ port, host });
        await listen(server, port, host);
        order.push("bound");
      },
    });
    cleanups.push(workspace.close);

    expect(calls).toEqual([{ port: 0, host: "127.0.0.1" }]);
    expect(order).toEqual(["bound", "origin"]);
    expect(workspace).toMatchObject({
      host: "127.0.0.1",
      mode: "mutation-capable",
      reviewOnlyReason: null,
      url: `http://${originHostname}:${workspace.port}`,
    });
    expect(workspace.server.address()).toMatchObject({
      address: "127.0.0.1",
      family: "IPv4",
      port: workspace.port,
    });
    expect(workspace.launchUrl).toMatch(
      new RegExp(
        `^http://${originHostname.replaceAll(".", "\\.")}:${workspace.port}/#icarus-action-session=[A-Za-z0-9_-]{43}$`,
      ),
    );
  });

  test.each(["EADDRNOTAVAIL", "EINVAL", "EADDRINUSE", "EPERM"])(
    "propagates %s without fallback or origin creation",
    async (code) => {
      const failure = errno(code);
      let calls = 0;
      let originCreated = false;
      await expect(
        startWorkspaceServerWithBindingHooks(options, 0, {
          createMutationHostname: () => {
            originCreated = true;
            return "0123456789abcdef0123456789abcdef.localhost";
          },
          listen: async (_server, port, host) => {
            calls += 1;
            expect({ port, host }).toEqual({ port: 0, host: "127.0.0.1" });
            throw failure;
          },
        }),
      ).rejects.toBe(failure);
      expect(calls).toBe(1);
      expect(originCreated).toBe(false);
    },
  );

  test("closes a listener when the listen hook fails after binding", async () => {
    const failure = errno("EACCES");
    let observedPort = 0;
    let originCreated = false;
    await expect(
      startWorkspaceServerWithBindingHooks(options, 0, {
        createMutationHostname: () => {
          originCreated = true;
          return "0123456789abcdef0123456789abcdef.localhost";
        },
        listen: async (server, port, host) => {
          await listen(server, port, host);
          const address = server.address();
          if (address === null || typeof address === "string") {
            throw new Error("test listener did not expose an IP address");
          }
          observedPort = address.port;
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
    expect(originCreated).toBe(false);
    expect(observedPort).toBeGreaterThan(0);

    const probe = createServer();
    await listen(probe, observedPort, "127.0.0.1");
    await new Promise<void>((resolve, reject) =>
      probe.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  });

  test.each([
    { actualHost: "0.0.0.0", expectedFamily: "IPv4" },
    { actualHost: "::1", expectedFamily: "IPv6" },
  ])(
    "closes a mismatched $expectedFamily listener before creating an origin",
    async ({ actualHost }) => {
      let observedPort = 0;
      let originCreated = false;
      await expect(
        startWorkspaceServerWithBindingHooks(options, 0, {
          createMutationHostname: () => {
            originCreated = true;
            return "0123456789abcdef0123456789abcdef.localhost";
          },
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
      expect(originCreated).toBe(false);
      expect(observedPort).toBeGreaterThan(0);

      const probe = createServer();
      await listen(probe, observedPort, actualHost);
      await new Promise<void>((resolve, reject) =>
        probe.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    },
  );

  test("rejects an invalid generated origin after binding and closes the listener", async () => {
    let observedPort = 0;
    let originObservedBoundServer = false;
    await expect(
      startWorkspaceServerWithBindingHooks(options, 0, {
        createMutationHostname: () => {
          originObservedBoundServer = observedPort > 0;
          return "192.0.2.1";
        },
        listen: async (server, port, host) => {
          await listen(server, port, host);
          const address = server.address();
          if (address === null || typeof address === "string") {
            throw new Error("test listener did not expose an IP address");
          }
          observedPort = address.port;
        },
      }),
    ).rejects.toMatchObject({ code: "INVALID_ORIGIN" });
    expect(originObservedBoundServer).toBe(true);
    expect(observedPort).toBeGreaterThan(0);

    const probe = createServer();
    await listen(probe, observedPort, "127.0.0.1");
    await new Promise<void>((resolve, reject) =>
      probe.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  });

  test("keeps an explicit port on stable 127.0.0.1 in bearer-free review-only mode", async () => {
    const reservation = createServer();
    await listen(reservation, 0, "127.0.0.1");
    const reservedAddress = reservation.address();
    if (reservedAddress === null || typeof reservedAddress === "string") {
      throw new Error("port reservation did not expose an IP address");
    }
    const explicitPort = reservedAddress.port;
    await new Promise<void>((resolve, reject) =>
      reservation.close((error) => (error === undefined ? resolve() : reject(error))),
    );

    let originCreated = false;
    const workspace = await startWorkspaceServerWithBindingHooks(options, explicitPort, {
      createMutationHostname: () => {
        originCreated = true;
        return "0123456789abcdef0123456789abcdef.localhost";
      },
      listen,
    });
    cleanups.push(workspace.close);

    expect(originCreated).toBe(false);
    expect(workspace).toMatchObject({
      host: "127.0.0.1",
      port: explicitPort,
      mode: "review-only",
      reviewOnlyReason: "explicit-port",
      url: `http://127.0.0.1:${explicitPort}`,
      launchUrl: `http://127.0.0.1:${explicitPort}`,
    });
    expect(new URL(workspace.launchUrl).hash).toBe("");
  });
});
