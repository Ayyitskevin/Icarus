// biome-ignore-all lint/suspicious/noExplicitAny: adversarial tests intentionally mutate untyped JSON contracts.
import { beforeAll, describe, expect, it } from "vitest";
import type { Gate2BenchmarkManifest } from "../../scripts/gate2-benchmark-contract.mjs";
import { loadGate2BenchmarkContract, sha256Raw } from "../../scripts/gate2-benchmark-contract.mjs";
import {
  compareGate2BenchmarkResults,
  computeGate2BenchmarkAggregates,
  computeGate2ExecutionProfileDigest,
  GATE2_RESULT_LIMITATIONS,
  parseAndValidateGate2BenchmarkResult,
  validateGate2BenchmarkResult,
} from "../../scripts/gate2-benchmark-result-contract.mjs";

const repositoryRoot = new URL("../../", import.meta.url);
const manifestUrl = new URL("../../fixtures/evals/gate2/manifest.v1.json", import.meta.url);

let manifest: Gate2BenchmarkManifest;
let manifestSha256: string;

beforeAll(async () => {
  const loaded = await loadGate2BenchmarkContract(
    manifestUrl,
    decodeURIComponent(repositoryRoot.pathname),
  );
  manifest = loaded.manifest;
  manifestSha256 = loaded.manifestSha256;
});

function executionProfile(): Record<string, any> {
  const profile: Record<string, any> = {
    profileId: "gate2-qwen38-fixed",
    profileDigestSha256: "",
    baselineModelId: "qwen3.8:27b",
    models: [
      {
        modelId: "muse-glimmer:latest",
        provider: "vulcan",
        adapterVersion: "openai-compatible-v1",
        modelVersion: "muse-glimmer-2026-08-24",
        inputUsdPerMillion: 0.5,
        outputUsdPerMillion: 1,
      },
      {
        modelId: "qwen3.8:27b",
        provider: "vulcan",
        adapterVersion: "openai-compatible-v1",
        modelVersion: "qwen3.8-27b-2026-08-18",
        inputUsdPerMillion: 1,
        outputUsdPerMillion: 2,
      },
    ],
    pricing: {
      capturedAt: "2026-08-21",
      currency: "USD",
      sourceLabel: "operator-captured-estimate-v1",
      estimatedOnly: true,
    },
    budgets: {
      maxRuntimeSeconds: 600,
      maxInputTokens: 10000,
      maxOutputTokens: 5000,
      maxEstimatedCostUsd: 1,
    },
  };
  profile.profileDigestSha256 = computeGate2ExecutionProfileDigest(profile);
  return profile;
}

function observations(
  profile: Record<string, any>,
  modelId: string,
  inputTokens: number,
  outputTokens: number,
): Record<string, any>[] {
  const repositories = new Map(
    manifest.repositories.map((repository: Record<string, any>) => [repository.id, repository]),
  );
  const selectedModel = profile.models.find(
    (candidate: Record<string, any>) => candidate.modelId === modelId,
  ) as Record<string, any> | undefined;
  if (selectedModel === undefined) throw new Error(`missing model fixture: ${modelId}`);
  const cost = Number(
    (
      (inputTokens * selectedModel.inputUsdPerMillion +
        outputTokens * selectedModel.outputUsdPerMillion) /
      1_000_000
    ).toFixed(12),
  );
  return manifest.cases.map((benchmarkCase: Record<string, any>) => {
    const repository = repositories.get(benchmarkCase.repositoryId) as Record<string, any>;
    const files = new Map(
      repository.files.map((file: Record<string, string>) => [file.path, file.sha256]),
    );
    return {
      caseId: benchmarkCase.id,
      repositoryRevisionSha256: repository.revisionSha256,
      taskSha256: benchmarkCase.task.sha256,
      modelId,
      retrievedContext: benchmarkCase.expectedContextPaths.map((filePath: string) => ({
        path: filePath,
        sha256: files.get(filePath),
      })),
      firstPassPlanAccepted: true,
      changedPaths: benchmarkCase.expectedOutcome.expectedChangedPaths,
      citations: benchmarkCase.expectedOutcome.expectedCitationPaths,
      findingIds: benchmarkCase.expectedOutcome.expectedFindingIds,
      scenarioEvaluatorId: benchmarkCase.expectedOutcome.scenarioEvaluatorId,
      scenarioEvidenceSha256: sha256Raw(
        JSON.stringify({
          caseId: benchmarkCase.id,
          evaluatorId: benchmarkCase.expectedOutcome.scenarioEvaluatorId,
          status: "passed",
        }),
      ),
      scenarioStatus: "passed",
      usage: {
        inputTokens,
        outputTokens,
        estimatedCostUsd: cost,
        actualBilledUsd: null,
        latencyMs: 1000,
      },
    };
  });
}

function result(mode: "baseline" | "routed", inputTokens: number, outputTokens: number) {
  const profile = executionProfile();
  const modelId = mode === "baseline" ? profile.baselineModelId : "muse-glimmer:latest";
  const taskObservations = observations(profile, modelId, inputTokens, outputTokens);
  return {
    schemaVersion: 1,
    benchmarkId: manifest.benchmarkId,
    benchmarkRevision: manifest.benchmarkRevision,
    manifestSha256,
    mode,
    executionProfile: profile,
    observations: taskObservations,
    aggregates: computeGate2BenchmarkAggregates(taskObservations, manifest, profile),
    limitations: [...GATE2_RESULT_LIMITATIONS],
  };
}
function requiredAt<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error(`missing test fixture entry at index ${index}`);
  return value;
}

describe("Gate 2 benchmark result contract", () => {
  it("accepts a complete result and recomputes every aggregate", () => {
    const candidate = result("baseline", 1000, 1000);

    expect(validateGate2BenchmarkResult(candidate, manifest, manifestSha256)).toBe(candidate);
    expect(candidate.aggregates).toMatchObject({
      taskCount: 30,
      measuredTaskCount: 30,
      successCount: 30,
      macroRetrievalRecall: 1,
      macroRetrievalPrecision: 1,
      digestProvenanceCoverage: 1,
      firstPassPlanAcceptance: 1,
      incorrectEdits: 0,
      thresholdsPassed: true,
      assessment: "thresholds_passed_pair_comparison_required",
    });
  });

  it("rejects aggregate, profile, provenance, budget, and exact-key tampering", () => {
    const attacks = [
      result("baseline", 1000, 1000),
      result("baseline", 1000, 1000),
      result("baseline", 1000, 1000),
      result("baseline", 1000, 1000),
      result("baseline", 1000, 1000),
    ];
    requiredAt(attacks, 0).aggregates.successCount = 29;
    requiredAt(attacks, 1).executionProfile.models = ["different-model"];
    const provenance = requiredAt(
      requiredAt(requiredAt(attacks, 2).observations, 0).retrievedContext,
      0,
    ) as Record<string, any>;
    provenance.sha256 = "0".repeat(64);
    requiredAt(requiredAt(attacks, 3).observations, 0).usage.inputTokens = 10001;
    requiredAt(requiredAt(attacks, 4).observations, 0).unreviewed = false;

    for (const attack of attacks) {
      expect(() => validateGate2BenchmarkResult(attack, manifest, manifestSha256)).toThrow();
    }
  });

  it("keeps unsupported and incorrect-edit results honest instead of promoting them", () => {
    const unsupported = result("baseline", 1000, 1000);
    requiredAt(unsupported.observations, 0).scenarioStatus = "unsupported";
    unsupported.aggregates = computeGate2BenchmarkAggregates(
      unsupported.observations,
      manifest,
      unsupported.executionProfile,
    );
    expect(
      validateGate2BenchmarkResult(unsupported, manifest, manifestSha256).aggregates,
    ).toMatchObject({
      measuredTaskCount: 29,
      thresholdsPassed: false,
      assessment: "incomplete",
    });

    const incorrect = result("baseline", 1000, 1000);
    const incorrectObservation = requiredAt(incorrect.observations, 0);
    incorrectObservation.changedPaths = [
      ...incorrectObservation.changedPaths,
      "outside.txt",
    ].sort();
    incorrect.aggregates = computeGate2BenchmarkAggregates(
      incorrect.observations,
      manifest,
      incorrect.executionProfile,
    );
    expect(
      validateGate2BenchmarkResult(incorrect, manifest, manifestSha256).aggregates,
    ).toMatchObject({
      successCount: 29,
      incorrectEdits: 1,
      thresholdsPassed: false,
      assessment: "thresholds_failed",
    });
  });

  it("strict parsing rejects duplicate result members", () => {
    const source = JSON.stringify(result("baseline", 1000, 1000));
    const duplicate = source.replace(
      '{"schemaVersion":1,',
      '{"schemaVersion":1,"schemaVersion":1,',
    );

    expect(() => parseAndValidateGate2BenchmarkResult(duplicate, manifest, manifestSha256)).toThrow(
      "duplicate JSON object members",
    );
  });

  it("requires manifest-bound evaluator identity and evidence for every observation", () => {
    const missingEvaluator = result("baseline", 1000, 1000);
    delete requiredAt(missingEvaluator.observations, 0).scenarioEvaluatorId;
    const missingEvidence = result("baseline", 1000, 1000);
    delete requiredAt(missingEvidence.observations, 0).scenarioEvidenceSha256;

    expect(() => validateGate2BenchmarkResult(missingEvaluator, manifest, manifestSha256)).toThrow(
      "scenarioEvaluatorId",
    );
    expect(() => validateGate2BenchmarkResult(missingEvidence, manifest, manifestSha256)).toThrow(
      "scenarioEvidenceSha256",
    );
  });

  it("requires an explicit declared model route for every paired observation", () => {
    const baseline = result("baseline", 1000, 1000);
    const routed = result("routed", 500, 500);
    delete requiredAt(routed.observations, 0).modelId;

    expect(() => compareGate2BenchmarkResults(baseline, routed, manifest, manifestSha256)).toThrow(
      "modelId",
    );
  });

  it("pins baseline routing and recomputes usage from the selected model price", () => {
    const mislabeledBaseline = result("routed", 1000, 1000);
    mislabeledBaseline.mode = "baseline";
    expect(() =>
      validateGate2BenchmarkResult(mislabeledBaseline, manifest, manifestSha256),
    ).toThrow("baseline observations");

    const wrongSelectedModelCost = result("routed", 1000, 1000);
    requiredAt(wrongSelectedModelCost.observations, 0).usage.estimatedCostUsd = 0.003;
    expect(() =>
      validateGate2BenchmarkResult(wrongSelectedModelCost, manifest, manifestSha256),
    ).toThrow("estimatedCostUsd");

    const undeclaredModel = result("routed", 1000, 1000);
    requiredAt(undeclaredModel.observations, 0).modelId = "undeclared-model";
    expect(() => validateGate2BenchmarkResult(undeclaredModel, manifest, manifestSha256)).toThrow(
      "must name a declared model",
    );
  });

  it("rejects a scenario evaluator other than the manifest-bound evaluator", () => {
    const candidate = result("baseline", 1000, 1000);
    requiredAt(candidate.observations, 0).scenarioEvaluatorId = "different-evaluator";

    expect(() => validateGate2BenchmarkResult(candidate, manifest, manifestSha256)).toThrow(
      "scenarioEvaluatorId",
    );
  });

  it("rejects token savings presented as routing when every task still uses the baseline model", () => {
    const baseline = result("baseline", 1000, 1000);
    const notActuallyRouted = result("baseline", 500, 500);
    notActuallyRouted.mode = "routed";

    expect(() =>
      compareGate2BenchmarkResults(baseline, notActuallyRouted, manifest, manifestSha256),
    ).toThrow("non-baseline model");
  });

  it("passes only an exact paired run with non-inferior success and >=30% lower cost", () => {
    const baseline = result("baseline", 1000, 1000);
    const routed = result("routed", 1000, 1000);
    const comparison = compareGate2BenchmarkResults(baseline, routed, manifest, manifestSha256);

    expect(comparison).toMatchObject({
      baselineModelId: "qwen3.8:27b",
      routedModelIds: ["muse-glimmer:latest"],
      baselineSuccessCount: 30,
      routedSuccessCount: 30,
      successCountRatio: 1,
      costReduction: 0.5,
      passed: true,
      assessment: "gate2-routing-comparison-passed",
    });
  });

  it("fails a weak cost result and rejects a mismatched execution profile", () => {
    const weak = compareGate2BenchmarkResults(
      result("baseline", 1000, 1000),
      result("routed", 1600, 1600),
      manifest,
      manifestSha256,
    );
    expect(weak).toMatchObject({ costReduction: 0.2, passed: false });

    const baseline = result("baseline", 1000, 1000);
    const routed = result("routed", 1000, 1000);
    routed.executionProfile.profileId = "changed";
    routed.executionProfile.profileDigestSha256 = computeGate2ExecutionProfileDigest(
      routed.executionProfile,
    );
    expect(() => compareGate2BenchmarkResults(baseline, routed, manifest, manifestSha256)).toThrow(
      "paired execution profile digest",
    );
  });
});
