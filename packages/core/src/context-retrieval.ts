import { Buffer } from "node:buffer";

import {
  containsSecretShapedContent,
  decodeTextOrNull,
  isWorkspaceContextPathExcluded,
  MAX_TRACKED_TREE_FILE_BYTES,
} from "./context.js";
import { digestJson, sha256 } from "./digest.js";
import { IcarusError, invariant } from "./errors.js";
import type { GitController, TreeEntry } from "./git.js";
import type { JsonValue } from "./types.js";

/**
 * v3 adds omission evidence and separates query matches from reference-hop
 * files. A result recorded under an earlier version carries neither, and that
 * absence means "not recorded" -- never "nothing was omitted". Frozen v1 reports
 * stay valid because they are bound by their own raw digests, not re-derived
 * through this contract.
 */
export const GATE2_RETRIEVAL_SCHEMA = "icarus.context-retrieval.v3";
export const MAX_RETRIEVAL_QUERY_BYTES = 16 * 1024;
export const MAX_RETRIEVAL_QUERY_TERMS = 128;
export const MAX_RETRIEVAL_TREE_ENTRIES = 2_000;
export const MAX_RETRIEVAL_FILES = 64;
export const MAX_RETRIEVAL_BYTES = 512 * 1024;
export const MAX_RETRIEVAL_SCAN_BYTES = 64 * 1024 * 1024;

export interface ContextRetrievalBudgetV3 {
  readonly maxFiles: number;
  readonly maxTotalBytes: number;
  readonly maxScanBytes: number;
}

export interface ContextRetrievalMatchV3 {
  readonly term: string;
  readonly lines: readonly number[];
}

/**
 * A file that matched the operator's query and was ranked, then dropped because
 * a selection ceiling was already spent. Without this the caller cannot tell a
 * repository that held no contrary evidence from one whose contrary evidence
 * ranked below the cap -- and a security review's "no finding" rests on exactly
 * that distinction.
 */
export interface ContextRetrievalOmissionV3 {
  readonly path: string;
  readonly bytes: number;
  readonly reason: "file_ceiling" | "byte_ceiling";
}

/**
 * Structurally ineligible tree entries, counted before any content is read.
 * A symlink blob or a submodule gitlink was withheld from the candidate set,
 * and "zero pre-candidate exclusions" cannot be claimed without saying so.
 */
export interface ContextRetrievalExclusionCountsV3 {
  readonly byPolicy: number;
  readonly nonText: number;
  readonly secretShaped: number;
  readonly unsupportedEntry: number;
}

export interface ContextRetrievalEntryV3 {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly score: number;
  readonly matchedTerms: readonly string[];
  readonly lineCount: number;
  readonly matches: readonly ContextRetrievalMatchV3[];
  readonly content: string;
}

export interface ContextRetrievalResultV3 {
  readonly schema: typeof GATE2_RETRIEVAL_SCHEMA;
  readonly baseCommit: string;
  readonly querySha256: string;
  readonly queryTerms: readonly string[];
  readonly repositoryDigestSha256: string;
  readonly entries: readonly ContextRetrievalEntryV3[];
  readonly totalBytes: number;
  readonly scannedFiles: number;
  readonly scannedBytes: number;
  /** Files that matched at least one query term, selected or not. */
  readonly matchedFiles: number;
  /**
   * Query-matched files a ceiling excluded, in rank order. Empty means none
   * were. A file reached only by the reference hop never matched the query and
   * is never recorded here -- calling it a match would be a false label.
   */
  readonly omittedMatches: readonly ContextRetrievalOmissionV3[];
  /**
   * Reference-hop files a ceiling excluded, in the path order the hop walks.
   * Separate from the matches because the two answer different questions: what
   * the query found, and what following one hop from it would have added.
   */
  readonly omittedReferences: readonly ContextRetrievalOmissionV3[];
  /**
   * Files skipped before scoring, so they were never candidates. Counted rather
   * than named: a path is disclosed here only for files that passed the secret
   * screen, which these did not.
   */
  readonly excludedFiles: ContextRetrievalExclusionCountsV3;
  readonly digestSha256: string;
}

/**
 * Validates the omission evidence a v3 receipt must carry, returning a reason
 * when it does not. Exported because both artifact writers have to REQUIRE this
 * evidence rather than recompute a digest over whatever members happen to be
 * present: absent members serialize away, so a v2-shaped object relabelled v3
 * would otherwise validate and mint a trusted-looking artifact whose
 * completeness claim never existed.
 */
export function retrievalOmissionEvidenceProblem(
  retrieval: ContextRetrievalResultV3,
): string | null {
  const counts = retrieval.excludedFiles as ContextRetrievalExclusionCountsV3 | undefined;
  if (
    !Number.isSafeInteger(retrieval.matchedFiles) ||
    retrieval.matchedFiles < 0 ||
    !Array.isArray(retrieval.omittedMatches) ||
    !Array.isArray(retrieval.omittedReferences) ||
    counts === undefined ||
    typeof counts !== "object" ||
    !Number.isSafeInteger(counts.byPolicy) ||
    counts.byPolicy < 0 ||
    !Number.isSafeInteger(counts.nonText) ||
    counts.nonText < 0 ||
    !Number.isSafeInteger(counts.secretShaped) ||
    counts.secretShaped < 0 ||
    !Number.isSafeInteger(counts.unsupportedEntry) ||
    counts.unsupportedEntry < 0
  ) {
    return "retrieval omission evidence is absent or malformed";
  }
  // The counts must reconcile against the receipt's own entries, not merely be
  // individually plausible. Without this a receipt claiming two matches while
  // showing one selected match and no omissions validates, and both writers bind
  // that internally impossible completeness claim into a trusted artifact digest.
  const selectedQueryMatches = retrieval.entries.filter(
    (entry) => entry.matchedTerms.length > 0,
  ).length;
  if (retrieval.matchedFiles !== selectedQueryMatches + retrieval.omittedMatches.length) {
    return "retrieval coverage does not reconcile with its own entries";
  }
  const selected = new Set(retrieval.entries.map((entry) => entry.path));
  const seen = new Set<string>();
  for (const omission of [...retrieval.omittedMatches, ...retrieval.omittedReferences]) {
    if (
      typeof omission !== "object" ||
      omission === null ||
      typeof omission.path !== "string" ||
      omission.path.length < 1 ||
      omission.path.startsWith("/") ||
      omission.path.includes("\\") ||
      omission.path.split("/").some((part: string) => part === "" || part === "." || part === "..")
    ) {
      return "retrieval omission path is invalid";
    }
    if (!Number.isSafeInteger(omission.bytes) || omission.bytes < 0) {
      return "retrieval omission size is invalid";
    }
    if (omission.reason !== "file_ceiling" && omission.reason !== "byte_ceiling") {
      return "retrieval omission reason is unsupported";
    }
    // A path cannot be both returned and withheld, and cannot be withheld twice.
    if (selected.has(omission.path)) return "retrieval omitted a path it also selected";
    if (seen.has(omission.path)) return "retrieval recorded one omission twice";
    seen.add(omission.path);
  }
  return null;
}

type RetrievalGit = Pick<GitController, "listTree" | "readBlob">;

interface ScoredEntry extends ContextRetrievalEntryV3 {
  readonly pathMatches: number;
}

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "explain",
  "file",
  "files",
  "for",
  "from",
  "in",
  "is",
  "it",
  "line",
  "module",
  "no",
  "of",
  "on",
  "or",
  "repository",
  "the",
  "to",
  "with",
]);

const TOKEN_ALIASES = new Map([
  ["assert", "test"],
  ["assertion", "test"],
  ["assertions", "test"],
  ["check", "check"],
  ["checks", "check"],
  ["configuration", "config"],
  ["configurations", "config"],
  ["configured", "config"],
  ["test", "test"],
  ["tests", "test"],
  ["verification", "check"],
  ["verifications", "check"],
  ["verified", "check"],
  ["verify", "check"],
  ["verifies", "check"],
]);

function invalid(message: string): never {
  throw new IcarusError("INVALID_CONTEXT_RETRIEVAL", message);
}

function asJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function canonicalToken(raw: string): string {
  const token = raw.toLowerCase();
  return TOKEN_ALIASES.get(token) ?? token;
}

function tokenize(value: string): readonly string[] {
  const tokens =
    value
      .normalize("NFC")
      .toLowerCase()
      .match(/[a-z0-9]+/g) ?? [];
  return [
    ...new Set(
      tokens
        .map(canonicalToken)
        .filter((token) => !STOP_WORDS.has(token) && (token.length > 1 || /^[0-9]+$/.test(token))),
    ),
  ].sort();
}

function assertBudget(budget: ContextRetrievalBudgetV3): void {
  const fields = [
    ["maxFiles", budget.maxFiles, MAX_RETRIEVAL_FILES],
    ["maxTotalBytes", budget.maxTotalBytes, MAX_RETRIEVAL_BYTES],
    ["maxScanBytes", budget.maxScanBytes, MAX_RETRIEVAL_SCAN_BYTES],
  ] as const;
  for (const [name, value, maximum] of fields) {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
      invalid(`${name} must be an integer between 1 and ${maximum}`);
    }
  }
  if (budget.maxTotalBytes > budget.maxScanBytes) {
    invalid("maxTotalBytes must not exceed maxScanBytes");
  }
}

function compareTreeEntries(left: TreeEntry, right: TreeEntry): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function lineMatches(content: string, queryTerms: readonly string[]): ContextRetrievalMatchV3[] {
  const lines = content.split("\n");
  const matches: ContextRetrievalMatchV3[] = [];
  for (const term of queryTerms) {
    const matchedLines: number[] = [];
    for (let index = 0; index < lines.length && matchedLines.length < 8; index += 1) {
      if (tokenize(lines[index] ?? "").includes(term)) matchedLines.push(index + 1);
    }
    if (matchedLines.length > 0) matches.push({ term, lines: matchedLines });
  }
  return matches;
}

function scoreEntry(
  entry: TreeEntry,
  content: string,
  queryTerms: readonly string[],
  source: { readonly bytes: number; readonly sha256: string },
): ScoredEntry {
  const pathTerms = new Set(tokenize(entry.path));
  const contentTerms = new Set(tokenize(content));
  const matchedTerms = queryTerms.filter((term) => pathTerms.has(term) || contentTerms.has(term));
  const pathMatches = matchedTerms.filter((term) => pathTerms.has(term)).length;
  const contentMatches = matchedTerms.filter((term) => contentTerms.has(term)).length;
  const seedBonus = /^(?:readme(?:\.[^/]*)?|package\.json|pyproject\.toml|cargo\.toml)$/i.test(
    entry.path,
  )
    ? 1
    : 0;
  return {
    path: entry.path,
    bytes: source.bytes,
    sha256: source.sha256,
    score: pathMatches * 16 + contentMatches * 2 + seedBonus,
    pathMatches,
    matchedTerms,
    lineCount: content.split("\n").length,
    matches: lineMatches(content, matchedTerms),
    content,
  };
}

function referenceForms(
  filePath: string,
  candidates: ReadonlyMap<string, ScoredEntry>,
): readonly string[] {
  const extensionIndex = filePath.lastIndexOf(".");
  const withoutExtension =
    extensionIndex > filePath.lastIndexOf("/") ? filePath.slice(0, extensionIndex) : filePath;
  if (withoutExtension !== filePath && candidates.has(withoutExtension)) return [filePath];
  return [...new Set([filePath, withoutExtension, withoutExtension.replaceAll("/", ".")])].filter(
    (form) => form.length >= 3,
  );
}

function containsBoundedReference(content: string, reference: string): boolean {
  const referenceCharacter = /[A-Za-z0-9_./-]/;
  let start = content.indexOf(reference);
  while (start !== -1) {
    const before = start === 0 ? "" : (content[start - 1] ?? "");
    const afterIndex = start + reference.length;
    const after = content[afterIndex] ?? "";
    const periodEndsSentence =
      after === "." && /^(?:$|[\s)\]}'",;:!?])/.test(content[afterIndex + 1] ?? "");
    if (
      !referenceCharacter.test(before) &&
      (!referenceCharacter.test(after) || periodEndsSentence)
    ) {
      return true;
    }
    start = content.indexOf(reference, start + 1);
  }
  return false;
}

function referencedEntries(
  source: ScoredEntry,
  candidates: ReadonlyMap<string, ScoredEntry>,
): readonly ScoredEntry[] {
  return [...candidates.values()]
    .filter(
      (candidate) =>
        candidate.path !== source.path &&
        referenceForms(candidate.path, candidates).some((form) =>
          containsBoundedReference(source.content, form),
        ),
    )
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

function publicEntry(entry: ScoredEntry): ContextRetrievalEntryV3 {
  const { pathMatches: _pathMatches, ...result } = entry;
  return result;
}

function digestableResult(result: Omit<ContextRetrievalResultV3, "digestSha256">): JsonValue {
  return asJsonValue({
    ...result,
    entries: result.entries.map(({ content: _content, ...entry }) => entry),
  });
}

/**
 * Select a bounded, lexical read-only context set from one exact committed tree.
 * Repository data is never executed. Hidden, linked, binary, invalid-UTF-8, and
 * secret-shaped files cannot enter the result.
 */
export async function retrieveReadOnlyContextV3(
  git: RetrievalGit,
  repositoryPath: string,
  baseCommit: string,
  query: string,
  budget: ContextRetrievalBudgetV3,
  signal?: AbortSignal,
): Promise<ContextRetrievalResultV3> {
  assertBudget(budget);
  const queryBytes = Buffer.byteLength(query, "utf8");
  if (
    queryBytes < 1 ||
    queryBytes > MAX_RETRIEVAL_QUERY_BYTES ||
    query !== query.normalize("NFC") ||
    containsSecretShapedContent(Buffer.from(query, "utf8"))
  ) {
    invalid("query must be non-empty NFC text within the byte ceiling and contain no secret shape");
  }
  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) invalid("query must contain at least one retrieval term");
  if (queryTerms.length > MAX_RETRIEVAL_QUERY_TERMS) {
    invalid(`query must not exceed ${MAX_RETRIEVAL_QUERY_TERMS} unique retrieval terms`);
  }
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(baseCommit)) {
    invalid("baseCommit must be one lowercase Git object ID");
  }

  const tree = [...(await git.listTree(repositoryPath, baseCommit, signal))].sort(
    compareTreeEntries,
  );
  invariant(
    tree.length <= MAX_RETRIEVAL_TREE_ENTRIES,
    "CONTEXT_RETRIEVAL_TREE_BUDGET_EXCEEDED",
    "Committed tree exceeds the Gate 2 retrieval entry ceiling",
  );

  const repositoryFiles: Array<{ path: string; bytes: number; sha256: string }> = [];
  const eligible = new Map<string, ScoredEntry>();
  let scannedFiles = 0;
  let scannedBytes = 0;
  let excludedByPolicy = 0;
  let excludedNonText = 0;
  let excludedSecretShaped = 0;
  let excludedUnsupportedEntry = 0;
  for (const entry of tree) {
    signal?.throwIfAborted();
    if (entry.type === "tree") continue;
    if (entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755")) {
      // A symlink blob or a submodule gitlink was found and withheld. Counting it
      // is what lets a reader distinguish "the tree held nothing else" from
      // "the tree held things this retrieval cannot read".
      excludedUnsupportedEntry += 1;
      continue;
    }
    if (isWorkspaceContextPathExcluded(entry.path)) {
      excludedByPolicy += 1;
      continue;
    }
    const bytes = await git.readBlob(
      repositoryPath,
      entry.objectId,
      MAX_TRACKED_TREE_FILE_BYTES,
      signal,
    );
    scannedFiles += 1;
    scannedBytes += bytes.length;
    invariant(
      scannedBytes <= budget.maxScanBytes,
      "CONTEXT_RETRIEVAL_SCAN_BUDGET_EXCEEDED",
      "Committed tree exceeds the Gate 2 retrieval scan byte ceiling",
    );
    const content = decodeTextOrNull(bytes);
    if (content === null) {
      excludedNonText += 1;
      continue;
    }
    if (containsSecretShapedContent(bytes)) {
      excludedSecretShaped += 1;
      continue;
    }
    const file = { path: entry.path, bytes: bytes.length, sha256: sha256(bytes) };
    repositoryFiles.push(file);
    const candidate = scoreEntry(entry, content, queryTerms, file);
    eligible.set(candidate.path, candidate);
  }

  const scored = [...eligible.values()].filter((candidate) => candidate.matchedTerms.length > 0);
  scored.sort(
    (left, right) =>
      right.score - left.score ||
      right.pathMatches - left.pathMatches ||
      (left.path < right.path ? -1 : left.path > right.path ? 1 : 0),
  );
  const entries: ContextRetrievalEntryV3[] = [];
  const selectedPaths = new Set<string>();
  const omittedPaths = new Set<string>();
  const omittedMatches: ContextRetrievalOmissionV3[] = [];
  const omittedReferences: ContextRetrievalOmissionV3[] = [];
  let totalBytes = 0;
  // A ceiling refusal is evidence, not a non-event: the file was found, it
  // ranked, and only the budget kept it out. Recorded once per path. A file
  // reached only by the reference hop goes to its own list -- it never matched
  // the query, and filing it under matches would make the record say something
  // the retrieval never observed.
  function omit(candidate: ScoredEntry, reason: ContextRetrievalOmissionV3["reason"]): void {
    if (selectedPaths.has(candidate.path) || omittedPaths.has(candidate.path)) return;
    omittedPaths.add(candidate.path);
    const omission = { path: candidate.path, bytes: candidate.bytes, reason };
    // Classify by what the file IS, not by which traversal reached it first. A
    // query match discovered while following a reference hop is still a query
    // match; filing it under references would let the coverage claim every query
    // match was selected while the only withheld file was incidental context.
    if (candidate.matchedTerms.length > 0) omittedMatches.push(omission);
    else omittedReferences.push(omission);
  }
  function select(candidate: ScoredEntry): boolean {
    if (selectedPaths.has(candidate.path)) return true;
    if (entries.length >= budget.maxFiles) {
      omit(candidate, "file_ceiling");
      return false;
    }
    const accountedBytes = candidate.bytes + Buffer.byteLength(candidate.path, "utf8");
    if (totalBytes + accountedBytes > budget.maxTotalBytes) {
      omit(candidate, "byte_ceiling");
      return false;
    }
    entries.push(publicEntry(candidate));
    selectedPaths.add(candidate.path);
    totalBytes += accountedBytes;
    return true;
  }
  for (const candidate of scored) {
    if (entries.length >= budget.maxFiles) {
      omit(candidate, "file_ceiling");
      continue;
    }
    if (!select(candidate)) continue;
    // Follow one deterministic reference hop only from files that matched the
    // operator's query. Repository text can influence ordering inside the
    // already-approved byte/file ceilings, but cannot widen either ceiling or
    // make linked, generated, binary, invalid, or secret-shaped files eligible.
    for (const referenced of referencedEntries(candidate, eligible)) {
      // The ceiling stops the hop, but a file it already discovered still has to
      // be recorded. Breaking here without omitting is how a discovered file
      // vanished with no trace of ever having been found.
      if (entries.length >= budget.maxFiles) {
        omit(referenced, "file_ceiling");
        continue;
      }
      select(referenced);
    }
  }

  const unsigned = {
    schema: GATE2_RETRIEVAL_SCHEMA,
    baseCommit,
    querySha256: sha256(Buffer.from(query, "utf8")),
    queryTerms,
    repositoryDigestSha256: digestJson(asJsonValue({ baseCommit, files: repositoryFiles })),
    entries,
    totalBytes,
    scannedFiles,
    scannedBytes,
    matchedFiles: scored.length,
    omittedMatches,
    omittedReferences,
    excludedFiles: {
      byPolicy: excludedByPolicy,
      nonText: excludedNonText,
      secretShaped: excludedSecretShaped,
      unsupportedEntry: excludedUnsupportedEntry,
    },
  } satisfies Omit<ContextRetrievalResultV3, "digestSha256">;
  return { ...unsigned, digestSha256: digestJson(digestableResult(unsigned)) };
}
