import { invariant } from "./errors.js";
import type {
  JsonValue,
  ModelCapabilities,
  ProviderConfig,
  ProviderKind,
  ProviderLocality,
  ProviderUsage,
} from "./types.js";

export interface StructuredGenerationRequest {
  readonly schemaName: string;
  readonly schema: JsonValue;
  readonly instructions: string;
  readonly input: string;
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
}

export interface StructuredGenerationResult {
  readonly text: string;
  readonly usage: ProviderUsage;
}

export interface ModelGateway {
  readonly config: ProviderConfig;
  generateStructured(
    request: StructuredGenerationRequest,
    signal?: AbortSignal,
  ): Promise<StructuredGenerationResult>;
}

export function parseProviderBaseUrl(value: string): { url: URL; locality: ProviderLocality } {
  const url = new URL(value);
  invariant(
    url.protocol === "http:" || url.protocol === "https:",
    "INVALID_PROVIDER_URL",
    "Provider URL must use HTTP(S)",
  );
  invariant(
    url.username === "" && url.password === "",
    "INVALID_PROVIDER_URL",
    "Provider URL must not embed credentials",
  );
  invariant(
    url.search === "" && url.hash === "",
    "INVALID_PROVIDER_URL",
    "Provider URL must not contain query or fragment data",
  );
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const loopback =
    hostname === "localhost" || hostname === "::1" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
  return { url, locality: loopback ? "loopback" : "remote" };
}

export function createProviderConfig(input: {
  readonly kind: ProviderKind;
  readonly model: string;
  readonly baseUrl: string;
  readonly inputUsdPerMillionTokens?: number | null;
  readonly outputUsdPerMillionTokens?: number | null;
}): ProviderConfig {
  invariant(
    input.model.trim().length > 0 && input.model.length <= 256 && !/[\r\n\0]/.test(input.model),
    "INVALID_MODEL",
    "Model ID is invalid",
  );
  const { url, locality } = parseProviderBaseUrl(input.baseUrl);
  const isRemote = locality === "remote";
  invariant(
    !isRemote || url.protocol === "https:",
    "INSECURE_PROVIDER_URL",
    "Remote provider URLs must use HTTPS",
  );
  const capabilities: ModelCapabilities = {
    contextSize: null,
    toolSupport: false,
    visionSupport: false,
    structuredOutputSupport: true,
    streamingSupport: false,
    costClass: isRemote ? "configured_remote" : "local",
    latencyClass: isRemote ? "remote" : "local",
    privacyClass: isRemote ? "remote_api" : "local_process",
    reasoningQuality: "unknown",
    locality,
  };
  const inputRate = input.inputUsdPerMillionTokens ?? (isRemote ? null : 0);
  const outputRate = input.outputUsdPerMillionTokens ?? (isRemote ? null : 0);
  if (isRemote) {
    invariant(
      inputRate !== null && outputRate !== null,
      "PRICING_REQUIRED",
      "Remote providers require explicit token rates",
    );
  }
  invariant(
    inputRate === null || (Number.isFinite(inputRate) && inputRate >= 0),
    "INVALID_PRICING",
    "Input token rate is invalid",
  );
  invariant(
    outputRate === null || (Number.isFinite(outputRate) && outputRate >= 0),
    "INVALID_PRICING",
    "Output token rate is invalid",
  );
  return {
    kind: input.kind,
    model: input.model,
    baseUrl: url.toString(),
    inputUsdPerMillionTokens: inputRate,
    outputUsdPerMillionTokens: outputRate,
    capabilities,
  };
}

export function estimateWorstCaseCost(
  config: ProviderConfig,
  inputBytes: number,
  maxOutputTokens: number,
): number {
  const inputRate = config.inputUsdPerMillionTokens;
  const outputRate = config.outputUsdPerMillionTokens;
  invariant(
    inputRate !== null && outputRate !== null,
    "PRICING_REQUIRED",
    "Provider pricing is not configured",
  );
  const conservativeInputTokens = inputBytes;
  return (conservativeInputTokens * inputRate + maxOutputTokens * outputRate) / 1_000_000;
}

export function calculateReportedCost(
  config: ProviderConfig,
  inputTokens: number | null,
  outputTokens: number | null,
): number | null {
  if (
    inputTokens === null ||
    outputTokens === null ||
    config.inputUsdPerMillionTokens === null ||
    config.outputUsdPerMillionTokens === null
  ) {
    return null;
  }
  return (
    (inputTokens * config.inputUsdPerMillionTokens +
      outputTokens * config.outputUsdPerMillionTokens) /
    1_000_000
  );
}
