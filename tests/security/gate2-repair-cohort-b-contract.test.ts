// biome-ignore-all lint/suspicious/noExplicitAny: adversarial tests intentionally mutate untyped JSON contracts.
import { beforeAll, describe, expect, it } from "vitest";

import type { Gate2BenchmarkManifest } from "../../scripts/gate2-benchmark-contract.mjs";
import { loadGate2BenchmarkContract } from "../../scripts/gate2-benchmark-contract.mjs";
import {
  computeGate2RepairBEvidenceDigest,
  GATE2_REPAIR_B_COHORT_LIMITATIONS,
  GATE2_REPAIR_B_ORACLES,
  GATE2_REPAIR_B_PROVIDER,
  parseAndValidateGate2RepairBCohortResult,
  validateGate2RepairBCohortResult,
} from "../../scripts/gate2-repair-cohort-b-contract.mjs";

const repositoryRoot = new URL("../../", import.meta.url);
const manifestUrl = new URL("../../fixtures/evals/gate2/manifest.v1.json", import.meta.url);
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

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

function check(
  id: string,
  argv: readonly string[],
  outcome: "passed" | "failed",
  exitCode: number,
): Record<string, any> {
  return {
    checkId: id,
    argv: [...argv],
    exitCode,
    signal: null,
    stdoutBytes: 0,
    stdoutSha256: EMPTY_SHA256,
    stderrBytes: outcome === "failed" ? 100 : 0,
    stderrSha256: outcome === "failed" ? "9".repeat(64) : EMPTY_SHA256,
    truncated: false,
    outcome,
  };
}

function result(): Record<string, any> {
  const repositories = new Map(
    manifest.repositories.map((repository: Record<string, any>) => [repository.id, repository]),
  );
  const cases = new Map(
    manifest.cases.map((benchmarkCase: Record<string, any>) => [benchmarkCase.id, benchmarkCase]),
  );
  const observations = GATE2_REPAIR_B_ORACLES.map((oracle, index) => {
    const benchmarkCase = cases.get(oracle.caseId) as Record<string, any>;
    const repository = repositories.get(benchmarkCase.repositoryId) as Record<string, any>;
    const digests = new Map(
      repository.files.map((file: Record<string, string>) => [file.path, file.sha256]),
    );
    const expectedChangedPaths = benchmarkCase.expectedOutcome.expectedChangedPaths as string[];
    const operatorSelectedTargets = [...expectedChangedPaths].sort((left, right) =>
      left.localeCompare(right),
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
      provider: {
        ...GATE2_REPAIR_B_PROVIDER,
        loopbackRequests: 2,
        instructionDigests: [...GATE2_REPAIR_B_PROVIDER.instructionDigests],
        requestDigests: ["c".repeat(64), "d".repeat(64)],
      },
      selectedContext: benchmarkCase.expectedContextPaths.map((filePath: string) => ({
        path: filePath,
        sha256: digests.get(filePath),
      })),
      retrievalMetrics: { recall: 1, precision: 1, digestProvenanceCoverage: 1 },
      targetAuthority: "operator_selected_expected_changed_paths",
      plan: {
        firstPassAccepted: true,
        operatorSelectedTargets,
        approvedTargets: [...benchmarkCase.expectedOutcome.expectedChangedPaths],
        checkIds: [oracle.check.id],
        planSha256: "e".repeat(64),
        autonomousTargetDiscoveryMeasured: false,
      },
      baseline: {
        outcome: oracle.baselineOutcome,
        checks: [
          check(
            oracle.check.id,
            oracle.check.argv,
            oracle.baselineOutcome,
            oracle.baselineOutcome === "passed" ? 0 : 1,
          ),
        ],
      },
      mutation: {
        runId: "00000000-0000-4000-8000-000000000001",
        state: "completed",
        patchSetSha256: "f".repeat(64),
        diffSha256: "1".repeat(64),
        checkpointSha256: "2".repeat(64),
        changedPaths: [...benchmarkCase.expectedOutcome.expectedChangedPaths],
        checks: [check(oracle.check.id, oracle.check.argv, "passed", 0)],
        finalFiles: oracle.approvedFiles.map((file) => ({
          path: file.path,
          sha256: file.sha256,
        })),
        privateWorkspaceMutated: true,
      },
      usage: {
        toolCalls: 2,
        inputTokens: oracle.inputTokens,
        outputTokens: oracle.outputTokens,
        estimatedCostUsd: 0,
        reservedCostUsd: 0,
      },
      sourceCheckoutUnchanged: true,
      sourceGitDirectoryUnchanged: true,
      durableRunRecovered: true,
      scenarioEvidenceSha256: "",
    };
    observation.scenarioEvidenceSha256 = computeGate2RepairBEvidenceDigest(observation);
    return observation;
  });
  return {
    schemaVersion: 1,
    benchmarkId: manifest.benchmarkId,
    benchmarkRevision: manifest.benchmarkRevision,
    manifestSha256,
    cohortClass: "repair",
    evaluatorRevision: "deterministic-production-lifecycle-v1",
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
    planAggregate: {
      firstPassAcceptedCases: observations.length,
      firstPassAcceptanceRate: 1,
      autonomousTargetDiscoveryMeasured: false,
      targetAuthority: "operator_selected_expected_changed_paths",
    },
    effects: {
      providerCalls: 8,
      loopbackProviderRequests: 8,
      externalNetworkRequests: 0,
      remoteMutations: 0,
      sourceCheckoutMutations: 0,
      privateWorkspaceMutations: 4,
      sandboxCheckExecutions: 8,
      icarusRegisteredCheckExecutions: 4,
      liveDatabaseConnections: 0,
      offlineInMemoryDatabaseChecks: 0,
      temporaryGitFixtureSetup: true,
      runtimeReopens: 4,
    },
    effectEvidence: {
      providerCalls: "observed",
      loopbackProviderRequests: "observed",
      externalNetworkRequests: "design-assertion",
      remoteMutations: "design-assertion",
      sourceCheckoutMutations: "observed",
      privateWorkspaceMutations: "observed",
      sandboxCheckExecutions: "observed",
      icarusRegisteredCheckExecutions: "observed",
      liveDatabaseConnections: "design-assertion",
      offlineInMemoryDatabaseChecks: "design-assertion",
      temporaryGitFixtureSetup: "observed",
      runtimeReopens: "observed",
    },
    observations,
    limitations: [...GATE2_REPAIR_B_COHORT_LIMITATIONS],
    assessment: "deterministic_repair_cohort_b_passed_gate2_incomplete",
  };
}

function requiredAt<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error(`missing fixture entry at index ${index}`);
  return value;
}

describe("Gate 2 repair cohort B result contract", () => {
  it("accepts exactly the four manifest-bound production-lifecycle observations", () => {
    const candidate = result();
    expect(validateGate2RepairBCohortResult(candidate, manifest, manifestSha256)).toBe(candidate);
    expect(candidate.observations.map((entry: Record<string, any>) => entry.caseId)).toEqual(
      GATE2_REPAIR_B_ORACLES.map((entry) => entry.caseId),
    );
  });

  it("rejects widened effects, false completion, forged counts, shapes, and limitations", () => {
    const attacks = [result(), result(), result(), result(), result(), result()];
    requiredAt(attacks, 0).effects.externalNetworkRequests = 1;
    requiredAt(attacks, 1).counts.unexecutedCases = 0;
    requiredAt(attacks, 2).planAggregate.autonomousTargetDiscoveryMeasured = true;
    requiredAt(attacks, 3).observations.push(requiredAt(attacks, 3).observations[0]);
    requiredAt(attacks, 4).limitations = [];
    requiredAt(attacks, 5).gate2Complete = true;
    for (const attack of attacks) {
      expect(() => validateGate2RepairBCohortResult(attack, manifest, manifestSha256)).toThrow();
    }
  });

  it("rejects changed authority, plans, checks, final bytes, durability, and evidence", () => {
    const attacks = [result(), result(), result(), result(), result(), result(), result()];
    requiredAt(attacks, 0).observations[0].targetAuthority = "model_selected";
    requiredAt(attacks, 1).observations[0].plan.approvedTargets = ["README.md"];
    requiredAt(attacks, 2).observations[0].baseline.outcome = "passed";
    requiredAt(attacks, 3).observations[0].mutation.changedPaths.push("README.md");
    requiredAt(attacks, 4).observations[0].mutation.finalFiles[0].sha256 = "0".repeat(64);
    requiredAt(attacks, 5).observations[0].durableRunRecovered = false;
    requiredAt(attacks, 6).observations[0].scenarioEvidenceSha256 = "0".repeat(64);
    for (const attack of attacks) {
      expect(() => validateGate2RepairBCohortResult(attack, manifest, manifestSha256)).toThrow();
    }
  });

  it("accepts extra eligible context only with honestly recomputed retrieval metrics", () => {
    const candidate = result();
    const observation = candidate.observations[1] as Record<string, any>;
    const repository = manifest.repositories.find((entry) => entry.id === observation.repositoryId);
    const extra = repository?.files.find(
      (entry) => !observation.selectedContext.some((selected: any) => selected.path === entry.path),
    );
    if (extra === undefined) throw new Error("fixture has no eligible extra source");
    const benchmarkCase = manifest.cases.find((entry) => entry.id === observation.caseId);
    if (benchmarkCase === undefined) throw new Error("repair fixture case missing");
    observation.selectedContext.push({ path: extra.path, sha256: extra.sha256 });
    observation.retrievalMetrics.precision =
      benchmarkCase.expectedContextPaths.length / observation.selectedContext.length;
    observation.scenarioEvidenceSha256 = computeGate2RepairBEvidenceDigest(observation);
    candidate.retrievalAggregate.macroPrecision =
      candidate.observations.reduce(
        (sum: number, entry: Record<string, any>) => sum + entry.retrievalMetrics.precision,
        0,
      ) / candidate.observations.length;

    expect(validateGate2RepairBCohortResult(candidate, manifest, manifestSha256)).toBe(candidate);
    observation.retrievalMetrics.precision = 1;
    observation.scenarioEvidenceSha256 = computeGate2RepairBEvidenceDigest(observation);
    expect(() => validateGate2RepairBCohortResult(candidate, manifest, manifestSha256)).toThrow();
  });

  it("rejects a manifest that rebinds a repair case to another evaluator", () => {
    const rebound = structuredClone(manifest);
    const benchmarkCase = rebound.cases.find(
      (entry) => entry.id === GATE2_REPAIR_B_ORACLES[0]?.caseId,
    );
    if (benchmarkCase === undefined) throw new Error("repair fixture case missing");
    benchmarkCase.expectedOutcome.scenarioEvaluatorId = "replacement-evaluator";
    expect(() => validateGate2RepairBCohortResult(result(), rebound, manifestSha256)).toThrow();
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
        parseAndValidateGate2RepairBCohortResult(attack, manifest, manifestSha256),
      ).toThrow();
    }
  });
});
