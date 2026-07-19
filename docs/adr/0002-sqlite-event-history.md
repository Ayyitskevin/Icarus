# ADR 0002: SQLite event and history store

- Status: Accepted
- Date: 2026-07-19

## Context

One local operator needs durable project/run state, transactional transitions,
and evidence queries. PostgreSQL and multiple services are premature.

## Decision

Use SQLite with foreign keys, WAL mode, schema versioning, append-only events,
and normalized project/run/checkpoint records. Access it behind a storage port.
Milestone 1 uses `better-sqlite3`; native compatibility is pinned by the lockfile
and tested on the supported Node line.

## Consequences

Deployment is one local file and transactions can couple state/event writes.
The native dependency adds build/supply-chain weight, so install artifacts are
locked and the port is kept narrow. Before schema changes, operators back up the
database and approve a tested migration.
