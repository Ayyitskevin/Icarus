import { describe, expect, it } from "vitest";

import { buildGate2ChatRequestBody } from "../../scripts/gate2-live-benchmark.mjs";
import { GATE2_LIVE_INSTRUCTION_POLICY } from "../../scripts/gate2-live-instruction-policy.mjs";

/**
 * Why this boundary exists.
 *
 * ADR 0070 claims a Gate 2 run cannot quietly measure the reasoning-enabled mode. That
 * was first "guaranteed" by a digest over the policy VALUE and a static source check for
 * the string. Neither shows what reaches the wire: deleting the request field left both
 * green, and a `.includes` assertion passes while the fragment sits in a comment. This
 * asserts the transmitted body.
 */
describe("Gate 2 live request body", () => {
  const body = buildGate2ChatRequestBody({
    modelId: "code",
    instructions: "system",
    input: "user",
    generation: GATE2_LIVE_INSTRUCTION_POLICY.generation,
  }) as Record<string, unknown>;

  it("transmits the policy's think value, not the provider default", () => {
    expect("think" in body).toBe(true);
    expect(body.think).toBe(GATE2_LIVE_INSTRUCTION_POLICY.generation.think);
    expect(body.think).toBe(false);
  });

  it("transmits the policy's generation budget rather than a local literal", () => {
    expect(body.max_tokens).toBe(GATE2_LIVE_INSTRUCTION_POLICY.generation.maxTokens);
    expect(body.temperature).toBe(GATE2_LIVE_INSTRUCTION_POLICY.generation.temperature);
  });

  it("sends no field Vulcan would reject and no unpinned extras", () => {
    // Vulcan rejects unknown request fields, so an extra member is a live failure rather
    // than a cosmetic one.
    expect(Object.keys(body).sort()).toEqual(
      ["max_tokens", "messages", "model", "seat", "stream", "temperature", "think"].sort(),
    );
  });
});
