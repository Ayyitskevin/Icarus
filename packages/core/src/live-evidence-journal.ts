import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { canonicalJson, canonicalJsonLine, parseStrictJson } from "./canonical-json.js";
import { IcarusError, invariant } from "./errors.js";
import type {
  LiveEvidenceCaseCompletionV1,
  LiveEvidenceExecutionJournalV1,
  LiveEvidenceJournalStore,
  LiveEvidenceTerminalReceiptV1,
} from "./live-evidence-executor.js";
import {
  LIVE_EVIDENCE_AUTHORIZED_EFFECTS,
  type LiveEvidenceEffect,
} from "./live-evidence-profile.js";
import type { JsonValue } from "./types.js";

const MAX_JOURNAL_BYTES = 4 * 1024 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{1,127}$/;

function invalid(message: string): never {
  throw new IcarusError("LIVE_EVIDENCE_JOURNAL_INVALID", message);
}

function record(value: unknown, keys: readonly string[], field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    invalid(`${field} is not an object`);
  const decoded = value as Record<string, unknown>;
  const actual = Object.keys(decoded).sort();
  const expected = [...keys].sort();
  if (canonicalJson(actual) !== canonicalJson(expected))
    invalid(`${field} has missing or unknown keys`);
  return decoded;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) invalid(`${field} is not text`);
  return value;
}

function digest(value: unknown, field: string): string {
  const decoded = text(value, field);
  if (!SHA256.test(decoded)) invalid(`${field} is not a SHA-256 digest`);
  return decoded;
}

function instant(value: unknown, field: string): string {
  const decoded = text(value, field);
  const parsed = new Date(decoded);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== decoded)
    invalid(`${field} is not an instant`);
  return decoded;
}

function stringArray(value: unknown, field: string): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || entry.length === 0)
  ) {
    invalid(`${field} is not a string array`);
  }
  return value as string[];
}

function finiteNonnegative(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    invalid(`${field} is invalid`);
  return value;
}

function jsonValue(value: unknown, field: string): JsonValue {
  try {
    canonicalJson(value as JsonValue);
  } catch {
    invalid(`${field} is not JSON`);
  }
  return value as JsonValue;
}

function decodeTerminal(value: unknown, field: string): LiveEvidenceTerminalReceiptV1 {
  const decoded = record(
    value,
    [
      "schemaVersion",
      "type",
      "outcome",
      "resumeId",
      "profileId",
      "profileDigestSha256",
      "manifestSha256",
      "caseId",
      "stage",
      "code",
      "completedCaseIds",
      "completedAt",
    ],
    field,
  );
  if (decoded.schemaVersion !== 1 || decoded.type !== "live_evidence_terminal")
    invalid(`${field} version is invalid`);
  const outcome = decoded.outcome;
  if (
    outcome !== "succeeded" &&
    outcome !== "blocked" &&
    outcome !== "interrupted" &&
    outcome !== "failed"
  ) {
    invalid(`${field}.outcome is invalid`);
  }
  const resumeId = text(decoded.resumeId, `${field}.resumeId`);
  if (!UUID.test(resumeId)) invalid(`${field}.resumeId is invalid`);
  const caseId = decoded.caseId === null ? null : text(decoded.caseId, `${field}.caseId`);
  const code = decoded.code === null ? null : text(decoded.code, `${field}.code`);
  if (code !== null && !SAFE_CODE.test(code)) invalid(`${field}.code is invalid`);
  return {
    schemaVersion: 1,
    type: "live_evidence_terminal",
    outcome,
    resumeId,
    profileId: text(decoded.profileId, `${field}.profileId`),
    profileDigestSha256: digest(decoded.profileDigestSha256, `${field}.profileDigestSha256`),
    manifestSha256: digest(decoded.manifestSha256, `${field}.manifestSha256`),
    caseId,
    stage: text(decoded.stage, `${field}.stage`),
    code,
    completedCaseIds: stringArray(decoded.completedCaseIds, `${field}.completedCaseIds`),
    completedAt: instant(decoded.completedAt, `${field}.completedAt`),
  };
}

function decodeCompletion(value: unknown, field: string): LiveEvidenceCaseCompletionV1 {
  const decoded = record(
    value,
    ["caseId", "effects", "spendUsd", "elapsedSeconds", "receipt"],
    field,
  );
  if (!Array.isArray(decoded.effects)) invalid(`${field}.effects is not an array`);
  const effects = decoded.effects.map((effect, index) => {
    if (!LIVE_EVIDENCE_AUTHORIZED_EFFECTS.includes(effect as LiveEvidenceEffect)) {
      invalid(`${field}.effects[${index}] is not authorized`);
    }
    return effect as LiveEvidenceEffect;
  });
  return {
    caseId: text(decoded.caseId, `${field}.caseId`),
    effects,
    spendUsd: finiteNonnegative(decoded.spendUsd, `${field}.spendUsd`),
    elapsedSeconds: finiteNonnegative(decoded.elapsedSeconds, `${field}.elapsedSeconds`),
    receipt: jsonValue(decoded.receipt, `${field}.receipt`),
  };
}

export function decodeLiveEvidenceExecutionJournalV1(
  value: unknown,
): LiveEvidenceExecutionJournalV1 {
  const decoded = record(
    value,
    [
      "schemaVersion",
      "resumeId",
      "profileId",
      "profileDigestSha256",
      "manifestSha256",
      "caseOrder",
      "completedCases",
      "terminalReceipts",
      "terminalReceipt",
      "createdAt",
      "updatedAt",
    ],
    "journal",
  );
  if (decoded.schemaVersion !== 1) invalid("journal.schemaVersion is invalid");
  const resumeId = text(decoded.resumeId, "journal.resumeId");
  if (!UUID.test(resumeId)) invalid("journal.resumeId is invalid");
  if (!Array.isArray(decoded.completedCases) || !Array.isArray(decoded.terminalReceipts)) {
    invalid("journal arrays are invalid");
  }
  const completedCases = decoded.completedCases.map((entry, index) =>
    decodeCompletion(entry, `journal.completedCases[${index}]`),
  );
  const terminalReceipts = decoded.terminalReceipts.map((entry, index) =>
    decodeTerminal(entry, `journal.terminalReceipts[${index}]`),
  );
  const terminalReceipt =
    decoded.terminalReceipt === null
      ? null
      : decodeTerminal(decoded.terminalReceipt, "journal.terminalReceipt");
  const latest = terminalReceipts.at(-1) ?? null;
  if (canonicalJson(latest as JsonValue) !== canonicalJson(terminalReceipt as JsonValue)) {
    invalid("journal.terminalReceipt is not the latest immutable receipt");
  }
  return {
    schemaVersion: 1,
    resumeId,
    profileId: text(decoded.profileId, "journal.profileId"),
    profileDigestSha256: digest(decoded.profileDigestSha256, "journal.profileDigestSha256"),
    manifestSha256: digest(decoded.manifestSha256, "journal.manifestSha256"),
    caseOrder: stringArray(decoded.caseOrder, "journal.caseOrder"),
    completedCases,
    terminalReceipts,
    terminalReceipt,
    createdAt: instant(decoded.createdAt, "journal.createdAt"),
    updatedAt: instant(decoded.updatedAt, "journal.updatedAt"),
  };
}

function isSystemError(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

export class FileLiveEvidenceJournalStore implements LiveEvidenceJournalStore {
  readonly #root: string;

  constructor(stateRoot: string) {
    this.#root = path.join(path.resolve(stateRoot), "live-evidence");
    mkdirSync(this.#root, { recursive: true, mode: 0o700 });
    const stat = lstatSync(this.#root);
    invariant(
      stat.isDirectory() && !stat.isSymbolicLink(),
      "UNSAFE_STATE_ROOT",
      "Live-evidence journal root is unsafe",
    );
    chmodSync(this.#root, 0o700);
  }

  #path(resumeId: string): string {
    if (!UUID.test(resumeId)) invalid("journal resume id is invalid");
    return path.join(this.#root, `${resumeId}.json`);
  }

  #temporaryPath(resumeId: string): string {
    return path.join(this.#root, `.${resumeId}.create`);
  }

  #syncDirectory(): void {
    const directory = openSync(this.#root, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  }

  #recoverCreate(resumeId: string): void {
    const target = this.#path(resumeId);
    const temporary = this.#temporaryPath(resumeId);
    const statOrNull = (candidate: string) => {
      try {
        return lstatSync(candidate);
      } catch (error) {
        if (isSystemError(error, "ENOENT")) return null;
        throw error;
      }
    };
    const temporaryStat = statOrNull(temporary);
    if (temporaryStat === null) return;
    const targetStat = statOrNull(target);
    if (targetStat === null) {
      const pending = this.#read(temporary);
      invariant(
        pending.resumeId === resumeId,
        "LIVE_EVIDENCE_JOURNAL_INVALID",
        "Pending journal binds another resume id",
      );
      linkSync(temporary, target);
      unlinkSync(temporary);
      this.#syncDirectory();
      return;
    }
    invariant(
      temporaryStat.isFile() &&
        targetStat.isFile() &&
        !temporaryStat.isSymbolicLink() &&
        !targetStat.isSymbolicLink() &&
        temporaryStat.dev === targetStat.dev &&
        temporaryStat.ino === targetStat.ino &&
        temporaryStat.nlink === 2 &&
        targetStat.nlink === 2,
      "LIVE_EVIDENCE_JOURNAL_INVALID",
      "Interrupted journal creation is unsafe",
    );
    unlinkSync(temporary);
    this.#syncDirectory();
  }

  #read(target: string): LiveEvidenceExecutionJournalV1 {
    const descriptor = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = fstatSync(descriptor);
      const uid = process.getuid?.();
      invariant(
        before.isFile() &&
          before.nlink === 1 &&
          before.size <= MAX_JOURNAL_BYTES &&
          (uid === undefined || before.uid === uid) &&
          (before.mode & 0o077) === 0,
        "LIVE_EVIDENCE_JOURNAL_INVALID",
        "Live-evidence journal file is unsafe",
      );
      const bytes = readFileSync(descriptor);
      const after = fstatSync(descriptor);
      invariant(
        before.dev === after.dev &&
          before.ino === after.ino &&
          before.size === after.size &&
          before.mtimeMs === after.mtimeMs &&
          bytes.length === after.size,
        "LIVE_EVIDENCE_JOURNAL_INVALID",
        "Live-evidence journal changed while reading",
      );
      const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const value = decodeLiveEvidenceExecutionJournalV1(parseStrictJson(source.trimEnd()));
      invariant(
        canonicalJsonLine(value).equals(bytes),
        "LIVE_EVIDENCE_JOURNAL_INVALID",
        "Live-evidence journal is not canonical",
      );
      return value;
    } finally {
      closeSync(descriptor);
    }
  }

  load(resumeId: string): LiveEvidenceExecutionJournalV1 | null {
    this.#recoverCreate(resumeId);
    try {
      return this.#read(this.#path(resumeId));
    } catch (error) {
      if (isSystemError(error, "ENOENT")) return null;
      throw error;
    }
  }

  create(journal: LiveEvidenceExecutionJournalV1): void {
    const decoded = decodeLiveEvidenceExecutionJournalV1(journal);
    const target = this.#path(decoded.resumeId);
    const temporary = this.#temporaryPath(decoded.resumeId);
    const descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(descriptor, canonicalJsonLine(decoded), "utf8");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    try {
      linkSync(temporary, target);
      unlinkSync(temporary);
      this.#syncDirectory();
    } catch (error) {
      try {
        unlinkSync(temporary);
      } catch {
        // A killed process bypasses cleanup; load reconciles the fixed path.
      }
      throw error;
    }
  }

  save(journal: LiveEvidenceExecutionJournalV1): void {
    const decoded = decodeLiveEvidenceExecutionJournalV1(journal);
    const target = this.#path(decoded.resumeId);
    const prior = this.#read(target);
    invariant(
      decoded.profileDigestSha256 === prior.profileDigestSha256 &&
        decoded.manifestSha256 === prior.manifestSha256 &&
        decoded.createdAt === prior.createdAt &&
        canonicalJson(decoded.caseOrder as JsonValue) ===
          canonicalJson(prior.caseOrder as JsonValue) &&
        canonicalJson(
          decoded.completedCases.slice(0, prior.completedCases.length) as unknown as JsonValue,
        ) === canonicalJson(prior.completedCases as unknown as JsonValue) &&
        canonicalJson(
          decoded.terminalReceipts.slice(0, prior.terminalReceipts.length) as unknown as JsonValue,
        ) === canonicalJson(prior.terminalReceipts as unknown as JsonValue),
      "LIVE_EVIDENCE_JOURNAL_INVALID",
      "Live-evidence journal update is not append-only",
    );
    const temporary = path.join(this.#root, `.${decoded.resumeId}.${randomUUID()}.tmp`);
    const descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(descriptor, canonicalJsonLine(decoded), "utf8");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, target);
    this.#syncDirectory();
  }
}
