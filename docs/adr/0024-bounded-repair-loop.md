# ADR 0024: Bounded repair loop

- Status: Accepted
- Date: 2026-07-25
- Builds on: [ADR 0023](0023-transactional-multi-file-patch-sets.md)

## Context

A run gets exactly one attempt. When registered checks fail, the run stops at
`awaiting_review` holding failing evidence, and the operator's only options are
rejecting it or planning a new run from scratch. The model never learns why its
patch set failed, so the most ordinary development loop — change something, run
the tests, fix what broke — is the one thing Icarus cannot do.

The machinery a bounded loop needs already exists. Operations are admitted
against reservations and settled against actuals, so iteration is already
metered. Verification provenance already reconstructs multiple attempts per run
from the event log, because rollback and restore already produce them. The
append-only event stream already retains each completed verification with its
diff and check evidence. What is missing is the edge from a failed verification
back into execution, and an operator decision that authorizes it.

The hard question is not the loop. It is what the model may see. Repairing a
failure requires the check output that describes it, and sending that output to
a provider is data leaving the host that the egress approval did not cover.

## Decision

### The repair grant lives in the plan

`PlanProposal` gains `repairIterations`: the number of additional attempts the
plan requests, from 0 to a fixed host maximum of 3. The plan is already inside
the plan approval digest, so the grant is bound by the approval the operator
already gives — no new approval kind, no new digest shape, and no mid-run
prompt. Approving a plan that requests two repairs is an explicit, reviewable
decision to allow two more attempts; approving one that requests none preserves
today's single-shot behavior exactly.

A grant is a ceiling, not a target. The loop stops the moment checks pass.

### Verification failure may re-enter execution

The state machine gains one edge, `verifying → running`, reached only through a
dedicated store method that requires an approved plan carrying an unspent
repair grant, a failed verification, and remaining budget. The generic
transition path stays closed; a repair is an evidence-bearing transition like
every other consequential move.

Each repair iteration:

1. re-reads the current worktree and confirms it still matches the recorded
   patch set, so a drifted worktree fails closed instead of being rewritten;
2. asks the provider for a revised patch set, supplying the approved plan, the
   superseded patch set, and the bounded, redacted check evidence;
3. validates that revision against the same approved target set, path policy,
   and ceilings as the first one — a repair widens nothing;
4. restores baseline bytes for paths the revision no longer changes, applies
   the new patch set, and re-enters verification.

Iterations are counted from the durable operation ledger rather than a new
column, so the count survives a crash and cannot drift from the work actually
charged.

### Revisions supersede rather than accumulate

A patch set and its checkpoint files are replaced by the revision that
supersedes them, and the superseded digest is appended to the event stream
before the replacement is written. This deliberately narrows the immutability
ADR 0023 gave a single patch set: within a revision it still holds, and across
revisions the append-only event log — which already retains every completed
verification with its diff and evidence — is the record. The alternative,
keeping every revision in its own row, would add a schema migration and a
second source of truth for questions the event log already answers.

A replacement is authorized by an iteration that has *already* been charged,
not by the grant still remaining after that charge — the revise call spends the
grant before it can return anything to record, so a grant of one would
otherwise never be able to write the revision it paid for. The store therefore
admits exactly one supersession per charged `provider.revise` operation and
never more charged iterations than the approved plan granted, which also closes
the reverse hole: a patch set cannot be replaced by an uncharged write.

Baseline bytes never change across revisions, because they are the pinned base
commit's bytes. Only the approved side moves, so rollback and restore keep
working unchanged: rollback still returns the worktree to the base commit, and
restore still recreates the most recently verified approved bytes.

### What may reach the provider

A repair iteration sends the check evidence that already passed the redaction
and truncation pipeline: check identity, exit status, and bounded output. It
sends no new repository content. Every byte of repository context the provider
sees is still exactly the approved context manifest.

For a remote provider this is nonetheless data the egress approval did not
name, and pretending otherwise would be dishonest. The plan approval authorizes
it: the operator approves a plan that requests repairs, for a provider that
egress approval already cleared to receive that repository's context, and the
evidence in question is derived from the operator's own registered commands run
against their own approved change. The plan text states the grant, so the
decision is visible at the moment it is made.

### Exhaustion is not success

When the grant is spent and checks still fail, the run lands in
`awaiting_review` with the failing evidence of the final attempt, exactly as it
does today. It cannot be approved. The response distinguishes "checks passed",
"checks failed after N repairs", and "repair budget exhausted" rather than
flattening them, and every attempt remains inspectable in verification
provenance.

A repair that cannot even produce a valid revision — malformed output, a path
outside the approved set, a stale preimage — consumes its iteration and lands
the failure honestly rather than retrying silently.

## Alternatives rejected

- **A separate egress envelope digest covering check output.** Correct in the
  abstract, but it forces a second operator approval mid-run for every remote
  repair, which is the interruption the loop exists to remove. Revisit if
  Icarus ever returns something to a provider that is not derived from already
  approved inputs.
- **An approval per repair iteration.** Safe and useless: a human decision per
  cycle is slower than the human just fixing it.
- **A repair ceiling in `SunCeiling`.** Every persisted project ceiling is
  validated against an exact shape by the store, the API, and the browser, so a
  new required field would invalidate existing project rows on read. The grant
  belongs to the plan anyway, because it describes this task's authority rather
  than the project's limits.
- **Unbounded iteration until checks pass.** An unbounded agent loop is exactly
  what this repository refuses, and a model that cannot fix a failure in three
  attempts is usually wrong about the problem rather than one attempt away.
- **Retaining every patch-set revision in its own row.** Adds a migration and a
  second history for what the event stream already records.
- **Feeding raw check output straight to the model.** The bounded, redacted
  evidence is the same text the operator reviews; an unredacted path would put
  credential-shaped command output on the wire.

## Consequences and review trigger

A task whose tests fail can now converge without a human round trip, which is
the first genuinely agentic behavior in the product. The cost is that a single
approval can authorize up to four provider edit calls instead of one; that
spend stays inside the existing token, cost, runtime, and tool-call ceilings,
and the operation ledger shows each iteration separately.

Checkpoint immutability is now per revision rather than per run. Anything that
assumed one checkpoint digest per run for its lifetime must read the event
stream instead.

This ADR does not add a tool registry, model-initiated file reads or searches,
capability grants beyond the approved target set, browser approvals, or any new
network surface. The model still cannot ask for anything; it receives a fixed
prompt and returns a patch set.

Review this record when tool use gives the model a way to request data the
operator did not pre-approve, when repair grants should vary by project policy
rather than per plan, or when measured evaluations show the three-iteration
maximum is the binding constraint on task success.
