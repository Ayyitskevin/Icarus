import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";

import { IcarusError } from "./errors.js";
import { sanitizeText } from "./redaction.js";

export const MAX_CONTROLLER_STDIN_BYTES = 8 * 1024 * 1024;

export interface ControllerProcessStdinContinuation {
  /** Exact stdout prefix that proves the child is ready for the second input phase. */
  readonly readyStdoutBytes: Uint8Array;
  /**
   * Produce the bounded final input phase. The signal aborts when the child
   * exits, times out, is cancelled, or otherwise cannot accept the response.
   */
  readonly nextStdinBytes: (signal: AbortSignal) => Uint8Array | Promise<Uint8Array>;
}

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
  readonly stdinContinuation?: ControllerProcessStdinContinuation;
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

function validateStdin(options: ControllerProcessOptions): number | null {
  if (options.stdinBytes === undefined) {
    if (options.stdinContinuation !== undefined) {
      throw new IcarusError(
        "INVALID_PROCESS_STDIN_CONTINUATION",
        "Controller process stdin continuation requires initial stdin bytes",
      );
    }
    return null;
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
  const readyBytes = options.stdinContinuation?.readyStdoutBytes;
  if (
    readyBytes !== undefined &&
    (!(readyBytes instanceof Uint8Array) ||
      readyBytes.byteLength === 0 ||
      readyBytes.byteLength > options.maxOutputBytes ||
      readyBytes.byteLength > options.maxRawOutputBytes)
  ) {
    throw new IcarusError(
      "INVALID_PROCESS_STDIN_CONTINUATION",
      "Controller process stdin continuation readiness marker is invalid",
    );
  }
  return maximumBytes;
}

function writeStdin(
  stream: Writable,
  bytes: Uint8Array,
  endStream: boolean,
  onFailure: () => void,
): Promise<boolean> {
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
      const onWrite = (error?: Error | null): void => {
        if (error !== undefined && error !== null) {
          fail();
          return;
        }
        settle(true);
      };
      // The completion callback fires only after the bounded payload has been
      // flushed or the stream has failed, so a full pipe applies backpressure
      // without creating an unbounded controller-side queue.
      if (endStream) {
        stream.end(payload, onWrite);
      } else {
        stream.write(payload, onWrite);
      }
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
  const stdinLimit = validateStdin(options);
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

  const continuation = options.stdinContinuation;
  const readyStdoutBytes =
    continuation === undefined ? undefined : Buffer.from(continuation.readyStdoutBytes);
  const continuationAbort = new AbortController();
  type ReadinessOutcome = "ready" | "blocked" | "closed" | "invalid";
  type ReadinessState =
    | "pending"
    | "ready"
    | "writing"
    | "complete"
    | "blocked"
    | "closed"
    | "invalid";
  let readinessState: ReadinessState = continuation === undefined ? "complete" : "pending";
  let readinessOffset = 0;
  let readinessSettled = false;
  let resolveReadiness: ((outcome: ReadinessOutcome) => void) | undefined;
  const readiness =
    continuation === undefined
      ? undefined
      : new Promise<ReadinessOutcome>((resolve) => {
          resolveReadiness = resolve;
        });
  const settleReadiness = (outcome: ReadinessOutcome): void => {
    if (readinessSettled) return;
    readinessSettled = true;
    resolveReadiness?.(outcome);
  };
  const invalidateReadiness = (): void => {
    if (readinessState !== "pending" && readinessState !== "ready") return;
    readinessState = "invalid";
    settleReadiness("invalid");
    continuationAbort.abort();
    terminateProcess(child.pid, "SIGKILL");
  };
  const blockReadiness = (): void => {
    if (readinessState !== "pending" && readinessState !== "ready") return;
    readinessState = "blocked";
    settleReadiness("blocked");
    continuationAbort.abort();
  };

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
    if (readyStdoutBytes === undefined) return;
    if (rawLimitExceeded || truncated) {
      invalidateReadiness();
      return;
    }
    if (readinessState === "ready") {
      invalidateReadiness();
      return;
    }
    if (readinessState !== "pending") return;
    const remaining = readyStdoutBytes.byteLength - readinessOffset;
    if (
      chunk.byteLength > remaining ||
      !chunk.equals(readyStdoutBytes.subarray(readinessOffset, readinessOffset + chunk.byteLength))
    ) {
      invalidateReadiness();
      return;
    }
    readinessOffset += chunk.byteLength;
    if (readinessOffset === readyStdoutBytes.byteLength) {
      readinessState = "ready";
      settleReadiness("ready");
    }
  });
  stderr.on("data", (chunk: Buffer) => {
    capture(chunk, stderrChunks);
    if (readinessState === "pending" || readinessState === "ready") {
      blockReadiness();
    }
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
    continuationAbort.abort();
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

  const closeContinuation = (): void => {
    continuationAbort.abort();
    if (readinessState === "pending" || readinessState === "ready") {
      readinessState = "closed";
      settleReadiness("closed");
    }
  };
  const processResult = new Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", (error) => {
      closeContinuation();
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      closeContinuation();
      resolve({ exitCode, signal });
    });
  });

  let stdinFailure: IcarusError | null = null;
  const terminateForStdinFailure = (): void => {
    if (!terminationStarted && !rawLimitExceeded) {
      terminateProcess(child.pid, "SIGKILL");
    }
  };
  const deliverStdin = async (): Promise<boolean> => {
    if (options.stdinBytes === undefined) return true;
    const stream = child.stdin as Writable;
    const closeBlockedStdin = async (): Promise<true> => {
      await writeStdin(stream, new Uint8Array(), true, () => undefined);
      return true;
    };
    const initialDelivered = await writeStdin(
      stream,
      options.stdinBytes,
      continuation === undefined,
      terminateForStdinFailure,
    );
    if (!initialDelivered || continuation === undefined || readiness === undefined) {
      return initialDelivered;
    }

    const readinessOutcome = await readiness;
    if (readinessOutcome === "closed") return true;
    if (readinessOutcome === "blocked") return closeBlockedStdin();
    if (readinessOutcome === "invalid") return false;

    type NextStdinOutcome =
      | { readonly kind: "bytes"; readonly bytes: Uint8Array }
      | { readonly kind: "error" }
      | { readonly kind: "aborted" };
    const produced = Promise.resolve()
      .then(() => continuation.nextStdinBytes(continuationAbort.signal))
      .then<NextStdinOutcome, NextStdinOutcome>(
        (bytes) => ({ kind: "bytes", bytes }),
        () => ({ kind: "error" }),
      );
    let onContinuationAbort: (() => void) | undefined;
    const aborted = new Promise<NextStdinOutcome>((resolve) => {
      onContinuationAbort = () => resolve({ kind: "aborted" });
      if (continuationAbort.signal.aborted) {
        onContinuationAbort();
      } else {
        continuationAbort.signal.addEventListener("abort", onContinuationAbort, { once: true });
      }
    });
    const next = await Promise.race([produced, aborted]);
    if (onContinuationAbort !== undefined) {
      continuationAbort.signal.removeEventListener("abort", onContinuationAbort);
    }
    if (next.kind === "aborted") {
      return readinessState === "blocked" ? closeBlockedStdin() : readinessState !== "invalid";
    }
    if (next.kind === "error" || !(next.bytes instanceof Uint8Array)) {
      stdinFailure = new IcarusError(
        "PROCESS_STDIN_CONTINUATION_FAILED",
        "Controller process stdin continuation failed",
      );
      terminateForStdinFailure();
      return false;
    }
    if (readinessState !== "ready") {
      return readinessState === "blocked" ? closeBlockedStdin() : readinessState !== "invalid";
    }
    const totalBytes = options.stdinBytes.byteLength + next.bytes.byteLength;
    if (stdinLimit === null || totalBytes > stdinLimit) {
      stdinFailure = new IcarusError(
        "PROCESS_STDIN_TOO_LARGE",
        "Controller process stdin exceeds its byte ceiling",
        { actualBytes: totalBytes, maximumBytes: stdinLimit ?? 0 },
      );
      terminateForStdinFailure();
      return false;
    }
    if (continuationAbort.signal.aborted) {
      return true;
    }
    readinessState = "writing";
    const finalDelivered = await writeStdin(stream, next.bytes, true, terminateForStdinFailure);
    if (finalDelivered) readinessState = "complete";
    return finalDelivered;
  };

  try {
    const [result, stdinDelivered] = await Promise.all([processResult, deliverStdin()]);
    if (!stdinDelivered && terminationCause === null && !rawLimitExceeded) {
      throw (
        stdinFailure ??
        new IcarusError(
          "PROCESS_STDIN_FAILED",
          "Controller process did not accept its bounded stdin",
        )
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
    continuationAbort.abort();
    clearTimeout(timeout);
    if (escalation !== undefined) {
      clearTimeout(escalation);
    }
    options.signal?.removeEventListener("abort", onAbort);
  }
}
