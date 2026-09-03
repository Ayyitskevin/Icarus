// biome-ignore-all lint/suspicious/noExplicitAny: adversarial tests intentionally mutate untyped JSON contracts.
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { assertAllowedTarget } from "../../packages/core/src/policy.js";

import {
  GATE2_CASE_IDS,
  GATE2_CASE_IDS_BY_REVISION,
  GATE2_CURRENT_BENCHMARK_REVISION,
  GATE2_CURRENT_MANIFEST_PATH,
  GATE2_MANIFEST_PATHS_BY_SHA256,
  GATE2_MANIFEST_SHA256_BY_REVISION,
  GATE2_V2_MANIFEST_SHA256,
  GATE2_V3_MANIFEST_SHA256,
  GATE2_V4_MANIFEST_SHA256,
  MAX_GATE2_JSON_BYTES,
  describeNonStrictGate2Json,
  parseStrictGate2Json,
  sha256Raw,
  validateGate2BenchmarkManifest,
  validateGate2BenchmarkSuccessor,
} from "../../scripts/gate2-benchmark-contract.mjs";

const manifestV1Url = new URL("../../fixtures/evals/gate2/manifest.v1.json", import.meta.url);
const manifestV2Url = new URL("../../fixtures/evals/gate2/manifest.v2.json", import.meta.url);

async function loadManifest(url = manifestV1Url): Promise<Record<string, any>> {
  return JSON.parse(await readFile(url, "utf8")) as Record<string, any>;
}

function copy(value: Record<string, any>): Record<string, any> {
  return structuredClone(value);
}

describe("Gate 2 benchmark manifest contract", () => {
  it("accepts the committed closed 30-task contract", async () => {
    const manifest = await loadManifest();

    expect(validateGate2BenchmarkManifest(manifest)).toBe(manifest);
    expect(manifest.cases.map((entry: Record<string, unknown>) => entry.id)).toEqual(
      GATE2_CASE_IDS,
    );
  });

  it("accepts the immutable v2 successor only against the exact v1 bytes", async () => {
    const [successor, predecessorBytes] = await Promise.all([
      loadManifest(manifestV2Url),
      readFile(manifestV1Url),
    ]);
    const predecessorSha256 = sha256Raw(predecessorBytes);

    expect(validateGate2BenchmarkManifest(successor)).toBe(successor);
    expect(validateGate2BenchmarkSuccessor(successor, predecessorBytes)).toBe(successor);
    expect(successor.cases.map((entry: Record<string, unknown>) => entry.id)).toEqual(
      GATE2_CASE_IDS_BY_REVISION["gate2-thirty-task-v2-host-policy-compatible"],
    );
    expect(successor.supersedes.manifestSha256).toBe(predecessorSha256);
    for (const benchmarkCase of successor.cases) {
      for (const changedPath of benchmarkCase.expectedOutcome.expectedChangedPaths) {
        expect(assertAllowedTarget(changedPath)).toBe(changedPath);
      }
    }
  });

  it("rejects successor lineage drift and protected replacement targets", async () => {
    const [source, predecessorBytes] = await Promise.all([
      loadManifest(manifestV2Url),
      readFile(manifestV1Url),
    ]);

    const inheritedDrift = copy(source);
    inheritedDrift.cases[0].expectedContextPaths = ["AGENTS.md", "src/greeting.txt"];
    expect(() => validateGate2BenchmarkSuccessor(inheritedDrift, predecessorBytes)).toThrow(
      "28 unchanged cases",
    );

    const lineageDrift = copy(source);
    lineageDrift.replacements[0].predecessorCaseId = "repair-basic-greeting";
    expect(() => validateGate2BenchmarkManifest(lineageDrift)).toThrow("replacement lineage");

    const protectedTarget = copy(source);
    protectedTarget.cases[4].expectedOutcome.expectedChangedPaths = [
      "migrations/001_add_status.sql",
    ];
    expect(() => validateGate2BenchmarkManifest(protectedTarget)).toThrow(
      "ordinary PatchSet authority",
    );

    const replacementScopeDrift = copy(source);
    replacementScopeDrift.cases[4].repositoryId = "basic";
    replacementScopeDrift.cases[4].expectedContextPaths = ["AGENTS.md"];
    expect(() => validateGate2BenchmarkSuccessor(replacementScopeDrift, predecessorBytes)).toThrow(
      "replacement case drifted",
    );
  });

  it("rejects extra and missing members at every authority boundary", async () => {
    const source = await loadManifest();
    const rootExtra = copy(source);
    rootExtra.unreviewed = false;
    const rootMissing = copy(source);
    delete rootMissing.thresholds;
    const repositoryExtra = copy(source);
    repositoryExtra.repositories[0].remote = "github";
    const outcomeMissing = copy(source);
    delete outcomeMissing.cases[0].expectedOutcome.allowNoFinding;

    for (const attack of [rootExtra, rootMissing, repositoryExtra, outcomeMissing]) {
      expect(() => validateGate2BenchmarkManifest(attack)).toThrow("must contain exactly");
    }
  });

  it("rejects weakened counts, quality thresholds, and execution boundaries", async () => {
    const source = await loadManifest();
    const attacks = [
      ["thresholds", "taskCount", 29],
      ["thresholds", "minimumSuccessfulTasks", 23],
      ["thresholds", "minimumMacroRetrievalRecall", 0.89],
      ["thresholds", "minimumMacroRetrievalPrecision", 0.59],
      ["thresholds", "minimumDigestProvenanceCoverage", 0.99],
      ["thresholds", "minimumFirstPassPlanAcceptance", 0.79],
      ["thresholds", "maximumIncorrectEditsPerSuccess", 1],
      ["thresholds", "minimumRoutedCostReduction", 0.29],
      ["executionBoundary", "credentialReads", 1],
      ["executionBoundary", "remoteMutations", 1],
      ["executionBoundary", "mockedEvidenceCompletesGate", true],
    ] as const;

    for (const [section, key, value] of attacks) {
      const attack = copy(source);
      attack[section][key] = value;
      expect(() => validateGate2BenchmarkManifest(attack)).toThrow();
    }
  });

  it("rejects reordered, duplicate, or reclassified tasks", async () => {
    const source = await loadManifest();
    const reordered = copy(source);
    [reordered.cases[0], reordered.cases[1]] = [reordered.cases[1], reordered.cases[0]];
    const duplicate = copy(source);
    duplicate.cases[1].id = duplicate.cases[0].id;
    const reclassified = copy(source);
    reclassified.cases[0].class = "scaffold";

    for (const attack of [reordered, duplicate, reclassified]) {
      expect(() => validateGate2BenchmarkManifest(attack)).toThrow();
    }
  });

  it("rejects traversal, non-NFC, duplicate, unsorted, and unpinned context paths", async () => {
    const source = await loadManifest();
    const candidates = [
      "../outside",
      "/absolute",
      String.raw`src\alternate.py`,
      "src/cafe\u0301.py",
    ];
    for (const candidate of candidates) {
      const attack = copy(source);
      attack.cases[0].expectedContextPaths = [candidate];
      expect(() => validateGate2BenchmarkManifest(attack)).toThrow();
    }

    const duplicate = copy(source);
    duplicate.cases[0].expectedContextPaths = ["AGENTS.md", "AGENTS.md"];
    expect(() => validateGate2BenchmarkManifest(duplicate)).toThrow("sorted and unique");

    const unsorted = copy(source);
    unsorted.cases[0].expectedContextPaths = ["src/greeting.txt", "AGENTS.md"];
    expect(() => validateGate2BenchmarkManifest(unsorted)).toThrow("sorted and unique");

    const unpinned = copy(source);
    unpinned.cases[0].expectedContextPaths = ["not-pinned.txt"];
    expect(() => validateGate2BenchmarkManifest(unpinned)).toThrow("unpinned");
  });

  it("rejects repository revisions, file pins, and outcome topology drift", async () => {
    const source = await loadManifest();
    const revision = copy(source);
    revision.repositories[0].revisionSha256 = "0".repeat(64);
    const fileDigest = copy(source);
    fileDigest.repositories[0].files[0].sha256 = "f".repeat(64);
    const readOnlyMutation = copy(source);
    readOnlyMutation.cases[15].expectedOutcome.expectedChangedPaths = ["src/main.py"];
    const mutationFinding = copy(source);
    mutationFinding.cases[0].expectedOutcome.expectedFindingIds = ["invented"];
    const evaluatorDrift = copy(source);
    evaluatorDrift.cases[0].expectedOutcome.scenarioEvaluatorId = "different-evaluator";

    for (const attack of [
      revision,
      fileDigest,
      readOnlyMutation,
      mutationFinding,
      evaluatorDrift,
    ]) {
      expect(() => validateGate2BenchmarkManifest(attack)).toThrow();
    }
  });

  it("names the shape of a non-strict document so a frozen record can say why it failed", () => {
    // The revision-9 evidence recorded four unparseable candidates as "must be strict
    // JSON" and nothing more; one of them had stopped 728 characters into a
    // 728-character document, which is a truncated answer, not a malformed one. The
    // shape must be in the thrown message, in the same closed vocabulary the core
    // harness uses, and the scanner's specific refusals must stay verbatim.
    const truncated =
      '{"schemaVersion":1,"plan":{"mutationTargets":["a"]},"answer":{"files":[{"path":"a"}';
    expect(describeNonStrictGate2Json(truncated)).toBe("truncated");
    expect(describeNonStrictGate2Json("```json\n{}\n```")).toBe("markdown_fenced");
    expect(describeNonStrictGate2Json("I will now produce the JSON.\n{}")).toBe("leading_prose");
    expect(describeNonStrictGate2Json("   ")).toBe("empty");
    expect(describeNonStrictGate2Json('{"a": NaN}')).toBe("other");
    for (const [source, shape] of [
      [truncated, "truncated"],
      ["```json\n{}\n```", "markdown_fenced"],
      ["prose first {}", "leading_prose"],
      ["", "empty"],
    ] as const) {
      expect(() => parseStrictGate2Json(source)).toThrow(`manifest must be strict JSON (${shape})`);
    }
    // A specific scanner refusal is not overwritten by the generic shape.
    expect(() => parseStrictGate2Json('{"k":1,"k":2}')).toThrow("duplicate JSON object members");
    expect(() => parseStrictGate2Json('{"k":1,"k":2}')).not.toThrow("(other)");
  });

  it("strict parsing rejects duplicate JSON members before JSON.parse can collapse them", async () => {
    const source = await readFile(manifestV1Url, "utf8");
    const duplicate = source.replace(
      '"schemaVersion": 1,',
      '"schemaVersion": 1, "schemaVersion": 1,',
    );

    expect(() => parseStrictGate2Json(duplicate)).toThrow("duplicate JSON object members");
    expect(() => parseStrictGate2Json('{"value": NaN}')).toThrow();
    expect(() => parseStrictGate2Json(`"${"x".repeat(MAX_GATE2_JSON_BYTES)}"`)).toThrow(
      "JSON byte limit",
    );
  });
});

describe("Gate 2 strict-JSON shape vocabulary, edge cases from review", () => {
  it("classifies a truncated answer the same with or without a leading byte-order mark", () => {
    // `trim` strips U+FEFF; parsing the untrimmed source reported position 0 and lost
    // the one distinction the classifier exists to make.
    expect(describeNonStrictGate2Json('{"a": 1')).toBe("truncated");
    expect(describeNonStrictGate2Json('﻿{"a": 1')).toBe("truncated");
  });

  it("reports not_text through the parser, shaped like every other refusal", () => {
    expect(() => parseStrictGate2Json(null as unknown as string)).toThrow(
      /manifest must be strict JSON \(not_text\)$/,
    );
  });

  it("names one shape, first match first: fenced beats truncated", () => {
    expect(describeNonStrictGate2Json('```json\n{"a":')).toBe("markdown_fenced");
  });
});

describe("Gate 2 benchmark manifest v3 lineage", () => {
  const manifestV3Url = new URL("../../fixtures/evals/gate2/manifest.v3.json", import.meta.url);

  it("accepts the immutable v3 successor only against the exact v2 bytes", async () => {
    const [successor, predecessorBytes, successorBytes] = await Promise.all([
      loadManifest(manifestV3Url),
      readFile(manifestV2Url),
      readFile(manifestV3Url),
    ]);
    const predecessorSha256 = sha256Raw(predecessorBytes);

    expect(predecessorSha256).toBe(GATE2_V2_MANIFEST_SHA256);
    expect(sha256Raw(successorBytes)).toBe(GATE2_V3_MANIFEST_SHA256);
    expect(validateGate2BenchmarkManifest(successor)).toBe(successor);
    expect(validateGate2BenchmarkSuccessor(successor, predecessorBytes)).toBe(successor);
    expect(successor.cases.map((entry: Record<string, unknown>) => entry.id)).toEqual(
      GATE2_CASE_IDS_BY_REVISION["gate2-thirty-task-v3-task-entailed-targets"],
    );
    expect(
      successor.replacements.map((entry: Record<string, string>) => entry.successorCaseId),
    ).toEqual([
      "refactor-cart-money-extraction",
      "scaffold-parser-cli-check",
      "scaffold-json-output-mode",
    ]);
    for (const benchmarkCase of successor.cases) {
      for (const changedPath of benchmarkCase.expectedOutcome.expectedChangedPaths) {
        expect(assertAllowedTarget(changedPath)).toBe(changedPath);
      }
    }
    // v1 bytes are not v3's predecessor, even though they are a valid manifest.
    const v1Bytes = await readFile(manifestV1Url);
    expect(() => validateGate2BenchmarkSuccessor(successor, v1Bytes)).toThrow(
      "predecessor benchmarkRevision",
    );
  });

  it("digests the predecessor itself: an object cannot ride the real digest", async () => {
    const [successor, predecessorBytes] = await Promise.all([
      loadManifest(manifestV3Url),
      readFile(manifestV2Url),
    ]);
    const forgedObject = JSON.parse(predecessorBytes.toString("utf8"));
    forgedObject.cases.find(
      (entry: Record<string, unknown>) => entry.id === "refactor-cart-money-module",
    ).expectedOutcome.expectedChangedPaths = ["src/cart.py"];
    expect(() => validateGate2BenchmarkSuccessor(successor, forgedObject)).toThrow(
      "raw manifest bytes",
    );
    // The same forgery as bytes changes the digest, and the digest is what the lineage pins.
    const forgedBytes = predecessorBytes
      .toString("utf8")
      .replace('["src/cart.py", "src/money.py"]', '["src/cart.py"]');
    expect(() => validateGate2BenchmarkSuccessor(successor, forgedBytes)).toThrow(
      "predecessor manifest digest",
    );
    expect(GATE2_MANIFEST_SHA256_BY_REVISION[successor.benchmarkRevision]).toBe(
      GATE2_V3_MANIFEST_SHA256,
    );
  });

  it("maps every registered digest to bytes that hash to it", async () => {
    const entries = Object.entries(GATE2_MANIFEST_PATHS_BY_SHA256);
    expect(entries).toHaveLength(4);
    for (const [digest, relative] of entries) {
      const bytes = await readFile(new URL(`../../${relative}`, import.meta.url));
      expect(sha256Raw(bytes)).toBe(digest);
    }
  });

  it("rejects v3 lineage drift, unregistered revisions, and replaced identities", async () => {
    const [predecessor, source, predecessorBytes] = await Promise.all([
      loadManifest(manifestV2Url),
      loadManifest(manifestV3Url),
      readFile(manifestV2Url),
    ]);

    const unregistered = copy(source);
    unregistered.benchmarkRevision = "gate2-thirty-task-v4-unregistered";
    expect(() => validateGate2BenchmarkManifest(unregistered)).toThrow(
      "registered successor revision",
    );

    const inheritedDrift = copy(source);
    inheritedDrift.cases[0].expectedContextPaths = ["AGENTS.md", "src/greeting.txt"];
    expect(() => validateGate2BenchmarkSuccessor(inheritedDrift, predecessorBytes)).toThrow(
      "27 unchanged cases",
    );

    const lineageDrift = copy(source);
    lineageDrift.replacements[2].reason = "cosmetic";
    expect(() => validateGate2BenchmarkManifest(lineageDrift)).toThrow("replacement lineage");

    const fewerReplacements = copy(source);
    fewerReplacements.replacements.pop();
    expect(() => validateGate2BenchmarkManifest(fewerReplacements)).toThrow("replacements");

    const wrongPredecessorDigest = copy(source);
    wrongPredecessorDigest.supersedes.manifestSha256 = sha256Raw("not the v2 bytes");
    expect(() => validateGate2BenchmarkManifest(wrongPredecessorDigest)).toThrow(
      "supersedes.manifestSha256",
    );

    const retainedIdentity = copy(source);
    const cartIndex = source.cases.findIndex(
      (entry: Record<string, unknown>) => entry.id === "refactor-cart-money-extraction",
    );
    retainedIdentity.cases[cartIndex] = copy(
      predecessor.cases.find(
        (entry: Record<string, unknown>) => entry.id === "refactor-cart-money-module",
      ),
    );
    expect(() => validateGate2BenchmarkManifest(retainedIdentity)).toThrow("cases[");

    const successorDrift = copy(source);
    successorDrift.cases[cartIndex].expectedOutcome.expectedChangedPaths = ["src/cart.py"];
    expect(() => validateGate2BenchmarkSuccessor(successorDrift, predecessorBytes)).toThrow(
      "replacement case drifted at refactor-cart-money-extraction",
    );
  });
});

describe("Gate 2 benchmark manifest v4 lineage", () => {
  const manifestV3Url = new URL("../../fixtures/evals/gate2/manifest.v3.json", import.meta.url);
  const manifestV4Url = new URL("../../fixtures/evals/gate2/manifest.v4.json", import.meta.url);

  it("accepts the immutable v4 successor only against the exact v3 bytes, and v4 is current", async () => {
    const [successor, predecessorBytes, successorBytes] = await Promise.all([
      loadManifest(manifestV4Url),
      readFile(manifestV3Url),
      readFile(manifestV4Url),
    ]);
    expect(sha256Raw(predecessorBytes)).toBe(GATE2_V3_MANIFEST_SHA256);
    expect(sha256Raw(successorBytes)).toBe(GATE2_V4_MANIFEST_SHA256);
    expect(GATE2_CURRENT_BENCHMARK_REVISION).toBe(successor.benchmarkRevision);
    expect(GATE2_CURRENT_MANIFEST_PATH).toBe("fixtures/evals/gate2/manifest.v4.json");
    expect(GATE2_MANIFEST_SHA256_BY_REVISION[successor.benchmarkRevision]).toBe(
      GATE2_V4_MANIFEST_SHA256,
    );
    expect(validateGate2BenchmarkManifest(successor)).toBe(successor);
    expect(validateGate2BenchmarkSuccessor(successor, predecessorBytes)).toBe(successor);
    expect(successor.cases.map((entry: Record<string, unknown>) => entry.id)).toEqual(
      GATE2_CASE_IDS_BY_REVISION["gate2-thirty-task-v4-stated-contracts"],
    );
    expect(
      successor.replacements.map((entry: Record<string, string>) => entry.successorCaseId),
    ).toEqual([
      "repair-lantern-config-contract",
      "scaffold-greeting-command-check",
      "explain-task-schema-contract",
    ]);
    for (const benchmarkCase of successor.cases) {
      for (const changedPath of benchmarkCase.expectedOutcome.expectedChangedPaths) {
        expect(assertAllowedTarget(changedPath)).toBe(changedPath);
      }
    }
    // v2 bytes are two links down, not v4's predecessor.
    const v2Bytes = await readFile(manifestV2Url);
    expect(() => validateGate2BenchmarkSuccessor(successor, v2Bytes)).toThrow(
      "predecessor benchmarkRevision",
    );
  });

  it("rejects v4 lineage drift and a retained replaced identity", async () => {
    const [predecessor, source, predecessorBytes] = await Promise.all([
      loadManifest(manifestV3Url),
      loadManifest(manifestV4Url),
      readFile(manifestV3Url),
    ]);
    const inheritedDrift = copy(source);
    inheritedDrift.cases[0].expectedContextPaths = ["AGENTS.md", "src/greeting.txt"];
    expect(() => validateGate2BenchmarkSuccessor(inheritedDrift, predecessorBytes)).toThrow(
      "27 unchanged cases",
    );
    const lineageDrift = copy(source);
    lineageDrift.replacements[0].reason = "cosmetic";
    expect(() => validateGate2BenchmarkManifest(lineageDrift)).toThrow("replacement lineage");
    const index = source.cases.findIndex(
      (entry: Record<string, unknown>) => entry.id === "repair-lantern-config-contract",
    );
    const retainedIdentity = copy(source);
    retainedIdentity.cases[index] = copy(
      predecessor.cases.find(
        (entry: Record<string, unknown>) => entry.id === "repair-lantern-missing-config",
      ),
    );
    expect(() => validateGate2BenchmarkManifest(retainedIdentity)).toThrow("cases[");
    const successorDrift = copy(source);
    successorDrift.cases[index].expectedOutcome.expectedChangedPaths = ["src/config.py"];
    expect(() => validateGate2BenchmarkSuccessor(successorDrift, predecessorBytes)).toThrow(
      "replacement case drifted at repair-lantern-config-contract",
    );
  });
});
