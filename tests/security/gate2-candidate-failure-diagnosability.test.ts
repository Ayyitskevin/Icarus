import { describe, expect, it } from "vitest";
import { describeGate2CandidateFailure } from "../../scripts/gate2-live-benchmark.mjs";

/**
 * Why this boundary exists.
 *
 * On 2026-08-28, eight Gate 2 baseline observations recorded an empty `rawCandidate`
 * with `candidateError: "Gate 2 benchmark contract: manifest must be strict JSON"`.
 * Read literally, that says the model produced nothing, and baseline scaffold was
 * scored 0/5 on that reading. It was wrong: the gateway of the day discarded the
 * model's reasoning before the harness saw it, and `scaffold-cart-discount` had
 * billed 8192 output tokens over 145 seconds for that empty string.
 *
 * A measurement harness must not serialize *absence* and *loss* identically. These
 * tests pin the distinction.
 */
describe("Gate 2 candidate failure descriptions", () => {
  const usage = { inputTokens: 972, outputTokens: 8192, estimatedCostUsd: null, latencyMs: 145543 };

  it("keeps a parser message verbatim when the model actually answered", () => {
    const reason = "Gate 2 benchmark contract: manifest must be strict JSON";
    expect(
      describeGate2CandidateFailure(reason, {
        text: '{"partial":',
        thinkingChars: 0,
        finishReason: "stop",
        usage,
      }),
    ).toBe(reason);
  });

  it("records why an empty candidate was empty, including discarded reasoning", () => {
    const described = describeGate2CandidateFailure(
      "Gate 2 benchmark contract: manifest must be strict JSON",
      { text: "", thinkingChars: 5364, finishReason: "length", usage },
    );

    // The reader must be able to conclude "budget exhausted by reasoning we did not
    // keep", not "the model said nothing".
    expect(described).toContain("0 content characters");
    expect(described).toContain("8192 output tokens");
    expect(described).toContain("finishReason=length");
    expect(described).toContain("reasoning=5364 characters");
  });

  it("distinguishes zero reasoning from unmeasured reasoning", () => {
    const measuredZero = describeGate2CandidateFailure("contract failed", {
      text: "",
      thinkingChars: 0,
      finishReason: "length",
      usage,
    });
    const unmeasured = describeGate2CandidateFailure("contract failed", {
      text: "",
      thinkingChars: null,
      finishReason: "legacy-stop",
      usage,
    });

    // A record replayed from before reasoning was measurable must not claim zero:
    // that would assert a fact the run never observed.
    expect(measuredZero).toContain("reasoning=0 characters");
    expect(unmeasured).toContain("reasoning=not measured");
    expect(unmeasured).not.toContain("0 characters");
  });
});
