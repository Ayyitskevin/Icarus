import assert from "node:assert/strict";
import test from "node:test";

import { clamp } from "../src/clamp.ts";

test("returns the lower bound below the range", () => {
  assert.equal(clamp(-4, 0, 10), 0);
});

test("returns the upper bound above the range", () => {
  assert.equal(clamp(14, 0, 10), 10);
});

test("preserves values and endpoints inside the range", () => {
  assert.equal(clamp(0, 0, 10), 0);
  assert.equal(clamp(6, 0, 10), 6);
  assert.equal(clamp(10, 0, 10), 10);
});

test("rejects an inverted range", () => {
  assert.throws(() => clamp(5, 10, 0), {
    name: "RangeError",
    message: "minimum must not exceed maximum",
  });
});
