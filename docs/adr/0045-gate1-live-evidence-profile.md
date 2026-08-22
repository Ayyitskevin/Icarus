# ADR 0045: Gate 1 credential-gated live-evidence profile

- Status: Proposed — offline record and validation only; no live run is
  authorized by this ADR, and no credential, network call, or remote effect is
  performed by anything it adds
- Date: 2026-08-18; amended 2026-08-21 with the post-merge review remediation
  below
- Related: [ADR 0027](0027-git-landing-authority.md) (git landing authority),
  [ADR 0043](0043-github-gateway-boundary.md) (GitHub gateway boundary),
  and draft ADR 0044 (headless workspace harness direction, authored by the
  codex seat and reviewed PASS by glm; 0044 is reserved for it, so this record
  takes 0045),
  [ADR 0036](0036-proof-carrying-software-factory-product-direction.md)
  (Gate 1 as the Verified Change Gate)

## Context

The offline Gate 1 benchmark reproduces byte-pinned candidate objects against
fixture repositories and reports `assessment:
contract_passed_gate1_live_evidence_not_run` with `liveEvidenceNotRun: 3`. It
deliberately never contacts GitHub, so it cannot demonstrate that the landing
chain — object upload, absent-only reference creation, draft pull request,
receipt, and reconciliation — works against a real repository.

`docs/PLANS.md` holds Gate 1 open on four items. Three of them are this record:
a versioned, separately approved profile bound to the offline manifest digest
and exact case pins; pinned real provider/model, pricing, and budgets alongside
an operator assessment of each repository's branch/PR-triggered automation; and
authorization limited to named effects with every prohibition retained. The
fourth is the operator's 3/3 run, which this ADR does not perform.

Two facts shape the design.

First, the landing chain already has an authority record. `GitHubLandingProfileV1`
pins owner, repository, base branch, credential environment name, expected
actor, commit identity, and `derivativeEffects` — a disposition of
`inert-repository` or `operator-approved` plus an operator evidence digest.
That last field *is* the per-repository automation assessment. Restating it in
a second record would create two sources of truth for one fact, which ADR 0026
already rejected for sessions and tool invocations.

Second, per `docs/OPERATIONS.md`, creating a head reference or opening a
same-repo draft pull request causes the head branch's own automation to run
with repository secrets. That is a code-execution boundary. The assessment is
therefore mandatory input, not documentation.

## Decision

Introduce `LiveEvidenceProfileV1`, an offline, strictly decoded record with
three binding properties, admitted by an authorization function and consumed
through an effect ledger that together add a fourth (see **Runtime authority
boundary** below).

1. **Manifest, case, and target binding.** The profile pins
   `offlineManifestDigest`, `benchmarkId`, and `benchmarkRevision`; its case set
   must be a bijection with the offline manifest's; and each case's embedded
   landing owner, repository, and base branch must equal the identity that
   manifest case pins. A profile covering a subset cannot produce complete
   evidence; one naming an unknown case targets unreviewed work. Changing the
   manifest invalidates the profile.

   A matching case-id set alone is **not** a pin. An independent review of the
   first implementation demonstrated this by construction: a profile carrying
   the exact manifest digest, the exact case ids, and a self-consistent
   approval was accepted while aiming a case at `unreviewed-repository`. The
   repository is the field that decides which real repository receives real
   effects, so it is bound explicitly. A manifest case that carries no
   repository identity is refused rather than treated as unconstrained —
   absence must not read as permission.

   Those identities must also be **distinct**. A manifest mapping two case ids
   to one `owner/repository` — or repeating a case id — is refused. Two cases
   sharing one repository would let a single landing receive two
   draft-pull-request POSTs while each case's own ledger count stayed at one,
   contradicting the durable `one_create_pr_post_per_landing` index.
   `scripts/gate1-benchmark-contract.mjs` already refuses such a manifest, but
   it is a separate, untyped validator that may simply not have run: a public
   authorization function establishes its own prerequisites rather than
   assuming a caller established them. The uniqueness key is `owner/name`,
   identical to that validator's, so the two contracts cannot drift.

2. **Closed effect set.** `authorizedEffects` must equal
   `["github.objects.upload", "github.ref.create.absent_only",
   "github.pull_request.create.draft", "github.landing.receipt"]` exactly, by
   ordered equality rather than subset. Authority that can be widened by
   appending an entry is not a bound. Force update, reference deletion, merge,
   deployment, and source-checkout mutation remain inexpressible because no
   effect naming them exists in the set or the gateway.

3. **Digest-bound approval.** `approval.profileDigestSha256` is the digest of
   the record with `approval` removed. Editing any pinned field after approval
   invalidates it. Approval attaches to exact content, never to a profile name —
   the same property plan-digest approvals already carry elsewhere.

4. **Runtime authority boundary.** Authority is enforced at runtime, not by
   type annotation. `readonly` disappears at compile time and the callers of
   this record are not all typed, so the authorization returned by
   `authorizeLiveEvidenceRun` is frozen at every level, and
   `LiveEvidenceEffectLedger` re-checks and copies the authorization it is
   handed instead of retaining it. A ledger that trusted its argument would
   inherit whatever the caller did to that object afterwards, and would honour
   a hand-built authorization naming an effect outside the closed set.

   The same boundary covers the credential preflight and the effect sequence:

   - The preflight requires the **pinned provider's** credential as well as
     each case's landing credential. It resolves the name through
     `providerCredentialEnvironmentName`, the table `createGateway` reads, so
     the check cannot assert one variable while the run consumes another.
     Presence only — the value is never read into a variable, compared, or
     placed in a message.
   - The authorized effect list is also the landing **chain**, in order. Each
     case must walk it forwards without skipping; repeating the stage a case
     occupies stays admissible because uploads legitimately recur. Counting
     alone would let a runner report a complete multiset it never earned — a
     receipt recorded before anything was uploaded is a claim about a landing
     that did not happen.
   - A ceiling that cannot bound anything is refused. `NaN` and `Infinity` make
     every `next > ceiling` comparison false, which turns a stated budget into
     a no-op that still reads as a bound.

Each case embeds a full `GitHubLandingProfileV1`, decoded by the existing
decoder. The automation assessment is thereby mandatory by construction rather
than by convention, and its validation rules are not duplicated.

The profile also pins the real provider, model, adapter version, and captured
pricing, plus `maxSpendUsd` and `maxRuntimeSeconds` ceilings. A zero spend
ceiling is valid, because a loopback provider genuinely costs nothing.

## Consequences

- Gate 1's remaining engineering work becomes reviewable offline, before any
  credential exists. The record can be inspected, tested, and approved without
  a single network call.
- An approved profile is a durable, auditable answer to "who authorized what,
  against which repositories, under what ceilings, bound to which contract."
- A repository swap after approval — the highest-consequence tamper, since it
  redirects real effects at a real repository — invalidates approval rather
  than inheriting it. A repository that was wrong *at* approval time is caught
  separately by the manifest identity comparison, which is the case digest
  binding alone cannot catch.
- The profile alone authorizes nothing. Consuming it in a runner, and the run
  itself, remain separate work under operator control.
- Strict-decode helpers are duplicated privately in the new module rather than
  exported from `landing-records.ts`. This keeps a large, recently changed file
  untouched at the cost of about forty repeated lines; factoring them into a
  shared decode module is a reasonable follow-up if a reviewer prefers it.

## Post-merge review remediation (2026-08-21)

An independent non-author review of the merged implementation
(`70b0b95`, commits `b0abe18` and `af493d0`) returned HOLD with four findings,
all reproduced by a probe against the exact merged head while the full release
gate still exited 0. That is the useful part of the record: a 973-test suite
and a green gate did not cover any of them, because the tests and the claim
came from the same mental model.

| Finding | Defect | Remedy |
| --- | --- | --- |
| 1 (High) | The preflight collected only each landing profile's GitHub credential, so an OpenAI or Anthropic profile authorized with no model key | Provider credential required, resolved through the shared table |
| 2 (High) | Manifest case identities were bound per case but never required to be distinct | Distinct case ids and `owner/repository` identities, matching the benchmark validator |
| 3 (High) | `effects` and `budgets` were returned by reference and retained by the ledger, so both were mutable after digest-bound approval | Frozen authorization; ledger re-checks and copies |
| 4 (Medium) | The ledger checked membership and counts but never the chain order | Per-case monotonic chain with no skipped stage |

Two boundaries were deliberately left where they are. Repeats of the stage a
case occupies remain admissible for every effect except the draft POST, whose
cap mirrors the durable index; a per-effect cap on ref creation or receipts
would be a new constraint this review did not ask for and the landing schema
does not state. And the ledger cannot validate that a budget it is handed is
the budget a human approved — it has no access to the profile — so it checks
only that the ceiling is a real bound. Binding budget provenance belongs with
the case executor, which does hold both.

## Alternatives rejected

- **Extend `GitHubLandingProfileV1` with benchmark fields.** Overloads a record
  used by ordinary landings with gate-only concerns, and would let benchmark
  changes churn production landing validation.
- **Restate the automation assessment in the new record.** Two sources of truth
  for whether a repository executes code on PR creation; they would drift, and
  the drift would be invisible until a live run executed something unexpected.
- **Accept `authorizedEffects` as a subset of a larger allowlist.** Makes
  widening authority a one-line diff that reads as configuration rather than as
  an authority change.
- **Approve by profile id or file path.** Approval would survive edits to the
  thing approved, which is the failure digest-bound approvals exist to prevent.
