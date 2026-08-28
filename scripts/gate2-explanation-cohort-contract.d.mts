import type { Gate2BenchmarkManifest } from "./gate2-benchmark-contract.mjs";

export interface Gate2ExplanationOracle {
  readonly caseId: string;
  readonly scenarioEvaluatorId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly response: {
    readonly summary: string;
    readonly claims: readonly {
      readonly text: string;
      readonly citations: readonly {
        readonly path: string;
        readonly lineStart: number;
        readonly lineEnd: number;
      }[];
    }[];
  };
}

export const GATE2_EXPLANATION_PROVIDER: Readonly<{
  kind: "ollama";
  model: string;
  adapterVersion: string;
  transport: "loopback-http";
}>;
export const GATE2_EXPLANATION_COHORT_LIMITATIONS: readonly string[];
export const GATE2_EXPLANATION_ORACLES: readonly Gate2ExplanationOracle[];
export function computeGate2ExplanationEvidenceDigest(
  observationInput: Record<string, unknown>,
): string;
export function validateGate2ExplanationCohortResult(
  value: unknown,
  manifestInput: Gate2BenchmarkManifest,
  manifestSha256: string,
): unknown;
export function parseAndValidateGate2ExplanationCohortResult(
  source: string,
  manifest: Gate2BenchmarkManifest,
  manifestSha256: string,
): unknown;
