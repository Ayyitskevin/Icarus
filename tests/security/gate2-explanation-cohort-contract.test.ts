// biome-ignore-all lint/suspicious/noExplicitAny: adversarial tests intentionally mutate untyped JSON contracts.
import { beforeAll, describe, expect, it } from "vitest";

import type { Gate2BenchmarkManifest } from "../../scripts/gate2-benchmark-contract.mjs";
import { loadGate2BenchmarkContract } from "../../scripts/gate2-benchmark-contract.mjs";
import {
  computeGate2ExplanationEvidenceDigest,
  GATE2_EXPLANATION_COHORT_LIMITATIONS,
  GATE2_EXPLANATION_ORACLES,
  parseAndValidateGate2ExplanationCohortResult,
  validateGate2ExplanationCohortResult,
} from "../../scripts/gate2-explanation-cohort-contract.mjs";

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

function result(): Record<string, any> {
  const repositories = new Map(
    manifest.repositories.map((repository: Record<string, any>) => [repository.id, repository]),
  );
  const cases = new Map(
    manifest.cases.map((benchmarkCase: Record<string, any>) => [benchmarkCase.id, benchmarkCase]),
  );
  const observations = GATE2_EXPLANATION_ORACLES.map((oracle, index) => {
    const benchmarkCase = cases.get(oracle.caseId) as Record<string, any>;
    const repository = repositories.get(benchmarkCase.repositoryId) as Record<string, any>;
    const digests = new Map(
      repository.files.map((file: Record<string, string>) => [file.path, file.sha256]),
    );
    const observation: Record<string, any> = {
      caseId: benchmarkCase.id,
      repositoryId: benchmarkCase.repositoryId,
      scenarioEvaluatorId: benchmarkCase.expectedOutcome.scenarioEvaluatorId,
      repositoryRevisionSha256: repository.revisionSha256,
      taskSha256: benchmarkCase.task.sha256,
      baseCommit: String(index + 1)
        .repeat(40)
        .slice(0, 40),
      treeSha1: String(index + 6)
        .repeat(40)
        .slice(0, 40),
      retrievalDigestSha256: "a".repeat(64),
      repositoryDigestSha256: "b".repeat(64),
      explanationDigestSha256: "c".repeat(64),
      provider: {
        kind: "ollama",
        model: "icarus-gate2-deterministic-explanation-fixture",
        adapterVersion: "production-ollama-structured-v1",
        transport: "loopback-http",
      },
      selectedContext: benchmarkCase.expectedContextPaths.map((filePath: string) => ({
        path: filePath,
        sha256: digests.get(filePath),
      })),
      retrievalMetrics: {
        recall: 1,
        precision: 1,
        digestProvenanceCoverage: 1,
      },
      outcome: structuredClone(oracle.response),
      usage: {
        inputTokens: oracle.inputTokens,
        outputTokens: oracle.outputTokens,
        estimatedCostUsd: 0,
        actualBilledUsd: null,
        latencyMs: 1,
      },
      sourceCheckoutUnchanged: true,
      fixtureWorkspaceUnchanged: true,
      scenarioEvidenceSha256: "",
    };
    observation.scenarioEvidenceSha256 = computeGate2ExplanationEvidenceDigest(observation);
    return observation;
  });
  return {
    schemaVersion: 1,
    benchmarkId: manifest.benchmarkId,
    benchmarkRevision: manifest.benchmarkRevision,
    manifestSha256,
    cohortClass: "explanation",
    evaluatorRevision: "deterministic-loopback-v1",
    generatedAt: "2026-08-28T00:00:00.000Z",
    passed: true,
    counts: {
      manifestCases: 30,
      cohortCases: 5,
      executedCases: 5,
      passedCases: 5,
      failedCases: 0,
      unexecutedCases: 25,
    },
    effects: {
      providerCalls: 5,
      loopbackProviderRequests: 5,
      externalNetworkRequests: 0,
      remoteMutations: 0,
      sourceCheckoutMutations: 0,
      repositoryCodeExecutions: 0,
      icarusRegisteredCommands: 0,
      temporaryGitFixtureSetup: true,
    },
    observations,
    limitations: [...GATE2_EXPLANATION_COHORT_LIMITATIONS],
    assessment: "deterministic_explanation_cohort_passed_gate2_incomplete",
  };
}

function firstObservation(candidate: Record<string, any>): Record<string, any> {
  const observation = candidate.observations[0];
  if (observation === undefined) throw new Error("test result has no observation");
  return observation;
}

function requiredAt<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error(`missing test fixture entry at index ${index}`);
  return value;
}

describe("Gate 2 explanation cohort result contract", () => {
  it("accepts exactly the five manifest-bound explanation observations", () => {
    const candidate = result();

    expect(validateGate2ExplanationCohortResult(candidate, manifest, manifestSha256)).toBe(
      candidate,
    );
    expect(candidate.observations.map((entry: Record<string, any>) => entry.caseId)).toEqual(
      GATE2_EXPLANATION_ORACLES.map((entry) => entry.caseId),
    );
  });

  it("rejects widened effects, counts, shapes, and completion claims", () => {
    const attacks = [result(), result(), result(), result(), result()];
    requiredAt(attacks, 0).effects.externalNetworkRequests = 1;
    requiredAt(attacks, 1).counts.unexecutedCases = 0;
    const duplicateObservation = requiredAt(attacks, 2);
    duplicateObservation.observations.push(requiredAt(duplicateObservation.observations, 0));
    requiredAt(attacks, 3).limitations = [];
    requiredAt(attacks, 4).gate2Complete = true;

    for (const attack of attacks) {
      expect(() =>
        validateGate2ExplanationCohortResult(attack, manifest, manifestSha256),
      ).toThrow();
    }
  });

  it("rejects evaluator, source, citation, response, usage, and digest forgery", () => {
    const attacks = [result(), result(), result(), result(), result(), result()];
    firstObservation(requiredAt(attacks, 0)).scenarioEvaluatorId = "different-evaluator";
    const changedContext = firstObservation(requiredAt(attacks, 1)).selectedContext as Record<
      string,
      any
    >[];
    requiredAt(changedContext, 0).sha256 = "0".repeat(64);
    const changedClaims = firstObservation(requiredAt(attacks, 2)).outcome.claims as Record<
      string,
      any
    >[];
    const changedClaim = requiredAt(changedClaims, 0);
    requiredAt(changedClaim.citations as Record<string, any>[], 0).path = "src/main.py";
    firstObservation(requiredAt(attacks, 3)).outcome.summary =
      "A plausible but unevaluated explanation.";
    firstObservation(requiredAt(attacks, 4)).usage.inputTokens += 1;
    firstObservation(requiredAt(attacks, 5)).scenarioEvidenceSha256 = "0".repeat(64);

    for (const attack of attacks) {
      expect(() =>
        validateGate2ExplanationCohortResult(attack, manifest, manifestSha256),
      ).toThrow();
    }
  });

  it("rejects a manifest that rebinds a case to a different evaluator", () => {
    const rebound = structuredClone(manifest);
    requiredAt(rebound.cases, 15).expectedOutcome.scenarioEvaluatorId = "replacement-evaluator";

    expect(() => validateGate2ExplanationCohortResult(result(), rebound, manifestSha256)).toThrow();
  });

  it("strict parsing rejects duplicate members, oversized input, and excessive depth", () => {
    const source = JSON.stringify(result());
    const duplicate = source.replace(
      '{"schemaVersion":1,',
      '{"schemaVersion":1,"schemaVersion":1,',
    );
    const oversized = JSON.stringify({ payload: "x".repeat(4 * 1024 * 1024) });
    const tooDeep = `${"[".repeat(70)}0${"]".repeat(70)}`;

    for (const attack of [duplicate, oversized, tooDeep]) {
      expect(() =>
        parseAndValidateGate2ExplanationCohortResult(attack, manifest, manifestSha256),
      ).toThrow();
    }
  });
});
