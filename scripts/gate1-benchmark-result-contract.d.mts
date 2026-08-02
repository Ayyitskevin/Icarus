import type { Gate1BenchmarkManifest } from "./gate1-benchmark-contract.mjs";

export type Gate1BenchmarkReport = Record<string, unknown>;

export const GATE1_OFFLINE_REPORT_LIMITATIONS: readonly string[];
export const GATE1_FAILURE_REPORT_LIMITATION: string;

export function validateGate1BenchmarkReport(
  value: unknown,
  manifest: Gate1BenchmarkManifest | null,
  expectedManifestSha256: string | null,
): Gate1BenchmarkReport;
