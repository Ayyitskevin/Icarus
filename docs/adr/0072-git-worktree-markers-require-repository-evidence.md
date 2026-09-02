# ADR 0072: Git worktree markers require repository evidence

- Status: Accepted
- Date: 2026-09-02
- Related: [ADR 0008](0008-dedicated-state-root-and-run-leases.md)

## Context

Before creating or opening its state root, Icarus walks every lexical and
canonical ancestor and refuses a root inside a Git worktree. The original check
treated the existence of any entry named `.git` as proof of a worktree.

An empty `.git` directory is not a Git repository. If one appears under a shared
temporary ancestor such as `/tmp`, the existence-only rule refuses every Icarus
state root below that ancestor with `STATE_REPOSITORY_OVERLAP`. The refusal says
that a repository exists even though the filesystem carries no repository
identity.

This is an observed release-gate and runtime failure, not only a hypothetical
test collision. On 2026-09-02, a full gate on flow passed 1,282 unit/provider
tests and 206 integration tests, then `pnpm eval` failed in Gate 2 repair cohort
B with `Icarus state may not be created inside a Git worktree`. The transient
`/tmp/.git` was gone by inspection time. During the same window, any real Icarus
operation choosing a state root beneath `/tmp` would receive the same refusal.

## Decision

An ancestor carries a Git worktree marker only when its `.git` entry, or the
target of a `.git` symlink, has one of Git's two documented worktree forms:

- a `.git` directory containing a `HEAD` entry; or
- a regular `.git` file whose first bytes are exactly `gitdir:`.

Marker symlinks are followed because Git follows them; a symlink resolving to
either form is repository evidence. The gitfile read is limited to that fixed
prefix. A missing marker, an empty `.git` directory, a nonmatching regular file,
a dangling `.git` symlink, or another special filesystem entry is not repository
evidence. Unexpected metadata, symlink-resolution, open, and read errors still
propagate, so an unreadable candidate is not silently treated as safe.

This changes only ancestor worktree discovery. The lexical and canonical walk,
state-root ownership and symlink checks, and bidirectional canonical separation
from every registered repository remain unchanged.

## Threat analysis

The narrower rule no longer refuses an incompletely staged repository: an
attacker who controls an ancestor could create an empty `.git` directory, wait
for state-root validation, and add `HEAD` afterward. The existence-only check
blocked that exact pre-staging order.

It did not close the underlying race. The same attacker could create the entire
`.git` marker immediately after the one-time ancestor walk. ADR 0008's state
root is private, single-operator operational state rather than a hostile
multi-tenant directory. If hostile concurrent control of an ancestor becomes a
supported threat, it needs an ownership or atomic ancestry protocol; treating
unrelated empty filesystem junk as a repository does not provide one.

## Alternatives rejected

- Keep treating every `.git` entry as a worktree: preserves the false refusal
  and lets stray empty mount points deny all state roots beneath a shared
  ancestor.
- Invoke `git rev-parse` while opening the runtime: adds a subprocess and ambient
  Git configuration to a filesystem ownership check.
- Validate objects, refs, config, and the gitfile target: adds parsing and I/O
  without improving the decision. A newly initialized repository may have an
  unborn branch, but it still has `HEAD`.

## Consequences and verification

An empty `.git` ancestor, a nonmatching regular `.git` file, and a dangling
`.git` symlink are accepted and the state marker can be created below them. A
repository-directory ancestor with `.git/HEAD`, a `.git` symlink resolving to
such a directory, and a linked-worktree `gitdir:` file are refused before
state-root creation. Reconsider this decision if state roots become supported
beneath hostile shared ancestors or if Git introduces another worktree marker
form.
