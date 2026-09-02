// biome-ignore-all lint/suspicious/noExplicitAny: adversarial tests intentionally mutate untyped JSON contracts.
import { readFile } from "node:fs/promises";

import { beforeAll, describe, expect, it } from "vitest";

import { parseStrictGate2Json, sha256Raw } from "../../scripts/gate2-benchmark-contract.mjs";
import {
  buildGate2V2EvidenceAdoptionResult,
  GATE2_V2_EVIDENCE_ADOPTION_LIMITATIONS,
  GATE2_V2_EVIDENCE_SOURCE_REPORTS,
  parseAndValidateGate2V2EvidenceAdoptionResult,
  validateGate2V2EvidenceAdoptionResult,
  type Gate2V2EvidenceAdoptionContext,
} from "../../scripts/gate2-v2-evidence-adoption-contract.mjs";

const manifestV1Url = new URL("../../fixtures/evals/gate2/manifest.v1.json", import.meta.url);
const manifestV2Url = new URL("../../fixtures/evals/gate2/manifest.v2.json", import.meta.url);
let context: Gate2V2EvidenceAdoptionContext;

beforeAll(async () => {
  const [predecessorSource, successorSource, ...reportSources] = await Promise.all([
    readFile(manifestV1Url, "utf8"),
    readFile(manifestV2Url, "utf8"),
    ...GATE2_V2_EVIDENCE_SOURCE_REPORTS.map((specification) =>
      readFile(new URL(`../../${specification.path}`, import.meta.url), "utf8"),
    ),
  ]);
  context = {
    predecessorManifest: parseStrictGate2Json(predecessorSource) as Record<string, any>,
    predecessorManifestSha256: sha256Raw(predecessorSource),
    predecessorManifestSource: predecessorSource,
    successorManifest: parseStrictGate2Json(successorSource) as Record<string, any>,
    successorManifestSha256: sha256Raw(successorSource),
    sourceReports: GATE2_V2_EVIDENCE_SOURCE_REPORTS.map((specification, index) => ({
      path: specification.path,
      source: requiredAt(reportSources, index),
    })),
  };
});

function requiredAt<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error(`missing fixture entry at index ${index}`);
  return value;
}

function copyContext(): Gate2V2EvidenceAdoptionContext {
  return structuredClone(context);
}

function build(): Record<string, any> {
  return buildGate2V2EvidenceAdoptionResult(context) as Record<string, any>;
}

describe("Gate 2 v2 evidence adoption contract", () => {
  it("replay-validates one closed 30-case v2 receipt from 28 unchanged and two direct cases", () => {
    const result = build();
    const successorCaseIds = (context.successorManifest.cases as Record<string, any>[]).map(
      (entry) => entry.id,
    );

    expect(validateGate2V2EvidenceAdoptionResult(result, context)).toBe(result);
    expect(JSON.stringify(build())).toBe(JSON.stringify(result));
    expect(result.generatedAt).toBe("2026-08-28T09:09:48.690Z");
    expect(result.counts).toEqual({
      manifestCases: 30,
      sourceReports: 7,
      adoptedUnchangedCases: 28,
      directSuccessorCases: 2,
      replayValidatedCases: 30,
      successfulCases: 30,
      failedCases: 0,
      missingCases: 0,
    });
    expect(result.cases.map((entry: Record<string, any>) => entry.caseId)).toEqual(
      successorCaseIds,
    );
    expect(
      result.cases.filter(
        (entry: Record<string, any>) => entry.sourceMode === "adopted_unchanged_predecessor",
      ),
    ).toHaveLength(28);
    expect(
      result.cases.filter(
        (entry: Record<string, any>) => entry.sourceMode === "direct_successor_execution",
      ),
    ).toHaveLength(2);
    expect(result.cases.map((entry: Record<string, any>) => entry.caseId)).not.toContain(
      "repair-schema-status-column",
    );
    expect(result.cases.map((entry: Record<string, any>) => entry.caseId)).not.toContain(
      "scaffold-task-priority",
    );
    expect(result.quality).toEqual({
      macroRetrievalRecall: 0.9916666666666667,
      macroRetrievalPrecision: 0.8083333333333333,
      digestProvenanceCoverage: 1,
      firstPassPlanAcceptedCases: 20,
      firstPassPlanMeasuredCases: 20,
      firstPassPlanRequiredCases: 30,
      incorrectEdits: 0,
      totalEstimatedCostUsd: 0,
      autonomousTargetDiscoveryMeasured: false,
      liveModelQualityMeasured: false,
      routingComparisonMeasured: false,
    });
    expect(result.thresholds).toEqual({
      taskCountMet: true,
      minimumSuccessfulTasksMet: true,
      minimumMacroRetrievalRecallMet: true,
      minimumMacroRetrievalPrecisionMet: true,
      minimumDigestProvenanceCoverageMet: true,
      minimumFirstPassPlanAcceptanceMet: false,
      maximumIncorrectEditsPerSuccessMet: true,
      minimumRoutedCostReductionMet: false,
      minimumRoutedSuccessCountRatioMet: false,
      allGate2ThresholdsMet: false,
    });
    expect(result.limitations).toEqual(GATE2_V2_EVIDENCE_ADOPTION_LIMITATIONS);
    expect(result.assessment).toBe("deterministic_v2_evidence_adoption_passed_gate2_incomplete");
  });

  it("strictly validates every frozen source report with its owning cohort contract", () => {
    expect(GATE2_V2_EVIDENCE_SOURCE_REPORTS).toHaveLength(7);
    for (const [index, specification] of GATE2_V2_EVIDENCE_SOURCE_REPORTS.entries()) {
      expect(sha256Raw(requiredAt(context.sourceReports, index).source)).toBe(specification.sha256);
    }

    const attack = copyContext();
    const parsed = JSON.parse(requiredAt(attack.sourceReports, 0).source) as Record<string, any>;
    parsed.observations[0].scenarioEvidenceSha256 = "0".repeat(64);
    requiredAt(attack.sourceReports, 0).source = JSON.stringify(parsed);
    expect(() => buildGate2V2EvidenceAdoptionResult(attack)).toThrow();
  });

  it("rejects manifest drift and non-exact source report topology", () => {
    const manifestDrift = copyContext();
    manifestDrift.successorManifest.cases[0].task.sha256 = "0".repeat(64);

    const missing = copyContext();
    missing.sourceReports.pop();

    const reordered = copyContext();
    reordered.sourceReports.reverse();

    const duplicatePath = copyContext();
    requiredAt(duplicatePath.sourceReports, 1).path = requiredAt(
      duplicatePath.sourceReports,
      0,
    ).path;

    for (const attack of [manifestDrift, missing, reordered, duplicatePath]) {
      expect(() => buildGate2V2EvidenceAdoptionResult(attack)).toThrow();
    }
  });

  it("rejects accessor-backed input instead of executing caller code", () => {
    const attack = copyContext();
    let getterCalled = false;
    Object.defineProperty(attack.sourceReports[0], "source", {
      enumerable: true,
      get() {
        getterCalled = true;
        return requiredAt(context.sourceReports, 0).source;
      },
    });

    expect(() => buildGate2V2EvidenceAdoptionResult(attack)).toThrow(
      "must contain only data properties",
    );
    expect(getterCalled).toBe(false);
  });

  it("rejects forged adoption, replay, quality, threshold, count, and completion claims", () => {
    const attacks = Array.from({ length: 9 }, () => build());
    requiredAt(attacks, 0).sourceReports[0].sha256 = "0".repeat(64);
    requiredAt(attacks, 1).cases[0].sourceMode = "direct_successor_execution";
    requiredAt(attacks, 2).cases[0].scenarioEvidenceSha256 = "0".repeat(64);
    requiredAt(attacks, 3).cases[0].targetCaseSha256 = "0".repeat(64);
    requiredAt(attacks, 4).cases[0].evidenceReplaySha256 = "0".repeat(64);
    requiredAt(attacks, 5).counts.missingCases = 1;
    requiredAt(attacks, 6).quality.firstPassPlanRequiredCases = 20;
    requiredAt(attacks, 7).thresholds.allGate2ThresholdsMet = true;
    requiredAt(attacks, 8).gate2Complete = true;

    for (const attack of attacks) {
      expect(() => validateGate2V2EvidenceAdoptionResult(attack, context)).toThrow();
    }
  });

  it("rejects reordered case receipts and duplicate-member result JSON", () => {
    const reordered = build();
    [reordered.cases[0], reordered.cases[1]] = [reordered.cases[1], reordered.cases[0]];
    expect(() => validateGate2V2EvidenceAdoptionResult(reordered, context)).toThrow();

    const serialized = JSON.stringify(build());
    const duplicate = serialized.replace(
      '"schemaVersion":1,',
      '"schemaVersion":1,"schemaVersion":1,',
    );
    expect(() => parseAndValidateGate2V2EvidenceAdoptionResult(duplicate, context)).toThrow(
      "duplicate JSON object members",
    );
  });
});
