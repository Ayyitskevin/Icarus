import { IcarusError } from "./errors.js";
import type { RunState } from "./types.js";

const transitions: Readonly<Record<RunState, ReadonlySet<RunState>>> = {
  preparing: new Set(["planned", "awaiting_egress_approval", "failed", "cancelling"]),
  planned: new Set(["awaiting_approval", "failed", "cancelling"]),
  awaiting_egress_approval: new Set(["planned", "failed", "cancelling"]),
  awaiting_approval: new Set(["running", "failed", "cancelling"]),
  running: new Set(["verifying", "failed", "cancelling"]),
  verifying: new Set(["awaiting_review", "failed", "cancelling"]),
  awaiting_review: new Set(["completed", "rolling_back", "failed", "cancelling"]),
  completed: new Set(["rolling_back"]),
  rolling_back: new Set(["rolled_back", "failed"]),
  cancelling: new Set(["cancelled", "failed"]),
  failed: new Set(["cancelling"]),
  cancelled: new Set([]),
  rolled_back: new Set(["restoring"]),
  restoring: new Set(["verifying", "failed"]),
};

export function assertTransition(from: RunState, to: RunState): void {
  if (!transitions[from].has(to)) {
    throw new IcarusError(
      "INVALID_STATE_TRANSITION",
      `Cannot transition run from ${from} to ${to}`,
      {
        from,
        to,
      },
    );
  }
}

export function canTransition(from: RunState, to: RunState): boolean {
  return transitions[from].has(to);
}
