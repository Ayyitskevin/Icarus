import { describe, expect, it } from "vitest";

import { GATE2_LIVE_INSTRUCTION_POLICY_REVISION } from "../../scripts/gate2-live-instruction-policy.mjs";

// The declaration file types the revision as a numeric literal. This annotation binds that
// literal at typecheck time: if scripts/gate2-live-instruction-policy.d.mts declares any other
// number, `pnpm typecheck` fails here with TS2322, and no comment, block comment, or
// `export declare` spelling can fool the compiler. The runtime assertion below binds the
// exported value to the same literal, so declaration and runtime cannot drift apart without
// this file changing too -- which is the point: a bump touches all three, visibly.
const DECLARED_REVISION: 11 = GATE2_LIVE_INSTRUCTION_POLICY_REVISION;

describe("Gate 2 instruction policy revision declaration", () => {
  it("runtime revision equals the literal the declaration file types", () => {
    expect(GATE2_LIVE_INSTRUCTION_POLICY_REVISION).toBe(DECLARED_REVISION);
    expect(DECLARED_REVISION).toBe(11);
  });
});
