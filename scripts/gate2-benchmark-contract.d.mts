export interface Gate2BenchmarkRepositoryFile {
  path: string;
  sha256: string;
}

export interface Gate2BenchmarkRepository {
  id: string;
  stack: string;
  fixturePath: string;
  revisionSha256: string;
  files: Gate2BenchmarkRepositoryFile[];
}

export interface Gate2BenchmarkOutcome {
  kind: "mutation" | "read_only";
  expectedChangedPaths: string[];
  expectedCitationPaths: string[];
  expectedFindingIds: string[];
  allowNoFinding: boolean;
  scenarioEvaluatorId: string;
}

export interface Gate2BenchmarkCase {
  id: string;
  class: "repair" | "refactor" | "explanation" | "security_review" | "scaffold";
  repositoryId: string;
  task: { path: string; sha256: string };
  expectedContextPaths: string[];
  expectedOutcome: Gate2BenchmarkOutcome;
}

export interface Gate2BenchmarkManifest {
  schemaVersion: 1;
  benchmarkId: string;
  benchmarkRevision: string;
  digestEncoding: string;
  resultSchemaVersion: 1;
  executionBoundary: Record<string, unknown>;
  thresholds: Record<string, unknown>;
  measurementDefinitions: Record<string, string>;
  repositories: Gate2BenchmarkRepository[];
  cases: Gate2BenchmarkCase[];
}

export const GATE2_CLASS_COUNTS: Readonly<Record<string, number>>;
export const GATE2_REPOSITORY_IDS: readonly string[];
export const GATE2_CASE_IDS: readonly string[];

export function sha256Raw(value: string | Uint8Array): string;
export function parseStrictGate2Json(source: string): unknown;
export function validateGate2BenchmarkManifest(value: unknown): Gate2BenchmarkManifest;
export function loadGate2BenchmarkContract(
  manifestPath: string | URL,
  repositoryRoot: string,
): Promise<{ manifest: Gate2BenchmarkManifest; manifestSha256: string }>;
