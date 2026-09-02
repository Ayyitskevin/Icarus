export function verifyGate2PublishedEvidence(
  repositoryRoot?: string,
  profileVersion?: "v1" | "v2" | "reasoning-suppressed",
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
  reasoningSuppressed: Awaited<ReturnType<typeof verifyGate2PublishedEvidence>>;
}>;
/**
 * True when a record's bytes match the record contract its published set declares.
 * A contract without `everyRecordReasoningChars` makes no claim about reasoning size and
 * nothing is compared against it; the other members bind either way.
 */
export function recordContractBound(
  record: unknown,
  config: { recordContract?: Record<string, unknown> },
): boolean;
