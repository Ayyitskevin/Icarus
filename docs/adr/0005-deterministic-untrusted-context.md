# ADR 0005: Deterministic untrusted context first

- Status: Accepted
- Date: 2026-07-19

## Context

Semantic indexing before a measurable baseline would add hidden selection state
and a prompt-injection path.

## Decision

Build context from Git-visible paths, bounded applicable `AGENTS.md` files, and
small deterministic seed documents. Preserve reason, size, and SHA-256 digest.
Mark all repository text untrusted and never allow it to alter host policy.

## Consequences

Selection is explainable and repeatable but initially shallow. M2 may add syntax,
LSP, and embeddings only against retrieval-quality fixtures.
