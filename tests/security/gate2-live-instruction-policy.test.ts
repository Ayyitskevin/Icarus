import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import {
  buildGate2LiveCandidateInput,
  buildGate2LiveInstructions,
  GATE2_LIVE_INSTRUCTION_POLICY,
  GATE2_LIVE_INSTRUCTION_POLICY_SHA256,
} from "../../scripts/gate2-live-instruction-policy.mjs";

describe("Gate 2 live instruction policy", () => {
  it("binds one target-independent policy for every case in a class", () => {
    expect(GATE2_LIVE_INSTRUCTION_POLICY_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(GATE2_LIVE_INSTRUCTION_POLICY.generation).toEqual({
      temperature: 0,
      maxTokens: 8192,
      // ADR 0070: digest-bound, so a rerun cannot silently restore the combined
      // reasoning-plus-content budget the recorded thresholds were never measured under.
      think: false,
    });
    expect(buildGate2LiveInstructions("scaffold", "mutation")).toBe(
      buildGate2LiveInstructions("scaffold", "mutation"),
    );
    expect(buildGate2LiveInstructions("security_review", "read_only")).not.toContain(
      "src/files.py",
    );
    expect(buildGate2LiveInstructions("scaffold", "mutation")).not.toContain(
      "tests/test_json_output.py",
    );
    const combined = [
      buildGate2LiveInstructions("scaffold", "mutation"),
      buildGate2LiveInstructions("refactor", "mutation"),
      buildGate2LiveInstructions("repair", "mutation"),
      buildGate2LiveInstructions("security_review", "read_only"),
    ].join("\n");
    for (const benchmarkShapedFragment of [
      "../outside",
      "src/",
      "tests/",
      "checks/",
      ".py",
      ".sql",
      "expected-answer",
      "configuration trust",
      "dynamic execution",
      "schema-versus-live-state",
      "concrete source-code vulnerability",
      "evaluator/check files",
    ]) {
      expect(combined).not.toContain(benchmarkShapedFragment);
    }
    expect(buildGate2LiveInstructions("scaffold", "mutation")).toContain(
      "Do not repair unrelated defects",
    );
    expect(buildGate2LiveInstructions("security_review", "read_only")).toContain(
      "Follow only the implemented data or control flow relevant to the task",
    );
    expect(buildGate2LiveInstructions("scaffold", "mutation")).not.toContain('"steps"');
    // Revision 10: the two classes that scored 0/5 in both revision-9 arms had no class
    // guidance at all; six of their ten misses were target selection, not capability.
    expect(buildGate2LiveInstructions("refactor", "mutation")).toContain(
      "creates that module as a new file",
    );
    expect(buildGate2LiveInstructions("repair", "mutation")).toContain(
      "the deliverable is the check that proves it",
    );
    expect(buildGate2LiveInstructions("explanation", "read_only")).not.toContain(
      "creates that module as a new file",
    );
    // Revision 10: four of the five read-only failures returned the correct verdict and
    // were zeroed for one surplus citation. Citations are scored by exact set equality.
    expect(buildGate2LiveInstructions("security_review", "read_only")).toContain(
      "remove every citation the conclusion would survive without",
    );
    expect(buildGate2LiveInstructions("scaffold", "mutation")).not.toContain(
      "remove every citation",
    );
    // Output boundary, on every class: 27 of 30 baseline failures were a code fence.
    for (const [cls, kind] of [
      ["repair", "mutation"],
      ["security_review", "read_only"],
    ] as const) {
      expect(buildGate2LiveInstructions(cls, kind)).toContain("its first character is {");
    }
  });

  it("names no expected path's stem in any class's instructions, derived from the manifest", () => {
    // Review of revision 10 (2026-09-02) planted a rule naming three expected module
    // stems in prose -- "a new module named money" -- and the whole security gate stayed
    // green, because the fragment list above forbids path SHAPES, not the benchmark's
    // nouns. A second review then beat the first version of this guard twice: a stem
    // spelled with a different separator ("test-json-output" for test_json_output) and
    // an answer-contract member name used as prose ("the module noun is files"), which a
    // global exemption for member names had made invisible.
    //
    // So the guard matches TOKEN SEQUENCES: every expected changed, cited, or context
    // path's stem, taken from the manifest rather than a hand-kept list, split on its
    // separators, may not appear as consecutive words in any class's instructions,
    // however they are separated. Nothing is exempt by name. The policy's JSON templates
    // and finding IDs are removed from the scanned text instead, because they are fixed
    // contract vocabulary a model sees identically for every case; prose that reuses one
    // of their words is scanned like any other prose. A convention speaks in roles
    // ("the extracted module"); an answer speaks in names. Paraphrase is not caught here
    // and is held by the authoring rule in ADR 0071.
    const repositoryRoot = decodeURIComponent(new URL("../../", import.meta.url).pathname);
    const manifest = JSON.parse(
      readFileSync(path.join(repositoryRoot, "fixtures/evals/gate2/manifest.v2.json"), "utf8"),
    ) as {
      cases: Array<{
        id: string;
        expectedContextPaths?: string[];
        expectedOutcome?: { expectedChangedPaths?: string[]; expectedCitationPaths?: string[] };
      }>;
    };
    const tokensOf = (text: string): string[] =>
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((token) => token.length > 0);
    const stems = new Map<string, { parts: string[]; cases: Set<string> }>();
    for (const benchmarkCase of manifest.cases) {
      for (const expectedPath of [
        ...(benchmarkCase.expectedOutcome?.expectedChangedPaths ?? []),
        ...(benchmarkCase.expectedOutcome?.expectedCitationPaths ?? []),
        ...(benchmarkCase.expectedContextPaths ?? []),
      ]) {
        const stem = path
          .basename(expectedPath)
          .replace(/\.[^.]+$/, "")
          .toLowerCase();
        const entry = stems.get(stem) ?? { parts: tokensOf(stem), cases: new Set<string>() };
        entry.cases.add(benchmarkCase.id);
        stems.set(stem, entry);
      }
    }
    expect(stems.size).toBeGreaterThan(20);
    expect(stems.get("files")?.parts).toEqual(["files"]);
    expect(stems.get("test_json_output")?.parts).toEqual(["test", "json", "output"]);
    const contractVocabulary = [
      ...Object.values(GATE2_LIVE_INSTRUCTION_POLICY.templates as Record<string, string>),
      ...Object.keys(GATE2_LIVE_INSTRUCTION_POLICY.findingTaxonomy as Record<string, string>),
    ];
    const containsSequence = (haystack: string[], needle: string[]): boolean =>
      haystack.some((_, index) =>
        needle.every((part, offset) => haystack[index + offset] === part),
      );
    const collisions: string[] = [];
    for (const [cls, kind] of [
      ["scaffold", "mutation"],
      ["refactor", "mutation"],
      ["repair", "mutation"],
      ["security_review", "read_only"],
      ["explanation", "read_only"],
    ] as const) {
      let scanned = buildGate2LiveInstructions(cls, kind);
      for (const fixed of contractVocabulary) scanned = scanned.split(fixed).join(" ");
      const tokens = tokensOf(scanned);
      for (const [stem, { parts, cases }] of stems) {
        if (containsSequence(tokens, parts)) {
          collisions.push(`${cls}: "${stem}" names ${[...cases].sort().join(", ")}`);
        }
      }
    }
    expect(collisions).toEqual([]);
  });

  it("gives the model the complete repository inventory without expected outcomes", () => {
    const input = JSON.parse(
      buildGate2LiveCandidateInput({
        task: "Add a command.",
        repositoryPaths: ["README.md", "src/greeting.txt"],
        registeredCheckIds: ["greeting-command"],
        sources: [{ path: "README.md", sha256: "a".repeat(64), content: "Fixture" }],
      }),
    );
    expect(input).toEqual({
      task: "Add a command.",
      repositoryPaths: ["README.md", "src/greeting.txt"],
      registeredCheckIds: ["greeting-command"],
      sources: [{ path: "README.md", sha256: "a".repeat(64), content: "Fixture" }],
    });
    expect(JSON.stringify(input)).not.toContain("expectedChangedPaths");
    expect(JSON.stringify(input)).not.toContain("expectedCitationPaths");
    expect(JSON.stringify(input)).not.toContain("expectedFindingIds");
  });
});
