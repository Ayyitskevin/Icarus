import { describe, expect, it } from "vitest";

import {
  assertRowAnsweredTheSharedRequest,
  type BenchTargetV1,
  runBenchComparison,
} from "../../packages/core/src/bench.js";
import { IcarusError } from "../../packages/core/src/errors.js";
import type {
  ModelGateway,
  StructuredGenerationRequest,
  StructuredGenerationResult,
} from "../../packages/core/src/provider.js";
import { createProviderConfig } from "../../packages/core/src/provider.js";
import type { ProviderUsage } from "../../packages/core/src/types.js";

function usage(partial: Partial<ProviderUsage> = {}): ProviderUsage {
  return {
    inputTokens: 64,
    outputTokens: 16,
    estimatedCostUsd: null,
    latencyMs: 1_000,
    ...partial,
  };
}

class FakeGateway implements ModelGateway {
  readonly config: ModelGateway["config"];
  readonly calls: StructuredGenerationRequest[] = [];
  readonly #fail: boolean;
  readonly #onCall: (() => void) | undefined;

  constructor(model: string, options: { fail?: boolean; onCall?: () => void } = {}) {
    this.config = createProviderConfig({
      kind: "ollama",
      model,
      baseUrl: "http://127.0.0.1:11434/",
    });
    this.#fail = options.fail ?? false;
    this.#onCall = options.onCall;
  }

  async generateStructured(
    request: StructuredGenerationRequest,
  ): Promise<StructuredGenerationResult> {
    this.#onCall?.();
    if (this.#fail) throw new IcarusError("PROVIDER_UNREACHABLE", "connection refused");
    this.calls.push(request);
    // The gateway returns TEXT; the probe parses it against its own schema.
    return {
      text: JSON.stringify({ answer: "ok", start: "0", middle: "0", end: "0" }),
      usage: usage(),
    };
  }
}

const TARGET_A: BenchTargetV1 = {
  kind: "ollama",
  baseUrl: "http://127.0.0.1:11434/",
  model: "model-a",
};
const TARGET_B: BenchTargetV1 = {
  kind: "ollama",
  baseUrl: "http://127.0.0.1:11434/",
  model: "model-b",
};

const RUNTIME = { now: () => new Date("2026-08-24T12:00:00Z"), createId: () => "bench-fixed-id" };

describe("runBenchComparison", () => {
  it("records ONE shared request per kind that every row answered", async () => {
    // The whole claim of a comparison document is that its rows are comparable.
    // A fleet model was recorded at five different token rates because each
    // harness asked a different question and none of them wrote the question
    // down. This is that fix, so it is the first thing pinned.
    const doc = await runBenchComparison({
      targets: [TARGET_A, TARGET_B],
      kinds: ["throughput"],
      request: { repeat: 2 },
      gatewayFor: (t) => new FakeGateway(t.model),
      runtime: RUNTIME,
    });

    expect(doc.requests).toHaveLength(1);
    expect(doc.requests[0]).toMatchObject({ kind: "throughput", repeat: 2 });
    expect(doc.rows).toHaveLength(2);
    for (const row of doc.rows) {
      expect(row.outcome).toBe("measured");
      // Each row echoes the request it actually ran; all must be the shared one.
      expect(row.result?.probe).toEqual(doc.requests[0]);
    }
    expect(doc.attempted).toBe(2);
    expect(doc.measured).toBe(2);
    expect(doc.failed).toBe(0);
  });

  it("records a failing target as a ROW and keeps the denominator honest", async () => {
    // A document reporting "one model measured" while silently omitting the
    // one that died reads as a complete comparison. The missing model is
    // usually the interesting one.
    const doc = await runBenchComparison({
      targets: [TARGET_A, TARGET_B],
      kinds: ["throughput"],
      request: { repeat: 1 },
      gatewayFor: (t) => new FakeGateway(t.model, { fail: t.model === "model-b" }),
      runtime: RUNTIME,
    });

    expect(doc.attempted).toBe(2);
    expect(doc.measured).toBe(1);
    expect(doc.failed).toBe(1);
    const failed = doc.rows.find((row) => row.outcome === "failed");
    expect(failed?.targetIndex).toBe(1);
    // runProbe records a refused attempt rather than throwing, so the row is
    // failed because NOTHING succeeded, not because the call escaped. The
    // result stays attached so the reason is still inspectable.
    expect(failed?.failureCode).toBe("BENCH_NO_SUCCESSFUL_ATTEMPT");
    expect(failed?.result?.aggregate.okCount).toBe(0);
    expect(failed?.failureDetail).toMatch(/connection refused/);
    // The failure is attributed to a target that is still named in the document.
    expect(doc.targets[failed?.targetIndex ?? -1]?.model).toBe("model-b");
  });

  it("answers an unsupported kind without contacting the provider", async () => {
    let contacted = false;
    const doc = await runBenchComparison({
      targets: [TARGET_A],
      kinds: ["tool-call"],
      request: {},
      gatewayFor: () => new FakeGateway("model-a", { onCall: () => (contacted = true) }),
      runtime: RUNTIME,
    });

    expect(contacted).toBe(false);
    expect(doc.rows[0]?.outcome).toBe("unsupported");
    expect(doc.rows[0]?.result?.status).toBe("unsupported");
    expect(doc.unsupported).toBe(1);
  });

  it("refuses a duplicate target rather than reporting it as agreement", async () => {
    // Two identical rows read as two independent measurements agreeing. It is
    // one measurement printed twice.
    await expect(
      runBenchComparison({
        targets: [TARGET_A, { ...TARGET_A }],
        kinds: ["throughput"],
        request: {},
        gatewayFor: (t) => new FakeGateway(t.model),
        runtime: RUNTIME,
      }),
    ).rejects.toThrowError(/duplicate bench target/);
  });

  it("refuses an unknown kind instead of recording a fake failed row", async () => {
    // A typo is an operator error, not a measurement. Recording it as a failure
    // would put a fabricated negative result beside real ones.
    await expect(
      runBenchComparison({
        targets: [TARGET_A],
        kinds: ["troughput"],
        request: {},
        gatewayFor: (t) => new FakeGateway(t.model),
        runtime: RUNTIME,
      }),
    ).rejects.toThrowError(/unknown probe kind/);
  });

  it("refuses an empty target set and an empty kind set", async () => {
    await expect(
      runBenchComparison({
        targets: [],
        kinds: ["throughput"],
        request: {},
        gatewayFor: (t) => new FakeGateway(t.model),
        runtime: RUNTIME,
      }),
    ).rejects.toThrowError(/at least one target/);
    await expect(
      runBenchComparison({
        targets: [TARGET_A],
        kinds: [],
        request: {},
        gatewayFor: (t) => new FakeGateway(t.model),
        runtime: RUNTIME,
      }),
    ).rejects.toThrowError(/at least one probe kind/);
  });

  it("runs targets sequentially so the battery measures models, not contention", async () => {
    // Concurrent local model calls contend for one accelerator, which is
    // exactly the harness artifact this packet exists to remove.
    let inFlight = 0;
    let maxInFlight = 0;
    const doc = await runBenchComparison({
      targets: [TARGET_A, TARGET_B],
      kinds: ["throughput", "structured"],
      request: { repeat: 1 },
      gatewayFor: (t) =>
        new FakeGateway(t.model, {
          onCall: () => {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            inFlight -= 1;
          },
        }),
      runtime: RUNTIME,
    });

    expect(maxInFlight).toBe(1);
    expect(doc.attempted).toBe(4);
  });

  it("records interrupted rows rather than truncating the document", async () => {
    const controller = new AbortController();
    controller.abort();
    const doc = await runBenchComparison({
      targets: [TARGET_A, TARGET_B],
      kinds: ["throughput"],
      request: {},
      gatewayFor: (t) => new FakeGateway(t.model),
      runtime: RUNTIME,
      signal: controller.signal,
    });

    expect(doc.attempted).toBe(2);
    expect(doc.failed).toBe(2);
    expect(doc.rows.every((row) => row.failureCode === "BENCH_INTERRUPTED")).toBe(true);
  });
});

describe("assertRowAnsweredTheSharedRequest", () => {
  // The document's entire claim is "these rows are comparable". That rests on
  // this one predicate, so it needs a test that can fail — an invariant nothing
  // exercises is a comment. `runProbe` echoes faithfully today, which is why
  // the drifted result has to be constructed by hand here.
  const shared = {
    kind: "throughput",
    repeat: 2,
    maxOutputTokens: 128,
    timeoutMs: 30_000,
    targetInputTokens: null,
  } as const;

  function resultWith(probe: unknown) {
    return {
      schemaVersion: 1,
      probeId: "p",
      startedAt: "2026-08-24T12:00:00Z",
      status: "measured",
      unsupportedReason: null,
      probe,
      provider: { kind: "ollama", baseUrl: "http://127.0.0.1:11434/", model: "m" },
      attempts: [],
      aggregate: {
        attemptCount: 0,
        okCount: 0,
        meanOutputTokensPerSecond: null,
        minConsumedInputRatio: null,
        truncationSuspected: null,
      },
    } as never;
  }

  it("passes when the row ran the shared request", () => {
    expect(() =>
      assertRowAnsweredTheSharedRequest(resultWith({ ...shared }), shared),
    ).not.toThrow();
  });

  it("refuses a row whose request drifted, however slightly", () => {
    // One differing field is enough: a battery where one model answered with
    // repeat=3 and the rest with repeat=2 is not a comparison, and reporting it
    // as one is how a model ends up with five different recorded token rates.
    expect(() =>
      assertRowAnsweredTheSharedRequest(resultWith({ ...shared, repeat: 3 }), shared),
    ).toThrowError(/not comparable/);
    expect(() =>
      assertRowAnsweredTheSharedRequest(resultWith({ ...shared, maxOutputTokens: 129 }), shared),
    ).toThrowError(/not comparable/);
  });
});
