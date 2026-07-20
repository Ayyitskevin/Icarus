# ADR 0017: Bounded workspace run summaries

- Status: Accepted
- Date: 2026-07-20
- Extends: [ADR 0014](0014-loopback-api-react-workspace.md)
- Related: [ADR 0002](0002-sqlite-event-history.md), [ADR 0016](0016-bounded-older-event-navigation.md), [ADR 0010](0010-inherited-opencode-workflow-security-hold.md)

## Context

The workspace bootstrap currently enumerates every run and builds each full run
presentation, including approvals, a timeline, context metadata, diff, checks,
outputs, and usage. The React sidebar displays only the first 12 runs. Work and
response size therefore grow with total run history, and unselected runs cross a
broader presentation boundary than the list needs.

ADR 0016 identifies workspace-wide run enumeration and selected-run approval
lists as follow-up debt. Older run summaries are the next chronological layer
after recent and older activity within one selected run. They can reuse fields
already shown in the run lists without adding repository reads, filenames,
payloads, diffs, check output, or action authority. Approval pagination remains a
separate selected-run concern.

The runs table has no chronological pagination index. Adding one would be a
schema migration and requires a separate human gate. It is an ordinary SQLite
rowid table, however, and Icarus has no run deletion, replacement, or
`VACUUM` path. A session-only insertion cursor can therefore use the intrinsic
rowid B-tree without changing schema. The cursor is not a durable identifier or
bookmark; unsupported external database deletion, replacement, or `VACUUM`
invalidates the session and requires opening a new page.

## Decision

Replace the unbounded full-run collection in `GET /api/workspace` with one
fixed run-summary page. Add `GET /api/runs`: no query opens a new page session,
while subsequent page requests require exactly one `before` and one `snapshot`
query parameter. `before` is a canonical positive safe integer and `snapshot`
is a canonical nonnegative safe integer. No other query, caller-selected limit,
project filter, sort, or search is accepted.

The first read transaction obtains
`CAST(COALESCE(MAX(rowid), 0) AS TEXT)`, parses that canonical decimal text,
and fails closed unless it is at most `Number.MAX_SAFE_INTEGER - 1`. Empty
history uses snapshot `0`; otherwise the maximum rowid is the pinned membership
snapshot. The first exclusive cursor is `snapshot + 1`. Later reads verify that
the snapshot is not ahead of the current maximum and that a nonzero snapshot
still names a row. `before === snapshot + 1` is the page-one sentinel;
otherwise `before` must name a row within the snapshot.

The fixed query is:

```sql
SELECT CAST(rowid AS TEXT) AS cursor,
       id, project_id, task, target, state, created_at, updated_at
FROM runs
WHERE rowid < ? AND rowid <= ?
ORDER BY rowid DESC
LIMIT 13
```

It seeks the intrinsic integer-primary-key B-tree, retains at most 12 rows, and
uses the thirteenth row only to derive `hasMore`. On every page,
`nextBefore = retainedRuns.at(-1)?.cursor ?? before`; `hasMore` alone enables
Older. Empty history is therefore `before: 1`, `snapshot: 0`,
`nextBefore: 1`, `hasMore: false`, and an empty run list. Rowids are parsed
from canonical decimal text before safe-integer conversion and appear only as
top-level ephemeral cursor metadata, never as run fields.

The exact page response contains `before`, `snapshot`, `nextBefore`,
`hasMore`, and `runs`. Each run summary contains only:

- canonical lowercase UUID run ID and project ID;
- nonempty NUL-free task text of at most 8 KiB UTF-8 and target text of at most
  1 KiB UTF-8;
- exact persisted state and a host-derived product phase; and
- canonical UTC ISO-8601 creation and update timestamps of at most 64 bytes.

The query does not select or decode provider configuration, context, plan, edit,
diff, verification, error, usage, approvals, or events. Selecting a summary
requests the existing full selected-run route separately. The membership
snapshot fixes which run insertions belong to the page session; it does not
freeze run state or `updatedAt`, which remain current when each page is read.

The browser replaces rather than accumulates pages. One session retains one
12-row page and at most three newer-page cursors, for a maximum depth of four
pages. Older/newer navigation is explicit. One page request may be current;
document hiding, another page request, workspace refresh, selection change, or
unmount aborts it. A request generation plus exact cursor/snapshot response
validation rejects late or mismatched success. Failure preserves the last
successful page and offers an honest retry. Beyond the four-page window, the UI
directs the operator to `icarus run list [--project NAME]`.

The sidebar labels page size rather than a total. Project detail labels its
filtered entries as matches in the loaded workspace page and never claims they
are the project's complete history. Creating a run or explicitly refreshing the
workspace opens a new newest-page session. A selected full run remains
independent of the current summary page.

This slice adds no schema or migration, dependency, write, event append, run
deletion, database maintenance route, Git or source read, repository status
detail, provider/context/plan/edit/diff/check/output/error/usage/approval/event
payload disclosure, stream, watcher, daemon, browser approval, execution,
arbitrary command, commit, push, or deployment authority. It preserves the
loopback/same-origin boundary, React text rendering, portable read-only host
support, guarded CLI lifecycle, and unresolved ADR 0010 release hold.

## Consequences

Workspace bootstrap and each browser run page perform fixed indexed row visits,
retain constant client state, and avoid hydrating full details for unselected
runs. Operators can inspect a bounded chronological run window and lazily open
one full run without confusing the page with a complete project history.

The cursor is intentionally session-only insertion order. An operator who
externally rewrites or vacuums the database must restart navigation. A durable
cross-maintenance chronological cursor would require an operator-approved
`(created_at, id)` index and is not claimed here.

Acceptance must prove strict dual-mode query parsing, safe rowid handling,
intrinsic-rowid query-plan use, `LIMIT + 1` boundaries with more than 200 runs,
empty history, gaps, pinned membership under concurrent insertion, malformed
summary metadata, non-selection of corrupt/private heavy columns, zero logical
writes, no full-run N+1 hydration, fixed presenter fields, lazy full-run
selection, failed/late detail preservation, one-request timing,
hidden/selection/unmount aborts, stale-response rejection, page replacement,
four-page depth, failure/retry truth, real-browser navigation, and exact-head
hosted CI.

Project and repository enumeration plus selected-run approval lists retain their
existing unpaginated local behavior. Approval pagination, repository file/status
detail, richer diff or verification-attempt views, payload-bearing history,
patch materialization, browser approval, and execution require separate
decisions and safety evidence. Full M3 remains open.
