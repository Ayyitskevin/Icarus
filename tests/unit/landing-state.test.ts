import { describe, expect, it } from "vitest";

import { IcarusError } from "../../packages/core/src/errors.js";
import {
  assertLandingStateResumePair,
  assertLandingTransition,
  canAttachLandingHttpKind,
  canResolveLandingTo,
  canStartLandingOperation,
  canTransitionLanding,
  isLandingHttpKindV1,
  isLandingOperationKindV1,
  isLandingResumeStateV1,
  isLandingStateV1,
  isLandingTerminalState,
  isValidLandingStateResumePair,
  LANDING_HTTP_KINDS,
  LANDING_OPERATION_KINDS,
  LANDING_RECONCILIATION_TARGETS_BY_RESUME,
  LANDING_RESUME_STATES,
  LANDING_STATES,
  LANDING_TERMINAL_STATES,
  type LandingHttpKindV1,
  type LandingOperationKindV1,
  type LandingResumeStateV1,
  type LandingStateV1,
  landingOperationActionState,
  landingOperationExpectedStates,
  landingOperationHttpKinds,
  landingResumeStatesFor,
  landingTransitionTargets,
} from "../../packages/core/src/landing-state.js";

const EXPECTED_TRANSITIONS: Readonly<Record<LandingStateV1, readonly LandingStateV1[]>> = {
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
};

const EXPECTED_RESUME_STATES: Readonly<Record<LandingStateV1, readonly LandingResumeStateV1[]>> = {
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
};

const EXPECTED_OPERATION_STATES: Readonly<
  Record<LandingOperationKindV1, readonly LandingStateV1[]>
> = {
  "candidate.prepare": ["preparing_candidate"],
  "local_ref.create": ["approved"],
  "github.preflight": ["local_ready", "objects_ready", "remote_ready"],
  "github.objects.upload": ["local_ready"],
  "github.ref.create": ["objects_ready"],
  "github.pull_request.create": ["remote_ready"],
  "landing.reconcile": ["reconciliation_required"],
};

const EXPECTED_ACTION_STATE: Readonly<Record<LandingOperationKindV1, LandingStateV1 | null>> = {
  "candidate.prepare": null,
  "local_ref.create": "creating_local_ref",
  "github.preflight": null,
  "github.objects.upload": "uploading_objects",
  "github.ref.create": "creating_remote_ref",
  "github.pull_request.create": "opening_draft_pr",
  "landing.reconcile": null,
};

const EXPECTED_HTTP_KINDS: Readonly<Record<LandingOperationKindV1, readonly LandingHttpKindV1[]>> =
  {
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
  };

function expectIcarusCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(IcarusError);
    expect((error as IcarusError).code).toBe(code);
  }
}

describe("landing state v1", () => {
  it("closes every direct transition and terminal state", () => {
    expect(Object.keys(EXPECTED_TRANSITIONS).sort()).toEqual([...LANDING_STATES].sort());
    expect(LANDING_TERMINAL_STATES).toEqual(["landed", "rejected", "abandoned"]);

    for (const from of LANDING_STATES) {
      expect(landingTransitionTargets(from)).toEqual(EXPECTED_TRANSITIONS[from]);
      expect(isLandingTerminalState(from)).toBe(
        (LANDING_TERMINAL_STATES as readonly LandingStateV1[]).includes(from),
      );
      for (const to of LANDING_STATES) {
        const allowed = EXPECTED_TRANSITIONS[from].includes(to);
        expect(canTransitionLanding(from, to), `${from} -> ${to}`).toBe(allowed);
        if (allowed) {
          expect(() => assertLandingTransition(from, to)).not.toThrow();
        } else {
          expectIcarusCode(
            () => assertLandingTransition(from, to),
            "INVALID_LANDING_STATE_TRANSITION",
          );
        }
      }
    }
  });

  it("closes every state/resume-state pair, including explicit null", () => {
    const candidates: readonly (LandingResumeStateV1 | null)[] = [null, ...LANDING_RESUME_STATES];

    for (const state of LANDING_STATES) {
      expect(landingResumeStatesFor(state)).toEqual(EXPECTED_RESUME_STATES[state]);
      for (const resumeState of candidates) {
        const allowed =
          EXPECTED_RESUME_STATES[state].length === 0
            ? resumeState === null
            : resumeState !== null && EXPECTED_RESUME_STATES[state].includes(resumeState);
        expect(isValidLandingStateResumePair(state, resumeState), `${state}/${resumeState}`).toBe(
          allowed,
        );
        if (allowed) {
          expect(() => assertLandingStateResumePair(state, resumeState)).not.toThrow();
        } else {
          expectIcarusCode(
            () => assertLandingStateResumePair(state, resumeState),
            "LANDING_RECORD_INVALID",
          );
        }
      }
    }
  });

  it("maps failed resumes and reconciliation outcomes without guessed progress", () => {
    for (const resumeState of LANDING_RESUME_STATES) {
      for (const target of LANDING_STATES) {
        expect(canResolveLandingTo("failed", resumeState, target)).toBe(target === resumeState);
      }
    }

    expect(LANDING_RECONCILIATION_TARGETS_BY_RESUME).toEqual({
      approved: ["approved", "local_ready"],
      local_ready: ["local_ready", "objects_ready"],
      objects_ready: ["objects_ready", "remote_ready"],
      remote_ready: ["remote_ready", "landed"],
    });
    for (const resumeState of LANDING_RESUME_STATES) {
      for (const target of LANDING_STATES) {
        const expected =
          resumeState !== "preparing_candidate" &&
          (
            LANDING_RECONCILIATION_TARGETS_BY_RESUME[
              resumeState as Exclude<LandingResumeStateV1, "preparing_candidate">
            ] as readonly LandingStateV1[]
          ).includes(target);
        expect(
          canResolveLandingTo("reconciliation_required", resumeState, target),
          `${resumeState} -> ${target}`,
        ).toBe(expected);
      }
    }
  });

  it("closes operation state, action-state, and HTTP-kind tables", () => {
    for (const operationKind of LANDING_OPERATION_KINDS) {
      expect(landingOperationExpectedStates(operationKind)).toEqual(
        EXPECTED_OPERATION_STATES[operationKind],
      );
      expect(landingOperationActionState(operationKind)).toBe(EXPECTED_ACTION_STATE[operationKind]);
      expect(landingOperationHttpKinds(operationKind)).toEqual(EXPECTED_HTTP_KINDS[operationKind]);

      for (const state of LANDING_STATES) {
        expect(canStartLandingOperation(operationKind, state)).toBe(
          EXPECTED_OPERATION_STATES[operationKind].includes(state),
        );
      }
      for (const httpKind of LANDING_HTTP_KINDS) {
        expect(canAttachLandingHttpKind(operationKind, httpKind)).toBe(
          EXPECTED_HTTP_KINDS[operationKind].includes(httpKind),
        );
      }
    }
  });

  it("rejects values outside all four closed enumerations", () => {
    for (const value of [null, 1, "", "landed ", "github.push", "candidate.run"]) {
      expect(isLandingStateV1(value)).toBe(false);
      expect(isLandingResumeStateV1(value)).toBe(false);
      expect(isLandingOperationKindV1(value)).toBe(false);
      expect(isLandingHttpKindV1(value)).toBe(false);
    }

    expect(LANDING_STATES.every(isLandingStateV1)).toBe(true);
    expect(LANDING_RESUME_STATES.every(isLandingResumeStateV1)).toBe(true);
    expect(LANDING_OPERATION_KINDS.every(isLandingOperationKindV1)).toBe(true);
    expect(LANDING_HTTP_KINDS.every(isLandingHttpKindV1)).toBe(true);
  });
});
