import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const V1_TOP_LEVEL_KEYS = Object.freeze([
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

const V2_TOP_LEVEL_KEYS = Object.freeze([
  "schemaVersion",
  "benchmarkId",
  "benchmarkRevision",
  "supersedes",
  "replacements",
  "digestEncoding",
  "resultSchemaVersion",
  "executionBoundary",
  "thresholds",
  "measurementDefinitions",
  "repositories",
  "cases",
]);

const SUPERSEDES_KEYS = Object.freeze(["benchmarkRevision", "manifestPath", "manifestSha256"]);
const REPLACEMENT_KEYS = Object.freeze(["predecessorCaseId", "successorCaseId", "reason"]);

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

const GATE2_V2_CASE_IDS = Object.freeze(
  GATE2_CASE_IDS.map((caseId) => {
    if (caseId === "repair-schema-status-column") return "repair-schema-status-snapshot";
    if (caseId === "scaffold-task-priority") return "scaffold-task-priority-contract";
    return caseId;
  }),
);

export const GATE2_V1_MANIFEST_SHA256 =
  "43159d8a174312e7fd720fbb625173601e7c90f6e5983c62c206b69ce99c9558";
export const GATE2_CASE_IDS_BY_REVISION = Object.freeze({
  "gate2-thirty-task-v1": GATE2_CASE_IDS,
  "gate2-thirty-task-v2-host-policy-compatible": GATE2_V2_CASE_IDS,
});

const GATE2_V2_REPLACEMENTS = Object.freeze([
  Object.freeze({
    predecessorCaseId: "repair-schema-status-column",
    successorCaseId: "repair-schema-status-snapshot",
    reason: "protected-migration-path-incompatible-with-ordinary-text-patchset-authority",
  }),
  Object.freeze({
    predecessorCaseId: "scaffold-task-priority",
    successorCaseId: "scaffold-task-priority-contract",
    reason: "protected-migration-path-incompatible-with-ordinary-text-patchset-authority",
  }),
]);

const GATE2_V2_SUCCESSOR_CASES = Object.freeze([
  Object.freeze({
    id: "repair-schema-status-snapshot",
    class: "repair",
    repositoryId: "schema",
    task: Object.freeze({
      path: "fixtures/evals/gate2/tasks/repair-schema-status-snapshot.md",
      sha256: "5c5a211b88fe21da7b6d2ff968051eb4ef089fd142354b4454d251fc0d867dc7",
    }),
    expectedContextPaths: Object.freeze([
      "checks/schema_contract.sql",
      "README.md",
      "schema/current.sql",
    ]),
    expectedOutcome: Object.freeze({
      kind: "mutation",
      expectedChangedPaths: Object.freeze(["checks/schema_contract.sql", "schema/current.sql"]),
      expectedCitationPaths: Object.freeze([]),
      expectedFindingIds: Object.freeze([]),
      allowNoFinding: false,
      scenarioEvaluatorId: "repair-schema-status-snapshot-evaluator",
    }),
  }),
  Object.freeze({
    id: "scaffold-task-priority-contract",
    class: "scaffold",
    repositoryId: "schema",
    task: Object.freeze({
      path: "fixtures/evals/gate2/tasks/scaffold-task-priority-contract.md",
      sha256: "83ad152996cef7b8bad212357a65f59c5376023167785a2a01ea6f59f56a4401",
    }),
    expectedContextPaths: Object.freeze([
      "checks/schema_contract.sql",
      "README.md",
      "schema/current.sql",
    ]),
    expectedOutcome: Object.freeze({
      kind: "mutation",
      expectedChangedPaths: Object.freeze([
        "checks/task_priority_contract.sql",
        "schema/current.sql",
      ]),
      expectedCitationPaths: Object.freeze([]),
      expectedFindingIds: Object.freeze([]),
      allowNoFinding: false,
      scenarioEvaluatorId: "scaffold-task-priority-contract-evaluator",
    }),
  }),
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

function assertOrdinaryPatchSetTarget(value, label) {
  const lower = value.toLowerCase();
  const components = lower.split("/");
  const basename = components.at(-1) ?? "";
  const denied =
    components.includes(".git") ||
    components.includes(".icarus") ||
    components.includes("migrations") ||
    lower.startsWith(".github/workflows/") ||
    basename === "agents.md" ||
    basename === "dockerfile" ||
    basename === "package.json" ||
    basename.endsWith(".pem") ||
    basename.endsWith(".key") ||
    basename.endsWith("lock.json") ||
    basename.endsWith("lock.yaml") ||
    basename.endsWith(".lock");
  if (denied) fail(`${label} exceeds ordinary PatchSet authority`);
  return value;
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

function validateOutcome(value, benchmarkCaseId, benchmarkClass, repository, label, schemaVersion) {
  const outcome = assertPlainRecord(value, label, OUTCOME_KEYS);
  const mutation = ["repair", "refactor", "scaffold"].includes(benchmarkClass);
  assertLiteral(outcome.kind, mutation ? "mutation" : "read_only", `${label}.kind`);
  const changed = assertSortedUniquePaths(
    outcome.expectedChangedPaths,
    `${label}.expectedChangedPaths`,
    mutation ? 1 : 0,
  );
  if (schemaVersion === 2) {
    for (const [index, candidate] of changed.entries()) {
      assertOrdinaryPatchSetTarget(candidate, `${label}.expectedChangedPaths[${index}]`);
    }
  }
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

function validateCase(value, index, repositoriesById, caseIds, schemaVersion) {
  const label = `cases[${index}]`;
  const benchmarkCase = assertPlainRecord(value, label, CASE_KEYS);
  assertLiteral(benchmarkCase.id, caseIds[index], `${label}.id`);
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
    schemaVersion,
  );
  return benchmarkCase;
}

function validateV2LineageMetadata(manifest) {
  const supersedes = assertPlainRecord(manifest.supersedes, "supersedes", SUPERSEDES_KEYS);
  assertLiteral(
    supersedes.benchmarkRevision,
    "gate2-thirty-task-v1",
    "supersedes.benchmarkRevision",
  );
  assertLiteral(
    supersedes.manifestPath,
    "fixtures/evals/gate2/manifest.v1.json",
    "supersedes.manifestPath",
  );
  assertLiteral(supersedes.manifestSha256, GATE2_V1_MANIFEST_SHA256, "supersedes.manifestSha256");
  const replacements = assertArray(manifest.replacements, "replacements", 2, 2);
  for (const [index, expected] of GATE2_V2_REPLACEMENTS.entries()) {
    const replacement = assertPlainRecord(
      replacements[index],
      `replacements[${index}]`,
      REPLACEMENT_KEYS,
    );
    for (const key of REPLACEMENT_KEYS) {
      assertLiteral(replacement[key], expected[key], `replacement lineage ${index}.${key}`);
    }
  }
}

/**
 * Validate the closed Gate 2 input contract without reading fixtures, invoking
 * Git, resolving credentials, calling a provider, or performing network work.
 */
export function validateGate2BenchmarkManifest(value) {
  const schemaVersion = value?.schemaVersion;
  const topLevelKeys = schemaVersion === 1 ? V1_TOP_LEVEL_KEYS : V2_TOP_LEVEL_KEYS;
  const manifest = assertPlainRecord(value, "root", topLevelKeys);
  if (schemaVersion !== 1 && schemaVersion !== 2) fail("schemaVersion must equal 1 or 2");
  assertLiteral(manifest.benchmarkId, "gate2-context-agent-quality", "benchmarkId");
  const benchmarkRevision =
    schemaVersion === 1 ? "gate2-thirty-task-v1" : "gate2-thirty-task-v2-host-policy-compatible";
  assertLiteral(manifest.benchmarkRevision, benchmarkRevision, "benchmarkRevision");
  if (schemaVersion === 2) validateV2LineageMetadata(manifest);
  assertLiteral(manifest.digestEncoding, "raw-bytes-sha256-lowercase-hex", "digestEncoding");
  assertLiteral(manifest.resultSchemaVersion, 1, "resultSchemaVersion");
  validateExecutionBoundary(manifest.executionBoundary);
  validateThresholds(manifest.thresholds);
  validateMeasurements(manifest.measurementDefinitions);

  const repositories = assertArray(manifest.repositories, "repositories", 7, 7).map(
    (entry, index) => validateRepository(entry, index),
  );
  const repositoriesById = new Map(repositories.map((repository) => [repository.id, repository]));
  const caseIds = GATE2_CASE_IDS_BY_REVISION[benchmarkRevision];
  const cases = assertArray(manifest.cases, "cases", 30, 30).map((entry, index) =>
    validateCase(entry, index, repositoriesById, caseIds, schemaVersion),
  );
  if (new Set(cases.map((entry) => entry.task.path)).size !== cases.length) {
    fail("task paths must be unique");
  }
  return manifest;
}

export function validateGate2BenchmarkSuccessor(
  successorInput,
  predecessorInput,
  predecessorManifestSha256,
) {
  const predecessor = validateGate2BenchmarkManifest(predecessorInput);
  const successor = validateGate2BenchmarkManifest(successorInput);
  assertLiteral(predecessor.schemaVersion, 1, "predecessor schemaVersion");
  assertLiteral(successor.schemaVersion, 2, "successor schemaVersion");
  assertLiteral(predecessorManifestSha256, GATE2_V1_MANIFEST_SHA256, "predecessor manifest digest");
  assertLiteral(
    successor.supersedes.manifestSha256,
    predecessorManifestSha256,
    "successor predecessor manifest digest",
  );

  for (const key of [
    "benchmarkId",
    "digestEncoding",
    "resultSchemaVersion",
    "executionBoundary",
    "thresholds",
    "measurementDefinitions",
    "repositories",
  ]) {
    if (JSON.stringify(successor[key]) !== JSON.stringify(predecessor[key])) {
      fail(`successor must preserve predecessor ${key}`);
    }
  }

  const replacedIds = new Set(GATE2_V2_REPLACEMENTS.map((entry) => entry.predecessorCaseId));
  const predecessorCases = new Map(predecessor.cases.map((entry) => [entry.id, entry]));
  const unchangedSuccessors = successor.cases.filter((entry) => predecessorCases.has(entry.id));
  if (unchangedSuccessors.length !== 28) fail("successor must preserve exactly 28 unchanged cases");
  for (const benchmarkCase of unchangedSuccessors) {
    if (replacedIds.has(benchmarkCase.id)) fail("successor retained a replaced case identity");
    if (JSON.stringify(benchmarkCase) !== JSON.stringify(predecessorCases.get(benchmarkCase.id))) {
      fail(`successor 28 unchanged cases drifted at ${benchmarkCase.id}`);
    }
  }
  for (const expected of GATE2_V2_SUCCESSOR_CASES) {
    const observed = successor.cases.find((entry) => entry.id === expected.id);
    if (JSON.stringify(observed) !== JSON.stringify(expected)) {
      fail(`successor replacement case drifted at ${expected.id}`);
    }
  }
  return successor;
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

const STRICT_JSON_DEFAULT_MESSAGE = "manifest must be strict JSON";

/**
 * Names the shape of a document that is not strict JSON, in the same closed vocabulary
 * `describeNonStrictJson` uses in the core harness, so a benchmark record and a CLI
 * record describe the same failure the same way. This exists because a frozen Gate 2
 * record that said only "must be strict JSON" could not tell a reader that the model had
 * stopped 728 characters into a 728-character document -- a truncated answer, not a
 * malformed one -- and the diagnosis had to be re-derived by hand.
 */
export function describeNonStrictGate2Json(source) {
  // First match wins: a fenced answer that is also truncated reports "markdown_fenced",
  // because the fence is what the reader sees first and what the model did wrong first.
  // The vocabulary names one shape, never a set.
  if (typeof source !== "string") return "not_text";
  const trimmed = source.trim();
  if (trimmed.length === 0) return "empty";
  if (/^```/.test(trimmed)) return "markdown_fenced";
  if (!/^[{[]/.test(trimmed)) return "leading_prose";
  try {
    // Parse the same text the gates above inspected. `trim` strips U+FEFF and the other
    // Unicode spaces that JSON.parse rejects at position 0, so parsing the untrimmed
    // source would report a truncated answer with a leading BOM as "other".
    JSON.parse(trimmed);
    return "other";
  } catch (error) {
    const message = String(error?.message ?? "");
    const position = /position (\d+)/.exec(message);
    // JSON.parse reports the offset it gave up at. Giving up at the end of the input
    // means the structure was never closed: the document is truncated, not malformed.
    if (position !== null && Number(position[1]) >= trimmed.length) return "truncated";
    return "other";
  }
}

export function parseStrictGate2Json(source) {
  if (typeof source !== "string") {
    invalidJson(`${STRICT_JSON_DEFAULT_MESSAGE} (${describeNonStrictGate2Json(source)})`);
  }
  if (Buffer.byteLength(source, "utf8") > MAX_GATE2_JSON_BYTES) {
    invalidJson("input exceeds the Gate 2 JSON byte limit");
  }
  try {
    new StrictJsonScanner(source).parseDocument();
    return JSON.parse(source);
  } catch (error) {
    // The scanner's own messages (depth, duplicate keys, byte limits) are specific and
    // are kept verbatim. Only two refusals gain the shape: the scanner's generic one and
    // JSON.parse's own SyntaxError. Anything else -- a RangeError, a fault inside the
    // scanner -- is a defect, not a data shape, and is rethrown as itself.
    const message = String(error?.message ?? "");
    const genericContractRefusal =
      message.startsWith("Gate 2 benchmark contract") &&
      message.endsWith(STRICT_JSON_DEFAULT_MESSAGE);
    if (genericContractRefusal || error instanceof SyntaxError) {
      invalidJson(`${STRICT_JSON_DEFAULT_MESSAGE} (${describeNonStrictGate2Json(source)})`);
    }
    throw error;
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
  let predecessorManifestSha256 = null;
  if (manifest.schemaVersion === 2) {
    const predecessorPath = path.resolve(repositoryRoot, manifest.supersedes.manifestPath);
    const predecessorRaw = await readFile(predecessorPath);
    predecessorManifestSha256 = sha256Raw(predecessorRaw);
    assertLiteral(
      predecessorManifestSha256,
      manifest.supersedes.manifestSha256,
      "predecessor manifest digest",
    );
    const predecessor = parseStrictGate2Json(predecessorRaw.toString("utf8"));
    validateGate2BenchmarkSuccessor(manifest, predecessor, predecessorManifestSha256);
  }
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
    predecessorManifestSha256,
  };
}

async function main() {
  if (process.argv.length !== 2) {
    fail("usage: node scripts/gate2-benchmark-contract.mjs");
  }
  const scriptPath = fileURLToPath(import.meta.url);
  const repositoryRoot = path.resolve(path.dirname(scriptPath), "..");
  const manifestPaths = [
    path.join(repositoryRoot, "fixtures/evals/gate2/manifest.v1.json"),
    path.join(repositoryRoot, "fixtures/evals/gate2/manifest.v2.json"),
  ];
  const loadedContracts = await Promise.all(
    manifestPaths.map((manifestPath) => loadGate2BenchmarkContract(manifestPath, repositoryRoot)),
  );
  const loaded = loadedContracts[1];
  process.stdout.write(
    `${JSON.stringify({
      benchmarkId: loaded.manifest.benchmarkId,
      benchmarkRevision: loaded.manifest.benchmarkRevision,
      manifestSha256: loaded.manifestSha256,
      predecessorManifestSha256: loaded.predecessorManifestSha256,
      validatedManifests: loadedContracts.map((entry) => ({
        benchmarkRevision: entry.manifest.benchmarkRevision,
        manifestSha256: entry.manifestSha256,
      })),
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
