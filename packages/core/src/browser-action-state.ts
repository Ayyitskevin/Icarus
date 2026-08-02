import { sha256 } from "./digest.js";
import { IcarusError, invariant } from "./errors.js";
import type { RunState } from "./types.js";

export const BROWSER_ACTION_DESCRIPTOR_VERSION = 1 as const;

export const BROWSER_ACTION_KINDS = [
  "egress.approve",
  "plan.approve",
  "review.approve",
  "review.reject",
  "rollback.approve",
  "restore.approve",
  "run.resume",
  "run.cancel",
] as const;

export type BrowserActionKind = (typeof BROWSER_ACTION_KINDS)[number];

export const BROWSER_ACTION_STATUSES = ["prepared", "admitted", "settled"] as const;

export type BrowserActionStatus = (typeof BROWSER_ACTION_STATUSES)[number];

export const BROWSER_ACTION_OUTCOMES = [
  "succeeded",
  "refused",
  "failed",
  "cancelled",
  "reconciliation_required",
] as const;

export type BrowserActionOutcome = (typeof BROWSER_ACTION_OUTCOMES)[number];

const BROWSER_ACTION_KIND_SET = new Set<string>(BROWSER_ACTION_KINDS);
const BROWSER_ACTION_STATUS_SET = new Set<string>(BROWSER_ACTION_STATUSES);
const BROWSER_ACTION_OUTCOME_SET = new Set<string>(BROWSER_ACTION_OUTCOMES);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const ERROR_CODE_PATTERN = /^[A-Z0-9_]{2,128}$/;

/**
 * This is the exact kind/state column truth table from ADR 0029. It is not a
 * complete descriptor-availability policy: callers must still prove review
 * completeness, passing verification, resume/orphan evidence, coordinator
 * ownership, leases, and every current domain gate.
 */
export const BROWSER_ACTION_EXPECTED_STATES = {
  "egress.approve": ["awaiting_egress_approval"],
  "plan.approve": ["awaiting_approval"],
  "review.approve": ["awaiting_review"],
  "review.reject": ["awaiting_review"],
  "rollback.approve": ["completed"],
  "restore.approve": ["rolled_back"],
  "run.resume": [
    "preparing",
    "planned",
    "running",
    "verifying",
    "rolling_back",
    "restoring",
    "cancelling",
    "failed",
  ],
  "run.cancel": [
    "preparing",
    "planned",
    "awaiting_egress_approval",
    "awaiting_approval",
    "running",
    "verifying",
    "awaiting_review",
    "failed",
  ],
} as const satisfies Readonly<Record<BrowserActionKind, readonly RunState[]>>;

const SUBJECT_ACTION_KINDS = new Set<BrowserActionKind>([
  "egress.approve",
  "plan.approve",
  "review.approve",
  "review.reject",
  "rollback.approve",
  "restore.approve",
]);

export interface BrowserActionDescriptorFields {
  readonly version: typeof BROWSER_ACTION_DESCRIPTOR_VERSION;
  readonly kind: BrowserActionKind;
  readonly runId: string;
  readonly expectedState: RunState;
  readonly eventRevision: number;
  readonly subjectDigest: string | null;
  readonly activeActionId: string | null;
  readonly activeActionDigest: string | null;
}

export type BrowserActionDescriptorTuple = readonly [
  version: typeof BROWSER_ACTION_DESCRIPTOR_VERSION,
  kind: BrowserActionKind,
  runId: string,
  expectedState: RunState,
  eventRevision: number,
  subjectDigest: string | null,
  activeActionId: string | null,
  activeActionDigest: string | null,
];

/**
 * The immutable identity sent by one deliberate browser click. It contains
 * every request-body field. Actor attribution is deliberately not client
 * identity and therefore is not part of this tuple.
 */
export interface BrowserActionIdentity extends BrowserActionDescriptorFields {
  readonly actionId: string;
  readonly actionDigest: string;
}

export type BrowserActionIdentityTuple = readonly [
  actionId: string,
  version: typeof BROWSER_ACTION_DESCRIPTOR_VERSION,
  kind: BrowserActionKind,
  runId: string,
  expectedState: RunState,
  eventRevision: number,
  subjectDigest: string | null,
  activeActionId: string | null,
  activeActionDigest: string | null,
  actionDigest: string,
];

export interface BrowserActionRecordBase extends BrowserActionIdentity {
  readonly actor: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface BrowserActionPreparedRecord extends BrowserActionRecordBase {
  readonly status: "prepared";
  readonly outcome: null;
  readonly admissionEventSequence: null;
  readonly domainEventSequence: null;
  readonly domainOperationId: null;
  readonly errorCode: null;
}

export interface BrowserActionAdmittedRecord extends BrowserActionRecordBase {
  readonly status: "admitted";
  readonly outcome: null;
  readonly admissionEventSequence: number;
  readonly domainEventSequence: number | null;
  readonly domainOperationId: string | null;
  readonly errorCode: null;
}

export type BrowserActionSettlement =
  | {
      readonly outcome: "refused";
      readonly admissionEventSequence: null;
      readonly domainEventSequence: null;
      readonly domainOperationId: null;
      readonly errorCode: string;
    }
  | {
      readonly outcome: "succeeded" | "cancelled";
      readonly admissionEventSequence: number;
      readonly domainEventSequence: number;
      readonly domainOperationId: string | null;
      readonly errorCode: null;
    }
  | {
      readonly outcome: "failed" | "reconciliation_required";
      readonly admissionEventSequence: number;
      readonly domainEventSequence: number | null;
      readonly domainOperationId: string | null;
      readonly errorCode: string;
    };

export type BrowserActionSettledRecord = BrowserActionRecordBase &
  BrowserActionSettlement & {
    readonly status: "settled";
  };

export type BrowserActionRecord =
  | BrowserActionPreparedRecord
  | BrowserActionAdmittedRecord
  | BrowserActionSettledRecord;

export interface BrowserActionDescriptor extends BrowserActionDescriptorFields {
  readonly actionDigest: string;
  readonly label: string;
  readonly consequence: string;
}

/** The only durable request fields a browser receipt may disclose. */
export interface BrowserActionReceipt {
  readonly actionId: string;
  readonly kind: BrowserActionKind;
  readonly status: BrowserActionStatus;
  readonly outcome: BrowserActionOutcome | null;
  readonly errorCode: string | null;
  readonly updatedAt: string;
}

/** Process-local coordinator evidence supplied to descriptor construction. */
export interface ActiveBrowserActionBinding {
  readonly actionId: string;
  readonly actionDigest: string;
  readonly kind: BrowserActionKind;
  readonly generation: number;
  readonly cancellable: boolean;
}

const BROWSER_ACTION_COPY: Readonly<
  Record<BrowserActionKind, { readonly label: string; readonly consequence: string }>
> = {
  "egress.approve": {
    label: "Approve exact context egress",
    consequence:
      "Validate the pinned context, call the configured provider for a plan, and stop at plan approval. This does not commit, push, merge, or deploy.",
  },
  "plan.approve": {
    label: "Approve bounded plan and execute",
    consequence:
      "Create only Icarus-private Git cache/worktree state, call the configured provider, apply only the approved targets, run registered sandbox checks, and stop at review. This does not commit, push, merge, or deploy.",
  },
  "review.approve": {
    label: "Accept reviewed change",
    consequence:
      "Revalidate the complete displayed diff, passing checks, checkpoint, and private worktree, then record acceptance. This does not commit, push, merge, or deploy.",
  },
  "review.reject": {
    label: "Reject and roll back change",
    consequence:
      "Record rejection and restore the approved baseline bytes inside the Icarus-private worktree. The source checkout and Git refs remain unchanged.",
  },
  "rollback.approve": {
    label: "Roll back accepted change",
    consequence:
      "Restore the approved baseline bytes inside the Icarus-private worktree. The source checkout and Git refs remain unchanged.",
  },
  "restore.approve": {
    label: "Restore rolled-back change",
    consequence:
      "Restore the checkpointed approved bytes inside the Icarus-private worktree and rerun registered sandbox checks. This does not commit, push, merge, or deploy.",
  },
  "run.resume": {
    label: "Resume interrupted run",
    consequence:
      "Resume only the persisted recovery stage under existing approvals and ceilings. Interrupted effects are not treated as successful or replayed blindly.",
  },
  "run.cancel": {
    label: "Cancel run",
    consequence:
      "Persist cancellation intent, stop the bound in-flight browser action when present, and restore baseline bytes in the Icarus-private worktree. Socket disconnect alone never cancels.",
  },
};

export function browserActionCopy(kind: BrowserActionKind): {
  readonly label: string;
  readonly consequence: string;
} {
  return BROWSER_ACTION_COPY[kind];
}

export function browserActionReceipt(record: BrowserActionRecord): BrowserActionReceipt {
  return {
    actionId: record.actionId,
    kind: record.kind,
    status: record.status,
    outcome: record.outcome,
    errorCode: record.errorCode,
    updatedAt: record.updatedAt,
  };
}

/**
 * Only these fields are needed to prove a bound cancellation names the exact
 * same-run, admitted, non-cancellation action and descriptor digest.
 */
export interface BrowserActionParentSnapshot {
  readonly actionId: string;
  readonly runId: string;
  readonly kind: BrowserActionKind;
  readonly status: BrowserActionStatus;
  readonly actionDigest: string;
}

export function isBrowserActionKind(value: unknown): value is BrowserActionKind {
  return typeof value === "string" && BROWSER_ACTION_KIND_SET.has(value);
}

export function isBrowserActionStatus(value: unknown): value is BrowserActionStatus {
  return typeof value === "string" && BROWSER_ACTION_STATUS_SET.has(value);
}

export function isBrowserActionOutcome(value: unknown): value is BrowserActionOutcome {
  return typeof value === "string" && BROWSER_ACTION_OUTCOME_SET.has(value);
}

export function browserActionRequiresSubject(kind: BrowserActionKind): boolean {
  return SUBJECT_ACTION_KINDS.has(kind);
}

export function isBrowserActionRunStateEligible(kind: BrowserActionKind, state: RunState): boolean {
  const states = (BROWSER_ACTION_EXPECTED_STATES as Readonly<Record<string, readonly RunState[]>>)[
    kind
  ];
  return states?.includes(state) === true;
}

export function assertBrowserActionRunStateEligible(
  kind: BrowserActionKind,
  state: RunState,
): void {
  invariant(
    isBrowserActionKind(kind) && isBrowserActionRunStateEligible(kind, state),
    "INVALID_BROWSER_ACTION",
    "Browser action kind and expected state are inconsistent",
    { kind, expectedState: state },
  );
}

export function assertBrowserActionSubject(
  kind: BrowserActionKind,
  subjectDigest: string | null,
): void {
  invariant(isBrowserActionKind(kind), "INVALID_BROWSER_ACTION", "Browser action kind is invalid");
  if (browserActionRequiresSubject(kind)) {
    invariant(
      typeof subjectDigest === "string" && SHA256_PATTERN.test(subjectDigest),
      "INVALID_BROWSER_ACTION",
      "Browser action subject must be a canonical lowercase SHA-256 digest",
      { kind },
    );
    return;
  }
  invariant(
    subjectDigest === null,
    "INVALID_BROWSER_ACTION",
    "Browser resume and cancellation actions must not have a subject digest",
    { kind },
  );
}

export function assertBrowserActionParentShape(input: BrowserActionDescriptorFields): void {
  invariant(
    isBrowserActionKind(input.kind),
    "INVALID_BROWSER_ACTION",
    "Browser action kind is invalid",
  );
  const hasActionId = input.activeActionId !== null;
  const hasActionDigest = input.activeActionDigest !== null;
  invariant(
    hasActionId === hasActionDigest,
    "INVALID_BROWSER_ACTION",
    "Cancellation parent action ID and digest must both be present or both be null",
    { kind: input.kind },
  );
  if (input.kind !== "run.cancel") {
    invariant(
      !hasActionId,
      "INVALID_BROWSER_ACTION",
      "Only run.cancel may bind an active browser action",
      { kind: input.kind },
    );
    return;
  }
  if (hasActionId) {
    invariant(
      UUID_PATTERN.test(input.activeActionId ?? ""),
      "INVALID_BROWSER_ACTION",
      "Cancellation parent action ID must be a canonical lowercase RFC 4122 UUID",
    );
    invariant(
      SHA256_PATTERN.test(input.activeActionDigest ?? ""),
      "INVALID_BROWSER_ACTION",
      "Cancellation parent action digest must be a canonical lowercase SHA-256 digest",
    );
  }
}

export function assertBrowserActionDescriptorFields(input: BrowserActionDescriptorFields): void {
  invariant(
    input.version === BROWSER_ACTION_DESCRIPTOR_VERSION,
    "INVALID_BROWSER_ACTION",
    "Browser action descriptor version is invalid",
  );
  invariant(
    isBrowserActionKind(input.kind),
    "INVALID_BROWSER_ACTION",
    "Browser action kind is invalid",
  );
  invariant(
    UUID_PATTERN.test(input.runId),
    "INVALID_BROWSER_ACTION",
    "Browser action run ID must be a canonical lowercase RFC 4122 UUID",
  );
  invariant(
    Number.isSafeInteger(input.eventRevision) && input.eventRevision >= 1,
    "INVALID_BROWSER_ACTION",
    "Browser action event revision must be a safe positive integer",
  );
  assertBrowserActionRunStateEligible(input.kind, input.expectedState);
  assertBrowserActionSubject(input.kind, input.subjectDigest);
  assertBrowserActionParentShape(input);
}

/**
 * ADR 0029 canonical descriptor bytes are UTF-8 JSON for this exact tuple.
 * JSON arrays fix order and JSON.stringify emits no whitespace.
 */
export function browserActionDescriptorTuple(
  input: BrowserActionDescriptorFields,
): BrowserActionDescriptorTuple {
  assertBrowserActionDescriptorFields(input);
  return [
    BROWSER_ACTION_DESCRIPTOR_VERSION,
    input.kind,
    input.runId,
    input.expectedState,
    input.eventRevision,
    input.subjectDigest,
    input.activeActionId,
    input.activeActionDigest,
  ];
}

export function browserActionDescriptorDigest(input: BrowserActionDescriptorFields): string {
  return sha256(JSON.stringify(browserActionDescriptorTuple(input)));
}

export function assertBrowserActionIdentity(input: BrowserActionIdentity): void {
  assertBrowserActionDescriptorFields(input);
  invariant(
    UUID_PATTERN.test(input.actionId),
    "INVALID_BROWSER_ACTION",
    "Browser action ID must be a canonical lowercase RFC 4122 UUID",
  );
  invariant(
    SHA256_PATTERN.test(input.actionDigest) &&
      input.actionDigest === browserActionDescriptorDigest(input),
    "INVALID_BROWSER_ACTION",
    "Browser action digest does not match the canonical descriptor",
  );
}

export function browserActionIdentityTuple(
  input: BrowserActionIdentity,
): BrowserActionIdentityTuple {
  return [
    input.actionId,
    input.version,
    input.kind,
    input.runId,
    input.expectedState,
    input.eventRevision,
    input.subjectDigest,
    input.activeActionId,
    input.activeActionDigest,
    input.actionDigest,
  ];
}

export function hasSameBrowserActionIdentity(
  existing: BrowserActionIdentity,
  incoming: BrowserActionIdentity,
): boolean {
  const left = browserActionIdentityTuple(existing);
  const right = browserActionIdentityTuple(incoming);
  return left.every((value, index) => value === right[index]);
}

export function assertSameBrowserActionIdentity(
  existing: BrowserActionIdentity,
  incoming: BrowserActionIdentity,
): void {
  if (!hasSameBrowserActionIdentity(existing, incoming)) {
    throw new IcarusError(
      "ACTION_ID_CONFLICT",
      "Browser action ID is already bound to a different immutable request tuple",
      { actionId: incoming.actionId },
    );
  }
}

export function assertBrowserActionCancellationParent(
  input: BrowserActionDescriptorFields,
  parent: BrowserActionParentSnapshot | null,
): void {
  assertBrowserActionDescriptorFields(input);
  if (input.activeActionId === null) {
    invariant(
      parent === null,
      "INVALID_BROWSER_ACTION",
      "A state-based cancellation must not have a parent action",
    );
    return;
  }

  invariant(
    parent !== null,
    "INVALID_BROWSER_ACTION",
    "A parent-bound cancellation requires its admitted parent action",
  );
  invariant(
    UUID_PATTERN.test(parent.actionId) && SHA256_PATTERN.test(parent.actionDigest),
    "INVALID_BROWSER_ACTION",
    "Cancellation parent identity is invalid",
  );
  invariant(
    parent.actionId === input.activeActionId &&
      parent.actionDigest === input.activeActionDigest &&
      parent.runId === input.runId &&
      parent.status === "admitted" &&
      isBrowserActionKind(parent.kind) &&
      parent.kind !== "run.cancel",
    "INVALID_BROWSER_ACTION",
    "Cancellation parent must be the exact same-run admitted non-cancellation action",
    { actionId: input.activeActionId },
  );
}

export function canTransitionBrowserAction(
  from: BrowserActionStatus,
  to: BrowserActionStatus,
  outcome: BrowserActionOutcome | null,
): boolean {
  if (from === "prepared" && to === "admitted") return outcome === null;
  if (from === "prepared" && to === "settled") return outcome === "refused";
  if (from === "admitted" && to === "settled") {
    return (
      outcome === "succeeded" ||
      outcome === "failed" ||
      outcome === "cancelled" ||
      outcome === "reconciliation_required"
    );
  }
  return false;
}

export function assertBrowserActionTransition(
  from: BrowserActionStatus,
  to: BrowserActionStatus,
  outcome: BrowserActionOutcome | null,
): void {
  if (!canTransitionBrowserAction(from, to, outcome)) {
    throw new IcarusError(
      "INVALID_BROWSER_ACTION_TRANSITION",
      `Cannot transition browser action from ${from} to ${to}`,
      { from, to, outcome },
    );
  }
}

function assertEventSequence(value: number | null, label: string): void {
  invariant(
    value === null || (Number.isSafeInteger(value) && value >= 1),
    "INVALID_BROWSER_ACTION_SETTLEMENT",
    `${label} must be null or a safe positive integer`,
  );
}

function assertDomainOperationId(value: string | null): void {
  invariant(
    value === null || UUID_PATTERN.test(value),
    "INVALID_BROWSER_ACTION_SETTLEMENT",
    "Domain operation ID must be null or a canonical lowercase RFC 4122 UUID",
  );
}

function assertErrorCode(value: string | null): void {
  invariant(
    value === null || ERROR_CODE_PATTERN.test(value),
    "INVALID_BROWSER_ACTION_SETTLEMENT",
    "Browser action error code must be null or a safe uppercase code",
  );
}

export function assertBrowserActionSettlement(
  from: BrowserActionStatus,
  settlement: BrowserActionSettlement,
): void {
  invariant(
    isBrowserActionOutcome(settlement.outcome),
    "INVALID_BROWSER_ACTION_SETTLEMENT",
    "Browser action settlement outcome is invalid",
  );
  assertBrowserActionTransition(from, "settled", settlement.outcome);
  assertEventSequence(settlement.admissionEventSequence, "Admission event sequence");
  assertEventSequence(settlement.domainEventSequence, "Domain event sequence");
  assertDomainOperationId(settlement.domainOperationId);
  assertErrorCode(settlement.errorCode);

  if (settlement.outcome === "refused") {
    invariant(
      settlement.admissionEventSequence === null &&
        settlement.domainEventSequence === null &&
        settlement.domainOperationId === null &&
        settlement.errorCode !== null,
      "INVALID_BROWSER_ACTION_SETTLEMENT",
      "A prepared refusal must have no admission or domain anchor and must have a safe error code",
    );
    return;
  }

  if (settlement.outcome === "succeeded" || settlement.outcome === "cancelled") {
    invariant(
      settlement.admissionEventSequence !== null &&
        settlement.domainEventSequence !== null &&
        settlement.errorCode === null,
      "INVALID_BROWSER_ACTION_SETTLEMENT",
      "A successful or cancelled settlement requires admission and terminal domain events",
    );
    return;
  }

  invariant(
    settlement.admissionEventSequence !== null && settlement.errorCode !== null,
    "INVALID_BROWSER_ACTION_SETTLEMENT",
    "A failed or reconciliation settlement requires admission and a safe error code",
  );
}
