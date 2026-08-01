import { describe, expect, test } from "vitest";

import { parseStrictJson } from "../../packages/api/src/strict-json.js";

function expectInvalid(source: string, maxDepth?: number): void {
  expect(() => parseStrictJson(source, maxDepth)).toThrowError(
    expect.objectContaining({ code: "INVALID_JSON" }),
  );
}

describe("strict API JSON parsing", () => {
  test("accepts ordinary JSON values without changing their decoded shape", () => {
    expect(
      parseStrictJson(
        '{"object":{"text":"line\\nvalue","number":-12.5e+2,"flag":true},"array":[null,false,0]}',
      ),
    ).toEqual({
      object: { text: "line\nvalue", number: -1_250, flag: true },
      array: [null, false, 0],
    });
  });

  test("rejects duplicate members at every object depth, including escaped aliases", () => {
    expectInvalid('{"name":1,"name":2}');
    expectInvalid('{"outer":[{"name":1,"name":2}]}');
    expectInvalid('{"name":1,"\\u006eame":2}');
    expectInvalid('{"__proto__":1,"\\u005f_proto__":2}');
  });

  test("rejects malformed or non-JSON syntax", () => {
    for (const source of [
      "",
      "{",
      "[1,]",
      '{"value":01}',
      '{"value":NaN}',
      '{"value":1e999}',
      '{"value":-1e999}',
      '{"value":"\\x20"}',
      "true false",
    ]) {
      expectInvalid(source);
    }
  });

  test("enforces the configured recursive container bound", () => {
    expect(parseStrictJson('{"outer":{"value":1}}', 2)).toEqual({ outer: { value: 1 } });
    expectInvalid('{"outer":{"value":1}}', 1);
    expectInvalid("[]", 0);
    expectInvalid("[]", 257);
  });
});
