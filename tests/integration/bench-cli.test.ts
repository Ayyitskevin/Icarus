import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { BenchComparisonV1 } from "../../packages/core/src/bench.js";
import { jsonOutput, runCli } from "../support/integration-cli.js";
import {
  type ProviderHttpServer,
  sendProviderJson,
  startProviderHttpServer,
} from "../support/provider-http.js";

describe("bench CLI", () => {
  let stateRoot: string;
  let server: ProviderHttpServer | undefined;

  beforeEach(async () => {
    stateRoot = await mkdtemp(path.join(os.tmpdir(), "icarus-bench-cli-"));
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
    await rm(stateRoot, { recursive: true, force: true });
  });

  it("compares two models end-to-end and records the one request both answered", async () => {
    server = await startProviderHttpServer((_request, response) => {
      sendProviderJson(response, 200, {
        message: {
          role: "assistant",
          content: JSON.stringify({
            summary: "duplicate write with green monitoring",
            severity: "high",
            findings: [{ title: "monitoring missed duplicates", confirmed: true }],
          }),
        },
        prompt_eval_count: 64,
        eval_count: 48,
      });
    });

    const result = await runCli(stateRoot, [
      "bench",
      "compare",
      "--target",
      "ollama:model-a",
      "--target",
      "ollama:model-b",
      "--kind",
      "structured",
      "--base-url",
      server.baseUrl,
      "--repeat",
      "2",
    ]);
    const doc = jsonOutput<BenchComparisonV1>(result);

    expect(doc.schemaVersion).toBe(1);
    expect(doc.targets.map((target) => target.model)).toEqual(["model-a", "model-b"]);
    // One request, recorded once, answered by both rows — the document's claim.
    expect(doc.requests).toHaveLength(1);
    expect(doc.rows).toHaveLength(2);
    for (const row of doc.rows) {
      expect(row.outcome).toBe("measured");
      expect(row.result?.probe).toEqual(doc.requests[0]);
    }
    expect(doc.attempted).toBe(2);
    expect(doc.measured).toBe(2);
    expect(doc.failed).toBe(0);
    // Sequential, and every attempt of every target actually reached the provider.
    expect(server.requests).toHaveLength(4);
  });

  it("refuses --base-url across mixed provider kinds instead of pointing half the document elsewhere", async () => {
    const result = await runCli(stateRoot, [
      "bench",
      "compare",
      "--target",
      "ollama:model-a",
      "--target",
      "vulcan:code",
      "--base-url",
      "http://127.0.0.1:9/",
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/mixed provider kinds/);
  });

  it("refuses a malformed target rather than guessing the provider", async () => {
    const result = await runCli(stateRoot, ["bench", "compare", "--target", "qwen3.8:27b"]);
    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/provider must be one of/);
  });
});
