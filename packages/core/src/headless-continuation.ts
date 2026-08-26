import { invariant } from "./errors.js";
import type { HeadlessReconstructionV1 } from "./headless-reconstruction.js";
import type { RunRecord } from "./types.js";

// H3b exactly-once continuation admission (ADR 0058). This module is a pure
// gate over the ADR 0057 evidence record and the current persisted run. It
// creates no event, operation, lease, or provider effect; it only decides
// whether re-entering the run's current stage can never re-execute a durably
// settled effect and never crosses an unknown (ambiguous) one.

/**
 * Crash-tail operation kinds the v1 continuation can re-enter replay-safely:
 * exactly the single-shot worker stage vocabulary. Session turns, recovery,
 * review, and foreign kinds are refused because their exactly-once resume
 * grammar is a later slice.
 */
const CONTINUABLE_OPERATION_KINDS: ReadonlySet<string> = new Set([
  "execution.prepare",
  "workspace.create",
  "edit.prepare",
  "provider.edit",
  "edit.materialize",
  "verification.preflight",
  "sandbox.verify",
  "verification.postflight",
]);

const RE_DRIVABLE_STATES: ReadonlySet<RunRecord["state"]> = new Set(["running", "verifying"]);

const SETTLE_ONLY_STATES: ReadonlySet<RunRecord["state"]> = new Set([
  "awaiting_review",
  "completed",
  "failed",
  "cancelled",
  "rolled_back",
]);

function denied(message: string): never {
  invariant(false, "HEADLESS_CONTINUATION_DENIED", message);
}

/**
 * Fail-closed admission for a governed continuation. Every check is over
 * durable evidence: a classification label is never trusted past the durable
 * successor intent that makes re-entry replay-safe.
 */
export function assertHeadlessContinuationReplaySafeV1(
  evidence: HeadlessReconstructionV1,
  run: RunRecord,
): void {
  invariant(
    evidence.runId === run.id && run.id.length > 0,
    "HEADLESS_CONTINUATION_DENIED",
    "Headless continuation evidence does not match the current run",
  );
  if (evidence.effects.some((effect) => effect.disposition === "ambiguous")) {
    denied("Headless crash tail contains an effect with an unknown durable outcome");
  }
  for (const effect of evidence.effects) {
    if (effect.kind === null || !CONTINUABLE_OPERATION_KINDS.has(effect.kind)) {
      denied(`Headless crash tail operation kind ${effect.kind ?? "unknown"} is not continuable`);
    }
    // A durably settled effect is re-executed on re-entry unless its durable
    // successor intent exists; require the exact successor for each stage.
    if (effect.settlement !== "finished") continue;
    if (effect.kind === "workspace.create" && run.worktreePath === null) {
      denied("Settled workspace creation lacks its persisted workspace identity");
    }
    if (effect.kind === "provider.edit" && run.patchSet === null) {
      denied("Settled provider edit lacks its persisted patch-set intent");
    }
    if (effect.kind === "sandbox.verify" && run.verification === null) {
      denied("Settled sandbox verification lacks its persisted verification evidence");
    }
  }
  if (!RE_DRIVABLE_STATES.has(run.state) && !SETTLE_ONLY_STATES.has(run.state)) {
    denied(`Headless continuation cannot re-enter run state ${run.state}`);
  }
}
