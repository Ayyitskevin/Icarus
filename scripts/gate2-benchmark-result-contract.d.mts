import type { Gate2BenchmarkManifest } from "./gate2-benchmark-contract.mjs";

export interface Gate2BenchmarkAggregates {
  taskCount: number;
  measuredTaskCount: number;
  successCount: number;
  classSuccessCounts: Record<string, number>;
  macroRetrievalRecall: number;
  macroRetrievalPrecision: number;
  digestProvenanceCoverage: number;
  firstPassPlanAcceptance: number;
  incorrectEdits: number;
  medianEstimatedCostPerSuccess: number | null;
  thresholdsPassed: boolean;
  assessment: string;
}

export const GATE2_RESULT_LIMITATIONS: readonly string[];

export function computeGate2ExecutionProfileDigest(profile: unknown): string;
export function computeGate2BenchmarkAggregates(
  observations: unknown[],
  manifest: Gate2BenchmarkManifest,
  profile: unknown,
): Gate2BenchmarkAggregates;
export function validateGate2BenchmarkResult(
  value: unknown,
  manifest: Gate2BenchmarkManifest,
  manifestSha256: string,
): Record<string, unknown> & { aggregates: Gate2BenchmarkAggregates };
export function parseAndValidateGate2BenchmarkResult(
  source: string,
  manifest: Gate2BenchmarkManifest,
  manifestSha256: string,
): Record<string, unknown> & { aggregates: Gate2BenchmarkAggregates };
export function compareGate2BenchmarkResults(
  baseline: unknown,
  routed: unknown,
  manifest: Gate2BenchmarkManifest,
  manifestSha256: string,
): Record<string, unknown>;
