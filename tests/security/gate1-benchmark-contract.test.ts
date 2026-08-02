import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { validateGate1BenchmarkManifest } from "../../scripts/gate1-benchmark-contract.mjs";

const manifestPath = new URL("../../fixtures/evals/gate1/manifest.v1.json", import.meta.url);

interface MutableCheck extends Record<string, unknown> {
  argv: string[];
  id: string;
  name: string;
}

interface MutableRepositoryFile extends Record<string, unknown> {
  path: string;
  sha256: string;
}

interface MutableCase extends Record<string, unknown> {
  acceptance: {
    ciSuccessConditions: string[];
    failureConditions: string[];
    releaseSuccessConditions: string[];
  } & Record<string, unknown>;
  allowedChangedPaths: string[];
  budgets: {
    maxProviderCalls: number;
    maxRemoteMutations: number;
    maxToolCalls: number;
  } & Record<string, unknown>;
  candidate: {
    baseCommitSha1: string;
    branchNamespace: string;
    candidateCommitSha1: string;
    headRefTemplate: string;
  } & Record<string, unknown>;
  checks: MutableCheck[];
  draftPullRequestEvidence: {
    baseRef: string;
    expectedCandidateCommitSha1: string;
    headRefTemplate: string;
    owner: string;
  } & Record<string, unknown>;
  expectedChangedPaths: string[];
  receiptEvidence: {
    requiredFields: string[];
    runtimeRequiredForGate: boolean;
    syntheticReceiptCompletesGate: boolean;
  } & Record<string, unknown>;
  repository: {
    baseBranch: string;
    derivativeEffects: {
      assessmentSha256: string | null;
      disclosureSha256: string;
      liveAssessmentRequired: boolean;
    } & Record<string, unknown>;
    files: MutableRepositoryFile[];
    fixturePath: string;
    sourceRevision: {
      commitSha1: string;
      treeSha1: string;
    } & Record<string, unknown>;
  } & Record<string, unknown>;
  restartRecovery: {
    durableRecovery: string;
    expectedLocalRefWrites: number;
    expectedRemoteMutations: number;
    serverProcessRestart: string;
  } & Record<string, unknown>;
  sandbox: {
    image: string;
  } & Record<string, unknown>;
  selectedPaths: string[];
  stack: string;
  task: {
    encoding: string;
    path: string;
    sha256: string;
  } & Record<string, unknown>;
}

interface MutableManifest extends Record<string, unknown> {
  cases: MutableCase[];
  executionBoundary: {
    mockedEvidenceCompletesGate: boolean;
    remoteMutations: number;
  } & Record<string, unknown>;
  releaseGate: {
    failureConditions: string[];
    requiredSuccessCount: number;
    successConditions: string[];
  } & Record<string, unknown>;
}

async function loadManifest(): Promise<MutableManifest> {
  return JSON.parse(await readFile(manifestPath, "utf8")) as MutableManifest;
}

function copyManifest(value: MutableManifest): MutableManifest {
  return structuredClone(value);
}

function benchmarkCase(value: MutableManifest, index = 0): MutableCase {
  const entry = value.cases[index];
  if (entry === undefined) throw new Error(`test manifest lacks case ${index}`);
  return entry;
}

function firstCheck(value: MutableCase): MutableCheck {
  const check = value.checks[0];
  if (check === undefined) throw new Error("test manifest lacks a registered check");
  return check;
}

function alterHex(value: string): string {
  return `${value[0] === "0" ? "1" : "0"}${value.slice(1)}`;
}

describe("Gate 1 benchmark manifest security contract", () => {
  it("accepts the committed closed three-repository contract", async () => {
    const value = await loadManifest();

    expect(validateGate1BenchmarkManifest(value)).toBe(value);
  });

  it("rejects extra and missing keys at root and nested boundaries", async () => {
    const source = await loadManifest();
    const extra = copyManifest(source);
    extra.unreviewed = false;
    const missing = copyManifest(source);
    delete missing.benchmarkRevision;
    const nestedExtra = copyManifest(source);
    benchmarkCase(nestedExtra).repository.unreviewed = false;

    for (const attack of [extra, missing, nestedExtra]) {
      expect(() => validateGate1BenchmarkManifest(attack)).toThrow("must contain exactly");
    }
  });

  it("rejects duplicate or reordered stack coverage", async () => {
    const duplicate = await loadManifest();
    benchmarkCase(duplicate, 1).stack = benchmarkCase(duplicate, 0).stack;
    const reordered = await loadManifest();
    const first = benchmarkCase(reordered, 0);
    const second = benchmarkCase(reordered, 1);
    reordered.cases[0] = second;
    reordered.cases[1] = first;

    for (const attack of [duplicate, reordered]) {
      expect(() => validateGate1BenchmarkManifest(attack)).toThrow();
    }
  });

  it("rejects traversal, protected, non-NFC, duplicate, and escaped fixture paths", async () => {
    const source = await loadManifest();
    const attacks = [
      "../outside.txt",
      "package.json",
      "src/cafe\u0301.ts",
      "/absolute/path.ts",
      String.raw`src\alternate.ts`,
    ].map((candidate) => {
      const attack = copyManifest(source);
      const entry = benchmarkCase(attack);
      entry.selectedPaths = [candidate];
      entry.allowedChangedPaths = [candidate];
      entry.expectedChangedPaths = [candidate];
      return attack;
    });

    const escapedFixture = copyManifest(source);
    benchmarkCase(escapedFixture).repository.fixturePath = "fixtures/evals/other/repository";
    attacks.push(escapedFixture);

    const duplicateInventory = copyManifest(source);
    const repository = benchmarkCase(duplicateInventory).repository;
    const firstFile = repository.files[0];
    if (firstFile === undefined) throw new Error("test manifest lacks repository files");
    repository.files.splice(1, 0, structuredClone(firstFile));
    attacks.push(duplicateInventory);

    const protectedInventory = copyManifest(source);
    const protectedFile = benchmarkCase(protectedInventory).repository.files[0];
    if (protectedFile === undefined) throw new Error("test manifest lacks repository files");
    protectedFile.path = ".gitattributes";
    attacks.push(protectedInventory);

    for (const attack of attacks) {
      expect(() => validateGate1BenchmarkManifest(attack)).toThrow();
    }
  });

  it("rejects mutable revisions, malformed digests, and mutable sandbox images", async () => {
    const source = await loadManifest();
    const mutableRevision = copyManifest(source);
    benchmarkCase(mutableRevision).repository.sourceRevision.commitSha1 = "main";
    const malformedDigest = copyManifest(source);
    benchmarkCase(malformedDigest).task.sha256 = "A".repeat(64);
    const mutableImage = copyManifest(source);
    benchmarkCase(mutableImage).sandbox.image = "node:22";

    for (const attack of [mutableRevision, malformedDigest, mutableImage]) {
      expect(() => validateGate1BenchmarkManifest(attack)).toThrow();
    }
  });

  it("rejects missing, duplicate, oversized, shell, and evaluator check profiles", async () => {
    const source = await loadManifest();
    const empty = copyManifest(source);
    benchmarkCase(empty).checks = [];
    const duplicate = copyManifest(source);
    const duplicateCase = benchmarkCase(duplicate);
    duplicateCase.checks.push(structuredClone(firstCheck(duplicateCase)));
    const oversized = copyManifest(source);
    firstCheck(benchmarkCase(oversized)).argv = ["node", "x".repeat(4_097)];
    const shell = copyManifest(source);
    firstCheck(benchmarkCase(shell)).argv = ["sh", "-c", "printf marker"];
    const nodeEval = copyManifest(source);
    firstCheck(benchmarkCase(nodeEval)).argv = ["node", "--eval", "process.exit(0)"];
    const pythonEval = copyManifest(source);
    firstCheck(benchmarkCase(pythonEval)).argv = ["python3", "-c", "print(0)"];
    const packageWrapper = copyManifest(source);
    firstCheck(benchmarkCase(packageWrapper)).argv = ["pnpm", "test"];
    const safeButWeakened = copyManifest(source);
    firstCheck(benchmarkCase(safeButWeakened)).argv = ["node", "--version"];

    for (const attack of [
      empty,
      duplicate,
      oversized,
      shell,
      nodeEval,
      pythonEval,
      packageWrapper,
      safeButWeakened,
    ]) {
      expect(() => validateGate1BenchmarkManifest(attack)).toThrow();
    }
  });

  it("rejects budget, execution-effect, and derivative-effect widening", async () => {
    const source = await loadManifest();
    const providerCalls = copyManifest(source);
    benchmarkCase(providerCalls).budgets.maxProviderCalls = 3;
    const remoteBudget = copyManifest(source);
    benchmarkCase(remoteBudget).budgets.maxRemoteMutations = 1;
    const hostCeiling = copyManifest(source);
    benchmarkCase(hostCeiling).budgets.maxToolCalls = 41;
    const remoteExecution = copyManifest(source);
    remoteExecution.executionBoundary.remoteMutations = 1;
    const mockedEvidence = copyManifest(source);
    mockedEvidence.executionBoundary.mockedEvidenceCompletesGate = true;
    const derivative = copyManifest(source);
    benchmarkCase(derivative).repository.derivativeEffects.liveAssessmentRequired = false;
    const selfAssertedAssessment = copyManifest(source);
    benchmarkCase(selfAssertedAssessment).repository.derivativeEffects.assessmentSha256 =
      "0".repeat(64);

    for (const attack of [
      providerCalls,
      remoteBudget,
      hostCeiling,
      remoteExecution,
      mockedEvidence,
      derivative,
      selfAssertedAssessment,
    ]) {
      expect(() => validateGate1BenchmarkManifest(attack)).toThrow();
    }
  });

  it("rejects repository, candidate branch, and draft-PR identity drift", async () => {
    const source = await loadManifest();
    const baseBranch = copyManifest(source);
    benchmarkCase(baseBranch).repository.baseBranch = "trunk";
    const candidateBase = copyManifest(source);
    const candidate = benchmarkCase(candidateBase).candidate;
    candidate.baseCommitSha1 = alterHex(candidate.baseCommitSha1);
    const branchNamespace = copyManifest(source);
    benchmarkCase(branchNamespace).candidate.branchNamespace = "assessment/";
    const prOwner = copyManifest(source);
    benchmarkCase(prOwner).draftPullRequestEvidence.owner = "different-owner";
    const prBase = copyManifest(source);
    benchmarkCase(prBase).draftPullRequestEvidence.baseRef = "refs/heads/trunk";
    const prCandidate = copyManifest(source);
    const evidence = benchmarkCase(prCandidate).draftPullRequestEvidence;
    evidence.expectedCandidateCommitSha1 = alterHex(evidence.expectedCandidateCommitSha1);

    for (const attack of [
      baseBranch,
      candidateBase,
      branchNamespace,
      prOwner,
      prBase,
      prCandidate,
    ]) {
      expect(() => validateGate1BenchmarkManifest(attack)).toThrow();
    }
  });

  it("rejects weakened reload and process-restart recovery", async () => {
    const source = await loadManifest();
    const noRotation = copyManifest(source);
    benchmarkCase(noRotation).restartRecovery.serverProcessRestart = "retains-old-authority";
    const noDurability = copyManifest(source);
    benchmarkCase(noDurability).restartRecovery.durableRecovery = "memory-only";
    const duplicateRef = copyManifest(source);
    benchmarkCase(duplicateRef).restartRecovery.expectedLocalRefWrites = 2;
    const remoteEffect = copyManifest(source);
    benchmarkCase(remoteEffect).restartRecovery.expectedRemoteMutations = 1;

    for (const attack of [noRotation, noDurability, duplicateRef, remoteEffect]) {
      expect(() => validateGate1BenchmarkManifest(attack)).toThrow();
    }
  });

  it("rejects receipt, acceptance, and three-of-three success drift", async () => {
    const source = await loadManifest();
    const receiptField = copyManifest(source);
    benchmarkCase(receiptField).receiptEvidence.requiredFields.pop();
    const syntheticReceipt = copyManifest(source);
    benchmarkCase(syntheticReceipt).receiptEvidence.syntheticReceiptCompletesGate = true;
    const noRuntimeReceipt = copyManifest(source);
    benchmarkCase(noRuntimeReceipt).receiptEvidence.runtimeRequiredForGate = false;
    const caseSuccess = copyManifest(source);
    benchmarkCase(caseSuccess).acceptance.releaseSuccessConditions.pop();
    const releaseSuccess = copyManifest(source);
    releaseSuccess.releaseGate.successConditions.pop();
    const releaseFailure = copyManifest(source);
    releaseFailure.releaseGate.failureConditions.reverse();
    const twoOfThree = copyManifest(source);
    twoOfThree.releaseGate.requiredSuccessCount = 2;

    for (const attack of [
      receiptField,
      syntheticReceipt,
      noRuntimeReceipt,
      caseSuccess,
      releaseSuccess,
      releaseFailure,
      twoOfThree,
    ]) {
      expect(() => validateGate1BenchmarkManifest(attack)).toThrow();
    }
  });
});
