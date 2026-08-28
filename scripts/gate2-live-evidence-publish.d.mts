export function verifyGate2PublishedEvidence(
  repositoryRoot?: string,
  profileVersion?: "v1" | "v2",
): Promise<{
  destination: string;
  manifest: Record<string, unknown>;
  files: Array<{ path: string; bytes: number; sha256: string }>;
  baseline: Record<string, unknown>;
  routed: Record<string, unknown>;
  comparison: Record<string, unknown>;
}>;
export function isGate2ProviderOutcomeBound(
  record: Record<string, unknown>,
  profile: Record<string, unknown>,
  evidenceRecordRevision: number,
): boolean;
export function verifyGate2PublishedEvidenceSet(repositoryRoot?: string): Promise<{
  v1: Awaited<ReturnType<typeof verifyGate2PublishedEvidence>>;
  v2: Awaited<ReturnType<typeof verifyGate2PublishedEvidence>>;
}>;
