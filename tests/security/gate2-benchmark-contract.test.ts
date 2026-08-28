// biome-ignore-all lint/suspicious/noExplicitAny: adversarial tests intentionally mutate untyped JSON contracts.
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  GATE2_CASE_IDS,
  MAX_GATE2_JSON_BYTES,
  parseStrictGate2Json,
  validateGate2BenchmarkManifest,
} from "../../scripts/gate2-benchmark-contract.mjs";

const manifestUrl = new URL("../../fixtures/evals/gate2/manifest.v1.json", import.meta.url);

async function loadManifest(): Promise<Record<string, any>> {
  return JSON.parse(await readFile(manifestUrl, "utf8")) as Record<string, any>;
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

  it("strict parsing rejects duplicate JSON members before JSON.parse can collapse them", async () => {
    const source = await readFile(manifestUrl, "utf8");
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
