# ADR 0011: Kernel-backed stable run leases

- Status: Accepted
- Date: 2026-07-19
- Supersedes: the lease ownership and stale-reconciliation mechanism in ADR 0008

## Context

ADR 0008 required cross-process per-run exclusion, but its atomically created
metadata file used a stat-then-unlink stale-owner path. A new owner could replace
that pathname between validation and unlink, allowing stale reconciliation to
remove a live lease. PID and process-start metadata are useful diagnostics, but
they cannot make pathname deletion atomic with ownership.

A process running the superseded implementation owns only that legacy metadata
file and does not hold `flock`. Its initialization is not atomic: after
`O_EXCL` creation it can be paused indefinitely with an empty or partially
written file. File age cannot distinguish that live initializer from an orphan.
Consequently, there is no safe online v1/v2 coexistence protocol: treating either
an unlocked or an aged malformed legacy file as stale can admit concurrent
mixed-version owners.

## Decision

Retain ADR 0008's dedicated-state-root boundary and replace its lease mechanism.
The state root is private operational state, not a hostile multi-tenant
namespace. The safety claim assumes only cooperative Icarus processes and
authorized operators mutate it; adversarial same-UID pathname replacement is
outside this lease's security boundary.

Each run has one persistent regular file opened with `O_NOFOLLOW`. Icarus
invokes the fixed Linux `/usr/bin/flock` executable in nonblocking exclusive
mode on an inherited descriptor. The parent retains the same open-file
description after the helper exits, so the kernel lock remains held until that
descriptor closes or the process dies.

The kernel lock is authoritative among protocol-version-2 participants; JSON
metadata is also protocol and compatibility evidence. After acquiring the
kernel lock, Icarus reads existing metadata through the held descriptor before
truncating it. A live or indeterminate unversioned legacy owner remains busy. A
dead owner or process-start mismatch may be migrated in place on the same inode.
Malformed or partial metadata remains busy indefinitely, regardless of age, and
unknown protocol versions fail closed instead of being mistaken for stale
state.

Those compatibility checks reduce accidental overlap but do not make a rolling
v1-to-v2 transition safe. Before the first v2 process starts, operators must
stop every v1 process and verify quiescence: the upgrade is explicitly
stop-the-world. If quiescent startup finds orphaned malformed metadata, v2
returns `RUN_BUSY`. Recovery is an operator-gated action performed only while
all Icarus processes remain stopped: preserve the file for diagnosis, verify
that no legacy initializer or current owner exists, then remove or repair the
affected lease before restarting. The production lease API never performs that
recovery automatically.

Before and after locking, compatibility checks, and metadata replacement,
Icarus proves that the descriptor and pathname still name the same single-link,
bounded regular-file inode. Release requires version-2 metadata, revalidates the
inode and owner nonce, then closes the descriptor. Production lease code never
unlinks or renames a lease path.

A missing or failing `/usr/bin/flock`, an unsafe path, or an identity change
fails closed. Milestone 1 therefore requires Linux, a local filesystem with
working `flock(2)` semantics, and util-linux `flock` at that fixed path.

## Alternatives rejected

- PID/start-time files with stale-owner unlink: pathname replacement remains a
  TOCTOU race even when the observed metadata is accurate.
- Age- or grace-based malformed-metadata recovery: a paused v1 initializer can
  exceed every finite threshold while still owning the legacy lease.
- In-memory mutexes: they do not coordinate independent CLI processes.
- Directory creation/removal locks: stale cleanup has the same ownership race.
- SQLite alone: it cannot cover Git, filesystem, and provider work outside a
  database transaction.

## Consequences and review trigger

Well-formed unlocked legacy metadata from a dead or process-start-mismatched
owner can be migrated on the same inode during a quiescent upgrade. Malformed
legacy metadata intentionally causes a durable hold until an operator completes
the recovery gate. Stable lock files accumulate one small file per run. Once v2
owns a lease, crash recovery needs no pathname deletion because the kernel
releases the descriptor lock.

Unit tests exercise the installed fixed helper, live kernel contention, legacy
owner migration and refusal, a paused `O_EXCL` legacy initializer with aged
partial bytes, unknown protocol versions, process-start mismatch, and unsafe
symlink, hard-link, and oversized identities. The missing-executable branch is
not dependency-injected: making the trusted executable configurable would
weaken the fixed-path decision. CI therefore provides positive evidence that
`/usr/bin/flock` works in its packaging environment, while the spawn-error path
and operator preflight provide the fail-closed absence boundary. A new packaging
environment must repeat that preflight rather than infer helper availability
from another host.

Review this decision before Windows support, network filesystems, containers
without the fixed helper, a long-lived daemon, distributed workers, or a
multi-tenant state root. Those environments need an explicitly tested ownership
protocol rather than a silent fallback.
