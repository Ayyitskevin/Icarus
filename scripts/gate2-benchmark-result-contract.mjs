import {
  parseStrictGate2Json,
  sha256Raw,
  validateGate2BenchmarkManifest,
} from "./gate2-benchmark-contract.mjs";

const RESULT_KEYS = Object.freeze([
  "schemaVersion",
  "benchmarkId",
  "benchmarkRevision",
  "manifestSha256",
  "mode",
  "executionProfile",
  "observations",
  "aggregates",
  "limitations",
]);
const PROFILE_KEYS = Object.freeze([
  "profileId",
  "profileDigestSha256",
  "provider",
  "adapterVersion",
  "models",
  "pricing",
  "budgets",
]);
const PRICING_KEYS = Object.freeze([
  "capturedAt",
  "currency",
  "inputUsdPerMillion",
  "outputUsdPerMillion",
  "sourceLabel",
  "estimatedOnly",
]);
const BUDGET_KEYS = Object.freeze([
  "maxRuntimeSeconds",
  "maxInputTokens",
  "maxOutputTokens",
  "maxEstimatedCostUsd",
]);
const OBSERVATION_KEYS = Object.freeze([
  "caseId",
  "repositoryRevisionSha256",
  "taskSha256",
  "retrievedContext",
  "firstPassPlanAccepted",
  "changedPaths",
  "citations",
  "findingIds",
  "scenarioStatus",
  "usage",
]);
const RETRIEVED_CONTEXT_KEYS = Object.freeze(["path", "sha256"]);
const USAGE_KEYS = Object.freeze([
  "inputTokens",
  "outputTokens",
  "estimatedCostUsd",
  "actualBilledUsd",
  "latencyMs",
]);
const AGGREGATE_KEYS = Object.freeze([
  "taskCount",
  "measuredTaskCount",
  "successCount",
  "classSuccessCounts",
  "macroRetrievalRecall",
  "macroRetrievalPrecision",
  "digestProvenanceCoverage",
  "firstPassPlanAcceptance",
  "incorrectEdits",
  "medianEstimatedCostPerSuccess",
  "thresholdsPassed",
  "assessment",
]);
const CLASS_COUNT_KEYS = Object.freeze([
  "repair",
  "refactor",
  "explanation",
  "security_review",
  "scaffold",
]);

export const GATE2_RESULT_LIMITATIONS = Object.freeze([
  "single-run-result-does-not-prove-routing-improvement",
]);

function fail(message) {
  throw new Error(`Gate 2 benchmark result: ${message}`);
}

function assertPlainRecord(value, label, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  if (JSON.stringify(Object.keys(value)) !== JSON.stringify(keys)) {
    fail(`${label} must contain exactly: ${keys.join(", ")}`);
  }
  return value;
}

function assertArray(value, label, length) {
  if (!Array.isArray(value) || (length !== undefined && value.length !== length)) {
    fail(`${label} must be an array${length === undefined ? "" : ` with ${length} entries`}`);
  }
  return value;
}

function assertLiteral(value, expected, label) {
  if (value !== expected) fail(`${label} must equal ${JSON.stringify(expected)}`);
  return value;
}

function assertDigest(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    fail(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function assertSafeToken(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value)) {
    fail(`${label} must be a bounded safe token`);
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

function assertSortedUniqueStrings(value, label, validate) {
  const entries = assertArray(value, label).map((entry, index) =>
    validate(entry, `${label}[${index}]`),
  );
  const sorted = [...entries].sort((left, right) => left.localeCompare(right));
  if (
    new Set(entries).size !== entries.length ||
    JSON.stringify(entries) !== JSON.stringify(sorted)
  ) {
    fail(`${label} must be sorted and unique`);
  }
  return entries;
}

function assertNonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} must be a nonnegative integer`);
  return value;
}

function assertFiniteNonnegative(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    fail(`${label} must be a finite nonnegative number`);
  }
  return value;
}

function rounded(value) {
  return Number(value.toFixed(12));
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : rounded((sorted[middle - 1] + sorted[middle]) / 2);
}

function canonicalProfileDigest(profile) {
  const unsigned = {
    profileId: profile.profileId,
    provider: profile.provider,
    adapterVersion: profile.adapterVersion,
    models: profile.models,
    pricing: profile.pricing,
    budgets: profile.budgets,
  };
  return sha256Raw(JSON.stringify(unsigned));
}

export function computeGate2ExecutionProfileDigest(profile) {
  return canonicalProfileDigest(profile);
}

function validateProfile(value) {
  const profile = assertPlainRecord(value, "executionProfile", PROFILE_KEYS);
  assertSafeToken(profile.profileId, "executionProfile.profileId");
  assertDigest(profile.profileDigestSha256, "executionProfile.profileDigestSha256");
  assertSafeToken(profile.provider, "executionProfile.provider");
  assertSafeToken(profile.adapterVersion, "executionProfile.adapterVersion");
  const models = assertSortedUniqueStrings(
    profile.models,
    "executionProfile.models",
    assertSafeToken,
  );
  if (models.length === 0 || models.length > 8)
    fail("executionProfile.models must contain 1..8 entries");

  const pricing = assertPlainRecord(profile.pricing, "executionProfile.pricing", PRICING_KEYS);
  if (typeof pricing.capturedAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(pricing.capturedAt)) {
    fail("executionProfile.pricing.capturedAt must be an ISO date");
  }
  assertLiteral(pricing.currency, "USD", "executionProfile.pricing.currency");
  const inputRate = assertFiniteNonnegative(
    pricing.inputUsdPerMillion,
    "executionProfile.pricing.inputUsdPerMillion",
  );
  const outputRate = assertFiniteNonnegative(
    pricing.outputUsdPerMillion,
    "executionProfile.pricing.outputUsdPerMillion",
  );
  if (inputRate === 0 && outputRate === 0) {
    fail("executionProfile pricing must make the cost-reduction gate measurable");
  }
  assertSafeToken(pricing.sourceLabel, "executionProfile.pricing.sourceLabel");
  assertLiteral(pricing.estimatedOnly, true, "executionProfile.pricing.estimatedOnly");

  const budgets = assertPlainRecord(profile.budgets, "executionProfile.budgets", BUDGET_KEYS);
  for (const key of ["maxRuntimeSeconds", "maxInputTokens", "maxOutputTokens"]) {
    if (!Number.isSafeInteger(budgets[key]) || budgets[key] < 1) {
      fail(`executionProfile.budgets.${key} must be a positive integer`);
    }
  }
  if (
    typeof budgets.maxEstimatedCostUsd !== "number" ||
    !Number.isFinite(budgets.maxEstimatedCostUsd) ||
    budgets.maxEstimatedCostUsd <= 0
  ) {
    fail("executionProfile.budgets.maxEstimatedCostUsd must be positive");
  }
  assertLiteral(
    profile.profileDigestSha256,
    canonicalProfileDigest(profile),
    "executionProfile.profileDigestSha256",
  );
  return profile;
}

function validateRetrievedContext(value, benchmarkCase, repository, label) {
  const entries = assertArray(value, label).map((entry, index) => {
    const entryLabel = `${label}[${index}]`;
    const context = assertPlainRecord(entry, entryLabel, RETRIEVED_CONTEXT_KEYS);
    return {
      path: assertSafePath(context.path, `${entryLabel}.path`),
      sha256: assertDigest(context.sha256, `${entryLabel}.sha256`),
    };
  });
  const paths = entries.map((entry) => entry.path);
  const sorted = [...paths].sort((left, right) => left.localeCompare(right));
  if (new Set(paths).size !== paths.length || JSON.stringify(paths) !== JSON.stringify(sorted)) {
    fail(`${label} must be sorted by unique path`);
  }
  const repositoryFiles = new Map(repository.files.map((file) => [file.path, file.sha256]));
  for (const entry of entries) {
    if (repositoryFiles.get(entry.path) !== entry.sha256) {
      fail(`${label} must carry exact manifest-backed digest provenance`);
    }
  }
  const expected = new Set(benchmarkCase.expectedContextPaths);
  const relevant = entries.filter((entry) => expected.has(entry.path)).length;
  return {
    recall: relevant / expected.size,
    precision: entries.length === 0 ? 0 : relevant / entries.length,
    provenanceCount: entries.length,
    retrievedCount: entries.length,
  };
}

function validateUsage(value, profile, label) {
  const usage = assertPlainRecord(value, label, USAGE_KEYS);
  const inputTokens = assertNonnegativeInteger(usage.inputTokens, `${label}.inputTokens`);
  const outputTokens = assertNonnegativeInteger(usage.outputTokens, `${label}.outputTokens`);
  const estimatedCost = assertFiniteNonnegative(
    usage.estimatedCostUsd,
    `${label}.estimatedCostUsd`,
  );
  assertLiteral(usage.actualBilledUsd, null, `${label}.actualBilledUsd`);
  const latency = assertNonnegativeInteger(usage.latencyMs, `${label}.latencyMs`);
  const expectedCost = rounded(
    (inputTokens * profile.pricing.inputUsdPerMillion +
      outputTokens * profile.pricing.outputUsdPerMillion) /
      1_000_000,
  );
  assertLiteral(estimatedCost, expectedCost, `${label}.estimatedCostUsd`);
  if (inputTokens > profile.budgets.maxInputTokens) fail(`${label} exceeds input-token budget`);
  if (outputTokens > profile.budgets.maxOutputTokens) fail(`${label} exceeds output-token budget`);
  if (estimatedCost > profile.budgets.maxEstimatedCostUsd) fail(`${label} exceeds cost budget`);
  if (latency > profile.budgets.maxRuntimeSeconds * 1_000) fail(`${label} exceeds runtime budget`);
  return usage;
}

function validateObservation(value, index, manifest, profile, repositoriesById) {
  const label = `observations[${index}]`;
  const observation = assertPlainRecord(value, label, OBSERVATION_KEYS);
  const benchmarkCase = manifest.cases[index];
  const repository = repositoriesById.get(benchmarkCase.repositoryId);
  assertLiteral(observation.caseId, benchmarkCase.id, `${label}.caseId`);
  assertLiteral(
    observation.repositoryRevisionSha256,
    repository.revisionSha256,
    `${label}.repositoryRevisionSha256`,
  );
  assertLiteral(observation.taskSha256, benchmarkCase.task.sha256, `${label}.taskSha256`);
  const retrieval = validateRetrievedContext(
    observation.retrievedContext,
    benchmarkCase,
    repository,
    `${label}.retrievedContext`,
  );
  if (typeof observation.firstPassPlanAccepted !== "boolean") {
    fail(`${label}.firstPassPlanAccepted must be boolean`);
  }
  const changedPaths = assertSortedUniqueStrings(
    observation.changedPaths,
    `${label}.changedPaths`,
    assertSafePath,
  );
  const citations = assertSortedUniqueStrings(
    observation.citations,
    `${label}.citations`,
    assertSafePath,
  );
  const findingIds = assertSortedUniqueStrings(
    observation.findingIds,
    `${label}.findingIds`,
    assertSafeToken,
  );
  if (!["passed", "failed", "unsupported"].includes(observation.scenarioStatus)) {
    fail(`${label}.scenarioStatus is invalid`);
  }
  const usage = validateUsage(observation.usage, profile, `${label}.usage`);

  const expectedChanged = benchmarkCase.expectedOutcome.expectedChangedPaths;
  const incorrectEdits = changedPaths.filter(
    (candidate) => !expectedChanged.includes(candidate),
  ).length;
  const exactChanged = JSON.stringify(changedPaths) === JSON.stringify(expectedChanged);
  const exactCitations =
    JSON.stringify(citations) ===
    JSON.stringify(benchmarkCase.expectedOutcome.expectedCitationPaths);
  const exactFindings =
    JSON.stringify(findingIds) === JSON.stringify(benchmarkCase.expectedOutcome.expectedFindingIds);
  const evidenceMatches =
    benchmarkCase.expectedOutcome.kind === "mutation"
      ? exactChanged && citations.length === 0 && findingIds.length === 0
      : changedPaths.length === 0 && exactCitations && exactFindings;
  const success =
    observation.scenarioStatus === "passed" && evidenceMatches && incorrectEdits === 0;

  return {
    success,
    measured: observation.scenarioStatus !== "unsupported",
    benchmarkClass: benchmarkCase.class,
    recall: retrieval.recall,
    precision: retrieval.precision,
    provenanceCount: retrieval.provenanceCount,
    retrievedCount: retrieval.retrievedCount,
    firstPassPlanAccepted: observation.firstPassPlanAccepted,
    incorrectEdits,
    estimatedCostUsd: usage.estimatedCostUsd,
  };
}

function expectedAggregates(observations, manifest) {
  const measuredTaskCount = observations.filter((entry) => entry.measured).length;
  const successful = observations.filter((entry) => entry.success);
  const classSuccessCounts = Object.fromEntries(
    CLASS_COUNT_KEYS.map((benchmarkClass) => [
      benchmarkClass,
      successful.filter((entry) => entry.benchmarkClass === benchmarkClass).length,
    ]),
  );
  const macroRecall = rounded(
    observations.reduce((sum, entry) => sum + entry.recall, 0) / observations.length,
  );
  const macroPrecision = rounded(
    observations.reduce((sum, entry) => sum + entry.precision, 0) / observations.length,
  );
  const retrievedCount = observations.reduce((sum, entry) => sum + entry.retrievedCount, 0);
  const provenanceCount = observations.reduce((sum, entry) => sum + entry.provenanceCount, 0);
  const provenanceCoverage = retrievedCount === 0 ? 0 : provenanceCount / retrievedCount;
  const planAcceptance = rounded(
    observations.filter((entry) => entry.firstPassPlanAccepted).length / observations.length,
  );
  const incorrectEdits = observations.reduce((sum, entry) => sum + entry.incorrectEdits, 0);
  const medianCost = median(successful.map((entry) => entry.estimatedCostUsd));
  const thresholds = manifest.thresholds;
  const thresholdsPassed =
    measuredTaskCount === thresholds.taskCount &&
    successful.length >= thresholds.minimumSuccessfulTasks &&
    macroRecall >= thresholds.minimumMacroRetrievalRecall &&
    macroPrecision >= thresholds.minimumMacroRetrievalPrecision &&
    provenanceCoverage >= thresholds.minimumDigestProvenanceCoverage &&
    planAcceptance >= thresholds.minimumFirstPassPlanAcceptance &&
    incorrectEdits <= thresholds.maximumIncorrectEditsPerSuccess * successful.length;
  return {
    taskCount: observations.length,
    measuredTaskCount,
    successCount: successful.length,
    classSuccessCounts,
    macroRetrievalRecall: macroRecall,
    macroRetrievalPrecision: macroPrecision,
    digestProvenanceCoverage: rounded(provenanceCoverage),
    firstPassPlanAcceptance: planAcceptance,
    incorrectEdits,
    medianEstimatedCostPerSuccess: medianCost,
    thresholdsPassed,
    assessment:
      measuredTaskCount !== observations.length
        ? "incomplete"
        : thresholdsPassed
          ? "thresholds_passed_pair_comparison_required"
          : "thresholds_failed",
  };
}

export function computeGate2BenchmarkAggregates(observationInputs, manifestInput, profileInput) {
  const manifest = validateGate2BenchmarkManifest(manifestInput);
  const profile = validateProfile(profileInput);
  const repositoriesById = new Map(
    manifest.repositories.map((repository) => [repository.id, repository]),
  );
  const observations = assertArray(observationInputs, "observations", 30).map((entry, index) =>
    validateObservation(entry, index, manifest, profile, repositoriesById),
  );
  return expectedAggregates(observations, manifest);
}

function validateAggregates(value, expected) {
  const aggregate = assertPlainRecord(value, "aggregates", AGGREGATE_KEYS);
  for (const key of AGGREGATE_KEYS) {
    if (key === "classSuccessCounts") continue;
    assertLiteral(aggregate[key], expected[key], `aggregates.${key}`);
  }
  const counts = assertPlainRecord(
    aggregate.classSuccessCounts,
    "aggregates.classSuccessCounts",
    CLASS_COUNT_KEYS,
  );
  for (const key of CLASS_COUNT_KEYS) {
    assertLiteral(
      counts[key],
      expected.classSuccessCounts[key],
      `aggregates.classSuccessCounts.${key}`,
    );
  }
}

/**
 * Validate one baseline or routed result and recompute every aggregate from
 * manifest-bound observations. A single result cannot prove routing lift.
 */
export function validateGate2BenchmarkResult(value, manifestInput, manifestSha256) {
  const manifest = validateGate2BenchmarkManifest(manifestInput);
  const result = assertPlainRecord(value, "root", RESULT_KEYS);
  assertLiteral(result.schemaVersion, 1, "schemaVersion");
  assertLiteral(result.benchmarkId, manifest.benchmarkId, "benchmarkId");
  assertLiteral(result.benchmarkRevision, manifest.benchmarkRevision, "benchmarkRevision");
  assertLiteral(
    result.manifestSha256,
    assertDigest(manifestSha256, "expected manifest digest"),
    "manifestSha256",
  );
  if (!["baseline", "routed"].includes(result.mode)) fail("mode must be baseline or routed");
  const profile = validateProfile(result.executionProfile);
  const repositoriesById = new Map(
    manifest.repositories.map((repository) => [repository.id, repository]),
  );
  const observations = assertArray(result.observations, "observations", 30).map((entry, index) =>
    validateObservation(entry, index, manifest, profile, repositoriesById),
  );
  validateAggregates(result.aggregates, expectedAggregates(observations, manifest));
  assertLiteral(
    JSON.stringify(result.limitations),
    JSON.stringify(GATE2_RESULT_LIMITATIONS),
    "limitations",
  );
  return result;
}

export function parseAndValidateGate2BenchmarkResult(source, manifest, manifestSha256) {
  return validateGate2BenchmarkResult(parseStrictGate2Json(source), manifest, manifestSha256);
}

/**
 * Compare exact validated paired runs. This is the only result-layer operation
 * that can establish the routing cost/success gate.
 */
export function compareGate2BenchmarkResults(
  baselineInput,
  routedInput,
  manifestInput,
  manifestSha256,
) {
  const manifest = validateGate2BenchmarkManifest(manifestInput);
  const baseline = validateGate2BenchmarkResult(baselineInput, manifest, manifestSha256);
  const routed = validateGate2BenchmarkResult(routedInput, manifest, manifestSha256);
  assertLiteral(baseline.mode, "baseline", "baseline.mode");
  assertLiteral(routed.mode, "routed", "routed.mode");
  assertLiteral(
    routed.executionProfile.profileDigestSha256,
    baseline.executionProfile.profileDigestSha256,
    "paired execution profile digest",
  );
  if (
    baseline.aggregates.medianEstimatedCostPerSuccess === null ||
    routed.aggregates.medianEstimatedCostPerSuccess === null ||
    baseline.aggregates.medianEstimatedCostPerSuccess <= 0
  ) {
    fail("paired comparison requires a positive baseline median cost per success");
  }
  const successCountRatio = routed.aggregates.successCount / baseline.aggregates.successCount;
  const costReduction = rounded(
    1 -
      routed.aggregates.medianEstimatedCostPerSuccess /
        baseline.aggregates.medianEstimatedCostPerSuccess,
  );
  const passed =
    baseline.aggregates.thresholdsPassed &&
    routed.aggregates.thresholdsPassed &&
    successCountRatio >= manifest.thresholds.minimumRoutedSuccessCountRatio &&
    costReduction >= manifest.thresholds.minimumRoutedCostReduction;
  return {
    schemaVersion: 1,
    benchmarkId: manifest.benchmarkId,
    manifestSha256,
    executionProfileDigestSha256: baseline.executionProfile.profileDigestSha256,
    baselineSuccessCount: baseline.aggregates.successCount,
    routedSuccessCount: routed.aggregates.successCount,
    successCountRatio: rounded(successCountRatio),
    baselineMedianEstimatedCostPerSuccess: baseline.aggregates.medianEstimatedCostPerSuccess,
    routedMedianEstimatedCostPerSuccess: routed.aggregates.medianEstimatedCostPerSuccess,
    costReduction,
    passed,
    assessment: passed ? "gate2-routing-comparison-passed" : "gate2-routing-comparison-failed",
  };
}
