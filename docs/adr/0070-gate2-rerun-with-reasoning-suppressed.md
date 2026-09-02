# ADR 0070: Gate 2 measures content generation, with reasoning suppressed

- Status: **Accepted** — the operator authorised the rerun and this setting on 2026-08-31
- Date: 2026-08-31
- Related: [ADR 0066](0066-gate2-live-model-comparison.md), [ADR 0067](0067-gate2-target-discovery-profile.md),
  [the zero-yield diagnosis](../diagnoses/2026-08-30-gate2-zero-yield-thinking-displacement.md)

## Context

Gate 2's profile pins `maxTokens: 8192` and the instruction policy presents it as the
budget for a model's answer. Under Vulcan's Ollama path a reasoning model spends that
same budget on reasoning the gateway then discards, with no observable split. The
diagnosis of the eight zero-yield cases measured the consequence: `rawCandidate: ''`
returned after the full budget was billed, recorded as though the model had produced
nothing, when in fact it had produced reasoning nobody kept.

So `maxTokens` was pinned as a content budget and behaved as a combined one. Every
observation taken under it — including the 5/30 and 16/30 in ADR 0067 — was measured
against a budget whose meaning was not the one the profile stated.

Vulcan `c6223a6` (deployed on mickey, verified 2026-08-31) adds a tri-state `think` on
the request path and surfaces `thinking` on responses, so the split is now controllable
and observable. The benchmark had deliberately not used it, with a comment saying that
doing so "would change what the profile measures and needs its own accepted ADR". This
is that ADR.

## Decision

Gate 2 sends `think: false`, bound into the instruction policy at revision 9.

- **`maxTokens` becomes a content budget in fact, not only in description.** The
  threshold this gate is judged against — 24/30 success, 0.80 first-plan acceptance —
  is a claim about producing correct answers. Measuring it against a budget a model may
  spend entirely on discarded reasoning does not test that claim; it tests how much
  reasoning the model happens to emit.
- **It is digest-bound in the instruction policy**, not passed at the call site, so no
  run can quietly measure the other thing. The policy SHA moves with it, and every
  result records which policy produced it.
- **The reasoning-cost recording stays.** It reads zero while `think` is false, which is
  itself the evidence that the setting took effect.

## What this measures, and what it does not

This measures **content generation under a stated budget**. It does not measure how much
reasoning these models would emit, whether reasoning improves their answers, or what the
scores would be with reasoning enabled. Those are separate questions and this run cannot
answer them.

In particular: **results are not comparable to ADR 0066's or ADR 0067's numbers as a
before-and-after.** Those were taken under a combined budget. A change in score between
them and this run may reflect the budget's meaning changing rather than any change in
capability, and must not be read as improvement or regression. This run establishes a new
baseline under a stated budget; the earlier figures remain valid records of what was
measured then.

## Expect more honest failures, not fewer failures

Two changes landing alongside this one make previously silent failures loud:

- The Ollama adapter now requires `done_reason === "stop"`, so a response truncated at
  the ceiling is a `PROVIDER_PROTOCOL_ERROR` instead of being scored as an answer, per
  ADR 0066's existing rule that a length stop fails even when the remaining text parses.
- Retrieval now records what a ceiling excluded ([ADR 0069](0069-retrieval-omission-is-evidence.md)),
  so a case whose context was silently truncated is visible rather than inferred.

A lower headline number than ADR 0067's would therefore be consistent with a better
instrument rather than a worse system, and must be read that way unless the evidence
says otherwise.

## Verification

- Vulcan on mickey at `c6223a6`; `think: false` accepted and returns clean content with
  no `thinking` member (probed 2026-08-31 against `code`).
- Both admitted models resolve to the exact digests the profile pins: `code` to
  `qwen3.8:27b` (`22130167c4c2`, 27.3B Q4_K_M) and `code-fast` to `ornith-1.5:35b`
  (`9f3b89b25219`, 35.5B Q4_K_M).
- The setting is asserted in `tests/security/gate2-live-instruction-policy.test.ts`, so
  removing it fails the security suite rather than silently changing the measurement.

## Outcome (2026-09-01)

Full record: [evaluation](../evals/2026-08-31-gate2-reasoning-suppressed.md).

| | baseline `code-fast` | routed `code` |
| --- | --- | --- |
| success | 2/30 | 12/30 |
| first-plan acceptance | 0.0667 | 0.60 |

Both exit thresholds still fail. The headline aggregates repeated across two full
executions; the pipeline output did not reproduce exactly, as one routed case produced a
different candidate and token count between runs.

**The setting reaches the provider, and that is now bound behaviourally.** 60/60 finished
with `stop`, 60/60 usage is provider-reported, and empty candidates fell from 8 to 1.
`reasoningChars` reads 0 on all 60, which means **zero surfaced thinking characters under
a request that sent `think: false`** — not "no reasoning was consumed". Vulcan omits the
member when reasoning is suppressed and the decode that produced this set mapped absence
to `0`. The runner now records `null` for an absent member and pairs it with the requested
mode; this frozen set predates that and cannot support the stronger reading. Amended
2026-09-02: that difference is now a difference in the record's declared revision rather
than a caveat a reader has to remember — see the revision-6 amendment below.

An earlier attempt to record this outcome reported those validity figures from fields the
runner computed but **never serialized** — absence read as measurement, which is the
defect class this campaign exists to close, committed in the validation of the run meant
to demonstrate it was closed. Evidence record revision 5 serializes both the reasoning
size and the retrieval coverage, and every figure here comes from a recorded value in a
run where all 60 cases carry `reassessedFromEvidenceSha256: null`. Amended 2026-09-02:
revision 5 was then made to name two incompatible shapes — see below.

This ADR also claimed that removing the setting would fail the security suite. It would
not have: the policy value was bound, its transmission was not, and deleting the request
field left every check green. A static source check replaced that claim and did not earn
it either — `.includes` passes on a string in a comment. The request body is now built by
an exported function and asserted by a test on the transmitted object, probed by deleting
the field.

**The decision stands; one sentence of its rationale did not.** The argument that
measuring answer quality against a budget a model may spend on discarded reasoning does
not test the claim the threshold makes holds regardless of the result. But the Context
leaned on the diagnosis's *displacement* framing, which implied that freeing the budget
would let content through and scores would rise. Scores under the honest budget are lower
than those recorded under the combined one: the models stopped returning expensive empty
answers and started returning cheap wrong ones.

An earlier version of this section said that refutes pure displacement and is consistent
with reasoning contributing. Both overreach, and the first is wrong on its own terms:
displacement was proposed as the mechanism for *empty content*, and empties fell from 8
to 1 — exactly what that mechanism predicts. That the surfaced answers are frequently
wrong says nothing about why the earlier ones were empty.

This run therefore identifies no cause. Whether reasoning improves these models' answers,
and whether displacement fully explained the zero-yield cases, both remain open, and the
next measurement is the paired reasoning-enabled arm rather than further argument about
these numbers.

**One anomaly survives, now quantified rather than hidden.**
`scaffold-lantern-json-output` returned 0 content characters in 112 provider-reported
output tokens, clean stop, zero reasoning. Those tokens are neither content nor
reasoning; the instrument cannot say where they went. What changed is that it is bounded
and visible instead of looking like model silence.

**What the omission evidence rules out is narrower than it first appears.** No query
match was excluded by a file or byte ceiling in any of the 60 cases. That is not "the
failures are not context starvation": the field says nothing about files that never
matched lexically, reference-hop candidates, or exclusions before candidacy, and macro
recall is `0.9917` rather than `1.0`. So `refactor` 0/5 and `scaffold` 0/5 are not
explained by selection-ceiling truncation, and remain otherwise open.

**Operational consequence worth stating.** Raising the evidence record revision makes an
invocation over older records take the pre-existing reassessment path: it re-scores stored
candidates and makes no provider calls. That is expected, not a fault, and
`reassessedFromEvidenceSha256` makes it visible — but a "re-run" must be checked for that
member being null before its numbers are treated as fresh. One re-run during this work
reported success in six seconds with every new field present and identical aggregates,
having called no provider at all.

**Evidence location.** The revision-5 set is frozen in the repository at
`docs/evals/artifacts/gate2-reasoning-suppressed-20260901/` with a per-file SHA-256
manifest, so every figure recomputes from version control rather than from mutable
node-local state. A stale token total survived one review because it did not.

The first manifest was itself wrong: generated before `pnpm format` reflowed the JSON, it
mis-stated 30 of 64 digests, so the integrity layer added to make stale figures
mechanically catchable was not verifiable on the committed tree. Regenerated after
formatting and verified against the committed bytes. Note what did NOT catch it: no
executable consumer reads this directory, so a 357-assertion security gate stayed green
over a false manifest. That wiring is done as of 2026-09-02 — see below.

## Amendment 2026-09-02: revision 6, and what this set's zeros mean

**Revision 5 named two incompatible shapes.** The frozen records above declare revision 5,
omit `requestedThink`, and encode an absent provider `thinking` member as `reasoningChars: 0`.
The writer that shipped alongside them also declared revision 5 while requiring
`requestedThink` and encoding that same absence as `null` — and its reuse predicate
rejected the very records bearing the revision it claimed to support. An unchanged version
string over a changed wire is the defect this campaign exists to remove, and it was
committed inside the fix for it.

The writer is now at **evidence record revision 6**, and revision 6 is a closed shape:
`requestedThink` is required and must equal the pinned policy's value, `reasoningChars` is
a non-negative count **or null**, the retrieval coverage members are required, and a new
`selectedQueryMatches` member records how many selected files actually matched the query.
That last member is not decoration: `selectedFiles` counts reference-hop entries that never
matched, so in 10 of the 60 records above `selectedFiles` exceeds `matchedFiles`, and no
arithmetic over the members revision 5 recorded can check that a record's coverage claim
reconciles with its own omissions. Revision 6 can.

**The frozen set is not rewritten.** It is a historical record and rewriting it would
falsify it. Instead its manifest now declares, in a machine-checked `recordContract`, the
contract that produced it: revision 5, `requestedThink` absent, absence-of-thinking encoded
as `0`, every record reading `0`, written 2026-09-01. The publication validator checks that
declaration against the bytes, so it is falsifiable rather than prose. **A zero in this set
therefore means "no `thinking` member surfaced under a request that sent `think: false`". A
zero in a revision-6 record means the opposite: a reasoning size the provider reported.**
The manifest schema moved to `icarus.gate2-frozen-evidence.v2` with that member, for the
same reason the record revision moved.

**The directory now has an executable consumer.** `verifyGate2PublishedEvidenceSet` verifies
this set alongside the ADR 0066 v1 and ADR 0067 v2 cohorts: it recomputes both 30-case
results and their comparison, binds all 60 case records, compares the manifest against the
committed bytes, refuses any file in the directory the manifest never listed, and applies
the same `assertNoUnknownSecretShape` screen the earlier cohorts pass. Every identity for
this set is pinned by value, so it stays valid when the live policies move.

**One secret-shaped span was adjudicated, not waved through.** The screen finds exactly one
match in this set outside the three tokens earlier cohorts already cleared, at
`routed/refactor-parser-token-table.json`. The model's candidate answer contains the Python
line `raise ValueError(f"unrecognized boolean token: {value!r}")`; the assignment scanner
reads `token` as a credential key and takes the rest of the line as its value. The captured
span is an f-string interpolation of the rejected input plus its JSON escaping — generated
source, carrying no credential. It is recorded as an exact-span entry in the publisher's
false-positive set, the way earlier cohorts recorded theirs, so the screen is not widened by
a pattern and a later addition still requires a stated reason.

**One correction to the record above.** This section is dated 2026-08-31 in places; every
one of the 60 records carries a `generatedAt` on **2026-09-01** UTC, and the preflight is
`2026-09-01T03:27:20.098Z`. The manifest's `writtenOn` states the date the bytes support.
