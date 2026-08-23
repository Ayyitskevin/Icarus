import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { sha256 } from "../../packages/core/src/digest.js";
import type { LandingStatusV1 } from "../../packages/core/src/landing-ledger.js";
import type { LiveEvidenceCaseContext } from "../../packages/core/src/live-evidence-executor.js";
import {
  decodeLiveEvidenceCaseRunMapV1,
  ExistingRunsLiveEvidenceCaseDriver,
} from "../../packages/core/src/live-evidence-existing-runs-driver.js";
import {
  decodeLiveEvidenceProfileV1,
  LIVE_EVIDENCE_AUTHORIZED_EFFECTS,
  liveEvidenceProfileApprovalDigest,
} from "../../packages/core/src/live-evidence-profile.js";
import type { RunRecord } from "../../packages/core/src/types.js";

const manifestPath = "fixtures/evals/gate1/manifest.v1.json";
const manifestBytes = readFileSync(manifestPath);
const manifest = JSON.parse(manifestBytes.toString("utf8")) as {
  benchmarkId: string;
  benchmarkRevision: string;
  cases: Array<{
    id: string;
    repository: {
      githubOwner: string;
      githubRepository: string;
      baseBranch: string;
      sourceRevision: { commitSha1: string; treeSha1: string };
      derivativeEffects: { disclosureSha256: string };
    };
    task: { path: string; sha256: string };
    selectedPaths: string[];
    expectedChangedPaths: string[];
    checks: Array<{ id: string; name: string; argv: string[] }>;
    candidate: {
      commitEpochSeconds: number;
      commitMessage: string;
      commitIdentity: { name: string; email: string };
      candidateTreeSha1: string;
      candidateCommitSha1: string;
      candidateCommitPayloadSha256: string;
    };
  }>;
};

const RUN_IDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
] as const;

function firstOf<T>(values: readonly T[]): T {
  const value = values[0];
  if (value === undefined) throw new Error("fixture has no first entry");
  return value;
}

function profile() {
  const draft = {
    schemaVersion: 1 as const,
    profileId: "gate1-existing-runs-v1",
    benchmarkId: manifest.benchmarkId,
    benchmarkRevision: manifest.benchmarkRevision,
    offlineManifestDigest: sha256(manifestBytes),
    provider: {
      kind: "ollama" as const,
      model: "qwen3.8:27b",
      baseUrl: "http://127.0.0.1:11434/",
      adapterVersion: "production-ollama-api-chat-v1",
      inputUsdPerMillionTokens: null,
      outputUsdPerMillionTokens: null,
    },
    budgets: { maxSpendUsd: 0, maxRuntimeSeconds: 3600 },
    authorizedEffects: [...LIVE_EVIDENCE_AUTHORIZED_EFFECTS],
    cases: manifest.cases.map((entry) => ({
      caseId: entry.id,
      landingProfile: {
        version: 1 as const,
        provider: "github" as const,
        owner: entry.repository.githubOwner,
        repository: entry.repository.githubRepository,
        baseBranch: entry.repository.baseBranch,
        branchNamespace: "icarus/" as const,
        credentialRef: { kind: "environment" as const, name: "ICARUS_GITHUB_TOKEN_GATE1" },
        expectedActor: "icarus-gate1-benchmark",
        commitIdentity: entry.candidate.commitIdentity,
        derivativeEffects: {
          version: 1 as const,
          disposition: "inert-repository" as const,
          evidenceSha256: entry.repository.derivativeEffects.disclosureSha256,
        },
      },
    })),
  };
  return decodeLiveEvidenceProfileV1({
    ...draft,
    approval: {
      actor: "kevin",
      approvedAt: "2026-08-23T12:00:00.000Z",
      profileDigestSha256: liveEvidenceProfileApprovalDigest(draft),
    },
  });
}

function runMap(approved = profile()) {
  return decodeLiveEvidenceCaseRunMapV1(
    {
      schemaVersion: 1,
      profileId: approved.profileId,
      manifestSha256: sha256(manifestBytes),
      cases: manifest.cases.map((entry, index) => ({ caseId: entry.id, runId: RUN_IDS[index] })),
    },
    approved,
    manifestBytes,
  );
}

function landingStatus(state: LandingStatusV1["landing"]["state"]): LandingStatusV1 {
  const first = firstOf(manifest.cases);
  const landingProfile = firstOf(profile().cases).landingProfile;
  return {
    landing: {
      state,
      resumeState: state === "reconciliation_required" ? "objects_ready" : null,
      profile: landingProfile,
      baseCommitSha1: first.repository.sourceRevision.commitSha1,
      baseTreeSha1: first.repository.sourceRevision.treeSha1,
      commitEpochSeconds: first.candidate.commitEpochSeconds,
      commitMessage: first.candidate.commitMessage,
      candidateTreeSha1: first.candidate.candidateTreeSha1,
      candidateCommitSha1: first.candidate.candidateCommitSha1,
      candidateCommitPayloadSha256: first.candidate.candidateCommitPayloadSha256,
      landingSha256: "a".repeat(64),
      errorCode: state === "reconciliation_required" ? "GITHUB_OUTCOME_AMBIGUOUS" : null,
    },
    httpRequests:
      state === "reconciliation_required"
        ? ([
            { kind: "github.blob.post" },
            { kind: "github.ref.post" },
          ] as unknown as LandingStatusV1["httpRequests"])
        : [],
    receipt: null,
  } as LandingStatusV1;
}

function fixture(status: LandingStatusV1) {
  const approved = profile();
  const first = firstOf(manifest.cases);
  const firstPin = firstOf(approved.cases);
  const project = {
    id: "project-id",
    name: "gate1-typescript",
    checks: first.checks,
  };
  const run = {
    id: RUN_IDS[0],
    projectId: project.id,
    task: readFileSync(first.task.path, "utf8"),
    provider: {
      kind: approved.provider.kind,
      model: approved.provider.model,
      baseUrl: approved.provider.baseUrl,
      inputUsdPerMillionTokens: approved.provider.inputUsdPerMillionTokens,
      outputUsdPerMillionTokens: approved.provider.outputUsdPerMillionTokens,
    },
    state: "completed",
    baseCommit: first.repository.sourceRevision.commitSha1,
    plan: { targets: first.selectedPaths, checkIds: first.checks.map((check) => check.id) },
    verification: {
      outcome: "passed",
      changedPaths: first.expectedChangedPaths,
      checks: first.checks.map((check) => ({
        checkId: check.id,
        argv: check.argv,
        exitCode: 0,
        signal: null,
        truncated: false,
        outcome: "passed",
      })),
    },
    usage: { estimatedCostUsd: 0, activeRuntimeMs: 1_000 },
    createdAt: "2026-08-23T12:00:01.000Z",
    updatedAt: "2026-08-23T12:00:02.000Z",
  } as unknown as RunRecord;
  const service = {
    getRun: vi.fn(() => run),
    getProject: vi.fn(() => project),
    getProjectRepositoryStatus: vi.fn(async () => ({
      availability: "available",
      worktree: "clean",
      baseCommit: first.repository.sourceRevision.commitSha1,
      head: first.repository.sourceRevision.commitSha1,
      issue: null,
    })),
    getLandingProfile: vi.fn(() => ({ profile: firstPin.landingProfile })),
    getLandingStatus: vi.fn(() => status),
    prepareLanding: vi.fn(async () => status),
    decideLanding: vi.fn(async () => status),
    resumeLanding: vi.fn(async () => status),
  };
  const context = (mode: "start" | "resume"): LiveEvidenceCaseContext => ({
    resumeId: "44444444-4444-4444-8444-444444444444",
    mode,
    caseId: first.id,
    caseIndex: 0,
    profile: approved,
    casePin: firstPin,
    manifestBytes,
  });
  return {
    service,
    driver: new ExistingRunsLiveEvidenceCaseDriver(
      service as never,
      runMap(approved),
      manifestBytes,
    ),
    context,
  };
}

describe("existing-runs live-evidence driver", () => {
  it("strictly binds one distinct completed run per manifest-order case", () => {
    const approved = profile();
    expect(runMap(approved).cases.map((entry) => entry.caseId)).toEqual(
      manifest.cases.map((entry) => entry.id),
    );
    expect(() =>
      decodeLiveEvidenceCaseRunMapV1(
        {
          schemaVersion: 1,
          profileId: approved.profileId,
          manifestSha256: sha256(manifestBytes),
          cases: manifest.cases.map((entry) => ({ caseId: entry.id, runId: RUN_IDS[0] })),
        },
        approved,
        manifestBytes,
      ),
    ).toThrowError(/distinct run/);
  });

  it("authorizes only the next remote effect at a stable landing stage", async () => {
    const { driver, context, service } = fixture(landingStatus("local_ready"));
    const observed = await driver.observe(context("start"));
    expect(observed).toMatchObject({
      outcome: "ready",
      durableStage: "local_ready",
      effects: [],
      nextEffects: ["github.objects.upload"],
    });
    await driver.advance(context("start"), observed);
    expect(service.resumeLanding).toHaveBeenCalledTimes(1);
  });

  it("refuses a run created before the adapter-version approval", async () => {
    const { driver, context, service } = fixture(landingStatus("local_ready"));
    const current = service.getRun();
    service.getRun.mockReturnValue({
      ...current,
      createdAt: "2026-08-23T11:59:59.000Z",
    });
    await expect(driver.observe(context("start"))).resolves.toMatchObject({
      outcome: "blocked",
      durableStage: "case.preflight",
      errorCode: "LIVE_EVIDENCE_CASE_MISMATCH",
    });
  });

  it("does not count an operation that has no durable GitHub POST admission", async () => {
    const status = {
      ...landingStatus("reconciliation_required"),
      operations: [{ kind: "github.objects.upload" }] as unknown as LandingStatusV1["operations"],
      httpRequests: [],
    } as LandingStatusV1;
    const { driver, context } = fixture(status);
    await expect(driver.observe(context("start"))).resolves.toMatchObject({
      outcome: "blocked",
      effects: [],
      nextEffects: [],
    });
  });

  it("blocks ambiguity on the original invocation and permits read-based recovery only on resume", async () => {
    const status = landingStatus("reconciliation_required");
    const { driver, context } = fixture(status);
    await expect(driver.observe(context("start"))).resolves.toMatchObject({
      outcome: "blocked",
      effects: ["github.objects.upload", "github.ref.create.absent_only"],
      nextEffects: [],
    });
    await expect(driver.observe(context("resume"))).resolves.toMatchObject({
      outcome: "ready",
      effects: ["github.objects.upload", "github.ref.create.absent_only"],
      nextEffects: [],
    });
  });
});
