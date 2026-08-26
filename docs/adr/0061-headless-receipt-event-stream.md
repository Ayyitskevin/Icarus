# ADR 0061: Receipt-bound NDJSON event stream projection

- Status: Proposed — the read-only stream projection and opt-in output mode
  are implemented; they add no execution, approval, resume, fork, provider,
  sandbox, workspace, Git, deployment, or Mickey service authority
- Date: 2026-08-26
- Related: [ADR 0044](0044-headless-workspace-harness-direction.md) (headless
  workstream), [ADR 0047](0047-headless-authority-binding.md) (H2a binding
  digest), [ADR 0048](0048-bounded-headless-worker.md) (H2b settlement
  receipt), [ADR 0057](0057-headless-evidence-reconstruction.md) (pure
  read-only projection precedent), and
  [ADR 0059](0059-headless-isolated-child-runs.md) (child settlement records)

## Context

Headless harnesses converge on a typed NDJSON event protocol — Cursor's
`stream-json` is the reference point — because supervisors, dashboards, and
downstream agents consume runs as typed events (`init`, `plan`, tool calls,
`result`), not as raw store dumps. Icarus's H0 export
(`icarus.headless.history.v1`) already emits the complete run trajectory as
checksum-terminated JSONL, but its lines are an undifferentiated
run/approval/event envelope: a consumer must re-derive which events carry the
plan, the patch set, the checks, and the settlement receipt, and nothing
binds a projected event to the identity digests that make Icarus's evidence
auditable.

The differentiator worth shipping is not another log format. It is a stream
in which every event is bound to the authority it descends from — the plan
approval digest, the patch-set digest, the H2a binding digest, and the
settlement receipt — so a supervisor can audit, not just observe.

Two traps define the design space. First, the stream must not become a
second, shadow event store: SQLite events and approvals remain the only
durable authority, so the stream is a projection of the same snapshot the H0
export reads, never new persistence. Second, the projection must not leak
more than the surfaces it joins: check lines carry per-check metadata
(identity, outcome, exit code, duration, truncation), never check
stdout/stderr bytes, even though the H0 history already exposes them to the
operator — a stream aimed at automated consumers stays metadata-only.

## Decision

Add the pure `createHeadlessStreamLines` projection over the authoritative
run history snapshot (run, approvals, events), emitting the
`icarus.headless.stream.v1` NDJSON stream. The projection appends no event,
creates or settles no operation, and changes no SQLite state; given the same
snapshot it returns byte-identical canonical JSONL, and malformed history
fails closed with `INVALID_HEADLESS_STREAM`.

The stream's closed line kinds, in emission order:

1. `init` — run identity from the durable `run.created` event (phase
   `run_created`), and, for headless runs, a second `init` (phase
   `worker_started`) from the durable `headless.worker.started` event
   carrying the H2a binding digest, profile identity, and tool set.
2. `grant` — one line per durable approval record (egress, plan, review,
   rollback, restore), bound to its approval digest, actor, and decision.
   Grants precede the evidence chronology, mirroring the H0 envelope; each
   carries its timestamp so a consumer can restore exact time order.
3. `plan` — from `plan.created`, bound to the plan approval digest identity
   (`planSha256`) and carrying the approved targets, check IDs, capability
   grants, and iteration ceiling from the persisted plan.
4. `patchset` — from `patch_set.intent_recorded`, `patch_set.superseded`,
   and `edit.materialized`. Every intent is bound to its patch-set digest: a
   supersession binds the digest it durably carries to the intent it
   replaces, and the surviving set's digest is recomputed from the snapshot
   exactly as the store digests it. An intent that cannot be bound, or a
   supersession without its intent, is malformed history and fails closed.
5. `check` — from `verification.completed`, bound to the diff and checkpoint
   digests with per-check metadata only (identity, outcome, exit code,
   signal, duration, truncation).
6. `receipt` — from `headless.worker.settled` and `headless.child.settled`,
   carrying the settlement schema, outcome, exit code, and binding digest
   (the child's own binding digest and child run identity for children).
7. `result` — the terminal line: final state, verification outcome, usage,
   the last worker settlement's outcome/exit-code/binding digest when one
   exists, event and approval counts, the last durable event sequence, and a
   SHA-256 over every preceding canonical stream line, terminating the
   stream exactly as the H0 envelope's checksum does.

Every line cites its evidence source — the durable event sequence and type,
the approval kind and digest, or the snapshot itself for `result` — so any
projected event resolves back to the exact authoritative record it was
derived from. Event types outside the curated set remain available through
the unchanged H0 export; the stream is a projection, not a replay.

The stream is wired as an opt-in output mode, default unchanged:

```text
icarus run history RUN --format json|jsonl|stream-json
icarus run approve-headless RUN ... [--output-format history|stream-json]
icarus run reconcile-headless RUN [--output-format history|stream-json]
icarus run resume-headless RUN [--output-format history|stream-json]
```

`history` remains the default everywhere and is byte-identical to before.
An invalid `--output-format` is an argument error validated before any
execution effect, never after settlement. Exit-code semantics are unchanged:
`stream-json` changes only what is printed, never what the run did.

## Consequences

- Supervisors consume a typed init/plan/grant/patchset/check/receipt/result
  protocol in which every line is bound to receipt identity — plan approval
  digest, patch-set digest, binding digest, settlement — which is the
  auditability claim no raw-log competitor stream can make.
- No new authority or persistence exists: the stream reads the same snapshot
  as the H0 export, appends nothing, and carries no replay, resume, or
  approval weight. The threat model is unchanged — the projection exposes a
  strict metadata subset of surfaces the operator already has.
- The default headless output, the H0 schema, and every existing consumer
  are untouched; opting in is one flag per invocation.
- Malformed or drifting history (foreign run identity, broken sequence,
  unbindable patch-set digests, malformed payloads) fails closed rather than
  projecting a stream that contradicts the durable record.

## Alternatives rejected

### Extend the H0 history envelope with typed members

Rejected because H0 is a merged, checksum-versioned trajectory with existing
consumers and a closed schema; widening it entangles the audit export's
compatibility contract with a presentation concern. A separate schema keeps
H0 byte-stable and lets the stream evolve as a protocol.

### Interleave grant lines into strict chronological order

Rejected because approvals carry no event sequence, and merging records on
injected-clock timestamps invites nondeterministic or misleading placement
exactly where audit order matters. Grants instead lead the stream (the H0
precedent) with explicit timestamps, and every event-derived line cites its
durable sequence, so consumers reconstruct exact order from durable facts.

### Project the stream from live events during execution

Rejected because it would couple the output surface to the execution path
and create a second, ephemeral event channel that could disagree with the
durable log. Projecting from the persisted snapshot after settlement keeps
SQLite the only event authority and makes the output reproducible on demand
through `run history --format stream-json`.

### Include check stdout/stderr in check lines

Rejected because the stream targets automated consumers; metadata
(identity, outcome, exit code, duration, truncation, diff and checkpoint
digests) answers what a supervisor needs, while full check bytes remain
available to the operator through the H0 history export.
