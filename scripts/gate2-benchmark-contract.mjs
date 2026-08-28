import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TOP_LEVEL_KEYS = Object.freeze([
  "schemaVersion",
  "benchmarkId",
  "benchmarkRevision",
  "digestEncoding",
  "resultSchemaVersion",
  "executionBoundary",
  "thresholds",
  "measurementDefinitions",
  "repositories",
  "cases",
]);

const EXECUTION_BOUNDARY_KEYS = Object.freeze([
  "contractValidation",
  "credentialReads",
  "externalNetworkRequests",
  "remoteMutations",
  "sourceCheckoutMutations",
  "mockedEvidenceCompletesGate",
]);

const THRESHOLD_KEYS = Object.freeze([
  "taskCount",
  "classCounts",
  "minimumSuccessfulTasks",
  "minimumMacroRetrievalRecall",
  "minimumMacroRetrievalPrecision",
  "minimumDigestProvenanceCoverage",
  "minimumFirstPassPlanAcceptance",
  "maximumIncorrectEditsPerSuccess",
  "minimumRoutedCostReduction",
  "minimumRoutedSuccessCountRatio",
]);

const CLASS_COUNT_KEYS = Object.freeze([
  "repair",
  "refactor",
  "explanation",
  "security_review",
  "scaffold",
]);

const MEASUREMENT_KEYS = Object.freeze([
  "retrievalUnit",
  "recall",
  "precision",
  "digestProvenanceCoverage",
  "firstPassPlanAcceptance",
  "incorrectEdits",
  "taskSuccess",
  "costPerSuccess",
  "routingComparison",
]);

const REPOSITORY_KEYS = Object.freeze(["id", "stack", "fixturePath", "revisionSha256", "files"]);
const REPOSITORY_FILE_KEYS = Object.freeze(["path", "sha256"]);
const CASE_KEYS = Object.freeze([
  "id",
  "class",
  "repositoryId",
  "task",
  "expectedContextPaths",
  "expectedOutcome",
]);
const TASK_KEYS = Object.freeze(["path", "sha256"]);
const OUTCOME_KEYS = Object.freeze([
  "kind",
  "expectedChangedPaths",
  "expectedCitationPaths",
  "expectedFindingIds",
  "allowNoFinding",
  "scenarioEvaluatorId",
]);

export const GATE2_CLASS_COUNTS = Object.freeze({
  repair: 10,
  refactor: 5,
  explanation: 5,
  security_review: 5,
  scaffold: 5,
});
export const MAX_GATE2_JSON_BYTES = 4 * 1024 * 1024;

export const GATE2_REPOSITORY_IDS = Object.freeze([
  "basic",
  "buggy",
  "failing",
  "refactor",
  "schema",
  "security",
  "unfamiliar",
]);

export const GATE2_CASE_IDS = Object.freeze([
  "repair-basic-greeting",
  "repair-cart-off-by-one",
  "repair-parser-false",
  "repair-public-path-containment",
  "repair-schema-status-column",
  "repair-name-whitespace",
  "repair-lantern-missing-config",
  "repair-lantern-empty-audience",
  "repair-basic-newline",
  "repair-cart-empty-list",
  "refactor-name-normalization",
  "refactor-lantern-config-loader",
  "refactor-cart-money-module",
  "refactor-parser-token-table",
  "refactor-schema-task-view",
  "explain-lantern-flow",
  "explain-basic-guardrails",
  "explain-schema-contract",
  "explain-refactor-duplication",
  "explain-parser-failure",
  "security-path-traversal",
  "security-hostile-agents",
  "security-schema-migration",
  "security-config-trust",
  "security-check-command",
  "scaffold-lantern-json-output",
  "scaffold-cart-discount",
  "scaffold-parser-cli",
  "scaffold-task-priority",
  "scaffold-greeting-command",
]);

const EXPECTED_CLASS_BY_INDEX = Object.freeze([
  ...Array(10).fill("repair"),
  ...Array(5).fill("refactor"),
  ...Array(5).fill("explanation"),
  ...Array(5).fill("security_review"),
  ...Array(5).fill("scaffold"),
]);

function fail(message) {
  throw new Error(`Gate 2 benchmark contract: ${message}`);
}

export function sha256Raw(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertPlainRecord(value, label, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const observed = Object.keys(value);
  if (JSON.stringify(observed) !== JSON.stringify(keys)) {
    fail(`${label} must contain exactly: ${keys.join(", ")}`);
  }
  return value;
}

function assertArray(value, label, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    fail(`${label} must be an array with ${minimum}..${maximum} entries`);
  }
  return value;
}

function assertLiteral(value, expected, label) {
  if (value !== expected) fail(`${label} must equal ${JSON.stringify(expected)}`);
  return value;
}

function assertSafeId(value, label) {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]{0,79}$/.test(value)) {
    fail(`${label} must be a bounded lowercase identifier`);
  }
  return value;
}

function assertDigest(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    fail(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function assertSafePath(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 240 ||
    value !== value.normalize("NFC") ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value
      .split("/")
      .some((component) => component === "" || component === "." || component === "..")
  ) {
    fail(`${label} must be a normalized repository-relative POSIX path`);
  }
  return value;
}

function assertSortedUniquePaths(value, label, minimum = 0) {
  const paths = assertArray(value, label, minimum, 64).map((entry, index) =>
    assertSafePath(entry, `${label}[${index}]`),
  );
  const sorted = [...paths].sort((left, right) => left.localeCompare(right));
  if (new Set(paths).size !== paths.length || JSON.stringify(paths) !== JSON.stringify(sorted)) {
    fail(`${label} must be sorted and unique`);
  }
  return paths;
}

function assertSafeStringArray(value, label, minimum = 0) {
  const entries = assertArray(value, label, minimum, 64).map((entry, index) => {
    if (typeof entry !== "string" || !/^[a-z][a-z0-9-]{0,79}$/.test(entry)) {
      fail(`${label}[${index}] must be a bounded identifier`);
    }
    return entry;
  });
  const sorted = [...entries].sort((left, right) => left.localeCompare(right));
  if (
    new Set(entries).size !== entries.length ||
    JSON.stringify(entries) !== JSON.stringify(sorted)
  ) {
    fail(`${label} must be sorted and unique`);
  }
  return entries;
}

function canonicalRepositoryRevision(files) {
  return sha256Raw(JSON.stringify(files));
}

function validateExecutionBoundary(value) {
  const boundary = assertPlainRecord(value, "executionBoundary", EXECUTION_BOUNDARY_KEYS);
  assertLiteral(
    boundary.contractValidation,
    "offline-read-only",
    "executionBoundary.contractValidation",
  );
  for (const key of [
    "credentialReads",
    "externalNetworkRequests",
    "remoteMutations",
    "sourceCheckoutMutations",
  ]) {
    assertLiteral(boundary[key], 0, `executionBoundary.${key}`);
  }
  assertLiteral(
    boundary.mockedEvidenceCompletesGate,
    false,
    "executionBoundary.mockedEvidenceCompletesGate",
  );
}

function validateThresholds(value) {
  const thresholds = assertPlainRecord(value, "thresholds", THRESHOLD_KEYS);
  assertLiteral(thresholds.taskCount, 30, "thresholds.taskCount");
  const counts = assertPlainRecord(
    thresholds.classCounts,
    "thresholds.classCounts",
    CLASS_COUNT_KEYS,
  );
  for (const key of CLASS_COUNT_KEYS) {
    assertLiteral(counts[key], GATE2_CLASS_COUNTS[key], `thresholds.classCounts.${key}`);
  }
  assertLiteral(thresholds.minimumSuccessfulTasks, 24, "thresholds.minimumSuccessfulTasks");
  assertLiteral(
    thresholds.minimumMacroRetrievalRecall,
    0.9,
    "thresholds.minimumMacroRetrievalRecall",
  );
  assertLiteral(
    thresholds.minimumMacroRetrievalPrecision,
    0.6,
    "thresholds.minimumMacroRetrievalPrecision",
  );
  assertLiteral(
    thresholds.minimumDigestProvenanceCoverage,
    1,
    "thresholds.minimumDigestProvenanceCoverage",
  );
  assertLiteral(
    thresholds.minimumFirstPassPlanAcceptance,
    0.8,
    "thresholds.minimumFirstPassPlanAcceptance",
  );
  assertLiteral(
    thresholds.maximumIncorrectEditsPerSuccess,
    0,
    "thresholds.maximumIncorrectEditsPerSuccess",
  );
  assertLiteral(
    thresholds.minimumRoutedCostReduction,
    0.3,
    "thresholds.minimumRoutedCostReduction",
  );
  assertLiteral(
    thresholds.minimumRoutedSuccessCountRatio,
    1,
    "thresholds.minimumRoutedSuccessCountRatio",
  );
}

function validateMeasurements(value) {
  const definitions = assertPlainRecord(value, "measurementDefinitions", MEASUREMENT_KEYS);
  const expected = {
    retrievalUnit: "unique-repository-path",
    recall:
      "per-task expected paths retrieved divided by expected path count; macro mean across all tasks",
    precision:
      "per-task retrieved expected paths divided by retrieved path count; macro mean across all tasks",
    digestProvenanceCoverage:
      "retrieved paths with manifest-matching raw-byte sha256 divided by retrieved path count",
    firstPassPlanAcceptance: "accepted first submitted plan divided by all tasks",
    incorrectEdits:
      "changed paths outside the exact expected set; any read-only change is incorrect",
    taskSuccess: "scenario evaluator passes and incorrectEdits equals zero",
    costPerSuccess:
      "median estimated provider cost over successful tasks; actual billed cost is never inferred",
    routingComparison:
      "paired baseline and routed results use the same execution-profile digest, task set, revisions, models, and captured price table",
  };
  for (const key of MEASUREMENT_KEYS) {
    assertLiteral(definitions[key], expected[key], `measurementDefinitions.${key}`);
  }
}

function validateRepository(value, index) {
  const label = `repositories[${index}]`;
  const repository = assertPlainRecord(value, label, REPOSITORY_KEYS);
  const id = assertSafeId(repository.id, `${label}.id`);
  assertLiteral(id, GATE2_REPOSITORY_IDS[index], `${label}.id`);
  if (typeof repository.stack !== "string" || !/^[a-z][a-z0-9-]{0,79}$/.test(repository.stack)) {
    fail(`${label}.stack must be a bounded identifier`);
  }
  assertLiteral(repository.fixturePath, `fixtures/evals/repos/${id}`, `${label}.fixturePath`);
  assertDigest(repository.revisionSha256, `${label}.revisionSha256`);
  const files = assertArray(repository.files, `${label}.files`, 1, 128).map((entry, fileIndex) => {
    const fileLabel = `${label}.files[${fileIndex}]`;
    const file = assertPlainRecord(entry, fileLabel, REPOSITORY_FILE_KEYS);
    return {
      path: assertSafePath(file.path, `${fileLabel}.path`),
      sha256: assertDigest(file.sha256, `${fileLabel}.sha256`),
    };
  });
  const paths = files.map((file) => file.path);
  const sorted = [...paths].sort((left, right) => left.localeCompare(right));
  if (new Set(paths).size !== paths.length || JSON.stringify(paths) !== JSON.stringify(sorted)) {
    fail(`${label}.files must be sorted by unique path`);
  }
  assertLiteral(
    repository.revisionSha256,
    canonicalRepositoryRevision(files),
    `${label}.revisionSha256`,
  );
  return { id, files, fixturePath: repository.fixturePath };
}

function validateOutcome(value, benchmarkCaseId, benchmarkClass, repository, label) {
  const outcome = assertPlainRecord(value, label, OUTCOME_KEYS);
  const mutation = ["repair", "refactor", "scaffold"].includes(benchmarkClass);
  assertLiteral(outcome.kind, mutation ? "mutation" : "read_only", `${label}.kind`);
  const changed = assertSortedUniquePaths(
    outcome.expectedChangedPaths,
    `${label}.expectedChangedPaths`,
    mutation ? 1 : 0,
  );
  const citations = assertSortedUniquePaths(
    outcome.expectedCitationPaths,
    `${label}.expectedCitationPaths`,
  );
  const findings = assertSafeStringArray(outcome.expectedFindingIds, `${label}.expectedFindingIds`);
  assertLiteral(
    outcome.scenarioEvaluatorId,
    `${benchmarkCaseId}-evaluator`,
    `${label}.scenarioEvaluatorId`,
  );
  if (typeof outcome.allowNoFinding !== "boolean") fail(`${label}.allowNoFinding must be boolean`);

  if (!mutation && changed.length !== 0) {
    fail(`${label} read-only outcomes cannot change files`);
  }
  if (benchmarkClass === "explanation") {
    if (citations.length === 0 || findings.length !== 0 || outcome.allowNoFinding) {
      fail(`${label} explanation outcomes require citations only`);
    }
  } else if (benchmarkClass === "security_review") {
    if (citations.length === 0 || (findings.length === 0) === !outcome.allowNoFinding) {
      fail(`${label} security outcomes must pin findings or explicitly permit no finding`);
    }
  } else if (citations.length !== 0 || findings.length !== 0 || outcome.allowNoFinding) {
    fail(`${label} mutation outcomes cannot predeclare read-only findings`);
  }
  const availablePaths = new Set([...repository.files.map((file) => file.path), ...changed]);
  for (const candidate of citations) {
    if (!availablePaths.has(candidate))
      fail(`${label} references a path outside its pinned outcome`);
  }
  return outcome;
}

function validateCase(value, index, repositoriesById) {
  const label = `cases[${index}]`;
  const benchmarkCase = assertPlainRecord(value, label, CASE_KEYS);
  assertLiteral(benchmarkCase.id, GATE2_CASE_IDS[index], `${label}.id`);
  assertLiteral(benchmarkCase.class, EXPECTED_CLASS_BY_INDEX[index], `${label}.class`);
  const repository = repositoriesById.get(benchmarkCase.repositoryId);
  if (repository === undefined) fail(`${label}.repositoryId must reference a pinned repository`);
  const task = assertPlainRecord(benchmarkCase.task, `${label}.task`, TASK_KEYS);
  assertLiteral(
    task.path,
    `fixtures/evals/gate2/tasks/${benchmarkCase.id}.md`,
    `${label}.task.path`,
  );
  assertDigest(task.sha256, `${label}.task.sha256`);
  const contextPaths = assertSortedUniquePaths(
    benchmarkCase.expectedContextPaths,
    `${label}.expectedContextPaths`,
    1,
  );
  const repositoryPaths = new Set(repository.files.map((file) => file.path));
  for (const contextPath of contextPaths) {
    if (!repositoryPaths.has(contextPath)) {
      fail(`${label}.expectedContextPaths references an unpinned repository path`);
    }
  }
  validateOutcome(
    benchmarkCase.expectedOutcome,
    benchmarkCase.id,
    benchmarkCase.class,
    repository,
    `${label}.expectedOutcome`,
  );
  return benchmarkCase;
}

/**
 * Validate the closed Gate 2 input contract without reading fixtures, invoking
 * Git, resolving credentials, calling a provider, or performing network work.
 */
export function validateGate2BenchmarkManifest(value) {
  const manifest = assertPlainRecord(value, "root", TOP_LEVEL_KEYS);
  assertLiteral(manifest.schemaVersion, 1, "schemaVersion");
  assertLiteral(manifest.benchmarkId, "gate2-context-agent-quality", "benchmarkId");
  assertLiteral(manifest.benchmarkRevision, "gate2-thirty-task-v1", "benchmarkRevision");
  assertLiteral(manifest.digestEncoding, "raw-bytes-sha256-lowercase-hex", "digestEncoding");
  assertLiteral(manifest.resultSchemaVersion, 1, "resultSchemaVersion");
  validateExecutionBoundary(manifest.executionBoundary);
  validateThresholds(manifest.thresholds);
  validateMeasurements(manifest.measurementDefinitions);

  const repositories = assertArray(manifest.repositories, "repositories", 7, 7).map(
    (entry, index) => validateRepository(entry, index),
  );
  const repositoriesById = new Map(repositories.map((repository) => [repository.id, repository]));
  const cases = assertArray(manifest.cases, "cases", 30, 30).map((entry, index) =>
    validateCase(entry, index, repositoriesById),
  );
  if (new Set(cases.map((entry) => entry.task.path)).size !== cases.length) {
    fail("task paths must be unique");
  }
  return manifest;
}

function invalidJson(message = "manifest must be strict JSON") {
  fail(message);
}

class StrictJsonScanner {
  #source;
  #index = 0;

  constructor(source) {
    this.#source = source;
  }

  parseDocument() {
    this.#skipWhitespace();
    this.#parseValue(0);
    this.#skipWhitespace();
    if (this.#index !== this.#source.length) invalidJson();
  }

  #parseValue(depth) {
    if (depth > 64) invalidJson("manifest exceeds the JSON nesting limit");
    const current = this.#source[this.#index];
    if (current === "{") return this.#parseObject(depth);
    if (current === "[") return this.#parseArray(depth);
    if (current === '"') return this.#parseString();
    if (current === "t") return this.#parseLiteral("true");
    if (current === "f") return this.#parseLiteral("false");
    if (current === "n") return this.#parseLiteral("null");
    if (current === "-" || (current >= "0" && current <= "9")) return this.#parseNumber();
    invalidJson();
  }

  #parseObject(depth) {
    this.#index += 1;
    this.#skipWhitespace();
    if (this.#source[this.#index] === "}") {
      this.#index += 1;
      return;
    }
    const keys = new Set();
    while (true) {
      if (this.#source[this.#index] !== '"') invalidJson();
      const key = this.#parseString();
      if (keys.has(key)) invalidJson("manifest must not contain duplicate JSON object members");
      keys.add(key);
      this.#skipWhitespace();
      if (this.#source[this.#index] !== ":") invalidJson();
      this.#index += 1;
      this.#skipWhitespace();
      this.#parseValue(depth + 1);
      this.#skipWhitespace();
      const delimiter = this.#source[this.#index];
      if (delimiter === "}") {
        this.#index += 1;
        return;
      }
      if (delimiter !== ",") invalidJson();
      this.#index += 1;
      this.#skipWhitespace();
    }
  }

  #parseArray(depth) {
    this.#index += 1;
    this.#skipWhitespace();
    if (this.#source[this.#index] === "]") {
      this.#index += 1;
      return;
    }
    while (true) {
      this.#parseValue(depth + 1);
      this.#skipWhitespace();
      const delimiter = this.#source[this.#index];
      if (delimiter === "]") {
        this.#index += 1;
        return;
      }
      if (delimiter !== ",") invalidJson();
      this.#index += 1;
      this.#skipWhitespace();
    }
  }

  #parseString() {
    const start = this.#index;
    this.#index += 1;
    while (this.#index < this.#source.length) {
      const character = this.#source[this.#index];
      if (character === '"') {
        this.#index += 1;
        try {
          return JSON.parse(this.#source.slice(start, this.#index));
        } catch {
          invalidJson();
        }
      }
      if (character.charCodeAt(0) < 0x20) invalidJson();
      if (character === "\\") {
        this.#index += 1;
        const escaped = this.#source[this.#index];
        if (escaped === "u") {
          const code = this.#source.slice(this.#index + 1, this.#index + 5);
          if (!/^[a-fA-F0-9]{4}$/.test(code)) invalidJson();
          this.#index += 5;
          continue;
        }
        if (!'"\\/bfnrt'.includes(escaped)) invalidJson();
      }
      this.#index += 1;
    }
    invalidJson();
  }

  #parseLiteral(literal) {
    if (this.#source.slice(this.#index, this.#index + literal.length) !== literal) invalidJson();
    this.#index += literal.length;
  }

  #parseNumber() {
    const start = this.#index;
    if (this.#source[this.#index] === "-") this.#index += 1;
    if (this.#source[this.#index] === "0") {
      this.#index += 1;
    } else {
      if (!this.#isDigit(this.#source[this.#index])) invalidJson();
      while (this.#isDigit(this.#source[this.#index])) this.#index += 1;
    }
    if (this.#source[this.#index] === ".") {
      this.#index += 1;
      if (!this.#isDigit(this.#source[this.#index])) invalidJson();
      while (this.#isDigit(this.#source[this.#index])) this.#index += 1;
    }
    const exponent = this.#source[this.#index];
    if (exponent === "e" || exponent === "E") {
      this.#index += 1;
      if (["+", "-"].includes(this.#source[this.#index])) this.#index += 1;
      if (!this.#isDigit(this.#source[this.#index])) invalidJson();
      while (this.#isDigit(this.#source[this.#index])) this.#index += 1;
    }
    if (!Number.isFinite(Number(this.#source.slice(start, this.#index)))) invalidJson();
  }

  #isDigit(value) {
    return value !== undefined && value >= "0" && value <= "9";
  }

  #skipWhitespace() {
    while ([" ", "\t", "\r", "\n"].includes(this.#source[this.#index])) this.#index += 1;
  }
}

export function parseStrictGate2Json(source) {
  if (typeof source !== "string") invalidJson();
  if (Buffer.byteLength(source, "utf8") > MAX_GATE2_JSON_BYTES) {
    invalidJson("input exceeds the Gate 2 JSON byte limit");
  }
  new StrictJsonScanner(source).parseDocument();
  try {
    return JSON.parse(source);
  } catch {
    invalidJson();
  }
}

async function snapshotFixture(root) {
  const files = [];
  async function visit(directory, prefix = "") {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (relative.split("/").includes(".git")) fail("fixture repositories cannot contain .git");
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute, relative);
      } else if (entry.isFile()) {
        files.push({ path: relative, sha256: sha256Raw(await readFile(absolute)) });
      } else {
        fail(`fixture contains a special path: ${relative}`);
      }
    }
  }
  await visit(root);
  return files;
}

/**
 * Strict-parse and verify every task and repository byte pin. This function is
 * read-only and deliberately has no provider, Git, credential, or network seam.
 */
export async function loadGate2BenchmarkContract(manifestPath, repositoryRoot) {
  const raw = await readFile(manifestPath);
  const manifest = validateGate2BenchmarkManifest(parseStrictGate2Json(raw.toString("utf8")));
  for (const benchmarkCase of manifest.cases) {
    const taskBytes = await readFile(path.resolve(repositoryRoot, benchmarkCase.task.path));
    assertLiteral(
      sha256Raw(taskBytes),
      benchmarkCase.task.sha256,
      `task digest for ${benchmarkCase.id}`,
    );
  }
  for (const repository of manifest.repositories) {
    const observed = await snapshotFixture(path.resolve(repositoryRoot, repository.fixturePath));
    if (JSON.stringify(observed) !== JSON.stringify(repository.files)) {
      fail(`repository inventory drifted: ${repository.id}`);
    }
    assertLiteral(
      canonicalRepositoryRevision(observed),
      repository.revisionSha256,
      `repository revision for ${repository.id}`,
    );
  }
  return {
    manifest,
    manifestSha256: sha256Raw(raw),
  };
}

async function main() {
  if (process.argv.length !== 2) {
    fail("usage: node scripts/gate2-benchmark-contract.mjs");
  }
  const scriptPath = fileURLToPath(import.meta.url);
  const repositoryRoot = path.resolve(path.dirname(scriptPath), "..");
  const manifestPath = path.join(repositoryRoot, "fixtures/evals/gate2/manifest.v1.json");
  const loaded = await loadGate2BenchmarkContract(manifestPath, repositoryRoot);
  process.stdout.write(
    `${JSON.stringify({
      benchmarkId: loaded.manifest.benchmarkId,
      benchmarkRevision: loaded.manifest.benchmarkRevision,
      manifestSha256: loaded.manifestSha256,
      validatedCases: loaded.manifest.cases.length,
      executedCases: 0,
      assessment: "contract_validated_gate2_execution_not_run",
    })}\n`,
  );
}

const invokedPath = process.argv[1] === undefined ? "" : path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    process.stderr.write(
      `Gate 2 benchmark contract failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
