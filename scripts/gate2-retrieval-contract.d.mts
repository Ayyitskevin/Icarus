export const GATE2_RETRIEVAL_LIMITATIONS: readonly string[];
export interface Gate2RetrievalManifest {
  schemaVersion: number;
  benchmarkId: string;
  benchmarkRevision: number;
  resultSchemaVersion: number;
  executionBoundary: {
    mode: string;
    providerCalls: number;
    networkRequests: number;
    repositoryMutations: number;
    registeredCommands: number;
    measuresExplanationCompletion: boolean;
  };
  case: {
    id: string;
    class: string;
    repository: {
      fixturePath: string;
      treeSha1: string;
      commitSha1: string;
      files: Array<{ path: string; sha256: string }>;
    };
    task: { path: string; sha256: string };
    expectedPaths: string[];
    retrievalBudget: { maxFiles: number; maxTotalBytes: number; maxScanBytes: number };
    thresholds: { minimumRecall: number; minimumPrecision: number };
    requiredEvidence: string[];
    claimBoundary: string;
  };
}
export function validateGate2RetrievalManifest(value: unknown): Gate2RetrievalManifest;
export function validateGate2RetrievalResult(
  value: unknown,
  manifest: Gate2RetrievalManifest,
  expectedManifestSha256: string,
): unknown;
