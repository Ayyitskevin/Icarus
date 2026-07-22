# ADR 0019: Bounded approval provenance

- Status: Proposed
- Date: 2026-07-22
- Depends on: [ADR 0018](0018-bounded-verification-attempt-provenance.md)
- Extends: [ADR 0014](0014-loopback-api-react-workspace.md)
- Related: [ADR 0002](0002-sqlite-event-history.md),
  [ADR 0015](0015-read-only-repository-status-and-event-cursors.md), and
  [ADR 0010](0010-inherited-opencode-workflow-security-hold.md)

## Context

The selected-run response currently loads every approval row. A run may cycle
through review, rollback, restore, and verification more than once, so response
work and browser memory grow with durable history. The existing approval list
also presents a digest and actor without stating whether the page is complete or
which persisted revision it represents.

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
recent event suffix, and event high-water mark. Approval selection uses direct
columns only, orders by SQLite rowid descending with `LIMIT 13`, retains 12,
then reverses the suffix for presentation. The query does not decode event
payloads or select private run, checkpoint, operation, or event columns.

Each retained row must have the selected run ID; a kind from `egress`, `plan`,
`review`, `rollback`, or `restore`; a canonical lowercase SHA-256 digest; an
actor between 1 and 200 UTF-8 bytes with no controls or recognizable credential
material; a decision from `approve` or `reject`; and a bounded canonical UTC
timestamp. Invalid persisted data fails closed with a host-controlled message.

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
presentation snapshot is bounded. This slice adds no approval action, mutation,
schema, migration, event append, Git/source read, provider call, check execution,
stream, watcher, daemon, command, commit, push, deployment, account, or workflow
authority. ADR 0010 and `.github/workflows/opencode.yml` remain separately held.

## Consequences

The browser gains truthful, bounded approval provenance while the selected-run
response stops growing with approval history. Operators use CLI history for
older decisions and causal investigation.

Acceptance covers 0, 1, 12, and 13-plus rows; every kind and decision; stable
suffix ordering; same-timestamp rows; malformed IDs, kinds, digests, actors,
controls, credentials, decisions, timestamps, and storage classes; one coherent
read snapshot under a concurrent approval append; fixed response shape and size;
zero writes/events/Git reads; hostile actor text rendered only as text; visible
truncation and CLI guidance; and unchanged browser authority.
