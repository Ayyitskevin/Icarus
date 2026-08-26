# ADR 0057: Headless evidence reconstruction and crash-tail classification

- Status: Proposed — the read-only reconstruction and classification contract
  is implemented; it grants no continuation, replay, fork, provider, sandbox,
  workspace, Git, deployment, or Mickey service authority
- Date: 2026-08-26
- Related: [ADR 0044](0044-headless-workspace-harness-direction.md) (headless
  workstream), [ADR 0046](0046-headless-execution-profiles.md) (H1 profile
  resolution), [ADR 0047](0047-headless-authority-binding.md) (H2a binding),
  [ADR 0048](0048-bounded-headless-worker.md) (H2b worker), and
  [ADR 0049](0049-headless-crash-tail-reconciliation.md) (H3a crash tail)

## Context

ADR 0049 closes a killed worker's history but leaves its continuation
disposition at `requires_binding_reconstruction`. Before any H3b continuation
can be designed, the runtime must be able to answer, from durable bytes alone:
was the authority the worker ran under still exactly the persisted authority,
and what is durably known about each effect in the crash tail?

Two traps must be avoided. First, reconstruction must not become a backdoor
approval: the durable start event is evidence of what the worker recorded, not
authority to run again. Second, classification must not guess: an interrupted
provider, sandbox, workspace, or Git operation has an unknown external effect,
and calling that effect absent would risk duplicating it in a later resume.

## Decision

Add the pure `reconstructHeadlessEvidenceV1` projection and the read-only
command:

```text
icarus run reconstruct-headless RUN
```

The projection takes the persisted run, project, approvals, events, and
readable manifest, and:

1. inspects the durable worker lifecycle through the existing H2b/H3a grammar,
   refusing absent, duplicated, or out-of-order lifecycles and treating any
   `resume.requested` event after the worker start as malformed evidence;
2. rebuilds the source profile from the durable `headless.worker.started`
   payload — which carries every operator-selectable profile field — and
   requires its H1 profile digest to equal the recorded digest exactly;
3. re-resolves the profile against a provider identity rebuilt from the
   persisted run provider, which the recomputed plan approval digest
   independently pins, and requires the H1 resolution digest to equal the
   recorded digest exactly;
4. recomputes the complete ADR 0047 binding through a shared digest path that
   omits only the pristine pre-worker snapshot requirement — after process
   death the run legitimately carries workspace, patch, verification, or error
   state — and requires the resulting binding digest to equal the durable
   lifecycle binding digest exactly; and
5. classifies every durable operation in the crash tail with the closed labels
   `no_effect`, `durably_settled`, or `ambiguous`.

Classification is a closed, code-owned mapping over durable
operation/event/receipt evidence. A `operation.started`/`operation.finished`
pair with an intact receipt and consistent identity is `durably_settled`. An
interrupted or still-open operation of the two closed read-only kinds
(`session.tool.read.manifest`, `session.tool.read.checks`) is `no_effect`.
Unknown operation kinds, missing starts, duplicate starts, missing or extra
receipt members, contradictory kind identities or ordering, and every other
interrupted or open operation are `ambiguous`. The effect list is capped at a
fixed bound so the result stays bounded.

The emitted `icarus.headless.reconstruction.v1` record is metadata only:
schema, run and project identity, lifecycle state and start sequence, the
binding/profile/resolution/plan digests, provider kind/model/base-url/locality
identity, workspace base commit and context digest with a materialization
flag, the classified effect list, and a reconstruction digest over those
fields. It carries no private paths, pricing, plan bodies, or operation
receipts. The labels describe persisted history only; neither positive label
grants replay, resume, fork, or any other execution authority, and the
reconstruction digest is a self-checking identity, not a signature or
approval.

Reconstruction appends no event, creates or settles no operation, records no
resume intent, and changes no SQLite state. The service path holds no lease
and the CLI emits exactly one canonical JSON record. Repeated reconstruction
over the same durable bytes returns byte-identical canonical output.
Exactly-once continuation remains a later H3b slice.

## Consequences

- A killed worker's binding is now re-derivable from current persisted inputs,
  and any drift in plan, approval, provider, profile, or lifecycle digests
  fails closed with `HEADLESS_RECONSTRUCTION_AUTHORITY_DENIED` or a malformed
  history error.
- The crash tail's durable knowledge is explicit: positive labels are rare,
  evidence-bound, and carry no authority; `ambiguous` is the default.
- H3a remains the only writer of interruption settlements; reconstruction
  works over both open and reconciled tails without mutating either.
- A later continuation design can consume this record as evidence but must
  still establish its own authority; this slice deliberately provides none.
- Child runs, schedules, daemons, deployment, automatic supervision, and
  provider fallback remain excluded.

## Alternatives rejected

### Treat the durable start payload as the binding

Rejected because the start event is the worker's own record. Recomputing the
complete binding from current run, project, approval, and manifest authority
and requiring exact digest equality detects tampering or drift that quoting
the payload would ratify.

### Require the operator to re-supply the profile and provider catalog

Rejected because reconstruction is a statement about durable evidence, not a
new selection. The start payload carries every selectable profile field and
the plan digest pins the provider, so external inputs would only add a way to
disagree with the record without adding evidence.

### Classify interrupted read-only operations as ambiguous

Rejected for the two closed host-side read kinds: their durable start cannot
have produced a provider, sandbox, workspace, or Git effect, and calling them
`no_effect` states durable fact. Every other kind remains `ambiguous` when its
settlement is not durably recorded.

### Mark interrupted operations `no_effect` after H3a reconciliation

Rejected because reconciliation deliberately never learns the remote or
filesystem outcome; interruption accounting is conservative charging, not
evidence that no effect occurred.
