import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  type StartedWorkspaceServer,
  startWorkspaceServer,
} from "../../packages/api/src/server.js";
import { isFreshWorkspaceLoopbackHostname } from "../../packages/api/src/workspace-session.js";
import { createIcarusRuntime, type IcarusRuntime } from "../../packages/core/src/index.js";

const cleanups: Array<() => Promise<void>> = [];

function actionSession(server: StartedWorkspaceServer): string {
  const launch = new URL(server.launchUrl);
  const match = /^#icarus-action-session=([A-Za-z0-9_-]{43})$/.exec(launch.hash);
  if (server.mode !== "mutation-capable" || launch.origin !== server.url || match === null) {
    throw new Error("native workspace did not expose one canonical mutation session");
  }
  return match[1] ?? "";
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("native portable numeric-loopback origin", () => {
  test("binds, fetches, coexists with stable review, and rejects an old bearer", async () => {
    const root = await mkdtemp(path.join(os.homedir(), ".icarus-native-origin-"));
    cleanups.push(async () => rm(root, { recursive: true, force: true }));
    const stateRoot = path.join(root, "state");
    const workspaceDist = path.join(root, "workspace");
    await mkdir(workspaceDist);
    await writeFile(path.join(workspaceDist, "index.html"), "<!doctype html>");
    const runtime: IcarusRuntime = await createIcarusRuntime(stateRoot);
    cleanups.push(async () => runtime.close());
    const options = { runtime, stateRoot, workspaceDist };

    const first = await startWorkspaceServer(options, 0);
    cleanups.push(first.close);
    expect(isFreshWorkspaceLoopbackHostname(first.host)).toBe(true);
    expect(first.mode).toBe("mutation-capable");
    expect(first.reviewOnlyReason).toBeNull();
    expect(first.server.address()).toMatchObject({
      address: first.host,
      family: "IPv4",
      port: first.port,
    });
    expect((await fetch(`${first.url}/api/health`)).status).toBe(200);
    const firstToken = actionSession(first);

    const stable = await startWorkspaceServer(options, first.port);
    cleanups.push(stable.close);
    expect(stable).toMatchObject({
      host: "127.0.0.1",
      port: first.port,
      mode: "review-only",
      reviewOnlyReason: "explicit-port",
      launchUrl: `http://127.0.0.1:${first.port}`,
    });
    expect((await fetch(`${stable.url}/api/health`)).status).toBe(200);
    await expect(startWorkspaceServer(options, first.port)).rejects.toMatchObject({
      code: "EADDRINUSE",
    });

    await first.close();
    const second = await startWorkspaceServer(options, 0);
    cleanups.push(second.close);
    expect(isFreshWorkspaceLoopbackHostname(second.host)).toBe(true);
    const secondToken = actionSession(second);
    expect(secondToken).not.toBe(firstToken);

    const stale = await fetch(`${second.url}/api/future-mutation`, {
      method: "POST",
      headers: {
        origin: second.url,
        authorization: `Bearer ${firstToken}`,
        "content-type": "application/json",
        "x-icarus-action": "workspace.mutate",
      },
      body: "{}",
    });
    expect(stale.status).toBe(401);
    expect(await stale.json()).toMatchObject({
      error: { code: "ACTION_SESSION_REQUIRED" },
    });
  });
});
