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
