import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
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
export const GATE2_V2_MANIFEST_SHA256 =
  "0eca6348be7848bac44922bcf426defdbd581af8ef790515e28c231b5fbc69c5";
// Pinned from the committed bytes; a change to manifest.v3.json is a new revision, not an edit.
export const GATE2_V3_MANIFEST_SHA256 =
  "e1411ab97ee64c8dccb39868ae29a6774c3281c21a7bc81061c31ab22fae3134";
// Pinned from the committed bytes; a change to manifest.v4.json is a new revision, not an edit.
export const GATE2_V4_MANIFEST_SHA256 =
  "da1f9e0b71ed1cc91cc66c1908920efdab51be325d6e1637188e6daa93924dfb";
const GATE2_V3_CASE_IDS = Object.freeze(
  GATE2_V2_CASE_IDS.map((caseId) => {
    if (caseId === "refactor-cart-money-module") return "refactor-cart-money-extraction";
    if (caseId === "scaffold-parser-cli") return "scaffold-parser-cli-check";
    if (caseId === "scaffold-lantern-json-output") return "scaffold-json-output-mode";
    return caseId;
  }),
);
const GATE2_V4_CASE_IDS = Object.freeze(
  GATE2_V3_CASE_IDS.map((caseId) => {
    if (caseId === "repair-lantern-missing-config") return "repair-lantern-config-contract";
    if (caseId === "scaffold-greeting-command") return "scaffold-greeting-command-check";
    if (caseId === "explain-schema-contract") return "explain-task-schema-contract";
    return caseId;
  }),
);
export const GATE2_CASE_IDS_BY_REVISION = Object.freeze({
  "gate2-thirty-task-v1": GATE2_CASE_IDS,
  "gate2-thirty-task-v2-host-policy-compatible": GATE2_V2_CASE_IDS,
  "gate2-thirty-task-v3-task-entailed-targets": GATE2_V3_CASE_IDS,
  "gate2-thirty-task-v4-stated-contracts": GATE2_V4_CASE_IDS,
});
export const GATE2_CURRENT_BENCHMARK_REVISION = "gate2-thirty-task-v4-stated-contracts";
export const GATE2_CURRENT_MANIFEST_PATH = "fixtures/evals/gate2/manifest.v4.json";
// A frozen set names its benchmark by digest; this is the only place a digest becomes a path.
export const GATE2_MANIFEST_PATHS_BY_SHA256 = Object.freeze({
  [GATE2_V1_MANIFEST_SHA256]: "fixtures/evals/gate2/manifest.v1.json",
  [GATE2_V2_MANIFEST_SHA256]: "fixtures/evals/gate2/manifest.v2.json",
  [GATE2_V3_MANIFEST_SHA256]: "fixtures/evals/gate2/manifest.v3.json",
  [GATE2_V4_MANIFEST_SHA256]: GATE2_CURRENT_MANIFEST_PATH,
});
// The bytes a revision may be loaded from. A manifest is refused unless its digest is the one
// registered for the revision it claims; a valid-JSON edit is a new revision, never an edit.
export const GATE2_MANIFEST_SHA256_BY_REVISION = Object.freeze({
  "gate2-thirty-task-v1": GATE2_V1_MANIFEST_SHA256,
  "gate2-thirty-task-v2-host-policy-compatible": GATE2_V2_MANIFEST_SHA256,
  "gate2-thirty-task-v3-task-entailed-targets": GATE2_V3_MANIFEST_SHA256,
  "gate2-thirty-task-v4-stated-contracts": GATE2_V4_MANIFEST_SHA256,
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

const GATE2_V3_REPLACEMENTS = Object.freeze([
  Object.freeze({
    predecessorCaseId: "refactor-cart-money-module",
    successorCaseId: "refactor-cart-money-extraction",
    reason: "task-text-did-not-entail-the-expected-new-module",
  }),
  Object.freeze({
    predecessorCaseId: "scaffold-parser-cli",
    successorCaseId: "scaffold-parser-cli-check",
    reason: "expected-check-path-contradicted-the-fixture-check-directory-convention",
  }),
  Object.freeze({
    predecessorCaseId: "scaffold-lantern-json-output",
    successorCaseId: "scaffold-json-output-mode",
    reason: "task-title-left-the-expected-check-name-underdetermined",
  }),
]);

const GATE2_V3_SUCCESSOR_CASES = Object.freeze([
  Object.freeze({
    id: "refactor-cart-money-extraction",
    class: "refactor",
    repositoryId: "buggy",
    task: Object.freeze({
      path: "fixtures/evals/gate2/tasks/refactor-cart-money-extraction.md",
      sha256: "8f1bdefcc33cdc0e9fed80466a1f00864f854ca7d28da36b2ad367d8bfc628f8",
    }),
    expectedContextPaths: Object.freeze(["checks/test_cart.py", "README.md", "src/cart.py"]),
    expectedOutcome: Object.freeze({
      kind: "mutation",
      expectedChangedPaths: Object.freeze(["src/cart.py", "src/money.py"]),
      expectedCitationPaths: Object.freeze([]),
      expectedFindingIds: Object.freeze([]),
      allowNoFinding: false,
      scenarioEvaluatorId: "refactor-cart-money-extraction-evaluator",
    }),
  }),
  Object.freeze({
    id: "scaffold-json-output-mode",
    class: "scaffold",
    repositoryId: "unfamiliar",
    task: Object.freeze({
      path: "fixtures/evals/gate2/tasks/scaffold-json-output-mode.md",
      sha256: "33afcb78ed0cfa00578b7e707f77365f99336e190e166a45e2dc5e4b0c573d4f",
    }),
    expectedContextPaths: Object.freeze([
      "config/app.json",
      "README.md",
      "src/greeting.py",
      "src/main.py",
    ]),
    expectedOutcome: Object.freeze({
      kind: "mutation",
      expectedChangedPaths: Object.freeze(["src/main.py", "tests/test_json_output.py"]),
      expectedCitationPaths: Object.freeze([]),
      expectedFindingIds: Object.freeze([]),
      allowNoFinding: false,
      scenarioEvaluatorId: "scaffold-json-output-mode-evaluator",
    }),
  }),
  Object.freeze({
    id: "scaffold-parser-cli-check",
    class: "scaffold",
    repositoryId: "failing",
    task: Object.freeze({
      path: "fixtures/evals/gate2/tasks/scaffold-parser-cli-check.md",
      sha256: "9112ed62adbb5215b577531e7eb78b43470b69d22d49f55cfa121b2e155df01b",
    }),
    expectedContextPaths: Object.freeze(["checks/test_parser.py", "README.md", "src/parser.py"]),
    expectedOutcome: Object.freeze({
      kind: "mutation",
      expectedChangedPaths: Object.freeze(["checks/test_cli.py", "src/cli.py"]),
      expectedCitationPaths: Object.freeze([]),
      expectedFindingIds: Object.freeze([]),
      allowNoFinding: false,
      scenarioEvaluatorId: "scaffold-parser-cli-check-evaluator",
    }),
  }),
]);

const GATE2_V4_REPLACEMENTS = Object.freeze([
  Object.freeze({
    predecessorCaseId: "repair-lantern-missing-config",
    successorCaseId: "repair-lantern-config-contract",
    reason: "check-demanded-an-exact-message-the-task-text-never-stated",
  }),
  Object.freeze({
    predecessorCaseId: "scaffold-greeting-command",
    successorCaseId: "scaffold-greeting-command-check",
    reason: "expected-check-path-contradicted-the-fixture-check-directory-convention",
  }),
  Object.freeze({
    predecessorCaseId: "explain-schema-contract",
    successorCaseId: "explain-task-schema-contract",
    reason: "task-text-named-two-documentation-files-where-the-expected-set-holds-one",
  }),
]);

const GATE2_V4_SUCCESSOR_CASES = Object.freeze([
  Object.freeze({
    id: "repair-lantern-config-contract",
    class: "repair",
    repositoryId: "unfamiliar",
    task: Object.freeze({
      path: "fixtures/evals/gate2/tasks/repair-lantern-config-contract.md",
      sha256: "2b8a52633b0550cc642036e181fb422d1d65470b562ba9b0b7e4700add95afe8",
    }),
    expectedContextPaths: Object.freeze(["config/app.json", "README.md", "src/main.py"]),
    expectedOutcome: Object.freeze({
      kind: "mutation",
      expectedChangedPaths: Object.freeze(["src/main.py"]),
      expectedCitationPaths: Object.freeze([]),
      expectedFindingIds: Object.freeze([]),
      allowNoFinding: false,
      scenarioEvaluatorId: "repair-lantern-config-contract-evaluator",
    }),
  }),
  Object.freeze({
    id: "explain-task-schema-contract",
    class: "explanation",
    repositoryId: "schema",
    task: Object.freeze({
      path: "fixtures/evals/gate2/tasks/explain-task-schema-contract.md",
      sha256: "a00de70ffd192d6c1d7b0e15becab54536aa533310cb101e48b38e4c01f15a9f",
    }),
    expectedContextPaths: Object.freeze([
      "checks/schema_contract.sql",
      "README.md",
      "schema/current.sql",
    ]),
    expectedOutcome: Object.freeze({
      kind: "read_only",
      expectedChangedPaths: Object.freeze([]),
      expectedCitationPaths: Object.freeze([
        "checks/schema_contract.sql",
        "README.md",
        "schema/current.sql",
      ]),
      expectedFindingIds: Object.freeze([]),
      allowNoFinding: false,
      scenarioEvaluatorId: "explain-task-schema-contract-evaluator",
    }),
  }),
  Object.freeze({
    id: "scaffold-greeting-command-check",
    class: "scaffold",
    repositoryId: "basic",
    task: Object.freeze({
      path: "fixtures/evals/gate2/tasks/scaffold-greeting-command-check.md",
      sha256: "bd0274ef7b42e3ad5ba5ececc69c33fde5203b535c3fe21a1d1efb5dd6a558eb",
    }),
    expectedContextPaths: Object.freeze([
      "AGENTS.md",
      "checks/verify.py",
      "README.md",
      "src/greeting.txt",
    ]),
    expectedOutcome: Object.freeze({
      kind: "mutation",
      expectedChangedPaths: Object.freeze(["checks/test_greet.py", "src/greet.py"]),
      expectedCitationPaths: Object.freeze([]),
      expectedFindingIds: Object.freeze([]),
      allowNoFinding: false,
      scenarioEvaluatorId: "scaffold-greeting-command-check-evaluator",
    }),
  }),
]);

// Every schema-2 revision is registered here by lineage: which manifest it supersedes (by
// digest), which cases it replaces, and the successor cases by exact value. A manifest whose
// benchmarkRevision is not registered is refused; nothing about a lineage is read from the
// manifest that claims it.
const GATE2_LINEAGE = Object.freeze({
  "gate2-thirty-task-v2-host-policy-compatible": Object.freeze({
    predecessor: Object.freeze({
      benchmarkRevision: "gate2-thirty-task-v1",
      manifestPath: "fixtures/evals/gate2/manifest.v1.json",
      manifestSha256: GATE2_V1_MANIFEST_SHA256,
    }),
    replacements: GATE2_V2_REPLACEMENTS,
    successorCases: GATE2_V2_SUCCESSOR_CASES,
  }),
  "gate2-thirty-task-v3-task-entailed-targets": Object.freeze({
    predecessor: Object.freeze({
      benchmarkRevision: "gate2-thirty-task-v2-host-policy-compatible",
      manifestPath: "fixtures/evals/gate2/manifest.v2.json",
      manifestSha256: GATE2_V2_MANIFEST_SHA256,
    }),
    replacements: GATE2_V3_REPLACEMENTS,
    successorCases: GATE2_V3_SUCCESSOR_CASES,
  }),
  "gate2-thirty-task-v4-stated-contracts": Object.freeze({
    predecessor: Object.freeze({
      benchmarkRevision: "gate2-thirty-task-v3-task-entailed-targets",
      manifestPath: "fixtures/evals/gate2/manifest.v3.json",
      manifestSha256: GATE2_V3_MANIFEST_SHA256,
    }),
    replacements: GATE2_V4_REPLACEMENTS,
    successorCases: GATE2_V4_SUCCESSOR_CASES,
  }),
});

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

function validateLineageMetadata(manifest, lineage) {
  const supersedes = assertPlainRecord(manifest.supersedes, "supersedes", SUPERSEDES_KEYS);
  for (const key of SUPERSEDES_KEYS) {
    assertLiteral(supersedes[key], lineage.predecessor[key], `supersedes.${key}`);
  }
  const count = lineage.replacements.length;
  const replacements = assertArray(manifest.replacements, "replacements", count, count);
  for (const [index, expected] of lineage.replacements.entries()) {
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

function lineageOf(benchmarkRevision) {
  if (typeof benchmarkRevision !== "string" || !Object.hasOwn(GATE2_LINEAGE, benchmarkRevision)) {
    fail("benchmarkRevision must name a registered successor revision");
  }
  return GATE2_LINEAGE[benchmarkRevision];
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
  let benchmarkRevision = "gate2-thirty-task-v1";
  if (schemaVersion === 1) {
    assertLiteral(manifest.benchmarkRevision, benchmarkRevision, "benchmarkRevision");
  } else {
    benchmarkRevision = manifest.benchmarkRevision;
    validateLineageMetadata(manifest, lineageOf(benchmarkRevision));
  }
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

/**
 * Validate a successor against its predecessor's raw bytes. The predecessor is digested and
 * strict-parsed here, so the object the lineage is checked against cannot diverge from the
 * digest the lineage pins: a review forged a v2 object and handed it in beside the real v2
 * digest, and the old object-plus-digest signature accepted the pair.
 */
export function validateGate2BenchmarkSuccessor(successorInput, predecessorBytes) {
  if (typeof predecessorBytes !== "string" && !(predecessorBytes instanceof Uint8Array)) {
    fail("predecessor must be raw manifest bytes");
  }
  const predecessorManifestSha256 = sha256Raw(predecessorBytes);
  const predecessorText =
    typeof predecessorBytes === "string"
      ? predecessorBytes
      : Buffer.from(predecessorBytes).toString("utf8");
  const predecessor = validateGate2BenchmarkManifest(parseStrictGate2Json(predecessorText));
  const successor = validateGate2BenchmarkManifest(successorInput);
  assertLiteral(successor.schemaVersion, 2, "successor schemaVersion");
  const lineage = lineageOf(successor.benchmarkRevision);
  assertLiteral(
    predecessor.benchmarkRevision,
    lineage.predecessor.benchmarkRevision,
    "predecessor benchmarkRevision",
  );
  assertLiteral(
    predecessorManifestSha256,
    lineage.predecessor.manifestSha256,
    "predecessor manifest digest",
  );
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

  const replacedIds = new Set(lineage.replacements.map((entry) => entry.predecessorCaseId));
  const unchangedCount = 30 - lineage.replacements.length;
  const predecessorCases = new Map(predecessor.cases.map((entry) => [entry.id, entry]));
  const unchangedSuccessors = successor.cases.filter((entry) => predecessorCases.has(entry.id));
  if (unchangedSuccessors.length !== unchangedCount) {
    fail(`successor must preserve exactly ${unchangedCount} unchanged cases`);
  }
  for (const benchmarkCase of unchangedSuccessors) {
    if (replacedIds.has(benchmarkCase.id)) fail("successor retained a replaced case identity");
    if (JSON.stringify(benchmarkCase) !== JSON.stringify(predecessorCases.get(benchmarkCase.id))) {
      fail(`successor ${unchangedCount} unchanged cases drifted at ${benchmarkCase.id}`);
    }
  }
  for (const expected of lineage.successorCases) {
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

/**
 * Resolve one path under the repository root through the path boundary: the root is a real
 * directory, the path is inside it, and every component below the root is checked with
 * lstat -- directories that are not symlinks on the way down, and at the end an ordinary
 * single-link regular file (kind "file") or a directory (kind "directory") -- before any
 * bytes or entries are read. A review reached the lineage through a byte-identical symlink to
 * a file outside the repository, and then a fixture through a symlinked root and a
 * hard-linked file: each time the digest authenticated the content while the path said
 * nothing about where it came from.
 */
async function assertRepositoryPath(repositoryRoot, target, label, kind) {
  const root = path.resolve(repositoryRoot);
  const real = await realpath(root).catch((error) => {
    if (error?.code === "ENOENT") fail(`${label}: repository root does not exist`);
    throw error;
  });
  if (real !== root) fail(`${label}: repository root resolves through a symlink`);
  if (!(await lstat(root)).isDirectory()) fail(`${label}: repository root is not a directory`);
  const absolute = path.resolve(root, target);
  const relative = path.relative(root, absolute);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    fail(`${label}: path escapes the repository root`);
  }
  const components = relative.split(path.sep);
  let current = root;
  for (const [index, component] of components.entries()) {
    current = path.join(current, component);
    const status = await lstat(current).catch((error) => {
      if (error?.code === "ENOENT") fail(`${label}: ${relative} does not exist`);
      throw error;
    });
    if (status.isSymbolicLink()) fail(`${label}: ${relative} passes through a symlink`);
    if (index < components.length - 1 || kind === "directory") {
      if (!status.isDirectory()) fail(`${label}: ${relative} is not a directory`);
    } else {
      if (!status.isFile()) fail(`${label}: ${relative} is not a regular file`);
      if (status.nlink !== 1) fail(`${label}: ${relative} is hard-linked`);
    }
  }
  return absolute;
}

async function readRepositoryFile(repositoryRoot, target, label) {
  return readFile(await assertRepositoryPath(repositoryRoot, target, label, "file"));
}

async function snapshotFixture(repositoryRoot, fixturePath, label) {
  const root = await assertRepositoryPath(repositoryRoot, fixturePath, label, "directory");
  const files = [];
  async function visit(directory, prefix = "") {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (relative.split("/").includes(".git")) fail("fixture repositories cannot contain .git");
      const absolute = path.join(directory, entry.name);
      // A Dirent says what the entry looked like at readdir; lstat says what is there now,
      // and it is the only call that sees a hard link.
      const status = await lstat(absolute);
      if (status.isSymbolicLink()) fail(`fixture contains a special path: ${relative}`);
      if (status.isDirectory()) {
        await visit(absolute, relative);
      } else if (status.isFile()) {
        if (status.nlink !== 1) fail(`${label}: ${relative} is hard-linked`);
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
  const givenPath = manifestPath instanceof URL ? fileURLToPath(manifestPath) : manifestPath;
  const raw = await readRepositoryFile(repositoryRoot, givenPath, "manifest");
  const manifest = validateGate2BenchmarkManifest(parseStrictGate2Json(raw.toString("utf8")));
  const manifestSha256 = sha256Raw(raw);
  // The bytes must be the registered bytes for the revision they claim. A valid-JSON edit
  // (a review appended one space) would otherwise run under a digest nothing can resolve.
  assertLiteral(
    manifestSha256,
    GATE2_MANIFEST_SHA256_BY_REVISION[manifest.benchmarkRevision],
    `registered manifest digest for ${manifest.benchmarkRevision}`,
  );
  let predecessorManifestSha256 = null;
  // Walk the whole lineage against committed bytes: v3 binds v2's digest, v2 binds v1's.
  // A predecessor edited anywhere in the chain refuses every manifest above it.
  let successor = manifest;
  while (successor.schemaVersion === 2) {
    const predecessorRaw = await readRepositoryFile(
      repositoryRoot,
      successor.supersedes.manifestPath,
      "predecessor manifest",
    );
    const digest = sha256Raw(predecessorRaw);
    assertLiteral(digest, successor.supersedes.manifestSha256, "predecessor manifest digest");
    validateGate2BenchmarkSuccessor(successor, predecessorRaw);
    if (predecessorManifestSha256 === null) predecessorManifestSha256 = digest;
    successor = validateGate2BenchmarkManifest(
      parseStrictGate2Json(predecessorRaw.toString("utf8")),
    );
  }
  for (const benchmarkCase of manifest.cases) {
    const taskBytes = await readRepositoryFile(
      repositoryRoot,
      benchmarkCase.task.path,
      `task ${benchmarkCase.id}`,
    );
    assertLiteral(
      sha256Raw(taskBytes),
      benchmarkCase.task.sha256,
      `task digest for ${benchmarkCase.id}`,
    );
  }
  for (const repository of manifest.repositories) {
    const observed = await snapshotFixture(
      repositoryRoot,
      repository.fixturePath,
      `repository ${repository.id}`,
    );
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
    manifestSha256,
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
    path.join(repositoryRoot, "fixtures/evals/gate2/manifest.v3.json"),
    path.join(repositoryRoot, GATE2_CURRENT_MANIFEST_PATH),
  ];
  const loadedContracts = await Promise.all(
    manifestPaths.map((manifestPath) => loadGate2BenchmarkContract(manifestPath, repositoryRoot)),
  );
  const loaded = loadedContracts[3];
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
