# ADR 0001: TypeScript modular monorepo

- Status: Accepted
- Date: 2026-07-19

## Context

The first slice needs one runtime, one CLI, shared types, and future web/API
seams. Splitting services now would add deployment and contract overhead.

## Decision

Use a pnpm workspace, strict ESM TypeScript, Node 22, `packages/core`, and
`packages/cli`. Add Python only for a later worker whose workload proves the
benefit.

## Consequences

The agent state machine remains unit-testable without a server or paid model.
Node's process, Git, HTTP, and filesystem APIs cover the first slice. A later
React/API package can consume the core without rewriting policy.
