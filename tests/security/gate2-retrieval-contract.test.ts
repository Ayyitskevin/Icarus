import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  GATE2_RETRIEVAL_LIMITATIONS,
  type Gate2RetrievalManifest,
  validateGate2RetrievalManifest,
  validateGate2RetrievalResult,
} from "../../scripts/gate2-retrieval-contract.mjs";

const manifestPath = new URL(
  "../../fixtures/evals/gate2/retrieval-manifest.v1.json",
  import.meta.url,
);

async function manifest(): Promise<Gate2RetrievalManifest> {
  return JSON.parse(await readFile(manifestPath, "utf8")) as Gate2RetrievalManifest;
}

function result(value: Gate2RetrievalManifest) {
  const selectedPaths = value.case.expectedPaths;
  const digestByPath = new Map(
    value.case.repository.files.map((entry) => [entry.path, entry.sha256] as const),
  );
  return {
    schemaVersion: 1,
    benchmarkId: value.benchmarkId,
    benchmarkRevision: value.benchmarkRevision,
    manifestSha256: "f".repeat(64),
    generatedAt: "2026-08-27T00:00:00.000Z",
    passed: true,
    case: {
      id: value.case.id,
      baseCommit: value.case.repository.commitSha1,
      treeSha1: value.case.repository.treeSha1,
      retrievalDigestSha256: "a".repeat(64),
      repositoryDigestSha256: "b".repeat(64),
      selectedPaths,
      provenance: selectedPaths.map((entry: string) => ({
        path: entry,
        sha256: digestByPath.get(entry),
        lineCount: 1,
        matches: [{ term: "lantern", lines: [1] }],
      })),
      recall: 1,
      precision: 1,
      sourceCheckoutUnchanged: true,
      workspaceUnchanged: true,
      effects: {
        providerCalls: 0,
        networkRequests: 0,
        repositoryMutations: 0,
        registeredCommands: 0,
      },
      passed: true,
    },
    limitations: [...GATE2_RETRIEVAL_LIMITATIONS],
  };
}

function firstFile(value: Gate2RetrievalManifest): { path: string; sha256: string } {
  const entry = value.case.repository.files[0];
  if (entry === undefined) throw new Error("manifest has no repository files");
  return entry;
}

describe("Gate 2 retrieval benchmark contract", () => {
  it("accepts the committed retrieval-only manifest and a threshold-derived result", async () => {
    const value = await manifest();
    expect(validateGate2RetrievalManifest(value)).toBe(value);
    const measured = result(value);
    expect(validateGate2RetrievalResult(measured, value, "f".repeat(64))).toBe(measured);
  });

  it("rejects unknown fields and widened execution or claim boundaries", async () => {
    const extra = await manifest();
    Object.assign(extra, { unreviewed: true });
    const network = await manifest();
    network.executionBoundary.networkRequests = 1;
    const explanation = await manifest();
    explanation.executionBoundary.measuresExplanationCompletion = true;
    const claim = await manifest();
    claim.case.claimBoundary = "explanation_supported";

    for (const attack of [extra, network, explanation, claim]) {
      expect(() => validateGate2RetrievalManifest(attack)).toThrow();
    }
  });

  it("rejects traversal, inventory drift, malformed digests, and reordered expectations", async () => {
    const traversal = await manifest();
    firstFile(traversal).path = "../README.md";
    const malformedDigest = await manifest();
    malformedDigest.case.task.sha256 = "A".repeat(64);
    const inventoryOrder = await manifest();
    inventoryOrder.case.repository.files.reverse();
    const expectedOrder = await manifest();
    expectedOrder.case.expectedPaths.reverse();

    for (const attack of [traversal, malformedDigest, inventoryOrder, expectedOrder]) {
      expect(() => validateGate2RetrievalManifest(attack)).toThrow();
    }
  });

  it("rejects budget and threshold weakening", async () => {
    const excessFiles = await manifest();
    excessFiles.case.retrievalBudget.maxFiles = 64;
    const scanMismatch = await manifest();
    scanMismatch.case.retrievalBudget.maxTotalBytes = 4097;
    const recall = await manifest();
    recall.case.thresholds.minimumRecall = 0.5;

    for (const attack of [excessFiles, scanMismatch, recall]) {
      expect(() => validateGate2RetrievalManifest(attack)).toThrow();
    }
  });

  it("rejects forged result quality, provenance, effects, and limitations", async () => {
    const value = await manifest();
    const forgedRecall = result(value);
    forgedRecall.case.recall = 0.5;
    const missingProvenance = result(value);
    const firstProvenance = missingProvenance.case.provenance[0];
    if (firstProvenance === undefined) throw new Error("result has no provenance");
    firstProvenance.lineCount = 0;
    const effect = result(value);
    effect.case.effects.providerCalls = 1;
    const widenedClaim = result(value);
    widenedClaim.limitations = [];

    for (const attack of [forgedRecall, missingProvenance, effect, widenedClaim]) {
      expect(() => validateGate2RetrievalResult(attack, value, "f".repeat(64))).toThrow();
    }
  });
});
