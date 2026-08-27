import { invariant } from "./errors.js";
import type { HeadlessReconstruction } from "./headless-reconstruction.js";
import type { RunRecord } from "./types.js";

// H3b exactly-once continuation admission (ADR 0058). This module is a pure
// gate over the ADR 0057 evidence record and the current persisted run. It
// creates no event, operation, lease, or provider effect; it only decides
// whether re-entering the run's current stage can never re-execute a durably
// settled effect and never crosses an unknown (ambiguous) one.

/**
 * Crash-tail operation kinds the v1 continuation can re-enter replay-safely:
 * exactly the single-shot worker stage vocabulary. The separately checked
 * read-only session subset is not part of this set; recovery, review, and
 * foreign kinds remain refused.
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

/**
 * The first session-continuation slice admits only a complete prior batch of
 * provider work plus read-only tools. Effectful/control calls retain process-
 * local replay state and therefore remain closed until their request identity
 * is durably bound by a later contract.
 */
const CONTINUABLE_SESSION_OPERATION_KINDS: ReadonlySet<string> = new Set([
  "provider.revise",
  "session.tool.read.manifest",
  "session.tool.read.checks",
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
  evidence: HeadlessReconstruction,
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
  const sessionEffects = evidence.effects.filter(
    (effect) => effect.kind === "provider.revise" || effect.kind?.startsWith("session.") === true,
  );
  const sessionIterationBoundary =
    "sessionIterationBoundary" in evidence ? evidence.sessionIterationBoundary : undefined;
  if (sessionEffects.length > 0) {
    const boundary = sessionIterationBoundary;
    if (boundary === undefined) {
      denied("Headless session continuation lacks a durable completed-iteration boundary");
    }
    if (run.state !== "running") {
      denied(`Headless session continuation cannot re-enter run state ${run.state}`);
    }
    for (const effect of sessionEffects) {
      if (
        effect.kind === null ||
        !CONTINUABLE_SESSION_OPERATION_KINDS.has(effect.kind) ||
        effect.disposition !== "durably_settled" ||
        effect.settlement !== "finished" ||
        effect.settlementSequence === null ||
        effect.settlementSequence >= boundary.eventSequence
      ) {
        denied(
          `Headless session crash-tail operation kind ${effect.kind ?? "unknown"} is not continuable`,
        );
      }
    }
    const providerTurns = sessionEffects.filter((effect) => effect.kind === "provider.revise");
    const readTools = sessionEffects.filter((effect) =>
      effect.kind?.startsWith("session.tool.read."),
    );
    if (providerTurns.length !== boundary.iterations) {
      denied("Headless session boundary does not cover every durable provider turn");
    }
    if (readTools.length < boundary.iterations) {
      denied("Headless session boundary does not cover a durable read-only tool batch");
    }
  } else if (sessionIterationBoundary !== undefined) {
    denied("Headless continuation has a session boundary without session operations");
  }
  for (const effect of evidence.effects) {
    if (sessionEffects.includes(effect)) continue;
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
