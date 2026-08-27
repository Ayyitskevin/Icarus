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

export const GATE2_RETRIEVAL_SCHEMA = "icarus.context-retrieval.v1";
export const MAX_RETRIEVAL_QUERY_BYTES = 16 * 1024;
export const MAX_RETRIEVAL_QUERY_TERMS = 128;
export const MAX_RETRIEVAL_TREE_ENTRIES = 2_000;
export const MAX_RETRIEVAL_FILES = 64;
export const MAX_RETRIEVAL_BYTES = 512 * 1024;
export const MAX_RETRIEVAL_SCAN_BYTES = 64 * 1024 * 1024;

export interface ContextRetrievalBudgetV1 {
  readonly maxFiles: number;
  readonly maxTotalBytes: number;
  readonly maxScanBytes: number;
}

export interface ContextRetrievalMatchV1 {
  readonly term: string;
  readonly lines: readonly number[];
}

export interface ContextRetrievalEntryV1 {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly score: number;
  readonly matchedTerms: readonly string[];
  readonly lineCount: number;
  readonly matches: readonly ContextRetrievalMatchV1[];
  readonly content: string;
}

export interface ContextRetrievalResultV1 {
  readonly schema: typeof GATE2_RETRIEVAL_SCHEMA;
  readonly baseCommit: string;
  readonly querySha256: string;
  readonly queryTerms: readonly string[];
  readonly repositoryDigestSha256: string;
  readonly entries: readonly ContextRetrievalEntryV1[];
  readonly totalBytes: number;
  readonly scannedFiles: number;
  readonly scannedBytes: number;
  readonly digestSha256: string;
}

type RetrievalGit = Pick<GitController, "listTree" | "readBlob">;

interface ScoredEntry extends ContextRetrievalEntryV1 {
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
  ["configuration", "config"],
  ["configurations", "config"],
  ["configured", "config"],
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

function assertBudget(budget: ContextRetrievalBudgetV1): void {
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

function lineMatches(content: string, queryTerms: readonly string[]): ContextRetrievalMatchV1[] {
  const lines = content.split("\n");
  const matches: ContextRetrievalMatchV1[] = [];
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
): ScoredEntry | null {
  const pathTerms = new Set(tokenize(entry.path));
  const contentTerms = new Set(tokenize(content));
  const matchedTerms = queryTerms.filter((term) => pathTerms.has(term) || contentTerms.has(term));
  if (matchedTerms.length === 0) return null;
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
    score: pathMatches * 8 + contentMatches * 2 + seedBonus,
    pathMatches,
    matchedTerms,
    lineCount: content.split("\n").length,
    matches: lineMatches(content, matchedTerms),
    content,
  };
}

function publicEntry(entry: ScoredEntry): ContextRetrievalEntryV1 {
  const { pathMatches: _pathMatches, ...result } = entry;
  return result;
}

function digestableResult(result: Omit<ContextRetrievalResultV1, "digestSha256">): JsonValue {
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
export async function retrieveReadOnlyContextV1(
  git: RetrievalGit,
  repositoryPath: string,
  baseCommit: string,
  query: string,
  budget: ContextRetrievalBudgetV1,
  signal?: AbortSignal,
): Promise<ContextRetrievalResultV1> {
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
  const scored: ScoredEntry[] = [];
  let scannedFiles = 0;
  let scannedBytes = 0;
  for (const entry of tree) {
    signal?.throwIfAborted();
    if (
      entry.type !== "blob" ||
      (entry.mode !== "100644" && entry.mode !== "100755") ||
      isWorkspaceContextPathExcluded(entry.path)
    ) {
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
    if (content === null || containsSecretShapedContent(bytes)) continue;
    const file = { path: entry.path, bytes: bytes.length, sha256: sha256(bytes) };
    repositoryFiles.push(file);
    const candidate = scoreEntry(entry, content, queryTerms, file);
    if (candidate !== null) scored.push(candidate);
  }

  scored.sort(
    (left, right) =>
      right.score - left.score ||
      right.pathMatches - left.pathMatches ||
      (left.path < right.path ? -1 : left.path > right.path ? 1 : 0),
  );
  const entries: ContextRetrievalEntryV1[] = [];
  let totalBytes = 0;
  for (const candidate of scored) {
    if (entries.length >= budget.maxFiles) break;
    const accountedBytes = candidate.bytes + Buffer.byteLength(candidate.path, "utf8");
    if (totalBytes + accountedBytes > budget.maxTotalBytes) continue;
    entries.push(publicEntry(candidate));
    totalBytes += accountedBytes;
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
  } satisfies Omit<ContextRetrievalResultV1, "digestSha256">;
  return { ...unsigned, digestSha256: digestJson(digestableResult(unsigned)) };
}
