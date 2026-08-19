import { IcarusError } from "./errors.js";
import {
  assertLiveEvidenceProfileApproved,
  assertLiveEvidenceProfileMatchesManifest,
  type LiveEvidenceBudgetV1,
  type LiveEvidenceEffect,
  type LiveEvidenceProfileV1,
} from "./live-evidence-profile.js";

// Authorization and effect accounting for a Gate 1 live-evidence run (S3).
//
// The offline Gate 1 benchmark proves safety by pinning its effect counters to
// zero: no paid provider call, no credential read, no external network request,
// no remote mutation. A live run cannot use zeros, so it needs the same
// discipline expressed as ceilings that come from an approved profile rather
// than from a constant.
//
// This module is that gate. It decides whether a live run may begin, and it is
// the ledger the executor must consult before every effect. It performs no I/O
// of its own: it reads no file, opens no socket, and never reads a credential
// VALUE — only whether the named environment variable is present, because a
// run that will fail for a missing token should fail before it mutates a
// repository, not halfway through case two.
//
// Fail-closed is the rule throughout. An unknown case, an unauthorized effect,
// a second draft-pull-request POST, or an exceeded budget throws rather than
// returning a value the caller might ignore.

export interface LiveEvidenceRunAuthorizationV1 {
  readonly profileId: string;
  readonly caseIds: readonly string[];
  readonly effects: readonly LiveEvidenceEffect[];
  readonly budgets: LiveEvidenceBudgetV1;
  /** Deduplicated credential environment variable names, confirmed present.
   * Names only — no value is ever read, stored, or surfaced. */
  readonly credentialEnvironmentNames: readonly string[];
}

export interface LiveEvidenceEffectSummaryV1 {
  readonly caseId: string;
  readonly effects: Readonly<Record<LiveEvidenceEffect, number>>;
}

export interface LiveEvidenceLedgerSummaryV1 {
  readonly profileId: string;
  readonly cases: readonly LiveEvidenceEffectSummaryV1[];
  readonly spendUsd: number;
  readonly elapsedSeconds: number;
  readonly budgets: LiveEvidenceBudgetV1;
}

function refuse(message: string): never {
  throw new IcarusError("LIVE_EVIDENCE_REFUSED", message);
}

/**
 * Decide whether a live run may begin.
 *
 * Every precondition is checked before the caller can perform any effect:
 * the approval must bind to this exact profile content, the profile must
 * target the reviewed manifest and its complete case set, and every credential
 * the run will need must already be present in the environment.
 */
export function authorizeLiveEvidenceRun(
  profile: LiveEvidenceProfileV1,
  manifest: {
    readonly benchmarkId?: unknown;
    readonly benchmarkRevision?: unknown;
    readonly cases?: unknown;
  },
  manifestDigest: string,
  environment: NodeJS.ProcessEnv,
): LiveEvidenceRunAuthorizationV1 {
  assertLiveEvidenceProfileApproved(profile);
  assertLiveEvidenceProfileMatchesManifest(profile, manifest, manifestDigest);

  const credentialEnvironmentNames: string[] = [];
  for (const entry of profile.cases) {
    const name = entry.landingProfile.credentialRef.name;
    if (!credentialEnvironmentNames.includes(name)) {
      credentialEnvironmentNames.push(name);
    }
  }
  for (const name of credentialEnvironmentNames) {
    // Presence only. The value is never read into a variable, compared, or
    // included in any message; a credential must not be able to reach an error
    // string, a log line, or durable state through this check.
    const present = Object.hasOwn(environment, name) && environment[name] !== "";
    if (!present) {
      refuse(
        `live-evidence run requires environment variable ${name}, which is absent or empty; refusing before any remote effect`,
      );
    }
  }

  return {
    profileId: profile.profileId,
    caseIds: profile.cases.map((entry) => entry.caseId),
    effects: profile.authorizedEffects,
    budgets: profile.budgets,
    credentialEnvironmentNames,
  };
}

/**
 * The ledger the executor consults before every effect.
 *
 * Draft pull-request creation is admitted at most once per case, ever. That
 * mirrors the durable `one_create_pr_post_per_landing` index in the landing
 * schema: a lost or ambiguous response is reconciled by reading, never by a
 * second POST, so a ledger that permitted a retry here would contradict the
 * database that refuses it.
 */
export class LiveEvidenceEffectLedger {
  readonly #authorization: LiveEvidenceRunAuthorizationV1;
  readonly #counts: Map<string, Map<LiveEvidenceEffect, number>>;
  #spendUsd = 0;
  #elapsedSeconds = 0;

  constructor(authorization: LiveEvidenceRunAuthorizationV1) {
    this.#authorization = authorization;
    this.#counts = new Map(
      authorization.caseIds.map((caseId) => [caseId, new Map<LiveEvidenceEffect, number>()]),
    );
  }

  recordEffect(caseId: string, effect: LiveEvidenceEffect): void {
    const caseCounts = this.#counts.get(caseId);
    if (caseCounts === undefined) {
      refuse(`live-evidence effect recorded for unknown case ${caseId}`);
    }
    if (!this.#authorization.effects.includes(effect)) {
      refuse(`effect ${effect} is not authorized by profile ${this.#authorization.profileId}`);
    }
    const previous = caseCounts.get(effect) ?? 0;
    if (effect === "github.pull_request.create.draft" && previous >= 1) {
      refuse(
        `case ${caseId} already created its draft pull request; a lost or ambiguous response is reconciled by reading, never by a second POST`,
      );
    }
    caseCounts.set(effect, previous + 1);
  }

  /** Cumulative spend against the profile ceiling. Refuses on the call that
   * would exceed it, so the ceiling is a bound rather than a report. */
  recordSpend(usd: number): void {
    if (!Number.isFinite(usd) || usd < 0) {
      refuse("live-evidence spend must be a non-negative finite number");
    }
    const next = this.#spendUsd + usd;
    if (next > this.#authorization.budgets.maxSpendUsd) {
      refuse(
        `live-evidence run would exceed its spend ceiling of ${this.#authorization.budgets.maxSpendUsd} USD`,
      );
    }
    this.#spendUsd = next;
  }

  /** Total elapsed runtime against the profile ceiling. */
  recordElapsed(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds < 0) {
      refuse("live-evidence elapsed time must be a non-negative finite number");
    }
    const next = this.#elapsedSeconds + seconds;
    if (next > this.#authorization.budgets.maxRuntimeSeconds) {
      refuse(
        `live-evidence run would exceed its runtime ceiling of ${this.#authorization.budgets.maxRuntimeSeconds} seconds`,
      );
    }
    this.#elapsedSeconds = next;
  }

  /**
   * Every case must have completed the full authorized chain. A run where one
   * case uploaded objects but never opened its pull request is incomplete
   * evidence, and incomplete evidence must not be reported as 3/3.
   */
  assertComplete(): void {
    for (const caseId of this.#authorization.caseIds) {
      const caseCounts = this.#counts.get(caseId);
      for (const effect of this.#authorization.effects) {
        if ((caseCounts?.get(effect) ?? 0) < 1) {
          refuse(`case ${caseId} did not record required effect ${effect}; evidence is incomplete`);
        }
      }
    }
  }

  summary(): LiveEvidenceLedgerSummaryV1 {
    return {
      profileId: this.#authorization.profileId,
      cases: this.#authorization.caseIds.map((caseId) => {
        const caseCounts = this.#counts.get(caseId);
        const effects = Object.fromEntries(
          this.#authorization.effects.map((effect) => [effect, caseCounts?.get(effect) ?? 0]),
        ) as Record<LiveEvidenceEffect, number>;
        return { caseId, effects };
      }),
      spendUsd: this.#spendUsd,
      elapsedSeconds: this.#elapsedSeconds,
      budgets: this.#authorization.budgets,
    };
  }
}
