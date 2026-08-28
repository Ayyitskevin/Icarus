import type { Gate2BenchmarkManifest } from "./gate2-benchmark-contract.mjs";

export interface Gate2RefactorOracle {
  readonly caseId: string;
  readonly scenarioEvaluatorId: string;
  readonly baselineOutcome: "passed" | "failed";
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly check: {
    readonly id: string;
    readonly name: string;
    readonly argv: readonly string[];
  };
  readonly approvedFiles: readonly {
    readonly op: "modify" | "create";
    readonly path: string;
    readonly sha256: string;
    readonly content: string;
  }[];
}

export const GATE2_REFACTOR_PROVIDER: {
  readonly kind: "ollama";
  readonly model: string;
  readonly adapterVersion: string;
  readonly transport: "loopback-http";
  readonly instructionDigests: readonly string[];
};
export const GATE2_REFACTOR_COHORT_LIMITATIONS: readonly string[];
export const GATE2_REFACTOR_ORACLES: readonly Gate2RefactorOracle[];

export function computeGate2RefactorEvidenceDigest(observation: Record<string, unknown>): string;
export function validateGate2RefactorCohortResult<T>(
  value: T,
  manifest: Gate2BenchmarkManifest,
  manifestSha256: string,
): T;
export function parseAndValidateGate2RefactorCohortResult(
  source: string,
  manifest: Gate2BenchmarkManifest,
  manifestSha256: string,
): unknown;
