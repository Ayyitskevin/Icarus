import { randomUUID } from "node:crypto";
import { parseStrictJson } from "./canonical-json.js";
import { errorMessage, IcarusError, invariant } from "./errors.js";
import type { ModelGateway } from "./provider.js";
import type { JsonValue, ProviderUsage } from "./types.js";

// Model characterization probes (packet E1). A probe measures a configured
// provider/model through the production gateway path. Probes execute no
// repository code, touch no worktree or sandbox, and require no approval or
// grant: their entire blast radius is one HTTP conversation with an
// operator-configured provider and a printed measurement. Results are
// measurements, never authority.
//
// Probe kinds:
//   throughput  structured generation rate through the production adapter
//               (Icarus only ever generates structured output, so structured
//               throughput is the honest number for Icarus usage).
//   context     anchor recall over a deterministic synthetic corpus, plus the
//               provider-reported consumed-input count. Detects silent front
//               truncation: a provider that drops the front of the prompt
//               loses the start anchor while keeping the end anchor, and
//               reports consuming fewer input tokens than were sent.
//   structured  schema compliance across repeated attempts against a fixed
//               nested schema.
//
// Tool-call probing is recognized but unsupported: ModelGateway exposes
// structured generation only, so a tool-call probe cannot be measured through
// the production path today. Per the evaluation reliability rule it returns an
// explicit unsupported result rather than an approximation or a usage error.

export type ProbeKind = "throughput" | "context" | "structured";

export const PROBE_KINDS: readonly ProbeKind[] = ["throughput", "context", "structured"];

// Kinds that are recognized but cannot be measured through the production
// gateway today. Per the evaluation reliability rule they produce an explicit
// unsupported result — a stable machine-readable status, not an argument error
// and never an approximation.
export const UNSUPPORTED_PROBE_KINDS = ["tool-call"] as const;

export type UnsupportedProbeKind = (typeof UNSUPPORTED_PROBE_KINDS)[number];

export const UNSUPPORTED_PROBE_REASONS: Readonly<Record<UnsupportedProbeKind, string>> = {
  "tool-call":
    "ModelGateway exposes structured generation only; tool-call behavior cannot be measured through the production path.",
};

export const PROBE_RESULT_SCHEMA_VERSION = 1;

const MAX_REPEAT = 32;
const MIN_CONTEXT_TARGET_TOKENS = 256;
const MAX_CONTEXT_TARGET_TOKENS = 1_048_576;
// The corpus estimates tokens from characters. Four characters per token is a
// deliberately conservative planning ratio for English prose; the probe never
// treats the estimate as truth — the provider-reported consumed count is the
// measurement, and the estimate only scales the corpus.
const ESTIMATED_CHARS_PER_TOKEN = 4;
// A provider that consumed less than this fraction of the estimated input is
// flagged as suspected truncation even when anchor recall happens to pass.
const TRUNCATION_CONSUMED_RATIO_FLOOR = 0.5;

export interface ProbeRequest {
  readonly kind: ProbeKind | UnsupportedProbeKind;
  readonly repeat: number;
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
  /** Context probe only: approximate prompt size to synthesize. */
  readonly targetInputTokens: number | null;
}

export interface ProbeAttempt {
  readonly attempt: number;
  readonly ok: boolean;
  /** Human-readable outcome; stable prefixes, free-form tail. */
  readonly detail: string;
  readonly usage: ProviderUsage;
  /** Output tokens per second, when the provider reported output tokens. */
  readonly outputTokensPerSecond: number | null;
  /** Context probe: provider-consumed input tokens / estimated sent tokens. */
  readonly consumedInputRatio: number | null;
  /** Context probe: which anchors the model returned correctly. */
  readonly anchorRecall: { start: boolean; middle: boolean; end: boolean } | null;
}

export interface ProbeAggregate {
  readonly attemptCount: number;
  readonly okCount: number;
  readonly meanOutputTokensPerSecond: number | null;
  readonly minConsumedInputRatio: number | null;
  /** Context probe: true when any attempt lost the start anchor or consumed
   * suspiciously little input. Null for other probe kinds. */
  readonly truncationSuspected: boolean | null;
}

export interface ProbeResultV1 {
  readonly schemaVersion: typeof PROBE_RESULT_SCHEMA_VERSION;
  readonly probeId: string;
  readonly startedAt: string;
  /** "measured" when attempts ran; "unsupported" when the kind is recognized
   * but cannot be measured through the production gateway. */
  readonly status: "measured" | "unsupported";
  readonly unsupportedReason: string | null;
  readonly probe: ProbeRequest;
  readonly provider: {
    readonly kind: string;
    readonly baseUrl: string;
    readonly model: string;
  };
  readonly attempts: readonly ProbeAttempt[];
  readonly aggregate: ProbeAggregate;
}

// A provider as *requested*, not as validated. An unsupported probe never
// connects, so it must be describable without pricing, credentials, or a URL
// policy check — that is exactly what made the previous implementation
// provider-dependent: config construction ran first and rejected remote
// providers before the unsupported answer could be given.
export interface ProbeProviderDescriptor {
  readonly kind: string;
  readonly baseUrl: string;
  readonly model: string;
}

export interface ProbeRuntime {
  readonly now?: () => Date;
  readonly createId?: () => string;
}

export function isUnsupportedProbeKind(kind: string): kind is UnsupportedProbeKind {
  return (UNSUPPORTED_PROBE_KINDS as readonly string[]).includes(kind);
}

export function createProbeRequest(input: {
  readonly kind: string;
  readonly repeat?: number | undefined;
  readonly maxOutputTokens?: number | undefined;
  readonly timeoutMs?: number | undefined;
  readonly targetInputTokens?: number | null | undefined;
}): ProbeRequest {
  invariant(
    (PROBE_KINDS as readonly string[]).includes(input.kind) ||
      (UNSUPPORTED_PROBE_KINDS as readonly string[]).includes(input.kind),
    "INVALID_PROBE",
    `Probe kind must be one of: ${[...PROBE_KINDS, ...UNSUPPORTED_PROBE_KINDS].join(", ")}`,
  );
  const kind = input.kind as ProbeKind | UnsupportedProbeKind;
  const repeat = input.repeat ?? 1;
  invariant(
    Number.isInteger(repeat) && repeat >= 1 && repeat <= MAX_REPEAT,
    "INVALID_PROBE",
    `Probe repeat must be an integer between 1 and ${MAX_REPEAT}`,
  );
  const maxOutputTokens = input.maxOutputTokens ?? 512;
  invariant(
    Number.isInteger(maxOutputTokens) && maxOutputTokens >= 16 && maxOutputTokens <= 65_536,
    "INVALID_PROBE",
    "Probe maxOutputTokens must be an integer between 16 and 65536",
  );
  const timeoutMs = input.timeoutMs ?? 600_000;
  invariant(
    Number.isInteger(timeoutMs) && timeoutMs >= 1_000 && timeoutMs <= 7_200_000,
    "INVALID_PROBE",
    "Probe timeoutMs must be an integer between 1000 and 7200000",
  );
  let targetInputTokens: number | null = null;
  if (kind === "context") {
    targetInputTokens = input.targetInputTokens ?? 8_192;
    invariant(
      Number.isInteger(targetInputTokens) &&
        targetInputTokens >= MIN_CONTEXT_TARGET_TOKENS &&
        targetInputTokens <= MAX_CONTEXT_TARGET_TOKENS,
      "INVALID_PROBE",
      `Context probe targetInputTokens must be an integer between ${MIN_CONTEXT_TARGET_TOKENS} and ${MAX_CONTEXT_TARGET_TOKENS}`,
    );
  } else {
    invariant(
      input.targetInputTokens === undefined || input.targetInputTokens === null,
      "INVALID_PROBE",
      "targetInputTokens applies only to the context probe",
    );
  }
  return { kind, repeat, maxOutputTokens, timeoutMs, targetInputTokens };
}

// Deterministic pseudo-random stream from a string seed (no Math.random: the
// corpus must be reproducible from the recorded probeId + attempt).
function* deterministicWords(seed: string): Generator<string> {
  let state = 0;
  for (let index = 0; index < seed.length; index += 1) {
    state = (state * 31 + seed.charCodeAt(index)) >>> 0;
  }
  const vocabulary = [
    "ledger",
    "harbor",
    "granite",
    "meadow",
    "copper",
    "signal",
    "lantern",
    "orchard",
    "timber",
    "quarry",
    "meridian",
    "basalt",
    "current",
    "prairie",
    "cinder",
    "vessel",
  ];
  while (true) {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    yield vocabulary[state % vocabulary.length] as string;
  }
}

function anchorCode(seed: string, label: string): string {
  let state = 0;
  const source = `${seed}:${label}`;
  for (let index = 0; index < source.length; index += 1) {
    state = (state * 33 + source.charCodeAt(index)) >>> 0;
  }
  return state.toString(16).padStart(8, "0");
}

export interface ContextCorpus {
  readonly text: string;
  readonly estimatedTokens: number;
  readonly anchors: { readonly start: string; readonly middle: string; readonly end: string };
}

export function buildContextCorpus(seed: string, targetInputTokens: number): ContextCorpus {
  const anchors = {
    start: anchorCode(seed, "start"),
    middle: anchorCode(seed, "middle"),
    end: anchorCode(seed, "end"),
  };
  const targetChars = targetInputTokens * ESTIMATED_CHARS_PER_TOKEN;
  const words = deterministicWords(seed);
  const parts: string[] = [`ANCHOR_START=${anchors.start}.`];
  let length = parts[0]?.length ?? 0;
  let middlePlaced = false;
  while (length < targetChars) {
    if (!middlePlaced && length >= targetChars / 2) {
      const marker = ` ANCHOR_MIDDLE=${anchors.middle}.`;
      parts.push(marker);
      length += marker.length;
      middlePlaced = true;
      continue;
    }
    const word = ` ${words.next().value}`;
    parts.push(word);
    length += word.length;
  }
  const tail = ` ANCHOR_END=${anchors.end}.`;
  parts.push(tail);
  length += tail.length;
  return {
    text: parts.join(""),
    estimatedTokens: Math.round(length / ESTIMATED_CHARS_PER_TOKEN),
    anchors,
  };
}

const THROUGHPUT_SCHEMA: JsonValue = {
  type: "object",
  properties: { text: { type: "string" } },
  required: ["text"],
  additionalProperties: false,
};

const CONTEXT_SCHEMA: JsonValue = {
  type: "object",
  properties: {
    startAnchor: { type: "string" },
    middleAnchor: { type: "string" },
    endAnchor: { type: "string" },
  },
  required: ["startAnchor", "middleAnchor", "endAnchor"],
  additionalProperties: false,
};

const STRUCTURED_SCHEMA: JsonValue = {
  type: "object",
  properties: {
    summary: { type: "string" },
    severity: { type: "string", enum: ["low", "medium", "high"] },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          confirmed: { type: "boolean" },
        },
        required: ["title", "confirmed"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "severity", "findings"],
  additionalProperties: false,
};

function tokensPerSecond(usage: ProviderUsage): number | null {
  if (usage.outputTokens === null || usage.latencyMs <= 0) {
    return null;
  }
  return (usage.outputTokens * 1000) / usage.latencyMs;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

// Explicit shape check for the fixed structured-probe schema. Hand-written on
// purpose: the probe asserts a closed contract, not general JSON Schema.
function structuredReplyValid(value: unknown): boolean {
  const record = asRecord(value);
  if (record === null) {
    return false;
  }
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== "findings,severity,summary") {
    return false;
  }
  if (typeof record.summary !== "string") {
    return false;
  }
  if (record.severity !== "low" && record.severity !== "medium" && record.severity !== "high") {
    return false;
  }
  if (!Array.isArray(record.findings)) {
    return false;
  }
  for (const entry of record.findings) {
    const finding = asRecord(entry);
    if (finding === null) {
      return false;
    }
    if (Object.keys(finding).sort().join(",") !== "confirmed,title") {
      return false;
    }
    if (typeof finding.title !== "string" || typeof finding.confirmed !== "boolean") {
      return false;
    }
  }
  return true;
}

/**
 * Usage for an attempt that threw before the provider reported anything.
 *
 * Token counts and cost are genuinely unknown and stay null. Elapsed time is NOT:
 * the attempt occupied real wall-clock time, and recording 0 made a request that
 * burned 145 seconds before failing indistinguishable from an instant preflight
 * refusal. A probe exists to measure, so it must not fabricate its own measurement.
 */
function unmeasuredUsage(latencyMs: number): ProviderUsage {
  return {
    inputTokens: null,
    outputTokens: null,
    estimatedCostUsd: null,
    latencyMs,
  };
}

async function runThroughputAttempt(
  gateway: ModelGateway,
  request: ProbeRequest,
  attempt: number,
  probeId: string,
  signal?: AbortSignal,
): Promise<ProbeAttempt> {
  const result = await gateway.generateStructured(
    {
      schemaName: "probe_throughput",
      schema: THROUGHPUT_SCHEMA,
      instructions:
        "You are a benchmark subject. Write flowing plain prose in the text field " +
        "until you reach your output limit. Do not stop early.",
      input: `Describe, in detail, how a small harbor town changes across four seasons. Run ${probeId} attempt ${attempt}.`,
      maxOutputTokens: request.maxOutputTokens,
      timeoutMs: request.timeoutMs,
    },
    signal,
  );
  const rate = tokensPerSecond(result.usage);
  // Billed tokens are not delivered output. A thinking model can spend an entire
  // budget on reasoning the gateway discards, returning zero usable text while
  // reporting thousands of output tokens; scoring that as a throughput success
  // measures what the provider CHARGED FOR, not what it PRODUCED. Exactly this
  // confusion made eight Gate 2 observations unreadable -- see
  // docs/diagnoses/2026-08-30-gate2-zero-yield-thinking-displacement.md.
  const producedText = result.text.trim().length > 0;
  return {
    attempt,
    ok: result.usage.outputTokens !== null && result.usage.outputTokens > 0 && producedText,
    detail:
      result.usage.outputTokens === null
        ? "no output token count reported by provider"
        : producedText
          ? `generated ${result.usage.outputTokens} tokens`
          : `billed ${result.usage.outputTokens} output tokens but returned no usable text`,
    usage: result.usage,
    outputTokensPerSecond: rate,
    consumedInputRatio: null,
    anchorRecall: null,
  };
}

async function runContextAttempt(
  gateway: ModelGateway,
  request: ProbeRequest,
  attempt: number,
  probeId: string,
  signal?: AbortSignal,
): Promise<ProbeAttempt> {
  invariant(
    request.targetInputTokens !== null,
    "INVALID_PROBE",
    "Context probe requires targetInputTokens",
  );
  const corpus = buildContextCorpus(`${probeId}:${attempt}`, request.targetInputTokens);
  const result = await gateway.generateStructured(
    {
      schemaName: "probe_context",
      schema: CONTEXT_SCHEMA,
      instructions:
        "The user message contains three anchor markers: ANCHOR_START=<code>, " +
        "ANCHOR_MIDDLE=<code>, and ANCHOR_END=<code>. Return exactly those three " +
        "hexadecimal codes in the startAnchor, middleAnchor, and endAnchor fields. " +
        "If a marker is not present in the text you received, return an empty string for it.",
      input: corpus.text,
      maxOutputTokens: request.maxOutputTokens,
      timeoutMs: request.timeoutMs,
    },
    signal,
  );
  let recall = { start: false, middle: false, end: false };
  let detail = "reply was not valid JSON";
  let parsed: unknown;
  try {
    parsed = parseStrictJson(result.text);
    const record = asRecord(parsed);
    if (record !== null) {
      recall = {
        start: record.startAnchor === corpus.anchors.start,
        middle: record.middleAnchor === corpus.anchors.middle,
        end: record.endAnchor === corpus.anchors.end,
      };
      detail = `anchor recall start=${recall.start} middle=${recall.middle} end=${recall.end}`;
    } else {
      detail = "reply JSON was not an object";
    }
  } catch (error) {
    detail = `reply was not valid JSON: ${errorMessage(error)}`;
  }
  const consumedInputRatio =
    result.usage.inputTokens === null || corpus.estimatedTokens <= 0
      ? null
      : result.usage.inputTokens / corpus.estimatedTokens;
  // Suspected truncation invalidates the attempt even when anchor recall
  // passes: a lucky answer must not launder a dropped prompt, and consumers
  // read ok/okCount as success. "Surfaced, never passed" has to bind here,
  // not only in the aggregate flag.
  const consumedTooLittle =
    consumedInputRatio !== null && consumedInputRatio < TRUNCATION_CONSUMED_RATIO_FLOOR;
  if (consumedTooLittle) {
    detail = `${detail}; consumed-input ratio ${consumedInputRatio.toFixed(3)} below ${TRUNCATION_CONSUMED_RATIO_FLOOR} — suspected truncation invalidates the attempt`;
  }
  return {
    attempt,
    ok: recall.start && recall.middle && recall.end && !consumedTooLittle,
    detail,
    usage: result.usage,
    outputTokensPerSecond: tokensPerSecond(result.usage),
    consumedInputRatio,
    anchorRecall: recall,
  };
}

async function runStructuredAttempt(
  gateway: ModelGateway,
  request: ProbeRequest,
  attempt: number,
  probeId: string,
  signal?: AbortSignal,
): Promise<ProbeAttempt> {
  const result = await gateway.generateStructured(
    {
      schemaName: "probe_structured",
      schema: STRUCTURED_SCHEMA,
      instructions:
        "Review the described situation and reply in the required schema with a " +
        "summary string, a severity of low, medium, or high, and a findings array " +
        "of {title, confirmed} objects. Reply with JSON only.",
      input:
        `Run ${probeId} attempt ${attempt}: a nightly batch job wrote its output ` +
        "twice, monitoring stayed green, and the duplicate was found by a customer. " +
        "Report what you can conclude.",
      maxOutputTokens: request.maxOutputTokens,
      timeoutMs: request.timeoutMs,
    },
    signal,
  );
  let ok = false;
  let detail = "reply was not valid JSON";
  try {
    const parsed = parseStrictJson(result.text);
    ok = structuredReplyValid(parsed);
    detail = ok ? "reply matched the closed schema" : "reply violated the closed schema";
  } catch (error) {
    detail = `reply was not valid JSON: ${errorMessage(error)}`;
  }
  return {
    attempt,
    ok,
    detail,
    usage: result.usage,
    outputTokensPerSecond: tokensPerSecond(result.usage),
    consumedInputRatio: null,
    anchorRecall: null,
  };
}

function aggregate(
  kind: ProbeKind | UnsupportedProbeKind,
  attempts: readonly ProbeAttempt[],
): ProbeAggregate {
  const okCount = attempts.filter((entry) => entry.ok).length;
  // Rates come from SUCCESSFUL attempts only. An attempt that failed still carries a
  // tokens-per-second figure, and including it reports the speed at which the provider
  // produced something unusable as though it were throughput. A published throughput
  // number must describe delivered output or it describes nothing.
  const rates = attempts
    .filter((entry) => entry.ok)
    .map((entry) => entry.outputTokensPerSecond)
    .filter((value): value is number => value !== null);
  const ratios = attempts
    .map((entry) => entry.consumedInputRatio)
    .filter((value): value is number => value !== null);
  let truncationSuspected: boolean | null = null;
  if (kind === "context") {
    const lostStartKeptEnd = attempts.some(
      (entry) => entry.anchorRecall !== null && !entry.anchorRecall.start && entry.anchorRecall.end,
    );
    const consumedTooLittle = ratios.some((value) => value < TRUNCATION_CONSUMED_RATIO_FLOOR);
    truncationSuspected = lostStartKeptEnd || consumedTooLittle;
  }
  return {
    attemptCount: attempts.length,
    okCount,
    meanOutputTokensPerSecond:
      rates.length === 0 ? null : rates.reduce((sum, value) => sum + value, 0) / rates.length,
    minConsumedInputRatio: ratios.length === 0 ? null : Math.min(...ratios),
    truncationSuspected,
  };
}

export function unsupportedProbeResult(
  request: ProbeRequest,
  provider: ProbeProviderDescriptor,
  runtime: ProbeRuntime = {},
): ProbeResultV1 {
  invariant(
    isUnsupportedProbeKind(request.kind),
    "INVALID_PROBE",
    "unsupportedProbeResult requires a recognized unsupported probe kind",
  );
  // The descriptor is echoed, never connected to. Validate only what keeps the
  // emitted row well-formed; pricing and credential policy deliberately do not
  // apply to an answer that contacts nothing.
  invariant(
    provider.model.trim().length > 0 &&
      provider.model.length <= 256 &&
      !/[\r\n\0]/.test(provider.model),
    "INVALID_MODEL",
    "Model ID is invalid",
  );
  const now = runtime.now ?? (() => new Date());
  const createId = runtime.createId ?? randomUUID;
  return {
    schemaVersion: PROBE_RESULT_SCHEMA_VERSION,
    probeId: createId(),
    startedAt: now().toISOString(),
    status: "unsupported",
    unsupportedReason: UNSUPPORTED_PROBE_REASONS[request.kind],
    probe: request,
    provider: {
      kind: provider.kind,
      baseUrl: provider.baseUrl,
      model: provider.model,
    },
    attempts: [],
    aggregate: {
      attemptCount: 0,
      okCount: 0,
      meanOutputTokensPerSecond: null,
      minConsumedInputRatio: null,
      truncationSuspected: null,
    },
  };
}

export async function runProbe(
  gateway: ModelGateway,
  request: ProbeRequest,
  runtime: ProbeRuntime = {},
  signal?: AbortSignal,
): Promise<ProbeResultV1> {
  const now = runtime.now ?? (() => new Date());
  const createId = runtime.createId ?? randomUUID;
  if (isUnsupportedProbeKind(request.kind)) {
    // Programmatic callers that already hold a gateway still get the same row
    // from the same builder the CLI uses pre-construction.
    return unsupportedProbeResult(request, gateway.config, runtime);
  }
  const probeId = createId();
  const startedAt = now().toISOString();
  const attempts: ProbeAttempt[] = [];
  for (let attempt = 1; attempt <= request.repeat; attempt += 1) {
    let result: ProbeAttempt;
    // Measured OUTSIDE the gateway call so a failure still reports how long it took.
    const attemptStartedAt = performance.now();
    try {
      if (request.kind === "throughput") {
        result = await runThroughputAttempt(gateway, request, attempt, probeId, signal);
      } else if (request.kind === "context") {
        result = await runContextAttempt(gateway, request, attempt, probeId, signal);
      } else {
        result = await runStructuredAttempt(gateway, request, attempt, probeId, signal);
      }
    } catch (error) {
      if (
        error instanceof IcarusError &&
        (error.code === "INVALID_PROBE" || error.code === "CANCELLED")
      ) {
        throw error;
      }
      const elapsedMs = Math.round(performance.now() - attemptStartedAt);
      // Keep the error CODE as a stable prefix. Two failures with the same code are
      // the same class; a free-form message alone cannot be compared across runs.
      const code = error instanceof IcarusError ? error.code : "UNKNOWN";
      result = {
        attempt,
        ok: false,
        detail: `provider error [${code}] after ${elapsedMs}ms: ${errorMessage(error)}`,
        usage: unmeasuredUsage(elapsedMs),
        outputTokensPerSecond: null,
        consumedInputRatio: null,
        anchorRecall: null,
      };
    }
    attempts.push(result);
  }
  return {
    schemaVersion: PROBE_RESULT_SCHEMA_VERSION,
    probeId,
    startedAt,
    status: "measured",
    unsupportedReason: null,
    probe: request,
    provider: {
      kind: gateway.config.kind,
      baseUrl: gateway.config.baseUrl,
      model: gateway.config.model,
    },
    attempts,
    aggregate: aggregate(request.kind, attempts),
  };
}
