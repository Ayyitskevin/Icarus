# ADR 0046: Default-deny headless execution profiles

- Status: Proposed — the offline profile and resolution contract is implemented;
  no worker, provider call, schedule, child run, deployment, or Mickey service is
  authorized by this record
- Date: 2026-08-21
- Related: [ADR 0026](0026-agent-session-loop-and-tool-registry.md) (approved
  plan, capability grants, and closed tools),
  [ADR 0044](0044-headless-workspace-harness-direction.md) (headless workstream),
  [ADR 0059](0059-headless-isolated-child-runs.md) (bounded child profiles),
  [ADR 0060](0060-headless-propose-only-and-envelopes.md) (mutation policy),
  [ADR 0065](0065-headless-vulcan-admission.md) (proposal-only Vulcan mapping),
  and [DeepSeek Harness comparison](../DEEPSEEK_HARNESS_COMPARISON.md)

## Context

H1 needs named runtime profiles without letting configuration become a second
authority kernel. A convenient profile that embeds a provider URL, model,
arbitrary tools, commands, credentials, or permissions would let a file bypass
the project ceiling and the plan-digest approval that Icarus already treats as
authoritative.

Three different things must not be conflated:

1. a source profile is an operator-reviewable selection request;
2. the host catalog maps a provider profile ID to current provider
   configuration; and
3. the approved run plan and project `SunCeiling` are the authority that bounds
   what may execute.

The source profile therefore cannot be self-sufficient. It must fail closed
until a host resolves it against the other two records.

## Decision

Introduce strict `HeadlessProfileV1` and pure
`resolveHeadlessProfileV1` contracts.

The base source profile has exactly seven required top-level fields:

- `schemaVersion`, fixed at `1`;
- canonical `profileId` and `providerProfileId` identifiers;
- `toolIds`, an explicit sorted, unique subset of the closed
  `TOOL_REGISTRY` (an empty list means no model-callable tools);
- `budgets`, carrying every `SunCeiling` field plus `iterationCeiling`;
- `output`, fixed to `{ "format": "jsonl" }`; and
- `worker`, fixed in v1 to one task, concurrency one, and scheduled runs
  denied. Child runs are denied by default.

Later records extend this grammar without changing its selection-not-authority
boundary: ADR 0059 adds optional bounded `children` plus a depth-one
`worker.childRuns` allow record; ADR 0060 adds optional `worker.mutation`, with
absence normalized to the proposal-only default; and ADR 0065 admits only a
priced loopback Vulcan mapping for child-free proposals.

Unknown fields, inherited prototypes, unknown or duplicate tools, malformed
ceilings, alternate output modes, concurrency above one, unbounded child
policies, and schedules are refused. Provider URLs, models, pricing,
credentials, grants, commands, approvals, and executable hooks have no field in
the grammar. ADR 0059 child specs may select only bounded subsets of the
already-approved plan targets; they cannot declare or expand target authority.

`headlessProfileDigest` hashes the strictly decoded canonical record. Tool IDs
are sorted because they are a set; two orderings must not create two identities
for the same selection.

Resolution is host-owned and pure:

1. locate the canonical `providerProfileId` in an unambiguous host catalog;
2. rebuild its `ProviderConfig` through the existing provider validator;
3. require every selected capability-bearing tool to have a matching,
   positive-call capability in the already-approved plan;
4. require every profile budget to be less than or equal to the project
   `SunCeiling`; and
5. require the profile iteration ceiling not to exceed the approved plan.

Grant-free control tools remain selectable, but no tool call is executed by the
resolver. Per-call scope, count, manifest, target, check, lease, and state
enforcement remain with the existing service/tool path.

The resolution emits a second digest over the source profile digest, canonical
host provider configuration, and resolved tool definitions. This detects a
provider mapping or registry-definition change under a stable profile ID. It is
not a signature, approval, plan digest, or substitute for verifying persisted
run authority.

## Consequences

- Profiles are portable names for bounded selections, not portable authority.
- An empty tool list is valid and means deny all model-callable tools.
- A profile cannot widen project budgets or plan iterations, and a tool name
  cannot create its missing capability grant.
- Provider configuration remains host-owned. The profile cannot choose an
  arbitrary URL or smuggle credentials.
- Provider and tool mapping drift is detectable through the resolution digest.
- H2 may consume this contract only through the existing service/lease path,
  using the persisted approved plan and project ceiling. Calling the pure
  resolver with a merely type-compatible unapproved plan does not approve it.
- H2 must persist or otherwise bind the profile and resolution digests alongside
  the run evidence, and H3 resume must re-resolve and compare them.
- The H1 module performs no I/O and creates no gateway, run, workspace, worker,
  child process, schedule, or remote effect.

## Alternatives rejected

### Embed provider configuration in the source profile

Rejected because a reviewed profile ID could then carry an unreviewed remote
endpoint or pricing change. Host resolution keeps provider material in the
host-owned catalog and makes mapping drift digest-visible.

### Treat the profile tool list as a grant

Rejected because it would duplicate ADR 0026's plan-bound capability authority.
The list is only a filter; a capability-bearing tool still requires the
approved plan to contain its grant, and every call remains subject to existing
scope and count checks.

### Clamp excessive profile budgets silently

Rejected because the persisted profile would claim a budget different from the
one actually enforced. Refusal makes the mismatch visible and forces an
operator-reviewable correction.

### Add arbitrary plugins or commands in H1

Rejected because executable extension points are a new trust boundary. Optional
out-of-process adapters remain H5 work and require their own sandbox, egress,
secret, compatibility, and grant contracts.
