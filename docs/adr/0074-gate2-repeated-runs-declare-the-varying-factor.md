# ADR 0074: Gate 2 repeated runs declare the varying factor

- Status: **Proposed** 2026-09-03 — drafted by the Codex seat (sol) from the #106 investigation; integrated by the lead. Option B needs a Vulcan request/provider/adapter change (a separate repository and a deployed service on mickey), which is Kevin's decision; nothing here is implemented yet.
- Date: 2026-09-03
- Related: issue #106, [ADR 0070](0070-gate2-rerun-with-reasoning-suppressed.md), [ADR 0073](0073-gate2-manifest-v3-task-entailed-targets.md), [ADR 0075](0075-gate2-evidence-record-revision-7-check-output.md) (revision 7 is check output; the members below are revision 8), and the [manifest-v3 two-run record](../evals/2026-09-02-gate2-manifest-v3-two-runs.md)

## Context

The two predeclared manifest-v3 runs agreed in every aggregate figure, and 59 of their 60
paired candidates were byte-identical. That is useful replication evidence for the whole
execution path. It is not a sampling-variance estimate.

The reason is part of the instrument. Instruction-policy revision 10 fixes
`generation` to:

```json
{ "temperature": 0, "maxTokens": 8192, "think": false }
```

The execution profile pins model identities, prices, and budgets, but no generation
setting. The runner takes the generation object from the instruction policy and
`buildGate2ChatRequestBody` transmits these exact request members to Vulcan:

```json
{
  "model": "<model id>",
  "messages": [
    { "role": "system", "content": "<instructions>" },
    { "role": "user", "content": "<task>" }
  ],
  "temperature": 0,
  "max_tokens": 8192,
  "think": false,
  "stream": false,
  "seat": "icarus"
}
```

The current evidence record writes only `requestedThink` from that generation block.
The preflight writes policy and execution-profile digests, not the decoded generation
values. Frozen-manifest schema v2 derives the record revision, `requestedThink` member
presence, absent-thinking encoding, write date, and sometimes one common
`reasoningChars` value. Therefore a reader can recover the policy generation settings by
checking out the pinned policy, but the frozen set does not itself state a repeated-run
design or a run-specific factor.

## What the live request path supports

Icarus and the deployed Vulcan agree at the current producing commits:

- Icarus `f09eec1`, `scripts/gate2-live-benchmark.mjs:88-100`, sends
  `temperature`, `max_tokens`, and `think`, with no seed.
- Vulcan `c6223a6`, deployed from `/home/kevin-lee/deploy/vulcan` on mickey, uses a
  strict request schema (`extra="forbid"`). `ChatCompletionRequest` accepts a finite
  temperature in `[0, 2]`, either bounded token-cap spelling, and `think`; it has no
  `seed` member. Its live OpenAPI schema likewise has `additionalProperties: false` and
  no `seed`. A top-level seed is therefore a 422 contract refusal, not an ignored hint.
- Vulcan's `ProviderChatRequest`, gateway translation, and Ollama adapter also have no
  seed. The adapter currently constructs `options` with only `temperature` and
  `num_predict`, then sends `think` at the request top level.
- Native Ollama 0.32.12 accepts `options.seed`. Its `Options` structure contains both
  `Seed` and `Temperature`, and the Linux llama-server request forwards both. Its
  unseeded sentinel is `-1`; the proposed public contract should use integers in
  `[0, 2147483647]` and reserve `null` to mean that the seed member was omitted.

The claim that a seed can pass through today is therefore **false**. It needs one
end-to-end addition: Vulcan request schema -> provider request -> gateway -> Ollama
`options.seed`, with mutation tests at every edge, followed by the Icarus request field.

## Narrow live probe

On 2026-09-03, native Ollama on mickey was 0.32.12 and the two profile-pinned model
artifacts were already resident:

- `qwen3.8:27b`, digest `22130167c4c2…`
- `ornith-1.5:35b`, digest `9f3b89b25219…`

For each model I sent the same short chat prompt and token cap with seeds 101 and 202 at
temperature 0 and 0.8. No configuration was changed and no service was restarted.

| model | temperature 0, seeds 101 / 202 | temperature 0.8, seeds 101 / 202 |
| --- | --- | --- |
| `qwen3.8:27b` (`think: false`) | byte-identical content, 13 output tokens each | different content, 12 / 11 output tokens |
| `ornith-1.5:35b` | byte-identical surfaced thinking through the 48-token cap | different surfaced thinking through the 48-token cap |

This proves only the request behavior observed for these exact model and Ollama builds:
native Ollama accepted the seed, different seeds did not alter either temperature-0
generation, and different seeds did alter both positive-temperature generations. It does
not establish same-seed reproducibility across repeated calls, providers, Ollama versions,
model artifacts, hardware, or concurrency, and it is not a variance estimate.

The result also exposes a false dichotomy in issue #106. A per-run seed is not a useful
alternative to positive temperature while decoding remains greedy. The two implementable
designs are **unseeded positive-temperature sampling** and **seeded positive-temperature
sampling**.

## Required recording contract

The request must be assembled once and the same evaluated values must feed the wire,
preflight, case records, and frozen-manifest derivation. Digests are bindings, not a
substitute for recording those values.

### Execution profile

Add a closed `repetition` object to the next execution-profile revision:

```json
{
  "repetition": {
    "campaignId": "gate2-r11-v3-sampling-202609xx",
    "runIndex": 1,
    "runCount": 3,
    "varyingFactor": "unseeded_sampling_draw",
    "seed": null
  }
}
```

or, for seeded runs:

```json
{
  "repetition": {
    "campaignId": "gate2-r11-v3-seeds-202609xx",
    "runIndex": 1,
    "runCount": 3,
    "varyingFactor": "generation.seed",
    "seed": 101
  }
}
```

`campaignId` must be a bounded safe token; `runIndex` is one-based and no greater than
`runCount`; `varyingFactor` is the two-value enum above; and `seed` is exactly `null` for
unseeded sampling or a non-negative 32-bit integer for seeded sampling. All five members
are part of the execution-profile digest. For both modes, validation requires the policy's
temperature to be greater than zero. Seeded profiles in one campaign require distinct
seeds.

Temperature, token cap, and thinking mode remain instrument-wide values in the policy;
they must not be independently configurable in the profile. That avoids two authorities
for the same request. The profile owns only the run/campaign identity and the factor that
differs between runs.

### Preflight and evidence record revision 8

Write the following exact members to preflight and to every case record:

```json
{
  "campaignId": "gate2-r11-v3-seeds-202609xx",
  "runIndex": 1,
  "runCount": 3,
  "declaredVaryingFactor": "generation.seed",
  "requestedTemperature": 0.8,
  "requestedMaxTokens": 8192,
  "requestedThink": false,
  "requestedSeed": 101
}
```

`requestedSeed: null` means the seed member was omitted from the wire; an integer means
that exact integer was sent. Bump `LIVE_EVIDENCE_RECORD_REVISION` to 8 rather than giving
revision 7 a second shape (revision 7 is ADR 0075's check-output record). The record reuse predicate must compare every member above.
The request-body test must assert that an integer becomes Vulcan's top-level `seed` and
that `null` omits the field rather than sending JSON null.

The preflight must bind these values to the execution-profile and policy digests before
the first model call. Every case record must equal the preflight on all eight members.
This gives the freezer one evaluated snapshot rather than four places that can diverge.

### Frozen evidence manifest schema v3

Derive, do not hand-author, these additions from all 60 record bytes:

```json
{
  "recordContract": {
    "evidenceRecordRevision": 8,
    "requestedTemperature": 0.8,
    "requestedMaxTokens": 8192,
    "requestedThink": false,
    "requestedSeed": 101
  },
  "repetitionContract": {
    "campaignId": "gate2-r11-v3-seeds-202609xx",
    "runIndex": 1,
    "runCount": 3,
    "declaredVaryingFactor": "generation.seed"
  }
}
```

The existing record-contract members remain. Freezing refuses if records disagree, if
preflight differs, or if the execution profile does not carry the same repetition object.
Verification re-derives both objects from committed bytes.

A single frozen set can state its declared varying factor and actual requested value; it
cannot prove what differed from another set. The campaign therefore also needs a small
committed index listing the predeclared run count and each frozen manifest digest. Its
validator compares the indexed sets and requires:

- identical benchmark-manifest, instruction-policy, routing-policy, candidate-contract,
  evidence-record, and model-version identities;
- identical requested generation values except the declared factor;
- consecutive unique run indexes and exactly the predeclared count;
- for `generation.seed`, distinct recorded seeds; and
- per-run figures, never a pooled case denominator.

For `unseeded_sampling_draw`, no byte can prove that an internal RNG state differed. The
campaign validator can prove only that separate requests were made with positive
temperature and no seed. The prose must preserve that limitation.

## Option A: declared non-zero temperature, seed omitted

Revise the instruction policy so `temperature > 0`, move its revision and digest, set
`varyingFactor: "unseeded_sampling_draw"`, and record `requestedSeed: null`.

This option can claim:

- each run used the same declared sampling-active instrument;
- separate runs produced the observed per-run spread; and
- no caller-chosen seed explained or constrained the draws.

It cannot claim:

- which RNG state varied, because that state is neither supplied nor returned;
- exact replay from the frozen inputs;
- that temperature alone caused an outcome difference; or
- population variance or stability from only two observations.

It is the smaller implementation, because Vulcan needs no seed support, but it leaves the
varying factor latent and unauditable.

## Option B: declared non-zero temperature plus a different seed per run

Revise the instruction policy to the same positive temperature, add the Vulcan/Ollama seed
path, assign each predeclared run a distinct profile seed, and record the seed at every
boundary above.

This option can claim:

- exactly which caller-controlled value differed between otherwise matched runs;
- that the requested seed reached Ollama's `options.seed`;
- per-seed outcomes and their observed spread; and
- the full set of caller-controlled inputs needed for a replay attempt.

It cannot claim:

- byte-for-byte replay across a changed Ollama build, model artifact, hardware path, or
  concurrent execution environment;
- that seed is the causal explanation for every difference without a paired same-seed
  check; or
- a stable variance estimate from a tiny number of seeds.

## Decision recommendation

Choose **Option B: positive temperature plus predeclared per-run seeds**. Seed-only at
temperature 0 is rejected as ineffective by both the decoder model and the live probe.
Unseeded positive-temperature runs would produce useful observations but could not satisfy
the requirement that the frozen evidence name the factor that varied. Distinct recorded
seeds make that factor explicit and reviewable.

Use at least three predeclared seeds if the goal is to describe a spread; two runs are a
pair, not a variance estimate. Report every run separately, then a clearly labelled range
or distribution over run-level figures. Do not pool cases across runs.

This recommendation is an instrument design, not a prediction that positive-temperature
sampling will improve Gate 2. The existing temperature-0 result remains the deterministic
reference measurement, and a new temperature moves the instruction-policy revision and
starts a new measurement series.

## Verification performed for this draft

- Read Icarus `f09eec1`: policy generation, request assembly, execution-profile contract,
  case-record writer/reuse checks, preflight, and freezer record-contract derivation.
- Read Vulcan `c6223a6`: strict public schema, gateway translation, provider request, Ollama
  adapter, and its tests; compared them with mickey's live OpenAPI schema and deployed
  process path.
- Read Ollama 0.32.12 source: `api.Options` carries seed/temperature, defaults seed to `-1`,
  and the llama-server request forwards both.
- Read-only mickey probes: service/version/model identity plus the two-seed temperature-0
  and temperature-0.8 comparisons above. No restarts or configuration edits.

## Integration note (lead, 2026-09-03)

The draft above is the Codex seat's investigation and recommendation, integrated as written
with three edits: the status line; the record revision it proposes (8, because revision 7
became the check-output record in ADR 0075 the same morning); and the Related line, whose
references were turned into links and which gained ADR 0075 with that explanation. The verification section is the
seat's own; the live probe was read-only and is not a determinism or variance claim. The
decision this ADR waits on is the Vulcan seed path — a change to a different repository and a
deployed service — which the standing delegation for this repository does not cover. Until
then, single temperature-0 runs remain the reference instrument by predeclaration: the v3 pair
agreed in every aggregate figure with 59 of 60 candidates byte-identical, which is an
observation about that pair and not a determinism claim, and no "stable across repeated
runs" claim is made.
