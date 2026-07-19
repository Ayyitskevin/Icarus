import { spawn } from "node:child_process";

import { IcarusError } from "./errors.js";
import { sanitizeText } from "./redaction.js";

export interface ControllerProcessOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly maxRawOutputBytes: number;
  readonly signal: AbortSignal | undefined;
  readonly knownSecrets?: readonly string[];
}

export interface ControllerProcessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutBytes: Uint8Array;
  readonly stderrBytes: Uint8Array;
  readonly durationMs: number;
  readonly truncated: boolean;
  readonly rawLimitExceeded: boolean;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
}

function terminateProcess(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) {
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // The process already exited.
    }
  }
}

export async function runControllerProcess(
  executable: string,
  args: readonly string[],
  options: ControllerProcessOptions,
): Promise<ControllerProcessResult> {
  if (options.signal?.aborted) {
    throw new IcarusError("CANCELLED", "Operation was cancelled before process start");
  }

  const startedAt = performance.now();
  const child = spawn(executable, args, {
    cwd: options.cwd,
    env: { ...options.env },
    shell: false,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let retainedBytes = 0;
  let rawBytes = 0;
  let truncated = false;
  let rawLimitExceeded = false;
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  const capture = (chunk: Buffer, destination: Buffer[]): void => {
    rawBytes += chunk.length;
    if (rawBytes > options.maxRawOutputBytes) {
      rawLimitExceeded = true;
      terminateProcess(child.pid, "SIGKILL");
    }
    const remaining = Math.max(0, options.maxOutputBytes - retainedBytes);
    if (remaining === 0) {
      truncated = true;
      return;
    }
    if (chunk.length > remaining) {
      destination.push(chunk.subarray(0, remaining));
      retainedBytes += remaining;
      truncated = true;
      return;
    }
    destination.push(chunk);
    retainedBytes += chunk.length;
  };

  child.stdout.on("data", (chunk: Buffer) => {
    capture(chunk, stdoutChunks);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    capture(chunk, stderrChunks);
  });

  let escalation: NodeJS.Timeout | undefined;
  let terminationStarted = false;
  let terminationCause: "timeout" | "cancelled" | null = null;
  const requestTermination = (cause: "timeout" | "cancelled"): void => {
    if (terminationStarted) {
      return;
    }
    terminationStarted = true;
    terminationCause = cause;
    terminateProcess(child.pid, "SIGTERM");
    escalation = setTimeout(() => terminateProcess(child.pid, "SIGKILL"), 1_000);
    escalation.unref();
  };
  const onAbort = (): void => requestTermination("cancelled");
  options.signal?.addEventListener("abort", onAbort, { once: true });

  const timeout = setTimeout(() => requestTermination("timeout"), options.timeoutMs);
  timeout.unref();

  try {
    const result = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once("error", reject);
        child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
      },
    );
    const knownSecrets = options.knownSecrets ?? [];
    const stdoutBuffer = Buffer.concat(stdoutChunks);
    const stderrBuffer = Buffer.concat(stderrChunks);
    return {
      ...result,
      stdout: sanitizeText(stdoutBuffer.toString("utf8"), knownSecrets),
      stderr: sanitizeText(stderrBuffer.toString("utf8"), knownSecrets),
      stdoutBytes: stdoutBuffer,
      stderrBytes: stderrBuffer,
      durationMs: Math.round(performance.now() - startedAt),
      truncated,
      rawLimitExceeded,
      timedOut: terminationCause === "timeout",
      cancelled: terminationCause === "cancelled",
    };
  } finally {
    clearTimeout(timeout);
    if (escalation !== undefined) {
      clearTimeout(escalation);
    }
    options.signal?.removeEventListener("abort", onAbort);
  }
}
