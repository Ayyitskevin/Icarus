import { afterEach, describe, expect, it } from "vitest";

import { IcarusError } from "../../packages/core/src/errors.js";
import type { StructuredGenerationRequest } from "../../packages/core/src/provider.js";
import { createProviderConfig } from "../../packages/core/src/provider.js";
import { OpenAIResponsesGateway } from "../../packages/core/src/providers.js";
import {
  type ProviderHttpServer,
  parseProviderRequestBody,
  sendProviderJson,
  startProviderHttpServer,
} from "../support/provider-http.js";

const apiKey = "test-only-openai-key-value-0123456789";
const generationRequest: StructuredGenerationRequest = {
  schemaName: "m1_plan",
  schema: {
    type: "object",
    properties: {
      summary: { type: "string" },
      steps: { type: "array", items: { type: "string" } },
    },
    required: ["summary", "steps"],
    additionalProperties: false,
  },
  instructions: "Return a minimal plan.",
  input: "Change exactly one greeting file.",
  maxOutputTokens: 96,
  timeoutMs: 1_000,
};

describe("OpenAIResponsesGateway HTTP contract", () => {
  let server: ProviderHttpServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("sends the exact safe Responses payload and extracts output text and usage", async () => {
    server = await startProviderHttpServer((_request, response) => {
      sendProviderJson(response, 200, {
        status: "completed",
        output: [
          {
            type: "message",
            content: [
              { type: "output_text", text: '{"summary":"one edit",' },
              { type: "output_text", text: '"steps":["replace"]}' },
            ],
          },
        ],
        usage: { input_tokens: 11, output_tokens: 7 },
      });
    });
    const config = createProviderConfig({
      kind: "openai",
      model: "gpt-5-mini",
      baseUrl: server.baseUrl,
      inputUsdPerMillionTokens: 2,
      outputUsdPerMillionTokens: 4,
    });

    const result = await new OpenAIResponsesGateway(config, apiKey).generateStructured(
      generationRequest,
    );

    expect(result.text).toBe('{"summary":"one edit","steps":["replace"]}');
    expect(result.usage).toMatchObject({ inputTokens: 11, outputTokens: 7 });
    expect(result.usage.estimatedCostUsd).toBeCloseTo(0.000_05, 10);
    expect(result.usage.latencyMs).toBeGreaterThanOrEqual(0);
    expect(server.requests).toHaveLength(1);
    const captured = server.requests[0];
    expect(captured).toBeDefined();
    expect(captured?.method).toBe("POST");
    expect(captured?.url).toBe("/responses");
    expect(captured?.headers.authorization).toBe(`Bearer ${apiKey}`);
    expect(captured?.headers.accept).toBe("application/json");
    expect(captured?.headers["content-type"]).toBe("application/json");
    expect(captured === undefined ? undefined : parseProviderRequestBody(captured)).toEqual({
      model: "gpt-5-mini",
      instructions: generationRequest.instructions,
      input: generationRequest.input,
      text: {
        format: {
          type: "json_schema",
          name: generationRequest.schemaName,
          strict: true,
          schema: generationRequest.schema,
        },
      },
      max_output_tokens: generationRequest.maxOutputTokens,
      store: false,
      tools: [],
      tool_choice: "none",
      truncation: "disabled",
    });
  });

  it("does not issue a request when the caller signal is already aborted", async () => {
    server = await startProviderHttpServer((_request, response) => {
      sendProviderJson(response, 500, { unexpected: true });
    });
    const gateway = new OpenAIResponsesGateway(
      createProviderConfig({ kind: "openai", model: "test-model", baseUrl: server.baseUrl }),
      apiKey,
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
        sendProviderJson(response, 200, {
          status: "completed",
          output: [],
          usage: {},
        });
        return;
      }
      response.writeHead(302, {
        location: `${server?.baseUrl}followed`,
        "content-type": "application/json",
      });
      response.end('{"redirect":true}');
    });
    const gateway = new OpenAIResponsesGateway(
      createProviderConfig({ kind: "openai", model: "test-model", baseUrl: server.baseUrl }),
      apiKey,
    );

    await expect(gateway.generateStructured(generationRequest)).rejects.toEqual(
      expect.objectContaining({ code: "PROVIDER_HTTP_ERROR", details: { status: 302 } }),
    );
    expect(server.requests.map((request) => request.url)).toEqual(["/responses"]);
  });

  it("rejects responses larger than the one MiB ceiling", async () => {
    server = await startProviderHttpServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(Buffer.alloc(1024 * 1024 + 1, 32));
    });
    const gateway = new OpenAIResponsesGateway(
      createProviderConfig({ kind: "openai", model: "test-model", baseUrl: server.baseUrl }),
      apiKey,
    );

    await expect(gateway.generateStructured(generationRequest)).rejects.toEqual(
      expect.objectContaining({ code: "PROVIDER_RESPONSE_TOO_LARGE" }),
    );
  });

  it("cancels an in-flight request through the caller signal", async () => {
    const controller = new AbortController();
    server = await startProviderHttpServer(() => {
      queueMicrotask(() => controller.abort("operator cancelled"));
      // Intentionally leave the response open until the gateway observes cancellation.
    });
    const gateway = new OpenAIResponsesGateway(
      createProviderConfig({ kind: "openai", model: "test-model", baseUrl: server.baseUrl }),
      apiKey,
    );

    await expect(gateway.generateStructured(generationRequest, controller.signal)).rejects.toEqual(
      expect.objectContaining({ code: "CANCELLED" }),
    );
    expect(server.requests).toHaveLength(1);
  });

  it("does not expose provider HTTP error bodies", async () => {
    const reflectedCredential = apiKey.replace("test-only-openai-key-value", "npm-value");
    server = await startProviderHttpServer((_request, response) => {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: `invalid bearer ${apiKey}`,
          detail: ["NPM_TOKEN", reflectedCredential].join("="),
        }),
      );
    });
    const gateway = new OpenAIResponsesGateway(
      createProviderConfig({ kind: "openai", model: "test-model", baseUrl: server.baseUrl }),
      apiKey,
    );

    const error = await gateway
      .generateStructured(generationRequest)
      .catch((reason: unknown) => reason);

    expect(error).toEqual(expect.objectContaining({ code: "PROVIDER_HTTP_ERROR" }));
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(apiKey);
    expect((error as Error).message).not.toContain(reflectedCredential);
    expect((error as Error).message).not.toContain("invalid bearer");
    expect((error as Error).message).toBe("Provider returned HTTP 401");
  });

  it("redacts the API key from thrown transport errors", async () => {
    const config = createProviderConfig({
      kind: "openai",
      model: "test-model",
      baseUrl: "https://api.openai.com/v1/",
      inputUsdPerMillionTokens: 1,
      outputUsdPerMillionTokens: 1,
    });
    const throwingFetch = (() =>
      Promise.reject(new Error(`transport rejected bearer ${apiKey}`))) as typeof fetch;
    const gateway = new OpenAIResponsesGateway(config, apiKey, throwingFetch);

    const error = await gateway
      .generateStructured(generationRequest)
      .catch((reason: unknown) => reason);

    expect(error).toEqual(expect.objectContaining({ code: "PROVIDER_TRANSPORT_ERROR" }));
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(apiKey);
    expect((error as Error).message).toContain("<redacted:known-secret>");
  });

  it("rewraps and redacts an IcarusError thrown by the transport", async () => {
    const config = createProviderConfig({
      kind: "openai",
      model: "test-model",
      baseUrl: "https://api.openai.com/v1/",
      inputUsdPerMillionTokens: 1,
      outputUsdPerMillionTokens: 1,
    });
    const throwingFetch = (() =>
      Promise.reject(
        new IcarusError("INJECTED_TRANSPORT_ERROR", `transport rejected bearer ${apiKey}`),
      )) as typeof fetch;
    const gateway = new OpenAIResponsesGateway(config, apiKey, throwingFetch);

    const error = await gateway
      .generateStructured(generationRequest)
      .catch((reason: unknown) => reason);

    expect(error).toEqual(expect.objectContaining({ code: "PROVIDER_TRANSPORT_ERROR" }));
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(apiKey);
    expect((error as Error).message).toContain("<redacted:known-secret>");
  });

  it("reports a structured refusal without persisting its text", async () => {
    const refusalText = "Sensitive provider refusal detail";
    server = await startProviderHttpServer((_request, response) => {
      sendProviderJson(response, 200, {
        status: "completed",
        output: [
          {
            type: "message",
            content: [{ type: "refusal", refusal: refusalText }],
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    });
    const gateway = new OpenAIResponsesGateway(
      createProviderConfig({ kind: "openai", model: "test-model", baseUrl: server.baseUrl }),
      apiKey,
    );

    const error = await gateway
      .generateStructured(generationRequest)
      .catch((reason: unknown) => reason);

    expect(error).toEqual(expect.objectContaining({ code: "PROVIDER_REFUSAL" }));
    expect((error as Error).message).not.toContain(refusalText);
  });

  it("discards a successful response that reflects its credential", async () => {
    server = await startProviderHttpServer((_request, response) => {
      sendProviderJson(response, 200, {
        status: "completed",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: apiKey }],
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    });
    const gateway = new OpenAIResponsesGateway(
      createProviderConfig({ kind: "openai", model: "test-model", baseUrl: server.baseUrl }),
      apiKey,
    );

    const error = await gateway
      .generateStructured(generationRequest)
      .catch((reason: unknown) => reason);

    expect(error).toEqual(expect.objectContaining({ code: "PROVIDER_SECRET_DETECTED" }));
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(apiKey);
  });

  it.each([
    { name: "too short", value: "q7!" },
    { name: "contains whitespace", value: "not a valid key" },
    { name: "too long", value: "x".repeat(513) },
  ])("rejects an API key that is $name before transport", ({ value }) => {
    const config = createProviderConfig({
      kind: "openai",
      model: "test-model",
      baseUrl: "https://api.openai.com/v1/",
      inputUsdPerMillionTokens: 1,
      outputUsdPerMillionTokens: 1,
    });
    let fetchCalled = false;
    const fetchImplementation = (() => {
      fetchCalled = true;
      return Promise.reject(new Error("transport must not run"));
    }) as typeof fetch;

    expect(() => new OpenAIResponsesGateway(config, value, fetchImplementation)).toThrow(
      expect.objectContaining({ code: "OPENAI_API_KEY_INVALID" }),
    );
    expect(fetchCalled).toBe(false);
  });

  it("denies sending OpenAI credentials to a non-OpenAI remote origin", () => {
    const config = createProviderConfig({
      kind: "openai",
      model: "test-model",
      baseUrl: "https://example.com/v1/",
      inputUsdPerMillionTokens: 1,
      outputUsdPerMillionTokens: 1,
    });

    expect(() => new OpenAIResponsesGateway(config, apiKey)).toThrow(
      expect.objectContaining({ code: "OPENAI_ORIGIN_DENIED" }),
    );
  });
});
