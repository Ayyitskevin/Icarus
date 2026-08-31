import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ProbeResultV1 } from "../../packages/core/src/probe.js";
import { jsonOutput, runCli } from "../support/integration-cli.js";
import {
  type ProviderHttpServer,
  parseProviderRequestBody,
  sendProviderJson,
  startProviderHttpServer,
} from "../support/provider-http.js";

function anchorsFromMessages(body: Record<string, unknown>): {
  start: string;
  middle: string;
  end: string;
  contentLength: number;
} {
  const messages = body.messages as Array<{ role: string; content: string }>;
  const userMessage = messages.find((entry) => entry.role === "user");
  const content = userMessage?.content ?? "";
  const anchor = (label: string): string =>
    content.match(new RegExp(`ANCHOR_${label}=([0-9a-f]{8})`))?.[1] ?? "";
  return {
    start: anchor("START"),
    middle: anchor("MIDDLE"),
    end: anchor("END"),
    contentLength: content.length,
  };
}

describe("probe CLI", () => {
  let stateRoot: string;
  let server: ProviderHttpServer | undefined;

  beforeEach(async () => {
    stateRoot = await mkdtemp(path.join(os.tmpdir(), "icarus-probe-cli-"));
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
    await rm(stateRoot, { recursive: true, force: true });
  });

  it("runs a structured probe end-to-end against a loopback provider and emits a v1 result row", async () => {
    server = await startProviderHttpServer((_request, response) => {
      sendProviderJson(response, 200, {
        model: "fake-model",
        message: {
          role: "assistant",
          content: JSON.stringify({
            summary: "duplicate write with green monitoring",
            severity: "high",
            findings: [{ title: "monitoring missed duplicates", confirmed: true }],
          }),
        },
        done: true,
        done_reason: "stop",
        prompt_eval_count: 64,
        eval_count: 48,
      });
    });
    const result = await runCli(stateRoot, [
      "probe",
      "structured",
      "--model",
      "fake-model",
      "--base-url",
      server.baseUrl,
      "--repeat",
      "2",
    ]);
    const row = jsonOutput<ProbeResultV1>(result);
    expect(row.schemaVersion).toBe(1);
    expect(row.probe.kind).toBe("structured");
    expect(row.attempts).toHaveLength(2);
    expect(row.aggregate.okCount).toBe(2);
    expect(row.provider.model).toBe("fake-model");
    expect(server.requests).toHaveLength(2);
    const captured = server.requests[0];
    expect(captured).toBeDefined();
    expect(captured?.url).toBe("/api/chat");
    const body = (captured === undefined ? {} : parseProviderRequestBody(captured)) as Record<
      string,
      unknown
    >;
    expect(body.model).toBe("fake-model");
    expect(body.stream).toBe(false);
  });

  it("threads context sizing through the CLI and reports clean consumption honestly", async () => {
    server = await startProviderHttpServer((request, response) => {
      const body = parseProviderRequestBody(request) as Record<string, unknown>;
      const anchors = anchorsFromMessages(body);
      sendProviderJson(response, 200, {
        model: body.model,
        message: {
          role: "assistant",
          content: JSON.stringify({
            startAnchor: anchors.start,
            middleAnchor: anchors.middle,
            endAnchor: anchors.end,
          }),
        },
        done: true,
        done_reason: "stop",
        prompt_eval_count: Math.round(anchors.contentLength / 4),
        eval_count: 24,
      });
    });
    const result = await runCli(stateRoot, [
      "probe",
      "context",
      "--model",
      "fake-model",
      "--base-url",
      server.baseUrl,
      "--target-input-tokens",
      "1024",
    ]);
    const row = jsonOutput<ProbeResultV1>(result);
    expect(row.probe.targetInputTokens).toBe(1_024);
    expect(row.attempts[0]?.ok).toBe(true);
    expect(row.attempts[0]?.anchorRecall).toEqual({ start: true, middle: true, end: true });
    expect(row.aggregate.truncationSuspected).toBe(false);
  });

  it("rejects an unknown probe kind with the INVALID_PROBE contract instead of measuring nothing", async () => {
    const result = await runCli(stateRoot, ["probe", "speed", "--model", "fake-model"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("INVALID_PROBE");
  });

  it("reports tool-call as an explicit unsupported result with exit 0, never as a usage error", async () => {
    const result = await runCli(stateRoot, ["probe", "tool-call", "--model", "fake-model"]);
    const row = jsonOutput<ProbeResultV1>(result);
    expect(row.status).toBe("unsupported");
    expect(row.unsupportedReason).toContain("structured generation only");
    expect(row.attempts).toHaveLength(0);
  });

  it("reports tool-call as unsupported for OpenAI with no key and no pricing, because the contract must not depend on the provider it never contacts", async () => {
    const result = await runCli(
      stateRoot,
      ["probe", "tool-call", "--provider", "openai", "--model", "gpt-4o"],
      { OPENAI_API_KEY: undefined },
    );
    const row = jsonOutput<ProbeResultV1>(result);
    expect(row.status).toBe("unsupported");
    expect(row.provider.kind).toBe("openai");
    expect(row.attempts).toHaveLength(0);
  });

  it("reports tool-call as unsupported for Anthropic with no key and no pricing", async () => {
    const result = await runCli(
      stateRoot,
      ["probe", "tool-call", "--provider", "anthropic", "--model", "claude-sonnet-4"],
      { ANTHROPIC_API_KEY: undefined },
    );
    const row = jsonOutput<ProbeResultV1>(result);
    expect(row.status).toBe("unsupported");
    expect(row.provider.kind).toBe("anthropic");
  });

  it("contacts nothing for an unsupported kind, proven by a base URL that must never be reached", async () => {
    // 127.0.0.1:1 is closed. Any connection attempt fails loudly; a clean
    // unsupported row is therefore evidence that no request was made.
    const result = await runCli(stateRoot, [
      "probe",
      "tool-call",
      "--model",
      "fake-model",
      "--base-url",
      "http://127.0.0.1:1/",
    ]);
    const row = jsonOutput<ProbeResultV1>(result);
    expect(row.status).toBe("unsupported");
    expect(row.provider.baseUrl).toBe("http://127.0.0.1:1/");
    expect(row.attempts).toHaveLength(0);
  });

  it("creates no runtime state, because a probe's entire effect is one provider conversation plus a printed row", async () => {
    server = await startProviderHttpServer((_request, response) => {
      sendProviderJson(response, 200, {
        model: "fake-model",
        message: { role: "assistant", content: '{"text":"prose"}' },
        done: true,
        done_reason: "stop",
        prompt_eval_count: 8,
        eval_count: 8,
      });
    });
    const result = await runCli(stateRoot, [
      "probe",
      "throughput",
      "--model",
      "fake-model",
      "--base-url",
      server.baseUrl,
    ]);
    expect(result.exitCode).toBe(0);
    const entries = await readdir(stateRoot);
    expect(entries).toEqual([]);
  });
});
