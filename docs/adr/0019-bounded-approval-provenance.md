# ADR 0019: Bounded approval provenance

- Status: Accepted
- Date: 2026-07-22
- Depends on: [ADR 0018](0018-bounded-verification-attempt-provenance.md)
- Extends: [ADR 0014](0014-loopback-api-react-workspace.md)
- Related: [ADR 0002](0002-sqlite-event-history.md),
  [ADR 0015](0015-read-only-repository-status-and-event-cursors.md), and
  [ADR 0010](0010-inherited-opencode-workflow-security-hold.md)

## Context

The selected-run response currently loads every approval row. A run may cycle
through review, rollback, restore, and verification more than once, so decoded
host data, response size, and browser memory grow with durable history. The
existing approval list also presents a digest and actor without stating whether
the page is complete or which persisted revision it represents.

Approval rows are authoritative decisions, but they do not prove that approved
bytes remain current or correct. Their timestamps do not establish ordering,
and the browser must not infer causality by pairing an approval with an adjacent
event. Complete history remains a CLI concern.

## Decision

### Bounded selected-run projection

The ordinary selected-run response returns at most the newest 12 approval rows,
ordered oldest to newest inside that retained suffix. It also returns:

```text
approvalCoverage: {
  limit: 12,
  loaded: <0..12>,
  earlierApprovalsExcluded: <boolean>
}
```

One SQLite read transaction continues to own the run row, approval suffix,
recent event suffix, and event high-water mark. Add the
`approvals_by_run(run_id)` index. SQLite's per-index rowid ordering makes
`ORDER BY approvals.rowid DESC LIMIT 13` an indexed reverse seek, so equal
timestamps and random approval UUIDs cannot reorder append history. The query
validates all 13 returned rows, retains 12, then reverses the suffix for
presentation. It does not decode
event payloads or select private run, checkpoint, operation, or event columns.
`EXPLAIN QUERY PLAN` must prove the per-run index rather than a table scan.

Every selected scalar first passes a direct-column SQLite `typeof = 'text'`
and `octet_length` ceiling inside a `CASE` projection. Invalid or oversized
storage becomes a bounded sentinel that host validation rejects; corrupt
megabyte-scale values are never returned to JavaScript.

Each retained row must have the selected run ID; a kind from `egress`, `plan`,
`review`, `rollback`, or `restore`; a canonical lowercase SHA-256 digest; an
actor between 1 and 200 UTF-8 bytes with no Unicode control, format, line-
separator, or paragraph-separator characters or recognizable credential
material; a valid kind/decision pair (`reject` is review-only); and a bounded
canonical UTC timestamp. Invalid persisted data fails closed with a
host-controlled message.

The presenter reconstructs the exact allowlist:

```text
{ kind, digest, actor, decision, createdAt }
```

No database identity, rowid, raw payload, source bytes, private path, command,
provider response, or error text crosses the API.

### Browser truth and lifecycle

The selected-run page labels the list “Approval provenance” and visibly states
the 12-row bound. Empty means no decision is present in the retained response;
it does not mean that an approval was unnecessary. A truncated suffix displays
CLI guidance and never claims a total.

Every row says “recorded decision” and “recorded digest.” It does not claim that
the digest was independently rehashed, that source or checkpoint bytes remain
current, that the actor is an authenticated account, or that an approval grants
browser authority. The existing selected-run refresh and event-cursor fencing
own freshness; this slice adds no independent request or poller.

Semantic lists, `<time>`, wrapped digests, visible decision text, stable headings,
and React text rendering are required. Actor text never becomes HTML, a URL,
an identifier, a fragment, or an accessible-name replacement.

### Authority and response boundary

The legacy full-history CLI API retains complete approvals. Only the workspace
presentation snapshot is bounded. This slice adds the one additive approval
index but no table/column migration, approval action, data mutation, event
append, Git/source read, provider call, check execution, stream, watcher, daemon,
command, commit, push, deployment, account, or workflow authority. Building the
index against existing non-test state requires a backup and explicit operator
rollout approval. ADR 0010 and `.github/workflows/opencode.yml` remain
separately held.

## Acceptance evidence

The implementation merged through PR #4. The combined local gate, cached
Chromium acceptance, and independent review completed with no remaining blocker,
high, or medium finding. Exact implementation-head hosted CI
[29963114892](https://github.com/Ayyitskevin/Icarus/actions/runs/29963114892)
passed at `cb3b97f8fc68b0bf451709b2a023031dc10c1177`; resulting `main` CI
[29964954585](https://github.com/Ayyitskevin/Icarus/actions/runs/29964954585)
passed at `03c27640ffd0e8a377f2a17e64dc2be987a52409`.

Acceptance does not resolve ADR 0010 or authorize deployment. Building the
index against existing non-test state still requires a verified backup and
explicit operator approval.

## Consequences

The browser gains truthful, bounded approval provenance while selected-run
queries avoid a history-sized scan and materialize at most 13 approval rows
after an indexed seek. Response size and decoded approval data no longer grow
with approval history. Operators use CLI history for older decisions and causal
investigation.

Acceptance covers 0, 1, 12, and 13-plus rows; every kind and decision; stable
append ordering with adversarial UUIDs and same-timestamp rows; malformed IDs,
kinds, digests, actors, controls, credentials, kind/decision pairs, timestamps,
and storage classes; fixed response shape and size; zero writes/events/Git
reads; hostile actor text rendered only as text; visible truncation and CLI
guidance; and unchanged browser authority. Transactional snapshot coherence is
an implementation invariant; this slice does not claim a separate WAL stress
test for approval appends.
