# ADR 0065: Proposal-only headless Vulcan admission

- Status: Proposed
- Date: 2026-08-27
- Extends: [ADR 0046](0046-headless-execution-profiles.md)
- Related: [ADR 0056](0056-vulcan-kind-on-evidence-surfaces.md),
  [ADR 0060](0060-headless-propose-apply-and-doom-loop.md), and
  [ADR 0064](0064-explicit-workspace-provider-selection.md)

## Context

The Vulcan adapter is credential-free, loopback-only, and always sends the
non-secret seat label `icarus`. Vulcan uses that label to enforce its separate
daily hosted-request and token budgets. Its public aliases may resolve to local
Ollama or hosted BYOK providers, however, so a loopback URL does not prove that
an invocation costs zero dollars.

The H1 headless host catalog deliberately refused `vulcan`. Simply adding the
kind to its enum would make a loopback Vulcan entry default to zero token rates,
allow a hosted alias to consume money outside the run's `maxCostUsd`, admit
apply-capable profiles and children, and leave the later digest-bound
`apply-headless` act open. That is wider authority than the requested first
slice.

## Decision

The H1 resolver admits a Vulcan host entry only when all of these conditions
hold:

- `createProviderConfig` accepts the complete host-owned provider mapping;
- the normalized endpoint is loopback;
- both input and output token rates are explicit, finite, and strictly
  positive;
- the worker mutation policy is absent or `propose`; and
- child runs are denied and no child specs exist.

Positive captured rates make Icarus reserve and settle its own worst-case cost
ceiling. This remains independent of Vulcan's per-seat daily budget, which is a
second fail-closed boundary rather than a substitute for the run ceiling. A
local alias may therefore be conservatively priced above its real zero-dollar
cost. The operator owns the captured-rate mapping just as it does for existing
host provider profiles; changing model, endpoint, or rates changes the H1
resolution digest.

A successful Vulcan resolution adds this record to the resolution and its
digest:

```json
{
  "schema": "icarus.headless.vulcan-admission.v1",
  "seat": "icarus",
  "mutation": "propose",
  "childRuns": "deny"
}
```

The seat value comes from the same constant used by the Vulcan gateway. Existing
Ollama, OpenAI, and Anthropic resolution payloads omit the record, preserving
their canonical bytes and digests.

Proposal mode is an evidence boundary, not a permanent apply grant. Therefore
`applyHeadlessProposal` reconstructs the durable binding and refuses a Vulcan
provider before recording an apply approval or apply-requested event. A Vulcan
proposal can be inspected, exported through the headless evidence surfaces, or
abandoned, but this slice cannot materialize its approved bytes through the
apply act.

Gate 1 live evidence continues to refuse Vulcan. The pure resolver performs no
Vulcan discovery or usage fetch, and this record authorizes no live endpoint,
active repository, deployment, migration, remote Git effect, or child worker.

## Consequences

- An operator can use a reviewed, priced loopback Vulcan alias for a bounded
  headless proposal without granting application authority.
- A missing/zero price, remote endpoint, apply policy, or child policy fails
  before worker execution.
- Alias routing remains host configuration. Explicit positive rates protect the
  Icarus run ceiling even when the selected alias is hosted; Vulcan's ledger
  independently protects its daily seat allowance.
- Admitting Vulcan to `apply-headless`, children, Gate 1, or deployment requires
  a separate decision and evidence record.

## Verification

- The H1 public resolver matrix covers valid loopback forms, explicit prices,
  remote/credential/query/fragment URLs, absent/zero/invalid prices, apply and
  child policies, unknown kinds, and duplicate catalog IDs.
- The service integration drives a Vulcan run through a durable proposal and
  proves the exact later apply act is refused without another provider call or
  apply approval.
- The static security contract pins that refusal before
  `recordHeadlessWorkerApplyRequested`.
- The measurement record is
  [2026-08-27-headless-vulcan-admission.md](../evals/2026-08-27-headless-vulcan-admission.md).
