export const GATE2_FROZEN_EVIDENCE_SCHEMA: "icarus.gate2-frozen-evidence.v2";
export interface FrozenEvidenceEntry {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}
/** What a set's case records encode, derived from their bytes; the manifest must restate it. */
export interface FrozenRecordContract {
  readonly evidenceRecordRevision: number;
  readonly requestedThinkMemberPresent: boolean;
  readonly absentThinkingEncodedAs: number | null;
  readonly writtenOn: string;
  /** Present only when every record reports the same value. */
  readonly everyRecordReasoningChars?: number | null;
}
/** True for the freezer's own refusals (verdicts about the evidence) and nothing else. */
export function isFreezerRefusal(error: unknown): boolean;
/** Digests every file under `root` except the manifest, from the bytes on disk now. Refuses a root that resolves through a symlink. */
export function computeFrozenEntries(root: string): Promise<FrozenEvidenceEntry[]>;
/** Derives the record contract from the case records; throws when the records disagree. */
export function deriveRecordContract(root: string): Promise<FrozenRecordContract>;
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
