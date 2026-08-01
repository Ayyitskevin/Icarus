# ADR 0020: Bounded persisted diff and run-status review

- Status: Accepted
- Date: 2026-07-22
- Depends on: [ADR 0019](0019-bounded-approval-provenance.md)
- Extends: [ADR 0014](0014-loopback-api-react-workspace.md)
- Related: [ADR 0003](0003-detached-worktree-single-file.md),
  [ADR 0018](0018-bounded-verification-attempt-provenance.md), and
  [ADR 0010](0010-inherited-opencode-workflow-security-hold.md)

## Context

The selected-run response already exposes the persisted Git diff as one raw
string, its recorded verification digest, the exact run state, and the latest
verification outcome. The browser renders the string as text, but those facts
are separated across the page. It does not say whether the exact displayed
string still hashes to the recorded digest, how large or structurally useful the
patch is, or whether an absent string means no diff or a presentation bound.

The desired review improvement must not become a current-worktree inspection.
Reading Git or source again would add a new authority and timing boundary, while
line-by-line HTML rendering would multiply untrusted DOM nodes. A partial diff
would also be unsafe review evidence because its digest binds bytes the operator
cannot see.

## Decision

### Existing coherent snapshot only

The ordinary selected-run response derives a `diffReview` projection from the
already loaded, transaction-coherent `run.diff`, `run.verification`, run target,
and registered project ceiling. It adds no route, request, poller, database
query, schema, migration, provider call, Git operation, or filesystem read.

For normally bounded runs the existing `diff: string | null` field remains
compatible. The exact response union is:

```text
not_produced:
  status, path: null, sha256: null, byteCount: 0, lineCount: 0,
  addedLines: 0, deletedLines: 0, hunkCount: 0,
  browserByteLimit: 262144, digestProvenance: "not_available"

available:
  status, path, sha256, byteCount, lineCount, addedLines, deletedLines,
  hunkCount, browserByteLimit: 262144,
  digestProvenance: "displayed_text_rehash_match"

outside_browser_bound:
  status, path, sha256, byteCount,
  lineCount: null, addedLines: null, deletedLines: null, hunkCount: null,
  browserByteLimit: 262144, digestProvenance: "recorded_only"
```

All variants contain exactly those ten keys. `diff` is the complete persisted
string only for `available`; otherwise it is `null`. No prefix, suffix, or other
partial patch is returned.

This cap bounds newly exposed response and browser-rendered patch bytes. It does
not claim to bound the existing full-run SQLite row hydration, which already
loads persisted diff and other private run fields before presentation. Replacing
that loader requires a separate response-projection decision.

### Fail-closed validation and statistics

Diff and verification must be both absent or both present. A present diff must
be nonempty, NUL-free text within the registered project `maxDiffBytes` ceiling.
Its verification digest must be canonical lowercase SHA-256, and changed paths
must contain exactly the selected target.

At or below 262,144 UTF-8 bytes, the local API rehashes the exact string and
requires equality with the recorded verification digest. It accepts exactly one
ordered textual Git patch whose decoded old/new headers bind to the selected
target, whose index/header sequence is canonical for the supported one-file
replacement, and whose hunk bodies exactly satisfy their declared old/new line
counts. It then reports physical patch lines, hunk count, and added/deleted
patch-line counts. These are patch statistics, not live file or repository
observations.

Any inconsistency fails with fixed `DATABASE_ERROR` copy and never includes the
persisted value. A valid project may configure a larger diff ceiling. Above the
browser cap the API returns metadata only, labels the digest `recorded_only`,
does not rehash or parse the hidden string for a stronger claim, and sends no
partial text.

### Browser review semantics

One focusable `#run-diff` section places the exact persisted run state,
verification outcome, recorded path, byte count, patch statistics, digest, and
digest provenance together. At the review gate the exact patch is initially
expanded inside one React `<pre>` text node; other states begin collapsed. The
patch has a labelled, keyboard-focusable bounded-height scroll region rather
than one DOM node per line.

Copy states that the API did not re-read the repository or worktree and that a
rehash match does not prove current source bytes. An oversized diff shows no
excerpt and directs the operator to `icarus run status <run-id>`. An absent diff
does not imply successful verification.

`verification.completed` metadata links to the fixed diff anchor, while
`checkpoint.saved` remains linked to verification. Paths, patch text, and
digests never become HTML, URLs, element IDs, or accessible-name substitutes.

### Authority boundary

This slice adds no browser approval, review decision, mutation, edit, check,
rerun, rollback, restore, arbitrary command, commit, push, deployment, account,
workflow, stream, watcher, daemon, Git/source read, or public endpoint. Existing
loopback/same-origin controls, guarded CLI lifecycle, approval provenance, and
ADR 0010 remain unchanged.

## Acceptance evidence

The implementation merged through PR #4. The combined local gate, cached
Chromium acceptance, and independent review completed with no remaining blocker,
high, or medium finding. Exact implementation-head hosted CI
[29963114892](https://github.com/Ayyitskevin/Icarus/actions/runs/29963114892)
passed at `cb3b97f8fc68b0bf451709b2a023031dc10c1177`; resulting `main` CI
[29964954585](https://github.com/Ayyitskevin/Icarus/actions/runs/29964954585)
passed at `03c27640ffd0e8a377f2a17e64dc2be987a52409`.

Acceptance does not resolve ADR 0010 or authorize deployment.

## Consequences

Operators can review one complete bounded persisted patch beside the exact run
and verification statuses and distinguish displayed-byte integrity from a
recorded-only digest. Large valid patches remain available through CLI without
turning a partial browser preview into approval evidence.

Acceptance covers all three union variants, exact keys, Unicode byte accounting,
patch statistics, HTML-like text, digest/path/presence/format corruption,
project- and browser-ceiling boundaries, no-partial response behavior, sanitized
errors, unchanged SQLite and repository fingerprints, fixed anchor navigation,
keyboard focus, review-gate expansion, no new controls or unsafe sinks, static
no-read-authority assertions, and the full local gate. Explicit cached Chromium
1228 completed the compiled workspace flow with inert hostile patch text, Tab
focus and PageDown scrolling in the labelled patch region, the fixed evidence
anchor, held-request cancellation, zero external requests or browser errors,
and unchanged SQLite and source fingerprints.
