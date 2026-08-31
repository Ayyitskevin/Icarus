# ADR 0067: Gate 2 target-discovery profile

- Status: Accepted as failed quality-improvement measurement; Gate 2 remains open
- Date: 2026-08-28
- Related: [ADR 0036](0036-proof-carrying-software-factory-product-direction.md),
  [ADR 0066](0066-gate2-live-model-comparison.md)

## Context

ADR 0066 retained an honest failed live measurement: its routed policy passed
9/30 cases, with security review and scaffold both at 0/5. Retrieval recall,
precision, and provenance were already above their gates. The next iteration
therefore needed to improve model-owned target discovery and minimal exact
read-only evidence without supplying expected answers, widening host authority,
or weakening the fixed manifest-v2 thresholds.

The original live evidence also had to remain reproducible. Changing the
candidate, instruction, or routing policy cannot retroactively make the v1
artifact invalid, and a slow provider response cannot silently remove a case
from a 30-case cohort.

## Decision

Add a separately digest-bound `gate2-local-vulcan-target-discovery-r7-20260828`
profile and retain ADR 0066's profile as immutable v1 evidence. The evidence
publisher validates each version against its own candidate-contract revision,
evidence-record revision, instruction-policy digest, and routing-policy digest.

The r7 policy makes four bounded quality changes:

- the model receives the complete repository path inventory beside the task
  and retrieved source bytes, while expected targets, citations, findings, and
  evaluator answers remain absent;
- the first-plan contract contains only mutation targets and registered check
  IDs, removing prose that the host never used to decide authority;
- one versioned instruction policy sets deterministic generation and adds
  repository-general scaffold and security-review guidance about ownership,
  local conventions, source-of-truth preservation, and minimal relationship
  evidence; and
- the routed lane uses `code` for all five task classes, while the paired
  baseline remains fixed `code-fast` for all 30 cases.

Candidate files must still exactly equal the plan's mutation targets. Requested
checks must still be registered, and read-only answers must request neither
mutation nor check authority. Mutations remain confined to disposable private
copies and only registered checks run in the pinned no-network sandbox.

Live requests use the fields supported by pinned Vulcan 1.0.0:
`temperature: 0` and `max_tokens: 8192`. The benchmark deliberately does not
send an unsupported structured-response field. Reassessment may reuse prior raw
output only when the instruction-policy digest matches; otherwise it must make
a fresh generation request.

A request timeout is a retained failed observation, not an omitted case. Its
record carries `request_timeout`, uses the declared input/output/runtime bounds
as conservative accounting upper bounds, and must fail both provider-completion
and scenario status. Other transport errors remain fatal to the benchmark run.

## Outcome

In the leak-free paired r7 run, fixed `code-fast` passed 5/30 and routed `code`
passed 16/30. Routed class successes were repair 7/10, refactor 4/5,
explanation 3/5, security review 2/5, and scaffold 0/5. First-pass plan
acceptance was 0.7667, retrieval recall was 0.9917, precision was 0.8083,
provenance was 1.0, and incorrect edits remained zero. All 60 provider requests
completed without timeout or other transport failure.

The 16/30 routed result improves on ADR 0066's historical 9/30 routed result,
and security review rises from 0/5 to 2/5, while scaffold remains 0/5. The
paired r7 baseline matched ADR 0066's historical 5/30, but the single 3.2
success ratio still must not be presented as evidence of general model
stability.

Gate 2 remains open: routed success is below 24/30 and plan acceptance is below
0.80. This single run proves neither general model quality nor authenticated
runner identity, and its artifact-size rates remain a relative local-compute
proxy rather than billed cost. It grants no active-repository, remote, canary,
merge, deployment, migration, live-database, or unattended authority.

## Verification

- `pnpm benchmark:gate2:live:publish`
- `pnpm exec vitest run tests/security/gate2-live-candidate-contract.test.ts tests/security/gate2-live-instruction-policy.test.ts tests/security/gate2-live-evidence.test.ts`
- `pnpm check`
- [Dated measurement](../evals/2026-08-28-gate2-target-discovery-profile.md)

## Amendment (2026-08-30): what the headline actually measures

This amendment corrects the *interpretation* of the Outcome section above. No
number in it changes. It is recorded as an amendment rather than an edit because
the measurement stands as taken; what was unsupported is the claim built on it.

**Three different metrics are in play and must not be collapsed into one:**

| metric | baseline | routed |
|--------|----------|--------|
| task success | 5/30 | 16/30 |
| first-plan acceptance | 8/30 | 23/30 |
| mutation-target matching (n=20, post-hoc) | 10/20 | 13/20 |

**The 5/30 → 16/30 improvement is overwhelmingly associated with strict-output
compliance, not with better target discovery.** Baseline emitted parseable
structured output in 10/30 cases; routed in 30/30. Decisively: **all 12 of the
routed-only task successes correspond to a baseline parse failure**, as do all 15
of the routed-only first-plan acceptances. On mutation-target matching the
improvement is 10/20 → 13/20, and on the paired recoverable subset (n=13) it is
10/13 → 11/13 — a one-case difference. Per class, intent-to-treat:

| class    | n  | baseline | routed |
|----------|----|----------|--------|
| repair   | 10 | 8/10     | 8/10   |
| refactor | 5  | 2/5      | 4/5    |
| scaffold | 5  | 0/5      | 1/5    |

On the metric this profile exists to measure, **repair is identical**. Format
compliance is real capability — a plan the host cannot parse is a plan that did
not happen — but it is a *different* capability from target discovery, and this
ADR's title claims the latter.

**The 20 baseline failures are not one mechanism.** Do not over-correct this into
"the baseline was merely fenced":

- **12 carried complete valid JSON behind a fence** — 10 with a matched fence
  pair, 2 (`repair-parser-false`, `repair-public-path-containment`) with an
  opening fence, no closing fence, complete valid JSON, and `finishReason`
  `stop`. The unmatched pair is why a naive matched-pair count returns 10.
- **6 terminated at exactly 8192 output tokens with zero retained raw bytes** —
  no observation at all. Four of these six are scaffold.
- **2 were nonrecoverable malformed payloads.**

**Fence recovery is a diagnostic, not a re-scoring.** Recovering those 12 changes
the strict candidate contract. It may reveal latent semantic quality in the
baseline arm, but it must never retroactively convert a benchmark failure into a
benchmark success. The recorded 5/30 stands as the measured result.

**Correction 1 — the stability line compares two different experiments.** The
Outcome section notes the paired r7 baseline "matched ADR 0066's historical
5/30". Those results were produced under different conditions; their agreement is
a coincidence of disjoint error mechanisms, not evidence of stability:

```
$ grep -rl instructionPolicySha256 docs/evals/artifacts/gate2-local-vulcan-code-routing-20260828/       | wc -l   # 0  of 65
$ grep -rl instructionPolicySha256 docs/evals/artifacts/gate2-local-vulcan-target-discovery-r7-20260828/ | wc -l   # 62 of 65
$ grep -rl '"risks"'               docs/evals/artifacts/gate2-local-vulcan-code-routing-20260828/       | wc -l   # 44
$ grep -rl '"risks"'               docs/evals/artifacts/gate2-local-vulcan-target-discovery-r7-20260828/ | wc -l   # 0
```

The v1 records carry no instruction-policy digest, so they are not digest-bound
to a comparable policy revision, and `plan.risks` was removed from the plan schema
at r7. Two runs under a different instruction policy and a different plan schema
landing on the same integer is not a repeated measurement.

**Correction 2 — baseline scaffold is censored, not poor.** Baseline scaffold
reads 0/5, which invites "the baseline cannot scaffold". Four of the six
zero-yield cases are scaffold, so that 0/5 is an upper bound on what was
*observable*, not a measurement of scaffold capability. The routed arm completed
the same six cases in 1039–5585 tokens.

**Correction 3 — an uncontrolled variable sits under all 60 observations.**
Ollama returns a `thinking` field and counts it in `eval_count`, while this
profile's frozen `maxTokens: 8192` is pinned as if it were a content budget. It is
really a combined thinking-plus-content budget whose split is unobservable through
the current Vulcan adapter, which neither sends a `think` flag nor surfaces
`thinking` on its Ollama message model. This does not invalidate the run; it
bounds what the run can claim, and it is the leading candidate mechanism for the
six zero-yield cases.

**What this ADR still supports.** Routed output is reliably parseable where
baseline is not (30/30 versus 10/30); routed matches targets at least as well as
baseline in every class and better in two; incorrect edits remained zero;
provenance was 1.0; and every one of the 64 files bound by `artifact-manifest.json`
verifies under `sha256sum -c`. **What it does not support:** a general capability
gap of the size 5/30 → 16/30 implies. Gate 2 remains open on its own terms.
