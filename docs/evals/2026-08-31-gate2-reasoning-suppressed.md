# Gate 2 live rerun with reasoning suppressed — 2026-08-31

> Rewritten 2026-09-01 against a fresh execution. The first version of this record
> reported validity figures read from fields the runner computed but never serialized,
> so "zero thinking characters" and "zero omitted matches" were absence, not
> measurement. Record revision 5 serializes both; every figure below comes from a
> recorded value in a genuinely fresh run (`reassessedFromEvidenceSha256: null` on all
> 60 cases).

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

These figures reproduced exactly across two full executions of the 30-case set, so they
are not a single lucky pass. Temperature is 0; that is determinism of this pipeline, not
evidence about model variance under sampling.

## What the recorded evidence supports

- **`reasoningChars: 0` on all 60 cases, measured and serialized.** `think: false`
  reached every path. Nothing silently dropped the field, and no case spent budget on
  reasoning.
- **60/60 `finishReason: "stop"`** and **60/60 `usageBasis: "provider_reported"`.** No
  truncation, no timeouts, no protocol failures, and every token count is observed
  rather than a charged upper bound.
- **Empty candidates fell from 8 to 1.** The routed arm generated 9,998 output tokens
  across 30 cases — fewer than the 8,192 a single zero-yield case burned on 2026-08-30
  to return an empty string.

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

**Refutes.** The expectation that displacement *alone* explained the zero-yield cases and
that freeing the budget would therefore raise scores. It did not: scores under the honest
budget are lower than the figures recorded under the combined budget.

**Does not establish.** That reasoning improves these models' answers. That is the
obvious reading of the numbers and this run cannot support it. The earlier figures were
taken under a different budget contract, so the two are not a controlled comparison, and
no reasoning-enabled arm was run under the now-observable protocol. The honest statement
is that these results are *consistent with* reasoning contributing to answer quality and
*inconsistent with* pure displacement — identifying the cause requires a paired arm this
run deliberately did not attempt.

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

## Verification

- Evidence: `.local/gate2-live-v2/03399661…/` on mickey, execution-profile digest
  `03399661…`, manifest `0eca6348…`, all 60 records with
  `reassessedFromEvidenceSha256: null`.
- Instruction policy revision 9, SHA `e6fb3111…`, recorded in every case record.
- Commit `f0df1a2`, Node 22.23.2, Vulcan `c6223a6`, models `qwen3.8:27b`
  (`22130167c4c2`) and `ornith-1.5:35b` (`9f3b89b25219`).
- The prior reassessed evidence set is retained beside it as
  `archive-reassessed-232438-03399661…`.
