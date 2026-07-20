# ADR 0016: Bounded older event navigation

- Status: Accepted
- Date: 2026-07-20
- Extends: [ADR 0015](0015-read-only-repository-status-and-event-cursors.md)
- Related: [ADR 0002](0002-sqlite-event-history.md), [ADR 0010](0010-inherited-opencode-workflow-security-hold.md)

## Context

ADR 0015 gives the selected run a coherent 200-event metadata tail and a fixed
forward cursor for live freshness. When a run has more than 200 events, the
browser honestly reports truncation but cannot inspect the older metadata. The
existing forward endpoint could begin at sequence zero, but reaching the page
immediately before the visible tail would require work and requests proportional
to total history. Reusing that cursor for manual browsing would also couple live
freshness to historical navigation.

The next M3 slot names file/status, diff, and history views as peer candidates.
Repository filenames, source contents, richer diffs, and payload-bearing event
history each widen a private-data boundary. Older event metadata can instead
reuse the already accepted sequence/type/host-label/timestamp/evidence-section
projection without reading Git, source files, or event payloads.

## Decision

Add one selected-run, read-only historical metadata route:
`GET /api/runs/:id/events/history?before=<sequence>&snapshot=<revision>`. Both
query values are required exactly once and are canonical positive safe integers.
The route returns events strictly before the exclusive `before` cursor and not
beyond the pinned `snapshot` revision. The store verifies in one SQLite read
transaction that the run exists, the snapshot is not ahead of the current
append-only high-water mark, and the cursor is not ahead of `snapshot + 1`.

The query selects only `sequence`, `run_id`, `type`, and `created_at`, ordered by
sequence descending with a fixed service-owned `LIMIT 65`. It uses the existing
unique `(run_id, sequence)` index, retains at most 64 rows, reverses them for
ascending display, and fails closed on a gap or malformed metadata. It never
selects or decodes `payload_json`. The allowlisted response contains only:

- run ID, requested exclusive cursor, and pinned snapshot revision;
- the next exclusive older cursor and a truthful `hasMore` flag; and
- sequence, bounded event type, fixed host-controlled label, bounded timestamp,
  and fixed host-generated evidence section for each event.

The current `after` endpoint and live high-water cursor remain unchanged. The
browser opens older activity only after an explicit operator action and seeds the
first request from the earliest sequence in the coherent selected-run tail plus
that run response's event cursor. Historical state never advances the live
cursor. While the older-activity panel is open, selected-run live polling is
paused and any current poll is aborted; closing the panel resumes live polling
immediately.

Only one historical request may be current. Hiding the document, closing the
panel, selecting another run/project, or unmounting aborts it. A request
generation and exact run/cursor/snapshot validation reject late or mismatched
responses even when transport cancellation loses a race. Failure preserves the
last successful page and exposes an explicit retry state.

The UI replaces rather than accumulates historical pages. One panel session may
reach at most four historical pages while retaining one 64-row page and at most
three newer-page cursors. It offers older/newer navigation inside that window and
directs the operator to CLI history beyond it. Historical labels remain untrusted
text. Any link is explicitly described as navigation to the current allowlisted
evidence section, not a historical payload snapshot.

This slice adds no schema or migration, dependency, write, event append, Git or
source read, file/status disclosure, diff payload, check output, raw event
payload, streaming transport, watcher, daemon, browser approval, execution,
arbitrary command, commit, push, or deployment authority. It preserves the
loopback/same-origin boundary, portable read-only host support, guarded CLI
lifecycle, and unresolved ADR 0010 release hold.

## Consequences

The browser can inspect a bounded window immediately before its recent timeline
without draining complete history or conflating historical and live cursors.
Each request and retained client state remain constant-size. A page is a pinned,
metadata-only view; it does not claim that the current evidence section still
matches historical payload detail.

Acceptance must prove strict query parsing, index-backed `LIMIT + 1` work,
snapshot and contiguity checks, payload non-selection under corrupt/private
payload fixtures, no persistence or repository mutation, fixed presenter text
and anchors, one-request timing, hidden/selection/unmount aborts, stale-response
rejection, page replacement, bounded navigation depth, failure/retry truth, live
poll pause/resume, real-browser navigation, and exact-head hosted CI.

Workspace-wide run enumeration and approval lists retain their existing
unpaginated local behavior and remain explicit follow-up debt. Repository
file/status views, richer diff or verification-attempt views, payload-bearing
history, patch materialization, browser approval, and execution require separate
decisions and safety evidence.
