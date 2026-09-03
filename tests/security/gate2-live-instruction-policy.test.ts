import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import {
  GATE2_CURRENT_MANIFEST_PATH,
  parseStrictGate2Json,
} from "../../scripts/gate2-benchmark-contract.mjs";
import { validateGate2LiveCandidate } from "../../scripts/gate2-live-candidate-contract.mjs";
import {
  assembleGate2LiveInstructions,
  buildGate2LiveCandidateInput,
  buildGate2LiveInstructions,
  GATE2_LIVE_BENCHMARK_CLASS_KINDS,
  GATE2_LIVE_BENCHMARK_CLASSES,
  GATE2_LIVE_INSTRUCTION_POLICY,
  GATE2_LIVE_INSTRUCTION_POLICY_SHA256,
  GATE2_LIVE_TEMPLATE_SKELETON,
  GATE2_LIVE_TEMPLATES,
  snapshotGate2LivePolicy,
  validateGate2LiveTemplate,
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
    // So the guard derives every expected changed, cited, or context path's stem from the
    // manifest rather than a hand-kept list, and treats a name as any consecutive run of
    // whole tokens whose concatenation equals the stem's letters. Separator changes, word
    // splits, glued lowercase, camelCase, PascalCase, and case changes therefore collide.
    // It scans every policy prose string -- common, kind, and class rules, plus taxonomy
    // definitions -- and then scans the final assembled text with each token tagged by its
    // origin. Nothing is cut out: the builder-owned class/kind and label text, canonical
    // template, and taxonomy IDs are scanned too. Spans wholly inside the template are
    // allowed; a span wholly inside one taxonomy ID is allowed only by the class-aware
    // identifier rule below. Builder text has no blanket exemption. A convention speaks
    // in roles ("the extracted module"); an answer speaks in names. Paraphrase is not
    // caught here and is held by the authoring rule in ADR 0071.
    const repositoryRoot = decodeURIComponent(new URL("../../", import.meta.url).pathname);
    const manifest = JSON.parse(
      readFileSync(path.join(repositoryRoot, GATE2_CURRENT_MANIFEST_PATH), "utf8"),
    ) as {
      cases: Array<{
        id: string;
        class: string;
        expectedContextPaths?: string[];
        expectedOutcome?: {
          kind?: string;
          expectedChangedPaths?: string[];
          expectedCitationPaths?: string[];
          expectedFindingIds?: string[];
        };
      }>;
    };
    // Format characters (Cf), nonspacing and enclosing marks (Mn, Me), and the soft hyphen
    // (U+00AD) -- exactly those -- are removed before splitting: an eighth review put U+200B
    // inside "money" and the split saw "mo" and "ney" while the model read "money". The
    // module refuses non-ASCII outright; this is the second layer.
    const tokensOf = (text: string): string[] =>
      text
        .replace(/[\p{Cf}\p{Mn}\p{Me}\u00ad]/gu, "")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((token) => token.length > 0);
    // A name is matched as the concatenation of consecutive tokens, not as a token sequence:
    // a thirteenth review wrote testJsonOutput and pathTraversal, which lowercase to one
    // token each and matched nothing while the model read the names whole. Under this
    // rule test_json_output, test-json-output, "test json output", testJsonOutput,
    // TestJsonOutput and testjsonoutput are one name, and so is any other split.
    type Stems = Map<string, { parts: string[]; glued: string; cases: Set<string> }>;
    const runsOf = (haystack: string[], glued: string): Array<[number, number]> => {
      const runs: Array<[number, number]> = [];
      for (let start = 0; start < haystack.length; start += 1) {
        let joined = "";
        for (let end = start; end < haystack.length; end += 1) {
          joined += haystack[end];
          if (joined === glued) {
            runs.push([start, end + 1]);
            break;
          }
          if (!glued.startsWith(joined)) break;
        }
      }
      return runs;
    };
    const containsName = (haystack: string[], glued: string): boolean =>
      runsOf(haystack, glued).length > 0;
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
          const entry = out.get(stem) ?? {
            parts: tokensOf(stem),
            glued: tokensOf(stem).join(""),
            cases: new Set<string>(),
          };
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
    const collisions: string[] = [];
    for (const { where, text } of prose) {
      const tokens = tokensOf(text);
      for (const [stem, { glued, cases }] of stems) {
        if (containsName(tokens, glued)) {
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
      for (const [stem, { glued, cases }] of readOnlyStems) {
        if (containsName(tokens, glued)) {
          identifierCollisions.push(
            `finding ID "${id}": "${stem}" names ${[...cases].sort().join(", ")}`,
          );
        }
      }
    }
    for (const cls of manifestClasses) {
      const own = stemsOf(manifest.cases.filter((benchmarkCase) => benchmarkCase.class === cls));
      const tokens = tokensOf(cls);
      for (const [stem, { glued, cases }] of own) {
        if (containsName(tokens, glued)) {
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
          for (const [stem, { glued, cases }] of visible) {
            if (containsName(tokens, glued)) {
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
    // The template's complete key tree is pinned in the module, at every level, to the
    // answer contract's skeleton; a seventh review planted an expected stem as a NESTED
    // key ("answer": {"test-json-output": "text"}) with every check green. The skeleton
    // itself is bound here to the contract members the scorer reads.
    expect(GATE2_LIVE_TEMPLATE_SKELETON).toEqual({
      schemaVersion: "number",
      selectedContextPaths: ["string"],
      plan: { mutationTargets: ["string"], requestedCheckIds: ["string"] },
      answer: {
        kind: "string",
        files: [{ path: "string", content: "string" }],
        citations: ["string"],
        findingIds: ["string"],
        summary: "string",
      },
    });
    const mutationTemplate = JSON.parse(policy.templates.mutation) as {
      answer: Record<string, unknown>;
    };
    // The policy's template strings must equal the canonical objects byte for byte; every
    // earlier template plant -- nested key, wrong literal, empty file list, mutation
    // authority in the read-only template -- is the same refusal now.
    for (const [kind, plant] of [
      [
        "mutation",
        { ...mutationTemplate, answer: { ...mutationTemplate.answer, "test-json-output": "text" } },
      ],
      ["mutation", { ...mutationTemplate, schemaVersion: 2 }],
      ["mutation", { ...mutationTemplate, answer: { ...mutationTemplate.answer, files: [] } }],
      [
        "readOnly",
        {
          ...(JSON.parse(policy.templates.readOnly) as Record<string, unknown>),
          plan: { mutationTargets: ["path"], requestedCheckIds: [] },
        },
      ],
    ] as const) {
      expect(() =>
        snapshotGate2LivePolicy({
          ...policy,
          templates: { ...policy.templates, [kind]: JSON.stringify(plant) },
        }),
      ).toThrow(new RegExp(`templates\\.${kind} must equal the canonical template byte for byte`));
    }
    // A duplicate member, whitespace, or a hidden code point in the string is the same refusal.
    expect(() =>
      snapshotGate2LivePolicy({
        ...policy,
        templates: {
          ...policy.templates,
          mutation: policy.templates.mutation.replace(/^\{/, '{"schemaVersion":1,'),
        },
      }),
    ).toThrow(/must equal the canonical template byte for byte/);
    // The canonical templates satisfy the live candidate contract under placeholder
    // authority, so "Required shape" cannot drift from what the scorer accepts.
    for (const [kind, expectedKind] of [
      ["mutation", "mutation"],
      ["readOnly", "read_only"],
    ] as const) {
      expect(() =>
        validateGate2LiveCandidate(GATE2_LIVE_TEMPLATES[kind], {
          repositoryPaths: ["path"],
          retrievedPaths: ["path"],
          checkIds: ["id"],
          expectedKind,
        }),
      ).not.toThrow();
    }
    // Expected FINDING IDs are answers too: a ninth review put ["path-traversal"] into the
    // read-only template's findingIds -- contract-valid, byte-equal to its constant, and
    // the exact scored answer for security-path-traversal. Template values are
    // placeholders only now (refused in the module), and every prose string a read-only
    // class sees, plus the read-only template's leaves, is scanned against the read-only
    // cases' expected finding IDs as token sequences. The taxonomy line lists every ID for
    // every case and is the contract; a rule naming one is steering.
    const findingIds: Stems = new Map();
    for (const benchmarkCase of manifest.cases) {
      for (const id of benchmarkCase.expectedOutcome?.expectedFindingIds ?? []) {
        const entry = findingIds.get(id) ?? {
          parts: tokensOf(id),
          glued: tokensOf(id).join(""),
          cases: new Set<string>(),
        };
        entry.cases.add(benchmarkCase.id);
        findingIds.set(id, entry);
      }
    }
    expect(findingIds.size).toBeGreaterThan(0);
    const findingCollisionsOf = (
      strings: ReadonlyArray<{ where: string; text: string }>,
    ): string[] => {
      const found: string[] = [];
      for (const { where, text } of strings) {
        const tokens = tokensOf(text);
        for (const [id, { glued, cases }] of findingIds) {
          if (where === `findingTaxonomy.${id}`) continue;
          if (containsName(tokens, glued)) {
            found.push(`${where}: finding "${id}" names ${[...cases].sort().join(", ")}`);
          }
        }
      }
      return found;
    };
    // Every string a read-only class sees: the common, read-only, and read-only class rules,
    // AND every taxonomy definition -- a tenth review appended ", report path-traversal" to
    // the unvalidated-config-shape definition and every test stayed green. A definition is
    // scanned against every expected ID except its own key, which it may describe.
    const readOnlyProse = prose.filter(
      ({ where }) =>
        where === "common" ||
        where === "readOnly" ||
        where === "classRules.explanation" ||
        where === "classRules.security_review" ||
        where.startsWith("findingTaxonomy."),
    );
    const readOnlyTemplateLeaves = templateLeaves(GATE2_LIVE_TEMPLATES.readOnly).map((text) => ({
      where: "templates.readOnly",
      text,
    }));
    expect(findingCollisionsOf([...readOnlyProse, ...readOnlyTemplateLeaves])).toEqual([]);
    expect(
      findingCollisionsOf([
        { where: "classRules.security_review", text: "Report path-traversal when input escapes." },
      ]),
    ).toEqual([
      'classRules.security_review: finding "path-traversal" names security-path-traversal',
    ]);
    expect(
      findingCollisionsOf([
        {
          where: "findingTaxonomy.unvalidated-config-shape",
          text: `${policy.findingTaxonomy["unvalidated-config-shape"]}, report path-traversal`,
        },
      ]),
    ).toEqual([
      'findingTaxonomy.unvalidated-config-shape: finding "path-traversal" names security-path-traversal',
    ]);
    expect(
      findingCollisionsOf([
        { where: "findingTaxonomy.path-traversal", text: "the path-traversal finding, described" },
      ]),
    ).toEqual([]);
    // The constants pass their own validator, and the snapshot path runs it: a planted
    // canonical template with a matching serialised string is refused by the snapshot.
    for (const kind of ["mutation", "readOnly"] as const) {
      expect(() => validateGate2LiveTemplate(GATE2_LIVE_TEMPLATES[kind], kind)).not.toThrow();
    }
    const roguePlan = {
      ...mutationTemplate,
      answer: { ...mutationTemplate.answer, summary: "rogue" },
    };
    expect(() =>
      snapshotGate2LivePolicy(
        { ...policy, templates: { ...policy.templates, mutation: JSON.stringify(roguePlan) } },
        { ...GATE2_LIVE_TEMPLATES, mutation: roguePlan },
      ),
    ).toThrow(/answer\.summary must be a template placeholder, not "rogue"/);
    const readOnlyTemplate = GATE2_LIVE_TEMPLATES.readOnly as { answer: Record<string, unknown> };
    expect(() =>
      validateGate2LiveTemplate(
        {
          ...readOnlyTemplate,
          answer: { ...readOnlyTemplate.answer, findingIds: ["path-traversal"] },
        },
        "readOnly",
      ),
    ).toThrow(/answer\.findingIds\[0\] must be a template placeholder/);
    // A JSON escape is ASCII in the serialised string and a control character in the value
    // the model is shown; the constants are checked as decoded objects.
    expect(() =>
      validateGate2LiveTemplate(
        { ...readOnlyTemplate, answer: { ...readOnlyTemplate.answer, summary: "mo\nney" } },
        "readOnly",
      ),
    ).toThrow(/answer\.summary must be printable ASCII/);
    for (const hidden of ["mo\u200bney", "mo\ufe0fney", "mo\u034fney", "mo\u00adney"]) {
      expect(tokensOf(hidden)).toEqual(["money"]);
    }
    // The text AS ASSEMBLED, in its final order, with every token tagged by the piece it
    // came from. An eleventh review split "path-traversal" across two rules; a twelfth
    // showed that replacing structure with neutral markers before scanning deletes
    // authored tokens and hides a span across the marker: a taxonomy KEY "expected"
    // followed by a definition starting "finding" renders "expected = finding ...", the
    // stem expected_finding whole. Nothing is substituted now. A match is permitted only
    // when its entire span lies inside the template -- builder-owned structure the
    // contract exposes on purpose -- or, for a finding ID, when the span is exactly one
    // taxonomy ID's own tokens. Everything else the model reads is authored or adjacent
    // to authored text, and a span through it is a leak.
    type TaggedToken = { token: string; origin: string };
    const taggedTokensOf = (
      source: typeof policy,
      cls: string,
      kind: "mutation" | "read_only",
    ): TaggedToken[] => {
      const out: TaggedToken[] = [];
      const push = (text: string, origin: string) => {
        for (const token of tokensOf(text)) out.push({ token, origin });
      };
      for (const rule of source.common) push(rule, "common");
      for (const rule of kind === "mutation" ? source.mutation : source.readOnly) push(rule, kind);
      for (const rule of Object.hasOwn(source.classRules, cls)
        ? (source.classRules[cls] ?? [])
        : []) {
        push(rule, `classRules.${cls}`);
      }
      push(`This task class is ${cls}; its answer kind is ${kind}.`, "builder");
      push("Required shape:", "builder");
      push(source.templates[kind === "mutation" ? "mutation" : "readOnly"], "template");
      if (kind === "read_only") {
        push("Finding taxonomy:", "builder");
        for (const [id, definition] of Object.entries(source.findingTaxonomy).sort(([l], [r]) =>
          l < r ? -1 : l > r ? 1 : 0,
        )) {
          push(id, `id:${id}`);
          push(definition, `definition:${id}`);
        }
      }
      return out;
    };
    // The tagged stream is the assembled text's token stream, exactly.
    for (const [cls, kind] of Object.entries(GATE2_LIVE_BENCHMARK_CLASS_KINDS) as Array<
      [string, "mutation" | "read_only"]
    >) {
      expect(taggedTokensOf(policy, cls, kind).map(({ token }) => token)).toEqual(
        tokensOf(buildGate2LiveInstructions(cls, kind)),
      );
    }
    // A span wholly inside ONE taxonomy ID is the identifier channel, judged class-aware
    // as above: the ID reaches only the receiving class, so it may contain a stem of some
    // other class's case (unvalidated-config-shape carries "config", a refactor target) but
    // not a stem of the receiving class's own cases. A finding ID inside its own ID tokens
    // is the contract listing itself.
    const spanAllowed = (span: TaggedToken[], ownStem: boolean, id?: string): boolean => {
      if (span.every(({ origin }) => origin === "template")) return true;
      const single = span[0]?.origin;
      const withinOneId =
        single !== undefined &&
        single.startsWith("id:") &&
        span.every(({ origin }) => origin === single);
      if (id !== undefined) return withinOneId && single === `id:${id}`;
      return withinOneId && !ownStem;
    };
    const assembledCollisionsOf = (
      source: typeof policy,
      cls: string,
      kind: "mutation" | "read_only",
    ): string[] => {
      const stream = taggedTokensOf(source, cls, kind);
      const ownStems = stemsOf(
        manifest.cases.filter((benchmarkCase) => benchmarkCase.class === cls),
      );
      const found: string[] = [];
      const tokens = stream.map(({ token }) => token);
      const scan = (glued: string, label: string, ownStem: boolean, id?: string) => {
        for (const [start, end] of runsOf(tokens, glued)) {
          const span = stream.slice(start, end);
          if (spanAllowed(span, ownStem, id)) continue;
          const origins = [...new Set(span.map(({ origin }) => origin))].join("+");
          found.push(`assembled ${cls}: ${label} across ${origins}`);
        }
      };
      for (const [stem, { glued, cases }] of stems) {
        scan(glued, `"${stem}" names ${[...cases].sort().join(", ")}`, ownStems.has(stem));
      }
      if (kind === "read_only") {
        for (const [fid, { glued, cases }] of findingIds) {
          scan(glued, `finding "${fid}" names ${[...cases].sort().join(", ")}`, false, fid);
        }
      }
      return [...new Set(found)];
    };
    for (const [cls, kind] of Object.entries(GATE2_LIVE_BENCHMARK_CLASS_KINDS) as Array<
      [string, "mutation" | "read_only"]
    >) {
      expect(assembledCollisionsOf(policy, cls, kind)).toEqual([]);
    }
    const asPolicy = (source: unknown) =>
      snapshotGate2LivePolicy(source) as unknown as typeof policy;
    // Eleventh review: a finding ID split across two adjacent rules.
    expect(
      assembledCollisionsOf(
        asPolicy({
          ...policy,
          classRules: {
            ...policy.classRules,
            security_review: [
              ...(policy.classRules.security_review ?? []),
              "Report path",
              "traversal when runtime input escapes.",
            ],
          },
        }),
        "security_review",
        "read_only",
      ),
    ).toEqual([
      'assembled security_review: finding "path-traversal" names security-path-traversal across classRules.security_review',
    ]);
    // Twelfth review, three forms: a taxonomy key and its definition reconstruct a stem;
    // definition -> key -> definition reconstruct one; adjacent rules whose text looks like
    // taxonomy structure ("json = output.") reconstruct one.
    expect(
      assembledCollisionsOf(
        asPolicy({
          ...policy,
          findingTaxonomy: {
            ...policy.findingTaxonomy,
            expected: "finding means a repository path named by the benchmark",
          },
        }),
        "security_review",
        "read_only",
      ),
    ).toEqual([
      'assembled security_review: "expected_finding" names repair-public-path-containment, security-path-traversal across id:expected+definition:expected',
    ]);
    const [firstId, firstDefinition] = Object.entries(policy.findingTaxonomy).sort(([l], [r]) =>
      l < r ? -1 : l > r ? 1 : 0,
    )[0] as [string, string];
    expect(
      assembledCollisionsOf(
        asPolicy({
          ...policy,
          findingTaxonomy: {
            ...policy.findingTaxonomy,
            [firstId]: `${firstDefinition} test`,
            json: "output",
          },
        }),
        "security_review",
        "read_only",
      ).some((line) => line.includes('"test_json_output"') && line.includes("definition:")),
    ).toBe(true);
    expect(
      assembledCollisionsOf(
        asPolicy({
          ...policy,
          classRules: {
            ...policy.classRules,
            scaffold: [
              ...(policy.classRules.scaffold ?? []),
              "Name the check test",
              "json = output.",
            ],
          },
        }),
        "scaffold",
        "mutation",
      ),
    ).toEqual([
      'assembled scaffold: "test_json_output" names scaffold-json-output-mode across classRules.scaffold',
    ]);
    // Thirteenth review: identifier spellings. Every one is the same name.
    for (const spelling of [
      "testJsonOutput",
      "TestJsonOutput",
      "testjsonoutput",
      "TEST_JSON_OUTPUT",
    ]) {
      expect(
        assembledCollisionsOf(
          asPolicy({
            ...policy,
            classRules: {
              ...policy.classRules,
              scaffold: [
                ...(policy.classRules.scaffold ?? []),
                `Name the new check module ${spelling}.`,
              ],
            },
          }),
          "scaffold",
          "mutation",
        ),
      ).toEqual([
        'assembled scaffold: "test_json_output" names scaffold-json-output-mode across classRules.scaffold',
      ]);
    }
    expect(
      assembledCollisionsOf(
        asPolicy({
          ...policy,
          classRules: {
            ...policy.classRules,
            security_review: [
              ...(policy.classRules.security_review ?? []),
              "Report pathTraversal when runtime input escapes.",
            ],
          },
        }),
        "security_review",
        "read_only",
      ),
    ).toEqual([
      'assembled security_review: finding "path-traversal" names security-path-traversal across classRules.security_review',
    ]);
    // Every policy string is printable ASCII, so a zero-width space cannot split a stem.
    expect(() =>
      snapshotGate2LivePolicy({
        ...policy,
        classRules: { ...policy.classRules, refactor: ["Name the extracted module mo\u200bney."] },
      }),
    ).toThrow(/classRules\.refactor\[0\] must be printable ASCII/);
    for (const badId of ["x-", "x--y", "-x", "X"]) {
      expect(() =>
        snapshotGate2LivePolicy({ ...policy, findingTaxonomy: { [badId]: "d" } }),
      ).toThrow(/must be a kebab-case identifier/);
    }
    const plantedTemplate = JSON.stringify({
      ...mutationTemplate,
      answer: { ...mutationTemplate.answer, summary: "test-json-output" },
    });
    // The leaf scan on its own catches the value plant (round six) ...
    expect(templateCollisionsOf({ ...policy.templates, mutation: plantedTemplate })).toEqual([
      'templates.mutation value "test-json-output": "test_json_output" names scaffold-json-output-mode',
    ]);
    // ... and the snapshot refuses it before the scan is even reached (round nine).
    expect(() =>
      snapshotGate2LivePolicy({
        ...policy,
        templates: { ...policy.templates, mutation: plantedTemplate },
      }),
    ).toThrow(/templates\.mutation must equal the canonical template byte for byte/);
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
    ).toThrow(/templates\.mutation must equal the canonical template byte for byte/);
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
