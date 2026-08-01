# ADR 0003: Detached worktree and one-file mutation

- Status: Accepted
- Date: 2026-07-19

> The one-file mutation boundary below is superseded by
> [ADR 0023](0023-transactional-multi-file-patch-sets.md). The isolation
> decisions — clean base commit, approval bound to the run manifest,
> hardlink-free private Git cache, post-approval detached worktree, and the
> prohibition on modifying the source checkout — remain in force.

## Context

The golden path must prove isolation, approval, verification, and recovery
without pretending arbitrary agent editing is already safe.

## Decision

Capture a clean base commit, bind approval to the run manifest, copy an
Icarus-private Git cache without hardlinks, and create its detached worktree only
after approval. Permit one preimage-bound, unique exact replacement in one
operator-selected existing UTF-8 file. Store baseline/approved bytes, diff, and
verification evidence. Do not create, delete, commit, push, merge, deploy, or
modify the source checkout or its Git metadata.

## Consequences

Writes and rollback are simple, inspectable, and idempotent. Multi-file patches,
renames, deletes, binary files, merge integration, and automatic cleanup need
separate designs and evaluations.
