# ADR 0018: Bounded verification-attempt provenance

- Status: Proposed
- Date: 2026-07-21
- Depends on: [ADR 0017](0017-bounded-workspace-run-summaries.md)
- Extends: [ADR 0014](0014-loopback-api-react-workspace.md)
- Related: [ADR 0002](0002-sqlite-event-history.md),
  [ADR 0015](0015-read-only-repository-status-and-event-cursors.md),
  [ADR 0016](0016-bounded-older-event-navigation.md),
  [ADR 0010](0010-inherited-opencode-workflow-security-hold.md)

## Context

The selected-run response exposes only the latest persisted verification outcome,
diff digest, and checkpoint digest. Every completed attempt is retained in a
`verification.completed` event, but its useful scalar metadata is stored inside
the same private payload as the raw diff, changed paths, check argv, and complete
check output. The immutable checkpoint table likewise stores its safe digest and
creation timestamp beside private baseline and approved file bytes.

The existing recent and older event routes intentionally never select or decode
`payload_json`. Historical attempt summaries therefore cannot be added by
pretending that boundary is unchanged. A narrow projection must explicitly parse
only selected verification events, keep raw evidence on the host, and leave the
payload-free event routes untouched.

This view is useful only if its limits are honest. A fixed event suffix can omit
older attempts, and a fixed summary limit can omit attempts that are inside that
suffix. Checkpoint metadata proves only that the recorded attempt digest equals
the recorded immutable-checkpoint digest; a read-only browser request does not
rehash the private checkpoint bytes.

## Decision

Add one lazy selected-run route:
`GET /api/runs/:id/verification-attempts?snapshot=<revision>`. The query must
contain exactly one `snapshot`, encoded as a canonical positive safe integer.
No duplicate or unknown query, caller-controlled limit, filter, sort, search, or
pagination cursor is accepted. The browser seeds `snapshot` from the coherent
full run's `eventCursor` and never requests this route automatically.

One SQLite read transaction point-checks run existence with
`SELECT 1 FROM runs WHERE id = ?`; it must not call `getRun()`,
`listEvents()`, `getRunHistory()`, `getCheckpoint()`, or another
`SELECT *` loader. The transaction reads the current append-only event
high-water mark and requires exact equality with the requested snapshot. A
request that lost a race to a newer persisted event fails with the fixed
`EVENT_SNAPSHOT_CONFLICT` response rather than combining an older event window
with newer checkpoint state.

The transaction covers exactly the sequence range
`max(1, snapshot - 199)..snapshot`. It selects sequence, run ID, type, and
timestamp for at most 200 events through the existing `(run_id, sequence)` index
and validates exact descending contiguity, identity, bounded event type, and
canonical UTC timestamp. Type-filtered work is always constrained to this range;
the implementation must not search sparse verification types through complete
history.

From that metadata window, the host identifies every
`verification.completed` sequence, retains the newest eight, and reports a
separate overflow bit if more than eight occur inside the window. Only those
retained events receive scalar projection. A first query returns only sequence,
`typeof(payload_json)`, and `octet_length(payload_json)`; it never returns the
payload text. The byte-length function's argument must be the stored column
directly, with no cast, JSON function, substring, or other expression that would
defeat SQLite's length-without-content-load optimization. The host requires
storage class `text` and at most 8 MiB per retained verification event before
any JSON parse.

Only after that byte preflight may SQLite require strict RFC-8259 JSON with
`json_valid(payload_json, 1) = 1`. Direct-child occurrence counts must prove
that `from`, `to`, `outcome`, `diffSha256`, and `verification` each occur
exactly once at the root, that `verification` is an object, and that its
`outcome`, `diffSha256`, and `checkpointSha256` keys each occur exactly
once. Occurrence queries return only counts. JSON5 extensions, duplicate selected
keys, BLOB-backed JSON text, missing/wrong-type fields, and invalid JSON fail
closed before scalar presentation. Extra unselected fields may exist but remain
inside SQLite.

SQLite scalar extraction then requires:

- `from` to equal `verifying`;
- `to` to equal `awaiting_review`;
- the outer and nested verification outcomes to match and be exactly `passed`,
  `failed`, or `unavailable`;
- the outer and nested diff SHA-256 values to match and be canonical lowercase
  hexadecimal; and
- the nested checkpoint SHA-256 to satisfy the same canonical digest validation.

The raw JSON, diff, check collection, argv, output, changed paths, and extra
payload fields never cross the SQLite projection boundary. Any selected-payload
failure surfaces fixed host-controlled error text. An unrelated event's corrupt
or private payload remains unread and cannot fail or appear in the projection.
The 8 MiB browser-projection ceiling is independent of project storage ceilings;
custom or legacy evidence above it remains available through the CLI.

The same transaction uses a dedicated query selecting only `run_id`,
`checkpoint_sha256`, and `created_at` from `checkpoints`. It validates the
expected run identity, canonical lowercase digest, and canonical UTC timestamp
of at most 64 bytes. It must not call `getCheckpoint()` or select
`baseline_base64` or `approved_base64`. Every retained attempt digest must
match this row. The response labels that relation `recorded_digest_match`; it
does not claim current byte integrity or a fresh checkpoint rehash.

If one `checkpoint.saved` event occurs inside the metadata window, a first
scalar preflight returns only its storage class and
`octet_length(payload_json)` with the stored column as the direct argument,
requiring text no larger than 1 KiB.
SQLite then requires strict RFC-8259 JSON, exactly one root
`checkpointSha256` key of text type, and a canonical digest matching the row.
The save-event sequence must be inside coverage and precede every
`verification.completed` sequence in the metadata window. More than one save
event, an event without a row, a post-attempt event, or any mismatch fails
closed.

When the coverage window is truncated and contains no save event, a saved row is
reported as `not_observed_in_coverage`, not as definitely older, missing, or
corrupt. If the window starts at sequence one, a saved row without its event is
inconsistent and fails closed. An attempt without a checkpoint row also fails
closed.

The exact response is:

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
  attemptsTruncatedWithinCoverage,
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
    sequence,
    outcome,
    diffSha256,
    checkpointSha256,
    checkpointRelation: "recorded_digest_match",
    completedAt
  }]
}
```

The retained newest eight attempts are returned in ascending sequence order to
match the workspace timeline. `earlierEventsExcluded` means only that persisted
events exist before the inspected up-to-200-event suffix; it does not assert an
attempt exists there. `attemptsTruncatedWithinCoverage` means only that more
than eight completed attempts occur inside the suffix. The browser may describe
the returned set as complete only through the pinned snapshot, and only when
both values are false; it must never call the set complete for the current run.
It displays “summaries loaded,” never a total-attempt claim.

The client exact-key validator also enforces relational consistency: a positive
seed equal to the response run/snapshot, constants 200 and 8, coverage arithmetic
with `firstSequence = max(1, snapshot - 199)`, `lastSequence = snapshot`, and
`eventCount = lastSequence - firstSequence + 1` as an integer from 1 through
200, bounded canonical timestamps and SHA-256 values, no more than eight unique
ascending attempt sequences inside coverage, and exact checkpoint unions. Every
attempt outcome must be exactly `passed`, `failed`, or `unavailable`, and
every relation must equal `recorded_digest_match`.
`attemptsTruncatedWithinCoverage` requires exactly eight returned attempts;
`not_saved` requires none; `not_observed_in_coverage` requires
`earlierEventsExcluded`; every attempt digest must equal the saved checkpoint
digest; and an observed save sequence must lie inside coverage before every
returned attempt.

The current verification snapshot remains visible above an inline, explicitly
opened “Recent attempt summaries” panel. Before loading, it says that this view
shows the newest up to eight completed summaries from up to the latest 200 events
at one pinned revision and omits commands, output, diffs, paths, and complete
history. A loaded panel visibly shows its revision, inspected sequence range,
summary count, both fixed limits, and each applicable truncation state. Empty
covered history never implies a pass. `not_saved` renders as “No checkpoint row
was recorded at this pinned revision,” and digest equality is explicitly
described as recorded metadata without a byte rehash. Complete private local
evidence remains available through `icarus run history <run-id>`.

The panel is a static pinned read while selected-run live polling continues.
Automatic live-poll reconciliation does not abort or replace an in-flight or
loaded attempt panel. When the full run's cursor advances beyond the loaded
snapshot, the panel stays visible but is marked stale; it never advances the live
cursor or reloads itself.

Every explicit Load, Refresh, or Retry captures a fresh coherent pair of the
current `run.id` and `run.eventCursor`; it never replays a stored failed
request. `EVENT_SNAPSHOT_CONFLICT` keeps any prior successful projection,
discards the conflicted request, and asks the operator to use “Refresh persisted
run.” Only after that operator-triggered refresh completes can another explicit
action seed the new cursor. Other failures preserve the last successful panel
and offer the same fresh-seed retry behavior.

One attempt request may be current. Document hiding, panel close, selected
run/project change, Back, operator-triggered “Refresh persisted run,” opening
older activity, or unmount aborts and invalidates it. A request generation plus
exact run/snapshot/response validation rejects late or mismatched success even
if transport cancellation loses a race.

Attempt-panel Close and “Refresh persisted run” call the attempt-local aborter
only; neither cancels an older-history request. Opening older activity first
aborts and invalidates any attempt request, then marks history open and launches
its initial request; that path must not invoke aggregate cancellation or
self-cancel the new history request. Attempt load/refresh stays disabled until
older activity closes, while an already loaded static attempt panel may remain
visible.

One aggregate `cancelSelectedRunAuxiliaryReads` callback is registered with the
parent and invoked only for parent-owned selected-run/project changes and Back.
It fans out to both history and attempt generations and controllers; two
independent callbacks must not overwrite the existing single registration.
History retains its own document-hiding, history-Close, and unmount cleanup.

The inline panel uses a labelled region, `aria-busy`, a polite status message,
semantic lists/facts/time, textual statuses, and wrapped digests. Only operator
Close restores focus: to the enabled attempt launcher, or to the focusable
verification section when older activity has disabled that launcher. Selection,
Back, and unmount do not attempt focus restoration. No success, failure,
staleness, or polling update steals focus.

This slice adds no schema or migration, dependency, write, event append,
checkpoint creation or rehash, database-maintenance route, Git/source read,
filename/source/checkpoint-byte disclosure, raw payload/diff/check output,
approval actor or usage disclosure, total-attempt count, older-attempt
pagination, stream, watcher, daemon, browser approval, rerun, restore,
execution, arbitrary command, commit, push, deployment, or workflow authority.
The loopback/same-origin boundary, CSP, React text rendering, guarded CLI, and
unresolved ADR 0010 security hold remain unchanged.

## Consequences

Operators can compare a bounded set of completed verification outcomes and their
recorded checkpoint relationship without exposing the evidence bodies that make
CLI history private and complete. The response and browser state stay fixed,
and the separate lazy route prevents payload extraction from joining automatic
selected-run polling.

This is deliberately a new narrow payload-derived projection. It weakens neither
existing metadata route: both continue to avoid `payload_json`. Relevant corrupt
or oversized evidence can make only this optional panel unavailable. A complete
or freshly revalidated checkpoint-integrity view would require private byte
access and a separately approved contract; durable scalar history beyond this
window would require a schema change and migration.

Acceptance must prove strict query parsing and snapshot conflict behavior; 0,
1, 8, and 9 attempts; attempts before the 200-event coverage window; independent
coverage and attempt truncation; checkpoint save observed and unobserved states;
concurrent append; reopen stability; gaps; malformed relevant JSON; unrelated
corrupt/private payload immunity; TEXT-only storage; strict RFC-8259 acceptance
and JSON5 rejection; duplicate selected-key rejection; ASCII and multibyte
exact-bound and over-bound cases at both the 8 MiB verification and 1 KiB save
event ceilings; invalid outcome, digest, and inner/outer mismatch; missing,
mismatched, duplicate, and post-attempt checkpoint state; save-before-attempt
ordering; fixed response keys and bounded bytes; indexed range plans; zero
logical SQLite writes or event appends; unchanged source/Git state; and SQL
shape proving that private checkpoint columns and raw payload text are never
selected or returned.

Client and real-browser acceptance must additionally prove exact-shape
validation, coverage/event counts from 1 through 200, no more than eight
attempts, exact outcome/relation enums, text-only rendering, empty/truncated
copy, single flight, failure/retained-retry behavior, and stale marking under
live cursor advance. It must prove explicit reload, request-local versus parent
aggregate cancellation, attempt-Close/history independence,
abort-before-history-open ordering, hidden/selection/Back/unmount behavior,
cancellation-ignoring late-response rejection, focus round trip,
private-sentinel absence, and preservation of the existing live-poll,
older-activity, workspace-page, and selected-run behaviors.
