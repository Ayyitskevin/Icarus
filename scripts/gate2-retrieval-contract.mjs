const HEX_40 = /^[0-9a-f]{40}$/;
const HEX_64 = /^[0-9a-f]{64}$/;

const TOP_LEVEL_KEYS = [
  "schemaVersion",
  "benchmarkId",
  "benchmarkRevision",
  "resultSchemaVersion",
  "executionBoundary",
  "case",
];
const BOUNDARY_KEYS = [
  "mode",
  "providerCalls",
  "networkRequests",
  "repositoryMutations",
  "registeredCommands",
  "measuresExplanationCompletion",
];
const CASE_KEYS = [
  "id",
  "class",
  "repository",
  "task",
  "expectedPaths",
  "retrievalBudget",
  "thresholds",
  "requiredEvidence",
  "claimBoundary",
];
const REPOSITORY_KEYS = ["fixturePath", "treeSha1", "commitSha1", "files"];
const FILE_KEYS = ["path", "sha256"];
const TASK_KEYS = ["path", "sha256"];
const BUDGET_KEYS = ["maxFiles", "maxTotalBytes", "maxScanBytes"];
const THRESHOLD_KEYS = ["minimumRecall", "minimumPrecision"];
const EXPECTED_EVIDENCE = [
  "fixture_contract_valid",
  "pinned_committed_tree",
  "deterministic_retrieval_digest",
  "file_line_provenance",
  "recall_precision_measured",
  "source_checkout_unchanged",
  "zero_external_or_repository_effects",
];
const EXPECTED_PATHS = ["README.md", "config/app.json", "src/greeting.py", "src/main.py"];
export const GATE2_RETRIEVAL_LIMITATIONS = Object.freeze([
  "This one-case deterministic fixture measures lexical retrieval only; it is not the Gate 2 30-task release benchmark.",
  "The explain_codebase capability remains unsupported until a read-only explanation run produces validated source citations.",
]);

function fail(message) {
  throw new Error(`Gate 2 retrieval contract: ${message}`);
}

function record(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(`${label} must have a record prototype`);
  }
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string")) {
    fail(`${label} must not contain symbol keys`);
  }
  return value;
}

function exactKeys(value, keys, label) {
  const object = record(value, label);
  const actual = Object.keys(object).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label} must contain exactly ${expected.join(", ")}`);
  }
  return object;
}

function safePath(value, prefix, label) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value !== value.normalize("NFC") ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value
      .split("/")
      .some((part) => part === "" || part === "." || part === ".." || part === ".git") ||
    (prefix !== null && !value.startsWith(prefix))
  ) {
    fail(`${label} is not a bounded repository-relative path`);
  }
  return value;
}

function exactStringArray(value, expected, label) {
  if (!Array.isArray(value) || JSON.stringify(value) !== JSON.stringify(expected)) {
    fail(`${label} is not the canonical closed list`);
  }
}

function positiveInteger(value, maximum, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    fail(`${label} must be an integer between 1 and ${maximum}`);
  }
}

export function validateGate2RetrievalManifest(value) {
  const manifest = exactKeys(value, TOP_LEVEL_KEYS, "manifest");
  if (
    manifest.schemaVersion !== 1 ||
    manifest.benchmarkId !== "icarus.gate2.retrieval.v1" ||
    manifest.benchmarkRevision !== 1 ||
    manifest.resultSchemaVersion !== 1
  ) {
    fail("manifest identity is unsupported");
  }
  const boundary = exactKeys(manifest.executionBoundary, BOUNDARY_KEYS, "executionBoundary");
  if (
    boundary.mode !== "deterministic_read_only" ||
    boundary.providerCalls !== 0 ||
    boundary.networkRequests !== 0 ||
    boundary.repositoryMutations !== 0 ||
    boundary.registeredCommands !== 0 ||
    boundary.measuresExplanationCompletion !== false
  ) {
    fail("execution boundary must remain read-only and retrieval-only");
  }

  const scenario = exactKeys(manifest.case, CASE_KEYS, "case");
  if (
    scenario.id !== "explain-codebase-retrieval" ||
    scenario.class !== "explain_codebase" ||
    scenario.claimBoundary !== "retrieval_measured_explanation_unsupported"
  ) {
    fail("case identity or claim boundary changed");
  }
  const repository = exactKeys(scenario.repository, REPOSITORY_KEYS, "case.repository");
  if (repository.fixturePath !== "fixtures/evals/gate2/repos/unfamiliar") {
    fail("fixture path changed");
  }
  if (!HEX_40.test(repository.treeSha1) || !HEX_40.test(repository.commitSha1)) {
    fail("pinned Git identities must be lowercase SHA-1 values");
  }
  if (!Array.isArray(repository.files) || repository.files.length !== EXPECTED_PATHS.length + 1) {
    fail("repository inventory must contain four expected files and one negative example");
  }
  const inventoryPaths = [];
  for (const [index, entryValue] of repository.files.entries()) {
    const entry = exactKeys(entryValue, FILE_KEYS, `case.repository.files[${index}]`);
    inventoryPaths.push(safePath(entry.path, null, `case.repository.files[${index}].path`));
    if (!HEX_64.test(entry.sha256)) fail(`case.repository.files[${index}].sha256 is invalid`);
  }
  const sortedInventory = [...inventoryPaths].sort();
  if (
    new Set(inventoryPaths).size !== inventoryPaths.length ||
    JSON.stringify(inventoryPaths) !== JSON.stringify(sortedInventory)
  ) {
    fail("repository inventory paths must be unique and sorted");
  }

  const task = exactKeys(scenario.task, TASK_KEYS, "case.task");
  if (
    safePath(task.path, "fixtures/evals/tasks/", "case.task.path") !==
      "fixtures/evals/tasks/explain-codebase.md" ||
    !HEX_64.test(task.sha256)
  ) {
    fail("task contract is invalid");
  }
  exactStringArray(scenario.expectedPaths, EXPECTED_PATHS, "case.expectedPaths");
  if (
    EXPECTED_PATHS.some((entry) => !inventoryPaths.includes(entry)) ||
    inventoryPaths.filter((entry) => !EXPECTED_PATHS.includes(entry)).length !== 1
  ) {
    fail("repository inventory must contain exactly one non-expected negative example");
  }

  const budget = exactKeys(scenario.retrievalBudget, BUDGET_KEYS, "case.retrievalBudget");
  positiveInteger(budget.maxFiles, 64, "maxFiles");
  positiveInteger(budget.maxTotalBytes, 524288, "maxTotalBytes");
  positiveInteger(budget.maxScanBytes, 67108864, "maxScanBytes");
  if (budget.maxFiles !== EXPECTED_PATHS.length || budget.maxTotalBytes > budget.maxScanBytes) {
    fail("retrieval budget must cover the expected set and fit within its scan budget");
  }
  const thresholds = exactKeys(scenario.thresholds, THRESHOLD_KEYS, "case.thresholds");
  if (thresholds.minimumRecall !== 0.9 || thresholds.minimumPrecision !== 0.6) {
    fail("Gate 2 retrieval thresholds changed");
  }
  exactStringArray(scenario.requiredEvidence, EXPECTED_EVIDENCE, "case.requiredEvidence");
  return value;
}

const RESULT_KEYS = [
  "schemaVersion",
  "benchmarkId",
  "benchmarkRevision",
  "manifestSha256",
  "generatedAt",
  "passed",
  "case",
  "limitations",
];
const RESULT_CASE_KEYS = [
  "id",
  "baseCommit",
  "treeSha1",
  "retrievalDigestSha256",
  "repositoryDigestSha256",
  "selectedPaths",
  "provenance",
  "recall",
  "precision",
  "sourceCheckoutUnchanged",
  "workspaceUnchanged",
  "effects",
  "passed",
];
const EFFECT_KEYS = [
  "providerCalls",
  "networkRequests",
  "repositoryMutations",
  "registeredCommands",
];
const PROVENANCE_KEYS = ["path", "sha256", "lineCount", "matches"];
const MATCH_KEYS = ["term", "lines"];

export function validateGate2RetrievalResult(value, manifest, expectedManifestSha256) {
  validateGate2RetrievalManifest(manifest);
  if (!HEX_64.test(expectedManifestSha256)) fail("expected manifest digest is invalid");
  const result = exactKeys(value, RESULT_KEYS, "result");
  if (
    result.schemaVersion !== manifest.resultSchemaVersion ||
    result.benchmarkId !== manifest.benchmarkId ||
    result.benchmarkRevision !== manifest.benchmarkRevision ||
    result.manifestSha256 !== expectedManifestSha256 ||
    typeof result.generatedAt !== "string" ||
    typeof result.passed !== "boolean" ||
    !Array.isArray(result.limitations) ||
    JSON.stringify(result.limitations) !== JSON.stringify(GATE2_RETRIEVAL_LIMITATIONS)
  ) {
    fail("result envelope is invalid");
  }
  const scenario = exactKeys(result.case, RESULT_CASE_KEYS, "result.case");
  const expected = manifest.case;
  if (
    scenario.id !== expected.id ||
    scenario.baseCommit !== expected.repository.commitSha1 ||
    scenario.treeSha1 !== expected.repository.treeSha1 ||
    !HEX_64.test(scenario.retrievalDigestSha256) ||
    !HEX_64.test(scenario.repositoryDigestSha256) ||
    !Array.isArray(scenario.selectedPaths) ||
    !Array.isArray(scenario.provenance) ||
    typeof scenario.recall !== "number" ||
    typeof scenario.precision !== "number" ||
    typeof scenario.sourceCheckoutUnchanged !== "boolean" ||
    typeof scenario.workspaceUnchanged !== "boolean" ||
    typeof scenario.passed !== "boolean"
  ) {
    fail("result case is invalid");
  }
  const inventory = new Map(expected.repository.files.map((entry) => [entry.path, entry.sha256]));
  const selectedPaths = scenario.selectedPaths.map((entry, index) =>
    safePath(entry, null, `result.case.selectedPaths[${index}]`),
  );
  if (
    new Set(selectedPaths).size !== selectedPaths.length ||
    selectedPaths.length > expected.retrievalBudget.maxFiles ||
    selectedPaths.some((entry) => !inventory.has(entry)) ||
    scenario.provenance.length !== selectedPaths.length
  ) {
    fail("result selection is not a unique subset of the closed fixture inventory");
  }
  const provenancePaths = [];
  for (const [index, entryValue] of scenario.provenance.entries()) {
    const entry = exactKeys(entryValue, PROVENANCE_KEYS, `result.case.provenance[${index}]`);
    const entryPath = safePath(entry.path, null, `result.case.provenance[${index}].path`);
    provenancePaths.push(entryPath);
    if (
      entry.sha256 !== inventory.get(entryPath) ||
      !Number.isSafeInteger(entry.lineCount) ||
      entry.lineCount < 1 ||
      !Array.isArray(entry.matches)
    ) {
      fail(`result provenance is invalid for ${entryPath}`);
    }
    for (const [matchIndex, matchValue] of entry.matches.entries()) {
      const match = exactKeys(
        matchValue,
        MATCH_KEYS,
        `result.case.provenance[${index}].matches[${matchIndex}]`,
      );
      if (
        typeof match.term !== "string" ||
        !/^[a-z0-9]+$/.test(match.term) ||
        !Array.isArray(match.lines) ||
        match.lines.length < 1 ||
        match.lines.length > 8 ||
        match.lines.some(
          (line) => !Number.isSafeInteger(line) || line < 1 || line > entry.lineCount,
        )
      ) {
        fail(`result line provenance is invalid for ${entryPath}`);
      }
    }
  }
  if (JSON.stringify(provenancePaths) !== JSON.stringify(selectedPaths)) {
    fail("result provenance order does not match selected paths");
  }
  const expectedPaths = new Set(expected.expectedPaths);
  const matched = selectedPaths.filter((entry) => expectedPaths.has(entry)).length;
  const recall = matched / expected.expectedPaths.length;
  const precision = selectedPaths.length === 0 ? 0 : matched / selectedPaths.length;
  if (scenario.recall !== recall || scenario.precision !== precision) {
    fail("result recall or precision does not follow the closed path sets");
  }
  const effects = exactKeys(scenario.effects, EFFECT_KEYS, "result.case.effects");
  if (Object.values(effects).some((value) => value !== 0))
    fail("result reports an external effect");
  const expectedPass =
    recall >= expected.thresholds.minimumRecall &&
    precision >= expected.thresholds.minimumPrecision &&
    scenario.sourceCheckoutUnchanged &&
    scenario.workspaceUnchanged &&
    scenario.provenance.some((entry) => entry.matches.length > 0);
  if (scenario.passed !== expectedPass || result.passed !== expectedPass) {
    fail("result pass claim does not follow the closed thresholds");
  }
  return value;
}
