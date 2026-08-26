# ADR 0060: Propose-only headless default and runaway envelopes

- Status: Proposed — the propose-only default, digest-bound application,
  envelope clamps, and doom-loop guard are implemented; no schedule, fork,
  deployment, or Mickey service authority is added
- Date: 2026-08-26
- Related: [ADR 0044](0044-headless-workspace-harness-direction.md) (headless
  workstream), [ADR 0046](0046-headless-execution-profiles.md) (profile
  grammar), [ADR 0047](0047-headless-authority-binding.md) (H2a binding),
  [ADR 0048](0048-bounded-headless-worker.md) (H2b worker),
  [ADR 0049](0049-headless-crash-tail-reconciliation.md) (H3a),
  [ADR 0057](0057-headless-evidence-reconstruction.md) (H3b evidence),
  [ADR 0058](0058-headless-exactly-once-continuation.md) (H3b continuation),
  and [ADR 0059](0059-headless-isolated-child-runs.md) (H4 children)

## Context

Today `run approve-headless` approves and applies in one act: the worker
proposes a patch set and materializes it under the same plan approval. The
premier-harness direction calls for the Cursor asymmetry with a stronger
binding: a headless run should propose by default, and application should
require an explicit grant bound to exactly what was proposed — not merely to
the plan that allowed some proposal. Separately, a headless runaway — an
unbounded repair session, a cost spiral, or a model repeating the identical
tool call forever — must die inside defined envelopes with defined exit
codes, not by operator intervention.

Two constraints shape the design. The application grant must fit the existing
approval pipeline (SQLite approval records with digest, actor, decision), not
a parallel mechanism. And the patch-set digest can only exist after the
provider proposes, so no profile or approval-time flag can carry it:
application is necessarily a second act after the proposal is durable.

## Decision

### Propose-only default

The profile worker policy gains an optional `mutation` field: `"propose"` or
`"apply"`. Absent means `"propose"` — the new default. `"apply"` is the
explicit opt-in preserving the previous approve-and-run behavior; it is
operator-visible inside the digested profile but is deliberately not bound to
any patch set (that binding is impossible before the proposal exists).

In propose mode the worker runs planning, binding, workspace creation, and
the provider edit exactly as before, records patch-set intent, proves
quiescence, and settles with the distinct
`icarus.headless.worker-proposal.v1` schema: the ordinary settlement members
plus `proposal: { patchSetSha256 }`, where the digest is the same
checkpoint-file digest the materialization stage already computes. The
outcome is `proposed` with exit code 10. The run remains at `running`; no
byte of the patch set is materialized.

### Digest-bound application

```text
icarus run apply-headless RUN --patchset-sha SHA --actor ACTOR \
  [--max-turns N] [--max-budget-usd USD]
```

Under the existing per-run lease, application:

1. requires a settled lifecycle whose first settlement is the proposal
   schema — or, after a crash, the interrupted schema, in which case the full
   ADR 0058 continuation admission (reconstruction equality, no ambiguous
   effects, replay-safe stage intent) must also hold;
2. recomputes the checkpoint-file patch-set digest from durable bytes and
   requires it to equal both the flag and the digest recorded in the proposal
   settlement, refusing any mismatch with `HEADLESS_APPLY_DENIED` before any
   effect — the grant binds exactly what was proposed;
3. records exactly one `apply` approval in the existing approvals pipeline
   (the `APPROVAL_KINDS` set gains `apply`; the row carries digest, operator
   actor, decision) and one `headless.worker.apply_requested` intent event
   (`icarus.headless.worker-apply.v1`) binding the run, the binding digest,
   and the patch-set digest;
4. re-establishes the process-local profile ceiling and tool filter and
   re-drives the ordinary execution path from the boundary — the persisted
   patch set skips the provider edit, materialization and verification run
   exactly as in apply mode; and
5. appends exactly one `icarus.headless.worker-application.v1` settlement
   linking the apply-intent sequence, the proposal-settlement sequence, and
   the patch-set digest.

A settled worker returns its durable settlement unchanged, so a repeated
apply prints byte-identical history. A crash during the application epoch is
closed by the unchanged H3a reconciliation with a second interrupted
settlement, after which the single application allowance is spent and a
further apply is refused with `HEADLESS_APPLY_EXHAUSTED`. `run
resume-headless` refuses propose-mode lifecycles and points at
apply-headless; apply-mode runs continue to use ADR 0058 unchanged. The
lifecycle grammar stays: exactly one start, at most one intent event
(resume request after an interruption, or apply request after a proposal),
at most two settlements.

### Runaway envelopes

`--max-turns N` clamps the effective session iteration ceiling to the
minimum of the approved plan, the profile, and the flag; admission beyond it
lands `session.exhausted` (reason `iteration_ceiling`) and exit 2.
`--max-budget-usd USD` clamps the active cost ceiling the same way; both are
available on `approve-headless` and `apply-headless` and only ever narrow.

A uniform doom-loop guard lives in the session tool path (interactive and
headless alike, because the guard belongs to the tool loop, not the
frontend): the third admission of the identical effectful or control tool
call — same tool name and identical canonical-argument digest — within one
session invocation is refused, the run lands `session.exhausted` with reason
`doom_loop` and the repeated call's digest, and the settlement exits 2.
Read-only manifest and check tools are exempt: they are `no_effect` by ADR
0057's own classification, so repeating them is bounded waste that plan
grants already cap, and legitimate repair patterns bulk-read identical paths.
Detection is deterministic code over the canonical call digest; no model
judges loops.

### Exit codes

| Outcome | Exit |
| --- | ---: |
| clean complete (`review_ready`) | 0 |
| envelope exceeded (turns, budget, doom loop) | 2 |
| awaiting human | 3 |
| proposed (clean stop, awaiting digest-bound apply) | 10 |
| failed (execution error, incomplete settlement) | 1 |
| signal cancellation settled | 130 |

Refusals — digest mismatch, exhausted application allowance, malformed
flags, continuation of a proposed worker — exit 1 with a named error on
stderr and persist nothing.

## Consequences

- Application authority is two-factor by construction: the plan approval
  bounds what may be proposed, and the apply approval binds the exact
  proposed bytes. Neither alone materializes anything in propose mode.
- The proposal digest is durable evidence: an operator can review the exact
  patch set (`run history`) before granting application, and a drifted or
  forged flag fails closed.
- Envelope clamps are per-invocation narrowings of already-approved
  ceilings; they never widen and are validated before any effect.
- H4 composition: children of propose-mode parents spawn only in the
  application epoch (the parent never reaches review-ready before it), and
  derived child profiles force `mutation: "apply"` because a child's
  isolated write-set is already spec-bound and the parent's proposal gate is
  the operator control point.
- Interactive approval, ordinary resume, and the H2b–H4 machinery are
  unchanged for profiles that explicitly select `mutation: "apply"`.

## Alternatives rejected

### An apply mode carried by a CLI flag at approval time

Rejected because it would not bind the patch set: the digest cannot exist
before the provider proposes, so any approval-time flag is a blanket
pre-grant, which is exactly the asymmetry this ADR exists to avoid.

### Settling proposals with the ordinary worker schema and a new outcome

Rejected because strict consumers treat the outcome enum as closed; ADR 0049
set the precedent that new lifecycle outcomes get distinct schemas rather
than widening closed ones.

### Persisting the envelope flags

Rejected because they are invigilation parameters of one invocation, not
run authority. The durable envelope remains the plan and profile ceilings;
flags only narrow a single worker or application epoch and must be
re-supplied where the operator wants them.

### Doom-loop detection in the model or in the headless frontend only

Rejected because repetition detection is a deterministic property of the
durable tool-call stream, and the session loop is shared. A guard that only
headless runs get would leave the identical interactive runaway unguarded
and fork the mechanism.
