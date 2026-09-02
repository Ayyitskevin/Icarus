export const GATE2_FROZEN_EVIDENCE_SCHEMA: "icarus.gate2-frozen-evidence.v1";
export interface FrozenEvidenceEntry {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}
/** Digests every JSON file under `root` except the manifest, from the bytes on disk now. */
export function computeFrozenEntries(root: string): Promise<FrozenEvidenceEntry[]>;
/** Mismatch descriptions; an empty array means the manifest is true of the committed bytes. */
export function verifyFrozenEvidence(root: string): Promise<string[]>;
export function freezeLiveEvidence(input: {
  from: string;
  to: string;
  commit: string;
  policyRevision: number;
  evidenceRevision: number;
  note?: string;
}): Promise<{ files: number; manifest: string }>;
