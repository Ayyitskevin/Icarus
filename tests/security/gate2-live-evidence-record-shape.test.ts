import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { DEFAULT_CEILING } from "../../packages/core/src/policy.js";
import {
  GATE2_EVIDENCE_RECORD_RULES,
  hasCurrentEvidenceShape,
  LIVE_EVIDENCE_RECORD_REVISION,
} from "../../scripts/gate2-live-benchmark.mjs";
import { GATE2_LIVE_INSTRUCTION_POLICY } from "../../scripts/gate2-live-instruction-policy.mjs";

type EvidenceRecord = Record<string, unknown>;

const PINNED_THINK = GATE2_LIVE_INSTRUCTION_POLICY.generation.think;

/**
 * A revision-7 record shaped like the ones the runner writes: four selected files, of
 * which three matched the query and one arrived by the reference hop. That gap is why
 * `selectedFiles` cannot stand in for the query-match count in the reconciliation.
 */
function validRecord(): EvidenceRecord {
  return {
    evidenceRecordRevision: LIVE_EVIDENCE_RECORD_REVISION,
    requestedThink: PINNED_THINK,
    reasoningChars: null,
    retrieval: {
      matchedFiles: 3,
      selectedFiles: 4,
      selectedQueryMatches: 3,
      omittedMatches: [],
      omittedReferences: [],
      excludedFiles: { byPolicy: 0, nonText: 0, secretShaped: 0, unsupportedEntry: 0 },
    },
    observation: {
      retrievedContext: [
        { path: "src/a.ts", sha256: "a".repeat(64) },
        { path: "src/b.ts", sha256: "b".repeat(64) },
        { path: "src/c.ts", sha256: "c".repeat(64) },
        { path: "src/hop.ts", sha256: "d".repeat(64) },
      ],
    },
    evaluatorEvidence: { checks: [recordedCheck("ok\n", "")] },
  };
}

/** A revision-7 check entry: the text beside the digest of exactly that text. */
function recordedCheck(stdout: string, stderr: string): Record<string, unknown> {
  return {
    checkId: "unit",
    argv: ["python", "-m", "checks.unit"],
    exitCode: 0,
    signal: null,
    stdout,
    stderr,
    stdoutSha256: createHash("sha256").update(stdout).digest("hex"),
    stderrSha256: createHash("sha256").update(stderr).digest("hex"),
    truncated: false,
    outcome: "passed",
  };
}

function withChecks(checks: unknown): EvidenceRecord {
  return { ...validRecord(), evaluatorEvidence: { checks } };
}

/**
 * The predicate this validator replaced, restated here so the tightening is testable:
 * every violator below satisfies it. It asked whether members EXIST, so a record could
 * name the reasoning mode without recording the requested one, report a negative count,
 * omit a path it also selected, and contradict its own coverage arithmetic while passing.
 */
function hasEveryRevision5Member(record: EvidenceRecord): boolean {
  if (!("reasoningChars" in record)) return false;
  if (!(record.reasoningChars === null || Number.isSafeInteger(record.reasoningChars)))
    return false;
  if (!("requestedThink" in record)) return false;
  const retrieval = record.retrieval as Record<string, unknown> | null;
  if (retrieval === null || typeof retrieval !== "object") return false;
  if (!Number.isSafeInteger(retrieval.matchedFiles)) return false;
  if (!Number.isSafeInteger(retrieval.selectedFiles)) return false;
  if (!Array.isArray(retrieval.omittedMatches)) return false;
  if (!Array.isArray(retrieval.omittedReferences)) return false;
  const excluded = retrieval.excludedFiles as Record<string, unknown> | null;
  if (excluded === null || typeof excluded !== "object") return false;
  return ["byPolicy", "nonText", "secretShaped", "unsupportedEntry"].every((key) =>
    Number.isSafeInteger(excluded[key]),
  );
}

function withRetrieval(patch: Record<string, unknown>): EvidenceRecord {
  const record = validRecord();
  record.retrieval = { ...(record.retrieval as Record<string, unknown>), ...patch };
  return record;
}

function omission(path: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { path, bytes: 128, reason: "file_ceiling", ...overrides };
}

/**
 * Each case violates EXACTLY ONE rule. That is what makes the mutation proof below
 * meaningful: if deleting the named rule left the record refused, some other rule was
 * doing the work and the named one could be removed unnoticed.
 */
const VIOLATIONS: ReadonlyArray<{
  readonly name: string;
  readonly ruleId: string;
  readonly record: EvidenceRecord;
  /** False where the rule is carried over from the superseded check rather than new. */
  readonly passesSupersededCheck?: boolean;
}> = [
  {
    name: "a record relabelled with the superseded revision",
    ruleId: "revision-is-current",
    record: { ...validRecord(), evidenceRecordRevision: LIVE_EVIDENCE_RECORD_REVISION - 1 },
  },
  {
    name: "a record whose requested reasoning mode is not the pinned policy's",
    ruleId: "requested-think-equals-policy",
    record: { ...validRecord(), requestedThink: !PINNED_THINK },
  },
  {
    name: "a record whose reasoning mode is a string rather than the pinned boolean",
    ruleId: "requested-think-equals-policy",
    record: { ...validRecord(), requestedThink: String(PINNED_THINK) },
  },
  {
    name: "a negative reasoning size",
    ruleId: "reasoning-chars-null-or-count",
    record: { ...validRecord(), reasoningChars: -1 },
  },
  {
    name: "negative coverage counts",
    ruleId: "coverage-counts-are-counts",
    record: withRetrieval({ matchedFiles: -1, selectedQueryMatches: -1 }),
  },
  {
    name: "a negative pre-candidate exclusion count",
    ruleId: "excluded-file-counts-are-counts",
    record: withRetrieval({
      excludedFiles: { byPolicy: -1, nonText: 0, secretShaped: 0, unsupportedEntry: 0 },
    }),
  },
  {
    name: "an omission list that is not a list",
    ruleId: "omission-lists-are-arrays",
    record: withRetrieval({ omittedReferences: {} }),
    passesSupersededCheck: false,
  },
  {
    name: "a selected-file count that disagrees with the selected paths",
    ruleId: "selected-count-matches-selected-paths",
    record: withRetrieval({ selectedFiles: 99 }),
  },
  {
    name: "more query matches selected than files selected",
    ruleId: "selected-query-matches-within-selection",
    record: withRetrieval({ selectedQueryMatches: 5, matchedFiles: 5 }),
  },
  {
    name: "an omission naming a path outside the repository",
    ruleId: "omission-entries-are-valid",
    record: withRetrieval({ omittedReferences: [omission("../../etc/shadow")] }),
  },
  {
    name: "an omission reporting a negative size",
    ruleId: "omission-entries-are-valid",
    record: withRetrieval({ omittedReferences: [omission("src/z.ts", { bytes: -1 })] }),
  },
  {
    name: "an omission giving a reason outside the closed set",
    ruleId: "omission-entries-are-valid",
    record: withRetrieval({ omittedReferences: [omission("src/z.ts", { reason: "unranked" })] }),
  },
  {
    name: "the same path withheld twice",
    ruleId: "omission-paths-are-unique",
    record: withRetrieval({ omittedReferences: [omission("src/z.ts"), omission("src/z.ts")] }),
  },
  {
    name: "a path both returned and withheld",
    ruleId: "no-path-both-selected-and-omitted",
    record: withRetrieval({ omittedReferences: [omission("src/a.ts")] }),
  },
  {
    name: "coverage that contradicts its own omissions",
    ruleId: "coverage-reconciles-with-omissions",
    record: withRetrieval({ matchedFiles: 7 }),
  },
  {
    // Revision 6's shape: digests present, text absent. Exactly what revision 7 refuses.
    name: "a check entry that carries digests but no output text",
    ruleId: "check-entries-carry-output-text",
    record: withChecks([
      (({ stdout: _o, stderr: _e, ...rest }) => rest)(recordedCheck("ok\n", "")),
    ]),
  },
  {
    name: "a check whose recorded text is not the text its digest names",
    ruleId: "check-output-is-digest-bound",
    record: withChecks([{ ...recordedCheck("ok\n", ""), stdout: "edited\n" }]),
  },
  {
    name: "a check whose recorded stdout exceeds the sandbox ceiling",
    ruleId: "check-output-within-ceiling",
    record: withChecks([recordedCheck("x".repeat(DEFAULT_CEILING.maxCommandOutputBytes + 1), "")]),
  },
];

describe("Gate 2 revision-7 evidence record shape", () => {
  it("accepts the shape the runner writes", () => {
    expect(LIVE_EVIDENCE_RECORD_REVISION).toBe(7);
    expect(hasCurrentEvidenceShape(validRecord())).toBe(true);
  });

  it("refuses a record that is not an object", () => {
    for (const value of [null, undefined, "record", 6, []]) {
      expect(hasCurrentEvidenceShape(value)).toBe(false);
    }
  });

  it("still accepts a null reasoning size, which is what an absent thinking member is", () => {
    expect(hasCurrentEvidenceShape({ ...validRecord(), reasoningChars: null })).toBe(true);
    expect(hasCurrentEvidenceShape({ ...validRecord(), reasoningChars: 0 })).toBe(true);
  });

  it("names every rule in at least one violation, so no rule is untested", () => {
    const covered = new Set(VIOLATIONS.map((violation) => violation.ruleId));
    const declared = GATE2_EVIDENCE_RECORD_RULES.map((rule) => rule.id);
    expect(declared.length).toBe(new Set(declared).size);
    expect([...declared].filter((id) => !covered.has(id))).toEqual([]);
    expect([...covered].filter((id) => !declared.includes(id))).toEqual([]);
  });

  for (const violation of VIOLATIONS) {
    it(`refuses ${violation.name}, and only the ${violation.ruleId} rule refuses it`, () => {
      // Except where noted, the record carries every member the superseded existence
      // check asked for, so the refusal below is the tightening and not a missing field.
      expect(hasEveryRevision5Member(violation.record)).toBe(
        violation.passesSupersededCheck ?? true,
      );
      expect(hasCurrentEvidenceShape(violation.record)).toBe(false);

      // Delete the rule and the same record is accepted: that is the rule's binding.
      const withoutRule = GATE2_EVIDENCE_RECORD_RULES.filter(
        (rule) => rule.id !== violation.ruleId,
      );
      expect(withoutRule.length).toBe(GATE2_EVIDENCE_RECORD_RULES.length - 1);
      expect(withoutRule.every((rule) => rule.holds(violation.record))).toBe(true);
    });
  }
});
