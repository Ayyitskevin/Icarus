import { afterEach, describe, expect, it } from "vitest";

import type { StructuredGenerationRequest } from "../../packages/core/src/provider.js";
import { createProviderConfig } from "../../packages/core/src/provider.js";
import { OllamaGateway } from "../../packages/core/src/providers.js";
import {
  type ProviderHttpServer,
  parseProviderRequestBody,
  sendProviderJson,
  startProviderHttpServer,
} from "../support/provider-http.js";

const generationRequest: StructuredGenerationRequest = {
  schemaName: "m1_edit",
  schema: {
    type: "object",
    properties: { replaceText: { type: "string" } },
    required: ["replaceText"],
    additionalProperties: false,
  },
  instructions: "Return one bounded edit.",
  input: "Replace the greeting with hello, Icarus.",
  maxOutputTokens: 64,
  timeoutMs: 1_000,
};

describe("OllamaGateway HTTP contract", () => {
  let server: ProviderHttpServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("sends the exact non-streaming structured payload and extracts text and usage", async () => {
    server = await startProviderHttpServer((_request, response) => {
      sendProviderJson(response, 200, {
        message: { role: "assistant", content: '{"replaceText":"hello, Icarus"}' },
        prompt_eval_count: 12,
        eval_count: 4,
      });
    });
    const config = createProviderConfig({
      kind: "ollama",
      model: "qwen3.6:27b",
      baseUrl: server.baseUrl,
      inputUsdPerMillionTokens: 0.5,
      outputUsdPerMillionTokens: 1.5,
    });

    const result = await new OllamaGateway(config).generateStructured(generationRequest);

    expect(result.text).toBe('{"replaceText":"hello, Icarus"}');
    expect(result.usage).toMatchObject({ inputTokens: 12, outputTokens: 4 });
    expect(result.usage.estimatedCostUsd).toBeCloseTo(0.000_012, 10);
    expect(result.usage.latencyMs).toBeGreaterThanOrEqual(0);
    expect(server.requests).toHaveLength(1);
    const captured = server.requests[0];
    expect(captured).toBeDefined();
    expect(captured?.method).toBe("POST");
    expect(captured?.url).toBe("/api/chat");
    expect(captured?.headers.accept).toBe("application/json");
    expect(captured?.headers["content-type"]).toBe("application/json");
    expect(captured?.headers.authorization).toBeUndefined();
    expect(captured === undefined ? undefined : parseProviderRequestBody(captured)).toEqual({
      model: "qwen3.6:27b",
      stream: false,
      think: false,
      format: generationRequest.schema,
      messages: [
        { role: "system", content: generationRequest.instructions },
        { role: "user", content: generationRequest.input },
      ],
      options: { num_predict: generationRequest.maxOutputTokens },
    });
  });

  it("does not issue a request when the caller signal is already aborted", async () => {
    server = await startProviderHttpServer((_request, response) => {
      sendProviderJson(response, 500, { unexpected: true });
    });
    const gateway = new OllamaGateway(
      createProviderConfig({ kind: "ollama", model: "test-model", baseUrl: server.baseUrl }),
    );
    const controller = new AbortController();
    controller.abort("operator cancelled");

    await expect(gateway.generateStructured(generationRequest, controller.signal)).rejects.toEqual(
      expect.objectContaining({ code: "CANCELLED" }),
    );
    expect(server.requests).toHaveLength(0);
  });

  it("does not follow provider redirects", async () => {
    server = await startProviderHttpServer((request, response) => {
      if (request.url === "/followed") {
        sendProviderJson(response, 200, { message: { content: "unsafe follow" } });
        return;
      }
      response.writeHead(307, {
        location: `${server?.baseUrl}followed`,
        "content-type": "application/json",
      });
      response.end('{"redirect":true}');
    });
    const gateway = new OllamaGateway(
      createProviderConfig({ kind: "ollama", model: "test-model", baseUrl: server.baseUrl }),
    );

    await expect(gateway.generateStructured(generationRequest)).rejects.toEqual(
      expect.objectContaining({ code: "PROVIDER_HTTP_ERROR", details: { status: 307 } }),
    );
    expect(server.requests.map((request) => request.url)).toEqual(["/api/chat"]);
  });

  it("rejects malformed JSON responses", async () => {
    server = await startProviderHttpServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"message":');
    });
    const gateway = new OllamaGateway(
      createProviderConfig({ kind: "ollama", model: "test-model", baseUrl: server.baseUrl }),
    );

    await expect(gateway.generateStructured(generationRequest)).rejects.toEqual(
      expect.objectContaining({ code: "PROVIDER_PROTOCOL_ERROR" }),
    );
  });

  it("times out a request that never produces a response", async () => {
    server = await startProviderHttpServer(() => {
      // Intentionally leave the response open until the gateway aborts it.
    });
    const gateway = new OllamaGateway(
      createProviderConfig({ kind: "ollama", model: "test-model", baseUrl: server.baseUrl }),
    );

    await expect(
      gateway.generateStructured({ ...generationRequest, timeoutMs: 25 }),
    ).rejects.toEqual(expect.objectContaining({ code: "PROVIDER_TIMEOUT" }));
    expect(server.requests).toHaveLength(1);
  });

  it("rejects negative or non-integral token usage", async () => {
    server = await startProviderHttpServer((_request, response) => {
      sendProviderJson(response, 200, {
        message: { content: '{"replaceText":"ok"}' },
        prompt_eval_count: -1,
        eval_count: 1.5,
      });
    });
    const gateway = new OllamaGateway(
      createProviderConfig({ kind: "ollama", model: "test-model", baseUrl: server.baseUrl }),
    );

    await expect(gateway.generateStructured(generationRequest)).rejects.toEqual(
      expect.objectContaining({ code: "PROVIDER_PROTOCOL_ERROR" }),
    );
  });
});
