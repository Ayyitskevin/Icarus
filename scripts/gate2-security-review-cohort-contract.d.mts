import type { Gate2BenchmarkManifest } from "./gate2-benchmark-contract.mjs";

export interface Gate2SecurityReviewOracle {
  readonly caseId: string;
  readonly scenarioEvaluatorId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly response: {
    readonly assessment: "findings" | "no_finding";
    readonly summary: string;
    readonly findings: readonly {
      readonly id: string;
      readonly title: string;
      readonly severity: "low" | "medium" | "high" | "critical";
      readonly description: string;
      readonly exploitCondition: string;
      readonly recommendation: string;
      readonly citations: readonly {
        readonly path: string;
        readonly lineStart: number;
        readonly lineEnd: number;
      }[];
    }[];
    readonly noFinding: {
      readonly rationale: string;
      readonly citations: readonly {
        readonly path: string;
        readonly lineStart: number;
        readonly lineEnd: number;
      }[];
    } | null;
  };
}

export const GATE2_SECURITY_REVIEW_PROVIDER: Readonly<{
  kind: "ollama";
  model: string;
  adapterVersion: string;
  transport: "loopback-http";
}>;
export const GATE2_SECURITY_REVIEW_COHORT_LIMITATIONS: readonly string[];
export const GATE2_SECURITY_REVIEW_ORACLES: readonly Gate2SecurityReviewOracle[];
export function computeGate2SecurityReviewEvidenceDigest(
  observationInput: Record<string, unknown>,
): string;
export function validateGate2SecurityReviewCohortResult(
  value: unknown,
  manifestInput: Gate2BenchmarkManifest,
  manifestSha256: string,
): unknown;
export function parseAndValidateGate2SecurityReviewCohortResult(
  source: string,
  manifest: Gate2BenchmarkManifest,
  manifestSha256: string,
): unknown;
