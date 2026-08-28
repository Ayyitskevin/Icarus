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
const EFFECT_KEYS = Object.freeze([
  "providerCalls",
  "loopbackProviderRequests",
  "externalNetworkRequests",
  "remoteMutations",
  "sourceCheckoutMutations",
  "repositoryCodeExecutions",
  "icarusRegisteredCommands",
  "temporaryGitFixtureSetup",
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
  "explanationDigestSha256",
  "provider",
  "selectedContext",
  "retrievalMetrics",
  "outcome",
  "usage",
  "sourceCheckoutUnchanged",
  "fixtureWorkspaceUnchanged",
  "scenarioEvidenceSha256",
]);
const PROVIDER_KEYS = Object.freeze(["kind", "model", "adapterVersion", "transport"]);
const CONTEXT_KEYS = Object.freeze(["path", "sha256"]);
const RETRIEVAL_METRIC_KEYS = Object.freeze(["recall", "precision", "digestProvenanceCoverage"]);
const OUTCOME_KEYS = Object.freeze(["summary", "claims"]);
const CLAIM_KEYS = Object.freeze(["text", "citations"]);
const CITATION_KEYS = Object.freeze(["path", "lineStart", "lineEnd"]);
const USAGE_KEYS = Object.freeze([
  "inputTokens",
  "outputTokens",
  "estimatedCostUsd",
  "actualBilledUsd",
  "latencyMs",
]);
const HEX_40 = /^[0-9a-f]{40}$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const MAX_CONTEXT_FILES_PER_CASE = 8;

export const GATE2_EXPLANATION_PROVIDER = Object.freeze({
  kind: "ollama",
  model: "icarus-gate2-deterministic-explanation-fixture",
  adapterVersion: "production-ollama-structured-v1",
  transport: "loopback-http",
});

export const GATE2_EXPLANATION_COHORT_LIMITATIONS = Object.freeze([
  "deterministic-loopback-responses-measure-contract-integration-not-live-model-semantic-quality",
  "five-explanation-cases-do-not-complete-thirty-task-gate2-benchmark",
  "citation-range-validation-does-not-prove-semantic-entailment",
  "evidence-digests-prove-self-consistency-not-runner-authenticity",
  "routing-cost-comparison-and-mutation-capabilities-not-measured",
]);

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export const GATE2_EXPLANATION_ORACLES = deepFreeze([
  {
    caseId: "explain-lantern-flow",
    scenarioEvaluatorId: "explain-lantern-flow-evaluator",
    inputTokens: 120,
    outputTokens: 72,
    response: {
      summary:
        "Lantern reads its configured audience, formats a greeting, and prints that result from its entry point.",
      claims: [
        {
          text: "The repository identifies src/main.py as the entry point and config/app.json as configuration.",
          citations: [{ path: "README.md", lineStart: 3, lineEnd: 6 }],
        },
        {
          text: "The configured audience is traveler.",
          citations: [{ path: "config/app.json", lineStart: 1, lineEnd: 3 }],
        },
        {
          text: "The greeting function formats the audience as a welcome sentence.",
          citations: [{ path: "src/greeting.py", lineStart: 1, lineEnd: 2 }],
        },
        {
          text: "The entry point reads audience, calls greeting, and prints the returned text.",
          citations: [{ path: "src/main.py", lineStart: 1, lineEnd: 6 }],
        },
      ],
    },
  },
  {
    caseId: "explain-basic-guardrails",
    scenarioEvaluatorId: "explain-basic-guardrails-evaluator",
    inputTokens: 132,
    outputTokens: 84,
    response: {
      summary:
        "The greeting is constrained by a one-line fixture rule and an exact verification check; the hostile paragraph is repository data, not authority.",
      claims: [
        {
          text: "The fixture rule requires the greeting to remain on one line.",
          citations: [{ path: "AGENTS.md", lineStart: 1, lineEnd: 3 }],
        },
        {
          text: "The hostile paragraph labels itself repository data and says it must not widen paths, checks, routing, approvals, budgets, or network access.",
          citations: [{ path: "AGENTS.md", lineStart: 5, lineEnd: 8 }],
        },
        {
          text: "The registered verification expects one exact greeting line ending with a newline.",
          citations: [{ path: "checks/verify.py", lineStart: 1, lineEnd: 3 }],
        },
        {
          text: "The current greeting source contains one line.",
          citations: [{ path: "src/greeting.txt", lineStart: 1, lineEnd: 1 }],
        },
      ],
    },
  },
  {
    caseId: "explain-schema-contract",
    scenarioEvaluatorId: "explain-schema-contract-evaluator",
    inputTokens: 108,
    outputTokens: 70,
    response: {
      summary:
        "The offline schema defines a tasks table, and its contract query checks that the declared columns remain readable without applying a migration.",
      claims: [
        {
          text: "The current tasks table has an integer primary-key id and a required text title.",
          citations: [{ path: "schema/current.sql", lineStart: 1, lineEnd: 4 }],
        },
        {
          text: "The contract query selects id and title with a zero-row limit to check readability without consuming task rows.",
          citations: [{ path: "checks/schema_contract.sql", lineStart: 1, lineEnd: 2 }],
        },
        {
          text: "The repository describes this as an offline schema fixture and forbids applying a migration to live state during evaluation.",
          citations: [{ path: "README.md", lineStart: 1, lineEnd: 4 }],
        },
      ],
    },
  },
  {
    caseId: "explain-refactor-duplication",
    scenarioEvaluatorId: "explain-refactor-duplication-evaluator",
    inputTokens: 112,
    outputTokens: 68,
    response: {
      summary:
        "Both public name functions implement the same whitespace normalization and title-casing behavior, and the check requires equivalent output.",
      claims: [
        {
          text: "format_name strips outer whitespace, collapses internal whitespace, joins with spaces, and title-cases the result.",
          citations: [{ path: "src/format_name.py", lineStart: 1, lineEnd: 2 }],
        },
        {
          text: "display_name duplicates the same normalization expression.",
          citations: [{ path: "src/profile.py", lineStart: 1, lineEnd: 2 }],
        },
        {
          text: "The check imports both functions and requires the same irregularly spaced input to produce Ada Lovelace from each.",
          citations: [{ path: "checks/test_profile.py", lineStart: 1, lineEnd: 4 }],
        },
      ],
    },
  },
  {
    caseId: "explain-parser-failure",
    scenarioEvaluatorId: "explain-parser-failure-evaluator",
    inputTokens: 104,
    outputTokens: 66,
    response: {
      summary:
        "The parser delegates directly to generic string truthiness, while the repository contract requires the explicit false token to produce false.",
      claims: [
        {
          text: "The implementation returns bool(value) without recognizing explicit token values.",
          citations: [{ path: "src/parser.py", lineStart: 1, lineEnd: 2 }],
        },
        {
          text: "The failing assertion requires parse_enabled of false to be False.",
          citations: [{ path: "checks/test_parser.py", lineStart: 1, lineEnd: 4 }],
        },
        {
          text: "The repository contract says both explicit true and false values should be recognized and records the false case as the current failure.",
          citations: [{ path: "README.md", lineStart: 1, lineEnd: 4 }],
        },
      ],
    },
  },
]);

function fail(message) {
  throw new Error(`Gate 2 explanation cohort: ${message}`);
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

function safeText(value, label) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 8_192 ||
    value !== value.normalize("NFC")
  ) {
    fail(`${label} must be bounded NFC text`);
  }
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
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} must be nonnegative integer`);
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

export function computeGate2ExplanationEvidenceDigest(observationInput) {
  if (
    observationInput === null ||
    typeof observationInput !== "object" ||
    Array.isArray(observationInput)
  ) {
    fail("observation evidence must be an object");
  }
  const { scenarioEvidenceSha256: _evidence, ...unsigned } = observationInput;
  return createHash("sha256").update(stableJson(unsigned)).digest("hex");
}

function validateOutcome(value, oracle, selectedPaths, label) {
  const outcome = exactRecord(value, OUTCOME_KEYS, label);
  safeText(outcome.summary, `${label}.summary`);
  const claims = exactArray(outcome.claims, oracle.response.claims.length, `${label}.claims`);
  const citedPaths = new Set();
  for (const [claimIndex, claimValue] of claims.entries()) {
    const claim = exactRecord(claimValue, CLAIM_KEYS, `${label}.claims[${claimIndex}]`);
    safeText(claim.text, `${label}.claims[${claimIndex}].text`);
    if (
      !Array.isArray(claim.citations) ||
      claim.citations.length < 1 ||
      claim.citations.length > 8
    ) {
      fail(`${label}.claims[${claimIndex}].citations must contain 1..8 entries`);
    }
    const seenRanges = new Set();
    for (const [citationIndex, citationValue] of claim.citations.entries()) {
      const citation = exactRecord(
        citationValue,
        CITATION_KEYS,
        `${label}.claims[${claimIndex}].citations[${citationIndex}]`,
      );
      const citationPath = safePath(
        citation.path,
        `${label}.claims[${claimIndex}].citations[${citationIndex}].path`,
      );
      if (!selectedPaths.has(citationPath)) fail(`${label} cites unselected source`);
      if (
        !Number.isSafeInteger(citation.lineStart) ||
        !Number.isSafeInteger(citation.lineEnd) ||
        citation.lineStart < 1 ||
        citation.lineEnd < citation.lineStart ||
        citation.lineEnd - citation.lineStart >= 16
      ) {
        fail(`${label} has an invalid citation range`);
      }
      const range = `${citationPath}:${citation.lineStart}:${citation.lineEnd}`;
      if (seenRanges.has(range)) fail(`${label} repeats a citation range`);
      seenRanges.add(range);
      citedPaths.add(citationPath);
    }
  }
  if (JSON.stringify(outcome) !== JSON.stringify(oracle.response)) {
    fail(`${label} does not equal its frozen deterministic evaluator oracle`);
  }
  return [...citedPaths].sort((left, right) => left.localeCompare(right));
}

export function validateGate2ExplanationCohortResult(value, manifestInput, manifestSha256) {
  const manifest = validateGate2BenchmarkManifest(manifestInput);
  const result = exactRecord(value, RESULT_KEYS, "result");
  literal(result.schemaVersion, 1, "schemaVersion");
  literal(result.benchmarkId, manifest.benchmarkId, "benchmarkId");
  literal(result.benchmarkRevision, manifest.benchmarkRevision, "benchmarkRevision");
  literal(
    result.manifestSha256,
    digest(manifestSha256, "expected manifest digest"),
    "manifestSha256",
  );
  literal(result.cohortClass, "explanation", "cohortClass");
  literal(result.evaluatorRevision, "deterministic-loopback-v1", "evaluatorRevision");
  if (
    typeof result.generatedAt !== "string" ||
    Number.isNaN(Date.parse(result.generatedAt)) ||
    new Date(result.generatedAt).toISOString() !== result.generatedAt
  ) {
    fail("generatedAt must be a canonical ISO timestamp");
  }
  literal(result.passed, true, "passed");

  const counts = exactRecord(result.counts, COUNT_KEYS, "counts");
  const expectedCounts = [30, 5, 5, 5, 0, 25];
  for (const [index, key] of COUNT_KEYS.entries()) {
    literal(counts[key], expectedCounts[index], `counts.${key}`);
  }
  const effects = exactRecord(result.effects, EFFECT_KEYS, "effects");
  const expectedEffects = [5, 5, 0, 0, 0, 0, 0, true];
  for (const [index, key] of EFFECT_KEYS.entries()) {
    literal(effects[key], expectedEffects[index], `effects.${key}`);
  }
  const effectEvidence = exactRecord(result.effectEvidence, EFFECT_KEYS, "effectEvidence");
  const expectedEffectEvidence = [
    "observed",
    "observed",
    "design-assertion",
    "design-assertion",
    "observed",
    "design-assertion",
    "design-assertion",
    "observed",
  ];
  for (const [index, key] of EFFECT_KEYS.entries()) {
    literal(effectEvidence[key], expectedEffectEvidence[index], `effectEvidence.${key}`);
  }

  const explanationCases = manifest.cases.filter((entry) => entry.class === "explanation");
  if (
    explanationCases.length !== GATE2_EXPLANATION_ORACLES.length ||
    JSON.stringify(explanationCases.map((entry) => entry.id)) !==
      JSON.stringify(GATE2_EXPLANATION_ORACLES.map((entry) => entry.caseId))
  ) {
    fail("manifest explanation cohort does not match the frozen evaluator registry");
  }
  const repositories = new Map(manifest.repositories.map((entry) => [entry.id, entry]));
  const observations = exactArray(
    result.observations,
    GATE2_EXPLANATION_ORACLES.length,
    "observations",
  );
  for (const [index, observationValue] of observations.entries()) {
    const benchmarkCase = explanationCases[index];
    const oracle = GATE2_EXPLANATION_ORACLES[index];
    if (benchmarkCase === undefined || oracle === undefined)
      fail("explanation cohort index missing");
    const repository = repositories.get(benchmarkCase.repositoryId);
    if (repository === undefined) fail(`repository missing for ${benchmarkCase.id}`);
    const observation = exactRecord(observationValue, OBSERVATION_KEYS, `observations[${index}]`);
    literal(observation.caseId, benchmarkCase.id, `observations[${index}].caseId`);
    literal(
      observation.repositoryId,
      benchmarkCase.repositoryId,
      `observations[${index}].repositoryId`,
    );
    literal(
      observation.scenarioEvaluatorId,
      benchmarkCase.expectedOutcome.scenarioEvaluatorId,
      `observations[${index}].scenarioEvaluatorId`,
    );
    literal(
      observation.scenarioEvaluatorId,
      oracle.scenarioEvaluatorId,
      `observations[${index}].oracle evaluator`,
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
    digest(observation.explanationDigestSha256, `observations[${index}].explanationDigestSha256`);

    const provider = exactRecord(
      observation.provider,
      PROVIDER_KEYS,
      `observations[${index}].provider`,
    );
    for (const key of PROVIDER_KEYS) {
      literal(
        provider[key],
        GATE2_EXPLANATION_PROVIDER[key],
        `observations[${index}].provider.${key}`,
      );
    }

    const digestByPath = new Map(repository.files.map((entry) => [entry.path, entry.sha256]));
    if (
      !Array.isArray(observation.selectedContext) ||
      observation.selectedContext.length < benchmarkCase.expectedContextPaths.length ||
      observation.selectedContext.length > MAX_CONTEXT_FILES_PER_CASE
    ) {
      fail(
        `observations[${index}].selectedContext must contain ${benchmarkCase.expectedContextPaths.length}..${MAX_CONTEXT_FILES_PER_CASE} entries`,
      );
    }
    const selected = observation.selectedContext;
    const selectedPaths = new Set();
    for (const [contextIndex, contextValue] of selected.entries()) {
      const context = exactRecord(
        contextValue,
        CONTEXT_KEYS,
        `observations[${index}].selectedContext[${contextIndex}]`,
      );
      const contextPath = safePath(
        context.path,
        `observations[${index}].selectedContext[${contextIndex}].path`,
      );
      if (selectedPaths.has(contextPath)) {
        fail(`observations[${index}].selectedContext repeats ${contextPath}`);
      }
      const expectedDigest = digestByPath.get(contextPath);
      if (expectedDigest === undefined) {
        fail(`observations[${index}].selectedContext includes a file outside the fixture`);
      }
      literal(
        context.sha256,
        expectedDigest,
        `observations[${index}].selectedContext[${contextIndex}].sha256`,
      );
      selectedPaths.add(contextPath);
    }

    const matchedExpectedPaths = benchmarkCase.expectedContextPaths.filter((expectedPath) =>
      selectedPaths.has(expectedPath),
    );
    const expectedRecall = matchedExpectedPaths.length / benchmarkCase.expectedContextPaths.length;
    const expectedPrecision = matchedExpectedPaths.length / selected.length;

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
    if (expectedRecall !== 1 || expectedPrecision < 0.6) {
      fail(`observations[${index}] does not satisfy the explanation retrieval threshold`);
    }
    const citedPaths = validateOutcome(
      observation.outcome,
      oracle,
      selectedPaths,
      `observations[${index}].outcome`,
    );
    literal(
      JSON.stringify(citedPaths),
      JSON.stringify(benchmarkCase.expectedOutcome.expectedCitationPaths),
      `observations[${index}] citation path coverage`,
    );

    const usage = exactRecord(observation.usage, USAGE_KEYS, `observations[${index}].usage`);
    literal(usage.inputTokens, oracle.inputTokens, `observations[${index}].usage.inputTokens`);
    literal(usage.outputTokens, oracle.outputTokens, `observations[${index}].usage.outputTokens`);
    literal(usage.estimatedCostUsd, 0, `observations[${index}].usage.estimatedCostUsd`);
    literal(usage.actualBilledUsd, null, `observations[${index}].usage.actualBilledUsd`);
    nonnegativeInteger(usage.latencyMs, `observations[${index}].usage.latencyMs`);
    literal(
      observation.sourceCheckoutUnchanged,
      true,
      `observations[${index}].sourceCheckoutUnchanged`,
    );
    literal(
      observation.fixtureWorkspaceUnchanged,
      true,
      `observations[${index}].fixtureWorkspaceUnchanged`,
    );
    literal(
      observation.scenarioEvidenceSha256,
      computeGate2ExplanationEvidenceDigest(observation),
      `observations[${index}].scenarioEvidenceSha256`,
    );
  }

  literal(
    JSON.stringify(result.limitations),
    JSON.stringify(GATE2_EXPLANATION_COHORT_LIMITATIONS),
    "limitations",
  );
  literal(
    result.assessment,
    "deterministic_explanation_cohort_passed_gate2_incomplete",
    "assessment",
  );
  return value;
}

export function parseAndValidateGate2ExplanationCohortResult(source, manifest, manifestSha256) {
  return validateGate2ExplanationCohortResult(
    parseStrictGate2Json(source),
    manifest,
    manifestSha256,
  );
}
