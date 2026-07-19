# ADR 0006: Headless first slice

- Status: Accepted
- Date: 2026-07-19

## Context

A dashboard before a real approval/runtime path would be a placeholder surface.

## Decision

Ship a strong CLI and core application service first. Defer HTTP API, React UI,
terminal streaming, previews, and deployment until the golden path has durable
behavior and evaluations.

## Consequences

The milestone is usable from a terminal and avoids false UI claims. The core
ports, event model, and presentation-neutral status objects are designed for a
later workspace without prebuilding it.
