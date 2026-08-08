import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  isIntrinsicallySecretPath,
  isWorkspaceContextPathExcluded,
} from "../../packages/core/src/context.js";

type FileMediaType = "binary" | "utf8_text";
type FileDisposition = "omitted" | "searchable";
type PolicyOmissionReason = "binary" | "ignore_rule" | "oversize" | "secret_policy";
type QueryOmissionReason = PolicyOmissionReason | "not_symbol_definition" | "result_limit";
type QueryKind = "file" | "symbol" | "text";
type MatchKind = "path" | "symbol" | "text";

interface CorpusFile {
  path: string;
  byteLength: number;
  sha256: string;
  mediaType: FileMediaType;
  disposition: FileDisposition;
  omissionReason: PolicyOmissionReason | null;
}

interface SourceLocation {
  line: number;
  column: number;
  endLine: number;
  endColumnExclusive: number;
}

interface SymbolProvenance {
  name: string;
  kind: "function";
  isDefinition: true;
}

interface ExpectedResult {
  rank: number;
  score: number;
  path: string;
  matchKind: MatchKind;
  origin: "retrieved_source";
  symbol: SymbolProvenance | null;
  location: SourceLocation | null;
  matchedText: string;
}

interface ExpectedOmission {
  path: string;
  reason: QueryOmissionReason;
}

interface BenchmarkQuery {
  id: string;
  kind: QueryKind;
  query: string;
  limit: number;
  totalRawMatchingFiles: number;
  totalEligibleMatches: number;
  expectedResults: ExpectedResult[];
  expectedOmissions: ExpectedOmission[];
}

interface RetrievalCorpus {
  schemaVersion: 1;
  corpusId: "gate2-retrieval";
  corpusRevision: "benchmark-first-r0-v1";
  digestEncoding: "raw-bytes-sha256-lowercase-hex";
  locationEncoding: "one_based_line_utf8_byte_columns";
  resultOrigin: "retrieved_source";
  repository: {
    root: "repository";
    maxReadableFileBytes: number;
    maxExcerptBytes: number;
    maxResultsPerQuery: number;
    files: CorpusFile[];
  };
  ranking: {
    scoreOrder: "descending_integer";
    tieBreak: ["path_utf8_bytes_ascending", "line_ascending", "column_ascending"];
  };
  queries: BenchmarkQuery[];
}

const FIXTURE_ROOT = fileURLToPath(
  new URL("../../fixtures/evals/gate2-retrieval/", import.meta.url),
);
const MANIFEST_PATH = fileURLToPath(
  new URL("../../fixtures/evals/gate2-retrieval/manifest.v1.json", import.meta.url),
);
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  invariant(
    typeof value === "object" && value !== null && !Array.isArray(value),
    `${label} must be an object`,
  );
  return value as Record<string, unknown>;
}

function expectExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  invariant(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label} must contain exactly [${expected.join(", ")}], got [${actual.join(", ")}]`,
  );
}

function expectString(value: unknown, label: string): string {
  invariant(typeof value === "string", `${label} must be a string`);
  return value;
}

function expectInteger(value: unknown, label: string, minimum = 0): number {
  invariant(
    typeof value === "number" && Number.isSafeInteger(value) && value >= minimum,
    `${label} must be a safe integer >= ${minimum}`,
  );
  return value;
}

function expectBoolean(value: unknown, label: string): boolean {
  invariant(typeof value === "boolean", `${label} must be a boolean`);
  return value;
}

function expectArray(value: unknown, label: string): unknown[] {
  invariant(Array.isArray(value), `${label} must be an array`);
  return value;
}

function expectLiteral<T extends string | number | boolean>(
  value: unknown,
  literal: T,
  label: string,
): T {
  invariant(value === literal, `${label} must equal ${JSON.stringify(literal)}`);
  return literal;
}

function expectEnum<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  label: string,
): T[number] {
  invariant(
    typeof value === "string" && allowed.includes(value),
    `${label} must be one of ${allowed.join(", ")}`,
  );
  return value as T[number];
}

function parseCorpusFile(value: unknown, index: number): CorpusFile {
  const label = `repository.files[${index}]`;
  const record = expectRecord(value, label);
  expectExactKeys(
    record,
    ["path", "byteLength", "sha256", "mediaType", "disposition", "omissionReason"],
    label,
  );
  const omissionReason =
    record.omissionReason === null
      ? null
      : expectEnum(
          record.omissionReason,
          ["binary", "ignore_rule", "oversize", "secret_policy"] as const,
          `${label}.omissionReason`,
        );
  return {
    path: expectString(record.path, `${label}.path`),
    byteLength: expectInteger(record.byteLength, `${label}.byteLength`),
    sha256: expectString(record.sha256, `${label}.sha256`),
    mediaType: expectEnum(record.mediaType, ["binary", "utf8_text"] as const, `${label}.mediaType`),
    disposition: expectEnum(
      record.disposition,
      ["omitted", "searchable"] as const,
      `${label}.disposition`,
    ),
    omissionReason,
  };
}

function parseLocation(value: unknown, label: string): SourceLocation | null {
  if (value === null) return null;
  const record = expectRecord(value, label);
  expectExactKeys(record, ["line", "column", "endLine", "endColumnExclusive"], label);
  return {
    line: expectInteger(record.line, `${label}.line`, 1),
    column: expectInteger(record.column, `${label}.column`, 1),
    endLine: expectInteger(record.endLine, `${label}.endLine`, 1),
    endColumnExclusive: expectInteger(record.endColumnExclusive, `${label}.endColumnExclusive`, 1),
  };
}

function parseSymbol(value: unknown, label: string): SymbolProvenance | null {
  if (value === null) return null;
  const record = expectRecord(value, label);
  expectExactKeys(record, ["name", "kind", "isDefinition"], label);
  return {
    name: expectString(record.name, `${label}.name`),
    kind: expectLiteral(record.kind, "function", `${label}.kind`),
    isDefinition: expectLiteral(
      expectBoolean(record.isDefinition, `${label}.isDefinition`),
      true,
      `${label}.isDefinition`,
    ),
  };
}

function parseResult(value: unknown, queryIndex: number, resultIndex: number): ExpectedResult {
  const label = `queries[${queryIndex}].expectedResults[${resultIndex}]`;
  const record = expectRecord(value, label);
  expectExactKeys(
    record,
    ["rank", "score", "path", "matchKind", "origin", "symbol", "location", "matchedText"],
    label,
  );
  return {
    rank: expectInteger(record.rank, `${label}.rank`, 1),
    score: expectInteger(record.score, `${label}.score`),
    path: expectString(record.path, `${label}.path`),
    matchKind: expectEnum(
      record.matchKind,
      ["path", "symbol", "text"] as const,
      `${label}.matchKind`,
    ),
    origin: expectLiteral(record.origin, "retrieved_source", `${label}.origin`),
    symbol: parseSymbol(record.symbol, `${label}.symbol`),
    location: parseLocation(record.location, `${label}.location`),
    matchedText: expectString(record.matchedText, `${label}.matchedText`),
  };
}

function parseOmission(
  value: unknown,
  queryIndex: number,
  omissionIndex: number,
): ExpectedOmission {
  const label = `queries[${queryIndex}].expectedOmissions[${omissionIndex}]`;
  const record = expectRecord(value, label);
  expectExactKeys(record, ["path", "reason"], label);
  return {
    path: expectString(record.path, `${label}.path`),
    reason: expectEnum(
      record.reason,
      [
        "binary",
        "ignore_rule",
        "not_symbol_definition",
        "oversize",
        "secret_policy",
        "result_limit",
      ] as const,
      `${label}.reason`,
    ),
  };
}

function parseQuery(value: unknown, index: number): BenchmarkQuery {
  const label = `queries[${index}]`;
  const record = expectRecord(value, label);
  expectExactKeys(
    record,
    [
      "id",
      "kind",
      "query",
      "limit",
      "totalRawMatchingFiles",
      "totalEligibleMatches",
      "expectedResults",
      "expectedOmissions",
    ],
    label,
  );
  return {
    id: expectString(record.id, `${label}.id`),
    kind: expectEnum(record.kind, ["file", "symbol", "text"] as const, `${label}.kind`),
    query: expectString(record.query, `${label}.query`),
    limit: expectInteger(record.limit, `${label}.limit`, 1),
    totalRawMatchingFiles: expectInteger(
      record.totalRawMatchingFiles,
      `${label}.totalRawMatchingFiles`,
    ),
    totalEligibleMatches: expectInteger(
      record.totalEligibleMatches,
      `${label}.totalEligibleMatches`,
    ),
    expectedResults: expectArray(record.expectedResults, `${label}.expectedResults`).map(
      (result, resultIndex) => parseResult(result, index, resultIndex),
    ),
    expectedOmissions: expectArray(record.expectedOmissions, `${label}.expectedOmissions`).map(
      (omission, omissionIndex) => parseOmission(omission, index, omissionIndex),
    ),
  };
}

function parseCorpus(value: unknown): RetrievalCorpus {
  const root = expectRecord(value, "manifest");
  expectExactKeys(
    root,
    [
      "schemaVersion",
      "corpusId",
      "corpusRevision",
      "digestEncoding",
      "locationEncoding",
      "resultOrigin",
      "repository",
      "ranking",
      "queries",
    ],
    "manifest",
  );

  const repositoryRecord = expectRecord(root.repository, "repository");
  expectExactKeys(
    repositoryRecord,
    ["root", "maxReadableFileBytes", "maxExcerptBytes", "maxResultsPerQuery", "files"],
    "repository",
  );

  const rankingRecord = expectRecord(root.ranking, "ranking");
  expectExactKeys(rankingRecord, ["scoreOrder", "tieBreak"], "ranking");
  const tieBreak = expectArray(rankingRecord.tieBreak, "ranking.tieBreak").map((value, index) =>
    expectString(value, `ranking.tieBreak[${index}]`),
  );
  invariant(
    JSON.stringify(tieBreak) ===
      JSON.stringify(["path_utf8_bytes_ascending", "line_ascending", "column_ascending"]),
    "ranking.tieBreak must pin UTF-8 byte path, line, then column order",
  );

  return {
    schemaVersion: expectLiteral(root.schemaVersion, 1, "schemaVersion"),
    corpusId: expectLiteral(root.corpusId, "gate2-retrieval", "corpusId"),
    corpusRevision: expectLiteral(root.corpusRevision, "benchmark-first-r0-v1", "corpusRevision"),
    digestEncoding: expectLiteral(
      root.digestEncoding,
      "raw-bytes-sha256-lowercase-hex",
      "digestEncoding",
    ),
    locationEncoding: expectLiteral(
      root.locationEncoding,
      "one_based_line_utf8_byte_columns",
      "locationEncoding",
    ),
    resultOrigin: expectLiteral(root.resultOrigin, "retrieved_source", "resultOrigin"),
    repository: {
      root: expectLiteral(repositoryRecord.root, "repository", "repository.root"),
      maxReadableFileBytes: expectInteger(
        repositoryRecord.maxReadableFileBytes,
        "repository.maxReadableFileBytes",
        1,
      ),
      maxExcerptBytes: expectInteger(
        repositoryRecord.maxExcerptBytes,
        "repository.maxExcerptBytes",
        1,
      ),
      maxResultsPerQuery: expectInteger(
        repositoryRecord.maxResultsPerQuery,
        "repository.maxResultsPerQuery",
        1,
      ),
      files: expectArray(repositoryRecord.files, "repository.files").map(parseCorpusFile),
    },
    ranking: {
      scoreOrder: expectLiteral(
        rankingRecord.scoreOrder,
        "descending_integer",
        "ranking.scoreOrder",
      ),
      tieBreak: ["path_utf8_bytes_ascending", "line_ascending", "column_ascending"],
    },
    queries: expectArray(root.queries, "queries").map(parseQuery),
  };
}

function compareUtf8Bytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

async function walkFiles(root: string, relative = ""): Promise<string[]> {
  const entries = await readdir(relative === "" ? root : `${root}/${relative}`, {
    withFileTypes: true,
  });
  const files: string[] = [];
  for (const entry of entries) {
    const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
    invariant(!entry.isSymbolicLink(), `fixture must not contain symlink ${child}`);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(root, child)));
      continue;
    }
    invariant(entry.isFile(), `fixture must contain only regular files: ${child}`);
    files.push(child);
  }
  return files.sort(compareUtf8Bytes);
}

function filePath(root: string, relativePath: string): string {
  return `${root}/${relativePath}`;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} must be valid UTF-8 text`);
  }
}

function isSafeRelativePath(value: string): boolean {
  return (
    value.length > 0 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    value
      .split("/")
      .every((component) => component !== "" && component !== "." && component !== "..")
  );
}

function sourceSlice(content: string, location: SourceLocation, label: string): string {
  invariant(location.line === location.endLine, `${label} must stay on one line`);
  const lines = Buffer.from(content, "utf8").toString("binary").split("\n");
  const line = lines[location.line - 1];
  invariant(line !== undefined, `${label}.line is outside the file`);
  invariant(
    location.endColumnExclusive > location.column,
    `${label}.endColumnExclusive must follow column`,
  );
  invariant(
    location.endColumnExclusive - 1 <= line.length,
    `${label}.endColumnExclusive is outside the line`,
  );
  return Buffer.from(
    line.slice(location.column - 1, location.endColumnExclusive - 1),
    "binary",
  ).toString("utf8");
}

function queryMatches(query: BenchmarkQuery, file: CorpusFile, bytes: Buffer): boolean {
  if (query.kind === "file") return file.path.includes(query.query);
  return bytes.includes(Buffer.from(query.query, "utf8"));
}

function isEligibleMatch(query: BenchmarkQuery, file: CorpusFile, bytes: Buffer): boolean {
  if (file.disposition !== "searchable") return false;
  if (query.kind !== "symbol") return true;
  const escaped = query.query.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?:^|\\n)export function ${escaped}\\b`, "u").test(
    decodeUtf8(bytes, file.path),
  );
}

function compareResults(left: ExpectedResult, right: ExpectedResult): number {
  if (left.score !== right.score) return right.score - left.score;
  const pathOrder = compareUtf8Bytes(left.path, right.path);
  if (pathOrder !== 0) return pathOrder;
  const leftLine = left.location?.line ?? 0;
  const rightLine = right.location?.line ?? 0;
  if (leftLine !== rightLine) return leftLine - rightLine;
  return (left.location?.column ?? 0) - (right.location?.column ?? 0);
}

function assertUnique(values: readonly string[], label: string): void {
  invariant(new Set(values).size === values.length, `${label} must be unique`);
}

async function validateCorpus(corpus: RetrievalCorpus): Promise<void> {
  const repositoryRoot = `${FIXTURE_ROOT}${corpus.repository.root}`;
  const actualPaths = await walkFiles(repositoryRoot);
  const manifestPaths = corpus.repository.files.map((file) => file.path);
  assertUnique(manifestPaths, "repository file paths");
  invariant(
    manifestPaths.every(isSafeRelativePath),
    "repository paths must be normalized repository-relative paths",
  );
  invariant(
    JSON.stringify(manifestPaths) === JSON.stringify([...manifestPaths].sort(compareUtf8Bytes)),
    "repository files must be ordered by raw UTF-8 path bytes",
  );
  invariant(
    JSON.stringify(actualPaths) === JSON.stringify(manifestPaths),
    "manifest must close over every regular fixture file and no others",
  );

  const bytesByPath = new Map<string, Buffer>();
  const gitignore = await readFile(filePath(repositoryRoot, ".gitignore"), "utf8");
  const ignorePrefixes = gitignore
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#") && line.endsWith("/"));

  for (const file of corpus.repository.files) {
    invariant(SHA256_PATTERN.test(file.sha256), `${file.path} must pin a lowercase SHA-256`);
    const bytes = await readFile(filePath(repositoryRoot, file.path));
    bytesByPath.set(file.path, bytes);
    invariant(bytes.byteLength === file.byteLength, `${file.path} byteLength pin changed`);
    invariant(sha256(bytes) === file.sha256, `${file.path} raw-byte SHA-256 pin changed`);

    if (file.mediaType === "binary") {
      invariant(bytes.includes(0), `${file.path} binary sentinel must include a NUL byte`);
    } else {
      decodeUtf8(bytes, file.path);
    }

    if (file.disposition === "searchable") {
      invariant(file.omissionReason === null, `${file.path} searchable file cannot be omitted`);
      invariant(file.mediaType === "utf8_text", `${file.path} searchable file must be text`);
      invariant(
        file.byteLength <= corpus.repository.maxReadableFileBytes,
        `${file.path} searchable file exceeds the readable byte ceiling`,
      );
      continue;
    }

    invariant(file.omissionReason !== null, `${file.path} omitted file needs a reason`);
    if (file.omissionReason === "binary") {
      invariant(file.mediaType === "binary", `${file.path} binary omission must be binary`);
    } else if (file.omissionReason === "oversize") {
      invariant(
        file.byteLength > corpus.repository.maxReadableFileBytes,
        `${file.path} oversize omission must exceed the byte ceiling`,
      );
    } else if (file.omissionReason === "ignore_rule") {
      invariant(
        ignorePrefixes.some((prefix) => file.path.startsWith(prefix)),
        `${file.path} ignore omission must be covered by .gitignore`,
      );
    } else {
      invariant(
        isWorkspaceContextPathExcluded(file.path),
        `${file.path} secret-policy omission must match the current context exclusion policy`,
      );
      invariant(
        !isIntrinsicallySecretPath(file.path),
        `${file.path} omission fixture must not make the whole tracked repository inadmissible`,
      );
      invariant(
        decodeUtf8(bytes, file.path).includes("REDACTED_FIXTURE_VALUE"),
        `${file.path} secret-policy fixture must contain only its redacted sentinel`,
      );
    }
  }

  assertUnique(
    corpus.queries.map((query) => query.id),
    "query ids",
  );
  let hasStableTie = false;
  let hasBoundedOmission = false;

  for (const query of corpus.queries) {
    invariant(query.query.length > 0, `${query.id} query must not be empty`);
    invariant(
      query.limit <= corpus.repository.maxResultsPerQuery,
      `${query.id} exceeds the corpus result ceiling`,
    );
    invariant(
      query.expectedResults.length === Math.min(query.limit, query.totalEligibleMatches),
      `${query.id} expected result count must honor its exact limit`,
    );
    invariant(query.expectedResults.length <= query.limit, `${query.id} results exceed its bound`);

    const candidates = corpus.repository.files.filter((file) => {
      const bytes = bytesByPath.get(file.path);
      invariant(bytes !== undefined, `missing loaded bytes for ${file.path}`);
      return queryMatches(query, file, bytes);
    });
    const eligibleCandidates = candidates.filter((file) => {
      const bytes = bytesByPath.get(file.path);
      invariant(bytes !== undefined, `missing loaded bytes for ${file.path}`);
      return isEligibleMatch(query, file, bytes);
    });
    invariant(
      candidates.length === query.totalRawMatchingFiles,
      `${query.id} totalRawMatchingFiles changed`,
    );
    invariant(
      eligibleCandidates.length === query.totalEligibleMatches,
      `${query.id} totalEligibleMatches changed`,
    );

    const resultPaths = query.expectedResults.map((result) => result.path);
    const omissionPaths = query.expectedOmissions.map((omission) => omission.path);
    assertUnique(resultPaths, `${query.id} result paths`);
    assertUnique(omissionPaths, `${query.id} omission paths`);
    invariant(
      resultPaths.every((resultPath) => !omissionPaths.includes(resultPath)),
      `${query.id} cannot both return and omit a path`,
    );
    invariant(
      JSON.stringify([...resultPaths, ...omissionPaths].sort(compareUtf8Bytes)) ===
        JSON.stringify(candidates.map((file) => file.path).sort(compareUtf8Bytes)),
      `${query.id} results and omissions must partition every raw match`,
    );

    for (const [index, result] of query.expectedResults.entries()) {
      invariant(result.rank === index + 1, `${query.id} ranks must be contiguous from one`);
      invariant(result.origin === corpus.resultOrigin, `${query.id} result origin changed`);
      invariant(
        Buffer.byteLength(result.matchedText, "utf8") <= corpus.repository.maxExcerptBytes,
        `${query.id} matched text exceeds the excerpt byte ceiling`,
      );
      const file = corpus.repository.files.find((entry) => entry.path === result.path);
      invariant(file?.disposition === "searchable", `${query.id} returned an omitted file`);
      const bytes = bytesByPath.get(result.path);
      invariant(bytes !== undefined, `${query.id} result bytes are missing`);
      invariant(
        isEligibleMatch(query, file, bytes),
        `${query.id} returned a source that is not eligible for its query kind`,
      );

      if (query.kind === "file") {
        invariant(result.matchKind === "path", `${query.id} file result must be a path match`);
        invariant(result.location === null, `${query.id} path match cannot invent a location`);
        invariant(result.symbol === null, `${query.id} path match cannot invent a symbol`);
        invariant(result.matchedText === query.query, `${query.id} path match text changed`);
      } else {
        invariant(
          result.matchKind === query.kind,
          `${query.id} result match kind must equal query kind`,
        );
        invariant(result.location !== null, `${query.id} source result needs a location`);
        const content = decodeUtf8(bytes, result.path);
        invariant(
          sourceSlice(content, result.location, `${query.id}:${result.path}`) ===
            result.matchedText,
          `${query.id} exact source location no longer resolves to matchedText`,
        );
        invariant(result.matchedText === query.query, `${query.id} matchedText changed`);
        if (query.kind === "symbol") {
          invariant(result.symbol !== null, `${query.id} symbol result needs provenance`);
          invariant(result.symbol.name === query.query, `${query.id} symbol name changed`);
          invariant(result.symbol.isDefinition, `${query.id} symbol must be a definition`);
        } else {
          invariant(result.symbol === null, `${query.id} text match cannot invent a symbol`);
        }
      }

      if (index > 0) {
        const previous = query.expectedResults[index - 1];
        invariant(previous !== undefined, `${query.id} previous result is missing`);
        invariant(
          compareResults(previous, result) <= 0,
          `${query.id} results violate deterministic score/tie ordering`,
        );
        if (previous.score === result.score) hasStableTie = true;
      }
    }

    invariant(
      JSON.stringify(omissionPaths) === JSON.stringify([...omissionPaths].sort(compareUtf8Bytes)),
      `${query.id} omissions must use UTF-8 byte path order`,
    );
    for (const omission of query.expectedOmissions) {
      const file = corpus.repository.files.find((entry) => entry.path === omission.path);
      invariant(file !== undefined, `${query.id} omission path is not in the repository`);
      const bytes = bytesByPath.get(file.path);
      invariant(bytes !== undefined, `${query.id} omission bytes are missing`);
      const expectedReason =
        file.disposition === "omitted"
          ? file.omissionReason
          : query.kind === "symbol" && !isEligibleMatch(query, file, bytes)
            ? "not_symbol_definition"
            : "result_limit";
      invariant(
        omission.reason === expectedReason,
        `${query.id} omission reason changed for ${omission.path}`,
      );
    }
    if (query.totalEligibleMatches > query.limit) hasBoundedOmission = true;
  }

  invariant(hasStableTie, "corpus must contain an equal-score deterministic tie");
  invariant(hasBoundedOmission, "corpus must contain a result-limit omission");
}

async function loadCorpus(): Promise<RetrievalCorpus> {
  return parseCorpus(JSON.parse(await readFile(MANIFEST_PATH, "utf8")) as unknown);
}

describe("Gate 2 retrieval benchmark corpus", () => {
  it("is a closed, byte-pinned corpus with exact provenance, ranking, bounds, and omissions", async () => {
    await validateCorpus(await loadCorpus());
  });

  it("rejects unknown manifest fields instead of silently widening the schema", async () => {
    const corpus = await loadCorpus();
    expect(() => parseCorpus({ ...corpus, ambientAuthority: true })).toThrow(
      "manifest must contain exactly",
    );
  });

  it("rejects a raw-byte digest mutation", async () => {
    const corpus = await loadCorpus();
    const mutation = structuredClone(corpus);
    const file = mutation.repository.files[0];
    invariant(file !== undefined, "pin mutation fixture is missing");
    file.sha256 = "0".repeat(64);
    await expect(validateCorpus(mutation)).rejects.toThrow("raw-byte SHA-256 pin changed");
  });

  it("rejects an exact source-location mutation", async () => {
    const corpus = await loadCorpus();
    const mutation = structuredClone(corpus);
    const result = mutation.queries.find((query) => query.id === "exact-symbol")
      ?.expectedResults[0];
    invariant(
      result?.location !== null && result?.location !== undefined,
      "location fixture missing",
    );
    result.location.column += 1;
    await expect(validateCorpus(mutation)).rejects.toThrow(
      "exact source location no longer resolves to matchedText",
    );
  });

  it("rejects a mutation of the stable equal-score tie order", async () => {
    const corpus = await loadCorpus();
    const mutation = structuredClone(corpus);
    const query = mutation.queries.find((entry) => entry.id === "stable-tie-and-bound");
    invariant(query !== undefined, "tie fixture missing");
    query.expectedResults.reverse();
    query.expectedResults.forEach((result, index) => {
      result.rank = index + 1;
    });
    await expect(validateCorpus(mutation)).rejects.toThrow(
      "results violate deterministic score/tie ordering",
    );
  });

  it("rejects a policy omission relabeled as a limit omission", async () => {
    const corpus = await loadCorpus();
    const mutation = structuredClone(corpus);
    const omission = mutation.queries
      .find((query) => query.id === "stable-tie-and-bound")
      ?.expectedOmissions.find((entry) => entry.path === "assets/render-status.bin");
    invariant(omission !== undefined, "binary omission fixture missing");
    omission.reason = "result_limit";
    await expect(validateCorpus(mutation)).rejects.toThrow(
      "omission reason changed for assets/render-status.bin",
    );
  });
});
