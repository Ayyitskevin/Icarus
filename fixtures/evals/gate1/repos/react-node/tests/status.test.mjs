import assert from "node:assert/strict";
import test from "node:test";

import { statusLabel, statusTone } from "../src/status.mjs";

test("maps an online user to the online presentation", () => {
  assert.equal(statusLabel(true), "Online");
  assert.equal(statusTone(true), "positive");
});

test("maps an offline user to the offline presentation", () => {
  assert.equal(statusLabel(false), "Offline");
  assert.equal(statusTone(false), "muted");
});
