# ADR 0059: Isolated headless child runs

- Status: Proposed — the child-run contract is implemented; it adds no fork,
  schedule, concurrency above one, remote-provider children, deployment, or
  Mickey service authority
- Date: 2026-08-26
- Related: [ADR 0044](0044-headless-workspace-harness-direction.md) (headless
  workstream, decision item 5),
  [ADR 0046](0046-headless-execution-profiles.md) (profile grammar and its
  `childRuns: "deny"` default),
  [ADR 0047](0047-headless-authority-binding.md) (H2a binding),
  [ADR 0048](0048-bounded-headless-worker.md) (H2b worker),
  [ADR 0049](0049-headless-crash-tail-reconciliation.md) (H3a crash tail),
  [ADR 0057](0057-headless-evidence-reconstruction.md) (H3b evidence), and
  [ADR 0058](0058-headless-exactly-once-continuation.md) (H3b continuation)

## Context

ADR 0044's fifth headless feature is isolated child runs with explicit depth,
budgets, tool filters, and write sets. The profile grammar has carried
`childRuns: "deny"` since H1 precisely because no governed alternative
existed. Three traps define the design space:

1. A child must not become a second authority kernel. Anything the child does
   has to derive from authority the operator already approved, with the
   derivation inspectable in durable evidence.
2. A model must never spawn a child. A child task is an instruction; a
   model-proposed one would be an unapproved command.
3. The single-active-run-per-project invariant exists to stop two runs from
   mutating one project concurrently. Children must satisfy its purpose —
   serialized, isolated effects — rather than disable it.

## Decision

H4 v1 admits operator-declared children only. The source profile gains an
optional `children` field: a bounded list (at most 8) of strict child
specifications `{ childId, task, targets, toolIds, budgets }`, admitted only
when `worker.childRuns` is the new allow object `{ maxDepth: 1, maxChildren }`
instead of the closed `"deny"` default. Resolution refuses unknown or
widening values: child tools must stay within the parent's tool set, child
budgets within the parent's profile budgets, child targets within the
parent's approved plan targets, and children require a loopback provider,
because a child's context-egress approval could never be operator-reviewed.
The specifications ride the existing profile digest, so the operator's
binding covers them exactly.

A child run is an ordinary Icarus run with recorded lineage, never a new
state machine or authority table. When the parent's own task reaches
review-ready evidence, the worker executes the declared children
sequentially under the parent's run lease, before the parent settles. Each
child:

1. is drafted with the parent's provider and the spec's task and targets,
   carrying a new `runs.headless_parent_run_id` lineage column;
2. records exactly one `headless.child.linked` event binding the child run to
   the parent run, the parent binding digest, depth 1, and the spec digest;
3. is planned through the ordinary planning path, and the provider-generated
   plan is admitted only when it stays inside the spec envelope (targets
   within the write set, checks within the parent's approved checks,
   iterations within the spec budget) and is then approved under the parent
   approval's operator actor — the authority chain is the operator's approval
   of the digested spec, not a new interactive act;
4. is bound through the unchanged ADR 0047 machinery under a derived profile
   that only narrows the parent (spec tools and budgets, `childRuns: "deny"`
   — depth 1 is the whole hierarchy) and executes in its own private
   worktree through the existing private-Git-cache path, settling through
   the normal worker lifecycle; and
5. has its durable outcome recorded on the parent as one
   `headless.child.settled` event carrying the child run ID, outcome, exit
   code, and child binding digest.

Budgets never reset. At each spawn the spec's metered budgets must fit the
parent profile's remaining envelope after the parent's own usage and every
prior settled child's usage; an envelope refusal is recorded as a failed
child settlement and stops further spawns. The parent-side `headless.child`
host-stage operation meters the span conservatively, so parent-plus-children
usage can only overstate, never understate, consumption.

Settlement and quiescence are explicit: the parent appends its settlement
only after every declared child has a durable `headless.child.settled`
record, and the worker outcome mapping settles the parent failed (exit 1,
`HEADLESS_CHILD_FAILED` or the child's own error) unless every spawned child
reached review-ready evidence. Children spawn only when the parent's own
task evidence is review-ready; otherwise no child runs and the parent's own
outcome stands. Child output is evidence only — no bytes ever flow into the
parent's workspace (the comparison note's "evidence or a proposal" rule;
admitting a PatchSet from a child is later work).

The single-active-run invariant now binds root runs only. The partial
unique index gains `AND headless_parent_run_id IS NULL`, and the code-level
conflict check exempts a run only against its recorded parent. Fresh
databases get the new shape from the core DDL; existing databases apply a
one-shot, human-gated migration (`ICARUS_APPROVE_SCHEMA_MIGRATION=
headless-children-v1`) whose result is byte-identical to the fresh shape,
verified by the exact-schema startup check. The migration lands before that
check because it changes a base object.

Crash semantics reuse H3a/H3b unchanged: a dead parent leaves its child
reconcilable through `run reconcile-headless` on the child run, and the
parent's open `headless.child` span closes through the same command on the
parent. A dead child's open span leaves the parent's crash tail ambiguous,
so H3b continuation of a child-bearing worker fails closed — this slice
refuses it explicitly before any resume intent. Concurrency above one, fork,
schedules, remote-provider children, grandchildren (depth above one),
model-initiated children, and child write-back remain excluded.

## Consequences

- Child execution authority is a pure derivation: operator-approved plan and
  profile digests → spec envelope → admitted child plan → ADR 0047 binding.
  Every hop is inspectable in durable events.
- The single-active-run invariant's purpose is preserved: two roots still
  conflict, a second concurrent child still conflicts, and only the recorded
  parent-child pair may be active together.
- A child is recoverable with exactly the H3a/H3b machinery any headless run
  already has, including its own private workspace and settlement evidence.
- Child-bearing profiles remain fully reconstructible: the durable start
  payload carries the declared children, so ADR 0057 reconstruction rebuilds
  and re-verifies them byte-exactly.
- `children: []` decodes as absent, and profiles without children digest
  identically to before this change; no existing run's evidence shifts.

## Alternatives rejected

### A model-callable spawn tool

Rejected because a child task is an instruction, and a model-proposed
instruction is an unapproved command. Operator-declared specifications keep
every child inside reviewed authority; a governed model-proposal seam can be
evaluated later on top of this contract.

### Children as evidence-only records without runs-table rows

Rejected because it contradicts the spine: a child is an ordinary run with
lineage. Hiding children in events would create exactly the second,
shadow-authority store ADR 0026 forbids.

### Dropping the single-active-run index instead of scoping it

Rejected because the invariant is load-bearing against concurrent root runs.
The lineage-scoped predicate plus the recorded-parent exemption preserves it
for every pair except the one the worker itself serializes.

### Admitting children under remote providers with a derived egress approval

Rejected because egress approval binds exact context bytes leaving the host;
the child's context is generated at runtime and cannot have been reviewed.
Loopback-only children keep the egress contract honest until a child
context-approval design exists.
