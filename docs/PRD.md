# Product requirements

## Product statement

Icarus is a private, local-first software factory for one operator. It turns a
task into an auditable sequence of context, plan, approval, isolated change,
verification, review, and landing or rollback. Ambitious capability is bounded
by an explicit "sun ceiling" and human decisions.

The accepted product direction in ADR 0036 is to compete for the
task-to-running-application outcome served by Cursor/VS Code, Replit, and
Supabase while owning a different center of gravity: proof-carrying authority,
execution, evidence, and recovery. Icarus will expose that kernel through a
browser and VS Code extension, land changes through isolated create-only
branches and draft pull requests with explicit reconciliation, orchestrate
bounded preview environments, and drive isolated Supabase change packs. It
will not reimplement an editor engine, Postgres, Auth, Storage, or Realtime.

## First user

Kevin operates multiple Git repositories, local hosts, and explicitly configured
local or cloud model endpoints. Milestone 1 and the first M3 workspace slice run
on one operator-controlled machine. They do not depend on Mickey, Flow,
Highwind, Zenbook, Mise, Athena, KleeOS, Chronos, Odysseus, or any production,
homelab, account, or telemetry service. Fleet control and workers remain future
distributed-execution concerns.

## Milestone 1 job to be done

Given a clean local Git repository and a selected set of candidate paths, Kevin
can ask a configured model to plan a patch set across the subset it intends to
change. Before Icarus creates a private workspace, requests edit bytes, or
mutates code, he can inspect and digest-approve the plan, whose digest binds the
approved target set. Icarus applies the later patch set in a private detached
worktree as one unit, runs only checks Kevin registered inside a no-network
sandbox, records evidence, and leaves the source checkout untouched. Kevin can
approve the result, reject it, resume an interrupted stage, roll it back, or
restore the recorded checkpoint.

The initial approved execution remains one strict provider patch-set attempt.
When its registered checks fail, a plan with explicit capability grants and a
positive `iterationCeiling` may enter the bounded session loop (ADR 0026).
Within at most two charged turns the provider may use only the closed,
grant-checked read, patch-set, registered-check, done, and human-input tools.
An `iterationCeiling` of zero remains single-shot. Exhaustion or a human-input
request lands reviewable evidence with a blocker and cannot be approved;
completion still requires current passing full-plan checks and human review.

Patch sets may modify existing tracked UTF-8 text files, create paths that do
not exist, and delete paths that do (ADR 0023). Rename is expressed as a delete
plus a create. Every path is validated independently against the protected-path
policy, and the number of changed files is bounded by the project ceiling.

## Functional requirements

1. Before creating or opening the requested state root, reject any lexical or
   canonical path inside a Git checkout and reject containment between state
   and the repository. Then register the canonical local Git repository and
   create an Icarus project.
2. Persist project checks, sandbox limits, and run ceilings. Milestone 1 path,
   network, shell, and approval policy is fixed host policy, not project data.
3. Start a run with a task, existing tracked target, provider, model, and bounded
   ceiling; pin a clean committed base tree.
4. Map the pinned Git tree and, before a context artifact, provider egress,
   private cache, or worktree exists, audit the complete tracked tree within
   fixed file/aggregate bounds. Ignored and uncommitted files never enter context.
5. Load only root/target-ancestor rules with byte limits and provenance.
6. For non-loopback providers, stop before context egress and bind approval to
   the exact context manifest digest.
7. Generate and persist a concise plan whose digest includes base, context,
   targets, the resolved readable-manifest digest, explicit capability grants,
   provider/model, checks, sandbox, ceilings, and policy version.
8. Stop in `awaiting_approval`; no private cache, worktree, edit call, or code
   mutation may precede matching plan approval. Durable database/context
   artifacts are required before this gate.
9. Revalidate the source identity, clean HEAD, and base ref, then atomically
   record the approving actor, timestamp, and exact digest.
10. Copy the pinned repository into an Icarus-private Git cache without hardlinks
    and create a detached worktree from that cache.
11. Ask the approved provider for one strict transactional patch set over a
    subset of approved targets. If its formal verification fails, admit only
    plan-granted session turns and closed tool calls within the remaining run
    ceilings.
12. Reject absolute paths, traversal, symlink/hardlink targets, protected paths,
    binaries, non-unique replacements, stale preimage hashes, mode changes, and
    patch sets over configured file/replacement/byte ceilings. Create and delete
    are explicit patch-set operations; rename is delete plus create.
13. Persist patch/checkpoint intent before materialization, then apply every file
    through guarded private temporaries outside the Git worktree. In a session,
    `propose_patch` is advisory preview/validation only and persists no authority
    or patch/checkpoint effects on success, failure, or cancellation;
    `apply_patchset` carries and independently revalidates its own exact bounded
    PatchSet before persisting intent. Repair replacement intent is accepted only
    inside that active mutation operation; a new repair checkpoint is bound to
    mutation or reconciliation. A partially failed set compensates already
    applied paths and fails closed.
14. Run only exact project checks inside a digest-pinned, no-network, read-only
    Docker sandbox with no capabilities, no host secrets, a timeout,
    cancellation, resource limits, and bounded/redacted output. A timed-out or
    cancelled command cannot pass merely by trapping the signal and exiting
    zero. Never fall back to host execution.
15. Verify the changed-file set equals the approved target and stays under the
    file ceiling.
16. Persist diff, check evidence, provider usage, state transitions, and a
    restorable checkpoint. Retain every completed bounded verification and its
    diff in append-only history even when the latest run snapshot is replaced;
    interrupted intervals retain only their explicit lifecycle transitions.
    A tool operation's finish and any verification/session-terminal evidence it
    produces must commit atomically.
17. Stop in `awaiting_review`; failed checks and session human-input/exhaustion
    blockers remain reviewable but cannot be accepted. Completion requires a
    second human decision, current passing full-plan checks, no current blocker,
    and a fresh match between live worktree bytes/path set/diff/checkpoint and
    the reviewed evidence.
18. Support status/history, explicit retry after a recoverable interruption,
    rollback, checkpoint restoration, and persisted cancellation recovery.
    Interrupted provider/tool operations stay charged; session resume reconciles
    the private checkpoint and reuses only completed-boundary evidence. An apply
    interrupted after intent persistence resumes from that persisted intent with
    `unavailable`, non-approvable verification. Every session verification is the
    immediate successor of its producing operation; apply and reconciliation can
    never claim passing checks, which only `run_checks` may establish. Finish
    `review.validate`, rollback, and restore operations in the same transaction
    as their corresponding state transition.
19. Support one real local adapter (Ollama HTTP) and one real cloud adapter
    (OpenAI Responses HTTP) without persisting credentials.

## First M3 local-workspace slice

The first browser path is intentionally narrower than the guarded CLI lifecycle:

1. A Node API persists repository/project records in the existing SQLite state
   root. Under accepted ADR 0040, its default ephemeral start binds and verifies
   exact IPv4 `127.0.0.1`, then creates a CSPRNG-selected 16-byte lowercase-hex
   `.localhost` public-origin nonce and an independent 32-byte bearer in the
   launch fragment. It performs no Node/operating-system lookup, hosts-file edit,
   or browser resolver injection. The client removes that fragment before render
   and retains it only in `sessionStorage`. Every non-GET/HEAD request requires
   exact same-origin session headers before a bounded,
   duplicate-member-rejecting JSON body is read; GETs and HEADs are tokenless
   and no CORS access is granted. An explicitly
   configured `127.0.0.1` port is GET-only and emits no bearer. Mutation support
   is limited to real-accepted Chromium-family browsers; Safari and every
   unverified browser use the explicit-port review-only mode. The server cannot
   detect or automatically downgrade a browser that never resolves the random
   `.localhost` hostname.
2. Import records an existing local Git repository but does not modify its
   content, refs, config, index, or worktree metadata.
3. Context preview is deterministic metadata over one committed tree and target.
   It returns paths, reasons, sizes, digests, counts, and warnings, never file
   contents. All `.env*` paths, dependency/generated directories, binary or
   invalid UTF-8 data, model-hidden paths, and secret-shaped content are omitted.
4. Submitting a task first persists a `preparing` draft without context, provider
   work, cache creation, worktree creation, or source mutation. Planning is a
   separate request and accepts only an explicitly configured loopback Ollama
   endpoint. The server and review-only UI support Linux, macOS, and Windows.
   Mutation-capable registration, context preview, draft persistence, and
   loopback planning require a supported Chromium-family browser. ADR 0040's
   exact-head technical gate passed at
   `eb01b6406c12126c60add7ac83800f8eba8ffdc9` in Linux CI `30618041483` and
   native real-Chrome run `30618043377`; explicit human acceptance of the
   interim operator-controlled browser/resolver/proxy residual risk was recorded
   on 2026-07-31. Remaining Gate 1 runtime slices still gate release. An atomic
   SQLite started-operation admission prevents concurrent planning work for the
   same run on every platform.
5. The workspace presents the exact internal state and derives only these product
   phases: `draft`, `planned`, `awaiting_approval`, `running`, `completed`,
   `failed`, and `cancelled`. The mapping never turns an approval, recovery, or
   failed state into success.
6. Allowlisted responses expose the plan, any edit action that actually exists,
   involved/changed files, verification, checks, bounded/redacted output,
   warnings, approvals, usage, failures, and timestamps without
   returning raw context/source blobs or private cache/worktree paths. Explicit
   diff/check output remains bounded and redacted. An absent check is `not_run`;
   missing provider capability is `unconfigured`; execution is `unconfigured`
   on Linux and `unsupported` elsewhere.
7. This original route set has no approval, edit, check-execution,
   arbitrary-shell, commit, push, deployment, account, telemetry, cloud-control,
   or fleet-control route. Packet 2 below adds only the closed guarded lifecycle
   actions; execution remains under the Linux kernel lease and existing Docker
   sandbox boundary.

## Gate 1 Packet 2 guarded action slice

Packet 2 narrows browser mutation to the existing governed lifecycle rather than
adding general execution authority:

1. The server derives every action from one SQLite authority transaction over
   the exact run, event revision, approval/checkpoint/readable-manifest evidence,
   and current active coordinator binding. The browser cannot invent a kind,
   state, digest, parent, actor, or consequence.
2. The closed action set is egress approval, plan approval, review accept/reject,
   rollback, restore, resume, and cancellation. A fresh action UUID plus the
   complete immutable descriptor is confirmed and submitted once; the response
   and recovery read expose only the bounded receipt fields.
3. Linux execution acquires one run lease, persists prepare and admission before
   dispatch, and settles only at an exact action-linked event or operation
   boundary. A stale descriptor is refused without an effect. An already
   admitted same-ID request is reconciled and never dispatched again.
4. Parent-bound cancellation is the only lease carve-out. It must match the
   admitted non-cancellation parent action ID, descriptor digest, kind, current
   coordinator generation, and process-local context before one structured abort
   signal may propagate. Socket disconnect alone is not cancellation.
5. Startup under the Linux lease marks started operations interrupted, refuses
   orphaned prepared requests, and reconciles admitted requests from durable
   evidence. Missing or ambiguous evidence becomes `reconciliation_required`
   rather than replay.
6. Non-Linux authority contains no guarded actions, and execution fails before
   intent persistence. [PR #22](https://github.com/Ayyitskevin/Icarus/pull/22)
   candidate `701952349e0818cead37672df951ed09c0edd27c` passed hosted run
   `30760607215` and native macOS/Windows run `30760619650`, then rebase-merged
   as `ba38856a0e0e63d1045500185b2158a0859469d1`. A post-merge macOS smoke
   exposed a timing-only acceptance-harness defect. The corrected Packet 2
   implementation head `3683087066efb65255f05b2493fd31051c3ad7c6`, published
   on `main`, passed hosted run `30761189188` and native run `30761192370`. The
   guarded CLI remains the full-fidelity fallback, not an alternate source of
   browser authority.
7. These actions reuse existing private-worktree, provider, checkpoint, and
   sandbox operations. They add no commit, push, Git-ref, pull-request, merge,
   deployment, or imported source-checkout mutation authority. Gate 1 remains
   incomplete, and live landing evidence is a separate human-approved slice.

## Second M3 read-only observation slice

ADR 0015 implements this bounded observation contract:

1. Observe one persisted project's repository without changing or persisting
   repository, project, run, or event state. Present independent availability,
   worktree, HEAD, branch, and configured-base-relation fields.
2. Missing repositories, identity mismatches, unresolved refs, and observation
   errors remain explicit in their relevant fields and never masquerade as a
   clean worktree. Detached HEAD is represented as `branch: null` while worktree
   cleanliness remains independently truthful. Omit dirty filenames and counts,
   file content, repository/private runtime paths, and raw Git output.
3. Expose one read-only event metadata endpoint for the selected run. Return a
   sequence-ordered page strictly after the supplied cursor under one fixed
   service-owned maximum. Each item contains only sequence, type, a
   host-controlled label, timestamp, and a fixed host-generated evidence-section
   identifier; event payloads never cross the API.
4. Build each full run response—run, the newest 12 validated approval decisions,
   and the 200 most recent timeline metadata rows—from one coherent SQLite read
   snapshot. Include explicit approval coverage plus the append-only event
   sequence high-water mark as the event cursor and total. Event metadata pages
   remain separate requests; complete approvals and payload-bearing history
   remain CLI-only contracts. If a retained suffix cannot establish an earlier
   prerequisite, present truncation or `unknown` with CLI guidance rather than
   inventing completeness.
5. Short-poll only the selected run while the document is visible. Keep one
   current request, pause while hidden, abort on selection change or unmount,
   apply bounded failure backoff with success reset, and reject late responses
   through a selection/request revision guard. Accept a full run response only
   when its event cursor is at least the newest event revision already observed.
6. Link live updates only to a closed set of fixed, Icarus-generated evidence
   anchors. Never derive fragment identifiers or navigation targets from
   repository, provider, event, or check text.
7. Add no Server-Sent Events, WebSocket, filesystem watcher, schema migration,
   runtime dependency, background daemon, approval, mutation, execution,
   arbitrary-command, commit, push, or deployment authority. The guarded CLI
   lifecycle and ADR 0025's residual third-party review/secret-rotation holds
   remain unchanged.

## Third M3 bounded older-activity slice

ADR 0016 defines this metadata-only navigation contract:

1. Add one selected-run GET route that returns at most 64 event metadata rows
   strictly before a required exclusive sequence cursor and at or below a
   required pinned revision. Both values are canonical positive safe integers;
   the client cannot choose a limit, fields, sort, filter, or search expression.
2. Read only sequence, run ID, type, and timestamp through the existing
   `(run_id, sequence)` index with descending `LIMIT 65`, then present the retained
   rows in ascending order. Never select or decode event payloads.
3. Keep the existing forward live cursor independent. Opening older activity is
   explicit, pauses and aborts live polling, and pins the first page to the
   coherent selected-run response. Closing the panel resumes live observation.
4. Keep one historical request current; abort on document hiding, close,
   selection change, or unmount; reject mismatched or late run/cursor/revision
   responses; and preserve the last successful page on failure.
5. Replace pages instead of accumulating them. Allow at most four historical
   pages per panel session while retaining one 64-row page plus at most three
   newer-page cursors; direct the operator to complete CLI history outside that
   window.
6. Return only sequence, bounded type, host-controlled label, bounded timestamp,
   and fixed host-generated evidence-section metadata. Historical entries do not
   expose payloads or claim that current evidence is a historical snapshot.
7. Add no schema/migration, dependency, write, event append, Git/source read,
   filename/content/diff/check disclosure, stream, watcher, daemon, browser
   approval, execution, command, commit, push, or deployment authority. Preserve
   portable read-only support and ADR 0025's residual release holds.

## Fourth M3 bounded workspace-run slice

ADR 0017 defines this summary-only navigation contract:

1. Replace the unbounded full-run collection in the workspace bootstrap with one
   fixed 12-row summary page. Add a GET run-page route that either opens a new
   session or accepts exactly one canonical positive `before` and one canonical
   nonnegative `snapshot`; expose no caller-controlled limit, project filter,
   sort, or search.
2. Pin membership to the current maximum safe SQLite rowid and query the
   intrinsic rowid B-tree in descending insertion order with `LIMIT 13`.
   Retain 12 rows, derive the next exclusive cursor from the oldest retained row,
   use the request cursor itself when the page is empty, and fail closed on
   invalid, unsafe, or detectably missing cursor anchors. External rewrites that
   leave numeric anchors present remain out of scope and require a new session.
3. Return only run/project IDs, bounded task and target text, exact state,
   host-derived phase, and bounded canonical timestamps. Never select or decode
   provider, context, plan, edit, diff, verification, error, usage, approval, or
   event columns for a summary page.
4. Fetch the existing full selected-run view only after an operator chooses a
   summary. The page snapshot pins membership, not state; state and update time
   remain current when the page is read.
5. Replace pages instead of accumulating them. Allow one 12-row page plus at most
   three newer cursors, preserve the last successful page on failure, use strict
   single-flight lifecycle cancellation and stale-response guards, and direct the
   operator to CLI run listing beyond the four-page window.
6. Label page size and project matches truthfully rather than presenting either
   as a total. Keep selected-run live/history cursors independent from workspace
   summary cursors.
7. Add no schema/migration, dependency, write, event append, deletion, database
   maintenance, Git/source read, new disclosure class, stream, watcher, daemon,
   browser approval, execution, command, commit, push, or deployment authority.
   Preserve ADR 0025's residual release holds.

## Implemented fifth M3 bounded verification-attempt slice

ADR 0018 is implemented by this bounded product slice. Its continuing contract
is to:

1. Add one lazy selected-run GET route requiring exactly one canonical positive
   event snapshot and no caller-selected limit, filter, sort, search, or
   pagination.
2. Select only safe run-state fields in one read transaction, require the
   snapshot to equal the current event revision, and inspect only the latest
   contiguous suffix of up to 200 event sequences.
3. Derive verification-state intervals only from validated transitions. Retain
   the newest eight anchors, return them chronologically, and distinguish
   completed, cancelled, incomplete-failed, open, and outside-coverage starts.
   Do not infer timeouts, process identity, rollback cause, or supersession.
4. Before SQLite scalar extraction, require TEXT storage and byte-measure payload
   values with direct-column `octet_length(payload_json)`: at most 8 MiB per
   retained completion, 16 KiB per selected lifecycle transition, and 1 KiB for
   an observed checkpoint-save event.
   Require strict RFC-8259 JSON, exactly-once selected keys, expected scalar
   types, fixed transitions, outcome
   agreement, and digest agreement; leave unrelated payloads unread.
5. Select only expected checkpoint run ID, canonical digest, and bounded
   canonical timestamp. Never select either private byte snapshot. A completed
   attempt may report only recorded digest agreement; incomplete intervals may
   report only run-checkpoint availability. Never claim a fresh byte rehash.
6. Return only run/snapshot/coverage constants, host-validated interval states,
   SHA-256 digests, event sequences, canonical timestamps, fixed provenance
   statuses, and truncation flags. Exclude raw JSON, diff, checks, argv, output,
   paths, errors, approvals, actors, usage, and totals.
7. Keep current verification visible above an explicit inline panel showing its
   pinned revision, inspected sequence range, limits, summary count, and both
   truncation states. Empty and partial states must not imply passing or
   current-run completeness.
8. Keep the loaded panel pinned while automatic live reconciliation continues;
   mark it stale after the run advances. Each explicit load/refresh/retry captures
   the current run cursor. A conflict requires operator-triggered persisted-run
   refresh and never replays the failed snapshot.
9. Allow one attempt request and abort/invalidate it on hidden document,
   attempt-panel Close, operator refresh, older-activity opening, or unmount;
   selected-run/project changes and Back use one aggregate parent callback.
   Attempt Close/refresh must not cancel history, and older activity must abort
   the attempt before launching its request. Require exact-key and relational
   validation with coverage/event counts bounded by 200, at most eight attempts,
   fixed status/provenance enums, retained last success, late-response rejection,
   and an enabled focus fallback when older activity disables launch.
10. Add no schema/migration, dependency, write, event append, checkpoint
    creation/rehash, Git/source read, private content disclosure, total count,
    older-attempt navigation, stream, watcher, daemon, browser approval,
    rerun/restore/execution, command, commit, push, deployment, or workflow
    authority. Preserve ADR 0025's residual release holds.

## Implemented sixth and seventh M3 selected-run presentation slices

ADR 0019 bounds ordinary approval provenance to the newest 12 validated rows
with explicit coverage and complete-history CLI guidance. ADR 0020 independently
improves review of the already persisted one-file verification diff:

1. Derive diff review only from the selected run's coherent persisted snapshot;
   add no endpoint, query, Git/source read, provider call, or poller.
2. Return exact absent, available, or outside-browser-bound metadata. Preserve
   complete raw text only when it is at most 262,144 UTF-8 bytes; never return a
   partial patch.
3. Require paired diff/verification presence, project diff-ceiling compliance,
   canonical digest, exactly one recorded target, exact displayed-text rehash,
   one patch header, and at least one hunk/change before claiming statistics.
4. Place exact persisted run state, latest verification outcome, path, bytes,
   physical patch lines, additions, deletions, hunks, digest, and provenance in
   one focusable browser section. State that no current repository read occurs.
5. Render complete patch bytes in one bounded-height React text node. HTML-like
   content stays text; oversized evidence receives metadata and CLI guidance,
   not a truncated preview.
6. Keep browser approval, review decisions, mutation, execution, commands,
   commit, push, deployment, current file/status, multi-file diff, raw history,
   and payload navigation outside this slice.

## Implemented eighth M3 bounded project-catalog and transport slice

ADR 0021 closes the remaining unbounded workspace catalog/transport path:

1. Replace workspace `projects` with a newest-first `projectPage` of at most 12
   joined project/repository presentations and add strict pinned continuation
   reads at `GET /api/projects?before=&snapshot=`.
2. Use one `LIMIT 13` intrinsic-rowid range query joined through the repository
   primary key. Decode no per-project or per-repository follow-up query.
3. Gate selected persisted text and strict JSON by storage class and bytes in
   SQL before parsing: 1 MiB checks, 16 KiB sandbox/ceiling, and smaller fixed
   identity/path/ref/timestamp limits. Enforce the JSON bounds on new writes.
4. Replace project pages in the browser, retain at most four page positions,
   validate exact nested shapes, reject stale responses, preserve the last
   success/retry, and abort on refresh, hiding, selection, or unmount.
5. Preserve selected/new-project behavior: a selected record can remain visible
   outside the current page, and successful creation selects it before opening
   a fresh newest-page session. Complete listing remains available through
   `icarus project list`.
6. Replace project-name, repository-name, and run-project collection scans with
   exact indexed lookups.
7. Serialize every API JSON response before headers and reject more than 8 MiB
   UTF-8, including the trailing newline, with a fixed safe
   `RESPONSE_TOO_LARGE` error. Never return partial JSON or rejected content.
8. Add no schema/migration, dependency, deletion, Git/source read, provider
   call, browser approval/execution, command, commit, push, deployment, or
   release authority. Preserve ADR 0025's residual release holds.

These merged read-only observation slices do not complete M3, close ADR 0025's
residual release work, establish native acceptance, or add browser action
authority.

## Sixth M3 change-room slice

ADR 0041 is implemented by this bounded product slice. Its continuing contract
is to:

1. Project each run as a strict read-only Change Room whose `roomId` is the run
   ID, derived in one SQLite read transaction from the run row, approvals, the
   200-event metadata tail, safe checkpoint columns, project check/sandbox
   configuration, and CLI annotations. Add no room table, event bus, or parallel
   state machine, and return a byte-identical projection on restart replay.
2. Present exactly eleven evidence cards in fixed lifecycle order, from task
   scope through terminal state. Each card carries a host-controlled title, one
   of six provenance classes, an explicit
   `available`/`pending`/`not_applicable`/`unavailable` status, bounded
   references (event sequences, approval digests, plan/context/diff/checkpoint
   digests), a bounded body, and `truncated`/`redacted`/`unavailableEvidence`
   indicators. Card bodies reuse only the disclosure classes the existing
   full-run presenter already crosses; baseline/approved checkpoint bytes,
   private cache/worktree/artifact paths, event payloads, raw provider prompts,
   and source blobs are never selected. State in the integrity block that
   digests prove byte binding and recorded-evidence integrity only — never fresh
   authorization or semantic correctness; label the provider plan an untrusted
   proposal; note that the checkpoint digest is a recorded byte binding, not a
   fresh rehash.
3. Serve a bounded change-room index under the ADR 0017 rowid discipline: one
   pinned `MAX(rowid)` snapshot, descending `LIMIT 13`, twelve retained
   summaries, an ephemeral exclusive cursor, and fail-closed cursor validation.
   Summaries expose only IDs, bounded task/target text, exact state,
   host-derived phase, latest verification outcome, provider
   kind/model/locality/privacy class, host-derived terminal reason, and
   timestamps. Project provider/verification JSON in SQL only behind
   typeof/octet-length preflight and strict JSON validity; fail the page closed
   as database corruption otherwise.
4. Answer exactly five fixed change-context questions (`why_blocked`,
   `what_changed`, `what_passed`, `what_remains_before_review`,
   `why_rolled_back`) and reject any other question shape. Return a deterministic
   host projection of at most eight component statements, each a host-controlled
   template over bounded facts carrying receipts (evidence-card IDs, event
   sequences, digests), plus explicit omission and uncertainty lists. Involve no
   LLM, provider, network, or external tool. State in a completed run's
   `what_changed` that nothing was committed, pushed, merged, or deployed.
5. Accept annotations only through the CLI (`run annotate` / `run annotations`).
   Validate before any write: run existence, a closed card enum (the eleven card
   kinds or `room`), the approval-actor rules, and a non-blank body of at most
   1 KiB without NUL bytes; reject recognizable credential material in actor or
   body before write; cap annotations at 32 per run. Keep them append-only with
   no update or delete path and no authority: they never append lifecycle
   events, advance event cursors, change run state, satisfy gates, or feed
   digests, approvals, verification, or execution. Show them in the browser only
   as read-only text inside the room projection; provide no browser annotation
   route.
6. Keep the Change Rooms routes browser-read-only. All three new routes are
   GET-only and add no action control; Packet 2's separately accepted guarded
   action routes remain outside the Change Room contract. Non-GET
   verbs are refused by the ADR 0029 action-session boundary (401 without it, 404 behind it), unknown runs receive 404, invalid query contracts receive
   422, and GET reads perform no durable writes. The React Change Rooms section
   pages its index explicitly (12-row replace-not-accumulate pages, at most a
   four-page window, no polling), pins the room's event revision, and offers the
   five fixed explain questions.
7. Keep the annotation schema additive and operator-gated: the only change is
   the `run_annotations` table in `ICARUS_ANNOTATION_SCHEMA`, applied
   idempotently on every open so fresh databases always have it. A database
   with `runs` but no table is refused with `DATABASE_MIGRATION_REQUIRED`
   until the operator backs up and reruns with exactly
   `ICARUS_APPROVE_SCHEMA_MIGRATION=run-annotations-v1`; one token approves
   exactly one migration, an unrelated token changes nothing, and an invalid
   table shape fails closed as `DATABASE_ERROR`. There is no backfill and no
   existing table or index change.
8. Add no schema beyond `run_annotations`, dependency, browser approval,
   mutation, annotation-authoring, execution, command, commit, push, or
   deployment route, live room polling or streaming, free-text questions, room
   search, annotation edit/delete, LLM/BYOK summarizer, federation, forge,
   Git-hosting, or multi-agent surface, or any claim that a change landed
   outside the Icarus-private worktree. Preserve the unresolved ADR 0010 hold.

## Offline Change Handoff Pack slice

ADR 0042 defines a standalone, operator-exported evidence capsule for a future
Athena Task Room without expanding Icarus authority. Its product contract is to:

1. Build `icarus.change-handoff.v1` directly from validated authoritative
   records through a closed safe-facts projection. Never reuse or serialize
   `icarus.change-room.v1`: the local room may expose bounded task, plan, path,
   diff, command-output, event, and annotation evidence that the external
   artifact must omit.
2. Allow only schema/version; deterministic handoff and opaque run/project IDs;
   a correlation ID and optional opaque external task reference; state and
   host-derived phase; provider kind/model/locality/privacy class; safe egress,
   plan-approval, verification, review, rollback/restoration, and terminal
   statuses; fixed host summaries; bounded counts; schema/version/type/digest-only
   artifact references; one disclosure class; the fixed integrity statement;
   omissions; and bounded uncertainty. The correlation ID is 1–128 ASCII bytes
   matching `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`; the optional task reference
   uses the same alphabet for 1–256 bytes; provider model crosses only when it
   passes the same 1–128-byte safe-token syntax.
3. Never include task text, plan content or grants, repository/context/source/
   changed-path values, PatchSet/checkpoint/diff bytes, check command/argv/output/
   sandbox configuration, annotations/actors, event payloads, local paths, URLs,
   destinations, credentials, headers, research/code artifacts, or any command,
   approval, retry, delivery, tool-call, or execution instruction. Unsafe or
   unrepresentable source evidence fails closed; it is never truncated into an
   apparently safe payload.
4. Make `run handoff-preview` a pure read: no network or credential access and
   no database, temporary snapshot, source, cache, worktree, or artifact write.
   Fingerprint the owned SQLite family, refuse a non-empty WAL rather than omit
   it or open source state with SQLite, query a stable private in-memory image,
   and re-fingerprint around the read. Emit the exact strict canonical JSON line
   that export would write, its complete payload SHA-256, a separate
   request/preview SHA-256 binding every safe source input, and the fixed
   complete omission list.
5. Make `run handoff-export` require that exact preview digest, reread and
   revalidate all bound evidence, and refuse drift before publication. Write
   only `icarus-change-handoff.json` and
   `icarus-change-handoff-result.json` below a current-user-owned,
   non-group/other-writable parent, using owner-only, descriptor-relative,
   no-follow exclusive creation, no overwrite, payload-then-result ordering,
   file/output-directory/parent-entry `fsync`, and descriptor-live
   identity-checked cleanup of only
   this attempt's partial files. Fail before creating output when the host lacks
   the required descriptor-root/no-follow primitives. The result has exactly
   `exportStatus`, `previewSha256`, `outputSchema`, and newline-inclusive
   `payloadSha256`.
6. Keep secure preview, export, verification, and inspection Linux-only and fail
   platform/capability checks before protected file access or output-directory
   creation, without a weaker path-only fallback. Make `handoff verify` and
   `handoff inspect` file-only. They run before
   state-root/runtime setup, reject hostile files, duplicate/unknown members,
   malformed/oversized/deep/noncanonical JSON and invalid hashes, and never open
   SQLite, a repository, credential store, provider, browser server, Git
   controller, or network. Inspection prints only the payload allowlist and
   fixed caveats.
7. Keep the meanings separate: payload and artifact digests bind bytes and
   recorded local evidence only. They do not prove authenticity, fresh
   authorization, semantic correctness, evidence truth, disclosure permission,
   or permission to execute or land code. Operator export is a disclosure act,
   not approval of any Icarus or receiver action.
8. Reserve only a conceptual one-way Athena seam. A later accepted integration
   may map handoff schema, complete handoff digest, Icarus run ID, correlation
   ID, safe lifecycle outcome, and disclosure class into an imported
   `constellation.event.v1` timeline record. No other field maps. This slice
   implements no shared event type, client, receiver, identity/authentication,
   credential, delivery, callback, retry, outbox, Task Room creation, Minerva
   trigger, API/browser/provider/Git/landing/deployment path, or workflow state.
9. Preserve Change Room fixed-card replay, GET-only routes, redaction,
   deterministic model-free answers, append-only annotation non-authority, and
   the truth that no commit, push, merge, or deployment is represented. Prove
   preview purity, default-deny canaries, stale refusal, canonical bytes, hostile
   files, no overwrite/partial cleanup, result hashing, and database-independent
   verification before claiming the slice complete.


## Sun ceiling

Every run records maximum active runtime, provider output tokens, total tokens,
estimated cost, context bytes, changed-file count, file bytes, diff bytes, tool
calls, provider/check timeouts, and persisted/raw process-output bytes. Network
class, container-only execution, and required plan/review approvals are fixed
Milestone 1 host policy. Unknown remote pricing is a hard stop.
The ordinary active-runtime ceiling remains binding for productive work. One
fixed `cancellation.recovery` operation kind may charge at most two 120-second
attempts above ordinary runtime admission solely to land a run safely; the
additional tool calls and runtime remain visible.


## Non-functional requirements

- Single-operator and single-tenant.
- Source checkout content, refs, config, index, and worktree metadata remain
  unchanged; private caches own Icarus worktrees.
- Durable, queryable SQLite state with foreign keys and WAL mode.
- Capability grants remain in approved `plan_json`; operations and events remain
  the session record. This session slice adds no table or live schema migration.
- Crash-safe exact replacement and explicit resume from persisted safe stages.
  An interrupted external operation is charged its full conservative
  reservation before a fresh retry; resume may therefore stop at a ceiling.
- Deterministic tests do not call paid or installed models.
- Secrets are environment-only, and recognizable credential material in
  successful provider output is discarded before proposal persistence.
- Before any context artifact, egress, cache, or worktree, a bounded complete
  tracked-tree audit rejects intrinsically secret paths, content findings, files
  over 16 MiB, or aggregate content over 64 MiB.
- Known credentials and detected spans are redacted with constant markers.
  Non-success provider HTTP response bodies are not surfaced or persisted, and
  transport errors are sanitized before crossing the provider adapter boundary.
- The HTTP server and explicit-port review UI support Linux, macOS, and Windows.
  Mutation-capable repository import, context preview, draft
  persistence, and loopback planning additionally require a supported
  Chromium-family browser. ADR 0040's real-Chrome exact-head macOS and Windows
  composition passed at `eb01b6406c12126c60add7ac83800f8eba8ffdc9`, and
  explicit human acceptance of the interim operator-controlled
  browser/resolver/proxy residual risk was recorded on 2026-07-31. Gate 1's
  remaining runtime slices are incomplete. Planning is read-only with respect
  to the imported checkout, and SQLite atomically admits one started operation
  per run before provider work.
- Approval and execution are supported only on Linux because they inherit the
  kernel lease through `/usr/bin/flock` and `/proc`; execution also inherits
  the Docker sandbox requirements.

## Gate 1 benchmark contract

The current tree carries a populated, closed Gate 1 input manifest at
`fixtures/evals/gate1/manifest.v1.json`. It contains exactly one
TypeScript-library repair, one Python-CLI repair, and one dependency-free
React/Node module repair fixture. The third case checks Node behavior and a
JSX-to-module contract; it is not runnable-React-application evidence. Each case
pins repository and commit identity, the exact task, prompt-revision labels and
production planning/edit system-instruction hashes, the complete ordered
registered-check IDs, names, and argv, exact expected changed paths, Git object
format, raw task/source/approved-repair bytes, and deterministic local-candidate
object identities.

`pnpm benchmark:gate1`, also included by `pnpm eval`, validates that contract
through the production Ollama adapter over deterministic loopback HTTP,
production no-network sandboxes, and the real deterministic local-candidate and
absent-only private-ref foundation. The ignored schema-v1
`.local/gate1-benchmark-report.json` is a closed success/failure union. A success
report binds the exact validated input-manifest digest and all three cases'
observed task, source, provider-instruction, check, and candidate identities. A
failure report preserves only the ordered completed-case prefix and labels its
aggregate counters `partial_completed_cases_only`; it separately binds the
failure stage, applicable next case, safe error code or `null`, and error-message
digest. Its manifest digest is `null` only when the raw manifest bytes were
unavailable. Neither variant can claim Gate 1 completion. For each completed case, the runner
reopens the production runtime and replays a harness-only candidate journal into
a new local controller before the absent-only-ref step. It does not execute
same-tab browser reload or foreground-server process restart and does not prove
durable landing coordination. The separate browser authority contract retains
the current tab-scoped bearer across same-tab reload; a process restart rotates
origin and bearer, requires the new launch URL, and may recover only durable
work.

This focused path has no credential, paid model, external network, remote
mutation, or live migration authority. Every completed-case report record
explicitly marks draft-PR and receipt effects as contract-only and not executed.
The manifest's derivative-effect record is `contract-only-unassessed`, not an
operator assessment of real repository automation. Gate 1 completion still
requires a separate versioned,
human-approved, credential-gated live-evidence profile bound to the offline
manifest digest and its exact immutable case/task/check/source/expected-change/
candidate pins. That profile must additionally pin the real provider/model and
adapter version, pricing and budgets, and an operator-produced repository-
automation assessment with disposition and raw assessment digest. It may
authorize only named, separately approved Git object upload, absent-only remote-
ref creation, draft-PR creation, and receipt effects. Gate 1 requires 3/3 passing
checks, exact changed paths, exact candidate and live branch/commit/draft-PR/
receipt identities, and unchanged source checkouts on the approved repositories.
Mock or synthetic model, GitHub, automation, or receipt evidence cannot complete
the gate.

## Current-slice exclusions and durable non-goals

The current implementation has no public signup, billing, teams, browser-held
provider keys, semantic retrieval, end-to-end landing, remote pushes,
deployments, application previews, remote API exposure, customer-data access,
production access, distributed execution, accounts, telemetry, or arbitrary
provider-native tool path. Packet 2's local guarded lifecycle actions do not
widen Git, landing, deployment, credential, provider-native-tool, or public
authority. Packet 2 is release-accepted at implementation head
`3683087066efb65255f05b2493fd31051c3ad7c6`, which was published on `main` and
passed hosted run `30761189188` plus native run `30761192370`. That acceptance
does not complete Gate 1 or authorize migration, landing/GitHub, deployment,
or public release. No roadmap statement implies that any excluded capability exists now.

ADR 0036 deliberately moves semantic retrieval, browser/VS Code actions, gated
Git landing, previews, deployment adapters, isolated database migrations,
Supabase integration, and distributed workers into later evidence-gated
delivery phases. They are deferred capabilities, not permanent non-goals.

Durable non-goals are browser-held provider credentials, model-authored shell
commands, binary patches, implicit production authority, a proprietary editor
engine, a proprietary Postgres/Auth/Storage/Realtime replacement, and
Kubernetes before measured demand justifies a superseding decision.

## Preserved future contracts

Later milestones retain these product requirements without implying that they
exist in Milestone 1:

- Context intelligence will add project skills, language/framework detection,
  `rg`-based search, syntax/LSP signals, semantic retrieval, project memory,
  file-and-line provenance, and measured context-budget fixtures.
- The first local-workspace slice exposes persisted projects, context metadata,
  task drafts, loopback planning, run state, and allowlisted evidence. The
  accepted second- and third-slice designs add only the bounded observation and
  metadata-only older-activity contracts above. Later M3 slices may add browser
  action sessions, current file/status plus multi-file and payload-bearing
  diff/history navigation, application previews, approvals, checkpoints, prompt
  history, and token/cost telemetry without placing provider keys in a browser.
- Application-factory templates may add an application starter, API layer,
  database, authentication, storage, realtime events, jobs, vector search,
  environment references, local preview, and deployment configuration only as
  demanded by real projects.
- Distributed execution treats Mickey, Flow, Highwind, and Zenbook as separate
  networked nodes with explicit job envelopes, heartbeats, retries,
  cancellation, idempotency, and resource limits. No shared-machine assumption
  is permitted.
- Future local services default to understandable Docker Compose-style
  orchestration. Kubernetes remains out of scope until evidence justifies it.

## Success measures

- A fixture golden path completes in the sandbox with the source checkout and
  source Git metadata unchanged.
- A traversal or symlink proposal is rejected before write.
- A state root inside any Git checkout, or overlapping a repository in either
  direction, is rejected before the requested state root is created.
- A timed-out check is failed even if it handles termination and exits zero.
- A failing provider call leaves a resumable run with an audit event.
- Multiple verification attempts remain independently inspectable in history.
- Rollback restores the baseline bytes; restore recreates the approved bytes.
- Formatting, lint, type checking, unit/integration tests, security checks, and
  fixture validation all pass in CI.
- The evaluation report states unsupported scenarios rather than counting them
  as successes.
- The populated Gate 1 contract fails closed on any changed raw-byte pin and
  keeps synthetic local results distinct from the separately approved real 3/3
  repository evidence required for release.
- The workspace API rejects wrong/duplicated Host, Origin, authorization,
  content-type, or action headers; stable-origin POSTs; oversized, malformed,
  duplicate-member mutations; and remote planning endpoints without mutating
  state. Exact-bind/no-lookup tests prove the socket remains `127.0.0.1` while
  the public origin uses a fresh 16-byte `.localhost` nonce; no injected
  resolver or hosts-file edit is acceptance evidence.
  Malformed provider URLs and missing repositories return useful
  `INVALID_PROVIDER_URL` and `INVALID_REPOSITORY` errors without persistence.
- Context preview is deterministic for one commit and target, returns metadata
  rather than source contents, and omits every prohibited path/content class.
- A task draft survives process restart before planning, and unavailable
  providers/execution or absent checks are never presented as completion or pass.
- Project import, context preview, draft, and planning leave the source checkout
  content and Git metadata unchanged.
- A production-asset smoke drives the golden path in real Chromium through a
  draft reload, planning, and truthful evidence. The required ADR 0040
  composition passed in real Chrome at exact implementation commit
  `eb01b6406c12126c60add7ac83800f8eba8ffdc9` on macOS 15 arm64 and Windows
  Server 2025 x64 in native run `30618043377`. Human acceptance of ADR 0040's
  interim residual risk was recorded on 2026-07-31; neither that acceptance nor
  the technical evidence completes Gate 1. No live migration, merge,
  deployment, or public release was authorized or performed as part of the
  acceptance.
- The HTTP presenter exposes populated, bounded plan, action, file, verification,
  check-output, approval, usage, and timestamp evidence for a completed CLI run
  without exposing private runtime paths.

The second M3 implementation has fresh local evidence for its independent status
fields, nonpersistence and source isolation, fixed event bounds and cursors,
payload omission, transaction-scoped full-run reads, the cross-request
event-revision guard, foreground polling lifecycle, bounded backoff,
stale-response guard, fixed evidence anchors, and unchanged browser authority.
Exact-head hosted CI passed before published acceptance. No separate
cross-process WAL contention stress was added; coherence currently relies on the
explicit better-sqlite3 read transaction plus bounded/corrupt-payload tests.

The third M3 implementation has fresh local and real-browser evidence for its
metadata-only reverse query, fixed 64-row pages, pinned revision, independent
live/history cursors, four-page replacement window, explicit navigation,
single-flight and lifecycle cancellation, late-success rejection, private
payload omission, current-evidence anchors, focus behavior, source isolation,
and zero logical SQLite writes during browsing. Exact implementation-head hosted
CI passed at `e99067c4d21aa5991b9cc49b17a925c0b9b4529a`. The query-plan
regression copies the production SQL literal exactly and therefore retains a
low-severity maintenance drift risk.
