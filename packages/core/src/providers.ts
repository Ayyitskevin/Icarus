import { errorMessage, IcarusError, invariant } from "./errors.js";
import {
  calculateReportedCost,
  type ModelGateway,
  parseProviderBaseUrl,
  type StructuredGenerationRequest,
  type StructuredGenerationResult,
} from "./provider.js";
import { sanitizeText } from "./redaction.js";
import type { ProviderConfig } from "./types.js";

const MAX_PROVIDER_RESPONSE_BYTES = 1024 * 1024;

function endpoint(baseUrl: string, suffix: string): URL {
  const normalized = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(suffix, normalized);
}

function asObject(value: unknown, name: string): Record<string, unknown> {
  invariant(
    typeof value === "object" && value !== null && !Array.isArray(value),
    "PROVIDER_PROTOCOL_ERROR",
    `${name} must be an object`,
  );
  return value as Record<string, unknown>;
}

function optionalCount(value: unknown): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  invariant(
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
    "PROVIDER_PROTOCOL_ERROR",
    "Provider token count is invalid",
  );
  return value;
}

async function readBoundedBody(response: Response): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number.parseInt(declaredLength, 10);
    invariant(
      Number.isSafeInteger(length) && length <= MAX_PROVIDER_RESPONSE_BYTES,
      "PROVIDER_RESPONSE_TOO_LARGE",
      "Provider response exceeds the byte ceiling",
    );
  }
  invariant(response.body !== null, "PROVIDER_PROTOCOL_ERROR", "Provider returned an empty body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.length;
    invariant(
      total <= MAX_PROVIDER_RESPONSE_BYTES,
      "PROVIDER_RESPONSE_TOO_LARGE",
      "Provider response exceeds the byte ceiling",
    );
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(body);
}

async function fetchJson(
  url: URL,
  init: RequestInit,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  knownSecrets: readonly string[],
  fetchImplementation: typeof fetch = globalThis.fetch,
): Promise<{ value: unknown; latencyMs: number }> {
  if (signal?.aborted) {
    throw new IcarusError("CANCELLED", "Provider request was cancelled before it started");
  }
  const controller = new AbortController();
  const onAbort = (): void => controller.abort(signal?.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(
    () => controller.abort(new Error("Provider request timed out")),
    timeoutMs,
  );
  timeout.unref();
  const startedAt = performance.now();
  try {
    let response: Response;
    try {
      response = await fetchImplementation(url, {
        ...init,
        redirect: "manual",
        signal: controller.signal,
      });
    } catch (error) {
      throw new IcarusError(
        "PROVIDER_TRANSPORT_ERROR",
        `Provider transport failed: ${sanitizeText(errorMessage(error), knownSecrets)}`,
      );
    }
    const body = await readBoundedBody(response);
    if (!response.ok) {
      throw new IcarusError("PROVIDER_HTTP_ERROR", `Provider returned HTTP ${response.status}`, {
        status: response.status,
      });
    }
    const contentType = response.headers.get("content-type") ?? "";
    invariant(
      contentType.includes("application/json"),
      "PROVIDER_PROTOCOL_ERROR",
      "Provider response is not JSON",
    );
    try {
      return {
        value: JSON.parse(body) as unknown,
        latencyMs: Math.round(performance.now() - startedAt),
      };
    } catch {
      throw new IcarusError("PROVIDER_PROTOCOL_ERROR", "Provider response contains invalid JSON");
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new IcarusError(
        signal?.aborted ? "CANCELLED" : "PROVIDER_TIMEOUT",
        "Provider request was interrupted",
      );
    }
    if (error instanceof IcarusError) {
      throw error;
    }
    throw new IcarusError(
      "PROVIDER_TRANSPORT_ERROR",
      `Provider transport failed: ${sanitizeText(errorMessage(error), knownSecrets)}`,
    );
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
}

export class OllamaGateway implements ModelGateway {
  readonly config: ProviderConfig;

  constructor(config: ProviderConfig) {
    invariant(
      config.kind === "ollama",
      "PROVIDER_MISMATCH",
      "Ollama gateway received the wrong provider config",
    );
    this.config = config;
  }

  async generateStructured(
    request: StructuredGenerationRequest,
    signal?: AbortSignal,
  ): Promise<StructuredGenerationResult> {
    const response = await fetchJson(
      endpoint(this.config.baseUrl, "api/chat"),
      {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          model: this.config.model,
          stream: false,
          think: false,
          format: request.schema,
          messages: [
            { role: "system", content: request.instructions },
            { role: "user", content: request.input },
          ],
          options: { num_predict: request.maxOutputTokens },
        }),
      },
      request.timeoutMs,
      signal,
      [],
    );
    const object = asObject(response.value, "Ollama response");
    const message = asObject(object.message, "Ollama message");
    invariant(
      typeof message.content === "string",
      "PROVIDER_PROTOCOL_ERROR",
      "Ollama response has no message content",
    );
    const inputTokens = optionalCount(object.prompt_eval_count);
    const outputTokens = optionalCount(object.eval_count);
    return {
      text: message.content,
      usage: {
        inputTokens,
        outputTokens,
        estimatedCostUsd: calculateReportedCost(this.config, inputTokens, outputTokens),
        latencyMs: response.latencyMs,
      },
    };
  }
}

export class OpenAIResponsesGateway implements ModelGateway {
  readonly config: ProviderConfig;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;

  constructor(
    config: ProviderConfig,
    apiKey: string,
    fetchImplementation: typeof fetch = globalThis.fetch,
  ) {
    invariant(
      config.kind === "openai",
      "PROVIDER_MISMATCH",
      "OpenAI gateway received the wrong provider config",
    );
    invariant(apiKey.length > 0, "OPENAI_API_KEY_REQUIRED", "OPENAI_API_KEY is required");
    invariant(
      apiKey.length >= 8 && apiKey.length <= 512 && !/[\s\0]/.test(apiKey),
      "OPENAI_API_KEY_INVALID",
      "OPENAI_API_KEY must contain 8 to 512 non-whitespace characters",
    );
    const { url, locality } = parseProviderBaseUrl(config.baseUrl);
    invariant(
      locality === "loopback" ||
        (url.protocol === "https:" &&
          url.hostname.toLowerCase() === "api.openai.com" &&
          (url.port === "" || url.port === "443")),
      "OPENAI_ORIGIN_DENIED",
      "Remote OpenAI credentials may only be sent to api.openai.com",
    );
    this.config = config;
    this.#apiKey = apiKey;
    this.#fetch = fetchImplementation;
  }

  async generateStructured(
    request: StructuredGenerationRequest,
    signal?: AbortSignal,
  ): Promise<StructuredGenerationResult> {
    const response = await fetchJson(
      endpoint(this.config.baseUrl, "responses"),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: `Bearer ${this.#apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          instructions: request.instructions,
          input: request.input,
          text: {
            format: {
              type: "json_schema",
              name: request.schemaName,
              strict: true,
              schema: request.schema,
            },
          },
          max_output_tokens: request.maxOutputTokens,
          store: false,
          tools: [],
          tool_choice: "none",
          truncation: "disabled",
        }),
      },
      request.timeoutMs,
      signal,
      [this.#apiKey],
      this.#fetch,
    );
    const object = asObject(response.value, "OpenAI response");
    invariant(
      object.status === "completed",
      "PROVIDER_PROTOCOL_ERROR",
      "OpenAI response did not complete",
    );
    invariant(
      Array.isArray(object.output),
      "PROVIDER_PROTOCOL_ERROR",
      "OpenAI response has no output array",
    );

    const textParts: string[] = [];
    for (const itemValue of object.output) {
      const item = asObject(itemValue, "OpenAI output item");
      if (item.type !== "message" || !Array.isArray(item.content)) {
        continue;
      }
      for (const contentValue of item.content) {
        const content = asObject(contentValue, "OpenAI content item");
        if (content.type === "refusal") {
          throw new IcarusError("PROVIDER_REFUSAL", "OpenAI refused the structured request");
        }
        if (content.type === "output_text" && typeof content.text === "string") {
          textParts.push(content.text);
        }
      }
    }
    invariant(
      textParts.length > 0,
      "PROVIDER_PROTOCOL_ERROR",
      "OpenAI response has no output text",
    );
    const text = textParts.join("");
    invariant(
      !text.includes(this.#apiKey),
      "PROVIDER_SECRET_DETECTED",
      "Provider output contained credential material and was discarded",
    );
    const usage = asObject(object.usage, "OpenAI usage");
    const inputTokens = optionalCount(usage.input_tokens);
    const outputTokens = optionalCount(usage.output_tokens);
    return {
      text,
      usage: {
        inputTokens,
        outputTokens,
        estimatedCostUsd: calculateReportedCost(this.config, inputTokens, outputTokens),
        latencyMs: response.latencyMs,
      },
    };
  }
}

export function createGateway(
  config: ProviderConfig,
  environment: NodeJS.ProcessEnv,
): ModelGateway {
  if (config.kind === "ollama") {
    return new OllamaGateway(config);
  }
  return new OpenAIResponsesGateway(config, environment.OPENAI_API_KEY ?? "");
}
