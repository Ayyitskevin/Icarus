#!/usr/bin/env node

import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createIcarusRuntime, IcarusError, type IcarusRuntime } from "@icarus/core";

import { startWorkspaceServer, type StartedWorkspaceServer } from "./server.js";

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
  const raw = process.env.ICARUS_PORT ?? "8787";
  if (!/^\d{1,5}$/.test(raw)) throw new IcarusError("INVALID_PORT", "ICARUS_PORT is invalid");
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new IcarusError("INVALID_PORT", "ICARUS_PORT is invalid");
  }
  return parsed;
}

async function main(): Promise<void> {
  let runtime: IcarusRuntime | undefined;
  let server: StartedWorkspaceServer | undefined;
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    await server?.close();
    runtime?.close();
  };
  try {
    const root = stateRoot();
    runtime = await createIcarusRuntime(root);
    const workspaceDist = fileURLToPath(new URL("../../workspace/dist/", import.meta.url));
    server = await startWorkspaceServer({ runtime, stateRoot: root, workspaceDist }, port());
    process.stdout.write(
      `${JSON.stringify({ url: server.url, binding: server.host, stateRoot: root })}\n`,
    );
    process.once("SIGINT", () => void shutdown());
    process.once("SIGTERM", () => void shutdown());
  } catch (error) {
    await shutdown();
    const code = error instanceof IcarusError ? error.code : "INTERNAL_ERROR";
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${JSON.stringify({ error: { code, message } })}\n`);
    process.exitCode = 1;
  }
}

await main();
