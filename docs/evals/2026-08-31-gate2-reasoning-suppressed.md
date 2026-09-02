# Gate 2 live rerun with reasoning suppressed — 2026-08-31

> Rewritten 2026-09-01 against a fresh execution. The first version of this record
> reported validity figures read from fields the runner computed but never serialized,
> so "zero thinking characters" and "zero omitted matches" were absence, not
> measurement. Record revision 5 serializes both, with one reading to carry: it wrote
> an absent provider `thinking` member as `reasoningChars: 0`, so every zero in this set
> means "no thinking member surfaced under think:false", never a measured zero. Revision
> 6 (PR #80) records that absence as `null`, and the frozen set's manifest states which
> encoding its bytes use. Every figure below comes from a recorded value in a genuinely
> fresh run (`reassessedFromEvidenceSha256: null` on all 60 cases).

## Question

Gate 2's profile pins `maxTokens: 8192` and presents it as the budget for a model's
answer, but under Vulcan's Ollama path a reasoning model spends that same budget on
reasoning the gateway discards, with no observable split.
[ADR 0070](../adr/0070-gate2-rerun-with-reasoning-suppressed.md) makes it a content
budget in fact by binding `think: false` into instruction-policy revision 9.

**With the budget meaning what it says, what does Gate 2 measure?**

## Result

30 cases per arm, 11 minutes, on mickey against Vulcan `c6223a6`.

| | baseline `code-fast` | routed `code` |
| --- | --- | --- |
| success | **2/30** | **12/30** |
| first-plan acceptance | 0.0667 | **0.60** |
| repair | 1 | 7 |
| explanation | 0 | 3 |
| security_review | 1 | 2 |
| refactor | **0** | **0** |
| scaffold | **0** | **0** |
| median cost per success | $0.000936 | $0.000732 |

Retrieval was identical across arms: macro recall `0.9917`, macro precision `0.8083`,
digest provenance coverage `1.0`, incorrect edits `0`. **Both Gate 2 exit thresholds
still fail**: 24/30 success and 0.80 first-plan acceptance remain open.

The headline aggregates above repeated across two full executions of the 30-case set, so
they are not a single lucky pass. **The pipeline output did not reproduce exactly**: one
routed case (`scaffold-greeting-command`) produced a different candidate and a different
token count between runs, 3,690 and 3,082, while success and plan aggregates were
unchanged. Aggregate stability is not byte determinism, and an earlier version of this
record claimed the stronger thing.

## What the recorded evidence supports

- **`reasoningChars: 0` on all 60 cases** — read precisely, **zero surfaced thinking
  characters under a request that sent `think: false`**. That is not the same as "no case
  spent budget on reasoning". Vulcan omits the `thinking` member entirely when reasoning
  is suppressed, and the decode that produced this frozen set mapped a missing member to
  `0`, so the zero is synthesized from absence. The runner now records `null` for an
  absent or malformed member and pairs it with the requested mode, so a future set can
  state the stronger claim; **this set cannot**, and the figure is reported for what it
  is. The 112-token empty case below is why the distinction matters.
- **60/60 `finishReason: "stop"`** and **60/60 `usageBasis: "provider_reported"`.** No
  truncation, no timeouts, no protocol failures, and every token count is observed
  rather than a charged upper bound.
- **Empty candidates fell from 8 to 1.** The routed arm generated **9,390** output tokens
  across 30 cases and the baseline arm 7,807, both recomputable from the frozen artifact
  set. For scale, a single zero-yield case burned 8,192 tokens on 2026-08-30 to return an
  empty string. An earlier version of this record cited 9,998 here — a figure copied from
  the previous execution into a document whose premise is that every number comes from
  the fresh one. It survived review once; freezing the evidence is what makes that class
  of error mechanically checkable.

## The one remaining anomaly, now quantified

`scaffold-lantern-json-output` (routed) returned **0 content characters in 112
provider-reported output tokens**, with `finishReason: "stop"`, no provider failure, and
`reasoningChars: 0`.

Those 112 tokens are neither content nor reasoning. The instrument cannot currently say
where they went, and this record does not claim to know. What changed is that the
anomaly is *visible and bounded* instead of being folded into "the model produced
nothing" — which is precisely what the earlier eight cases looked like before the budget
was made honest. It remains open.

## What this does and does not establish

**Establishes.** Under a budget that means what it states, routed `code` reaches 12/30
with first-plan acceptance 0.60 and fixed `code-fast` reaches 2/30, on this manifest,
this profile, one seed.

**Observes.** Scores under the honest budget are lower than the figures recorded under
the combined budget, and empty candidates fell from 8 to 1.

**Does not establish, in either direction.** An earlier version of this record said the
result "refutes pure displacement" and was "consistent with reasoning contributing". Both
overreach, and the first is wrong on its own terms: displacement was proposed as the
mechanism for *empty content*, and empties falling from 8 to 1 is exactly what that
mechanism predicts. That the newly surfaced answers are frequently wrong says nothing
about why the earlier ones were empty.

With no paired reasoning-enabled arm under the observable protocol, and with the two
figure sets taken under different budget contracts, this run identifies no cause. Whether
reasoning improves these models' answers, and whether displacement fully explained the
zero-yield cases, both remain open. The next measurement is the paired arm, not more
argument about these numbers.

**Not a before-and-after.** ADR 0066's and ADR 0067's numbers remain valid records of
what was measured then, under a budget whose meaning differed. A lower number here is not
a regression and is not reported as one.

## What the omission evidence rules out, precisely

This is the first Gate 2 run with [ADR 0069](../adr/0069-retrieval-omission-is-evidence.md)
evidence actually recorded. Across all 60 cases, **no query match was excluded by the
file or byte ceiling** — `omittedMatches` is empty everywhere.

That is a narrower statement than "the failures are not context starvation," which an
earlier version of this record claimed and the evidence does not support. `omittedMatches`
covers query-matched files dropped at a selection ceiling. It says nothing about relevant
files that never matched lexically, about reference-hop candidates, or about files
excluded before candidacy. Macro retrieval recall is `0.9917`, not `1.0` — something was
missed, and this field is not the instrument that would find it.

So `refactor` 0/5 and `scaffold` 0/5 are **not explained by selection-ceiling truncation**.
Whether they are capability, instruction, or a retrieval mechanism this field does not
cover remains open.

## Limitations

- One profile, two models, one seed, no repetition across seeds.
- `refactor` and `scaffold` floor at zero in both arms, so the sixfold success ratio rests
  entirely on repair, explanation, and security review. It is a one-run, three-class
  observation, not a routing or capability estimate.
- Cost figures apply the profile's captured price table to observed tokens;
  `actualBilledUsd` is null throughout.
- The 112-token empty case is unexplained.
- `reasoningChars` in this frozen set cannot distinguish a measured zero from an unreported
  one; only later sets can.
- Re-invoking the runner over records from an older evidence revision takes the
  reassessment path and makes no provider calls. That is expected behaviour, not a fault,
  but it means a "re-run" must be checked for `reassessedFromEvidenceSha256: null` before
  its numbers are treated as fresh.

## Verification

- Evidence: frozen in this repository at
  `docs/evals/artifacts/gate2-reasoning-suppressed-20260901/`, with a `manifest.json`
  giving a SHA-256 per file, taken after formatting settled and verified against the
  committed bytes. Every figure above recomputes from that set. The first manifest was
  generated before `pnpm format` reflowed those files and had 30 of 64 entries wrong —
  an integrity layer that asserted something untrue, caught by an independent
  recomputation rather than by the gate, which does not read this directory. It was captured
  from `.local/gate2-live-v2/03399661…/` on mickey, execution-profile digest
  `03399661…`, manifest `0eca6348…`, all 60 records carrying
  `reassessedFromEvidenceSha256: null`.
- Instruction policy revision 9, SHA `e6fb3111…`, recorded in every case record.
- Commit `f0df1a2`, Node 22.23.2, Vulcan `c6223a6`, models `qwen3.8:27b`
  (`22130167c4c2`) and `ornith-1.5:35b` (`9f3b89b25219`).
- The prior reassessed evidence set is retained beside it as
  `archive-reassessed-232438-03399661…`.
