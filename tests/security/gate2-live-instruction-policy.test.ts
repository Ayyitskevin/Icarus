import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import {
  assembleGate2LiveInstructions,
  buildGate2LiveCandidateInput,
  buildGate2LiveInstructions,
  GATE2_LIVE_BENCHMARK_CLASSES,
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
      buildGate2LiveInstructions("explanation", "read_only"),
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
    // A third review then beat the second version: it cut the JSON templates and finding
    // IDs out of the assembled text before scanning, so a rule that wrote a finding ID
    // into its prose ("the middle word of unvalidated-config-shape") had the stem inside
    // the ID erased before the scan while the model still read it.
    //
    // So the guard scans the policy's PROSE STRINGS themselves -- common, kind, and class
    // rules, and the taxonomy definitions -- as token sequences: every expected changed,
    // cited, or context path's stem, taken from the manifest rather than a hand-kept
    // list, split on its separators, may not appear as consecutive words in any of them,
    // however separated. Nothing is cut out of prose and no word is exempt. The only text
    // not scanned is what the builder owns structurally: the class/kind line, the JSON
    // template, and the taxonomy IDs as identifiers -- and a structural check below
    // asserts the assembled instructions contain nothing beyond those pieces. A
    // convention speaks in roles ("the extracted module"); an answer speaks in names.
    // Paraphrase is not caught here and is held by the authoring rule in ADR 0071.
    const repositoryRoot = decodeURIComponent(new URL("../../", import.meta.url).pathname);
    const manifest = JSON.parse(
      readFileSync(path.join(repositoryRoot, "fixtures/evals/gate2/manifest.v2.json"), "utf8"),
    ) as {
      cases: Array<{
        id: string;
        class: string;
        expectedContextPaths?: string[];
        expectedOutcome?: {
          kind?: string;
          expectedChangedPaths?: string[];
          expectedCitationPaths?: string[];
        };
      }>;
    };
    const tokensOf = (text: string): string[] =>
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((token) => token.length > 0);
    type Stems = Map<string, { parts: string[]; cases: Set<string> }>;
    const stemsOf = (cases: typeof manifest.cases): Stems => {
      const out: Stems = new Map();
      for (const benchmarkCase of cases) {
        for (const expectedPath of [
          ...(benchmarkCase.expectedOutcome?.expectedChangedPaths ?? []),
          ...(benchmarkCase.expectedOutcome?.expectedCitationPaths ?? []),
          ...(benchmarkCase.expectedContextPaths ?? []),
        ]) {
          const stem = path
            .basename(expectedPath)
            .replace(/\.[^.]+$/, "")
            .toLowerCase();
          const entry = out.get(stem) ?? { parts: tokensOf(stem), cases: new Set<string>() };
          entry.cases.add(benchmarkCase.id);
          out.set(stem, entry);
        }
      }
      return out;
    };
    const stems = stemsOf(manifest.cases);
    expect(stems.size).toBeGreaterThan(20);
    expect(stems.get("files")?.parts).toEqual(["files"]);
    expect(stems.get("test_json_output")?.parts).toEqual(["test", "json", "output"]);
    expect(stems.get("config")?.parts).toEqual(["config"]);
    const policy = GATE2_LIVE_INSTRUCTION_POLICY as unknown as {
      common: readonly string[];
      mutation: readonly string[];
      readOnly: readonly string[];
      classRules: Readonly<Record<string, readonly string[]>>;
      templates: Readonly<Record<"mutation" | "readOnly", string>>;
      findingTaxonomy: Readonly<Record<string, string>>;
    };
    const prose: Array<{ where: string; text: string }> = [];
    for (const [where, list] of [
      ["common", policy.common],
      ["mutation", policy.mutation],
      ["readOnly", policy.readOnly],
      ...Object.entries(policy.classRules).map(([cls, list]) => [`classRules.${cls}`, list]),
    ] as Array<[string, readonly string[]]>) {
      for (const text of list) prose.push({ where, text });
    }
    for (const [id, definition] of Object.entries(policy.findingTaxonomy)) {
      prose.push({ where: `findingTaxonomy.${id}`, text: definition });
    }
    expect(prose.length).toBeGreaterThan(10);
    const containsSequence = (haystack: string[], needle: string[]): boolean =>
      haystack.some((_, index) =>
        needle.every((part, offset) => haystack[index + offset] === part),
      );
    const collisions: string[] = [];
    for (const { where, text } of prose) {
      const tokens = tokensOf(text);
      for (const [stem, { parts, cases }] of stems) {
        if (containsSequence(tokens, parts)) {
          collisions.push(`${where}: "${stem}" names ${[...cases].sort().join(", ")}`);
        }
      }
    }
    expect(collisions).toEqual([]);
    // Identifier channels. The model also sees two kinds of identifier: the finding IDs, in
    // the taxonomy line every read-only class receives, and its own class name, in the
    // class/kind line. A third review planted "for-public-containment-cite-only-files" as
    // a taxonomy key and every test stayed green. Identifiers cannot be held to the prose
    // rule -- unvalidated-config-shape must contain "config" -- so each is scanned against
    // the stems of exactly the cases whose instructions include it: finding IDs against
    // the read-only cases, a class name against its own class. Class-rule keys are pinned
    // to the manifest's classes so the class line can carry only a reviewed name.
    const manifestClasses = new Set(manifest.cases.map((benchmarkCase) => benchmarkCase.class));
    expect([...manifestClasses].sort()).toEqual([
      "explanation",
      "refactor",
      "repair",
      "scaffold",
      "security_review",
    ]);
    for (const cls of Object.keys(policy.classRules)) expect(manifestClasses.has(cls)).toBe(true);
    expect([...GATE2_LIVE_BENCHMARK_CLASSES].sort()).toEqual([...manifestClasses].sort());
    expect(() =>
      buildGate2LiveInstructions("for-public-containment-cite-only-files", "read_only"),
    ).toThrow(/class is invalid/);
    const identifierCollisions: string[] = [];
    const readOnlyStems = stemsOf(
      manifest.cases.filter((benchmarkCase) => benchmarkCase.expectedOutcome?.kind === "read_only"),
    );
    expect(readOnlyStems.has("files")).toBe(true);
    for (const id of Object.keys(policy.findingTaxonomy)) {
      const tokens = tokensOf(id);
      for (const [stem, { parts, cases }] of readOnlyStems) {
        if (containsSequence(tokens, parts)) {
          identifierCollisions.push(
            `finding ID "${id}": "${stem}" names ${[...cases].sort().join(", ")}`,
          );
        }
      }
    }
    for (const cls of manifestClasses) {
      const own = stemsOf(manifest.cases.filter((benchmarkCase) => benchmarkCase.class === cls));
      const tokens = tokensOf(cls);
      for (const [stem, { parts, cases }] of own) {
        if (containsSequence(tokens, parts)) {
          identifierCollisions.push(
            `class name "${cls}": "${stem}" names ${[...cases].sort().join(", ")}`,
          );
        }
      }
    }
    expect(identifierCollisions).toEqual([]);
    // Structural: the assembled instructions are exactly the scanned prose plus the
    // builder-owned pieces. If the builder ever adds prose of its own, this fails and the
    // scan above has to learn about it.
    for (const [cls, kind] of [
      ["scaffold", "mutation"],
      ["refactor", "mutation"],
      ["repair", "mutation"],
      ["security_review", "read_only"],
      ["explanation", "read_only"],
    ] as const) {
      const expected = [
        ...policy.common,
        ...(kind === "mutation" ? policy.mutation : policy.readOnly),
        ...(Object.hasOwn(policy.classRules, cls) ? policy.classRules[cls] : []),
        `This task class is ${cls}; its answer kind is ${kind}.`,
        `Required shape: ${policy.templates[kind === "mutation" ? "mutation" : "readOnly"]}`,
        ...(kind === "read_only"
          ? [
              `Finding taxonomy: ${Object.entries(policy.findingTaxonomy)
                .map(([id, definition]) => `${id} = ${definition}`)
                .join("; ")}.`,
            ]
          : []),
      ].join(" ");
      expect(buildGate2LiveInstructions(cls, kind)).toBe(expected);
    }
    // A fourth review planted a class rule on classRules' PROTOTYPE: the builder's property
    // lookup emitted it while the scan, the digest, and the oracle above -- all own-key
    // walks -- stayed unchanged. The builder now reads own rules only; prove it on a policy
    // carrying exactly that plant.
    expect(Object.getPrototypeOf(policy.classRules)).toBe(Object.prototype);
    const planted = {
      ...policy,
      classRules: Object.freeze(
        Object.assign(
          Object.create({ explanation: ["For this explanation, cite only files."] }),
          policy.classRules,
        ),
      ),
    };
    expect(
      assembleGate2LiveInstructions(planted as never, "explanation", "read_only"),
    ).not.toContain("cite only files");
    expect(assembleGate2LiveInstructions(planted as never, "explanation", "read_only")).toBe(
      buildGate2LiveInstructions("explanation", "read_only"),
    );
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
