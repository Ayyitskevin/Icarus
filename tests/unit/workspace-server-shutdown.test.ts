import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  type StartedWorkspaceServer,
  startWorkspaceServer,
} from "../../packages/api/src/server.js";
import {
  browserActionDescriptorDigest,
  type IcarusRuntime,
} from "../../packages/core/src/index.js";
import { fetchWorkspace } from "../support/workspace-http.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve = (_value: T): void => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

interface ShutdownFixture {
  readonly root: string;
  readonly workspace: StartedWorkspaceServer;
}

const fixtures: ShutdownFixture[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0).reverse()) {
    await fixture.workspace.close().catch(() => undefined);
    await rm(fixture.root, { recursive: true, force: true });
  }
});

interface ShutdownFixtureOptions {
  readonly service?: Readonly<Record<string, unknown>>;
  readonly operatorActor?: string;
}

async function startShutdownFixture(
  previewProjectContext: (projectId: string, target: string) => Promise<unknown>,
  configuration: ShutdownFixtureOptions = {},
): Promise<ShutdownFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "icarus-shutdown-test-"));
  const workspaceDist = path.join(root, "workspace");
  await mkdir(workspaceDist);
  await writeFile(path.join(workspaceDist, "index.html"), "<!doctype html>");
  const runtime = {
    service: {
      previewProjectContext,
      reconcileBrowserActionRequests: () => undefined,
      settledBrowserActionReplay: () => null,
      ...(configuration.service ?? {}),
    },
    close: () => undefined,
  } as unknown as IcarusRuntime;
  const workspace = await startWorkspaceServer(
    {
      runtime,
      stateRoot: path.join(root, "state"),
      workspaceDist,
      ...(configuration.operatorActor === undefined
        ? {}
        : { operatorActor: configuration.operatorActor }),
    },
    0,
  );
  const fixture = { root, workspace };
  fixtures.push(fixture);
  return fixture;
}

function mutationHeaders(workspace: StartedWorkspaceServer): Record<string, string> {
  const launch = new URL(workspace.launchUrl);
  const token = /^#icarus-action-session=([A-Za-z0-9_-]{43})$/.exec(launch.hash)?.[1];
  if (token === undefined) throw new Error("Mutation workspace did not expose an action session");
  return {
    origin: workspace.url,
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "x-icarus-action": "workspace.mutate",
  };
}

function previewRequest(workspace: StartedWorkspaceServer): Promise<Response> {
  return fetchWorkspace(workspace, `${workspace.url}/api/projects/project/context-preview`, {
    method: "POST",
    headers: mutationHeaders(workspace),
    body: '{"target":"src/example.ts"}',
  });
}

function rawPreviewRequest(
  workspace: StartedWorkspaceServer,
  connection: "keep-alive" | "close",
): string {
  const body = '{"target":"src/example.ts"}';
  const headers = mutationHeaders(workspace);
  const host = new URL(workspace.url).host;
  return [
    "POST /api/projects/project/context-preview HTTP/1.1",
    `Host: ${host}`,
    `Origin: ${headers.origin ?? ""}`,
    `Authorization: ${headers.authorization ?? ""}`,
    "Content-Type: application/json",
    `X-Icarus-Action: ${headers["x-icarus-action"] ?? ""}`,
    `Content-Length: ${Buffer.byteLength(body, "utf8")}`,
    `Connection: ${connection}`,
    "",
    body,
  ].join("\r\n");
}

function rawBrowserActionRequest(workspace: StartedWorkspaceServer): string {
  const runId = "11111111-1111-4111-8111-111111111111";
  const descriptor = {
    version: 1,
    kind: "run.cancel",
    runId,
    expectedState: "preparing",
    eventRevision: 1,
    subjectDigest: null,
    activeActionId: null,
    activeActionDigest: null,
  } as const;
  const body = JSON.stringify({
    actionId: "22222222-2222-4222-8222-222222222222",
    ...descriptor,
    actionDigest: browserActionDescriptorDigest(descriptor),
  });
  const headers = mutationHeaders(workspace);
  const host = new URL(workspace.url).host;
  return [
    `POST /api/runs/${runId}/actions HTTP/1.1`,
    `Host: ${host}`,
    `Origin: ${headers.origin ?? ""}`,
    `Authorization: ${headers.authorization ?? ""}`,
    "Content-Type: application/json",
    "X-Icarus-Action: run.cancel",
    `Content-Length: ${Buffer.byteLength(body, "utf8")}`,
    "Connection: close",
    "",
    body,
  ].join("\r\n");
}

async function connect(workspace: StartedWorkspaceServer): Promise<net.Socket> {
  const socket = net.createConnection({ host: workspace.host, port: workspace.port });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  return socket;
}

describe("workspace server shutdown", () => {
  test("memoizes close and waits for an in-flight handler without aborting it", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    let completed = false;
    const { workspace } = await startShutdownFixture(async () => {
      entered.resolve();
      await release.promise;
      completed = true;
      return { ok: true };
    });
    const request = previewRequest(workspace).catch(() => null);
    await entered.promise;

    const first = workspace.close();
    const second = workspace.close();
    expect(first).toBe(second);
    expect(workspace.server.listening).toBe(false);

    let closed = false;
    void first.then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(completed).toBe(false);

    release.resolve();
    await expect(first).resolves.toBeUndefined();
    expect(completed).toBe(true);
    await request;
  });

  test("waits for response finish after the handler has returned", async () => {
    const handlerEnded = deferred<void>();
    const releaseResponse = deferred<void>();
    const { workspace } = await startShutdownFixture(async () => ({ ok: true }));
    workspace.server.prependListener("request", (_request, response) => {
      const originalEnd = response.end.bind(response);
      response.end = ((
        chunk?: string | Uint8Array,
        encodingOrCallback?: BufferEncoding | (() => void),
        callback?: () => void,
      ) => {
        handlerEnded.resolve();
        void releaseResponse.promise.then(() => {
          if (typeof encodingOrCallback === "function") {
            originalEnd(chunk, encodingOrCallback);
          } else if (encodingOrCallback === undefined) {
            originalEnd(chunk);
          } else {
            originalEnd(chunk, encodingOrCallback, callback);
          }
        });
        return response;
      }) as typeof response.end;
    });
    const request = previewRequest(workspace);
    await handlerEnded.promise;

    const close = workspace.close();
    let closed = false;
    void close.then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);

    releaseResponse.resolve();
    await expect(request).resolves.toMatchObject({ status: 200 });
    await expect(close).resolves.toBeUndefined();
  });

  test("rejects close with the exact in-flight settlement failure", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const failure = new Error("forced response settlement failure");
    const { workspace } = await startShutdownFixture(async () => {
      entered.resolve();
      await release.promise;
      return { ok: true };
    });
    workspace.server.prependListener("request", (_request, response) => {
      response.writeHead = (() => {
        throw failure;
      }) as typeof response.writeHead;
    });
    const request = previewRequest(workspace).catch(() => null);
    await entered.promise;

    const close = workspace.close();
    release.resolve();

    let observed: unknown;
    try {
      await close;
    } catch (error) {
      observed = error;
    }
    expect(observed).toBeInstanceOf(AggregateError);
    expect((observed as AggregateError).message).toBe(
      "Workspace shutdown did not settle all active requests cleanly",
    );
    expect((observed as AggregateError).errors).toEqual([failure]);
    await request;
  });

  test("rejects a late keep-alive request after draining with no second service effect", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const secondRequestSeen = deferred<void>();
    let serviceCalls = 0;
    const { workspace } = await startShutdownFixture(async () => {
      serviceCalls += 1;
      entered.resolve();
      await release.promise;
      return { ok: true };
    });
    let requestEvents = 0;
    workspace.server.on("request", () => {
      requestEvents += 1;
      if (requestEvents === 2) secondRequestSeen.resolve();
    });
    const socket = await connect(workspace);
    let received = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      received += chunk;
    });
    const socketClosed = new Promise<void>((resolve) => socket.once("close", () => resolve()));

    socket.write(rawPreviewRequest(workspace, "keep-alive"));
    await entered.promise;
    const close = workspace.close();
    socket.write(rawPreviewRequest(workspace, "close"));
    await secondRequestSeen.promise;

    expect(serviceCalls).toBe(1);
    release.resolve();
    await close;
    await socketClosed;

    expect(serviceCalls).toBe(1);
    expect(received).toContain("HTTP/1.1 200 OK");
    expect(received).toContain("HTTP/1.1 503 Service Unavailable");
    expect(received).toContain('"code":"SHUTTING_DOWN"');
  });
  test("does not bind an admitted browser action to disconnect and drains it before close", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    let completed = false;
    let serviceCalls = 0;
    let observedActor: string | undefined;
    let observedSignal: AbortSignal | undefined;
    const { workspace } = await startShutdownFixture(async () => ({ ok: true }), {
      operatorActor: "fixed-shutdown-operator",
      service: {
        executeFencedBrowserAction: async (
          _identity: unknown,
          actor: string,
          options: { readonly signal?: AbortSignal },
        ): Promise<never> => {
          serviceCalls += 1;
          observedActor = actor;
          observedSignal = options.signal;
          entered.resolve();
          await release.promise;
          completed = true;
          throw new Error("forced action response after completed effect");
        },
      },
    });
    const socket = await connect(workspace);
    const socketClosed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    socket.write(rawBrowserActionRequest(workspace));
    await entered.promise;

    expect(serviceCalls).toBe(1);
    expect(observedActor).toBe("fixed-shutdown-operator");
    expect(observedSignal?.aborted).toBe(false);
    socket.destroy();
    await socketClosed;
    expect(observedSignal?.aborted).toBe(false);

    const close = workspace.close();
    let closed = false;
    void close.then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(completed).toBe(false);
    expect(observedSignal?.aborted).toBe(false);

    release.resolve();
    await expect(close).resolves.toBeUndefined();
    expect(completed).toBe(true);
    expect(serviceCalls).toBe(1);
    expect(observedSignal?.aborted).toBe(false);
  });
});
