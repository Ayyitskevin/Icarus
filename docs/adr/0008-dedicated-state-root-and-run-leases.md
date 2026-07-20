# ADR 0008: Dedicated state root and run leases

- Status: Accepted
- Date: 2026-07-19

> The lease ownership and stale-reconciliation mechanism below is superseded by
> [ADR 0011](0011-kernel-backed-stable-run-leases.md). The dedicated state-root
> decision remains in force.

## Context

Icarus changes permissions inside its state directory and multiple CLI
processes can otherwise mutate the same run concurrently. Trusting an arbitrary
`ICARUS_HOME`, or treating a PID file as sufficient ownership proof, can damage
shared paths or create write races.

## Decision

The runtime accepts only a dedicated, current-user-owned, private directory
whose nonsymlinked parent resolves exactly. A new or empty root receives a
versioned marker; existing nonempty unmarked roots are refused before chmod.
State and registered repositories may not contain one another.

Every mutating run command acquires an atomically created run lock containing
PID and Linux process-start identity. A live owner produces `RUN_BUSY`; a stale
owner may be reconciled. SQLite transitions and the unique active-project index
remain the second concurrency boundary.

## Alternatives rejected

- Chmod any configured path: can alter `/`, `/tmp`, or another application's
  directory.
- In-memory mutexes: do not coordinate separate CLI processes.
- PID alone: PID reuse can make stale locks look live.

## Consequences and review trigger

Shared/symlinked state layouts are intentionally unsupported. Review this
decision before adding Windows support, network filesystems, a daemon, or
remote workers; those need a different ownership and lease protocol.
