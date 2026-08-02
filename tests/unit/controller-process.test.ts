import { createHash } from "node:crypto";

import { describe, expect, test } from "vitest";

import { IcarusError } from "../../packages/core/src/errors.js";
import {
  type ControllerProcessOptions,
  type ControllerProcessResult,
  MAX_CONTROLLER_STDIN_BYTES,
  runControllerProcess,
} from "../../packages/core/src/process.js";

const SECRET_MARKER = "ICARUS_CONTROLLER_STDIN_MUST_NOT_LEAK";

function processOptions(
  overrides: Partial<ControllerProcessOptions> = {},
): ControllerProcessOptions {
  return {
    cwd: process.cwd(),
    env: {},
    timeoutMs: 3_000,
    maxOutputBytes: 64 * 1024,
    maxRawOutputBytes: 128 * 1024,
    signal: undefined,
    ...overrides,
  };
}

function runNode(
  source: string,
  overrides: Partial<ControllerProcessOptions> = {},
): Promise<ControllerProcessResult> {
  return runControllerProcess(process.execPath, ["-e", source], processOptions(overrides));
}

function largeSecretInput(): Buffer {
  const marker = Buffer.from(`${SECRET_MARKER}\0`, "utf8");
  const input = Buffer.alloc(2 * 1024 * 1024);
  for (let offset = 0; offset < input.length; offset += marker.length) {
    marker.copy(input, offset);
  }
  return input;
}

function expectNoInputInResult(result: ControllerProcessResult, input: Uint8Array): void {
  const marker = Buffer.from(SECRET_MARKER, "utf8");
  const inputBuffer = Buffer.from(input);
  expect(result).not.toHaveProperty("stdinBytes");
  expect(result.stdout).not.toContain(SECRET_MARKER);
  expect(result.stderr).not.toContain(SECRET_MARKER);
  expect(Buffer.from(result.stdoutBytes).includes(marker)).toBe(false);
  expect(Buffer.from(result.stderrBytes).includes(marker)).toBe(false);
  expect(Buffer.from(result.stdoutBytes).includes(inputBuffer)).toBe(false);
  expect(Buffer.from(result.stderrBytes).includes(inputBuffer)).toBe(false);
}

function expectNoInputInError(error: unknown): void {
  const diagnostic =
    error instanceof IcarusError
      ? `${error.name}\n${error.code}\n${error.message}\n${JSON.stringify(error.details)}\n${error.stack ?? ""}`
      : String(error);
  expect(diagnostic).not.toContain(SECRET_MARKER);
}

async function captureRejection(action: Promise<unknown>): Promise<unknown> {
  const notRejected = Symbol("not-rejected");
  let observed: unknown = notRejected;
  try {
    await action;
  } catch (error) {
    observed = error;
  }
  if (observed === notRejected) {
    throw new Error("Expected controller process action to reject");
  }
  return observed;
}

describe("controller process bounded stdin", () => {
  test("preserves the ignored-stdin behavior when no bytes are supplied", async () => {
    const result = await runNode(`
      const chunks = [];
      process.stdin.on("data", (chunk) => chunks.push(chunk));
      process.stdin.on("end", () => process.stdout.write(String(Buffer.concat(chunks).length)));
    `);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("0");
    expect(result.stderr).toBe("");
    expect(result.cancelled).toBe(false);
    expect(result.timedOut).toBe(false);
  });

  test("delivers the exact bounded bytes, including NUL and non-UTF-8 bytes", async () => {
    const stdinBytes = Buffer.concat([
      Buffer.from([0x00, 0xff, 0x01, 0x00, 0x7f]),
      Buffer.from(SECRET_MARKER, "utf8"),
      Buffer.from([0x00, 0x80, 0xfe]),
    ]);
    const expectedDigest = createHash("sha256").update(stdinBytes).digest("hex");

    const result = await runNode(
      `
        const { createHash } = require("node:crypto");
        const chunks = [];
        process.stdin.on("data", (chunk) => chunks.push(chunk));
        process.stdin.on("end", () => {
          const input = Buffer.concat(chunks);
          process.stdout.write(JSON.stringify({
            byteLength: input.length,
            sha256: createHash("sha256").update(input).digest("hex"),
          }));
        });
      `,
      { stdinBytes, maxStdinBytes: stdinBytes.byteLength },
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      byteLength: stdinBytes.byteLength,
      sha256: expectedDigest,
    });
    expectNoInputInResult(result, stdinBytes);
  });

  test("refuses oversized input before attempting to spawn", async () => {
    const stdinBytes = Buffer.from(SECRET_MARKER, "utf8");
    const error = await captureRejection(
      runControllerProcess(
        `/icarus-controller-process-does-not-exist-${process.pid}`,
        [],
        processOptions({
          stdinBytes,
          maxStdinBytes: stdinBytes.byteLength - 1,
        }),
      ),
    );

    expect(error).toBeInstanceOf(IcarusError);
    expect(error).toMatchObject({
      code: "PROCESS_STDIN_TOO_LARGE",
      details: {
        actualBytes: stdinBytes.byteLength,
        maximumBytes: stdinBytes.byteLength - 1,
      },
    });
    expectNoInputInError(error);
  });

  test("refuses a caller ceiling above the absolute bound before spawn", async () => {
    const error = await captureRejection(
      runControllerProcess(
        `/icarus-controller-process-does-not-exist-${process.pid}`,
        [],
        processOptions({
          stdinBytes: new Uint8Array(),
          maxStdinBytes: MAX_CONTROLLER_STDIN_BYTES + 1,
        }),
      ),
    );

    expect(error).toBeInstanceOf(IcarusError);
    expect(error).toMatchObject({
      code: "INVALID_PROCESS_STDIN_LIMIT",
      details: { maximumBytes: MAX_CONTROLLER_STDIN_BYTES },
    });
    expectNoInputInError(error);
  });

  test("fails safely when the child closes stdin before accepting the payload", async () => {
    const stdinBytes = largeSecretInput();
    const startedAt = performance.now();
    const error = await captureRejection(
      runNode(
        `
          require("node:fs").closeSync(0);
          setInterval(() => undefined, 1_000);
        `,
        { stdinBytes, maxStdinBytes: stdinBytes.byteLength },
      ),
    );

    expect(performance.now() - startedAt).toBeLessThan(5_000);
    expect(error).toBeInstanceOf(IcarusError);
    expect(error).toMatchObject({ code: "PROCESS_STDIN_FAILED", details: {} });
    expectNoInputInError(error);
  });

  test("cancellation cannot hang behind stdin backpressure", async () => {
    const stdinBytes = largeSecretInput();
    const controller = new AbortController();
    const abort = setTimeout(() => controller.abort(), 200);
    const startedAt = performance.now();
    try {
      const result = await runNode(
        `
          process.on("SIGTERM", () => undefined);
          setInterval(() => undefined, 1_000);
        `,
        {
          stdinBytes,
          maxStdinBytes: stdinBytes.byteLength,
          signal: controller.signal,
        },
      );

      expect(performance.now() - startedAt).toBeLessThan(5_000);
      expect(result.cancelled).toBe(true);
      expect(result.timedOut).toBe(false);
      expectNoInputInResult(result, stdinBytes);
    } finally {
      clearTimeout(abort);
    }
  });

  test("timeout cannot hang behind stdin backpressure", async () => {
    const stdinBytes = largeSecretInput();
    const startedAt = performance.now();
    const result = await runNode(
      `
        process.on("SIGTERM", () => undefined);
        setInterval(() => undefined, 1_000);
      `,
      {
        stdinBytes,
        maxStdinBytes: stdinBytes.byteLength,
        timeoutMs: 200,
      },
    );

    expect(performance.now() - startedAt).toBeLessThan(5_000);
    expect(result.cancelled).toBe(false);
    expect(result.timedOut).toBe(true);
    expectNoInputInResult(result, stdinBytes);
  });
});
