// biome-ignore-all lint/suspicious/noExplicitAny: runtime validators own the closed manifest grammars and adversarial tests mutate copies.
export interface Gate2V2EvidenceSourceReportSpecification {
  readonly path: string;
  readonly sha256: string;
  readonly benchmarkRevision: string;
}

export interface Gate2V2EvidenceSourceReportInput {
  path: string;
  source: string;
}

export interface Gate2V2EvidenceAdoptionContext {
  predecessorManifest: Record<string, any>;
  predecessorManifestSha256: string;
  successorManifest: Record<string, any>;
  successorManifestSha256: string;
  sourceReports: Gate2V2EvidenceSourceReportInput[];
}

export const GATE2_V2_EVIDENCE_SOURCE_REPORTS: readonly Gate2V2EvidenceSourceReportSpecification[];
export const GATE2_V2_EVIDENCE_ADOPTION_LIMITATIONS: readonly string[];

export function buildGate2V2EvidenceAdoptionResult(
  context: Gate2V2EvidenceAdoptionContext,
): Record<string, unknown>;
export function validateGate2V2EvidenceAdoptionResult<T>(
  value: T,
  context: Gate2V2EvidenceAdoptionContext,
): T;
export function parseAndValidateGate2V2EvidenceAdoptionResult(
  source: string,
  context: Gate2V2EvidenceAdoptionContext,
): unknown;
