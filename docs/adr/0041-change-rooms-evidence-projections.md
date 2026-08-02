# ADR 0041: Change Rooms are evidence projections, not a chat system, workflow engine, or execution authority

- Status: Proposed
- Date: 2026-08-01
- Extends: [ADR 0014](0014-loopback-api-react-workspace.md)
- Related: [ADR 0002](0002-sqlite-event-history.md),
  [ADR 0015](0015-read-only-repository-status-and-event-cursors.md),
  [ADR 0016](0016-bounded-older-event-navigation.md),
  [ADR 0017](0017-bounded-workspace-run-summaries.md),
  [ADR 0018](0018-bounded-verification-attempt-provenance.md),
  [ADR 0023](0023-transactional-multi-file-patch-sets.md),
  [ADR 0026](0026-agent-session-loop-and-tool-registry.md),
  [ADR 0029](0029-browser-approval-authority.md),
  [ADR 0036](0036-proof-carrying-software-factory-product-direction.md)

## Context

Operators reviewing a guarded change must reconstruct its story from several
separate surfaces: run status, the approval list, bounded event metadata, the
verification-attempt projection, and CLI history. The product direction asks
for one canonical, operator-facing explanation per run — a "Change Room" — in
the spirit of a work room that is the durable record of why a change exists:
the task, the approved scope, what the model proposed, what the operator
approved, what changed, what verification proved, and how to land or reverse
it safely.

That direction tempts three failure modes this ADR exists to foreclose. A room
could become a chat channel whose messages acquire implicit authority. It
could become a second workflow state machine that disagrees with the run
record. Or it could become an execution surface that quietly widens browser
authority. None of those is compatible with the Icarus safety model: the Change
Room surface is read-only, and every guarded fact must come from the persisted
run, approval, event, verification, and checkpoint records.

Operator review annotations are the one new durable input. They need a home,
and the only durable local store is the existing SQLite database, so adding a
table is a schema change that this ADR must explicitly approve and bound
through the established one-shot operator-approved migration framework.

This decision is the per-run evidence container named by
[ADR 0036](0036-proof-carrying-software-factory-product-direction.md)'s
product promise — the operator reviews one evidence bundle — and by its Gate 3
"authority/evidence containers." It is deliberately not the ADR 0037 Mission
Room: there is no membership, no deliberation transcript, and no participant
provider call here. A Change Room answers "what was requested, proposed,
approved, changed, verified, decided, and how to land or reverse it" from the
run's authoritative records; bounded multi-agent deliberation remains the
separate ADR 0037 collaboration track. Where ADR 0036's Crew track later joins
decisions, patches, checks, review, and landing receipts in a branch room,
this per-run projection is the evidence surface those receipts reference.

## Decision

### Change Rooms are read-only projections

A Change Room is not a new entity. The room of a run is the run;
`roomId` is the run ID. The `icarus.change-room.v1` projection is derived on
every read from the authoritative records — the run row, approvals, the
bounded event metadata tail, the checkpoint row, and project check/sandbox
configuration — inside one SQLite read transaction. There is no room table,
no event bus, no room membership, and no parallel workflow state. Restarting
the process and re-reading yields the identical projection, and the
integration evidence asserts that byte-for-byte replay.

The projection contains exactly eleven evidence cards in a fixed lifecycle
order: task and approved scope, pinned base and context egress, provider
plan, plan approval, PatchSet and diff evidence, registered checks,
verification outcomes, review decision, checkpoint, rollback and restoration,
and run state with terminal outcome. Each card carries a host-controlled
title, a provenance class (`operator_assertion`, `provider_output`,
`host_fact`, `approval_decision`, `verification_evidence`,
`system_failure`), an explicit status (`available`, `pending`,
`not_applicable`, `unavailable`), bounded references to the authoritative
records (event sequences, approval digests, plan/context/diff digests, the
checkpoint digest), a bounded body, and explicit `truncated`, `redacted`,
and `unavailableEvidence` indicators.

Card bodies reuse only the disclosure classes the existing full-run
presenter already crosses: bounded-at-persistence redacted diff and check
output, context manifest metadata, plan and edit rationale, approvals,
digests, and state. Baseline/approved checkpoint bytes, private
cache/worktree/artifact paths, event payloads, raw provider prompts, and
source blobs are never selected. The checkpoint card repeats that its digest
is a recorded byte binding, not a fresh rehash. The room integrity block
states that digests prove byte binding and recorded-evidence integrity only —
never fresh authorization or semantic correctness. Provider output is
labeled an untrusted proposal until host validation and recorded approvals
establish the relevant facts.

A review rejection performs the bounded rollback without a separate rollback
approval row, so the rollback/restoration card projects it as a rollback
record carrying the rejecting decision. Completion sequences on those records
mark observed completion events, not a causal link to one record; CLI history
remains the full ordered record.

### The room index is a bounded summary page

`GET /api/change-rooms` mirrors the ADR 0017 rowid-page discipline exactly:
one pinned `MAX(rowid)` snapshot, descending `LIMIT 13`, twelve retained
summaries, an ephemeral exclusive cursor, and fail-closed cursor validation.
Each summary adds only safe derived metadata: the latest verification outcome
(`passed`, `failed`, `unavailable`, or `not_run` when no verification column
exists), provider kind/model/locality/privacy class, exact state, host-derived
phase, a host-derived terminal reason, and timestamps. Provider and
verification JSON are projected in SQL only behind `typeof`/`octet_length`
preflight (16 KiB provider, 4 MiB verification) and strict `json_valid`;
an unprojectable or invalid value fails the page closed as database
corruption rather than guessing an unknown model or outcome. The index
claims nothing about raw provider configuration, context, plans, diffs,
checks, usage, approvals, or events.

### "Explain this change" is deterministic and model-free

`GET /api/runs/:id/change-context?question=...` answers exactly five fixed
questions — `why_blocked`, `what_changed`, `what_passed`,
`what_remains_before_review`, `why_rolled_back` — with an
`icarus.change-context.v1` packet built by a pure host function over the room
projection. No LLM, provider, network service, or external tool is involved.
Every component statement is a host-controlled template interpolating only
bounded facts (states, digests, sequences, actors, counts) and carries
receipts: the evidence-card IDs, event sequences, and digests its statement
stands on. Packets carry explicit omission and uncertainty lists — for
example, that a truncated browser timeline may hide earlier causes, or that
the authoritative record contains no free-text rollback reason. The packet is
designed so a future optional local/BYOK assistant could summarize it with
citations; this milestone does not build that assistant. A completed run's
`what_changed` states plainly that nothing was committed, pushed, merged, or
deployed.

### Annotations are append-only CLI operator context, never authority

Operators may attach bounded review annotations to a room or a specific
evidence card through `run annotate RUN --card CARD|room --text TEXT --actor
ACTOR`, and list them with `run annotations RUN`. Annotations:

- persist in a new `run_annotations` table with no update or delete path
  anywhere in the codebase;
- are validated before any write: run existence, a closed card enum, the
  approval-actor rules, a 1 KiB body bound, no NUL bytes, and fail-closed
  rejection of recognizable credential material in actor or body;
- are capped at 32 per run so room responses stay bounded;
- never append a lifecycle event, advance an event cursor, change run state,
  satisfy a gate, or feed any digest, approval, verification, or execution
  input — the store asserts this by construction and the tests prove the run
  row, event stream, and approvals are byte-identical after annotating;
- appear in the browser only as durable read-only operator context inside
  the room projection. There is no browser annotation route.

The browser therefore gains no mutation authority of any kind from this
slice: all three new API routes are GET-only reads on the observation side of
the boundary, and the route inventory assertions cover them. The ADR 0029
browser mutation session and its fenced origins are untouched — room copy
states that approvals are recorded through the CLI or that fenced session,
while the room itself stays read-only evidence.

### The annotation migration follows the one-shot operator-approved framework

`run_annotations` is the only schema change. Its DDL lives beside the other
schema constants in `core-schema.ts` as `ICARUS_ANNOTATION_SCHEMA` and is
applied idempotently on every open, so freshly created databases always have
it. A database that already has `runs` but lacks the table follows the same
contract as the approval-index, patch-set, and readable-manifest migrations:
a read-only shape inspection runs before the writable handle opens, and the
store refuses to open with `DATABASE_MIGRATION_REQUIRED` until the operator
backs up state and reruns with exactly
`ICARUS_APPROVE_SCHEMA_MIGRATION=run-annotations-v1`. One token approves
exactly one migration; an unrelated token changes nothing. A table whose
shape does not match fails closed as `DATABASE_ERROR`. The annotation objects
are registered in the closed schema-object set, so no unknown-object
assertion can mistake them for tampering. There is no backfill, no
destructive step, and no change to the deletion-coupling invariant. The
upgrade policy in `docs/OPERATIONS.md` is amended accordingly.

### Explicit non-goals for this slice

No chat or generic messaging; no event bus or room database; no browser
approval, mutation, annotation authoring, execution, command, commit, push,
or deployment route; no live room polling or streaming transport; no LLM or
BYOK summarizer; no free-text questions; no room search; no annotation
editing or deletion; no remote or multi-agent personas; no Nostr, relay,
federation, forge, or Git hosting functionality borrowed from the inspiring
product; no claim that any change has landed outside the Icarus-private
worktree.

## Consequences

Operators open one room per run and see the complete guarded story — scope,
base, plan, approvals, PatchSet, verification, review, checkpoint, recovery,
and terminal outcome — with provenance labels and receipts instead of
tab-hopping across status, history, and verification surfaces. The five
deterministic answers cover the blocking, change, verification, readiness,
and rollback questions with citations.

The cost is a second derived-read code path per run, which the bounded
response shapes, fixed card set, fail-closed projection, and replay tests
keep small, plus one additive migration, which follows the established
operator-approved framework and is covered by refusal, invalid-token,
shape-validation, and round-trip tests. Richer questions, live updates,
browser-side annotation authoring, and any assistant summarization remain
separately justified future work. ADR 0025's residual third-party-review and
secret-rotation holds remain independent and unchanged.
