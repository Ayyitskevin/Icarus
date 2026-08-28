import {
  GATE2_V1_MANIFEST_SHA256,
  parseStrictGate2Json,
  sha256Raw,
  validateGate2BenchmarkManifest,
  validateGate2BenchmarkSuccessor,
} from "./gate2-benchmark-contract.mjs";
import { parseAndValidateGate2ExplanationCohortResult } from "./gate2-explanation-cohort-contract.mjs";
import { parseAndValidateGate2RefactorCohortResult } from "./gate2-refactor-cohort-contract.mjs";
import { parseAndValidateGate2RepairACohortResult } from "./gate2-repair-cohort-a-contract.mjs";
import { parseAndValidateGate2RepairBCohortResult } from "./gate2-repair-cohort-b-contract.mjs";
import { parseAndValidateGate2ScaffoldACohortResult } from "./gate2-scaffold-cohort-a-contract.mjs";
import { parseAndValidateGate2SchemaSuccessorCohortResult } from "./gate2-schema-successor-cohort-contract.mjs";
import { parseAndValidateGate2SecurityReviewCohortResult } from "./gate2-security-review-cohort-contract.mjs";

const GATE2_V2_MANIFEST_SHA256 = "0eca6348be7848bac44922bcf426defdbd581af8ef790515e28c231b5fbc69c5";
const PREDECESSOR_REVISION = "gate2-thirty-task-v1";
const SUCCESSOR_REVISION = "gate2-thirty-task-v2-host-policy-compatible";
const ADOPTION_POLICY_REVISION = "gate2-v2-exact-unchanged-evidence-adoption-v1";
const HEX_64 = /^[0-9a-f]{64}$/;

const SOURCE_REPORT_SPECIFICATIONS = Object.freeze([
  Object.freeze({
    path: "fixtures/evals/gate2/evidence/v1/explanation-cohort-report.json",
    sha256: "d8c0355d8d654f532c99e53577c390534f4e14d922676d9c978fcc56ffcf9895",
    benchmarkRevision: PREDECESSOR_REVISION,
    parse: parseAndValidateGate2ExplanationCohortResult,
  }),
  Object.freeze({
    path: "fixtures/evals/gate2/evidence/v1/security-review-cohort-report.json",
    sha256: "d24d64dbfb3cee8819de8d79055df017cea0753813a818e78539d8f83e2dc88c",
    benchmarkRevision: PREDECESSOR_REVISION,
    parse: parseAndValidateGate2SecurityReviewCohortResult,
  }),
  Object.freeze({
    path: "fixtures/evals/gate2/evidence/v1/refactor-cohort-report.json",
    sha256: "7069f8bcac907ad7b18600e301191620478d6be921f8d4f05ae1df340a80df57",
    benchmarkRevision: PREDECESSOR_REVISION,
    parse: parseAndValidateGate2RefactorCohortResult,
  }),
  Object.freeze({
    path: "fixtures/evals/gate2/evidence/v1/repair-cohort-a-report.json",
    sha256: "261562d0520fe2ed3bc506b7b7d19f786d08f53eed4994d8d67b2d5540ae5cdc",
    benchmarkRevision: PREDECESSOR_REVISION,
    parse: parseAndValidateGate2RepairACohortResult,
  }),
  Object.freeze({
    path: "fixtures/evals/gate2/evidence/v1/repair-cohort-b-report.json",
    sha256: "ca4af9c4410f5c2c1bd27f26d9581fbe393ba810f34bcc3493659caca29d8d36",
    benchmarkRevision: PREDECESSOR_REVISION,
    parse: parseAndValidateGate2RepairBCohortResult,
  }),
  Object.freeze({
    path: "fixtures/evals/gate2/evidence/v1/scaffold-cohort-a-report.json",
    sha256: "e38f1d4febba2a703c90959522d9aaa7805010f49a4d34ad8847a4a5e706ba01",
    benchmarkRevision: PREDECESSOR_REVISION,
    parse: parseAndValidateGate2ScaffoldACohortResult,
  }),
  Object.freeze({
    path: "fixtures/evals/gate2/evidence/v2/schema-successor-cohort-report.json",
    sha256: "6f894f1ea65223076cac4e2bbdec53231bc4b1e3ca522b74cace694afa9b3ff4",
    benchmarkRevision: SUCCESSOR_REVISION,
    parse: parseAndValidateGate2SchemaSuccessorCohortResult,
  }),
]);

export const GATE2_V2_EVIDENCE_SOURCE_REPORTS = Object.freeze(
  SOURCE_REPORT_SPECIFICATIONS.map(({ path, sha256, benchmarkRevision }) =>
    Object.freeze({ path, sha256, benchmarkRevision }),
  ),
);

export const GATE2_V2_EVIDENCE_ADOPTION_LIMITATIONS = Object.freeze([
  "adopted-predecessor-evidence-is-replay-validated-not-new-v2-execution",
  "deterministic-loopback-evidence-does-not-measure-live-model-quality",
  "operator-selected-targets-do-not-measure-autonomous-target-discovery",
  "first-pass-plan-acceptance-is-measured-for-twenty-mutation-cases-not-all-thirty-tasks",
  "fixed-model-routing-cost-and-success-comparison-remains-unmeasured",
  "source-and-replay-digests-prove-self-consistency-not-runner-authenticity",
  "frozen-evidence-does-not-grant-migration-production-or-remote-mutation-authority",
  "closed-deterministic-v2-case-coverage-does-not-complete-gate2",
]);

function fail(message) {
  throw new Error(`Gate 2 v2 evidence adoption: ${message}`);
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function digestCanonical(value) {
  return sha256Raw(canonicalJson(value));
}

function canonicalTimestamp(value, label) {
  if (
    typeof value !== "string" ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    fail(`${label} must be a canonical ISO timestamp`);
  }
  return value;
}

function assertJsonGraph(value, label, seen = new WeakSet(), depth = 0) {
  if (depth > 64) fail(`${label} exceeds the JSON nesting limit`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(`${label} contains a non-finite number`);
    return;
  }
  if (typeof value !== "object") fail(`${label} contains a non-JSON value`);
  if (seen.has(value)) fail(`${label} contains a cycle`);
  seen.add(value);
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) {
      fail(`${label} must be a dense ordinary array`);
    }
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor)) {
        fail(`${label} must contain only data properties`);
      }
      assertJsonGraph(descriptor.value, `${label}[${index}]`, seen, depth + 1);
    }
  } else {
    if (prototype !== Object.prototype && prototype !== null) {
      fail(`${label} must contain only plain records`);
    }
    const keys = Object.keys(value);
    if (Reflect.ownKeys(value).length !== keys.length) {
      fail(`${label} must contain only enumerable string keys`);
    }
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        fail(`${label} must contain only data properties`);
      }
      assertJsonGraph(descriptor.value, `${label}.${key}`, seen, depth + 1);
    }
  }
  seen.delete(value);
}

function normalizeContext(contextInput) {
  assertJsonGraph(contextInput, "context");
  if (contextInput === null || typeof contextInput !== "object" || Array.isArray(contextInput)) {
    fail("context must be an object");
  }
  const contextKeys = [
    "predecessorManifest",
    "predecessorManifestSha256",
    "successorManifest",
    "successorManifestSha256",
    "sourceReports",
  ];
  if (JSON.stringify(Object.keys(contextInput)) !== JSON.stringify(contextKeys)) {
    fail(`context must contain exactly: ${contextKeys.join(", ")}`);
  }
  const predecessorManifest = validateGate2BenchmarkManifest(contextInput.predecessorManifest);
  const successorManifest = validateGate2BenchmarkSuccessor(
    contextInput.successorManifest,
    predecessorManifest,
    contextInput.predecessorManifestSha256,
  );
  if (contextInput.predecessorManifestSha256 !== GATE2_V1_MANIFEST_SHA256) {
    fail("predecessor manifest digest is not the frozen v1 digest");
  }
  if (contextInput.successorManifestSha256 !== GATE2_V2_MANIFEST_SHA256) {
    fail("successor manifest digest is not the frozen v2 digest");
  }
  if (!Array.isArray(contextInput.sourceReports)) fail("sourceReports must be an array");
  if (contextInput.sourceReports.length !== SOURCE_REPORT_SPECIFICATIONS.length) {
    fail("sourceReports must contain the exact seven-report evidence set");
  }

  const parsedReports = [];
  for (const [index, specification] of SOURCE_REPORT_SPECIFICATIONS.entries()) {
    const input = contextInput.sourceReports[index];
    if (
      input === null ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      JSON.stringify(Object.keys(input)) !== JSON.stringify(["path", "source"])
    ) {
      fail(`sourceReports[${index}] must contain exactly path and source`);
    }
    if (input.path !== specification.path) {
      fail(`sourceReports[${index}] path does not match the closed evidence set`);
    }
    if (typeof input.source !== "string") fail(`sourceReports[${index}].source must be text`);
    const sourceSha256 = sha256Raw(input.source);
    if (sourceSha256 !== specification.sha256) {
      fail(`source report bytes drifted at ${specification.path}`);
    }
    const manifest =
      specification.benchmarkRevision === PREDECESSOR_REVISION
        ? predecessorManifest
        : successorManifest;
    const manifestSha256 =
      specification.benchmarkRevision === PREDECESSOR_REVISION
        ? GATE2_V1_MANIFEST_SHA256
        : GATE2_V2_MANIFEST_SHA256;
    const report = specification.parse(input.source, manifest, manifestSha256);
    parsedReports.push({ specification, report, sourceSha256 });
  }
  return { predecessorManifest, successorManifest, parsedReports };
}

function deriveResult(context) {
  const { predecessorManifest, successorManifest, parsedReports } = normalizeContext(context);
  const generatedAt = parsedReports
    .map(({ report, specification }) =>
      canonicalTimestamp(report.generatedAt, `${specification.path} generatedAt`),
    )
    .sort((left, right) => left.localeCompare(right))
    .at(-1);
  if (generatedAt === undefined) fail("source evidence has no timestamp");
  const predecessorCases = new Map(predecessorManifest.cases.map((entry) => [entry.id, entry]));
  const successorCases = new Map(successorManifest.cases.map((entry) => [entry.id, entry]));
  const replacementSuccessorIds = new Set(
    successorManifest.replacements.map((entry) => entry.successorCaseId),
  );
  const evidenceByCaseId = new Map();
  const sourceReports = [];

  for (const { specification, report, sourceSha256 } of parsedReports) {
    if (report.passed !== true || !Array.isArray(report.observations)) {
      fail(`${specification.path} is not a successful observation report`);
    }
    const caseIds = [];
    for (const observation of report.observations) {
      const caseId = observation.caseId;
      if (typeof caseId !== "string" || evidenceByCaseId.has(caseId)) {
        fail(`source evidence repeats or omits a case identity at ${specification.path}`);
      }
      const targetCase = successorCases.get(caseId);
      if (targetCase === undefined) fail(`source evidence has no v2 target case: ${caseId}`);
      let sourceMode;
      if (specification.benchmarkRevision === PREDECESSOR_REVISION) {
        const predecessorCase = predecessorCases.get(caseId);
        if (
          predecessorCase === undefined ||
          JSON.stringify(predecessorCase) !== JSON.stringify(targetCase)
        ) {
          fail(`predecessor evidence cannot be adopted across drifted case ${caseId}`);
        }
        sourceMode = "adopted_unchanged_predecessor";
      } else {
        if (!replacementSuccessorIds.has(caseId)) {
          fail(`direct v2 evidence is not an explicit successor case: ${caseId}`);
        }
        sourceMode = "direct_successor_execution";
      }
      if (!HEX_64.test(observation.scenarioEvidenceSha256)) {
        fail(`source evidence digest is invalid for ${caseId}`);
      }
      const isMutation = targetCase.expectedOutcome.kind === "mutation";
      const firstPassPlanAccepted = isMutation ? observation.plan?.firstPassAccepted : null;
      if (isMutation && firstPassPlanAccepted !== true) {
        fail(`mutation evidence lacks accepted first plan for ${caseId}`);
      }
      const incorrectEdits = isMutation
        ? JSON.stringify(observation.mutation?.changedPaths) ===
          JSON.stringify(targetCase.expectedOutcome.expectedChangedPaths)
          ? 0
          : 1
        : observation.sourceCheckoutUnchanged === true &&
            observation.fixtureWorkspaceUnchanged === true
          ? 0
          : 1;
      if (incorrectEdits !== 0) fail(`source evidence contains an incorrect edit for ${caseId}`);
      const receiptWithoutDigest = {
        caseId,
        class: targetCase.class,
        sourceMode,
        sourceReportPath: specification.path,
        sourceReportSha256: sourceSha256,
        sourceBenchmarkRevision: specification.benchmarkRevision,
        sourceManifestSha256: report.manifestSha256,
        repositoryId: targetCase.repositoryId,
        repositoryRevisionSha256: observation.repositoryRevisionSha256,
        taskSha256: observation.taskSha256,
        scenarioEvaluatorId: observation.scenarioEvaluatorId,
        scenarioEvidenceSha256: observation.scenarioEvidenceSha256,
        targetCaseSha256: digestCanonical(targetCase),
        retrievalMetrics: {
          recall: observation.retrievalMetrics.recall,
          precision: observation.retrievalMetrics.precision,
          digestProvenanceCoverage: observation.retrievalMetrics.digestProvenanceCoverage,
        },
        firstPassPlanAccepted,
        incorrectEdits,
      };
      evidenceByCaseId.set(caseId, {
        ...receiptWithoutDigest,
        evidenceReplaySha256: digestCanonical(receiptWithoutDigest),
        estimatedCostUsd: observation.usage.estimatedCostUsd,
      });
      caseIds.push(caseId);
    }
    sourceReports.push({
      path: specification.path,
      sha256: sourceSha256,
      benchmarkRevision: report.benchmarkRevision,
      manifestSha256: report.manifestSha256,
      cohortClass: report.cohortClass,
      evaluatorRevision: report.evaluatorRevision,
      generatedAt: report.generatedAt,
      caseIds,
    });
  }

  const internalCases = successorManifest.cases.map((entry) => evidenceByCaseId.get(entry.id));
  if (internalCases.some((entry) => entry === undefined) || internalCases.length !== 30) {
    fail("source evidence does not cover every v2 manifest case exactly once");
  }
  const cases = internalCases.map(({ estimatedCostUsd: _estimatedCostUsd, ...entry }) => entry);
  const adoptedUnchangedCases = cases.filter(
    (entry) => entry.sourceMode === "adopted_unchanged_predecessor",
  ).length;
  const directSuccessorCases = cases.filter(
    (entry) => entry.sourceMode === "direct_successor_execution",
  ).length;
  if (adoptedUnchangedCases !== 28 || directSuccessorCases !== 2) {
    fail("adoption topology must remain exactly 28 unchanged plus two direct successors");
  }
  const macroRetrievalRecall =
    cases.reduce((sum, entry) => sum + entry.retrievalMetrics.recall, 0) / cases.length;
  const macroRetrievalPrecision =
    cases.reduce((sum, entry) => sum + entry.retrievalMetrics.precision, 0) / cases.length;
  const digestProvenanceCoverage =
    cases.reduce((sum, entry) => sum + entry.retrievalMetrics.digestProvenanceCoverage, 0) /
    cases.length;
  const planCases = cases.filter((entry) => entry.firstPassPlanAccepted !== null);
  const firstPassPlanAcceptedCases = planCases.filter(
    (entry) => entry.firstPassPlanAccepted,
  ).length;
  const incorrectEdits = cases.reduce((sum, entry) => sum + entry.incorrectEdits, 0);
  const totalEstimatedCostUsd = internalCases.reduce(
    (sum, entry) => sum + entry.estimatedCostUsd,
    0,
  );
  const quality = {
    macroRetrievalRecall,
    macroRetrievalPrecision,
    digestProvenanceCoverage,
    firstPassPlanAcceptedCases,
    firstPassPlanMeasuredCases: planCases.length,
    firstPassPlanRequiredCases: successorManifest.cases.length,
    incorrectEdits,
    totalEstimatedCostUsd,
    autonomousTargetDiscoveryMeasured: false,
    liveModelQualityMeasured: false,
    routingComparisonMeasured: false,
  };
  const thresholdContract = successorManifest.thresholds;
  const thresholds = {
    taskCountMet: cases.length === thresholdContract.taskCount,
    minimumSuccessfulTasksMet: cases.length >= thresholdContract.minimumSuccessfulTasks,
    minimumMacroRetrievalRecallMet:
      macroRetrievalRecall >= thresholdContract.minimumMacroRetrievalRecall,
    minimumMacroRetrievalPrecisionMet:
      macroRetrievalPrecision >= thresholdContract.minimumMacroRetrievalPrecision,
    minimumDigestProvenanceCoverageMet:
      digestProvenanceCoverage >= thresholdContract.minimumDigestProvenanceCoverage,
    minimumFirstPassPlanAcceptanceMet:
      planCases.length === successorManifest.cases.length &&
      firstPassPlanAcceptedCases / planCases.length >=
        thresholdContract.minimumFirstPassPlanAcceptance,
    maximumIncorrectEditsPerSuccessMet:
      incorrectEdits / cases.length <= thresholdContract.maximumIncorrectEditsPerSuccess,
    minimumRoutedCostReductionMet: false,
    minimumRoutedSuccessCountRatioMet: false,
    allGate2ThresholdsMet: false,
  };
  const resultWithoutReceiptDigest = {
    schemaVersion: 1,
    benchmarkId: successorManifest.benchmarkId,
    benchmarkRevision: successorManifest.benchmarkRevision,
    manifestSha256: GATE2_V2_MANIFEST_SHA256,
    predecessor: {
      benchmarkRevision: predecessorManifest.benchmarkRevision,
      manifestSha256: GATE2_V1_MANIFEST_SHA256,
    },
    adoptionPolicyRevision: ADOPTION_POLICY_REVISION,
    generatedAt,
    contractPassed: true,
    counts: {
      manifestCases: successorManifest.cases.length,
      sourceReports: sourceReports.length,
      adoptedUnchangedCases,
      directSuccessorCases,
      replayValidatedCases: cases.length,
      successfulCases: cases.length,
      failedCases: 0,
      missingCases: 0,
    },
    quality,
    thresholds,
    sourceReports,
    cases,
  };
  return {
    ...resultWithoutReceiptDigest,
    receiptSha256: digestCanonical(resultWithoutReceiptDigest),
    limitations: GATE2_V2_EVIDENCE_ADOPTION_LIMITATIONS,
    assessment: "deterministic_v2_evidence_adoption_passed_gate2_incomplete",
  };
}

export function buildGate2V2EvidenceAdoptionResult(context) {
  const result = deriveResult(context);
  assertJsonGraph(result, "result");
  return result;
}

export function validateGate2V2EvidenceAdoptionResult(value, context) {
  assertJsonGraph(value, "result");
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("result must be an object");
  }
  const expected = deriveResult(context);
  if (JSON.stringify(value) !== JSON.stringify(expected)) {
    fail("result does not match the exact replay-derived adoption receipt");
  }
  return value;
}

export function parseAndValidateGate2V2EvidenceAdoptionResult(source, context) {
  return validateGate2V2EvidenceAdoptionResult(parseStrictGate2Json(source), context);
}
