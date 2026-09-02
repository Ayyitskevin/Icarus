import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { parseStrictGate2Json } from "../../scripts/gate2-benchmark-contract.mjs";
import {
  assembleGate2LiveInstructions,
  buildGate2LiveCandidateInput,
  buildGate2LiveInstructions,
  GATE2_LIVE_BENCHMARK_CLASS_KINDS,
  GATE2_LIVE_BENCHMARK_CLASSES,
  GATE2_LIVE_INSTRUCTION_POLICY,
  GATE2_LIVE_INSTRUCTION_POLICY_SHA256,
  snapshotGate2LivePolicy,
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
      generation: Readonly<{ temperature: number; maxTokens: number; think: boolean }>;
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
    // Each class produces one answer kind; the assembler refuses any other pair, so the
    // taxonomy line reaches only the read-only classes the scan checks it against.
    const manifestKinds: Record<string, string> = {};
    for (const benchmarkCase of manifest.cases) {
      const kind = benchmarkCase.expectedOutcome?.kind ?? "";
      expect(manifestKinds[benchmarkCase.class] ?? kind).toBe(kind);
      manifestKinds[benchmarkCase.class] = kind;
    }
    expect({ ...GATE2_LIVE_BENCHMARK_CLASS_KINDS }).toEqual(manifestKinds);
    expect(() => buildGate2LiveInstructions("refactor", "read_only")).toThrow(
      /class and kind do not match/,
    );
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
    // Template VALUES are text the model sees; template KEYS are the answer contract. A
    // sixth review kept a template valid and changed only answer.summary from "text" to
    // "test-json-output", and every test stayed green. Each template's string leaves are
    // scanned against the stems of the cases whose kind receives it; its top-level keys
    // are exact and it parses under the strict parser (no duplicate members).
    const templateLeaves = (value: unknown, out: string[] = []): string[] => {
      if (typeof value === "string") out.push(value);
      else if (Array.isArray(value)) for (const item of value) templateLeaves(item, out);
      else if (value !== null && typeof value === "object") {
        for (const item of Object.values(value)) templateLeaves(item, out);
      }
      return out;
    };
    const templateCollisionsOf = (templates: Readonly<Record<string, string>>): string[] => {
      const found: string[] = [];
      for (const [kind, template] of Object.entries(templates)) {
        const parsed = parseStrictGate2Json(template) as Record<string, unknown>;
        expect(Object.keys(parsed).sort()).toEqual([
          "answer",
          "plan",
          "schemaVersion",
          "selectedContextPaths",
        ]);
        const receivingKind = kind === "mutation" ? "mutation" : "read_only";
        const visible = stemsOf(
          manifest.cases.filter(
            (benchmarkCase) => benchmarkCase.expectedOutcome?.kind === receivingKind,
          ),
        );
        for (const leaf of templateLeaves(parsed)) {
          const tokens = tokensOf(leaf);
          for (const [stem, { parts, cases }] of visible) {
            if (containsSequence(tokens, parts)) {
              found.push(
                `templates.${kind} value "${leaf}": "${stem}" names ${[...cases].sort().join(", ")}`,
              );
            }
          }
        }
      }
      return found;
    };
    expect(templateCollisionsOf(policy.templates)).toEqual([]);
    const mutationTemplate = JSON.parse(policy.templates.mutation) as {
      answer: Record<string, unknown>;
    };
    const plantedTemplate = JSON.stringify({
      ...mutationTemplate,
      answer: { ...mutationTemplate.answer, summary: "test-json-output" },
    });
    const withPlantedTemplate = snapshotGate2LivePolicy({
      ...policy,
      templates: { ...policy.templates, mutation: plantedTemplate },
    }) as unknown as typeof policy;
    expect(templateCollisionsOf(withPlantedTemplate.templates)).toEqual([
      'templates.mutation value "test-json-output": "test_json_output" names scaffold-lantern-json-output',
    ]);
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
        ...(Object.hasOwn(policy.classRules, cls) ? (policy.classRules[cls] ?? []) : []),
        `This task class is ${cls}; its answer kind is ${kind}.`,
        `Required shape: ${policy.templates[kind === "mutation" ? "mutation" : "readOnly"]}`,
        ...(kind === "read_only"
          ? [
              `Finding taxonomy: ${Object.entries(policy.findingTaxonomy)
                .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
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
    // A fifth review planted an own GETTER that returned the recorded rule on its first
    // read and an answer on its second -- the digest matched, the scan passed, the model
    // saw the answer -- and a one-element array as a template, which coerced to an
    // expected stem where the template is interpolated. The exported policy is plain data
    // by construction: the snapshot evaluates every accessor exactly once, asserts the
    // shape, and is what the digest, this scan, and the assembler all read.
    const walk = (value: unknown, where: string): void => {
      if (value === null || typeof value !== "object") return;
      expect(Object.getOwnPropertySymbols(value), where).toEqual([]);
      expect(Object.isFrozen(value), where).toBe(true);
      for (const key of Object.keys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        expect(descriptor && "value" in descriptor, `${where}.${key} is a data property`).toBe(
          true,
        );
        walk((value as Record<string, unknown>)[key], `${where}.${key}`);
      }
    };
    walk(policy, "policy");
    let reads = 0;
    const recorded = policy.classRules.refactor ?? [];
    const withGetter = {
      ...policy,
      classRules: {
        ...policy.classRules,
        get refactor() {
          reads += 1;
          return reads === 1 ? recorded : [...recorded, "Name the extracted module money."];
        },
      },
    };
    const snapshot = snapshotGate2LivePolicy(withGetter);
    expect(reads).toBe(1);
    expect((snapshot as unknown as typeof policy).classRules.refactor).toEqual(recorded);
    const first = assembleGate2LiveInstructions(snapshot, "refactor", "mutation");
    expect(assembleGate2LiveInstructions(snapshot, "refactor", "mutation")).toBe(first);
    expect(first).not.toContain("money");
    expect(() =>
      snapshotGate2LivePolicy({
        ...policy,
        templates: { ...policy.templates, mutation: ["money"] },
      }),
    ).toThrow(/templates\.mutation must be a string/);
    expect(() =>
      snapshotGate2LivePolicy({ ...policy, classRules: { ...policy.classRules, rogue: ["x"] } }),
    ).toThrow(/classRules\.rogue is not a benchmark class/);
    // A second closure review: the digest canonicalises key order but the taxonomy line
    // rendered in insertion order, so two policies with one digest could show the model
    // two orders. The rendering is sorted now; a reordered source assembles identically.
    const reordered = snapshotGate2LivePolicy({
      ...policy,
      findingTaxonomy: Object.fromEntries(Object.entries(policy.findingTaxonomy).reverse()),
    });
    expect(assembleGate2LiveInstructions(reordered, "security_review", "read_only")).toBe(
      buildGate2LiveInstructions("security_review", "read_only"),
    );
    // Delimiters inside an id or a definition would render as extra taxonomy entries.
    expect(() =>
      snapshotGate2LivePolicy({ ...policy, findingTaxonomy: { "a = b; c": "d" } }),
    ).toThrow(/must be a kebab-case identifier/);
    expect(() =>
      snapshotGate2LivePolicy({ ...policy, findingTaxonomy: { x: "y; z = w" } }),
    ).toThrow(/must not contain the taxonomy delimiters/);
    expect(() =>
      snapshotGate2LivePolicy({
        ...policy,
        generation: { temperature: -5, maxTokens: -1.5, think: false },
      }),
    ).toThrow(/generation must carry/);
    expect(() =>
      snapshotGate2LivePolicy({ ...policy, templates: { ...policy.templates, extra: "{}" } }),
    ).toThrow(/templates\.extra is not an answer kind/);
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
