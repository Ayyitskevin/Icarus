import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { validateGate1BenchmarkManifest } from "../../scripts/gate1-benchmark-contract.mjs";
import {
  GATE1_FAILURE_REPORT_LIMITATION,
  GATE1_OFFLINE_REPORT_LIMITATIONS,
  validateGate1BenchmarkReport,
} from "../../scripts/gate1-benchmark-result-contract.mjs";

const manifestPath = new URL("../../fixtures/evals/gate1/manifest.v1.json", import.meta.url);
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const RUN_IDS = [
  "10000000-0000-4000-8000-000000000001",
  "20000000-0000-4000-8000-000000000002",
  "30000000-0000-4000-8000-000000000003",
] as const;

interface ManifestCheck {
  argv: string[];
  id: string;
}

interface ManifestCase {
  budgets: { maxCommandOutputBytes: number };
  candidate: Record<string, unknown> & {
    baseCommitSha1: string;
    baseTreeSha1: string;
    candidateCommitPayloadSha256: string;
    candidateCommitSha1: string;
    candidateObjectManifestSha256: string;
    candidateTreeSha1: string;
    objectFormat: string;
  };
  checks: ManifestCheck[];
  draftPullRequestEvidence: { schemaVersion: number };
  expectedChangedPaths: string[];
  id: string;
  modelAdapter: { adapterVersion: string; expectedRequests: number; model: string };
  prompt: { editInstructionsSha256: string; planInstructionsSha256: string };
  receiptEvidence: { schemaVersion: number };
  repository: {
    sourceRevision: { commitSha1: string; treeSha1: string };
    treeSha256: string;
  };
  restartRecovery: {
    expectedCredentialReads: number;
    expectedExternalNetworkRequests: number;
    expectedLocalRefOutcome: string;
    expectedLocalRefWrites: number;
    expectedRemoteMutations: number;
    injectionPoint: string;
  };
  sourceImmutability: { gitFingerprintFields: string[] };
  stack: string;
  task: { sha256: string };
}

interface Manifest extends Record<string, unknown> {
  benchmarkId: string;
  benchmarkRevision: string;
  cases: ManifestCase[];
  releaseGate: { requiredCaseCount: number };
  resultSchemaVersion: number;
}

interface CheckResult extends Record<string, unknown> {
  argv: string[];
  checkId: string;
  exitCode: number;
  outcome: string;
}

interface CaseResult extends Record<string, unknown> {
  baselineChecks: CheckResult[];
  candidate: Record<string, unknown>;
  draftPullRequest: Record<string, unknown>;
  effects: Record<string, number>;
  repair: Record<string, unknown> & { changedPaths: string[]; checks: CheckResult[] };
  receipt: Record<string, unknown>;
}

interface Report extends Record<string, unknown> {
  assessment: string;
  cases: CaseResult[];
  counts: Record<string, number>;
  effects: Record<string, number | string>;
  limitations: string[];
}

async function loadManifest(): Promise<{ digest: string; manifest: Manifest }> {
  const bytes = await readFile(manifestPath);
  const manifest = JSON.parse(bytes.toString("utf8")) as Manifest;
  validateGate1BenchmarkManifest(manifest);
  return {
    digest: createHash("sha256").update(bytes).digest("hex"),
    manifest,
  };
}

function checkResult(check: ManifestCheck, outcome: "failed" | "passed"): CheckResult {
  return {
    checkId: check.id,
    argv: [...check.argv],
    exitCode: outcome === "passed" ? 0 : 1,
    signal: null,
    stdoutBytes: 0,
    stdoutSha256: EMPTY_SHA256,
    stderrBytes: 0,
    stderrSha256: EMPTY_SHA256,
    truncated: false,
    outcome,
  };
}

function caseEffects(benchmarkCase: ManifestCase): Record<string, number> {
  return {
    paidProviderCalls: 0,
    credentialReads: benchmarkCase.restartRecovery.expectedCredentialReads,
    externalNetworkRequests: benchmarkCase.restartRecovery.expectedExternalNetworkRequests,
    remoteMutations: benchmarkCase.restartRecovery.expectedRemoteMutations,
    loopbackHttpRequests: benchmarkCase.modelAdapter.expectedRequests,
    gatewayInstances: benchmarkCase.modelAdapter.expectedRequests,
    localRefWrites: benchmarkCase.restartRecovery.expectedLocalRefWrites,
  };
}

function aggregateEffects(cases: readonly CaseResult[]): Record<string, number> {
  const aggregate = {
    paidProviderCalls: 0,
    credentialReads: 0,
    externalNetworkRequests: 0,
    remoteMutations: 0,
    loopbackHttpRequests: 0,
    gatewayInstances: 0,
    localRefWrites: 0,
  };
  for (const result of cases) {
    for (const key of Object.keys(aggregate) as (keyof typeof aggregate)[]) {
      aggregate[key] += result.effects[key] ?? 0;
    }
  }
  return aggregate;
}

function buildCase(benchmarkCase: ManifestCase, index: number): CaseResult {
  const runId = RUN_IDS[index];
  if (runId === undefined) throw new Error(`test lacks run ID ${index}`);
  const baselineChecks = benchmarkCase.checks.map((check, checkIndex) =>
    checkResult(check, checkIndex === 0 ? "failed" : "passed"),
  );
  const repairChecks = benchmarkCase.checks.map((check) => checkResult(check, "passed"));
  return {
    id: benchmarkCase.id,
    stack: benchmarkCase.stack,
    assessment: "contract_passed_gate1_live_evidence_not_run",
    source: {
      commitSha1: benchmarkCase.repository.sourceRevision.commitSha1,
      treeSha1: benchmarkCase.repository.sourceRevision.treeSha1,
      treeSha256: benchmarkCase.repository.treeSha256,
      unchanged: true,
      gitFingerprintFields: [...benchmarkCase.sourceImmutability.gitFingerprintFields],
      completeGitDirectorySnapshotUnchanged: true,
    },
    taskSha256: benchmarkCase.task.sha256,
    baselineChecks,
    repair: {
      runId,
      state: "completed",
      planSha256: "1".repeat(64),
      diffSha256: "2".repeat(64),
      checkpointSha256: "3".repeat(64),
      changedPaths: [...benchmarkCase.expectedChangedPaths],
      checks: repairChecks,
      provider: {
        adapterVersion: benchmarkCase.modelAdapter.adapterVersion,
        model: benchmarkCase.modelAdapter.model,
        loopbackRequests: benchmarkCase.modelAdapter.expectedRequests,
        instructionDigests: [
          benchmarkCase.prompt.planInstructionsSha256,
          benchmarkCase.prompt.editInstructionsSha256,
        ],
        requestDigests: Array.from({ length: benchmarkCase.modelAdapter.expectedRequests }, () =>
          "4".repeat(64),
        ),
      },
    },
    candidate: {
      objectFormat: benchmarkCase.candidate.objectFormat,
      baseCommitSha1: benchmarkCase.candidate.baseCommitSha1,
      baseTreeSha1: benchmarkCase.candidate.baseTreeSha1,
      candidateTreeSha1: benchmarkCase.candidate.candidateTreeSha1,
      candidateCommitSha1: benchmarkCase.candidate.candidateCommitSha1,
      candidateCommitPayloadSha256: benchmarkCase.candidate.candidateCommitPayloadSha256,
      candidateObjectManifestSha256: benchmarkCase.candidate.candidateObjectManifestSha256,
      diffByteEqual: true,
      headRef: `refs/heads/icarus/${runId}`,
      localRefOutcome: benchmarkCase.restartRecovery.expectedLocalRefOutcome,
      updateRefExitCode: 0,
      recoveredAfter: benchmarkCase.restartRecovery.injectionPoint,
      productionRuntimeReopened: true,
      durableRunRecovered: true,
      recoveryJournal: "benchmark_harness_only",
      duplicateReplayCode: "LANDING_LOCAL_REF_CONFLICT",
      localRefWrites: benchmarkCase.restartRecovery.expectedLocalRefWrites,
    },
    draftPullRequest: {
      status: "not_executed_contract_only",
      contractSchemaVersion: benchmarkCase.draftPullRequestEvidence.schemaVersion,
      remoteMutationPerformed: false,
    },
    receipt: {
      status: "not_executed_contract_only",
      schemaVersion: benchmarkCase.receiptEvidence.schemaVersion,
      runtimeRequiredForGate: true,
    },
    effects: caseEffects(benchmarkCase),
  };
}

function buildSuccess(manifest: Manifest, digest: string): Report {
  const cases = manifest.cases.map(buildCase);
  return {
    schemaVersion: manifest.resultSchemaVersion,
    benchmarkId: manifest.benchmarkId,
    benchmarkRevision: manifest.benchmarkRevision,
    manifestSha256: digest,
    assessment: "offline_contract_passed_gate1_incomplete",
    counts: {
      contractPassed: cases.length,
      failed: 0,
      liveEvidenceNotRun: manifest.releaseGate.requiredCaseCount,
    },
    effects: aggregateEffects(cases),
    cases,
    limitations: [...GATE1_OFFLINE_REPORT_LIMITATIONS],
  };
}

function buildFailure(
  manifest: Manifest,
  digest: string,
  stage: "aggregate_verification" | "case_execution" | "manifest_or_fixture_preflight",
  completedCount: number,
): Report {
  const report = buildSuccess(manifest, digest);
  report.assessment = "offline_contract_failed_gate1_incomplete";
  report.cases = report.cases.slice(0, completedCount);
  report.counts = {
    contractPassed: completedCount,
    failed: 1,
    liveEvidenceNotRun: manifest.releaseGate.requiredCaseCount,
  };
  report.effects = {
    status: "partial_completed_cases_only",
    ...aggregateEffects(report.cases),
  };
  report.failure = {
    stage,
    caseId: stage === "case_execution" ? (manifest.cases[completedCount]?.id ?? null) : null,
    code: "SANDBOX_UNAVAILABLE",
    messageSha256: "5".repeat(64),
  };
  report.limitations = [...GATE1_OFFLINE_REPORT_LIMITATIONS, GATE1_FAILURE_REPORT_LIMITATION];
  return report;
}

function copyReport(report: Report): Report {
  return structuredClone(report);
}

function reportCase(report: Report, index = 0): CaseResult {
  const result = report.cases[index];
  if (result === undefined) throw new Error(`test report lacks case ${index}`);
  return result;
}

function repairCheck(report: Report, index = 0): CheckResult {
  const result = reportCase(report).repair.checks[index];
  if (result === undefined) throw new Error(`test report lacks repair check ${index}`);
  return result;
}

function manifestCase(manifest: Manifest, index = 0): ManifestCase {
  const result = manifest.cases[index];
  if (result === undefined) throw new Error(`test manifest lacks case ${index}`);
  return result;
}

describe("Gate 1 benchmark result security contract", () => {
  it("accepts the closed success and all three failure-stage variants", async () => {
    const { digest, manifest } = await loadManifest();
    const success = buildSuccess(manifest, digest);
    const preflight = buildFailure(manifest, digest, "manifest_or_fixture_preflight", 0);
    const caseExecution = buildFailure(manifest, digest, "case_execution", 1);
    const aggregate = buildFailure(manifest, digest, "aggregate_verification", 3);

    expect(validateGate1BenchmarkReport(success, manifest, digest)).toBe(success);
    expect(validateGate1BenchmarkReport(preflight, null, digest)).toBe(preflight);
    expect(validateGate1BenchmarkReport(caseExecution, manifest, digest)).toBe(caseExecution);
    expect(validateGate1BenchmarkReport(aggregate, manifest, digest)).toBe(aggregate);
  });

  it("rejects extra or missing fields at top-level and nested boundaries", async () => {
    const { digest, manifest } = await loadManifest();
    const extra = copyReport(buildSuccess(manifest, digest));
    extra.releasePassed = true;
    const missing = copyReport(buildSuccess(manifest, digest));
    delete (missing as Record<string, unknown>).limitations;
    const nested = copyReport(buildSuccess(manifest, digest));
    reportCase(nested).candidate.cachePath = "/private/path";

    for (const attack of [extra, missing, nested]) {
      expect(() => validateGate1BenchmarkReport(attack, manifest, digest)).toThrow(
        "must contain exactly",
      );
    }
  });

  it("rejects assessment, identity, manifest-digest, and schema drift", async () => {
    const { digest, manifest } = await loadManifest();
    const assessment = copyReport(buildSuccess(manifest, digest));
    assessment.assessment = "gate1_complete";
    const identity = copyReport(buildSuccess(manifest, digest));
    identity.benchmarkId = "different";
    const manifestDigest = copyReport(buildSuccess(manifest, digest));
    manifestDigest.manifestSha256 = "0".repeat(64);
    const nullManifestDigest = copyReport(buildSuccess(manifest, digest));
    nullManifestDigest.manifestSha256 = null;
    const schema = copyReport(buildSuccess(manifest, digest));
    schema.schemaVersion = 2;

    for (const attack of [assessment, identity, manifestDigest, schema]) {
      expect(() => validateGate1BenchmarkReport(attack, manifest, digest)).toThrow();
    }
    expect(() => validateGate1BenchmarkReport(nullManifestDigest, manifest, null)).toThrow(
      "success requires",
    );
  });

  it("rejects case prefix, ordering, duplication, and count drift", async () => {
    const { digest, manifest } = await loadManifest();
    const missing = copyReport(buildSuccess(manifest, digest));
    missing.cases.pop();
    const reordered = copyReport(buildSuccess(manifest, digest));
    const first = reportCase(reordered, 0);
    const second = reportCase(reordered, 1);
    reordered.cases[0] = second;
    reordered.cases[1] = first;
    const duplicate = copyReport(buildSuccess(manifest, digest));
    duplicate.cases[1] = structuredClone(reportCase(duplicate));
    const count = copyReport(buildSuccess(manifest, digest));
    count.counts.contractPassed = 2;

    for (const attack of [missing, reordered, duplicate, count]) {
      expect(() => validateGate1BenchmarkReport(attack, manifest, digest)).toThrow();
    }
  });

  it("rejects weakened checks, changed paths, truncation, and false passing evidence", async () => {
    const { digest, manifest } = await loadManifest();
    const checkId = copyReport(buildSuccess(manifest, digest));
    repairCheck(checkId).checkId = "weaker-check";
    const changedPath = copyReport(buildSuccess(manifest, digest));
    reportCase(changedPath).repair.changedPaths = ["src/other.ts"];
    const truncated = copyReport(buildSuccess(manifest, digest));
    repairCheck(truncated).truncated = true;
    const falsePass = copyReport(buildSuccess(manifest, digest));
    repairCheck(falsePass).exitCode = 1;

    for (const attack of [checkId, changedPath, truncated, falsePass]) {
      expect(() => validateGate1BenchmarkReport(attack, manifest, digest)).toThrow();
    }
  });

  it("rejects candidate, ref, run, recovery, replay, and write-count drift", async () => {
    const { digest, manifest } = await loadManifest();
    const candidate = copyReport(buildSuccess(manifest, digest));
    reportCase(candidate).candidate.candidateCommitSha1 = "f".repeat(40);
    const ref = copyReport(buildSuccess(manifest, digest));
    reportCase(ref).candidate.headRef = "refs/heads/main";
    const run = copyReport(buildSuccess(manifest, digest));
    reportCase(run).repair.runId = "not-a-run";
    const recovery = copyReport(buildSuccess(manifest, digest));
    reportCase(recovery).candidate.productionRuntimeReopened = false;
    const replay = copyReport(buildSuccess(manifest, digest));
    reportCase(replay).candidate.duplicateReplayCode = null;
    const writes = copyReport(buildSuccess(manifest, digest));
    reportCase(writes).candidate.localRefWrites = 2;

    for (const attack of [candidate, ref, run, recovery, replay, writes]) {
      expect(() => validateGate1BenchmarkReport(attack, manifest, digest)).toThrow();
    }
  });

  it("rejects privileged, per-case, and aggregate effect drift", async () => {
    const { digest, manifest } = await loadManifest();
    const privileged = copyReport(buildSuccess(manifest, digest));
    reportCase(privileged).effects.remoteMutations = 1;
    const perCase = copyReport(buildSuccess(manifest, digest));
    reportCase(perCase).effects.gatewayInstances = 1;
    const aggregate = copyReport(buildSuccess(manifest, digest));
    aggregate.effects.loopbackHttpRequests = 5;

    for (const attack of [privileged, perCase, aggregate]) {
      expect(() => validateGate1BenchmarkReport(attack, manifest, digest)).toThrow();
    }
  });

  it("rejects promoted draft-PR or receipt evidence", async () => {
    const { digest, manifest } = await loadManifest();
    const draft = copyReport(buildSuccess(manifest, digest));
    reportCase(draft).draftPullRequest.status = "created";
    const remote = copyReport(buildSuccess(manifest, digest));
    reportCase(remote).draftPullRequest.remoteMutationPerformed = true;
    const receipt = copyReport(buildSuccess(manifest, digest));
    reportCase(receipt).receipt.status = "issued";

    for (const attack of [draft, remote, receipt]) {
      expect(() => validateGate1BenchmarkReport(attack, manifest, digest)).toThrow();
    }
  });

  it("rejects invalid failure topology, error identity, or limitations", async () => {
    const { digest, manifest } = await loadManifest();
    const stage = copyReport(buildFailure(manifest, digest, "case_execution", 1));
    (stage.failure as Record<string, unknown>).stage = "manifest_or_fixture_preflight";
    const caseId = copyReport(buildFailure(manifest, digest, "case_execution", 1));
    (caseId.failure as Record<string, unknown>).caseId = manifestCase(manifest).id;
    const code = copyReport(buildFailure(manifest, digest, "case_execution", 1));
    (code.failure as Record<string, unknown>).code = "unsafe-code";
    const message = copyReport(buildFailure(manifest, digest, "case_execution", 1));
    (message.failure as Record<string, unknown>).messageSha256 = "short";
    const limitation = copyReport(buildFailure(manifest, digest, "case_execution", 1));
    limitation.limitations.pop();

    for (const attack of [stage, caseId, code, message, limitation]) {
      expect(() => validateGate1BenchmarkReport(attack, manifest, digest)).toThrow();
    }
  });

  it("writes and validates a private closed failure report when manifest preflight fails", async () => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "icarus-gate1-report-test-"));
    try {
      const runnerPath = fileURLToPath(
        new URL("../../scripts/gate1-benchmark.mjs", import.meta.url),
      );
      const result = spawnSync(process.execPath, [runnerPath], {
        cwd: temporaryRoot,
        encoding: "utf8",
        env: {
          HOME: temporaryRoot,
          LANG: "C.UTF-8",
          LC_ALL: "C.UTF-8",
          PATH: "/usr/local/bin:/usr/bin:/bin",
        },
        maxBuffer: 1024 * 1024,
        shell: false,
        timeout: 30_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).toBe(1);

      const reportPath = path.join(temporaryRoot, ".local", "gate1-benchmark-report.json");
      const [bytes, metadata] = await Promise.all([readFile(reportPath), stat(reportPath)]);
      expect(metadata.isFile()).toBe(true);
      expect(metadata.nlink).toBe(1);
      expect(metadata.mode & 0o777).toBe(0o600);
      const report = JSON.parse(bytes.toString("utf8")) as Report;
      expect(validateGate1BenchmarkReport(report, null, null)).toBe(report);
      expect(report.assessment).toBe("offline_contract_failed_gate1_incomplete");
      expect(report.manifestSha256).toBeNull();
      expect(report.counts).toEqual({ contractPassed: 0, failed: 1, liveEvidenceNotRun: 3 });
      expect(report.failure).toMatchObject({
        stage: "manifest_or_fixture_preflight",
        caseId: null,
      });
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
