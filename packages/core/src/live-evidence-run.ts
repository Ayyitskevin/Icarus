import { IcarusError } from "./errors.js";
import {
  assertLiveEvidenceProfileApproved,
  assertLiveEvidenceProfileMatchesManifest,
  LIVE_EVIDENCE_AUTHORIZED_EFFECTS,
  type LiveEvidenceBudgetV1,
  type LiveEvidenceEffect,
  type LiveEvidenceProfileV1,
} from "./live-evidence-profile.js";
import { providerCredentialEnvironmentName } from "./provider.js";

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
// of its own: it reads no file and opens no socket. It does examine each named
// credential far enough to answer whether the gateway that will spend it would
// accept it, because a run that will fail for an unusable token should fail
// before it mutates a repository, not halfway through case two. That is
// usability, not disclosure: a credential value never reaches a message, the
// returned authorization, the ledger, or durable state.
//
// Fail-closed is the rule throughout. An unknown case, an unauthorized effect,
// an out-of-order effect, a second draft-pull-request POST, or an exceeded
// budget throws rather than returning a value the caller might ignore.
//
// Two properties are enforced at RUNTIME rather than by type annotation,
// because `readonly` disappears at compile time and the callers of this module
// are not all typed:
//
//  * The authorization this module returns is frozen, so effects and budgets
//    cannot be widened after the digest-bound approval that granted them.
//  * The ledger re-checks and COPIES the authorization it is handed instead of
//    retaining it. A ledger that trusted its argument would inherit whatever
//    the caller did to that object afterwards, and a hand-built authorization
//    naming an effect outside the closed set would be honoured.

/** Frozen at every level: the authority a run holds must not change after the
 * approval that granted it. */
export interface LiveEvidenceRunAuthorizationV1 {
  readonly profileId: string;
  readonly caseIds: readonly string[];
  readonly effects: readonly LiveEvidenceEffect[];
  readonly budgets: LiveEvidenceBudgetV1;
  /** Deduplicated credential environment variable names, each confirmed to hold
   * a value the consuming gateway will accept: the pinned provider's key, then
   * each case's landing credential. Names only — no value is ever stored or
   * surfaced here. */
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
 * The bounds every consumer of these credentials already enforces.
 *
 * Three gateways will spend the variables this module admits, and all three
 * apply their own rule at construction: `OpenAIResponsesGateway` and
 * `AnthropicMessagesGateway` require 8 to 512 characters with no whitespace or
 * NUL, and `GithubGateway` requires that plus no other control character. The
 * GitHub rule is therefore the strictest, and its accept set is a subset of the
 * other two — so checking it here is sound for all three at once and cannot
 * admit a value one of them would later reject.
 *
 * Deliberately one predicate rather than a per-provider dispatch. A dispatch
 * would be a fourth place where the rule that decides the blast radius is
 * re-derived, which is the defect class this surface has already produced three
 * times. `tests/security/live-evidence-credential-agreement.test.ts` measures
 * the relation against the real constructors, so a consumer that tightens its
 * rule fails that test rather than silently outgrowing this one.
 */
const CREDENTIAL_MIN_LENGTH = 8;
const CREDENTIAL_MAX_LENGTH = 512;
// Built through `new RegExp(String.raw...)` rather than as a literal, the same
// way `github-gateway`'s CONTROL_CHARACTER_PATTERN is: a regex literal carrying
// a control-character range is a lint error, and the repo already settled on
// this spelling at the boundary that enforces the identical rule.
const CREDENTIAL_UNUSABLE_CHARACTER = new RegExp(String.raw`[\s\x00-\x1f\x7f]`);

/**
 * Usability, never disclosure.
 *
 * The value reaches only this predicate, which returns a boolean. It is never
 * bound to a variable that outlives the call, never compared against another
 * secret, and never reaches the refusal message, the returned authorization,
 * the ledger, a log line, or durable state — only the variable NAME does.
 *
 * `typeof` is checked at runtime rather than trusted from the declared
 * `NodeJS.ProcessEnv`, for the same reason the authorization is frozen rather
 * than marked `readonly`: the callers of this module are not all typed, and an
 * own property holding `undefined` is inside the declared type anyway.
 */
function isUsableCredentialValue(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.length >= CREDENTIAL_MIN_LENGTH &&
    value.length <= CREDENTIAL_MAX_LENGTH &&
    !CREDENTIAL_UNUSABLE_CHARACTER.test(value)
  );
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
  const requireCredential = (name: string): void => {
    if (!credentialEnvironmentNames.includes(name)) {
      credentialEnvironmentNames.push(name);
    }
  };
  // The pinned provider's credential comes first. A live case pays a real model
  // before it touches a repository, so a missing model key must refuse here and
  // not after case one has already uploaded objects and opened a pull request.
  // The name is resolved through the same table the gateway reads, so this
  // preflight cannot assert one variable while the run consumes another.
  const providerCredential = providerCredentialEnvironmentName(profile.provider.kind);
  if (providerCredential !== null) {
    requireCredential(providerCredential);
  }
  for (const entry of profile.cases) {
    requireCredential(entry.landingProfile.credentialRef.name);
  }
  for (const name of credentialEnvironmentNames) {
    if (!Object.hasOwn(environment, name) || environment[name] === "") {
      refuse(
        `live-evidence run requires environment variable ${name}, which is absent or empty; refusing before any remote effect`,
      );
    }
    // Presence is not the question this gate is actually asking. A preflight
    // exists to refuse early what the consumer would refuse late, so it must
    // apply a predicate at least as strong as the one that will spend the
    // credential — otherwise it admits a run it cannot deliver, and case three
    // dies on an unusable token after cases one and two have already uploaded
    // objects and opened pull requests against real repositories. That partial
    // landing is the exact outcome this preflight exists to prevent.
    if (!isUsableCredentialValue(environment[name])) {
      refuse(
        `live-evidence run requires environment variable ${name} to hold a usable credential of ${CREDENTIAL_MIN_LENGTH} to ${CREDENTIAL_MAX_LENGTH} non-whitespace, non-control characters; refusing before any remote effect`,
      );
    }
  }

  // Frozen, and copied before freezing so the caller's profile is not silently
  // frozen with it. Without this, `authorization.effects.push(...)` or a raised
  // `maxSpendUsd` would widen an authority that a human approved by digest.
  return Object.freeze({
    profileId: profile.profileId,
    caseIds: Object.freeze(profile.cases.map((entry) => entry.caseId)),
    effects: Object.freeze([...profile.authorizedEffects]),
    budgets: Object.freeze({
      maxSpendUsd: profile.budgets.maxSpendUsd,
      maxRuntimeSeconds: profile.budgets.maxRuntimeSeconds,
    }),
    credentialEnvironmentNames: Object.freeze([...credentialEnvironmentNames]),
  });
}

/**
 * The ledger the executor consults before every effect.
 *
 * Draft pull-request creation is admitted at most once per case, ever. That
 * mirrors the durable `one_create_pr_post_per_landing` index in the landing
 * schema: a lost or ambiguous response is reconciled by reading, never by a
 * second POST, so a ledger that permitted a retry here would contradict the
 * database that refuses it.
 *
 * The authorized effect list is also the landing CHAIN, in order: objects are
 * uploaded, then the absent-only ref is created, then the draft pull request is
 * opened, then the receipt is written. The ledger binds that sequence per case.
 * Counting alone would let a runner report a complete multiset it never earned
 * — a receipt recorded before anything was uploaded is a claim about a landing
 * that did not happen. Repeating the stage a case is currently in stays
 * admissible, because uploads legitimately recur; going backwards or skipping
 * ahead does not.
 *
 * The authorization is re-checked and copied here rather than retained, so this
 * ledger's bounds do not depend on what the caller does to that object next,
 * nor on the caller having obtained it from `authorizeLiveEvidenceRun` at all.
 */
export class LiveEvidenceEffectLedger {
  readonly #profileId: string;
  readonly #caseIds: readonly string[];
  readonly #effects: readonly LiveEvidenceEffect[];
  readonly #budgets: LiveEvidenceBudgetV1;
  readonly #counts: Map<string, Map<LiveEvidenceEffect, number>>;
  /** Highest chain stage each case has reached; -1 before its first effect. */
  readonly #reachedStage: Map<string, number>;
  #spendUsd = 0;
  #elapsedSeconds = 0;

  constructor(authorization: LiveEvidenceRunAuthorizationV1) {
    const effects = [...authorization.effects];
    // The closed set, in order, or nothing. This is what makes the ledger safe
    // to hand an authorization from an untyped caller: a fabricated object
    // naming `github.ref.force_update` cannot produce a ledger that admits it.
    if (
      effects.length !== LIVE_EVIDENCE_AUTHORIZED_EFFECTS.length ||
      !effects.every((effect, index) => effect === LIVE_EVIDENCE_AUTHORIZED_EFFECTS[index])
    ) {
      refuse(
        `live-evidence authorization must carry exactly ${JSON.stringify(LIVE_EVIDENCE_AUTHORIZED_EFFECTS)}, in that order`,
      );
    }
    const caseIds = [...authorization.caseIds];
    if (caseIds.length === 0) {
      refuse("live-evidence authorization must name at least one case");
    }
    if (new Set(caseIds).size !== caseIds.length) {
      refuse("live-evidence authorization must not repeat a case id");
    }
    const { maxSpendUsd, maxRuntimeSeconds } = authorization.budgets;
    // A non-finite ceiling is not a ceiling: every `next > ceiling` comparison
    // against NaN is false, and Infinity is never exceeded, so either would
    // turn the budget checks below into no-ops.
    if (!Number.isFinite(maxSpendUsd) || maxSpendUsd < 0) {
      refuse("live-evidence authorization must carry a non-negative finite spend ceiling");
    }
    if (!Number.isInteger(maxRuntimeSeconds) || maxRuntimeSeconds <= 0) {
      refuse("live-evidence authorization must carry a positive integer runtime ceiling");
    }

    this.#profileId = authorization.profileId;
    this.#caseIds = Object.freeze(caseIds);
    this.#effects = Object.freeze(effects);
    this.#budgets = Object.freeze({ maxSpendUsd, maxRuntimeSeconds });
    this.#counts = new Map(
      caseIds.map((caseId) => [caseId, new Map<LiveEvidenceEffect, number>()]),
    );
    this.#reachedStage = new Map(caseIds.map((caseId) => [caseId, -1]));
  }

  recordEffect(caseId: string, effect: LiveEvidenceEffect): void {
    const caseCounts = this.#counts.get(caseId);
    if (caseCounts === undefined) {
      refuse(`live-evidence effect recorded for unknown case ${caseId}`);
    }
    const stage = this.#effects.indexOf(effect);
    if (stage === -1) {
      refuse(`effect ${effect} is not authorized by profile ${this.#profileId}`);
    }
    const reached = this.#reachedStage.get(caseId) ?? -1;
    if (stage < reached) {
      refuse(
        `case ${caseId} recorded ${effect} after reaching ${this.#effects[reached]}; the landing chain runs in one direction`,
      );
    }
    if (stage > reached + 1) {
      refuse(
        `case ${caseId} recorded ${effect} before ${this.#effects[reached + 1]}; the landing chain admits no skipped stage`,
      );
    }
    const previous = caseCounts.get(effect) ?? 0;
    if (effect === "github.pull_request.create.draft" && previous >= 1) {
      refuse(
        `case ${caseId} already created its draft pull request; a lost or ambiguous response is reconciled by reading, never by a second POST`,
      );
    }
    caseCounts.set(effect, previous + 1);
    this.#reachedStage.set(caseId, stage);
  }

  /** Cumulative spend against the profile ceiling. Refuses on the call that
   * would exceed it, so the ceiling is a bound rather than a report. */
  recordSpend(usd: number): void {
    if (!Number.isFinite(usd) || usd < 0) {
      refuse("live-evidence spend must be a non-negative finite number");
    }
    const next = this.#spendUsd + usd;
    if (next > this.#budgets.maxSpendUsd) {
      refuse(
        `live-evidence run would exceed its spend ceiling of ${this.#budgets.maxSpendUsd} USD`,
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
    if (next > this.#budgets.maxRuntimeSeconds) {
      refuse(
        `live-evidence run would exceed its runtime ceiling of ${this.#budgets.maxRuntimeSeconds} seconds`,
      );
    }
    this.#elapsedSeconds = next;
  }

  /**
   * Every case must have completed the full authorized chain. A run where one
   * case uploaded objects but never opened its pull request is incomplete
   * evidence, and incomplete evidence must not be reported as 3/3. Ordering is
   * already bound by `recordEffect`, so a case holding all four counts held
   * them in the one admissible sequence.
   */
  assertComplete(): void {
    for (const caseId of this.#caseIds) {
      const caseCounts = this.#counts.get(caseId);
      for (const effect of this.#effects) {
        if ((caseCounts?.get(effect) ?? 0) < 1) {
          refuse(`case ${caseId} did not record required effect ${effect}; evidence is incomplete`);
        }
      }
    }
  }

  summary(): LiveEvidenceLedgerSummaryV1 {
    return {
      profileId: this.#profileId,
      cases: this.#caseIds.map((caseId) => {
        const caseCounts = this.#counts.get(caseId);
        const effects = Object.fromEntries(
          this.#effects.map((effect) => [effect, caseCounts?.get(effect) ?? 0]),
        ) as Record<LiveEvidenceEffect, number>;
        return { caseId, effects };
      }),
      spendUsd: this.#spendUsd,
      elapsedSeconds: this.#elapsedSeconds,
      budgets: this.#budgets,
    };
  }
}
