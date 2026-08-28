import { createHash } from "node:crypto";

import {
  parseStrictGate2Json,
  validateGate2BenchmarkManifest,
} from "./gate2-benchmark-contract.mjs";

const RESULT_KEYS = Object.freeze([
  "schemaVersion",
  "benchmarkId",
  "benchmarkRevision",
  "manifestSha256",
  "cohortClass",
  "evaluatorRevision",
  "generatedAt",
  "passed",
  "counts",
  "retrievalAggregate",
  "planAggregate",
  "effects",
  "effectEvidence",
  "observations",
  "limitations",
  "assessment",
]);
const COUNT_KEYS = Object.freeze([
  "manifestCases",
  "cohortCases",
  "executedCases",
  "passedCases",
  "failedCases",
  "unexecutedCases",
]);
const RETRIEVAL_KEYS = Object.freeze(["macroRecall", "macroPrecision", "digestProvenanceCoverage"]);
const PLAN_AGGREGATE_KEYS = Object.freeze([
  "firstPassAcceptedCases",
  "firstPassAcceptanceRate",
  "autonomousTargetDiscoveryMeasured",
  "targetAuthority",
]);
const EFFECT_KEYS = Object.freeze([
  "providerCalls",
  "loopbackProviderRequests",
  "externalNetworkRequests",
  "remoteMutations",
  "sourceCheckoutMutations",
  "privateWorkspaceMutations",
  "sandboxCheckExecutions",
  "icarusRegisteredCheckExecutions",
  "liveDatabaseConnections",
  "offlineInMemoryDatabaseChecks",
  "temporaryGitFixtureSetup",
  "runtimeReopens",
]);
const OBSERVATION_KEYS = Object.freeze([
  "caseId",
  "repositoryId",
  "scenarioEvaluatorId",
  "repositoryRevisionSha256",
  "taskSha256",
  "baseCommit",
  "treeSha1",
  "retrievalDigestSha256",
  "repositoryDigestSha256",
  "provider",
  "selectedContext",
  "retrievalMetrics",
  "targetAuthority",
  "plan",
  "baseline",
  "mutation",
  "usage",
  "sourceCheckoutUnchanged",
  "sourceGitDirectoryUnchanged",
  "durableRunRecovered",
  "scenarioEvidenceSha256",
]);
const PROVIDER_KEYS = Object.freeze([
  "kind",
  "model",
  "adapterVersion",
  "transport",
  "instructionDigests",
  "loopbackRequests",
  "requestDigests",
]);
const CONTEXT_KEYS = Object.freeze(["path", "sha256"]);
const RETRIEVAL_METRIC_KEYS = Object.freeze(["recall", "precision", "digestProvenanceCoverage"]);
const PLAN_KEYS = Object.freeze([
  "firstPassAccepted",
  "operatorSelectedTargets",
  "approvedTargets",
  "checkIds",
  "planSha256",
  "autonomousTargetDiscoveryMeasured",
]);
const BASELINE_KEYS = Object.freeze(["outcome", "checks"]);
const MUTATION_KEYS = Object.freeze([
  "runId",
  "state",
  "patchSetSha256",
  "diffSha256",
  "checkpointSha256",
  "changedPaths",
  "checks",
  "finalFiles",
  "privateWorkspaceMutated",
]);
const CHECK_KEYS = Object.freeze([
  "checkId",
  "argv",
  "exitCode",
  "signal",
  "stdoutBytes",
  "stdoutSha256",
  "stderrBytes",
  "stderrSha256",
  "truncated",
  "outcome",
]);
const FINAL_FILE_KEYS = Object.freeze(["path", "sha256"]);
const USAGE_KEYS = Object.freeze([
  "toolCalls",
  "inputTokens",
  "outputTokens",
  "estimatedCostUsd",
  "reservedCostUsd",
]);
const TARGET_AUTHORITY = "operator_selected_existing_anchor_plus_expected_changed_paths";
const HEX_40 = /^[0-9a-f]{40}$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_CONTEXT_FILES_PER_CASE = 8;

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value)) deepFreeze(entry);
  }
  return value;
}

export const GATE2_SCAFFOLD_A_PROVIDER = deepFreeze({
  kind: "ollama",
  model: "icarus-gate2-deterministic-scaffold-a-fixture",
  adapterVersion: "production-ollama-plan-patchset-v1",
  transport: "loopback-http",
  instructionDigests: [
    "eecd9bcebee8bbdea74b6d2eee555bc599532c4e5f315e0506d767af155f6a8a",
    "1b1d68633c2af6fe5b7de4a2ae20327662cd3637d398ac5fe89e4b197ca491e9",
  ],
});

export const GATE2_SCAFFOLD_A_MANIFEST_CASE_IDS = Object.freeze([
  "scaffold-lantern-json-output",
  "scaffold-cart-discount",
  "scaffold-parser-cli",
  "scaffold-task-priority",
  "scaffold-greeting-command",
]);
export const GATE2_SCAFFOLD_A_EXCLUDED_CASE_ID = "scaffold-task-priority";

export const GATE2_SCAFFOLD_A_COHORT_LIMITATIONS = Object.freeze([
  "deterministic-loopback-responses-measure-contract-integration-not-live-model-scaffold-quality",
  "four-scaffold-cases-do-not-complete-thirty-task-gate2-benchmark",
  "protected-migration-scaffold-remains-unexecuted-without-gate5-authority",
  "operator-selected-target-authority-does-not-measure-autonomous-target-discovery",
  "exact-byte-oracles-measure-these-scenarios-not-general-scaffold-correctness",
  "macro-recall-can-pass-while-one-case-omits-expected-context",
  "created-check-files-are-evaluator-fixtures-not-repository-authored-proof",
  "evidence-digests-prove-self-consistency-not-runner-authenticity",
  "partial-cohort-accounting-cannot-be-added-as-a-full-suite-result",
]);

export const GATE2_SCAFFOLD_A_ORACLES = deepFreeze([
  {
    caseId: "scaffold-lantern-json-output",
    scenarioEvaluatorId: "scaffold-lantern-json-output-evaluator",
    baselineOutcome: "failed",
    inputTokens: 150,
    outputTokens: 80,
    check: {
      id: "lantern-json-output",
      name: "Lantern text and JSON output",
      argv: ["python", "-m", "tests.test_json_output"],
    },
    approvedFiles: [
      {
        op: "modify",
        path: "src/main.py",
        sha256: "c8b72b0ae29f1c6fa8f43fb9cb0308b298ee6a05a316b278dd0c42bd71362d4a",
        content:
          'import argparse\nimport json\nfrom pathlib import Path\n\nfrom src.greeting import greeting\n\n\ndef main(argv: list[str] | None = None) -> int:\n    parser = argparse.ArgumentParser()\n    parser.add_argument("--json", action="store_true")\n    args = parser.parse_args(argv)\n    audience = json.loads(Path("config/app.json").read_text(encoding="utf-8"))["audience"]\n    message = greeting(audience)\n    if args.json:\n        print(json.dumps({"greeting": message}, separators=(",", ":"), sort_keys=True))\n    else:\n        print(message)\n    return 0\n\n\nif __name__ == "__main__":\n    raise SystemExit(main())\n',
      },
      {
        op: "create",
        path: "tests/test_json_output.py",
        sha256: "37f3b6fe20a9cd8434e32198b0b1dc365bd52d73559a7cffc8127e7d6ea83edd",
        content:
          'import subprocess\nimport sys\n\n\ndef run(*args: str) -> subprocess.CompletedProcess[str]:\n    return subprocess.run(\n        [sys.executable, "-m", "src.main", *args],\n        capture_output=True,\n        text=True,\n        check=False,\n    )\n\n\ndefault = run()\nassert (default.returncode, default.stdout, default.stderr) == (\n    0,\n    "Welcome, traveler.\\n",\n    "",\n)\nstructured = run("--json")\nassert (structured.returncode, structured.stdout, structured.stderr) == (\n    0,\n    \'{"greeting":"Welcome, traveler."}\\n\',\n    "",\n)\n',
      },
    ],
  },
  {
    caseId: "scaffold-cart-discount",
    scenarioEvaluatorId: "scaffold-cart-discount-evaluator",
    baselineOutcome: "failed",
    inputTokens: 150,
    outputTokens: 80,
    check: {
      id: "cart-discount",
      name: "Integer-cents discount bounds",
      argv: ["python", "-m", "checks.test_discount"],
    },
    approvedFiles: [
      {
        op: "create",
        path: "checks/test_discount.py",
        sha256: "2afad7fac2f35ed51e671333c00f2b57f46f5c68c79addf9c6f5cd2bfc2fcb32",
        content:
          'from src.discount import apply_discount\n\nassert apply_discount(1_000, 0) == 1_000\nassert apply_discount(1_000, 2_500) == 750\nassert apply_discount(999, 10_000) == 0\n\nfor values in [(-1, 0), (100, -1), (100, 10_001)]:\n    try:\n        apply_discount(*values)\n    except ValueError:\n        pass\n    else:\n        raise AssertionError(f"expected ValueError for {values!r}")\n',
      },
      {
        op: "create",
        path: "src/discount.py",
        sha256: "7a55a1994cef71ae891f6c364dcb0ae0ff52bd302a61925299600fc70c31e56b",
        content:
          'def apply_discount(subtotal_cents: int, basis_points: int) -> int:\n    """Return a bounded integer-cents total after a basis-point discount."""\n    if subtotal_cents < 0:\n        raise ValueError("subtotal_cents must be nonnegative")\n    if not 0 <= basis_points <= 10_000:\n        raise ValueError("basis_points must be between 0 and 10000")\n    return subtotal_cents * (10_000 - basis_points) // 10_000\n',
      },
    ],
  },
  {
    caseId: "scaffold-parser-cli",
    scenarioEvaluatorId: "scaffold-parser-cli-evaluator",
    baselineOutcome: "failed",
    inputTokens: 150,
    outputTokens: 80,
    check: {
      id: "parser-cli",
      name: "Parser command exit contract",
      argv: ["python", "-m", "tests.test_cli"],
    },
    approvedFiles: [
      {
        op: "create",
        path: "src/cli.py",
        sha256: "552a1a948cb0309df3b7469db1dbcfd32aadf8d649aaca7ffb758d4745093ac4",
        content:
          'import sys\n\nfrom src.parser import parse_enabled\n\n\ndef main(argv: list[str] | None = None) -> int:\n    args = sys.argv[1:] if argv is None else argv\n    if len(args) != 1 or args[0] not in {"true", "false"}:\n        print("usage: python -m src.cli <true|false>", file=sys.stderr)\n        return 2\n    print("true" if parse_enabled(args[0]) else "false")\n    return 0\n\n\nif __name__ == "__main__":\n    raise SystemExit(main())\n',
      },
      {
        op: "create",
        path: "tests/test_cli.py",
        sha256: "f20d58168683cbaa4620f3f3fbbf9911295d28c1562c760c463c4afcb721e6c1",
        content:
          'import subprocess\nimport sys\n\n\ndef run(*args: str) -> subprocess.CompletedProcess[str]:\n    return subprocess.run(\n        [sys.executable, "-m", "src.cli", *args],\n        capture_output=True,\n        text=True,\n        check=False,\n    )\n\n\nenabled = run("true")\nassert (enabled.returncode, enabled.stdout, enabled.stderr) == (0, "true\\n", "")\nfor args in [(), ("maybe",), ("true", "false")]:\n    invalid = run(*args)\n    assert invalid.returncode == 2\n    assert invalid.stdout == ""\n    assert invalid.stderr == "usage: python -m src.cli <true|false>\\n"\n',
      },
    ],
  },
  {
    caseId: "scaffold-greeting-command",
    scenarioEvaluatorId: "scaffold-greeting-command-evaluator",
    baselineOutcome: "failed",
    inputTokens: 150,
    outputTokens: 80,
    check: {
      id: "greeting-command",
      name: "Greeting source-of-truth command",
      argv: ["python", "-m", "tests.test_greet"],
    },
    approvedFiles: [
      {
        op: "create",
        path: "src/greet.py",
        sha256: "622f87133e6421d357a9d923c079318f2e4bba2a0b49150547bb1fb72f5acb7b",
        content:
          'from pathlib import Path\n\n\ndef load_greeting(path: str | Path = "src/greeting.txt") -> str:\n    text = Path(path).read_text(encoding="utf-8")\n    if not text.endswith("\\n") or len(text.splitlines()) != 1:\n        raise ValueError("greeting must be exactly one newline-terminated line")\n    return text[:-1]\n\n\ndef main() -> int:\n    print(load_greeting())\n    return 0\n\n\nif __name__ == "__main__":\n    raise SystemExit(main())\n',
      },
      {
        op: "create",
        path: "tests/test_greet.py",
        sha256: "cf32e7705a72a41fd480dfe4ec7352f8ccd5ac9d487bf6afb3a60cc71c8b42d6",
        content:
          'import subprocess\nimport sys\nimport tempfile\nfrom pathlib import Path\n\nfrom src.greet import load_greeting\n\nassert load_greeting() == "Hello, world!"\ncommand = subprocess.run(\n    [sys.executable, "-m", "src.greet"],\n    capture_output=True,\n    text=True,\n    check=False,\n)\nassert (command.returncode, command.stdout, command.stderr) == (0, "Hello, world!\\n", "")\nwith tempfile.TemporaryDirectory() as directory:\n    invalid = Path(directory, "greeting.txt")\n    invalid.write_text("Hello\\nAgain\\n", encoding="utf-8")\n    try:\n        load_greeting(invalid)\n    except ValueError:\n        pass\n    else:\n        raise AssertionError("multi-line greeting was accepted")\n',
      },
    ],
  },
]);

function fail(message) {
  throw new Error(`Gate 2 scaffold A cohort: ${message}`);
}

function exactRecord(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string")
  ) {
    fail(`${label} must be a plain string-keyed record`);
  }
  if (JSON.stringify(Object.keys(value)) !== JSON.stringify(keys)) {
    fail(`${label} must contain exactly: ${keys.join(", ")}`);
  }
  return value;
}

function exactArray(value, length, label) {
  if (!Array.isArray(value) || value.length !== length) {
    fail(`${label} must contain exactly ${length} entries`);
  }
  return value;
}

function literal(value, expected, label) {
  if (value !== expected) fail(`${label} must equal ${JSON.stringify(expected)}`);
  return value;
}

function digest(value, label) {
  if (typeof value !== "string" || !HEX_64.test(value)) fail(`${label} must be SHA-256`);
  return value;
}

function safePath(value, label) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 240 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    fail(`${label} must be a repository-relative POSIX path`);
  }
  return value;
}

function nonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} must be a nonnegative integer`);
  return value;
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function computeGate2ScaffoldAEvidenceDigest(observationInput) {
  if (
    observationInput === null ||
    typeof observationInput !== "object" ||
    Array.isArray(observationInput)
  ) {
    fail("observation evidence must be an object");
  }
  const { scenarioEvidenceSha256: _evidence, ...unsigned } = observationInput;
  return sha256(stableJson(unsigned));
}

function validateCheck(value, expected, expectedOutcome, label) {
  const check = exactRecord(value, CHECK_KEYS, label);
  literal(check.checkId, expected.id, `${label}.checkId`);
  literal(JSON.stringify(check.argv), JSON.stringify(expected.argv), `${label}.argv`);
  if (expectedOutcome === "passed") {
    literal(check.exitCode, 0, `${label}.exitCode`);
  } else if (!Number.isSafeInteger(check.exitCode) || check.exitCode === 0) {
    fail(`${label}.exitCode must show failure`);
  }
  literal(check.signal, null, `${label}.signal`);
  nonnegativeInteger(check.stdoutBytes, `${label}.stdoutBytes`);
  digest(check.stdoutSha256, `${label}.stdoutSha256`);
  nonnegativeInteger(check.stderrBytes, `${label}.stderrBytes`);
  digest(check.stderrSha256, `${label}.stderrSha256`);
  literal(check.truncated, false, `${label}.truncated`);
  literal(check.outcome, expectedOutcome, `${label}.outcome`);
}

function validateOracle(oracle, benchmarkCase, repository, label) {
  literal(oracle.scenarioEvaluatorId, benchmarkCase.expectedOutcome.scenarioEvaluatorId, label);
  const expectedPaths = benchmarkCase.expectedOutcome.expectedChangedPaths;
  literal(
    JSON.stringify(oracle.approvedFiles.map((file) => file.path)),
    JSON.stringify(expectedPaths),
    `${label}.approved paths`,
  );
  const sourceDigests = new Map(repository.files.map((file) => [file.path, file.sha256]));
  for (const [index, file] of oracle.approvedFiles.entries()) {
    safePath(file.path, `${label}.approvedFiles[${index}].path`);
    literal(sha256(file.content), file.sha256, `${label}.approvedFiles[${index}].sha256`);
    if (file.op === "create") {
      if (sourceDigests.has(file.path)) fail(`${label} creates an existing path`);
    } else if (file.op === "modify") {
      if (!sourceDigests.has(file.path)) fail(`${label} modifies an absent path`);
    } else {
      fail(`${label} has unsupported edit operation`);
    }
  }
}

export function validateGate2ScaffoldACohortResult(value, manifestInput, manifestSha256) {
  const manifest = validateGate2BenchmarkManifest(manifestInput);
  const result = exactRecord(value, RESULT_KEYS, "result");
  literal(result.schemaVersion, 1, "schemaVersion");
  literal(result.benchmarkId, manifest.benchmarkId, "benchmarkId");
  literal(result.benchmarkRevision, manifest.benchmarkRevision, "benchmarkRevision");
  literal(result.manifestSha256, digest(manifestSha256, "manifest digest"), "manifestSha256");
  literal(result.cohortClass, "scaffold", "cohortClass");
  literal(result.evaluatorRevision, "deterministic-production-lifecycle-v1", "evaluatorRevision");
  if (
    typeof result.generatedAt !== "string" ||
    Number.isNaN(Date.parse(result.generatedAt)) ||
    new Date(result.generatedAt).toISOString() !== result.generatedAt
  ) {
    fail("generatedAt must be a canonical ISO timestamp");
  }
  literal(result.passed, true, "passed");

  const allScaffoldCases = manifest.cases.filter((entry) => entry.class === "scaffold");
  literal(
    JSON.stringify(allScaffoldCases.map((entry) => entry.id)),
    JSON.stringify(GATE2_SCAFFOLD_A_MANIFEST_CASE_IDS),
    "manifest scaffold class",
  );
  const excludedCase = allScaffoldCases.find(
    (entry) => entry.id === GATE2_SCAFFOLD_A_EXCLUDED_CASE_ID,
  );
  if (excludedCase === undefined) fail("protected scaffold exclusion is missing");
  literal(
    JSON.stringify(excludedCase.expectedOutcome.expectedChangedPaths),
    JSON.stringify([
      "checks/schema_contract.sql",
      "migrations/001_add_priority.sql",
      "schema/current.sql",
    ]),
    "protected scaffold exclusion paths",
  );
  const includedCaseIds = new Set(GATE2_SCAFFOLD_A_ORACLES.map((entry) => entry.caseId));
  const scaffoldCases = allScaffoldCases.filter((entry) => includedCaseIds.has(entry.id));
  literal(
    JSON.stringify(scaffoldCases.map((entry) => entry.id)),
    JSON.stringify(GATE2_SCAFFOLD_A_ORACLES.map((entry) => entry.caseId)),
    "manifest scaffold A cohort",
  );
  const cohortCases = scaffoldCases.length;
  const counts = exactRecord(result.counts, COUNT_KEYS, "counts");
  const expectedCounts = [
    manifest.cases.length,
    cohortCases,
    cohortCases,
    cohortCases,
    0,
    manifest.cases.length - cohortCases,
  ];
  for (const [index, key] of COUNT_KEYS.entries()) {
    literal(counts[key], expectedCounts[index], `counts.${key}`);
  }

  const retrievalAggregate = exactRecord(
    result.retrievalAggregate,
    RETRIEVAL_KEYS,
    "retrievalAggregate",
  );
  const planAggregate = exactRecord(result.planAggregate, PLAN_AGGREGATE_KEYS, "planAggregate");
  literal(
    planAggregate.firstPassAcceptedCases,
    cohortCases,
    "planAggregate.firstPassAcceptedCases",
  );
  literal(planAggregate.firstPassAcceptanceRate, 1, "planAggregate.firstPassAcceptanceRate");
  literal(
    planAggregate.autonomousTargetDiscoveryMeasured,
    false,
    "planAggregate.autonomousTargetDiscoveryMeasured",
  );
  literal(planAggregate.targetAuthority, TARGET_AUTHORITY, "planAggregate.targetAuthority");

  const effects = exactRecord(result.effects, EFFECT_KEYS, "effects");
  const expectedEffects = [8, 8, 0, 0, 0, 4, 8, 4, 0, 0, true, 4];
  for (const [index, key] of EFFECT_KEYS.entries()) {
    literal(effects[key], expectedEffects[index], `effects.${key}`);
  }
  const effectEvidence = exactRecord(result.effectEvidence, EFFECT_KEYS, "effectEvidence");
  const expectedEvidence = [
    "observed",
    "observed",
    "design-assertion",
    "design-assertion",
    "observed",
    "observed",
    "observed",
    "observed",
    "design-assertion",
    "design-assertion",
    "observed",
    "observed",
  ];
  for (const [index, key] of EFFECT_KEYS.entries()) {
    literal(effectEvidence[key], expectedEvidence[index], `effectEvidence.${key}`);
  }

  const repositories = new Map(manifest.repositories.map((entry) => [entry.id, entry]));
  const observations = exactArray(result.observations, cohortCases, "observations");
  const recalls = [];
  const precisions = [];
  for (const [index, observationValue] of observations.entries()) {
    const benchmarkCase = scaffoldCases[index];
    const oracle = GATE2_SCAFFOLD_A_ORACLES[index];
    if (benchmarkCase === undefined || oracle === undefined) fail("scaffold cohort index missing");
    const repository = repositories.get(benchmarkCase.repositoryId);
    if (repository === undefined) fail(`repository missing for ${benchmarkCase.id}`);
    validateOracle(oracle, benchmarkCase, repository, `oracle[${index}]`);

    const observation = exactRecord(observationValue, OBSERVATION_KEYS, `observations[${index}]`);
    literal(observation.caseId, benchmarkCase.id, `observations[${index}].caseId`);
    literal(
      observation.repositoryId,
      benchmarkCase.repositoryId,
      `observations[${index}].repositoryId`,
    );
    literal(
      observation.scenarioEvaluatorId,
      oracle.scenarioEvaluatorId,
      `observations[${index}].scenarioEvaluatorId`,
    );
    literal(
      observation.repositoryRevisionSha256,
      repository.revisionSha256,
      `observations[${index}].repositoryRevisionSha256`,
    );
    literal(observation.taskSha256, benchmarkCase.task.sha256, `observations[${index}].taskSha256`);
    if (!HEX_40.test(observation.baseCommit) || !HEX_40.test(observation.treeSha1)) {
      fail(`observations[${index}] Git identities must be SHA-1`);
    }
    digest(observation.retrievalDigestSha256, `observations[${index}].retrievalDigestSha256`);
    digest(observation.repositoryDigestSha256, `observations[${index}].repositoryDigestSha256`);

    const provider = exactRecord(
      observation.provider,
      PROVIDER_KEYS,
      `observations[${index}].provider`,
    );
    for (const key of ["kind", "model", "adapterVersion", "transport"]) {
      literal(
        provider[key],
        GATE2_SCAFFOLD_A_PROVIDER[key],
        `observations[${index}].provider.${key}`,
      );
    }
    literal(
      JSON.stringify(provider.instructionDigests),
      JSON.stringify(GATE2_SCAFFOLD_A_PROVIDER.instructionDigests),
      `observations[${index}].provider.instructionDigests`,
    );
    literal(provider.loopbackRequests, 2, `observations[${index}].provider.loopbackRequests`);
    const requestDigests = exactArray(
      provider.requestDigests,
      2,
      `observations[${index}].provider.requestDigests`,
    );
    for (const [requestIndex, entry] of requestDigests.entries()) {
      digest(entry, `observations[${index}].provider.requestDigests[${requestIndex}]`);
    }

    const digestByPath = new Map(repository.files.map((entry) => [entry.path, entry.sha256]));
    if (
      !Array.isArray(observation.selectedContext) ||
      observation.selectedContext.length < 1 ||
      observation.selectedContext.length > MAX_CONTEXT_FILES_PER_CASE
    ) {
      fail(`observations[${index}].selectedContext has invalid cardinality`);
    }
    const selectedPaths = new Set();
    for (const [contextIndex, contextValue] of observation.selectedContext.entries()) {
      const context = exactRecord(
        contextValue,
        CONTEXT_KEYS,
        `observations[${index}].selectedContext[${contextIndex}]`,
      );
      const contextPath = safePath(
        context.path,
        `observations[${index}].selectedContext[${contextIndex}].path`,
      );
      if (selectedPaths.has(contextPath)) fail(`observations[${index}] repeats context path`);
      literal(
        context.sha256,
        digestByPath.get(contextPath),
        `observations[${index}].selectedContext[${contextIndex}].sha256`,
      );
      selectedPaths.add(contextPath);
    }
    const matched = benchmarkCase.expectedContextPaths.filter((entry) => selectedPaths.has(entry));
    const expectedRecall = matched.length / benchmarkCase.expectedContextPaths.length;
    const expectedPrecision = matched.length / observation.selectedContext.length;
    const metrics = exactRecord(
      observation.retrievalMetrics,
      RETRIEVAL_METRIC_KEYS,
      `observations[${index}].retrievalMetrics`,
    );
    literal(metrics.recall, expectedRecall, `observations[${index}].retrievalMetrics.recall`);
    literal(
      metrics.precision,
      expectedPrecision,
      `observations[${index}].retrievalMetrics.precision`,
    );
    literal(
      metrics.digestProvenanceCoverage,
      1,
      `observations[${index}].retrievalMetrics.digestProvenanceCoverage`,
    );
    recalls.push(expectedRecall);
    precisions.push(expectedPrecision);

    literal(
      observation.targetAuthority,
      TARGET_AUTHORITY,
      `observations[${index}].targetAuthority`,
    );
    const plan = exactRecord(observation.plan, PLAN_KEYS, `observations[${index}].plan`);
    literal(plan.firstPassAccepted, true, `observations[${index}].plan.firstPassAccepted`);
    const expectedChangedPaths = benchmarkCase.expectedOutcome.expectedChangedPaths;
    const sourcePaths = new Set(repository.files.map((file) => file.path));
    const selection = [...expectedChangedPaths];
    if (!sourcePaths.has(selection[0])) {
      const existingAnchor = repository.files
        .map((file) => file.path)
        .filter((entry) => entry.localeCompare(selection[0]) < 0)
        .sort((left, right) => left.localeCompare(right))[0];
      if (existingAnchor === undefined)
        fail(`observations[${index}] has no existing target anchor`);
      selection.push(existingAnchor);
    }
    const expectedOperatorTargets = selection.sort((left, right) => left.localeCompare(right));
    literal(
      JSON.stringify(plan.operatorSelectedTargets),
      JSON.stringify(expectedOperatorTargets),
      `observations[${index}].plan.operatorSelectedTargets`,
    );
    literal(
      JSON.stringify(plan.approvedTargets),
      JSON.stringify(expectedChangedPaths),
      `observations[${index}].plan.approvedTargets`,
    );
    literal(
      JSON.stringify(plan.checkIds),
      JSON.stringify([oracle.check.id]),
      `observations[${index}].plan.checkIds`,
    );
    digest(plan.planSha256, `observations[${index}].plan.planSha256`);
    literal(
      plan.autonomousTargetDiscoveryMeasured,
      false,
      `observations[${index}].plan.autonomousTargetDiscoveryMeasured`,
    );

    const baseline = exactRecord(
      observation.baseline,
      BASELINE_KEYS,
      `observations[${index}].baseline`,
    );
    literal(baseline.outcome, oracle.baselineOutcome, `observations[${index}].baseline.outcome`);
    const baselineChecks = exactArray(baseline.checks, 1, `observations[${index}].baseline.checks`);
    validateCheck(
      baselineChecks[0],
      oracle.check,
      oracle.baselineOutcome,
      `observations[${index}].baseline.checks[0]`,
    );

    const mutation = exactRecord(
      observation.mutation,
      MUTATION_KEYS,
      `observations[${index}].mutation`,
    );
    if (typeof mutation.runId !== "string" || !UUID.test(mutation.runId)) {
      fail(`observations[${index}].mutation.runId must be UUID`);
    }
    literal(mutation.state, "completed", `observations[${index}].mutation.state`);
    for (const key of ["patchSetSha256", "diffSha256", "checkpointSha256"]) {
      digest(mutation[key], `observations[${index}].mutation.${key}`);
    }
    literal(
      JSON.stringify(mutation.changedPaths),
      JSON.stringify(expectedChangedPaths),
      `observations[${index}].mutation.changedPaths`,
    );
    const mutationChecks = exactArray(mutation.checks, 1, `observations[${index}].mutation.checks`);
    validateCheck(
      mutationChecks[0],
      oracle.check,
      "passed",
      `observations[${index}].mutation.checks[0]`,
    );
    const finalFiles = exactArray(
      mutation.finalFiles,
      oracle.approvedFiles.length,
      `observations[${index}].mutation.finalFiles`,
    );
    for (const [fileIndex, fileValue] of finalFiles.entries()) {
      const file = exactRecord(
        fileValue,
        FINAL_FILE_KEYS,
        `observations[${index}].mutation.finalFiles[${fileIndex}]`,
      );
      literal(file.path, oracle.approvedFiles[fileIndex]?.path, `finalFiles[${fileIndex}].path`);
      literal(
        file.sha256,
        oracle.approvedFiles[fileIndex]?.sha256,
        `finalFiles[${fileIndex}].sha256`,
      );
    }
    literal(
      mutation.privateWorkspaceMutated,
      true,
      `observations[${index}].mutation.privateWorkspaceMutated`,
    );

    const usage = exactRecord(observation.usage, USAGE_KEYS, `observations[${index}].usage`);
    nonnegativeInteger(usage.toolCalls, `observations[${index}].usage.toolCalls`);
    if (usage.toolCalls < 1 || usage.toolCalls > 40) {
      fail(`observations[${index}].usage.toolCalls exceeds the production ceiling`);
    }
    literal(usage.inputTokens, oracle.inputTokens, `observations[${index}].usage.inputTokens`);
    literal(usage.outputTokens, oracle.outputTokens, `observations[${index}].usage.outputTokens`);
    literal(usage.estimatedCostUsd, 0, `observations[${index}].usage.estimatedCostUsd`);
    literal(usage.reservedCostUsd, 0, `observations[${index}].usage.reservedCostUsd`);
    literal(
      observation.sourceCheckoutUnchanged,
      true,
      `observations[${index}].sourceCheckoutUnchanged`,
    );
    literal(
      observation.sourceGitDirectoryUnchanged,
      true,
      `observations[${index}].sourceGitDirectoryUnchanged`,
    );
    literal(observation.durableRunRecovered, true, `observations[${index}].durableRunRecovered`);
    literal(
      observation.scenarioEvidenceSha256,
      computeGate2ScaffoldAEvidenceDigest(observation),
      `observations[${index}].scenarioEvidenceSha256`,
    );
  }

  const macroRecall = recalls.reduce((sum, entry) => sum + entry, 0) / recalls.length;
  const macroPrecision = precisions.reduce((sum, entry) => sum + entry, 0) / precisions.length;
  literal(retrievalAggregate.macroRecall, macroRecall, "retrievalAggregate.macroRecall");
  literal(retrievalAggregate.macroPrecision, macroPrecision, "retrievalAggregate.macroPrecision");
  literal(
    retrievalAggregate.digestProvenanceCoverage,
    1,
    "retrievalAggregate.digestProvenanceCoverage",
  );
  if (
    macroRecall < manifest.thresholds.minimumMacroRetrievalRecall ||
    macroPrecision < manifest.thresholds.minimumMacroRetrievalPrecision ||
    planAggregate.firstPassAcceptanceRate < manifest.thresholds.minimumFirstPassPlanAcceptance
  ) {
    fail("scaffold cohort does not satisfy manifest retrieval or plan thresholds");
  }
  literal(
    JSON.stringify(result.limitations),
    JSON.stringify(GATE2_SCAFFOLD_A_COHORT_LIMITATIONS),
    "limitations",
  );
  literal(
    result.assessment,
    "deterministic_scaffold_a_cohort_passed_gate2_incomplete",
    "assessment",
  );
  return value;
}

export function parseAndValidateGate2ScaffoldACohortResult(source, manifest, manifestSha256) {
  return validateGate2ScaffoldACohortResult(parseStrictGate2Json(source), manifest, manifestSha256);
}
