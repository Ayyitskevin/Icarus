import { describe, expect, it } from "vitest";

import { IcarusError } from "../../packages/core/src/errors.js";
import { assertTransition, canTransition } from "../../packages/core/src/state-machine.js";
import type { RunState } from "../../packages/core/src/types.js";

const STATES = [
  "preparing",
  "planned",
  "awaiting_egress_approval",
  "awaiting_approval",
  "running",
  "verifying",
  "awaiting_review",
  "completed",
  "rolling_back",
  "cancelling",
  "failed",
  "cancelled",
  "rolled_back",
  "restoring",
] as const satisfies readonly RunState[];

const EXPECTED: Readonly<Record<RunState, readonly RunState[]>> = {
  preparing: ["planned", "awaiting_egress_approval", "failed", "cancelling"],
  planned: ["awaiting_approval", "failed", "cancelling"],
  awaiting_egress_approval: ["planned", "failed", "cancelling"],
  awaiting_approval: ["running", "failed", "cancelling"],
  running: ["verifying", "failed", "cancelling"],
  verifying: ["awaiting_review", "failed", "cancelling"],
  awaiting_review: ["completed", "rolling_back", "failed", "cancelling"],
  completed: ["rolling_back"],
  rolling_back: ["rolled_back", "failed"],
  cancelling: ["cancelled", "failed"],
  failed: ["cancelling"],
  cancelled: [],
  rolled_back: ["restoring"],
  restoring: ["verifying", "failed"],
};

describe("run state machine", () => {
  it("enumerates every allowed and denied transition, including preparation", () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...STATES].sort());

    for (const from of STATES) {
      for (const to of STATES) {
        const allowed = EXPECTED[from].includes(to);
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(allowed);

        if (allowed) {
          expect(() => assertTransition(from, to), `${from} -> ${to}`).not.toThrow();
        } else {
          try {
            assertTransition(from, to);
            throw new Error(`Expected ${from} -> ${to} to be denied`);
          } catch (error) {
            expect(error, `${from} -> ${to}`).toBeInstanceOf(IcarusError);
            expect((error as IcarusError).code, `${from} -> ${to}`).toBe(
              "INVALID_STATE_TRANSITION",
            );
          }
        }
      }
    }
  });
});
