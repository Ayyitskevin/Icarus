import { digestJson } from "./digest.js";
import { invariant } from "./errors.js";
import type {
  HeadlessChildSpecV1,
  HeadlessProfileBudgetsV1,
  HeadlessProfileV1,
} from "./headless-profile.js";
import type { HeadlessWorkerExitCodeV1, HeadlessWorkerOutcomeV1 } from "./headless-worker.js";
import type { JsonValue, PlanProposal, RunRecord } from "./types.js";

// H4 isolated child runs (ADR 0059). This module owns the pure child
// contracts: spec digests, derived child profiles, cumulative envelope
// accounting, child plan admission, and lineage event payloads. It performs
// no I/O and creates no run, event, operation, lease, or provider effect.

export const HEADLESS_CHILD_LINK_SCHEMA = "icarus.headless.child-link.v1";
export const HEADLESS_CHILD_SETTLEMENT_SCHEMA = "icarus.headless.child-settlement.v1";
/** The H4 v1 depth ceiling: direct children of the root worker only. */
export const HEADLESS_CHILD_MAX_DEPTH = 1;

/** Lineage recorded on the child run before its plan is admitted. */
export interface HeadlessChildLinkV1 {
  readonly schema: typeof HEADLESS_CHILD_LINK_SCHEMA;
  readonly runId: string;
  readonly parentRunId: string;
  readonly parentBindingDigestSha256: string;
  readonly depth: typeof HEADLESS_CHILD_MAX_DEPTH;
  readonly childId: string;
  readonly specDigestSha256: string;
}

/**
 * Child outcome recorded on the parent run. A null `childRunId` means the
 * child was never spawned (envelope refusal); a null
 * `childBindingDigestSha256` means execution never reached a binding.
 */
export interface HeadlessChildSettlementV1 {
  readonly schema: typeof HEADLESS_CHILD_SETTLEMENT_SCHEMA;
  readonly runId: string;
  readonly childId: string;
  readonly childRunId: string | null;
  readonly outcome: HeadlessWorkerOutcomeV1;
  readonly exitCode: HeadlessWorkerExitCodeV1;
  readonly childBindingDigestSha256: string | null;
  readonly error: { readonly code: string; readonly message: string } | null;
}

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

function denied(message: string): never {
  invariant(false, "HEADLESS_CHILD_DENIED", message);
}

function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

/** Deterministic identity of one operator-declared child specification. */
export function headlessChildSpecDigestV1(spec: HeadlessChildSpecV1): string {
  return digestJson(json(spec));
}

/**
 * The child executes under a derived profile that only narrows the parent:
 * same provider selection, the spec's tool subset and budgets, no children of
 * its own, and the fixed one-task/no-schedule policy.
 */
export function deriveHeadlessChildProfileV1(
  parent: HeadlessProfileV1,
  spec: HeadlessChildSpecV1,
): HeadlessProfileV1 {
  const profileId = `${parent.profileId}-c-${spec.childId}`;
  invariant(
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(profileId),
    "HEADLESS_CHILD_DENIED",
    "Derived child profile ID is not canonical",
  );
  return {
    schemaVersion: parent.schemaVersion,
    profileId,
    providerProfileId: parent.providerProfileId,
    toolIds: spec.toolIds,
    budgets: spec.budgets,
    output: parent.output,
    worker: {
      mode: "one_task",
      maxConcurrency: 1,
      childRuns: "deny",
      scheduledRuns: "deny",
      // ADR 0060: a child's isolated write-set is already spec-bound, and the
      // parent's proposal gate is the operator control point, so children
      // always execute their admitted envelope.
      mutation: "apply",
    },
  };
}

const CUMULATIVE_USAGE_FIELDS = [
  "toolCalls",
  "inputTokens",
  "outputTokens",
  "activeRuntimeMs",
] as const;

/**
 * Cumulative envelope: the spec's metered budgets must fit the parent
 * profile's remaining envelope after the parent's own usage and every prior
 * settled child's usage. Child budgets never reset the envelope; they only
 * ever consume it.
 */
export function assertHeadlessChildEnvelopeV1(
  spec: HeadlessChildSpecV1,
  parentBudgets: HeadlessProfileBudgetsV1,
  parentUsage: RunRecord["usage"],
  settledChildrenUsage: readonly RunRecord["usage"][],
): void {
  const used = {
    toolCalls: parentUsage.toolCalls,
    inputTokens: parentUsage.inputTokens,
    outputTokens: parentUsage.outputTokens,
    activeRuntimeMs: parentUsage.activeRuntimeMs,
    costUsd: parentUsage.estimatedCostUsd + parentUsage.reservedCostUsd,
  };
  for (const childUsage of settledChildrenUsage) {
    used.toolCalls += childUsage.toolCalls;
    used.inputTokens += childUsage.inputTokens;
    used.outputTokens += childUsage.outputTokens;
    used.activeRuntimeMs += childUsage.activeRuntimeMs;
    used.costUsd += childUsage.estimatedCostUsd + childUsage.reservedCostUsd;
  }
  for (const field of CUMULATIVE_USAGE_FIELDS) {
    const budgetField = (
      {
        toolCalls: "maxToolCalls",
        inputTokens: "maxTotalTokens",
        outputTokens: "maxTotalTokens",
        activeRuntimeMs: "maxActiveRuntimeMs",
      } as const
    )[field];
    const consumed =
      field === "inputTokens" || field === "outputTokens"
        ? used.inputTokens + used.outputTokens
        : used[field];
    if (spec.budgets[budgetField] > parentBudgets[budgetField] - consumed) {
      denied(`child ${spec.childId} budget ${budgetField} exceeds the parent's remaining envelope`);
    }
  }
  if (spec.budgets.maxCostUsd > parentBudgets.maxCostUsd - used.costUsd) {
    denied(`child ${spec.childId} budget maxCostUsd exceeds the parent's remaining envelope`);
  }
}

/**
 * The provider-generated child plan is admitted only when it stays inside
 * the operator-declared spec envelope; the parent's approved plan remains
 * the outer authority for targets, checks, and iterations.
 */
export function assertHeadlessChildPlanV1(
  spec: HeadlessChildSpecV1,
  plan: PlanProposal,
  parentPlan: PlanProposal,
): void {
  for (const target of plan.targets) {
    if (!spec.targets.includes(target)) {
      denied(`child ${spec.childId} plan target ${target} escapes its declared write set`);
    }
  }
  if (!spec.targets.includes(plan.target)) {
    denied(`child ${spec.childId} plan anchor ${plan.target} escapes its declared write set`);
  }
  for (const checkId of plan.checkIds) {
    if (!parentPlan.checkIds.includes(checkId)) {
      denied(`child ${spec.childId} plan check ${checkId} escapes the parent's approved checks`);
    }
  }
  if (plan.iterationCeiling > spec.budgets.iterationCeiling) {
    denied(`child ${spec.childId} plan iteration ceiling exceeds its declared budget`);
  }
}

export function headlessChildLinkPayload(link: HeadlessChildLinkV1): JsonValue {
  invariant(
    link.schema === HEADLESS_CHILD_LINK_SCHEMA &&
      link.depth === HEADLESS_CHILD_MAX_DEPTH &&
      DIGEST_PATTERN.test(link.parentBindingDigestSha256) &&
      DIGEST_PATTERN.test(link.specDigestSha256),
    "INVALID_HEADLESS_CHILD",
    "Headless child link is malformed",
  );
  return json(link);
}

export function headlessChildSettlementPayload(record: HeadlessChildSettlementV1): JsonValue {
  invariant(
    record.schema === HEADLESS_CHILD_SETTLEMENT_SCHEMA &&
      (record.childBindingDigestSha256 === null ||
        DIGEST_PATTERN.test(record.childBindingDigestSha256)),
    "INVALID_HEADLESS_CHILD",
    "Headless child settlement is malformed",
  );
  return json(record);
}
