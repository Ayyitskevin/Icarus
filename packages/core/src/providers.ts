import { sha256 } from "./digest.js";
import { errorMessage, IcarusError, invariant } from "./errors.js";
import {
  calculateReportedCost,
  type ModelGateway,
  parseProviderBaseUrl,
  providerCredentialEnvironmentName,
  type StructuredGenerationRequest,
  type StructuredGenerationResult,
} from "./provider.js";
import { sanitizeText } from "./redaction.js";
import type { ProviderConfig, ProviderKind } from "./types.js";

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
    // The body was read, so it exists. Discarding it on failure leaves every failure
    // with the same status indistinguishable, even when one carried actionable
    // provider diagnostics. Retain a FINGERPRINT, never the upstream text: a byte
    // count and a digest identify and compare a failure without copying provider
    // content -- which may hold prompt echoes or credentials -- into an error.
    const bodyFingerprint = {
      bodyBytes: Buffer.byteLength(body, "utf8"),
      bodySha256: sha256(body),
    } as const;
    if (!response.ok) {
      throw new IcarusError("PROVIDER_HTTP_ERROR", `Provider returned HTTP ${response.status}`, {
        status: response.status,
        ...bodyFingerprint,
      });
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      throw new IcarusError("PROVIDER_PROTOCOL_ERROR", "Provider response is not JSON", {
        contentType: contentType.split(";", 1)[0] ?? "",
        ...bodyFingerprint,
      });
    }
    try {
      return {
        value: JSON.parse(body) as unknown,
        latencyMs: Math.round(performance.now() - startedAt),
      };
    } catch (error) {
      // Distinguish WHERE the JSON broke. Two malformed payloads that fail at the same
      // offset are the same defect; two that fail at different offsets are not.
      throw new IcarusError("PROVIDER_PROTOCOL_ERROR", "Provider response contains invalid JSON", {
        ...bodyFingerprint,
        parseError: sanitizeText(errorMessage(error), knownSecrets),
      });
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

const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Anthropic Messages adapter. The Messages API has no strict JSON-schema
 * response mode, so the schema is enforced by a single forced tool call whose
 * input schema is the requested structure. Tool use is not exposed to the run:
 * the tool is a transport for structured output, and its input is returned as
 * text for the same validators every other adapter's output passes through.
 */
export class AnthropicMessagesGateway implements ModelGateway {
  readonly config: ProviderConfig;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;

  constructor(
    config: ProviderConfig,
    apiKey: string,
    fetchImplementation: typeof fetch = globalThis.fetch,
  ) {
    invariant(
      config.kind === "anthropic",
      "PROVIDER_MISMATCH",
      "Anthropic gateway received the wrong provider config",
    );
    invariant(apiKey.length > 0, "ANTHROPIC_API_KEY_REQUIRED", "ANTHROPIC_API_KEY is required");
    invariant(
      apiKey.length >= 8 && apiKey.length <= 512 && !/[\s\0]/.test(apiKey),
      "ANTHROPIC_API_KEY_INVALID",
      "ANTHROPIC_API_KEY must contain 8 to 512 non-whitespace characters",
    );
    const { url, locality } = parseProviderBaseUrl(config.baseUrl);
    invariant(
      locality === "loopback" ||
        (url.protocol === "https:" &&
          url.hostname.toLowerCase() === "api.anthropic.com" &&
          (url.port === "" || url.port === "443")),
      "ANTHROPIC_ORIGIN_DENIED",
      "Remote Anthropic credentials may only be sent to api.anthropic.com",
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
      endpoint(this.config.baseUrl, "messages"),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "x-api-key": this.#apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model: this.config.model,
          max_tokens: request.maxOutputTokens,
          system: request.instructions,
          messages: [{ role: "user", content: request.input }],
          tools: [
            {
              name: request.schemaName,
              description: "Return the required structured result.",
              input_schema: request.schema,
            },
          ],
          tool_choice: { type: "tool", name: request.schemaName },
        }),
      },
      request.timeoutMs,
      signal,
      [this.#apiKey],
      this.#fetch,
    );
    const object = asObject(response.value, "Anthropic response");
    invariant(
      object.stop_reason !== "refusal",
      "PROVIDER_REFUSAL",
      "Anthropic refused the structured request",
    );
    invariant(
      object.stop_reason !== "max_tokens",
      "PROVIDER_PROTOCOL_ERROR",
      "Anthropic response stopped at the output ceiling",
    );
    invariant(
      Array.isArray(object.content),
      "PROVIDER_PROTOCOL_ERROR",
      "Anthropic response has no content array",
    );

    const structured: string[] = [];
    for (const blockValue of object.content) {
      const block = asObject(blockValue, "Anthropic content block");
      if (block.type !== "tool_use") {
        continue;
      }
      invariant(
        block.name === request.schemaName,
        "PROVIDER_PROTOCOL_ERROR",
        "Anthropic returned an unexpected tool call",
      );
      structured.push(JSON.stringify(block.input));
    }
    invariant(
      structured.length === 1,
      "PROVIDER_PROTOCOL_ERROR",
      "Anthropic response did not contain exactly one structured result",
    );
    const text = structured[0] as string;
    invariant(
      !text.includes(this.#apiKey),
      "PROVIDER_SECRET_DETECTED",
      "Provider output contained credential material and was discarded",
    );
    const usage = asObject(object.usage, "Anthropic usage");
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

/** Operator-attribution seat every Icarus request to Vulcan carries. Vulcan's
 * budget ledger resolves it; the value is non-secret and never leaves the
 * loopback boundary unattributed. */
export const VULCAN_PROVIDER_SEAT = "icarus";

/**
 * Vulcan chat-completions adapter. Vulcan is a loopback-only OpenAI-subset
 * gateway whose closed request contract admits no `response_format`, `tools`,
 * or credential field, so the schema travels in the system message and the
 * response text faces the same downstream validators every other adapter's
 * output passes through. The gateway holds no credential: the loopback bind is
 * the boundary, and the seat is attribution, not authentication. Aliases pass
 * through verbatim — routing to a local or hosted upstream is Vulcan's
 * operator-configured concern, never this adapter's.
 */
export class VulcanChatCompletionsGateway implements ModelGateway {
  readonly config: ProviderConfig;
  readonly #fetch: typeof fetch;

  constructor(config: ProviderConfig, fetchImplementation: typeof fetch = globalThis.fetch) {
    invariant(
      config.kind === "vulcan",
      "PROVIDER_MISMATCH",
      "Vulcan gateway received the wrong provider config",
    );
    const { locality } = parseProviderBaseUrl(config.baseUrl);
    invariant(
      locality === "loopback",
      "VULCAN_ORIGIN_DENIED",
      "Vulcan provider may only target a loopback endpoint",
    );
    this.config = config;
    this.#fetch = fetchImplementation;
  }

  async generateStructured(
    request: StructuredGenerationRequest,
    signal?: AbortSignal,
  ): Promise<StructuredGenerationResult> {
    const response = await fetchJson(
      endpoint(this.config.baseUrl, "chat/completions"),
      {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          model: this.config.model,
          messages: [
            {
              role: "system",
              content: `${request.instructions}\n\nRespond with exactly one JSON object that validates against the JSON Schema named "${request.schemaName}", with no prose, wrapper object, or code fence:\n${JSON.stringify(request.schema)}`,
            },
            { role: "user", content: request.input },
          ],
          max_tokens: request.maxOutputTokens,
          stream: false,
          seat: VULCAN_PROVIDER_SEAT,
        }),
      },
      request.timeoutMs,
      signal,
      [],
      this.#fetch,
    );
    const object = asObject(response.value, "Vulcan response");
    invariant(
      Array.isArray(object.choices) && object.choices.length === 1,
      "PROVIDER_PROTOCOL_ERROR",
      "Vulcan response did not contain exactly one choice",
    );
    const choice = asObject(object.choices[0], "Vulcan choice");
    invariant(
      choice.finish_reason !== "length",
      "PROVIDER_PROTOCOL_ERROR",
      "Vulcan response stopped at the output ceiling",
    );
    const message = asObject(choice.message, "Vulcan message");
    if (typeof message.refusal === "string" && message.refusal.length > 0) {
      throw new IcarusError("PROVIDER_REFUSAL", "Vulcan refused the structured request");
    }
    invariant(
      typeof message.content === "string",
      "PROVIDER_PROTOCOL_ERROR",
      "Vulcan response has no message content",
    );
    const usage =
      object.usage === undefined || object.usage === null
        ? null
        : asObject(object.usage, "Vulcan usage");
    const inputTokens = usage === null ? null : optionalCount(usage.prompt_tokens);
    const outputTokens = usage === null ? null : optionalCount(usage.completion_tokens);
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

function credentialValue(kind: ProviderKind, environment: NodeJS.ProcessEnv): string {
  const name = providerCredentialEnvironmentName(kind);
  return name === null ? "" : (environment[name] ?? "");
}

export function createGateway(
  config: ProviderConfig,
  environment: NodeJS.ProcessEnv,
): ModelGateway {
  if (config.kind === "ollama") {
    return new OllamaGateway(config);
  }
  if (config.kind === "anthropic") {
    return new AnthropicMessagesGateway(config, credentialValue("anthropic", environment));
  }
  if (config.kind === "vulcan") {
    return new VulcanChatCompletionsGateway(config);
  }
  return new OpenAIResponsesGateway(config, credentialValue("openai", environment));
}
