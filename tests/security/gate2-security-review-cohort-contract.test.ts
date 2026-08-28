// biome-ignore-all lint/suspicious/noExplicitAny: adversarial tests intentionally mutate untyped JSON contracts.
import { beforeAll, describe, expect, it } from "vitest";

import type { Gate2BenchmarkManifest } from "../../scripts/gate2-benchmark-contract.mjs";
import { loadGate2BenchmarkContract } from "../../scripts/gate2-benchmark-contract.mjs";
import {
  computeGate2SecurityReviewEvidenceDigest,
  GATE2_SECURITY_REVIEW_COHORT_LIMITATIONS,
  GATE2_SECURITY_REVIEW_ORACLES,
  parseAndValidateGate2SecurityReviewCohortResult,
  validateGate2SecurityReviewCohortResult,
} from "../../scripts/gate2-security-review-cohort-contract.mjs";

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
  const observations = GATE2_SECURITY_REVIEW_ORACLES.map((oracle, index) => {
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
      securityReviewDigestSha256: "c".repeat(64),
      provider: {
        kind: "ollama",
        model: "icarus-gate2-deterministic-security-review-fixture",
        adapterVersion: "production-ollama-structured-v1",
        transport: "loopback-http",
      },
      selectedContext: benchmarkCase.expectedContextPaths.map((filePath: string) => ({
        path: filePath,
        sha256: digests.get(filePath),
      })),
      retrievalMetrics: { recall: 1, precision: 1, digestProvenanceCoverage: 1 },
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
    observation.scenarioEvidenceSha256 = computeGate2SecurityReviewEvidenceDigest(observation);
    return observation;
  });
  return {
    schemaVersion: 1,
    benchmarkId: manifest.benchmarkId,
    benchmarkRevision: manifest.benchmarkRevision,
    manifestSha256,
    cohortClass: "security_review",
    evaluatorRevision: "deterministic-loopback-v1",
    generatedAt: "2026-08-28T00:00:00.000Z",
    passed: true,
    counts: {
      manifestCases: manifest.cases.length,
      cohortCases: observations.length,
      executedCases: observations.length,
      passedCases: observations.length,
      failedCases: 0,
      unexecutedCases: manifest.cases.length - observations.length,
    },
    retrievalAggregate: { macroRecall: 1, macroPrecision: 1, digestProvenanceCoverage: 1 },
    effects: {
      providerCalls: observations.length,
      loopbackProviderRequests: observations.length,
      externalNetworkRequests: 0,
      remoteMutations: 0,
      sourceCheckoutMutations: 0,
      repositoryCodeExecutions: 0,
      icarusRegisteredCommands: 0,
      temporaryGitFixtureSetup: true,
    },
    effectEvidence: {
      providerCalls: "observed",
      loopbackProviderRequests: "observed",
      externalNetworkRequests: "design-assertion",
      remoteMutations: "design-assertion",
      sourceCheckoutMutations: "observed",
      repositoryCodeExecutions: "design-assertion",
      icarusRegisteredCommands: "design-assertion",
      temporaryGitFixtureSetup: "observed",
    },
    observations,
    limitations: [...GATE2_SECURITY_REVIEW_COHORT_LIMITATIONS],
    assessment: "deterministic_security_review_cohort_passed_gate2_incomplete",
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

describe("Gate 2 security-review cohort result contract", () => {
  it("accepts exactly the five manifest-bound security-review observations", () => {
    const candidate = result();

    expect(validateGate2SecurityReviewCohortResult(candidate, manifest, manifestSha256)).toBe(
      candidate,
    );
    expect(candidate.observations.map((entry: Record<string, any>) => entry.caseId)).toEqual(
      GATE2_SECURITY_REVIEW_ORACLES.map((entry) => entry.caseId),
    );
  });

  it("rejects widened effects, counts, shapes, aggregate forgery, and completion claims", () => {
    const attacks = [result(), result(), result(), result(), result(), result()];
    requiredAt(attacks, 0).effects.externalNetworkRequests = 1;
    requiredAt(attacks, 1).counts.unexecutedCases = 0;
    requiredAt(attacks, 2).retrievalAggregate.macroPrecision = 0.99;
    const duplicate = requiredAt(attacks, 3);
    duplicate.observations.push(requiredAt(duplicate.observations, 0));
    requiredAt(attacks, 4).limitations = [];
    requiredAt(attacks, 5).gate2Complete = true;

    for (const attack of attacks) {
      expect(() =>
        validateGate2SecurityReviewCohortResult(attack, manifest, manifestSha256),
      ).toThrow();
    }
  });

  it("rejects finding, no-finding, citation, usage, and digest forgery", () => {
    const attacks = [result(), result(), result(), result(), result(), result()];
    firstObservation(requiredAt(attacks, 0)).scenarioEvaluatorId = "different-evaluator";
    firstObservation(requiredAt(attacks, 1)).outcome.findings[0].id = "plausible-other-finding";
    requiredAt(attacks, 2).observations[2].outcome.noFinding.rationale =
      "A plausible but unevaluated absence claim.";
    firstObservation(requiredAt(attacks, 3)).outcome.findings[0].citations[0].path = "README.md";
    firstObservation(requiredAt(attacks, 4)).usage.outputTokens += 1;
    firstObservation(requiredAt(attacks, 5)).scenarioEvidenceSha256 = "0".repeat(64);

    for (const attack of attacks) {
      expect(() =>
        validateGate2SecurityReviewCohortResult(attack, manifest, manifestSha256),
      ).toThrow();
    }
  });

  it("accepts extra eligible context only with honestly recomputed retrieval metrics", () => {
    const candidate = result();
    const observation = requiredAt(candidate.observations, 1) as Record<string, any>;
    const repository = manifest.repositories.find((entry) => entry.id === observation.repositoryId);
    const extra = repository?.files.find(
      (entry) => !observation.selectedContext.some((selected: any) => selected.path === entry.path),
    );
    if (extra === undefined) throw new Error("fixture has no eligible extra source");
    const benchmarkCase = manifest.cases.find((entry) => entry.id === observation.caseId);
    if (benchmarkCase === undefined) throw new Error("security fixture case missing");
    observation.selectedContext.push({ path: extra.path, sha256: extra.sha256 });
    observation.retrievalMetrics.precision =
      benchmarkCase.expectedContextPaths.length / observation.selectedContext.length;
    observation.scenarioEvidenceSha256 = computeGate2SecurityReviewEvidenceDigest(observation);
    candidate.retrievalAggregate.macroPrecision =
      candidate.observations.reduce(
        (sum: number, entry: Record<string, any>) => sum + entry.retrievalMetrics.precision,
        0,
      ) / candidate.observations.length;

    expect(validateGate2SecurityReviewCohortResult(candidate, manifest, manifestSha256)).toBe(
      candidate,
    );

    observation.retrievalMetrics.precision = 1;
    observation.scenarioEvidenceSha256 = computeGate2SecurityReviewEvidenceDigest(observation);
    expect(() =>
      validateGate2SecurityReviewCohortResult(candidate, manifest, manifestSha256),
    ).toThrow();
  });

  it("rejects a manifest that rebinds a security case to a different evaluator", () => {
    const rebound = structuredClone(manifest);
    const firstOracle = requiredAt(GATE2_SECURITY_REVIEW_ORACLES, 0);
    const benchmarkCase = rebound.cases.find((entry) => entry.id === firstOracle.caseId);
    if (benchmarkCase === undefined) throw new Error("security fixture case missing");
    benchmarkCase.expectedOutcome.scenarioEvaluatorId = "replacement-evaluator";

    expect(() =>
      validateGate2SecurityReviewCohortResult(result(), rebound, manifestSha256),
    ).toThrow();
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
        parseAndValidateGate2SecurityReviewCohortResult(attack, manifest, manifestSha256),
      ).toThrow();
    }
  });
});
