# ADR 0049: Fail-closed headless crash-tail reconciliation

- Status: Proposed — H3a implementation merged through PR #54 and received
  independent review; risky-change research and live measurement remain open
- Date: 2026-08-21
- Related: [ADR 0044](0044-headless-workspace-harness-direction.md),
  [ADR 0047](0047-headless-authority-binding.md), and
  [ADR 0048](0048-bounded-headless-worker.md)

## Context

ADR 0048 records `headless.worker.started` before the first workspace or
provider effect and records `headless.worker.settled` only after quiescence. A
process killed between those events leaves a committed, valid history prefix
but no worker terminator. The ordinary run recovery path can mark a started
operation interrupted, yet invoking `run resume` would continue without
reconstructing the headless profile and binding. That would bypass the H2
authority boundary and could duplicate an effect whose outcome is unknown.

H3 must separate two questions: first, how the dead worker's history is closed;
second, whether a new worker may reconstruct the same binding and continue.
This ADR answers only the first question.

## Decision

Add an explicit Linux command:

```text
icarus run reconcile-headless RUN
```

Under the existing per-run kernel lease, the service:

1. validates exactly one `headless.worker.started` event and at most one later
   settlement;
2. returns an existing settlement unchanged when reconciliation already ran;
3. marks every still-started ordinary operation interrupted through the
   existing SQLite transaction, charging its complete reserved cost, tokens,
   and runtime;
4. re-reads the append-only event history and proves that no operation remains
   active; and
5. appends exactly one `headless.worker.settled` event whose payload uses the
   distinct `icarus.headless.worker-interruption.v1` schema.

The interruption payload binds the original binding digest and start sequence,
every durable interrupted-operation ID after that start, current run state and
usage, exit `1`, `HEADLESS_WORKER_INTERRUPTED`, and the fixed continuation
disposition `requires_binding_reconstruction`. Deriving the IDs from the full
durable tail means a second process death after operation reconciliation but
before worker settlement cannot erase their linkage. Existing
`icarus.headless.worker.v1` start and ordinary settlement payloads are not
widened.

Reconciliation never invokes the provider, sandbox, Git controller, execution
stage, or model tool loop. It does not change the run's execution state. The
ordinary `run resume` path refuses every run with a headless lifecycle before
recording resume intent or re-entering a stage. H3b must reconstruct and compare
the persisted binding before any continuation is introduced.

The complete checksum-terminated H0 JSONL history is emitted after recovery.
The database remains the only durable authority; no worker, tail, or recovery
table is added.

## Consequences

- Process death has an explicit, append-only, non-success terminator.
- A repeated reconciliation is idempotent and returns byte-identical history.
- A process death during reconciliation can retry from the already-committed
  interruption evidence without losing the affected operation IDs.
- An unknown remote or filesystem effect is never replayed by H3a.
- A started operation remains conservatively charged exactly as ordinary Icarus
  recovery already requires.
- A headless run cannot use ordinary resume to escape its profile and binding.
- H3b still owns binding reconstruction, effect-receipt reconciliation, and
  exactly-once continuation.
- The distinct public interruption schema remains a risky-change shipping gate:
  local crash evidence proves implementation behavior, not operator or consumer
  fitness.
- Automatic startup scanning, live tailing, daemons, schedules, children,
  deployment, and provider fallback remain excluded.

## Alternatives rejected

### Resume immediately after marking the operation interrupted

Rejected because the process-local H2 binding is gone. Re-entering execution
without reconstructing it would make the durable start event into authority and
could duplicate an effect.

### Rewrite or truncate the open history tail

Rejected because committed events are evidence. Recovery appends its
observation; it never edits the record it is explaining.

### Add `interrupted` to `icarus.headless.worker.v1`

Rejected because strict consumers may treat that outcome enum as closed. A
distinct interruption schema keeps the H2b protocol stable.

### Reconcile every run whenever the CLI opens the state root

Rejected because read-only commands must not silently mutate unrelated runs.
H3a is an explicit operator action; automatic background supervision belongs to
a separately governed worker lifecycle.
