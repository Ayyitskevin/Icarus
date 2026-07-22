# ADR 0021: Bounded project catalog and JSON responses

- Status: Proposed
- Date: 2026-07-22
- Extends: [ADR 0014](0014-loopback-api-react-workspace.md)
- Related: [ADR 0017](0017-bounded-workspace-run-summaries.md), [ADR 0010](0010-inherited-opencode-workflow-security-hold.md)

## Context

The workspace bootstrap still enumerates every project and repository. The
store first lists project IDs, hydrates every project separately, lists every
repository separately, and then joins them in application memory. Total SQL
work, decoded configuration, response bytes, and retained browser state grow
with the catalog. Project creation and browser run creation also scan complete
collections for records that already have unique indexed keys.

The API limits request bodies but has no corresponding final JSON response
limit. Individual presenters bound several evidence fields, yet a composition
of legitimate fields or corrupt persisted state can still create an
unreasonably large response. Writing success headers before serialization also
prevents the top-level error boundary from replacing an oversized or
unserializable response with a deterministic safe error.

Projects are ordinary SQLite rowid records and Icarus exposes no project
deletion, replacement, `VACUUM`, or database-maintenance route. As with ADR
0017's run pages, a session-only insertion cursor can use the intrinsic rowid
B-tree without a schema migration. Unsupported external deletion, replacement,
or `VACUUM` invalidates the session and requires a new page.

## Decision

Replace `projects` in `GET /api/workspace` with `projectPage`. Add
`GET /api/projects`: no query starts a newest-page session; continuation
requests require exactly one canonical positive safe-integer `before` and one
canonical nonnegative safe-integer `snapshot`. No limit, filter, search, sort,
or extra query parameter is accepted.

The first read transaction obtains
`CAST(COALESCE(MAX(rowid), 0) AS TEXT)`, rejects an unsafe value, pins that
maximum as membership snapshot, and uses `snapshot + 1` as the first exclusive
cursor. Empty state is `before: 1`, `snapshot: 0`, `nextBefore: 1`,
`hasMore: false`. Continuations reject snapshots ahead of current history,
missing nonzero snapshot anchors, and missing page anchors.

One joined data query reads the page:

```sql
SELECT CAST(p.rowid AS TEXT) AS cursor, <allowlisted bounded columns>
FROM projects AS p
LEFT JOIN repositories AS r ON r.id = p.repository_id
WHERE p.rowid < ? AND p.rowid <= ?
ORDER BY p.rowid DESC
LIMIT 13
```

The intrinsic rowid B-tree seeks projects and the repository primary-key index
per retained row. The left join deliberately surfaces an orphaned project as
invalid null repository metadata instead of omitting corrupt state. The
thirteenth row derives `hasMore`; at most 12 are returned. There is no
per-project or per-repository hydration query. Each result includes the existing
project presentation: canonical IDs and names, repository ID/name/path, base
ref, checks, sandbox, ceiling, and project creation time. Internal repository
device, inode, and repository creation time are validated for the joined record
but remain outside the presenter.

All selected persisted text is storage-class and byte checked in SQL before it
crosses into JavaScript. IDs are at most 64 bytes, names 100 bytes, base refs
256 bytes, repository paths 4,096 bytes, and timestamps 64 bytes. Check JSON is
TEXT, strict RFC-8259 JSON, and at most 1 MiB. Sandbox and ceiling JSON are TEXT,
strict JSON, and at most 16 KiB each. Parsed objects require exact keys and
valid policy relationships. New project writes use the same JSON byte ceilings,
preventing the supported create paths from persisting a catalog-poisoning
configuration. Invalid, BLOB, malformed, oversized, extra-key, or policy-
inconsistent selected values fail closed as `DATABASE_ERROR`; unselected older
corruption is not decoded.

Indexed direct lookups replace collection scans. Project-name conflict checks
use the unique project-name index, repository reuse uses the unique repository-
name index, and browser run creation supplies the validated project ID directly
to the store's existing exact project lookup. CLI list commands retain their
explicit complete-list behavior.

The browser validates exact project/page shapes and policy relationships before
acceptance. It replaces rather than accumulates pages, retaining one 12-project
page and at most three newer-page cursors. Older/newer navigation is explicit.
Only one project-page request may be current; workspace refresh, another page
request, document hiding, selection change, or unmount aborts it. A generation
guard plus exact cursor/snapshot validation rejects late or mismatched success.
Failure preserves the last successful page and exact retry request. A selected
project object remains usable while navigating another catalog page. Creating a
project selects the returned record and refreshes into a new newest-page
session. Beyond four pages, the UI points to `icarus project list`.

Every API JSON response now serializes completely before headers and includes
its trailing newline in one fixed 8 MiB UTF-8 ceiling. The limit covers health,
workspace, project, run, event, evidence, mutation, and error JSON; it does not
apply to static workspace assets. Eight MiB is comfortably above ordinary
current project pages and selected-run responses under their existing context,
diff, and persisted command-output limits while providing a final composition
backstop. A larger serialized result throws `RESPONSE_TOO_LARGE`; the outer
boundary returns a fixed HTTP 500 JSON error without leaking rejected content.
The safe error itself is subject to the same serializer and is far below the
ceiling.

This slice adds no table, index, migration, dependency, project deletion,
database maintenance, Git/source read, provider call, stream, watcher, daemon,
browser approval, execution, command, commit, push, deployment, or release
authority. It preserves loopback/same-origin/CSP controls, React text rendering,
guarded CLI lifecycle, and the unresolved ADR 0010 release hold.

## Consequences

Workspace project work and browser retention are fixed by page size rather than
catalog history. The joined query removes the prior N+1 hydration pattern;
create paths no longer scan complete collections. The response ceiling protects
all current and future JSON compositions even when a narrower presenter bound
is missed.

The cursor is intentionally session-only insertion order, not a durable
chronological bookmark. A catalog with multiple near-limit project
configurations can exceed the aggregate 8 MiB response ceiling and will fail
closed rather than return a partial page. A future lean summary/detail split
would need its own UX and disclosure decision; this slice preserves the current
full project presentation.

Acceptance must prove empty and 12/13/>200-project boundaries, gaps, pinned
membership during insertion, intrinsic-rowid and repository-index plans, one
joined data query, exact query validation, malformed/BLOB/oversized/extra-key
selected fields, unread older corruption, zero read-side writes, no create/run
collection scans, exact presenter fields, four-page replacement, retry and stale
rejection, hidden/selection/unmount cancellation, new-project selection and
refresh, exact/over 8 MiB serialization, pre-header safe overflow handling,
unchanged source state, static security assertions, the full local gate, and
exact-head hosted CI. Until those merge gates close, this ADR remains Proposed.
