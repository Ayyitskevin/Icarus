import { IcarusError } from "./errors.js";

export const LANDING_STATES = [
  "preparing_candidate",
  "awaiting_approval",
  "approved",
  "creating_local_ref",
  "local_ready",
  "uploading_objects",
  "objects_ready",
  "creating_remote_ref",
  "remote_ready",
  "opening_draft_pr",
  "landed",
  "reconciliation_required",
  "rejected",
  "abandoned",
  "failed",
] as const;

export type LandingStateV1 = (typeof LANDING_STATES)[number];

export const LANDING_RESUME_STATES = [
  "preparing_candidate",
  "approved",
  "local_ready",
  "objects_ready",
  "remote_ready",
] as const;

export type LandingResumeStateV1 = (typeof LANDING_RESUME_STATES)[number];

export const LANDING_OPERATION_KINDS = [
  "candidate.prepare",
  "local_ref.create",
  "github.preflight",
  "github.objects.upload",
  "github.ref.create",
  "github.pull_request.create",
  "landing.reconcile",
] as const;

export type LandingOperationKindV1 = (typeof LANDING_OPERATION_KINDS)[number];

export const LANDING_HTTP_KINDS = [
  "github.actor.get",
  "github.base_ref.get",
  "github.head_ref.get",
  "github.pull_requests.get",
  "github.blob.post",
  "github.tree.post",
  "github.commit.post",
  "github.ref.post",
  "github.pull_request.post",
] as const;

export type LandingHttpKindV1 = (typeof LANDING_HTTP_KINDS)[number];

export const LANDING_TERMINAL_STATES = [
  "landed",
  "rejected",
  "abandoned",
] as const satisfies readonly LandingStateV1[];

const DIRECT_TRANSITIONS = {
  preparing_candidate: ["awaiting_approval", "abandoned", "failed"],
  awaiting_approval: ["approved", "rejected", "abandoned"],
  approved: ["creating_local_ref", "failed"],
  creating_local_ref: ["local_ready", "reconciliation_required", "failed"],
  local_ready: ["uploading_objects", "failed"],
  uploading_objects: ["objects_ready", "reconciliation_required", "failed"],
  objects_ready: ["creating_remote_ref", "reconciliation_required", "failed"],
  creating_remote_ref: ["remote_ready", "reconciliation_required", "failed"],
  remote_ready: ["opening_draft_pr", "reconciliation_required", "failed"],
  opening_draft_pr: ["landed", "reconciliation_required", "failed"],
  landed: [],
  reconciliation_required: ["approved", "local_ready", "objects_ready", "remote_ready", "landed"],
  rejected: [],
  abandoned: [],
  failed: [
    "preparing_candidate",
    "approved",
    "local_ready",
    "objects_ready",
    "remote_ready",
    "abandoned",
  ],
} as const satisfies Readonly<Record<LandingStateV1, readonly LandingStateV1[]>>;

const RESUME_STATES_BY_STATE = {
  preparing_candidate: [],
  awaiting_approval: [],
  approved: [],
  creating_local_ref: [],
  local_ready: [],
  uploading_objects: [],
  objects_ready: [],
  creating_remote_ref: [],
  remote_ready: [],
  opening_draft_pr: [],
  landed: [],
  reconciliation_required: ["approved", "local_ready", "objects_ready", "remote_ready"],
  rejected: [],
  abandoned: [],
  failed: ["preparing_candidate", "approved", "local_ready", "objects_ready", "remote_ready"],
} as const satisfies Readonly<Record<LandingStateV1, readonly LandingResumeStateV1[]>>;

/**
 * A reconciliation marker names the stable state before the uncertain effect.
 * Fresh evidence may prove either that exact retry stage or the one completed
 * delivery stage that follows it.
 */
export const LANDING_RECONCILIATION_TARGETS_BY_RESUME = {
  approved: ["approved", "local_ready"],
  local_ready: ["local_ready", "objects_ready"],
  objects_ready: ["objects_ready", "remote_ready"],
  remote_ready: ["remote_ready", "landed"],
} as const satisfies Readonly<
  Record<Exclude<LandingResumeStateV1, "preparing_candidate">, readonly LandingStateV1[]>
>;

const EXPECTED_STATES_BY_OPERATION = {
  "candidate.prepare": ["preparing_candidate"],
  "local_ref.create": ["approved"],
  "github.preflight": ["local_ready", "objects_ready", "remote_ready"],
  "github.objects.upload": ["local_ready"],
  "github.ref.create": ["objects_ready"],
  "github.pull_request.create": ["remote_ready"],
  "landing.reconcile": ["reconciliation_required"],
} as const satisfies Readonly<Record<LandingOperationKindV1, readonly LandingStateV1[]>>;

const ACTION_STATE_BY_OPERATION = {
  "candidate.prepare": null,
  "local_ref.create": "creating_local_ref",
  "github.preflight": null,
  "github.objects.upload": "uploading_objects",
  "github.ref.create": "creating_remote_ref",
  "github.pull_request.create": "opening_draft_pr",
  "landing.reconcile": null,
} as const satisfies Readonly<Record<LandingOperationKindV1, LandingStateV1 | null>>;

const HTTP_KINDS_BY_OPERATION = {
  "candidate.prepare": [],
  "local_ref.create": [],
  "github.preflight": [
    "github.actor.get",
    "github.base_ref.get",
    "github.head_ref.get",
    "github.pull_requests.get",
  ],
  "github.objects.upload": [
    "github.actor.get",
    "github.blob.post",
    "github.tree.post",
    "github.commit.post",
  ],
  "github.ref.create": [
    "github.actor.get",
    "github.base_ref.get",
    "github.head_ref.get",
    "github.ref.post",
  ],
  "github.pull_request.create": [
    "github.actor.get",
    "github.base_ref.get",
    "github.head_ref.get",
    "github.pull_requests.get",
    "github.pull_request.post",
  ],
  "landing.reconcile": [
    "github.actor.get",
    "github.base_ref.get",
    "github.head_ref.get",
    "github.pull_requests.get",
  ],
} as const satisfies Readonly<Record<LandingOperationKindV1, readonly LandingHttpKindV1[]>>;

export function isLandingStateV1(value: unknown): value is LandingStateV1 {
  return typeof value === "string" && (LANDING_STATES as readonly string[]).includes(value);
}

export function isLandingResumeStateV1(value: unknown): value is LandingResumeStateV1 {
  return typeof value === "string" && (LANDING_RESUME_STATES as readonly string[]).includes(value);
}

export function isLandingOperationKindV1(value: unknown): value is LandingOperationKindV1 {
  return (
    typeof value === "string" && (LANDING_OPERATION_KINDS as readonly string[]).includes(value)
  );
}

export function isLandingHttpKindV1(value: unknown): value is LandingHttpKindV1 {
  return typeof value === "string" && (LANDING_HTTP_KINDS as readonly string[]).includes(value);
}

export function isLandingTerminalState(state: LandingStateV1): boolean {
  return (LANDING_TERMINAL_STATES as readonly LandingStateV1[]).includes(state);
}

export function landingTransitionTargets(from: LandingStateV1): readonly LandingStateV1[] {
  return DIRECT_TRANSITIONS[from];
}

export function canTransitionLanding(from: LandingStateV1, to: LandingStateV1): boolean {
  return (DIRECT_TRANSITIONS[from] as readonly LandingStateV1[]).includes(to);
}

export function assertLandingTransition(from: LandingStateV1, to: LandingStateV1): void {
  if (!canTransitionLanding(from, to)) {
    throw new IcarusError(
      "INVALID_LANDING_STATE_TRANSITION",
      `Cannot transition landing from ${from} to ${to}`,
      { from, to },
    );
  }
}

export function landingResumeStatesFor(state: LandingStateV1): readonly LandingResumeStateV1[] {
  return RESUME_STATES_BY_STATE[state];
}

export function isValidLandingStateResumePair(
  state: LandingStateV1,
  resumeState: LandingResumeStateV1 | null,
): boolean {
  const permitted = RESUME_STATES_BY_STATE[state] as readonly LandingResumeStateV1[];
  return permitted.length === 0
    ? resumeState === null
    : resumeState !== null && permitted.includes(resumeState);
}

export function assertLandingStateResumePair(
  state: LandingStateV1,
  resumeState: LandingResumeStateV1 | null,
): void {
  if (!isValidLandingStateResumePair(state, resumeState)) {
    throw new IcarusError(
      "LANDING_RECORD_INVALID",
      "Landing state and resume state are inconsistent",
      { state, resumeState },
    );
  }
}

export function canResolveLandingTo(
  state: "failed" | "reconciliation_required",
  resumeState: LandingResumeStateV1,
  to: LandingStateV1,
): boolean {
  if (!isValidLandingStateResumePair(state, resumeState)) return false;
  if (state === "failed") return to === resumeState;
  if (resumeState === "preparing_candidate") return false;
  return (
    LANDING_RECONCILIATION_TARGETS_BY_RESUME[resumeState] as readonly LandingStateV1[]
  ).includes(to);
}

export function landingOperationExpectedStates(
  kind: LandingOperationKindV1,
): readonly LandingStateV1[] {
  return EXPECTED_STATES_BY_OPERATION[kind];
}

export function canStartLandingOperation(
  kind: LandingOperationKindV1,
  state: LandingStateV1,
): boolean {
  return (EXPECTED_STATES_BY_OPERATION[kind] as readonly LandingStateV1[]).includes(state);
}

export function landingOperationActionState(kind: LandingOperationKindV1): LandingStateV1 | null {
  return ACTION_STATE_BY_OPERATION[kind];
}

export function landingOperationHttpKinds(
  kind: LandingOperationKindV1,
): readonly LandingHttpKindV1[] {
  return HTTP_KINDS_BY_OPERATION[kind];
}

export function canAttachLandingHttpKind(
  operationKind: LandingOperationKindV1,
  httpKind: LandingHttpKindV1,
): boolean {
  return (HTTP_KINDS_BY_OPERATION[operationKind] as readonly LandingHttpKindV1[]).includes(
    httpKind,
  );
}
