import type { Gate2BenchmarkManifest } from "./gate2-benchmark-contract.mjs";

export interface Gate2SchemaSuccessorOracle {
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

export const GATE2_SCHEMA_SUCCESSOR_PROVIDER: {
  readonly kind: "ollama";
  readonly model: string;
  readonly adapterVersion: string;
  readonly transport: "loopback-http";
  readonly instructionDigests: readonly string[];
};
export const GATE2_SCHEMA_SUCCESSOR_MANIFEST_CASE_IDS: readonly string[];
export const GATE2_SCHEMA_SUCCESSOR_COHORT_LIMITATIONS: readonly string[];
export const GATE2_SCHEMA_SUCCESSOR_ORACLES: readonly Gate2SchemaSuccessorOracle[];

export function computeGate2SchemaSuccessorEvidenceDigest(
  observation: Record<string, unknown>,
): string;
export function validateGate2SchemaSuccessorCohortResult<T>(
  value: T,
  manifest: Gate2BenchmarkManifest,
  manifestSha256: string,
): T;
export function parseAndValidateGate2SchemaSuccessorCohortResult(
  source: string,
  manifest: Gate2BenchmarkManifest,
  manifestSha256: string,
): unknown;
