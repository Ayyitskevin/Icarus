import type { Gate2BenchmarkManifest } from "./gate2-benchmark-contract.mjs";

export interface Gate2ScaffoldAOracle {
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

export const GATE2_SCAFFOLD_A_PROVIDER: {
  readonly kind: "ollama";
  readonly model: string;
  readonly adapterVersion: string;
  readonly transport: "loopback-http";
  readonly instructionDigests: readonly string[];
};
export const GATE2_SCAFFOLD_A_MANIFEST_CASE_IDS: readonly string[];
export const GATE2_SCAFFOLD_A_EXCLUDED_CASE_ID: string;
export const GATE2_SCAFFOLD_A_COHORT_LIMITATIONS: readonly string[];
export const GATE2_SCAFFOLD_A_ORACLES: readonly Gate2ScaffoldAOracle[];

export function computeGate2ScaffoldAEvidenceDigest(observation: Record<string, unknown>): string;
export function validateGate2ScaffoldACohortResult<T>(
  value: T,
  manifest: Gate2BenchmarkManifest,
  manifestSha256: string,
): T;
export function parseAndValidateGate2ScaffoldACohortResult(
  source: string,
  manifest: Gate2BenchmarkManifest,
  manifestSha256: string,
): unknown;
