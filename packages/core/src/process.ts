import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";

import { IcarusError } from "./errors.js";
import { sanitizeText } from "./redaction.js";

export const MAX_CONTROLLER_STDIN_BYTES = 8 * 1024 * 1024;

export interface ControllerProcessOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly maxRawOutputBytes: number;
  readonly signal: AbortSignal | undefined;
  readonly knownSecrets?: readonly string[];
  readonly stdinBytes?: Uint8Array;
  readonly maxStdinBytes?: number;
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

function validateStdin(options: ControllerProcessOptions): void {
  if (options.stdinBytes === undefined) {
    return;
  }

  const maximumBytes = options.maxStdinBytes ?? MAX_CONTROLLER_STDIN_BYTES;
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 0 ||
    maximumBytes > MAX_CONTROLLER_STDIN_BYTES
  ) {
    throw new IcarusError(
      "INVALID_PROCESS_STDIN_LIMIT",
      "Controller process stdin limit is invalid",
      { maximumBytes: MAX_CONTROLLER_STDIN_BYTES },
    );
  }
  if (options.stdinBytes.byteLength > maximumBytes) {
    throw new IcarusError(
      "PROCESS_STDIN_TOO_LARGE",
      "Controller process stdin exceeds its byte ceiling",
      {
        actualBytes: options.stdinBytes.byteLength,
        maximumBytes,
      },
    );
  }
}

function writeStdin(stream: Writable, bytes: Uint8Array, onFailure: () => void): Promise<boolean> {
  const payload = Buffer.from(bytes);

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (delivered: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      payload.fill(0);
      resolve(delivered);
    };
    const fail = (): void => {
      if (settled) {
        return;
      }
      onFailure();
      settle(false);
    };
    const onError = (): void => fail();
    const onClose = (): void => {
      stream.off("error", onError);
      fail();
    };

    stream.on("error", onError);
    stream.once("close", onClose);
    try {
      // The completion callback fires only after the bounded payload has been
      // flushed or the stream has failed, so a full pipe applies backpressure
      // without creating an unbounded controller-side queue.
      stream.end(payload, (error?: Error | null) => {
        if (error !== undefined && error !== null) {
          fail();
          return;
        }
        settle(true);
      });
    } catch {
      fail();
    }
  });
}

export async function runControllerProcess(
  executable: string,
  args: readonly string[],
  options: ControllerProcessOptions,
): Promise<ControllerProcessResult> {
  validateStdin(options);
  if (options.signal?.aborted) {
    throw new IcarusError("CANCELLED", "Operation was cancelled before process start");
  }

  const startedAt = performance.now();
  const child = spawn(executable, args, {
    cwd: options.cwd,
    env: { ...options.env },
    shell: false,
    detached: true,
    stdio: [options.stdinBytes === undefined ? "ignore" : "pipe", "pipe", "pipe"] as const,
  });

  let retainedBytes = 0;
  let rawBytes = 0;
  let truncated = false;
  let rawLimitExceeded = false;
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const stdout = child.stdout as Readable;
  const stderr = child.stderr as Readable;

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

  stdout.on("data", (chunk: Buffer) => {
    capture(chunk, stdoutChunks);
  });
  stderr.on("data", (chunk: Buffer) => {
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
  if (options.signal?.aborted) {
    requestTermination("cancelled");
  }

  const timeout = setTimeout(() => requestTermination("timeout"), options.timeoutMs);
  timeout.unref();

  const processResult = new Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
  });
  const stdinDelivery =
    options.stdinBytes === undefined
      ? undefined
      : writeStdin(child.stdin as Writable, options.stdinBytes, () => {
          if (!terminationStarted && !rawLimitExceeded) {
            terminateProcess(child.pid, "SIGKILL");
          }
        });

  try {
    const result = await processResult;
    const stdinDelivered = (await stdinDelivery) ?? true;
    if (!stdinDelivered && terminationCause === null && !rawLimitExceeded) {
      throw new IcarusError(
        "PROCESS_STDIN_FAILED",
        "Controller process did not accept its bounded stdin",
      );
    }
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
