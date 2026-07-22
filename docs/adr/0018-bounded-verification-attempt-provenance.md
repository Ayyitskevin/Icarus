# ADR 0018: Bounded verification-attempt and checkpoint provenance

- Status: Accepted
- Date: 2026-07-22
- Depends on: [ADR 0017](0017-bounded-workspace-run-summaries.md)
- Extends: [ADR 0014](0014-loopback-api-react-workspace.md)
- Related: [ADR 0002](0002-sqlite-event-history.md),
  [ADR 0015](0015-read-only-repository-status-and-event-cursors.md),
  [ADR 0016](0016-bounded-older-event-navigation.md),
  [ADR 0010](0010-inherited-opencode-workflow-security-hold.md)

## Context

The selected-run response exposes only the latest persisted verification outcome,
diff digest, and checkpoint digest. Historical scalar facts live beside private
diffs, changed paths, check commands, output, actors, and error messages inside
event payloads. The immutable checkpoint row likewise stores its safe digest and
timestamp beside private baseline and approved bytes.

The persisted model has no verification-attempt ID, `verification.started`
event, per-check attempt row, explicit supersession relation, or retained timeout
bit. A check timeout is persisted only as a failed completed verification; a
stage timeout or orchestration failure exits `verifying` through `run.failed`.
Cancellation exits through `cancellation.requested`. Crash recovery can resume a
run already in `verifying` without appending a new start event. Therefore this
view cannot reconstruct invocations, distinguish a completed timeout from another
check failure, or call one attempt formally superseded.

Existing recent and older activity routes intentionally never select or decode
`payload_json`. This new optional projection must not weaken those routes. It may
parse only bounded, selected lifecycle events after byte preflight and may expose
only allowlisted scalars. When the persisted model cannot establish a relation,
the browser says unknown or outside coverage.

## Decision

### Attempt semantics

One displayed attempt is one evidence-backed interval in the run state machine
whose state is `verifying`. Intervals cannot overlap. They are not provider calls
or individual check processes.

An observed interval starts only with a strictly validated transition:

- `edit.materialized`, `running -> verifying` (`initial_edit`);
- `restore.completed`, `restoring -> verifying` (`restore`); or
- `run.resumed`, `failed -> verifying` (`resume`).

It ends only with a strictly validated transition:

- `verification.completed`, `verifying -> awaiting_review`, with status
  `passed`, `failed`, or `unavailable`;
- `cancellation.requested`, `verifying -> cancelling`, with status `cancelled`;
  or
- `run.failed`, `verifying -> failed` and `resumeState = verifying`, with status
  `incomplete_failed`.

An observed start with no exit through the pinned snapshot is
`incomplete_at_snapshot`. If the current safe run state is `verifying` but its
start precedes the evidence window, the route may return the same incomplete
status with `startProvenance = outside_coverage`. If a terminal is in coverage
but its start is not, the terminal status is known and its start is outside
coverage. Missing start evidence is never filled from event adjacency or a
timestamp.

The host identity is `verification-anchor-<sequence>`, where the anchor is the
terminal sequence, or the observed start/current snapshot for an open interval.
It is a bounded response identity, not a durable database attempt ID. Ordering
uses anchor sequence only. Timestamps are presentation facts and never establish
ordering.

`laterAttemptObservedWithinCoverage` means only that a later validated/candidate
interval anchor occurs in this response's evidence suffix. It does not claim
formal supersession, obsolescence, or review disposition. Individual check
attempts, a completed timeout, raw-limit termination, and the reason for an
incomplete failure remain unavailable in this browser projection and require CLI
history.

### Fixed snapshot and evidence bounds

Add one lazy selected-run route:
`GET /api/runs/:id/verification-attempts?snapshot=<revision>`. The query contains
exactly one canonical positive safe-integer `snapshot`. Duplicate or unknown
keys, caller-controlled limits, filters, sorting, searching, and cursors fail.

One SQLite read transaction selects only `id`, `state`, and `resume_state` from
the run row, validates them, reads the event high-water mark, and requires exact
equality with the requested snapshot. It must not call `getRun()`,
`listEvents()`, `getRunHistory()`, `getCheckpoint()`, or any `SELECT *` loader.
A concurrent append before the snapshot check produces fixed
`EVENT_SNAPSHOT_CONFLICT`; an append after transaction start is excluded by the
same coherent SQLite snapshot.

Coverage is exactly `max(1, snapshot - 199)..snapshot`. A direct range query
uses the existing `(run_id, sequence)` index and selects at most 200 rows of
sequence, run ID, type, and timestamp. Exact contiguity, identity, bounded event
type, and canonical UTC timestamp are mandatory. All type work remains inside
that range; no sparse full-history query or total-attempt count is allowed.

The host scans metadata in sequence order and derives candidate interval anchors.
It retains the newest eight and returns them in ascending anchor order.
`attemptAnchorsTruncatedWithinCoverage` means only that additional
attempt-shaped anchors exist in the suffix; it does not certify excluded payloads
as valid attempts. `earlierEventsExcluded` means only that events precede the
suffix. Either condition requires truncated/unknown copy and CLI guidance.

### Selected payload projection

Raw payload text never crosses the SQLite projection boundary. Before any JSON
operation, a query returns only sequence, storage class, and direct-column
`octet_length(payload_json)`. Selected completion payloads must be TEXT no larger
than 8 MiB. Selected lifecycle transitions must be TEXT no larger than 16 KiB.
The checkpoint-save payload must be TEXT no larger than 1 KiB. The fixed window,
eight-result cap, and payload ceilings are independent bounds.

Only after preflight may SQLite require strict RFC-8259
`json_valid(payload_json, 1) = 1`. Direct-child occurrence counts prove selected
keys occur exactly once. Root transition shapes, selected scalar types, fixed
states, and bounded values are validated in SQL and defensively in host code.
JSON5, duplicate selected keys, BLOB-backed text, wrong types, invalid states,
and malformed selected metadata fail with fixed host-controlled messages. Extra
private subobjects remain unselected.

For `verification.completed`, exactly-once root `from`, `to`, `outcome`,
`diffSha256`, and `verification` plus nested `outcome`, `diffSha256`, and
`checkpointSha256` are required. Outer and nested outcome/diff values must match.
Outcomes are exactly `passed`, `failed`, or `unavailable`; digests are exactly 64
lowercase hexadecimal bytes. The raw diff, checks, argv, output, changed paths,
and extra fields never leave SQLite.

For the other selected transitions, only exact root shape and the state scalars
needed above are projected. Private `detail`, actor, error code, and error message
values are neither extracted nor returned. Unrelated corrupt/private payloads
remain unread and cannot fail the optional view. An excluded completion payload
is not decoded merely to count its metadata anchor.

### Checkpoint and recovery provenance

The transaction uses a dedicated query selecting only `run_id`,
`checkpoint_sha256`, and `created_at` from `checkpoints`. It never selects
`baseline_base64` or `approved_base64`. The row identity, canonical digest, and
bounded canonical timestamp are validated.

An observed `checkpoint.saved` event receives its own byte/strict-JSON/exact-key
validation and must match the row. More than one save event, an event without a
row, a row without its save event when coverage starts at sequence one, or a save
after a completed attempt that cites it fails closed. With truncated coverage, a
row whose save event is absent is `not_observed_in_coverage`, not missing or
corrupt.

A completed attempt exposes its nested checkpoint digest only when it equals the
immutable row and labels the relation `recorded_digest_match`. This proves only
that two recorded scalar values agree. It does not rehash private bytes or prove
current byte integrity. A cancelled/incomplete attempt may expose the run-level
checkpoint digest only as `run_checkpoint_available`; it does not claim the
attempt completed against it. With no row it reports `not_available`.

`restore.completed` safely establishes that the interval began after a completed
restore transition. It does not prove which historical verification caused the
rollback or that bytes were freshly verified. `rollback.completed`, review, and
approval events are not joined by digest or adjacency and are not presented as
attempt relations.

### Exact response allowlist

The transport-neutral response has exactly:

```text
{
  runId,
  snapshot,
  coverage: {
    firstSequence,
    lastSequence,
    eventCount,
    eventLimit: 200,
    earlierEventsExcluded
  },
  attemptLimit: 8,
  attemptAnchorsTruncatedWithinCoverage,
  checkpoint:
    { status: "not_saved" }
    | {
        status: "saved",
        sha256,
        createdAt,
        saveEvent:
          { status: "observed_in_coverage", sequence, timestamp }
          | { status: "not_observed_in_coverage" }
      },
  attempts: [{
    identity,
    anchorSequence,
    startSequence,
    startedAt,
    startProvenance:
      "observed_initial_edit" | "observed_restore" | "observed_resume"
      | "outside_coverage",
    status:
      "passed" | "failed" | "unavailable" | "cancelled"
      | "incomplete_failed" | "incomplete_at_snapshot",
    endSequence,
    endedAt,
    diffSha256,
    checkpointSha256,
    checkpointProvenance:
      "recorded_digest_match" | "run_checkpoint_available" | "not_available",
    laterAttemptObservedWithinCoverage
  }]
}
```

Nullable fields are always present. The API presenter reconstructs this exact
allowlist instead of returning a store object by assertion. The browser validator
enforces exact keys, response seed equality, constants 200 and 8, coverage
arithmetic, unique ascending anchors, identity derivation, bounded timestamps,
digest syntax, enum/nullable combinations, checkpoint union consistency, at most
eight attempts, and the truncation/result relation.

### Workspace lifecycle and authority

The current verification snapshot stays visible above an explicitly opened
“Verification & Recovery Evidence” region. Before loading, copy states both fixed
bounds and all omitted private fields. A loaded view shows the pinned revision,
sequence range, result count, limits, truncation/unknown states, checkpoint
availability, and the difference between recorded digest agreement and verified
checkpoint bytes. Empty coverage never implies success. CLI guidance is visible
whenever the bounded view cannot answer completely.

The panel is a static pinned read while selected-run polling continues. A newer
live cursor marks it stale but never replaces or advances it. Each explicit load,
refresh, or retry captures the current `(run.id, run.eventCursor)`. A snapshot
conflict retains prior success and requires an operator persisted-run refresh
before retry; other transient failures also retain prior success.

One attempt request may be current. Generation plus exact run/snapshot validation
rejects late, mismatched, and cancellation-ignoring responses. Document hiding,
panel close, selected run/project change, Back, persisted-run refresh, opening
older activity, and unmount abort and invalidate it. Opening older activity first
aborts the attempt request and then launches history. Attempt-close and run
refresh never cancel history. One parent-owned aggregate cancellation callback
fans out to the independent history and attempt request lifecycles.

Only operator Close restores focus, to the enabled launcher or the focusable
verification section when older activity disables it. The labelled region uses
`aria-busy`, polite status, semantic lists/facts/time, textual statuses, wrapped
digests, and React text rendering. No response value reaches raw HTML or
navigation.

This slice adds no schema, migration, dependency, write, event append,
checkpoint creation or rehash, database-maintenance route, Git/source read,
filename/source/checkpoint-byte disclosure, raw payload/diff/check output,
provider data, actor/error disclosure, older-attempt pagination, stream, watcher,
daemon, browser approval, review, rerun, restore, execution, arbitrary command,
commit, push, deployment, or workflow authority. Loopback/same-origin, CSP,
guarded CLI, ADR 0010, and `.github/workflows/opencode.yml` remain unchanged.

## Consequences

Operators gain a bounded comparison of observed verification-state intervals and
the safe recorded checkpoint relation. They do not gain complete attempt history
or process-level causality. Timeout, check, failure-reason, formal supersession,
review, rollback-cause, and fresh checkpoint-integrity questions remain CLI-only
or unknown.

Acceptance must cover no/one/eight/more-than-eight attempts; more than 200 events;
boundary-straddling starts; passed, failed (including a real timed-out check),
cancelled, incomplete-failed, and incomplete-at-snapshot intervals; restore
starts and rollback non-correlation; missing/mismatched checkpoint state; corrupt
IDs, timestamps, states, sequences, digests, strict JSON, selected-key duplicates,
storage classes, and byte ceilings; unrelated private/corrupt payload immunity;
fixed response bytes; indexed range/exact-anchor plans; coherent snapshot races;
and zero logical writes, events, source changes, or Git reads.

Client and Chromium acceptance must additionally prove lazy loading, exact-shape
rejection, retained retry, request replacement, stale/mismatched response
rejection, selection/refresh/hide/unmount cancellation, abort-before-history
ordering, focus fallback, hostile-text rendering, private-sentinel absence, no
mutation routes or sinks, and preservation of live polling and older activity.
