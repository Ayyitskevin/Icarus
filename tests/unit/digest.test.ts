import { describe, expect, test } from "vitest";

import { stableJson } from "../../packages/core/src/digest.js";

describe("stableJson", () => {
  test("sorts object keys by deterministic code-unit order instead of host locale", () => {
    expect(stableJson({ a: 1, Z: 2 })).toBe('{"Z":2,"a":1}');
  });

  test("recursively preserves array order and canonicalizes nested objects", () => {
    expect(stableJson([{ z: null, A: true }, "value"])).toBe('[{"A":true,"z":null},"value"]');
  });
});
