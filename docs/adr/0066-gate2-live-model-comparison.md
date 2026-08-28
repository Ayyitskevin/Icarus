# ADR 0066: Gate 2 live-model comparison evidence

- Status: Accepted as failed measurement; Gate 2 remains open
- Date: 2026-08-28
- Related: [ADR 0036](0036-proof-carrying-software-factory-product-direction.md),
  [ADR 0065](0065-headless-vulcan-admission.md)

## Context

Gate 2 had a strict 30-case manifest, deterministic retrieval and scenario
evaluators, and a closed v2 replay. It did not yet have one live-model run in
which the models independently selected context and mutation targets, supplied
their first plans, and were compared under one fixed execution profile.

That measurement must not widen Icarus authority. A local Vulcan URL alone does
not prove which provider model it reaches, model output must not become command
authority, and a benchmark failure must remain a failure rather than motivating
a post-hoc threshold change.

## Decision

The live benchmark is an explicit, non-CI measurement separate from
`pnpm eval`. It executes the exact manifest-v2 cases and the digest-bound
`gate2-local-vulcan-code-routing-20260828` profile serially through local
Vulcan. Preflight requires the expected Vulcan health and model catalog, exact
host configuration mapping, the `local-ollama` provider's `ollama` type and
credential-free numeric-loopback base URL, and exact local Ollama model
digests. Fetches are restricted to the two numeric-loopback origins.

For each case the host performs deterministic bounded retrieval, then makes
one live model request. The model independently returns selected context, its
first plan, and either file contents or read-only findings through a closed
candidate contract. The host may canonicalize harmless array ordering, but it
does not repair targets, citations, findings, or plan substance. The candidate
contains no commands, tools, deletion operation, or external-effect authority.

Mutation candidates proceed only when the first plan requests the manifest's
exact expected target and registered-check sets. Approved candidate bytes are
applied in a disposable private copy, and only the registered check runs in the
digest-pinned no-network Docker sandbox. Read-only outcomes require the exact
manifest citation paths and finding IDs. Every case proves the source copy is
unchanged. A provider `finish_reason` of `length` makes the scenario fail even
when the truncated text happens to form valid JSON. Truncated provider output
is retained as a failed observation rather than aborting or disappearing from
the suite.

The paired policy is code-owned and independently digest-bound:

- baseline: `code-fast` for all 30 cases;
- routed: `code` for repair, refactor, explanation, and scaffold cases, with
  `code-fast` for security-review cases.

Every evaluator record carries the candidate-contract revision, evidence-record
revision, routing-policy digest, manifest digest, profile digest, selected
model, raw candidate digest, evaluator evidence, and observation. Publication
duplicate-key-strictly parses and revalidates all 60 case records plus
preflight, both results, and the comparison, scans them for unknown
secret-shaped spans, and binds the 64 source files in one artifact manifest.

The profile's positive per-token rates are an estimated relative local-compute
proxy derived from the two local model artifact sizes. They are not billed USD;
`actualBilledUsd` remains `null`. The comparison may therefore test the
manifest's configured-rate arithmetic, but it cannot establish real monetary
cost or savings.

## Outcome

The routed run improved successful cases from 5/30 to 9/30 without incorrect
edits and reduced median estimated proxy cost per success by 36.996%. It still
failed the predeclared absolute thresholds: successful cases must reach 24/30
and first-pass plan acceptance must reach 0.80, while the routed run measured
9/30 and 0.6667. Security review and scaffold both measured 0/5.

The comparison is therefore accepted as an honest failed measurement, not as a
Gate 2 pass or new execution authority. The next iteration should improve
autonomous target discovery and minimal exact citations, then run a new
explicitly versioned profile without weakening the manifest thresholds.

## Verification

- `pnpm benchmark:gate2:live:baseline`
- `pnpm benchmark:gate2:live:routed`
- `pnpm benchmark:gate2:live:publish`
- `pnpm exec vitest run tests/security/gate2-live-candidate-contract.test.ts tests/security/gate2-live-evidence.test.ts`
- [Dated measurement](../evals/2026-08-28-gate2-live-model-comparison.md)
