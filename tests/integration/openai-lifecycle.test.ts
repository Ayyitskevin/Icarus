import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { DEFAULT_CEILING, DEFAULT_SANDBOX_LIMITS } from "../../packages/core/src/policy.js";
import { createProviderConfig } from "../../packages/core/src/provider.js";
import { OpenAIResponsesGateway } from "../../packages/core/src/providers.js";
import { createIcarusRuntime } from "../../packages/core/src/runtime.js";
import type { JsonValue } from "../../packages/core/src/types.js";
import {
  createFixtureRepository,
  PYTHON_IMAGE,
  repositoryFingerprint,
} from "../support/integration-cli.js";

async function treeContains(root: string, needle: Buffer): Promise<boolean> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (await treeContains(entryPath, needle)) return true;
    } else if (entry.isFile() && (await readFile(entryPath)).includes(needle)) {
      return true;
    }
  }
  return false;
}

describe("OpenAI remote lifecycle", () => {
  test("requires exact egress approval before the real Responses adapter runs end to end", async () => {
    const fixture = await createFixtureRepository();
    const apiKey = "openai-lifecycle-test-key-not-a-real-secret";
    const preimage = "Hello, world!\n";
    const preimageSha256 = createHash("sha256").update(preimage).digest("hex");
    const outputs: JsonValue[] = [
      {
        summary: "Replace the operator-selected greeting.",
        steps: ["Apply one exact replacement", "Run the registered verification check"],
        risks: ["The exact preimage may have changed"],
        target: "src/greeting.txt",
        checkIds: ["verify"],
      },
      {
        path: "src/greeting.txt",
        expectedPreimageSha256: preimageSha256,
        findText: preimage,
        replaceText: "Hello, Icarus!\n",
        rationale: "Implement the approved greeting change only.",
      },
    ];
    const requests: Array<{ readonly url: string; readonly body: Record<string, unknown> }> = [];
    const fetchImplementation: typeof fetch = async (input, init) => {
      const output = outputs.shift();
      if (output === undefined) throw new Error("OpenAI response queue exhausted");
      if (typeof init?.body !== "string") throw new Error("Expected a JSON request body");
      requests.push({ url: String(input), body: JSON.parse(init.body) as Record<string, unknown> });
      expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${apiKey}`);
      return new Response(
        JSON.stringify({
          status: "completed",
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: JSON.stringify(output) }],
            },
          ],
          usage: { input_tokens: 20, output_tokens: 10 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const runtime = await createIcarusRuntime(fixture.stateRoot, {
      gatewayFactory: (config) => new OpenAIResponsesGateway(config, apiKey, fetchImplementation),
    });
    try {
      const sourceBefore = await repositoryFingerprint(fixture.repository);
      await runtime.service.registerRepository("fixture", fixture.repository);
      runtime.service.createProject({
        name: "golden",
        repositoryName: "fixture",
        baseRef: "main",
        checks: [{ id: "verify", name: "Verify", argv: ["python", "checks/verify.py"] }],
        sandbox: { image: PYTHON_IMAGE, ...DEFAULT_SANDBOX_LIMITS },
        ceiling: DEFAULT_CEILING,
      });
      const provider = createProviderConfig({
        kind: "openai",
        model: "gpt-5-contract-model",
        baseUrl: "https://api.openai.com/v1/",
        inputUsdPerMillionTokens: 1,
        outputUsdPerMillionTokens: 1,
      });

      const awaitingEgress = await runtime.service.planRun({
        projectName: "golden",
        task: "Replace the greeting and run the check.",
        target: "src/greeting.txt",
        provider,
      });
      expect(awaitingEgress.state).toBe("awaiting_egress_approval");
      expect(requests).toHaveLength(0);
      expect((await runtime.service.resume(awaitingEgress.id)).state).toBe(
        "awaiting_egress_approval",
      );
      expect(requests).toHaveLength(0);
      const egressGateHistory = runtime.service.history(awaitingEgress.id);
      await expect(
        runtime.service.approveEgress(awaitingEgress.id, "0".repeat(64), "integration-test"),
      ).rejects.toEqual(expect.objectContaining({ code: "STALE_APPROVAL" }));
      await expect(
        runtime.service.approveEgress(awaitingEgress.id, awaitingEgress.contextSha256, ""),
      ).rejects.toEqual(expect.objectContaining({ code: "INVALID_APPROVAL" }));
      expect(requests).toHaveLength(0);
      expect(runtime.service.history(awaitingEgress.id)).toEqual(egressGateHistory);

      const awaitingPlan = await runtime.service.approveEgress(
        awaitingEgress.id,
        awaitingEgress.contextSha256,
        "integration-test",
      );
      expect(awaitingPlan.state).toBe("awaiting_approval");
      expect(requests).toHaveLength(1);
      const awaitingReview = await runtime.service.approvePlan(
        awaitingEgress.id,
        awaitingPlan.planSha256 ?? "",
        "integration-test",
      );
      expect(awaitingReview.state).toBe("awaiting_review");
      expect(awaitingReview.verification?.outcome).toBe("passed");
      expect(requests).toHaveLength(2);
      expect(requests.map((request) => request.url)).toEqual([
        "https://api.openai.com/v1/responses",
        "https://api.openai.com/v1/responses",
      ]);
      for (const request of requests) {
        expect(request.body.store).toBe(false);
        expect(request.body.tools).toEqual([]);
        expect(request.body.tool_choice).toBe("none");
      }

      const completed = await runtime.service.review(
        awaitingEgress.id,
        "approve",
        awaitingReview.verification?.diffSha256 ?? "",
        "integration-test",
      );
      expect(completed.state).toBe("completed");
      expect(await readFile(path.join(fixture.repository, "src/greeting.txt"), "utf8")).toBe(
        preimage,
      );
      expect(await repositoryFingerprint(fixture.repository)).toEqual(sourceBefore);
    } finally {
      runtime.close();
    }
    try {
      expect(await treeContains(fixture.stateRoot, Buffer.from(apiKey, "utf8"))).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  }, 180_000);
});
