# ADR 0045: Gate 1 credential-gated live-evidence profile

- Status: Proposed — offline record and validation only; no live run is
  authorized by this ADR, and no credential, network call, or remote effect is
  performed by anything it adds
- Date: 2026-08-18
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
three binding properties.

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
