# ADR 0047: Persisted authority binding for headless execution

- Status: Proposed — the pure H2a binding contract is implemented; no worker,
  provider call, lease, state transition, workspace, deployment, or Mickey
  service is authorized by this record
- Date: 2026-08-21
- Related: [ADR 0026](0026-agent-session-loop-and-tool-registry.md) (persisted
  plan approval and closed tools),
  [ADR 0044](0044-headless-workspace-harness-direction.md) (headless workstream),
  and [ADR 0046](0046-headless-execution-profiles.md) (H1 profile resolution)

## Context

H1 deliberately keeps profile resolution pure. It accepts a host-supplied
`PlanProposal` and `SunCeiling`, but a type-compatible plan is not evidence that
the plan is the one SQLite persisted and the operator digest-approved for a
particular run. H2 cannot start a worker by trusting those values alone.

The bridge to execution must preserve Icarus's existing authority rather than
creating a headless-specific approval table or treating a profile digest as a
grant. It must also prevent a stable provider profile ID from selecting a
different provider or model than the plan approval covered.

## Decision

Introduce the pure `bindHeadlessExecutionV1` contract as H2a.

The host supplies one current `RunRecord`, its `ProjectRecord`, the run's
`ApprovalRecord` list, its persisted readable manifest when present, the source
profile, and the host provider catalog. The binder then:

1. requires matching run and project identities;
2. requires a pristine run at `running`, before any workspace, patch set,
   verification, recovery, or error state exists;
3. recomputes the complete plan approval digest from the task, base commit,
   context digest and selected targets, provider, checks, sandbox, project
   ceiling, plan, and readable manifest;
4. requires exactly one matching persisted plan approval, including run ID,
   digest, positive decision, valid operator actor, and timestamp;
5. for remote providers, also requires exactly one matching context-egress
   approval;
6. resolves H1 against the persisted plan and project ceiling; and
7. requires the resolved provider configuration to equal the provider bound by
   the plan approval.

The resulting `icarus.headless.execution-binding.v1` record binds the run,
project, base commit, context digest, plan digest, approval provenance, profile
digest, and resolution digest under one deterministic binding digest. It also
returns the H1 resolution for later use.

The binding digest is a self-checking identity, not a signature, approval,
lease, capability grant, or execution receipt. H2b must reconstruct the binding
from authoritative records while holding the existing per-run lease and must
not accept a previously exported binding as authority. Any state change ends
the snapshot's usefulness for execution.

## Consequences

- A type-compatible but unapproved plan cannot cross from H1 into H2.
- Provider-profile remapping fails closed unless the selected provider is still
  exactly the provider covered by the run's plan approval.
- Readable-manifest omission or drift invalidates the recomputed plan digest.
- Remote execution remains subordinate to the existing context-egress approval.
- No second session, approval, grant, event, or state store is introduced.
- H2b still must implement lease-held one-task execution, lifecycle events,
  cancellation, quiescence, metering, and explicit non-success settlement.
- H3 resume must reconstruct and compare the binding after it verifies run,
  provider, workspace, and persisted evidence identity.

## Alternatives rejected

### Treat the H1 resolution digest as execution authority

Rejected because H1 intentionally does not prove that its plan input was
persisted or approved, and its digest does not bind a run or approval record.

### Add a headless approval or binding table

Rejected because SQLite's existing plan and egress approvals are authoritative.
A second table would create a competing source of truth and new recovery rules.

### Permit binding after workspace or patch activity begins

Rejected because attaching a different worker policy mid-run would make effect
ownership and recovery ambiguous. H2a admits only a pristine pre-worker
`running` snapshot; later continuation belongs to H3 resume.

### Accept a changed provider mapping under the same profile ID

Rejected because the plan digest binds the exact run provider. A profile ID is
selection metadata, not permission to change provider, endpoint, model, or
pricing after approval.
