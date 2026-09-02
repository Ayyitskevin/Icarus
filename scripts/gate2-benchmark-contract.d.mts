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

export interface Gate2BenchmarkReplacement {
  predecessorCaseId: string;
  successorCaseId: string;
  reason: string;
}

export interface Gate2BenchmarkSupersedes {
  benchmarkRevision: string;
  manifestPath: string;
  manifestSha256: string;
}

export interface Gate2BenchmarkManifest {
  schemaVersion: 1 | 2;
  benchmarkId: string;
  benchmarkRevision: string;
  supersedes?: Gate2BenchmarkSupersedes;
  replacements?: Gate2BenchmarkReplacement[];
  digestEncoding: string;
  resultSchemaVersion: 1;
  executionBoundary: Record<string, unknown>;
  thresholds: Record<string, unknown>;
  measurementDefinitions: Record<string, string>;
  repositories: Gate2BenchmarkRepository[];
  cases: Gate2BenchmarkCase[];
}

export const GATE2_CLASS_COUNTS: Readonly<Record<string, number>>;
export const MAX_GATE2_JSON_BYTES: number;
export const GATE2_REPOSITORY_IDS: readonly string[];
export const GATE2_CASE_IDS: readonly string[];
export const GATE2_V1_MANIFEST_SHA256: string;
export const GATE2_CASE_IDS_BY_REVISION: Readonly<Record<string, readonly string[]>>;

export function sha256Raw(value: string | Uint8Array): string;
export function parseStrictGate2Json(source: string): unknown;
export function validateGate2BenchmarkManifest(value: unknown): Gate2BenchmarkManifest;
export function validateGate2BenchmarkSuccessor(
  successor: unknown,
  predecessor: unknown,
  predecessorManifestSha256: string,
): Gate2BenchmarkManifest;
export function loadGate2BenchmarkContract(
  manifestPath: string | URL,
  repositoryRoot: string,
): Promise<{
  manifest: Gate2BenchmarkManifest;
  manifestSha256: string;
  predecessorManifestSha256: string | null;
}>;
export function describeNonStrictGate2Json(
  source: unknown,
): "not_text" | "empty" | "markdown_fenced" | "leading_prose" | "truncated" | "other";
