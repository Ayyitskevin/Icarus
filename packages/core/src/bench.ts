import { randomUUID } from "node:crypto";

import { canonicalJson } from "./canonical-json.js";
import { errorMessage, IcarusError, invariant } from "./errors.js";
import type { ModelGateway } from "./provider.js";
import {
  createProbeRequest,
  isUnsupportedProbeKind,
  type ProbeKind,
  PROBE_KINDS,
  type ProbeRequest,
  type ProbeResultV1,
  runProbe,
  unsupportedProbeResult,
} from "./probe.js";
import type { JsonValue } from "./types.js";

// Probe batteries across several models (packet E2, revised scope).
//
// WHY THIS EXISTS. `qwen3.8:27b` is recorded at 13.1, 13.3, 17.7, 18.95 and
// 21.5 tokens per second across four separate fleet notes, because each
// measurement used a different hand-rolled harness. Those numbers then decide
// model routing. The defect is not the spread — it is that nothing recorded
// WHAT DIFFERED between the runs, so the numbers cannot be compared and cannot
// be re-derived.
//
// A comparison is therefore only meaningful when every target answered the
// SAME question. This module builds one `ProbeRequest` per kind, applies it to
// every target, and refuses to emit a document whose rows did not all run that
// exact request. The shared request is recorded once, in the document, so a
// reader can re-run it rather than trust the summary (a summary is a claim
// about a measurement, not the measurement).
//
// Scope, deliberately: this is measurement only, the same blast radius as one
// probe — an HTTP conversation with an operator-configured provider and a
// printed document. It executes no repository code, touches no worktree or
// sandbox, and needs no approval or grant. LIVE CODE-CHANGE benchmarking is
// explicitly NOT here: that requires the eval-scoped execution grant, because
// an "approve everything for the benchmark" flag would be exactly the
// digest-unbound authority widening this repository refuses everywhere else.

/** Schema version of the comparison document. Bump when a field's meaning changes. */
export const BENCH_COMPARISON_SCHEMA_VERSION = 1;

/** Targets are capped so one command cannot fan out into an unbounded sweep. */
const MAX_TARGETS = 16;

/** One model under comparison: a provider kind, its base URL, and the model name. */
export interface BenchTargetV1 {
  readonly kind: string;
  readonly baseUrl: string;
  readonly model: string;
}

/** One (target, kind) cell of the comparison. Every cell attempted produces a row,
 * including failures — see `runBenchComparison` for why none are dropped. */
export interface BenchRowV1 {
  /** Index into `targets`; rows never restate the target, so it cannot drift. */
  readonly targetIndex: number;
  readonly kind: string;
  /** `failed` is a RECORDED outcome, never a dropped row — see `runBenchComparison`. */
  readonly outcome: "measured" | "unsupported" | "failed";
  readonly failureCode: string | null;
  readonly failureDetail: string | null;
  readonly result: ProbeResultV1 | null;
}

/** The comparison document: the shared question, who answered it, and every row.
 * Its claim is that the rows are COMPARABLE, which `assertRowAnsweredTheSharedRequest`
 * enforces per row rather than assuming from a single request object. */
export interface BenchComparisonV1 {
  readonly schemaVersion: typeof BENCH_COMPARISON_SCHEMA_VERSION;
  readonly benchId: string;
  readonly startedAt: string;
  readonly completedAt: string;
  /** One request per kind, in `kinds` order — the question every target answered. */
  readonly requests: readonly ProbeRequest[];
  readonly kinds: readonly string[];
  /** The probe id every target used for `kinds[i]`; prompt bytes derive from it. */
  readonly probeIds: readonly string[];
  readonly targets: readonly BenchTargetV1[];
  readonly rows: readonly BenchRowV1[];
  /** Denominator first: an empty `measured` set is not "all clear" without it. */
  readonly attempted: number;
  readonly measured: number;
  readonly unsupported: number;
  readonly failed: number;
}

/** Injected clock and id source, so a comparison is reproducible under test. */
export interface BenchRuntime {
  readonly now?: () => Date;
  readonly createId?: () => string;
}

/** Inputs to one battery. `gatewayFor` is called per row so a per-target
 * credential or pricing failure becomes that row's failure, not the batch's. */
export interface RunBenchComparisonOptions {
  readonly targets: readonly BenchTargetV1[];
  readonly kinds: readonly string[];
  readonly request: {
    readonly repeat?: number | undefined;
    readonly maxOutputTokens?: number | undefined;
    readonly timeoutMs?: number | undefined;
    readonly targetInputTokens?: number | null | undefined;
  };
  readonly gatewayFor: (target: BenchTargetV1) => ModelGateway;
  readonly runtime?: BenchRuntime;
  readonly signal?: AbortSignal;
}

function invalid(message: string): never {
  throw new IcarusError("INVALID_BENCH_REQUEST", message);
}

function targetKey(target: BenchTargetV1): string {
  return canonicalJson({
    kind: target.kind,
    baseUrl: target.baseUrl,
    model: target.model,
  } as unknown as JsonValue);
}

/**
 * The comparison's whole claim: these rows are comparable. That is true only if
 * each row answered the request this document records for its kind, so it is
 * checked against the row's OWN echoed request rather than assumed from the
 * fact that one object was passed in. `runProbe` echoes the request it ran into
 * `result.probe`; a future change that lets a probe adjust its own parameters
 * mid-flight would silently invalidate every comparison, and this is what would
 * catch it.
 */
export function assertRowAnsweredTheSharedRequest(
  result: ProbeResultV1,
  shared: ProbeRequest,
  sharedProbeId: string,
): void {
  invariant(
    canonicalJson(result.probe as unknown as JsonValue) ===
      canonicalJson(shared as unknown as JsonValue),
    "BENCH_REQUEST_DRIFT",
    "A bench row did not run the comparison's shared request; the rows are not comparable",
  );
  // The ProbeRequest DESCRIBES the question; it is not the question. Every probe
  // kind interpolates its probeId into the bytes the model actually receives —
  // throughput and structured carry it in the prompt, and `context` SEEDS ITS
  // CORPUS from it, so a per-row id hands each target different anchors and
  // therefore a different correct answer. Comparing request objects alone passed
  // happily while the rows answered different questions: exactly the defect this
  // module exists to prevent, reproduced inside it. Binding the id is what turns
  // a shared request into a shared QUESTION.
  invariant(
    result.probeId === sharedProbeId,
    "BENCH_REQUEST_DRIFT",
    "A bench row ran under a different probe id, so its prompt bytes differ; the rows are not comparable",
  );
}

/** Validate the target set: non-empty, within the fan-out cap, and free of
 * duplicates, which would read as two measurements agreeing. */
export function assertBenchTargets(targets: readonly BenchTargetV1[]): void {
  if (targets.length === 0) invalid("bench comparison needs at least one target");
  if (targets.length > MAX_TARGETS) {
    invalid(`bench comparison accepts at most ${MAX_TARGETS} targets`);
  }
  const seen = new Set<string>();
  for (const target of targets) {
    if (
      typeof target.kind !== "string" ||
      target.kind.length === 0 ||
      typeof target.baseUrl !== "string" ||
      target.baseUrl.length === 0 ||
      typeof target.model !== "string" ||
      target.model.length === 0
    ) {
      invalid("every bench target needs a provider kind, base url, and model");
    }
    const key = targetKey(target);
    // A duplicate target would appear twice in the document and be read as
    // agreement between two independent measurements. It is one measurement.
    if (seen.has(key)) invalid(`duplicate bench target ${target.kind}/${target.model}`);
    seen.add(key);
  }
}

/** Validate the requested probe kinds: non-empty, unique, and each recognized.
 * An unknown kind refuses here rather than becoming a fabricated failed row. */
export function assertBenchKinds(kinds: readonly string[]): void {
  if (kinds.length === 0) invalid("bench comparison needs at least one probe kind");
  const seen = new Set<string>();
  for (const kind of kinds) {
    if (seen.has(kind)) invalid(`duplicate probe kind ${kind}`);
    seen.add(kind);
    const known = (PROBE_KINDS as readonly string[]).includes(kind) || isUnsupportedProbeKind(kind);
    // An unknown kind fails here rather than becoming a `failed` row: a typo is
    // an operator error, not a measurement, and recording it as one would put a
    // fake negative result next to real ones.
    if (!known) invalid(`unknown probe kind ${kind}`);
  }
}

/**
 * Run every kind against every target and return one comparison document.
 *
 * Targets run sequentially and never in parallel. Concurrent local model calls
 * contend for the same accelerator, so a parallel battery would measure the
 * contention rather than the models — which is precisely the class of harness
 * artifact this packet exists to remove.
 *
 * A target that throws produces a `failed` ROW. It is never dropped: a document
 * reporting "two models measured" while silently omitting the third reads as a
 * complete comparison, and the missing model is usually the interesting one.
 */
export async function runBenchComparison(
  options: RunBenchComparisonOptions,
): Promise<BenchComparisonV1> {
  assertBenchTargets(options.targets);
  assertBenchKinds(options.kinds);
  const runtime = options.runtime ?? {};
  const now = runtime.now ?? (() => new Date());
  const createId = runtime.createId ?? randomUUID;

  const requests = options.kinds.map((kind) =>
    createProbeRequest({
      kind,
      repeat: options.request.repeat,
      maxOutputTokens: options.request.maxOutputTokens,
      timeoutMs: options.request.timeoutMs,
      targetInputTokens: options.request.targetInputTokens,
    }),
  );

  const benchId = createId();
  // One probe id per KIND, shared by every target answering that kind, so all
  // targets receive byte-identical prompts. Attempt number still varies within
  // a row exactly as it does for a single probe run.
  const probeIds = options.kinds.map(() => createId());
  const startedAt = now().toISOString();
  const rows: BenchRowV1[] = [];

  for (const [targetIndex, target] of options.targets.entries()) {
    for (const [kindIndex, kind] of options.kinds.entries()) {
      const shared = requests[kindIndex];
      const sharedProbeId = probeIds[kindIndex];
      invariant(
        shared !== undefined && sharedProbeId !== undefined,
        "INVALID_BENCH_REQUEST",
        "Missing bench request",
      );
      if (options.signal?.aborted === true) {
        rows.push({
          targetIndex,
          kind,
          outcome: "failed",
          failureCode: "BENCH_INTERRUPTED",
          failureDetail: "interrupted before this row ran",
          result: null,
        });
        continue;
      }
      if (isUnsupportedProbeKind(shared.kind)) {
        // Answered without contacting the provider, exactly as one probe does.
        rows.push({
          targetIndex,
          kind,
          outcome: "unsupported",
          failureCode: null,
          failureDetail: null,
          result: unsupportedProbeResult(shared, target, runtime),
        });
        continue;
      }
      try {
        const gateway = options.gatewayFor(target);
        const result = await runProbe(
          gateway,
          shared,
          { ...runtime, createId: () => sharedProbeId },
          options.signal,
        );
        assertRowAnsweredTheSharedRequest(result, shared, sharedProbeId);
        // `runProbe` records a failed attempt rather than throwing, so a target
        // that refused every single attempt still returns a well-formed result.
        // Counting that as `measured` would put a model with no answers into
        // the measured denominator and report a mean over nothing — the exact
        // false number this packet exists to stop. Zero successful attempts is
        // a failed row. The result stays attached so the attempt details, and
        // therefore the reason, remain inspectable.
        const answered = result.status === "measured" && result.aggregate.okCount === 0;
        rows.push({
          targetIndex,
          kind,
          outcome:
            result.status === "unsupported" ? "unsupported" : answered ? "failed" : "measured",
          failureCode: answered ? "BENCH_NO_SUCCESSFUL_ATTEMPT" : null,
          failureDetail: answered
            ? (result.attempts.find((attempt) => !attempt.ok)?.detail ??
              "every probe attempt failed")
            : null,
          result,
        });
      } catch (error) {
        // Request drift is a defect in this module's own contract, not a
        // property of the target, so it must not be recorded as that model
        // failing. It propagates and the whole document is refused.
        if (error instanceof IcarusError && error.code === "BENCH_REQUEST_DRIFT") throw error;
        rows.push({
          targetIndex,
          kind,
          outcome: "failed",
          failureCode: error instanceof IcarusError ? error.code : "BENCH_TARGET_FAILED",
          failureDetail: errorMessage(error),
          result: null,
        });
      }
    }
  }

  return {
    schemaVersion: BENCH_COMPARISON_SCHEMA_VERSION,
    benchId,
    startedAt,
    completedAt: now().toISOString(),
    requests,
    kinds: [...options.kinds],
    probeIds: [...probeIds],
    targets: options.targets.map((target) => ({
      kind: target.kind,
      baseUrl: target.baseUrl,
      model: target.model,
    })),
    rows,
    attempted: rows.length,
    measured: rows.filter((row) => row.outcome === "measured").length,
    unsupported: rows.filter((row) => row.outcome === "unsupported").length,
    failed: rows.filter((row) => row.outcome === "failed").length,
  };
}

/** Re-exported so a caller can name a kind without importing the probe module. */
export type { ProbeKind };
