# ADR 0012: Bounded emergency cancellation recovery

- Status: Accepted
- Date: 2026-07-19

## Context

Cancellation is a safety action, not another productive tool call. A run can
enter `cancelling` only after its ordinary runtime or tool ceiling has already
been consumed. Requiring recovery to fit inside that exhausted ceiling can
strand approved bytes or misleading verification evidence in the private
worktree. An unlimited or unrecorded bypass would be worse: it would hide work
and turn cancellation into an unbounded execution path.

## Decision

Icarus has one emergency operation kind, `cancellation.recovery`. It may start
only while the run is durably in `cancelling`, has a fixed 120-second runtime
reservation, and may be attempted at most twice. The dedicated store path
bypasses ordinary per-tool and aggregate-runtime admission only for this exact
operation. It does not permit provider calls, network access, source-repository
writes, arbitrary commands, or productive edits.

The operation remains fully visible in the ordinary operation ledger and usage
counters. Successful completion reconciles the reservation to observed bounded
use. If the process dies with the operation unfinished, recovery charges the
full reservation before deciding whether the one remaining attempt is
available. Visible runtime may therefore exceed the ordinary sun ceiling while
landing the run safely; accounting is never erased or refunded optimistically.
After the attempt limit, Icarus records a failed run whose resume state remains
`cancelling`, retains the evidence for operator inspection, and requires human
intervention.

## Alternatives rejected

- Refuse cancellation when a normal ceiling is exhausted: leaves unsafe or
  misleading private state behind.
- Silently reset the run budget: hides consumption and reopens productive work.
- Retry until cleanup succeeds: creates an unbounded execution path.
- Perform unmetered best-effort cleanup: makes interruption and forensic review
  invisible.

## Consequences and review trigger

Cancellation can consume up to two additional fixed recovery reservations, and
reported usage can exceed a run's ordinary ceiling. That exception is narrow,
state-bound, attempt-bound, and auditable. ADR 0009 still governs every
ordinary external operation; this record supersedes only its implication that
recovery must always fit inside the already-consumed ordinary ceiling.

The operation finish and final cancelling-to-cancelled transition are separate
transactions. Repeated process death in that narrow post-recovery window can
therefore consume both attempts and leave an availability hold instead of
claiming an unsafe success.

Revisit the carve-out if cleanup moves to an independently supervised worker or
gains a stronger transactional rollback primitive.
