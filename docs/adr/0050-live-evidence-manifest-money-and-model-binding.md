# ADR 0050: The live-evidence profile binds the manifest fields that decide money and model

- Status: Proposed — validation only; no live run is authorized by this ADR, and
  nothing it adds performs I/O, reads a credential value, or contacts a provider
  or GitHub
- Date: 2026-08-21
- Related: [ADR 0045](0045-gate1-live-evidence-profile.md) (the profile record
  this amends the binding of), [ADR 0027](0027-git-landing-authority.md),
  [ADR 0043](0043-github-gateway-boundary.md)
- Numbering: main holds through 0045; the codex seat holds unpushed 0044 and
  0046–0049 on `codex/headless-recovery-h3a`. 0050 was claimed in #fleet and is
  the first free number if those land as numbered.

## Context

ADR 0045 states three binding properties for `LiveEvidenceProfileV1`, and PR #45
added a fourth (runtime authority). Property 1 says the profile binds "the
offline manifest digest, the exact case set, AND each case's authoritative
repository identity."

That is exactly what it bound, and no more. `assertLiveEvidenceProfileMatchesManifest`
compared the manifest digest, `benchmarkId`, `benchmarkRevision`, the case-id
bijection, each case's `owner/repository/baseBranch`, and their distinctness. It
never compared the profile's **provider pin** or its **budgets** against
anything, and `decodeBudgets` accepts any finite non-negative `maxSpendUsd`.

Every case in the committed manifest declares:

```json
"modelAdapter": { "provider": "ollama", "paid": false,
                  "inputUsdPerMillionTokens": 0, "outputUsdPerMillionTokens": 0 },
"budgets":      { "maxCostUsd": 0 }
```

So a profile carrying the exact reviewed manifest digest, the exact case ids,
correct repository identities and a self-consistent digest-bound approval could
pin `anthropic/claude-opus-5` at `maxSpendUsd: 500` and be admitted. The
approval bound everything except the spend. An approval that binds everything
except the spend is not a spending authority.

This is the third instance on this surface of one defect class: the fields that
are easy to compare get bound, and the field that decides the blast radius does
not. The first was the repository identity (ADR 0045, found by review). The
second was identity distinctness (PR #45, found by review). This one was found
by an adversarial planning pass over the merged tree, before it could matter —
which is the only reason it is an ADR rather than an incident.

## Decision

`assertLiveEvidenceProfileMatchesManifest` additionally requires, for every
manifest case:

1. **Provider kind agreement.** `profile.provider.kind` must equal the case's
   `modelAdapter.provider`.
2. **Unpaid means unpaid.** When a case declares `modelAdapter.paid: false`, the
   profile's `inputUsdPerMillionTokens` and `outputUsdPerMillionTokens` must be
   `null` or `0`. Null is the loopback case and is accepted: nothing is charged.
3. **The spend ceiling is bounded by the manifest's.**
   `profile.budgets.maxSpendUsd` must not exceed the case's
   `budgets.maxCostUsd`. With the committed manifest that means zero.

The manifest's `modelAdapter` block is strict-decoded against its exact nine
keys, and a case carrying no `modelAdapter` or no `budgets.maxCostUsd` is
refused rather than skipped — absence must not read as permission, the same rule
ADR 0045 applies to a missing repository identity.

### What is deliberately NOT bound, and why

This list is the decision, not an omission. Each was considered and rejected:

- **`model`** — the manifest names `icarus-gate1-fixture-model-v1`, the
  deterministic replay fixture. A live run uses a real model by definition.
  Binding this would make Gate 1's live evidence impossible to produce.
- **`adapterVersion`** — the manifest's value records which adapter produced the
  *offline* evidence. The profile's field records which adapter produces the
  *live* evidence. They describe different runs.
- **`transport`** (`deterministic-loopback-http`) and **`expectedRequests`** —
  properties of the replay harness, not of a live attempt.
- **`credentials: false`** — true of the offline run, which reads none. A live
  run necessarily reads a GitHub credential.

The rule separating the two lists: a manifest field is bound when it constrains
what a live run may DO, and left unbound when it merely describes how the
offline replay was performed.

## Consequences

- The provider KIND recorded as the operator's choice for the 3/3 run becomes an
  enforced bound rather than an intention. Reaching a paid model now requires
  editing the manifest, which changes its digest, which invalidates the approval
  — the intended path, and a visible one.
- **Correction (ADR 0053, 2026-08-22).** This clause originally read "the
  loopback provider pin ... becomes an enforced bound". That overstated the code:
  this ADR bound the provider `kind`, and nothing bound the provider HOST, so an
  `ollama` pin naming a remote endpoint was admitted. The loopback half became
  true only under ADR 0053.
- The refusal happens at authorization, before any effect. Previously the only
  thing standing between an over-budget profile and a real spend was the project
  ceiling check inside `store.ts`, which fires at admission of the first call —
  late, and only if the executor chose to apply the manifest's budgets as the
  project ceiling. Executor policy is not a bound.
- Manifests must now carry `modelAdapter` and `budgets.maxCostUsd` per case. The
  committed manifest already does. Any hand-built manifest in a test or an
  external probe must be made well-formed; a malformed one is refused, which is
  correct but means such a probe fails for that reason rather than the one it
  was testing.
- `scripts/security-check.mjs` gains
  `liveEvidenceAuthorityIsClosedBoundAndInert`, the first static assertion for
  this surface. Before it, live-evidence was the only authority surface in the
  repository with no entry there. The assertion was proven capable of failing by
  injecting two faults (a forbidden effect literal; a removed binding) and
  observing it go red, then restoring.
- The approval-digest projection at `liveEvidenceProfileApprovalDigest` is
  hand-built. It is complete today, but a field added later would be silently
  unsigned. A key-set tripwire plus per-field digest-change coverage now fails
  if the record grows without a decision about signing it.

## Alternatives rejected

- **Bind every `modelAdapter` field.** Would bind `model` to a fixture name and
  make a live run unconstructible. The strictness would read as rigour and
  function as a dead end.
- **Bind nothing and rely on `store.ts`'s project ceiling.** That check is late,
  is executor policy rather than record authority, and produces a run that dies
  mid-flight rather than one that is refused before it starts — the failure mode
  the credential preflight already exists to prevent.
- **Require `maxSpendUsd` to equal `maxCostUsd`.** Rejected: a profile may
  legitimately authorize less than the manifest permits. A ceiling is an upper
  bound, not a target.
