import { describe, expect, it } from "vitest";

import { IcarusError } from "../../packages/core/src/errors.js";
import {
  buildContextCorpus,
  createProbeRequest,
  runProbe,
  unsupportedProbeResult,
} from "../../packages/core/src/probe.js";
import type {
  ModelGateway,
  StructuredGenerationRequest,
  StructuredGenerationResult,
} from "../../packages/core/src/provider.js";
import { createProviderConfig } from "../../packages/core/src/provider.js";
import type { ProviderUsage } from "../../packages/core/src/types.js";

type Responder = (
  request: StructuredGenerationRequest,
  attemptIndex: number,
) => StructuredGenerationResult;

function usage(partial: Partial<ProviderUsage>): ProviderUsage {
  return {
    inputTokens: null,
    outputTokens: null,
    estimatedCostUsd: null,
    latencyMs: 1_000,
    ...partial,
  };
}

class FakeGateway implements ModelGateway {
  readonly config = createProviderConfig({
    kind: "ollama",
    model: "fake-model",
    baseUrl: "http://127.0.0.1:11434/",
  });
  readonly requests: StructuredGenerationRequest[] = [];
  readonly #respond: Responder;

  constructor(respond: Responder) {
    this.#respond = respond;
  }

  async generateStructured(
    request: StructuredGenerationRequest,
  ): Promise<StructuredGenerationResult> {
    this.requests.push(request);
    return this.#respond(request, this.requests.length - 1);
  }
}

function anchorFromInput(input: string, label: string): string {
  const match = input.match(new RegExp(`ANCHOR_${label}=([0-9a-f]{8})`));
  return match?.[1] ?? "";
}

const RUNTIME = { now: () => new Date("2026-08-18T12:00:00Z"), createId: () => "probe-fixed-id" };

describe("createProbeRequest", () => {
  it("rejects unknown probe kinds so typos cannot silently measure nothing", () => {
    expect(() => createProbeRequest({ kind: "speed" })).toThrowError(/Probe kind/);
  });

  it("rejects out-of-range repeat so a loop cannot become an unbounded burn", () => {
    expect(() => createProbeRequest({ kind: "throughput", repeat: 0 })).toThrowError(/repeat/);
    expect(() => createProbeRequest({ kind: "throughput", repeat: 33 })).toThrowError(/repeat/);
  });

  it("rejects targetInputTokens on non-context probes so the flag cannot imply an unmeasured behavior", () => {
    expect(() => createProbeRequest({ kind: "throughput", targetInputTokens: 1_024 })).toThrowError(
      /context probe/,
    );
  });
});

describe("buildContextCorpus", () => {
  it("is deterministic from its seed because a recorded probeId must regenerate the exact corpus", () => {
    const first = buildContextCorpus("seed-a", 1_024);
    const second = buildContextCorpus("seed-a", 1_024);
    const different = buildContextCorpus("seed-b", 1_024);
    expect(first.text).toBe(second.text);
    expect(first.anchors).toEqual(second.anchors);
    expect(first.text).not.toBe(different.text);
  });

  it("places the three anchors at the start, interior, and tail", () => {
    const corpus = buildContextCorpus("seed-a", 2_048);
    const start = corpus.text.indexOf(`ANCHOR_START=${corpus.anchors.start}`);
    const middle = corpus.text.indexOf(`ANCHOR_MIDDLE=${corpus.anchors.middle}`);
    const end = corpus.text.indexOf(`ANCHOR_END=${corpus.anchors.end}`);
    expect(start).toBe(0);
    expect(middle).toBeGreaterThan(start);
    expect(end).toBeGreaterThan(middle);
    expect(corpus.text.endsWith(`ANCHOR_END=${corpus.anchors.end}.`)).toBe(true);
    expect(corpus.estimatedTokens).toBeGreaterThanOrEqual(2_048);
  });
});

describe("throughput probe", () => {
  it("derives tokens per second from provider-reported counts only", async () => {
    const gateway = new FakeGateway(() => ({
      text: '{"text":"prose"}',
      usage: usage({ inputTokens: 20, outputTokens: 100, latencyMs: 2_000 }),
    }));
    const result = await runProbe(gateway, createProbeRequest({ kind: "throughput" }), RUNTIME);
    expect(result.attempts[0]?.ok).toBe(true);
    expect(result.attempts[0]?.outputTokensPerSecond).toBeCloseTo(50, 5);
    expect(result.aggregate.meanOutputTokensPerSecond).toBeCloseTo(50, 5);
  });

  it("reports how long a failed attempt actually took, not zero", async () => {
    // A provider that burns 145 seconds before failing must not be recorded the same
    // way as one that refuses instantly. Token counts are genuinely unknown and stay
    // null; elapsed time is not unknown, and fabricating 0 destroys the only signal a
    // probe exists to collect.
    const gateway = new FakeGateway(() => {
      const until = Date.now() + 25;
      while (Date.now() < until) {
        // deliberate wall-clock cost before the failure
      }
      throw new IcarusError("PROVIDER_TRANSPORT_ERROR", "connection reset");
    });
    const result = await runProbe(gateway, createProbeRequest({ kind: "throughput" }), RUNTIME);
    const attempt = result.attempts[0];

    expect(attempt?.ok).toBe(false);
    expect(attempt?.usage.latencyMs).toBeGreaterThan(0);
    expect(attempt?.usage.inputTokens).toBeNull();
    expect(attempt?.usage.outputTokens).toBeNull();
    // The code is a stable prefix; the message alone cannot be compared across runs.
    expect(attempt?.detail).toContain("PROVIDER_TRANSPORT_ERROR");
  });

  it("refuses to call billed-but-empty output a throughput success", async () => {
    // A thinking model can spend an entire budget on reasoning the gateway discards,
    // returning no usable text while reporting thousands of output tokens. Scoring that
    // as success measures what the provider CHARGED FOR, not what it PRODUCED -- the
    // same confusion that made eight Gate 2 observations unreadable on 2026-08-28.
    const gateway = new FakeGateway(() => ({
      text: "",
      usage: usage({ inputTokens: 20, outputTokens: 8_192, latencyMs: 145_543 }),
    }));
    const result = await runProbe(gateway, createProbeRequest({ kind: "throughput" }), RUNTIME);
    expect(result.attempts[0]?.ok).toBe(false);
    expect(result.attempts[0]?.detail).toContain("no usable text");
    expect(result.attempts[0]?.detail).toContain("8192");
  });

  it("excludes failed attempts from the published mean rate", async () => {
    // A failed attempt still carries a tokens-per-second figure. Averaging it in reports
    // the speed of producing something unusable as throughput.
    let call = 0;
    const gateway = new FakeGateway(() => {
      call += 1;
      return call === 1
        ? {
            text: '{"text":"prose"}',
            usage: usage({ inputTokens: 20, outputTokens: 100, latencyMs: 2_000 }),
          }
        : { text: "", usage: usage({ inputTokens: 20, outputTokens: 1_000, latencyMs: 1_000 }) };
    });
    const result = await runProbe(
      gateway,
      createProbeRequest({ kind: "throughput", repeat: 2 }),
      RUNTIME,
    );
    expect(result.attempts.map((entry) => entry.ok)).toStrictEqual([true, false]);
    // Only the successful 50 t/s attempt counts; the failed 1000 t/s attempt must not
    // drag the published mean upward.
    expect(result.aggregate.meanOutputTokensPerSecond).toBeCloseTo(50, 5);
  });

  it("refuses to fabricate a rate when the provider hides token counts", async () => {
    const gateway = new FakeGateway(() => ({
      text: '{"text":"prose"}',
      usage: usage({ outputTokens: null }),
    }));
    const result = await runProbe(gateway, createProbeRequest({ kind: "throughput" }), RUNTIME);
    expect(result.attempts[0]?.ok).toBe(false);
    expect(result.attempts[0]?.outputTokensPerSecond).toBeNull();
    expect(result.aggregate.meanOutputTokensPerSecond).toBeNull();
  });
});

describe("context probe", () => {
  const request = createProbeRequest({ kind: "context", targetInputTokens: 1_024 });

  it("passes when all anchors are recalled and the consumed count matches the estimate", async () => {
    const gateway = new FakeGateway((generation) => ({
      text: JSON.stringify({
        startAnchor: anchorFromInput(generation.input, "START"),
        middleAnchor: anchorFromInput(generation.input, "MIDDLE"),
        endAnchor: anchorFromInput(generation.input, "END"),
      }),
      usage: usage({ inputTokens: 1_050, outputTokens: 30 }),
    }));
    const result = await runProbe(gateway, request, RUNTIME);
    expect(result.attempts[0]?.ok).toBe(true);
    expect(result.attempts[0]?.anchorRecall).toEqual({ start: true, middle: true, end: true });
    expect(result.aggregate.truncationSuspected).toBe(false);
  });

  it("flags suspected truncation when the start anchor is lost but the end anchor survives, because silent front-drop must surface rather than pass", async () => {
    const gateway = new FakeGateway((generation) => ({
      text: JSON.stringify({
        startAnchor: "",
        middleAnchor: anchorFromInput(generation.input, "MIDDLE"),
        endAnchor: anchorFromInput(generation.input, "END"),
      }),
      usage: usage({ inputTokens: 512, outputTokens: 30 }),
    }));
    const result = await runProbe(gateway, request, RUNTIME);
    expect(result.attempts[0]?.ok).toBe(false);
    expect(result.attempts[0]?.anchorRecall).toEqual({ start: false, middle: true, end: true });
    expect(result.aggregate.truncationSuspected).toBe(true);
  });

  it("invalidates the attempt on a low consumed-input ratio even when recall passes, so ok/okCount can never launder a dropped prompt", async () => {
    const gateway = new FakeGateway((generation) => ({
      text: JSON.stringify({
        startAnchor: anchorFromInput(generation.input, "START"),
        middleAnchor: anchorFromInput(generation.input, "MIDDLE"),
        endAnchor: anchorFromInput(generation.input, "END"),
      }),
      usage: usage({ inputTokens: 100, outputTokens: 30 }),
    }));
    const result = await runProbe(gateway, request, RUNTIME);
    expect(result.attempts[0]?.ok).toBe(false);
    expect(result.attempts[0]?.detail).toContain("suspected truncation invalidates the attempt");
    expect(result.aggregate.okCount).toBe(0);
    expect(result.aggregate.minConsumedInputRatio).not.toBeNull();
    expect(result.aggregate.truncationSuspected).toBe(true);
  });
});

describe("structured probe", () => {
  const request = createProbeRequest({ kind: "structured" });

  it("accepts a reply that matches the closed schema", async () => {
    const gateway = new FakeGateway(() => ({
      text: JSON.stringify({
        summary: "duplicate write with green monitoring",
        severity: "high",
        findings: [{ title: "monitoring missed duplicates", confirmed: true }],
      }),
      usage: usage({ inputTokens: 50, outputTokens: 40 }),
    }));
    const result = await runProbe(gateway, request, RUNTIME);
    expect(result.attempts[0]?.ok).toBe(true);
  });

  it("rejects a reply with fields outside the closed schema, because compliance is the measurement", async () => {
    const gateway = new FakeGateway(() => ({
      text: JSON.stringify({
        summary: "ok",
        severity: "high",
        findings: [],
        extra: "field",
      }),
      usage: usage({ inputTokens: 50, outputTokens: 40 }),
    }));
    const result = await runProbe(gateway, request, RUNTIME);
    expect(result.attempts[0]?.ok).toBe(false);
    expect(result.attempts[0]?.detail).toContain("violated");
  });

  it("records invalid JSON as a failed attempt without aborting the run", async () => {
    const gateway = new FakeGateway(() => ({
      text: "not json at all",
      usage: usage({ inputTokens: 50, outputTokens: 40 }),
    }));
    const result = await runProbe(gateway, request, RUNTIME);
    expect(result.attempts[0]?.ok).toBe(false);
    expect(result.attempts[0]?.detail).toContain("not valid JSON");
  });
});

describe("unsupported probe kinds", () => {
  it("returns an explicit unsupported result for tool-call without calling the provider, because unsupported must be a status, not an argument error or an approximation", async () => {
    const gateway = new FakeGateway(() => {
      throw new Error("provider must never be called for an unsupported kind");
    });
    const result = await runProbe(gateway, createProbeRequest({ kind: "tool-call" }), RUNTIME);
    expect(result.status).toBe("unsupported");
    expect(result.unsupportedReason).toContain("structured generation only");
    expect(result.attempts).toHaveLength(0);
    expect(result.aggregate.attemptCount).toBe(0);
    expect(result.aggregate.okCount).toBe(0);
    expect(gateway.requests).toHaveLength(0);
  });

  it("builds an unsupported row from a raw descriptor without any provider validation, so remote providers answer identically", () => {
    const request = createProbeRequest({ kind: "tool-call" });
    const row = unsupportedProbeResult(
      request,
      { kind: "openai", baseUrl: "https://api.openai.com/v1/", model: "gpt-4o" },
      RUNTIME,
    );
    expect(row.status).toBe("unsupported");
    expect(row.provider).toEqual({
      kind: "openai",
      baseUrl: "https://api.openai.com/v1/",
      model: "gpt-4o",
    });
    expect(row.attempts).toHaveLength(0);
  });

  it("refuses to build an unsupported row for a supported kind, so the two paths cannot be confused", () => {
    const request = createProbeRequest({ kind: "throughput" });
    expect(() =>
      unsupportedProbeResult(
        request,
        { kind: "ollama", baseUrl: "http://x/", model: "m" },
        RUNTIME,
      ),
    ).toThrowError(/recognized unsupported probe kind/);
  });

  it("still rejects genuinely unknown kinds so typos stay loud", () => {
    expect(() => createProbeRequest({ kind: "speed" })).toThrowError(/Probe kind/);
  });
});

describe("cancellation", () => {
  it("propagates CANCELLED instead of recording it as a completed measurement, because an interrupted run must not report success", async () => {
    const gateway = new FakeGateway(() => {
      throw new IcarusError("CANCELLED", "Provider request was cancelled before it started");
    });
    await expect(
      runProbe(gateway, createProbeRequest({ kind: "structured", repeat: 2 }), RUNTIME),
    ).rejects.toMatchObject({ code: "CANCELLED" });
  });
});

describe("runProbe resilience and identity", () => {
  it("survives a provider error mid-run so one failed attempt cannot void a measurement", async () => {
    const gateway = new FakeGateway((_generation, index) => {
      if (index === 1) {
        throw new Error("connection reset");
      }
      return {
        text: JSON.stringify({
          summary: "s",
          severity: "low",
          findings: [],
        }),
        usage: usage({ inputTokens: 10, outputTokens: 10 }),
      };
    });
    const result = await runProbe(
      gateway,
      createProbeRequest({ kind: "structured", repeat: 3 }),
      RUNTIME,
    );
    expect(result.attempts).toHaveLength(3);
    expect(result.attempts[1]?.ok).toBe(false);
    expect(result.attempts[1]?.detail).toContain("provider error");
    expect(result.aggregate.okCount).toBe(2);
  });

  it("stamps schema version and injected identity so rows are joinable and reproducible", async () => {
    const gateway = new FakeGateway(() => ({
      text: '{"text":"prose"}',
      usage: usage({ inputTokens: 5, outputTokens: 5 }),
    }));
    const result = await runProbe(gateway, createProbeRequest({ kind: "throughput" }), RUNTIME);
    expect(result.schemaVersion).toBe(1);
    expect(result.status).toBe("measured");
    expect(result.unsupportedReason).toBeNull();
    expect(result.probeId).toBe("probe-fixed-id");
    expect(result.startedAt).toBe("2026-08-18T12:00:00.000Z");
    expect(result.provider).toEqual({
      kind: "ollama",
      baseUrl: "http://127.0.0.1:11434/",
      model: "fake-model",
    });
  });
});
