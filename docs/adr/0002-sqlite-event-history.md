# ADR 0002: SQLite event and history store

- Status: Accepted
- Date: 2026-07-19

## Context

One local operator needs durable project/run state, transactional transitions,
and evidence queries. PostgreSQL and multiple services are premature.

## Decision

Use SQLite with foreign keys, WAL mode, schema versioning, append-only events,
and normalized project/run/checkpoint records. Milestone 1 injects the concrete
`IcarusStore` into the application service; this is a narrow storage boundary,
not an interchangeable storage port. Extract a port when a second implementation
or isolated contract test makes it necessary. Milestone 1 uses `better-sqlite3`;
native compatibility is pinned by the lockfile and tested on the supported Node
line.

## Consequences

Deployment is one local file and transactions can couple state/event writes.
The run row stores the latest verification snapshot while each full bounded
verification attempt and diff is also retained in the append-only event stream.
The native dependency adds build/supply-chain weight, so install artifacts are
locked and the concrete storage dependency is kept narrow. Before schema changes,
operators back up the database and approve a tested migration.
