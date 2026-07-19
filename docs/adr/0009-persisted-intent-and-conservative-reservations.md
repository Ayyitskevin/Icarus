# ADR 0009: Persisted intent and conservative reservations

- Status: Accepted
- Date: 2026-07-19

## Context

Repository/context preparation and provider, Git, sandbox, or recovery calls
can be interrupted after their external effect but before a result is recorded.
Blind retries can exceed runtime, token, or cost ceilings; persisting only after
context assembly leaves no run to inspect or resume.

## Decision

`run plan` persists a `preparing` run before repository I/O, pins the resolved
base commit as soon as it is known, and moves to `planned` only after the
immutable context manifest/artifact is stored. Remote runs instead move
atomically from `preparing` to `awaiting_egress_approval`; there is no durable
remote `planned` state without the exact approval. Cancellation similarly
persists `cancelling` before restoring bytes. Replay-safe stages may resume from
their persisted state.

Before each bounded external operation, SQLite records a started operation and
reserves worst-case runtime, tokens, and cost inside the run's sun ceiling.
Normal completion replaces the reservation with actual bounded usage. If no
result exists after restart, Icarus marks the operation interrupted and charges
the full reservation before any fresh retry.

## Alternatives rejected

- Optimistically refund unknown calls: can silently exceed paid or runtime
  limits.
- Automatically retry without an operation record: duplicates hidden external
  effects.
- Keep preparation outside the run: produces unauditable failures and orphaned
  context artifacts.

## Consequences and review trigger

False-positive charging can exhaust a ceiling even when the external call did
little work; the operator must start a new run rather than bypass the ceiling.
Review this decision when providers supply idempotency keys or workers gain a
durable exactly-once result protocol.
