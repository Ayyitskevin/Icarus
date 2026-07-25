import { afterEach, describe, expect, it } from "vitest";

import { IcarusError } from "../../packages/core/src/errors.js";
import type { StructuredGenerationRequest } from "../../packages/core/src/provider.js";
import { createProviderConfig } from "../../packages/core/src/provider.js";
import { AnthropicMessagesGateway } from "../../packages/core/src/providers.js";
import {
  parseProviderRequestBody,
  type ProviderHttpServer,
  sendProviderJson,
  startProviderHttpServer,
} from "../support/provider-http.js";

const apiKey = "test-only-anthropic-key-value-0123456789";
const schema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    steps: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "steps"],
  additionalProperties: false,
};
const generationRequest: StructuredGenerationRequest = {
  schemaName: "icarus_plan",
  schema,
  instructions: "Return a minimal plan.",
  input: "Change exactly one greeting file.",
  maxOutputTokens: 96,
  timeoutMs: 1_000,
};

async function expectCode(promise: Promise<unknown>, code: string): Promise<IcarusError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(IcarusError);
    expect((error as IcarusError).code).toBe(code);
    return error as IcarusError;
  }
  throw new Error(`Expected ${code}`);
}

describe("AnthropicMessagesGateway HTTP contract", () => {
  let server: ProviderHttpServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("forces one schema-bound tool call and returns its input as structured text", async () => {
    server = await startProviderHttpServer((_request, response) => {
      sendProviderJson(response, 200, {
        stop_reason: "tool_use",
        content: [
          { type: "text", text: "ignored prose" },
          {
            type: "tool_use",
            id: "toolu_1",
            name: "icarus_plan",
            input: { summary: "one edit", steps: ["replace"] },
          },
        ],
        usage: { input_tokens: 11, output_tokens: 7 },
      });
    });
    const config = createProviderConfig({
      kind: "anthropic",
      model: "claude-sonnet-4",
      baseUrl: server.baseUrl,
      inputUsdPerMillionTokens: 2,
      outputUsdPerMillionTokens: 4,
    });

    const result = await new AnthropicMessagesGateway(config, apiKey).generateStructured(
      generationRequest,
    );

    expect(JSON.parse(result.text)).toEqual({ summary: "one edit", steps: ["replace"] });
    expect(result.usage).toMatchObject({ inputTokens: 11, outputTokens: 7 });
    expect(result.usage.estimatedCostUsd).toBeCloseTo(0.000_05, 10);
    expect(server.requests).toHaveLength(1);
    const captured = server.requests[0];
    expect(captured?.method).toBe("POST");
    expect(captured?.url).toBe("/messages");
    expect(captured?.headers["x-api-key"]).toBe(apiKey);
    expect(captured?.headers["anthropic-version"]).toBe("2023-06-01");
    expect(captured?.headers.authorization).toBeUndefined();
    expect(captured === undefined ? undefined : parseProviderRequestBody(captured)).toEqual({
      model: "claude-sonnet-4",
      max_tokens: 96,
      system: "Return a minimal plan.",
      messages: [{ role: "user", content: "Change exactly one greeting file." }],
      tools: [
        {
          name: "icarus_plan",
          description: "Return the required structured result.",
          input_schema: schema,
        },
      ],
      tool_choice: { type: "tool", name: "icarus_plan" },
    });
  });

  it("rejects a response that stopped at the output ceiling", async () => {
    server = await startProviderHttpServer((_request, response) => {
      sendProviderJson(response, 200, {
        stop_reason: "max_tokens",
        content: [{ type: "tool_use", name: "icarus_plan", input: { summary: "cut" } }],
        usage: { input_tokens: 3, output_tokens: 96 },
      });
    });
    const config = createProviderConfig({
      kind: "anthropic",
      model: "claude-sonnet-4",
      baseUrl: server.baseUrl,
      inputUsdPerMillionTokens: 1,
      outputUsdPerMillionTokens: 1,
    });

    await expectCode(
      new AnthropicMessagesGateway(config, apiKey).generateStructured(generationRequest),
      "PROVIDER_PROTOCOL_ERROR",
    );
  });

  it("reports a refusal without copying its text", async () => {
    server = await startProviderHttpServer((_request, response) => {
      sendProviderJson(response, 200, {
        stop_reason: "refusal",
        content: [{ type: "text", text: "refusal detail that must not surface" }],
        usage: { input_tokens: 3, output_tokens: 1 },
      });
    });
    const config = createProviderConfig({
      kind: "anthropic",
      model: "claude-sonnet-4",
      baseUrl: server.baseUrl,
      inputUsdPerMillionTokens: 1,
      outputUsdPerMillionTokens: 1,
    });

    const error = await expectCode(
      new AnthropicMessagesGateway(config, apiKey).generateStructured(generationRequest),
      "PROVIDER_REFUSAL",
    );
    expect(JSON.stringify(error)).not.toContain("refusal detail");
  });

  it("rejects a response without exactly one structured tool result", async () => {
    server = await startProviderHttpServer((_request, response) => {
      sendProviderJson(response, 200, {
        stop_reason: "end_turn",
        content: [{ type: "text", text: '{"summary":"prose instead of a tool call"}' }],
        usage: { input_tokens: 3, output_tokens: 4 },
      });
    });
    const config = createProviderConfig({
      kind: "anthropic",
      model: "claude-sonnet-4",
      baseUrl: server.baseUrl,
      inputUsdPerMillionTokens: 1,
      outputUsdPerMillionTokens: 1,
    });

    await expectCode(
      new AnthropicMessagesGateway(config, apiKey).generateStructured(generationRequest),
      "PROVIDER_PROTOCOL_ERROR",
    );
  });

  it("rejects a tool call that renamed the requested schema", async () => {
    server = await startProviderHttpServer((_request, response) => {
      sendProviderJson(response, 200, {
        stop_reason: "tool_use",
        content: [{ type: "tool_use", name: "other_tool", input: { summary: "x" } }],
        usage: { input_tokens: 3, output_tokens: 4 },
      });
    });
    const config = createProviderConfig({
      kind: "anthropic",
      model: "claude-sonnet-4",
      baseUrl: server.baseUrl,
      inputUsdPerMillionTokens: 1,
      outputUsdPerMillionTokens: 1,
    });

    await expectCode(
      new AnthropicMessagesGateway(config, apiKey).generateStructured(generationRequest),
      "PROVIDER_PROTOCOL_ERROR",
    );
  });

  it("discards output that echoes the credential", async () => {
    server = await startProviderHttpServer((_request, response) => {
      sendProviderJson(response, 200, {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            name: "icarus_plan",
            input: { summary: apiKey, steps: ["replace"] },
          },
        ],
        usage: { input_tokens: 3, output_tokens: 4 },
      });
    });
    const config = createProviderConfig({
      kind: "anthropic",
      model: "claude-sonnet-4",
      baseUrl: server.baseUrl,
      inputUsdPerMillionTokens: 1,
      outputUsdPerMillionTokens: 1,
    });

    const error = await expectCode(
      new AnthropicMessagesGateway(config, apiKey).generateStructured(generationRequest),
      "PROVIDER_SECRET_DETECTED",
    );
    expect(JSON.stringify(error)).not.toContain(apiKey);
  });

  it("never sends remote credentials to an origin other than Anthropic", () => {
    const config = createProviderConfig({
      kind: "anthropic",
      model: "claude-sonnet-4",
      baseUrl: "https://anthropic.example.com/v1/",
      inputUsdPerMillionTokens: 1,
      outputUsdPerMillionTokens: 1,
    });

    expect(() => new AnthropicMessagesGateway(config, apiKey)).toThrow(
      /Remote Anthropic credentials/,
    );
  });

  it("rejects malformed credentials before any transport", async () => {
    server = await startProviderHttpServer((_request, response) => {
      sendProviderJson(response, 200, { stop_reason: "tool_use", content: [], usage: {} });
    });
    const config = createProviderConfig({
      kind: "anthropic",
      model: "claude-sonnet-4",
      baseUrl: server.baseUrl,
      inputUsdPerMillionTokens: 1,
      outputUsdPerMillionTokens: 1,
    });

    expect(() => new AnthropicMessagesGateway(config, "short")).toThrow(/8 to 512 non-whitespace/);
    expect(() => new AnthropicMessagesGateway(config, `${apiKey} with space`)).toThrow(
      /8 to 512 non-whitespace/,
    );
    expect(server.requests).toHaveLength(0);
  });
});
