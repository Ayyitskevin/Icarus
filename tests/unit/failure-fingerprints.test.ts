import { describe, expect, it } from "vitest";
import { describeNonStrictJson } from "../../packages/core/src/canonical-json.js";

/**
 * Why this boundary exists.
 *
 * "not strict JSON" is equally true of a markdown-fenced object, a truncated
 * document, an empty string, and arbitrary prose. On 2026-08-28, twelve of twenty
 * Gate 2 baseline failures were complete, valid JSON behind a markdown fence -- a
 * formatting habit, not a broken model -- and the retained evidence could not say so.
 * Distinguishing the shapes is what makes such a record actionable.
 *
 * The classifier reports shape and size only. Provider text can echo prompts or
 * credentials and must never be placed in an error.
 */
describe("non-strict-JSON classification", () => {
  it("names a markdown fence, the Gate 2 failure mode, distinctly", () => {
    const described = describeNonStrictJson('```json\n{"mutationTargets":[]}\n```');
    expect(described.shape).toBe("markdown_fenced");
    expect(described.bytes).toBeGreaterThan(0);
  });

  it("separates a truncated document from other malformed payloads", () => {
    // A length stop leaves more openers than closers.
    expect(describeNonStrictJson('{"a":{"b":[1,2').shape).toBe("truncated");
    // Balanced but still invalid is a different defect.
    expect(describeNonStrictJson('{"a":,}').shape).toBe("other");
  });

  it("separates an empty answer from prose", () => {
    expect(describeNonStrictJson("   ").shape).toBe("empty");
    expect(describeNonStrictJson("Sure! Here is the plan:").shape).toBe("leading_prose");
  });

  it("never carries the payload itself", () => {
    const secretish = '```json\n{"token":"ghp_not_a_real_secret_value"}\n```';
    const described = describeNonStrictJson(secretish);
    expect(JSON.stringify(described)).not.toContain("ghp_");
    expect(Object.keys(described).sort()).toStrictEqual(["bytes", "shape"]);
  });
});
