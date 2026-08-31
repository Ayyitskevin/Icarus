import { afterEach, describe, expect, it } from "vitest";

import type { StructuredGenerationRequest } from "../../packages/core/src/provider.js";
import { createProviderConfig } from "../../packages/core/src/provider.js";
import {
  VULCAN_PROVIDER_SEAT,
  VulcanChatCompletionsGateway,
} from "../../packages/core/src/providers.js";
import {
  type ProviderHttpServer,
  parseProviderRequestBody,
  sendProviderJson,
  startProviderHttpServer,
} from "../support/provider-http.js";

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

// Vulcan's closed request contract has no response_format or tools field, so
// the schema can only travel inside the system message. The response text then
// faces the same downstream validators every other adapter's output does.
const expectedSystemContent = `${generationRequest.instructions}\n\nRespond with exactly one JSON object that validates against the JSON Schema named "${generationRequest.schemaName}", with no prose, wrapper object, or code fence:\n${JSON.stringify(generationRequest.schema)}`;

describe("VulcanChatCompletionsGateway HTTP contract", () => {
  let server: ProviderHttpServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("sends the exact seated payload, passes the alias through, and extracts text and usage", async () => {
    server = await startProviderHttpServer((_request, response) => {
      sendProviderJson(response, 200, {
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: '{"summary":"one edit","steps":["replace"]}',
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 21, completion_tokens: 9, total_tokens: 30 },
      });
    });
    // The model is a Vulcan alias, not a raw model tag. It must pass through
    // verbatim: alias resolution is Vulcan's operator-configured concern.
    const config = createProviderConfig({
      kind: "vulcan",
      model: "code",
      baseUrl: server.baseUrl,
    });

    const result = await new VulcanChatCompletionsGateway(config).generateStructured(
      generationRequest,
    );

    expect(result.text).toBe('{"summary":"one edit","steps":["replace"]}');
    expect(result.usage).toMatchObject({ inputTokens: 21, outputTokens: 9 });
    // A loopback config prices at zero: Icarus records no spend here because
    // Vulcan's own budget ledger meters hosted aliases against the seat.
    expect(result.usage.estimatedCostUsd).toBe(0);
    expect(result.usage.latencyMs).toBeGreaterThanOrEqual(0);
    expect(server.requests).toHaveLength(1);
    const captured = server.requests[0];
    expect(captured).toBeDefined();
    expect(captured?.method).toBe("POST");
    expect(captured?.url).toBe("/chat/completions");
    expect(captured?.headers.accept).toBe("application/json");
    expect(captured?.headers["content-type"]).toBe("application/json");
    // No credential exists at this boundary, so none may be attached.
    expect(captured?.headers.authorization).toBeUndefined();
    // The seat is attribution, not authentication: every request must carry it
    // so Vulcan can meter Icarus traffic under the operator's budgets.
    expect(VULCAN_PROVIDER_SEAT).toBe("icarus");
    expect(captured === undefined ? undefined : parseProviderRequestBody(captured)).toEqual({
      model: "code",
      messages: [
        { role: "system", content: expectedSystemContent },
        { role: "user", content: generationRequest.input },
      ],
      max_tokens: generationRequest.maxOutputTokens,
      stream: false,
      seat: VULCAN_PROVIDER_SEAT,
    });
  });

  it("prices reported usage with explicit positive host-catalog rates", async () => {
    server = await startProviderHttpServer((_request, response) => {
      sendProviderJson(response, 200, {
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: '{"summary":"priced","steps":[]}' },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 21, completion_tokens: 9, total_tokens: 30 },
      });
    });
    const gateway = new VulcanChatCompletionsGateway(
      createProviderConfig({
        kind: "vulcan",
        model: "code",
        baseUrl: server.baseUrl,
        inputUsdPerMillionTokens: 3,
        outputUsdPerMillionTokens: 15,
      }),
    );

    const result = await gateway.generateStructured(generationRequest);

    expect(result.usage).toMatchObject({
      inputTokens: 21,
      outputTokens: 9,
      estimatedCostUsd: 0.000198,
    });
    expect(server.requests).toHaveLength(1);
  });

  it("refuses a non-loopback base URL before any transport", async () => {
    // The loopback-only rule is what makes a credential-free adapter safe:
    // planning prompts must not leave the host through this gateway.
    const config = createProviderConfig({
      kind: "vulcan",
      model: "code",
      baseUrl: "https://vulcan.example.com/v1/",
      inputUsdPerMillionTokens: 1,
      outputUsdPerMillionTokens: 1,
    });
    let fetchCalled = false;
    const fetchImplementation = (() => {
      fetchCalled = true;
      return Promise.reject(new Error("transport must not run"));
    }) as typeof fetch;

    expect(() => new VulcanChatCompletionsGateway(config, fetchImplementation)).toThrow(
      expect.objectContaining({ code: "VULCAN_ORIGIN_DENIED" }),
    );
    expect(fetchCalled).toBe(false);
  });

  it("does not issue a request when the caller signal is already aborted", async () => {
    server = await startProviderHttpServer((_request, response) => {
      sendProviderJson(response, 500, { unexpected: true });
    });
    const gateway = new VulcanChatCompletionsGateway(
      createProviderConfig({ kind: "vulcan", model: "code", baseUrl: server.baseUrl }),
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
          choices: [{ message: { content: "unsafe follow" }, finish_reason: "stop" }],
        });
        return;
      }
      response.writeHead(302, {
        location: `${server?.baseUrl}followed`,
        "content-type": "application/json",
      });
      response.end('{"redirect":true}');
    });
    const gateway = new VulcanChatCompletionsGateway(
      createProviderConfig({ kind: "vulcan", model: "code", baseUrl: server.baseUrl }),
    );

    await expect(gateway.generateStructured(generationRequest)).rejects.toEqual(
      expect.objectContaining({
        code: "PROVIDER_HTTP_ERROR",
        details: expect.objectContaining({ status: 302 }),
      }),
    );
    expect(server.requests.map((request) => request.url)).toEqual(["/chat/completions"]);
  });

  it("rejects a response truncated at the output ceiling", async () => {
    // A truncated JSON plan must fail at the adapter; half a plan reaching the
    // downstream validators would be a parse error with no provenance.
    server = await startProviderHttpServer((_request, response) => {
      sendProviderJson(response, 200, {
        choices: [{ message: { content: '{"summary":' }, finish_reason: "length" }],
        usage: { prompt_tokens: 21, completion_tokens: 96, total_tokens: 117 },
      });
    });
    const gateway = new VulcanChatCompletionsGateway(
      createProviderConfig({ kind: "vulcan", model: "code", baseUrl: server.baseUrl }),
    );

    await expect(gateway.generateStructured(generationRequest)).rejects.toEqual(
      expect.objectContaining({ code: "PROVIDER_PROTOCOL_ERROR" }),
    );
  });

  it("reports a structured refusal without persisting its text", async () => {
    const refusalText = "Sensitive provider refusal detail";
    server = await startProviderHttpServer((_request, response) => {
      sendProviderJson(response, 200, {
        choices: [
          {
            message: { role: "assistant", content: null, refusal: refusalText },
            finish_reason: "stop",
          },
        ],
      });
    });
    const gateway = new VulcanChatCompletionsGateway(
      createProviderConfig({ kind: "vulcan", model: "code", baseUrl: server.baseUrl }),
    );

    const error = await gateway
      .generateStructured(generationRequest)
      .catch((reason: unknown) => reason);

    expect(error).toEqual(expect.objectContaining({ code: "PROVIDER_REFUSAL" }));
    expect((error as Error).message).not.toContain(refusalText);
  });

  it("reports null usage when the response carries none", async () => {
    server = await startProviderHttpServer((_request, response) => {
      sendProviderJson(response, 200, {
        choices: [{ message: { content: '{"summary":"ok","steps":[]}' }, finish_reason: "stop" }],
      });
    });
    const gateway = new VulcanChatCompletionsGateway(
      createProviderConfig({ kind: "vulcan", model: "code", baseUrl: server.baseUrl }),
    );

    const result = await gateway.generateStructured(generationRequest);

    expect(result.text).toBe('{"summary":"ok","steps":[]}');
    expect(result.usage).toMatchObject({
      inputTokens: null,
      outputTokens: null,
      estimatedCostUsd: null,
    });
  });

  it("rejects a response without exactly one choice", async () => {
    server = await startProviderHttpServer((_request, response) => {
      sendProviderJson(response, 200, { choices: [] });
    });
    const gateway = new VulcanChatCompletionsGateway(
      createProviderConfig({ kind: "vulcan", model: "code", baseUrl: server.baseUrl }),
    );

    await expect(gateway.generateStructured(generationRequest)).rejects.toEqual(
      expect.objectContaining({ code: "PROVIDER_PROTOCOL_ERROR" }),
    );
  });

  it("rejects negative or non-integral token usage", async () => {
    server = await startProviderHttpServer((_request, response) => {
      sendProviderJson(response, 200, {
        choices: [{ message: { content: '{"summary":"ok","steps":[]}' }, finish_reason: "stop" }],
        usage: { prompt_tokens: -1, completion_tokens: 1.5 },
      });
    });
    const gateway = new VulcanChatCompletionsGateway(
      createProviderConfig({ kind: "vulcan", model: "code", baseUrl: server.baseUrl }),
    );

    await expect(gateway.generateStructured(generationRequest)).rejects.toEqual(
      expect.objectContaining({ code: "PROVIDER_PROTOCOL_ERROR" }),
    );
  });
});
