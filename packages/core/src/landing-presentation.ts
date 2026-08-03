import { sha256 } from "./digest.js";
import { IcarusError } from "./errors.js";
import type { LandingStatusV1 } from "./landing-ledger.js";
import {
  canonicalizePullRequestBodyPrefix,
  canonicalizePullRequestTitle,
  DERIVATIVE_EFFECTS,
  DERIVATIVE_GITHUB_EVENTS,
  DIRECT_ICARUS_EFFECTS,
  landingPullRequestMarkerV1,
} from "./landing-records.js";
import type { RunLandingPresentation } from "./types.js";

export const LANDING_DIRECT_ICARUS_EFFECTS = DIRECT_ICARUS_EFFECTS;
export const LANDING_DERIVATIVE_GITHUB_EVENTS = DERIVATIVE_GITHUB_EVENTS;
export const LANDING_DERIVATIVE_MAY_TRIGGER = DERIVATIVE_EFFECTS;

export const LANDING_EFFECT_WARNING =
  "Landing approval authorizes Icarus to create one private local ref, upload immutable GitHub objects, create one absent-only GitHub branch, and open one draft pull request. GitHub create and pull_request.opened events may trigger repository-configured Actions, webhooks, bots, notifications, or deployments. Icarus does not suppress those derivative effects or gain authority to invoke their endpoints directly.";

export interface LandingApprovalPresentationV1 {
  readonly landingId: string;
  readonly state: RunLandingPresentation["state"];
  readonly resumeState: RunLandingPresentation["resumeState"];
  readonly version: number;
  readonly landingSha256: string | null;
  readonly candidateCommitSha1: string | null;
  readonly pullRequestTitle: string;
  readonly pullRequestBody: string | null;
  readonly decision: RunLandingPresentation["decision"];
  readonly errorCode: string | null;
  readonly updatedAt: string;
  readonly directIcarusEffects: typeof LANDING_DIRECT_ICARUS_EFFECTS;
  readonly derivativeEffectDisclosure: {
    readonly version: 1;
    readonly githubEvents: typeof LANDING_DERIVATIVE_GITHUB_EVENTS;
    readonly mayTrigger: typeof LANDING_DERIVATIVE_MAY_TRIGGER;
    readonly disposition: "inert-repository" | "operator-approved";
    readonly evidenceSha256: string;
  };
  readonly effectWarning: typeof LANDING_EFFECT_WARNING;
}

export interface LandingStatusPresentationV1 {
  /** Independent from the ordinary run-event cursor. */
  readonly landingRevision: number;
  /** Exact operator-facing approval projection. */
  readonly approval: LandingApprovalPresentationV1 | null;
  /** Complete durable evidence, including attempts, operations, and events. */
  readonly status: LandingStatusV1 | null;
}

function invalid(message: string): never {
  throw new IcarusError("LANDING_RECORD_INVALID", message);
}

function derivedPullRequestBody(status: LandingStatusV1): string | null {
  const { landing } = status;
  if (landing.landingSha256 === null) {
    if (landing.candidateCommitSha1 !== null || landing.pullRequestBodySha256 !== null) {
      invalid("Unsettled landing has partial candidate presentation evidence");
    }
    return null;
  }
  if (
    !/^[a-f0-9]{64}$/u.test(landing.landingSha256) ||
    landing.candidateCommitSha1 === null ||
    !/^[a-f0-9]{40}$/u.test(landing.candidateCommitSha1) ||
    landing.pullRequestBodySha256 === null ||
    !/^[a-f0-9]{64}$/u.test(landing.pullRequestBodySha256)
  ) {
    invalid("Settled landing is missing bounded pull-request presentation evidence");
  }

  const title = canonicalizePullRequestTitle(landing.pullRequestTitle);
  if (title !== landing.pullRequestTitle || sha256(title) !== landing.pullRequestTitleSha256) {
    invalid("Landing pull-request title does not match its durable digest");
  }
  const bodyPrefix = canonicalizePullRequestBodyPrefix(landing.pullRequestBodyPrefix);
  if (
    bodyPrefix !== landing.pullRequestBodyPrefix ||
    sha256(bodyPrefix) !== landing.pullRequestBodyPrefixSha256
  ) {
    invalid("Landing pull-request body prefix does not match its durable digest");
  }

  const body =
    `${bodyPrefix}\n\n` +
    "Icarus landing evidence v1\n" +
    `run-id: ${landing.runId}\n` +
    `candidate-commit-sha1: ${landing.candidateCommitSha1}\n` +
    `plan-sha256: ${landing.planSha256}\n` +
    `diff-sha256: ${landing.diffSha256}\n` +
    `checkpoint-sha256: ${landing.checkpointSha256}\n` +
    "object-format: sha1\n" +
    "\n" +
    landingPullRequestMarkerV1(landing.id, landing.landingSha256);
  if (sha256(body) !== landing.pullRequestBodySha256) {
    invalid("Derived landing pull-request body does not match its durable digest");
  }
  return body;
}

export function presentLandingApprovalV1(
  landing: RunLandingPresentation,
): LandingApprovalPresentationV1 {
  return {
    landingId: landing.landingId,
    state: landing.state,
    resumeState: landing.resumeState,
    version: landing.version,
    landingSha256: landing.landingSha256,
    candidateCommitSha1: landing.candidateCommitSha1,
    pullRequestTitle: landing.pullRequestTitle,
    pullRequestBody: landing.pullRequestBody,
    decision:
      landing.decision === null
        ? null
        : {
            actor: landing.decision.actor,
            decision: landing.decision.decision,
            createdAt: landing.decision.createdAt,
          },
    errorCode: landing.errorCode,
    updatedAt: landing.updatedAt,
    directIcarusEffects: LANDING_DIRECT_ICARUS_EFFECTS,
    derivativeEffectDisclosure: {
      version: 1,
      githubEvents: LANDING_DERIVATIVE_GITHUB_EVENTS,
      mayTrigger: LANDING_DERIVATIVE_MAY_TRIGGER,
      disposition: landing.derivativeEffects.disposition,
      evidenceSha256: landing.derivativeEffects.evidenceSha256,
    },
    effectWarning: LANDING_EFFECT_WARNING,
  };
}

export function presentLandingStatusV1(
  status: LandingStatusV1 | null,
): LandingStatusPresentationV1 {
  if (status === null) {
    return {
      landingRevision: 0,
      approval: null,
      status: null,
    };
  }
  if (!Number.isSafeInteger(status.revision) || status.revision < 0) {
    invalid("Landing revision is not a nonnegative safe integer");
  }
  const { landing } = status;
  return {
    landingRevision: status.revision,
    approval: presentLandingApprovalV1({
      landingId: landing.id,
      state: landing.state,
      resumeState: landing.resumeState,
      version: landing.version,
      landingSha256: landing.landingSha256,
      candidateCommitSha1: landing.candidateCommitSha1,
      pullRequestTitle: landing.pullRequestTitle,
      pullRequestBody: derivedPullRequestBody(status),
      derivativeEffects: landing.profile.derivativeEffects,
      decision:
        status.decision === null
          ? null
          : {
              actor: status.decision.actor,
              decision: status.decision.decision,
              createdAt: status.decision.createdAt,
            },
      errorCode: landing.errorCode,
      updatedAt: landing.updatedAt,
    }),
    status,
  };
}
