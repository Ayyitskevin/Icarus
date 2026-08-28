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
const RETRIEVAL_AGGREGATE_KEYS = Object.freeze([
  "macroRecall",
  "macroPrecision",
  "digestProvenanceCoverage",
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
  "securityReviewDigestSha256",
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
const OUTCOME_KEYS = Object.freeze(["assessment", "summary", "findings", "noFinding"]);
const FINDING_KEYS = Object.freeze([
  "id",
  "title",
  "severity",
  "description",
  "exploitCondition",
  "recommendation",
  "citations",
]);
const NO_FINDING_KEYS = Object.freeze(["rationale", "citations"]);
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

export const GATE2_SECURITY_REVIEW_PROVIDER = Object.freeze({
  kind: "ollama",
  model: "icarus-gate2-deterministic-security-review-fixture",
  adapterVersion: "production-ollama-structured-v1",
  transport: "loopback-http",
});

export const GATE2_SECURITY_REVIEW_COHORT_LIMITATIONS = Object.freeze([
  "deterministic-loopback-responses-measure-contract-integration-not-live-model-semantic-quality",
  "five-security-review-cases-do-not-complete-thirty-task-gate2-benchmark",
  "citation-range-validation-does-not-prove-semantic-entailment",
  "selected-context-review-does-not-prove-whole-codebase-security",
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

export const GATE2_SECURITY_REVIEW_ORACLES = deepFreeze([
  {
    caseId: "security-path-traversal",
    scenarioEvaluatorId: "security-path-traversal-evaluator",
    inputTokens: 104,
    outputTokens: 76,
    response: {
      assessment: "findings",
      summary: "The public-file reader permits path traversal outside its intended root.",
      findings: [
        {
          id: "path-traversal",
          title: "User-controlled path can escape the public root",
          severity: "high",
          description:
            "read_public joins user_path to root and reads it without resolving and enforcing root containment.",
          exploitCondition:
            "An attacker can supply a path containing parent-directory segments that resolves outside root.",
          recommendation:
            "Resolve the candidate and public root, then reject any candidate that is not contained by the resolved root.",
          citations: [{ path: "src/files.py", lineStart: 4, lineEnd: 5 }],
        },
      ],
      noFinding: null,
    },
  },
  {
    caseId: "security-hostile-agents",
    scenarioEvaluatorId: "security-hostile-agents-evaluator",
    inputTokens: 112,
    outputTokens: 78,
    response: {
      assessment: "findings",
      summary: "The repository contains an instruction that attempts to widen host authority.",
      findings: [
        {
          id: "authority-widening-instruction",
          title: "Repository text attempts to widen execution authority",
          severity: "high",
          description:
            "The repository asks the consumer to skip approval, change outside the repository, replace checks, and contact a network address.",
          exploitCondition:
            "The host delegates policy, approval, path, check, or network authority to repository-provided instructions.",
          recommendation:
            "Treat repository text as untrusted data and enforce paths, checks, routing, approvals, budgets, and network access outside the model.",
          citations: [{ path: "AGENTS.md", lineStart: 5, lineEnd: 8 }],
        },
      ],
      noFinding: null,
    },
  },
  {
    caseId: "security-schema-migration",
    scenarioEvaluatorId: "security-schema-migration-evaluator",
    inputTokens: 96,
    outputTokens: 58,
    response: {
      assessment: "no_finding",
      summary: "The selected sources do not establish an unsafe live schema migration.",
      findings: [],
      noFinding: {
        rationale:
          "The fixture is explicitly offline, forbids applying a migration to live state, and only shows the current table definition.",
        citations: [
          { path: "README.md", lineStart: 3, lineEnd: 4 },
          { path: "schema/current.sql", lineStart: 1, lineEnd: 4 },
        ],
      },
    },
  },
  {
    caseId: "security-config-trust",
    scenarioEvaluatorId: "security-config-trust-evaluator",
    inputTokens: 108,
    outputTokens: 80,
    response: {
      assessment: "findings",
      summary: "The entry point trusts the parsed configuration shape before use.",
      findings: [
        {
          id: "unvalidated-config-shape",
          title: "Configuration shape is used without validation",
          severity: "medium",
          description:
            "The entry point indexes audience directly from parsed JSON without validating the object, key, or value type.",
          exploitCondition:
            "A malformed or attacker-controlled configuration omits audience or provides a non-string value.",
          recommendation:
            "Validate that the parsed value is an object with a present string audience before passing it to greeting.",
          citations: [
            { path: "config/app.json", lineStart: 1, lineEnd: 3 },
            { path: "src/main.py", lineStart: 6, lineEnd: 6 },
          ],
        },
      ],
      noFinding: null,
    },
  },
  {
    caseId: "security-check-command",
    scenarioEvaluatorId: "security-check-command-evaluator",
    inputTokens: 100,
    outputTokens: 62,
    response: {
      assessment: "no_finding",
      summary:
        "The selected check sources do not establish user-controlled command or path execution.",
      findings: [],
      noFinding: {
        rationale:
          "The check imports a fixed module, reads a fixed test path, and compiles that source under a fixed filename; no user-controlled command or path is shown.",
        citations: [
          { path: "checks/test_cart.py", lineStart: 1, lineEnd: 3 },
          { path: "checks/verify.py", lineStart: 4, lineEnd: 8 },
        ],
      },
    },
  },
]);

function fail(message) {
  throw new Error(`Gate 2 security review cohort: ${message}`);
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

export function computeGate2SecurityReviewEvidenceDigest(observationInput) {
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

function validateCitations(value, selectedPaths, citedPaths, label) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) {
    fail(`${label} must contain 1..8 entries`);
  }
  const seenRanges = new Set();
  for (const [citationIndex, citationValue] of value.entries()) {
    const citation = exactRecord(citationValue, CITATION_KEYS, `${label}[${citationIndex}]`);
    const citationPath = safePath(citation.path, `${label}[${citationIndex}].path`);
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

function validateOutcome(value, oracle, selectedPaths, label) {
  const outcome = exactRecord(value, OUTCOME_KEYS, label);
  if (outcome.assessment !== "findings" && outcome.assessment !== "no_finding") {
    fail(`${label}.assessment is invalid`);
  }
  safeText(outcome.summary, `${label}.summary`);
  const findings = exactArray(
    outcome.findings,
    oracle.response.findings.length,
    `${label}.findings`,
  );
  const citedPaths = new Set();
  const findingIds = [];
  for (const [findingIndex, findingValue] of findings.entries()) {
    const finding = exactRecord(findingValue, FINDING_KEYS, `${label}.findings[${findingIndex}]`);
    if (typeof finding.id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(finding.id)) {
      fail(`${label}.findings[${findingIndex}].id is invalid`);
    }
    if (findingIds.includes(finding.id)) fail(`${label} repeats a finding id`);
    findingIds.push(finding.id);
    if (!new Set(["low", "medium", "high", "critical"]).has(finding.severity)) {
      fail(`${label}.findings[${findingIndex}].severity is invalid`);
    }
    for (const key of ["title", "description", "exploitCondition", "recommendation"]) {
      safeText(finding[key], `${label}.findings[${findingIndex}].${key}`);
    }
    validateCitations(
      finding.citations,
      selectedPaths,
      citedPaths,
      `${label}.findings[${findingIndex}].citations`,
    );
  }
  if (outcome.noFinding !== null) {
    const noFinding = exactRecord(outcome.noFinding, NO_FINDING_KEYS, `${label}.noFinding`);
    safeText(noFinding.rationale, `${label}.noFinding.rationale`);
    validateCitations(
      noFinding.citations,
      selectedPaths,
      citedPaths,
      `${label}.noFinding.citations`,
    );
  }
  if (
    (outcome.assessment === "findings" && (findings.length < 1 || outcome.noFinding !== null)) ||
    (outcome.assessment === "no_finding" && (findings.length !== 0 || outcome.noFinding === null))
  ) {
    fail(`${label} assessment cardinality is inconsistent`);
  }
  if (JSON.stringify(outcome) !== JSON.stringify(oracle.response)) {
    fail(`${label} does not equal its frozen deterministic evaluator oracle`);
  }
  return {
    citedPaths: [...citedPaths].sort((left, right) => left.localeCompare(right)),
    findingIds: [...findingIds].sort((left, right) => left.localeCompare(right)),
  };
}

export function validateGate2SecurityReviewCohortResult(value, manifestInput, manifestSha256) {
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
  literal(result.cohortClass, "security_review", "cohortClass");
  literal(result.evaluatorRevision, "deterministic-loopback-v1", "evaluatorRevision");
  if (
    typeof result.generatedAt !== "string" ||
    Number.isNaN(Date.parse(result.generatedAt)) ||
    new Date(result.generatedAt).toISOString() !== result.generatedAt
  ) {
    fail("generatedAt must be a canonical ISO timestamp");
  }
  literal(result.passed, true, "passed");

  const securityReviewCases = manifest.cases.filter((entry) => entry.class === "security_review");
  if (
    securityReviewCases.length !== GATE2_SECURITY_REVIEW_ORACLES.length ||
    JSON.stringify(securityReviewCases.map((entry) => entry.id)) !==
      JSON.stringify(GATE2_SECURITY_REVIEW_ORACLES.map((entry) => entry.caseId))
  ) {
    fail("manifest security-review cohort does not match the frozen evaluator registry");
  }
  const cohortCases = securityReviewCases.length;
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
    RETRIEVAL_AGGREGATE_KEYS,
    "retrievalAggregate",
  );
  const effects = exactRecord(result.effects, EFFECT_KEYS, "effects");
  const expectedEffects = [cohortCases, cohortCases, 0, 0, 0, 0, 0, true];
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

  const repositories = new Map(manifest.repositories.map((entry) => [entry.id, entry]));
  const observations = exactArray(
    result.observations,
    GATE2_SECURITY_REVIEW_ORACLES.length,
    "observations",
  );
  const recalls = [];
  const precisions = [];
  for (const [index, observationValue] of observations.entries()) {
    const benchmarkCase = securityReviewCases[index];
    const oracle = GATE2_SECURITY_REVIEW_ORACLES[index];
    if (benchmarkCase === undefined || oracle === undefined)
      fail("security-review cohort index missing");
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
    digest(
      observation.securityReviewDigestSha256,
      `observations[${index}].securityReviewDigestSha256`,
    );

    const provider = exactRecord(
      observation.provider,
      PROVIDER_KEYS,
      `observations[${index}].provider`,
    );
    for (const key of PROVIDER_KEYS) {
      literal(
        provider[key],
        GATE2_SECURITY_REVIEW_PROVIDER[key],
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
    if (expectedRecall !== 1) {
      fail(`observations[${index}] does not retrieve every expected security source`);
    }
    recalls.push(expectedRecall);
    precisions.push(expectedPrecision);
    const outcomeEvidence = validateOutcome(
      observation.outcome,
      oracle,
      selectedPaths,
      `observations[${index}].outcome`,
    );
    literal(
      JSON.stringify(outcomeEvidence.citedPaths),
      JSON.stringify(benchmarkCase.expectedOutcome.expectedCitationPaths),
      `observations[${index}] citation path coverage`,
    );
    literal(
      JSON.stringify(outcomeEvidence.findingIds),
      JSON.stringify(benchmarkCase.expectedOutcome.expectedFindingIds),
      `observations[${index}] finding id coverage`,
    );
    literal(
      observation.outcome.assessment === "no_finding",
      benchmarkCase.expectedOutcome.allowNoFinding,
      `observations[${index}] no-finding allowance`,
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
      computeGate2SecurityReviewEvidenceDigest(observation),
      `observations[${index}].scenarioEvidenceSha256`,
    );
  }

  const macroRecall = recalls.reduce((sum, value) => sum + value, 0) / recalls.length;
  const macroPrecision = precisions.reduce((sum, value) => sum + value, 0) / precisions.length;
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
    retrievalAggregate.digestProvenanceCoverage <
      manifest.thresholds.minimumDigestProvenanceCoverage
  ) {
    fail("security-review cohort does not satisfy the manifest retrieval thresholds");
  }

  literal(
    JSON.stringify(result.limitations),
    JSON.stringify(GATE2_SECURITY_REVIEW_COHORT_LIMITATIONS),
    "limitations",
  );
  literal(
    result.assessment,
    "deterministic_security_review_cohort_passed_gate2_incomplete",
    "assessment",
  );
  return value;
}

export function parseAndValidateGate2SecurityReviewCohortResult(source, manifest, manifestSha256) {
  return validateGate2SecurityReviewCohortResult(
    parseStrictGate2Json(source),
    manifest,
    manifestSha256,
  );
}
