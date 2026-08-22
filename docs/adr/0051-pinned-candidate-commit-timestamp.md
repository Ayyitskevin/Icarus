# ADR 0051: A landing may pin its candidate commit timestamp, and nothing else

- Status: Proposed — an optional input with no default behaviour change; absent
  the pin, the clock decides exactly as before
- Date: 2026-08-22
- Related: [ADR 0027](0027-git-landing-authority.md) (git landing authority),
  [ADR 0045](0045-gate1-live-evidence-profile.md) and
  [ADR 0050](0050-live-evidence-manifest-money-and-model-binding.md) (the Gate 1
  live-evidence profile this unblocks)
- Numbering: 0050 is claimed by the live-evidence manifest binding; the codex
  seat holds unpushed 0044 and 0046–0049.

## Context

Gate 1's committed manifest pins, per case, the exact candidate the run must
produce:

```json
"candidateCommitSha1":  "b3626c47c17494760835ebbf279685759be84345",
"commitEpochSeconds":   1704067200,
"commitIdentity":       { "name": "Icarus Gate 1 Benchmark", "email": "…" }
```

and the case's `draftPullRequestEvidence` separately pins
`expectedCandidateCommitSha1` to the same SHA. A Git commit hashes its
committer timestamp, so reproducing that SHA requires reproducing that epoch.

`LandingCoordinator.prepareLanding` derived the epoch from `this.#now()` and
stored it on the durable landing record; the candidate stage then reads
`landing.commitEpochSeconds` back and honours it. So the whole chain downstream
of `prepareLanding` was already deterministic given an epoch. Exactly one line
made it non-reproducible.

The offline evaluator already passes the manifest's pinned epoch directly to
`landingGit.prepareCandidate`, which is why the offline benchmark reproduces the
pinned SHA today. Only the live path, which goes through `prepareLanding`, could
not.

## Decision

`PrepareLandingInput` gains an optional `commitEpochSeconds`. When absent, the
clock decides and behaviour is unchanged. When present it is used for the
candidate commit, and:

- it must be a non-negative safe integer;
- it must not be in the future relative to the observed clock;
- the existing `commitEpochToGitInstant` bound still applies.

It is recorded durably on the landing record exactly as an observed value is.

### Why not the `now` seam that already exists

`LandingCoordinatorOptions` already takes `now: () => string`, and pinning the
commit through it would have required no new input at all. That is the wrong
answer and it is worth recording why, because it is the obvious one.

`#now()` is the clock for **everything the coordinator writes** — admission
records, settlements, events, state transitions. Pinning it to 2024-01-01 to
obtain a reproducible commit would backdate the entire durable evidence trail of
a run that actually happened in 2026. Gate 1 exists to produce trustworthy
evidence; an evidence trail that misreports when things happened is a worse
failure than a non-deterministic commit, and it would be invisible in exactly
the way this repository's last several defects were invisible — everything would
pass, and the record would lie.

So the pin is per landing, applies to the commit instant alone, and every other
timestamp continues to come from the clock. A test proves this by difference:
two identical landings, one pinned and one not, must agree on every other
durable timestamp and differ only in the commit instant.

### Why the future is refused

A commit dated after the moment it was created is a false claim about the past.
No legitimate caller needs one, and refusing it costs nothing.

### Where the authority to pin lives

Not here. `prepareLanding` treats the pin as caller-supplied and does not know
what a live-evidence profile is; coupling the landing coordinator to Gate 1
machinery would put benchmark concerns inside the production landing path. The
authority that a *particular* epoch may be pinned belongs to the caller — for
Gate 1, the future case executor, which holds the digest-bound approved profile
and the manifest that pins the value.

That is deliberately weaker than "only an approved profile may pin", and the
weakness is bounded: the pinned value is durably recorded, the resulting commit
SHA is derived from it, and Gate 1's own success condition requires that SHA to
equal the manifest's. A wrong pin does not produce misleading evidence; it
produces evidence that fails to match, which is the correct outcome.

## Consequences

- The Gate 1 live path can reproduce `candidateCommitSha1`, which
  `candidate_commit_and_absent_only_branch_exact` requires. This was the second
  of the two hard blockers under the executor; it turned out to be one optional
  field rather than a runtime clock seam.
- Ordinary landings are untouched. No caller passes the field today.
- No schema change and no migration: the landing record already carries
  `commitEpochSeconds`, because the wall-clock value was always stored there.
- A reviewer reading a landing record can compare its commit instant against the
  run's own event timestamps and see that it was pinned. Nothing hides.

## Alternatives rejected

- **Pin through the coordinator's `now` seam.** Backdates the whole evidence
  trail. See above.
- **Require the pin to arrive with a live-evidence profile.** Puts Gate 1
  machinery inside the production landing coordinator and inverts the layering.
  The manifest's own SHA comparison already catches a wrong pin.
- **Drop `expectedCandidateCommitSha1` from the evidence and verify only the
  tree SHA and diff.** Cheaper, and it silently removes one of the pins Gate 1
  exists to prove. If it is ever taken it must be an explicit, documented
  downgrade with its own ADR — not a default reached by finding the commit
  inconvenient to reproduce.
