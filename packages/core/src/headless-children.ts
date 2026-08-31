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
  readonly outcome: Exclude<HeadlessWorkerOutcomeV1, "proposed">;
  readonly exitCode: HeadlessWorkerExitCodeV1;
  readonly childBindingDigestSha256: string | null;
  readonly error: { readonly code: string; readonly message: string } | null;
}

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const RUN_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const CHILD_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const CHILD_SETTLEMENT_MEMBERS = [
  "childBindingDigestSha256",
  "childId",
  "childRunId",
  "error",
  "exitCode",
  "outcome",
  "runId",
  "schema",
] as const;
const CHILD_EXIT_CODES = {
  review_ready: 0,
  failed: 1,
  exhausted: 2,
  awaiting_human: 3,
  cancelled: 130,
} as const satisfies Readonly<
  Record<HeadlessChildSettlementV1["outcome"], HeadlessWorkerExitCodeV1>
>;

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
    upperBoundTokens: parentUsage.upperBoundTokens,
    activeRuntimeMs: parentUsage.activeRuntimeMs,
    costUsd: parentUsage.estimatedCostUsd + parentUsage.reservedCostUsd,
  };
  for (const childUsage of settledChildrenUsage) {
    used.toolCalls += childUsage.toolCalls;
    used.inputTokens += childUsage.inputTokens;
    used.outputTokens += childUsage.outputTokens;
    used.upperBoundTokens += childUsage.upperBoundTokens;
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
    // ADR 0068: a child's envelope is measured against everything the parent has been
    // CHARGED, not only what a provider itemised. Excluding upper bounds would admit a
    // child against budget the parent has already spent.
    const consumed =
      field === "inputTokens" || field === "outputTokens"
        ? used.inputTokens + used.outputTokens + used.upperBoundTokens
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
  return json(decodeHeadlessChildSettlementV1(json(record), record.runId));
}

/** Strict reader for a child settlement projected from durable event history. */
export function decodeHeadlessChildSettlementV1(
  value: JsonValue,
  expectedRunId: string,
): HeadlessChildSettlementV1 {
  invariant(
    typeof value === "object" && value !== null && !Array.isArray(value),
    "INVALID_HEADLESS_CHILD",
    "Headless child settlement is malformed",
  );
  const actualMembers = Object.keys(value).sort();
  const expectedMembers = [...CHILD_SETTLEMENT_MEMBERS].sort();
  invariant(
    actualMembers.length === expectedMembers.length &&
      actualMembers.every((member, index) => member === expectedMembers[index]),
    "INVALID_HEADLESS_CHILD",
    "Headless child settlement members are malformed",
  );
  const { schema, runId, childId, childRunId, outcome, exitCode, childBindingDigestSha256, error } =
    value;
  const childOutcome = outcome as HeadlessChildSettlementV1["outcome"];
  invariant(
    schema === HEADLESS_CHILD_SETTLEMENT_SCHEMA &&
      runId === expectedRunId &&
      typeof childId === "string" &&
      CHILD_ID_PATTERN.test(childId) &&
      (childRunId === null ||
        (typeof childRunId === "string" && RUN_ID_PATTERN.test(childRunId))) &&
      typeof outcome === "string" &&
      Object.hasOwn(CHILD_EXIT_CODES, outcome) &&
      exitCode === CHILD_EXIT_CODES[childOutcome] &&
      (childBindingDigestSha256 === null ||
        (typeof childBindingDigestSha256 === "string" &&
          DIGEST_PATTERN.test(childBindingDigestSha256))),
    "INVALID_HEADLESS_CHILD",
    "Headless child settlement is malformed",
  );
  invariant(
    error === null ||
      (typeof error === "object" &&
        !Array.isArray(error) &&
        Object.keys(error).length === 2 &&
        typeof error.code === "string" &&
        /^[A-Z0-9_]{2,128}$/.test(error.code) &&
        typeof error.message === "string" &&
        error.message.length > 0),
    "INVALID_HEADLESS_CHILD",
    "Headless child settlement error is malformed",
  );
  const childWasSpawned = childRunId !== null;
  invariant(
    childWasSpawned === (childBindingDigestSha256 !== null) &&
      (outcome !== "review_ready" || (childWasSpawned && error === null)) &&
      (outcome !== "failed" || error !== null) &&
      (childWasSpawned || (outcome === "failed" && error !== null)),
    "INVALID_HEADLESS_CHILD",
    "Headless child settlement evidence is contradictory",
  );
  return {
    schema: HEADLESS_CHILD_SETTLEMENT_SCHEMA,
    runId: expectedRunId,
    childId,
    childRunId,
    outcome: childOutcome,
    exitCode: exitCode as HeadlessWorkerExitCodeV1,
    childBindingDigestSha256,
    error: error as HeadlessChildSettlementV1["error"],
  };
}
