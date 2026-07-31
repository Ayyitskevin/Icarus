#!/usr/bin/env node

import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createIcarusRuntime, IcarusError, type IcarusRuntime } from "@icarus/core";

import { type StartedWorkspaceServer, startWorkspaceServer } from "./server.js";

function stateRoot(): string {
  const explicit = process.env.ICARUS_HOME;
  if (explicit !== undefined && explicit.length > 0) return path.resolve(explicit);
  const stateHome = process.env.XDG_STATE_HOME;
  return path.resolve(
    stateHome !== undefined && stateHome.length > 0
      ? path.join(stateHome, "icarus")
      : path.join(os.homedir(), ".local", "state", "icarus"),
  );
}

function port(): number {
  const raw = process.env.ICARUS_PORT;
  if (raw === undefined) return 0;
  if (!/^\d{1,5}$/.test(raw)) throw new IcarusError("INVALID_PORT", "ICARUS_PORT is invalid");
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new IcarusError("INVALID_PORT", "ICARUS_PORT is invalid");
  }
  return parsed;
}

function reportFailure(error: unknown): void {
  const code = error instanceof IcarusError ? error.code : "INTERNAL_ERROR";
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ error: { code, message } })}\n`);
  process.exitCode = 1;
}

async function main(): Promise<void> {
  let runtime: IcarusRuntime | undefined;
  let server: StartedWorkspaceServer | undefined;
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    if (shutdownPromise !== undefined) return shutdownPromise;
    shutdownPromise = (async () => {
      const failures: unknown[] = [];
      try {
        await server?.close();
      } catch (error) {
        failures.push(error);
      }
      // Server close resolves or rejects only after its request drain. Runtime
      // storage therefore remains available to every first-signal handler.
      try {
        runtime?.close();
      } catch (error) {
        failures.push(error);
      }
      runtime = undefined;
      server = undefined;
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, "Workspace shutdown failed");
      }
    })();
    return shutdownPromise;
  };
  const onSignal = (): void => {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    // A first signal starts the same graceful drain used by programmatic
    // shutdown. Its rejection is observed and reported rather than becoming an
    // unhandled promise; no action signal or AbortController is involved.
    void shutdown().catch(reportFailure);
  };
  try {
    const root = stateRoot();
    runtime = await createIcarusRuntime(root);
    if (process.platform === "linux") {
      await runtime.service.reconcilePreparedBrowserActionRequests();
    }
    const workspaceDist = fileURLToPath(new URL("../../workspace/dist/", import.meta.url));
    server = await startWorkspaceServer({ runtime, stateRoot: root, workspaceDist }, port());
    process.stdout.write(
      `${JSON.stringify({ url: server.launchUrl, binding: server.host, stateRoot: root })}\n`,
    );
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  } catch (error) {
    try {
      await shutdown();
    } catch (shutdownError) {
      reportFailure(shutdownError);
    }
    reportFailure(error);
  }
}

await main();
