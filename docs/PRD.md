# Product requirements

## Product statement

Icarus is a private, local-first software factory for one operator. It turns a
task into an auditable sequence of context, plan, approval, isolated change,
verification, review, and landing or rollback. Ambitious capability is bounded
by an explicit "sun ceiling" and human decisions.

## First user

Kevin operates multiple Git repositories, local hosts, and explicitly configured
local or cloud model endpoints. Milestone 1 and the first M3 workspace slice run
on one operator-controlled machine. They do not depend on Mickey, Flow,
Highwind, Zenbook, Mise, Athena, KleeOS, Chronos, Odysseus, or any production,
homelab, account, or telemetry service. Fleet control and workers remain future
distributed-execution concerns.

## Milestone 1 job to be done

Given a clean local Git repository and one selected tracked text file, Kevin can
ask a configured model to plan one exact replacement. Before Icarus creates a
private workspace, requests edit bytes, or mutates code, he can inspect and
digest-approve the plan. Icarus applies the later edit proposal in a private
detached worktree, runs only checks Kevin registered
inside a no-network sandbox, records evidence, and leaves the source checkout
untouched. Kevin can approve the result, reject it, resume an interrupted stage,
roll it back, or restore the recorded checkpoint.

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
   target, provider/model, checks, sandbox, ceilings, and policy version.
8. Stop in `awaiting_approval`; no private cache, worktree, edit call, or code
   mutation may precede matching plan approval. Durable database/context
   artifacts are required before this gate.
9. Revalidate the source identity, clean HEAD, and base ref, then atomically
   record the approving actor, timestamp, and exact digest.
10. Copy the pinned repository into an Icarus-private Git cache without hardlinks
    and create a detached worktree from that cache.
11. Ask the approved provider for one typed exact replacement against the target
    path and preimage hash.
12. Reject absolute paths, traversal, symlink/hardlink targets, protected paths,
    binaries, non-unique matches, creates/deletes/mode changes, stale hashes, and
    proposals over the configured byte ceiling.
13. Apply the replacement atomically from a private temporary outside the Git
    worktree, so an interrupted pre-rename write cannot add an unreviewed path.
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
17. Stop in `awaiting_review`; failed checks remain reviewable but cannot be
    accepted. Completion requires a second human decision, passing checks, and
    a fresh match between live worktree bytes/path set/diff and the reviewed
    evidence.
18. Support status/history, explicit retry after a recoverable interruption,
    rollback, checkpoint restoration, and persisted cancellation recovery.
19. Support one real local adapter (Ollama HTTP) and one real cloud adapter
    (OpenAI Responses HTTP) without persisting credentials.

## First M3 local-workspace slice

The first browser path is intentionally narrower than the guarded CLI lifecycle:

1. A Node API persists repository/project records in the existing SQLite state
   root and serves a React workspace from the same fixed `127.0.0.1` origin.
   Host and Origin values are loopback-only, mutation bodies are bounded JSON,
   and the server grants no CORS access.
2. Import records an existing local Git repository but does not modify its
   content, refs, config, index, or worktree metadata.
3. Context preview is deterministic metadata over one committed tree and target.
   It returns paths, reasons, sizes, digests, counts, and warnings, never file
   contents. All `.env*` paths, dependency/generated directories, binary or
   invalid UTF-8 data, model-hidden paths, and secret-shaped content are omitted.
4. Submitting a task first persists a `preparing` draft without context, provider
   work, cache creation, worktree creation, or source mutation. Planning is a
   separate request and accepts only an explicitly configured loopback Ollama
   endpoint. Registration, context preview, draft persistence, and loopback
   planning support Linux, macOS, and Windows. An atomic SQLite started-operation
   admission prevents concurrent planning work for the same run on every
   platform.
5. The workspace presents the exact internal state and derives only these product
   phases: `draft`, `planned`, `awaiting_approval`, `running`, `completed`,
   `failed`, and `cancelled`. The mapping never turns an approval, recovery, or
   failed state into success.
6. Allowlisted responses expose the plan, any edit action that actually exists,
   involved/changed files, verification, checks, bounded/redacted output,
   warnings, approvals, usage, failures, and timestamps without
   returning raw context/source blobs or private cache/worktree paths. Explicit
   diff/check output remains bounded and redacted. An absent check is `not_run`;
   missing provider/execution capability is `unconfigured`.
7. The browser has no approval, edit, check-execution, arbitrary-shell, commit,
   push, deployment, account, telemetry, cloud-control, or fleet-control route.
   Guarded approval and execution remain Linux CLI-only under the kernel lease;
   execution also remains inside the Docker sandbox boundary.

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
   lifecycle and ADR 0010 hold remain unchanged.

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
   portable read-only support and the unresolved ADR 0010 hold.

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
   Preserve the unresolved ADR 0010 hold.

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
    authority. Preserve ADR 0010.

## Candidate sixth and seventh M3 selected-run presentation slices

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

## Candidate eighth M3 bounded project-catalog and transport slice

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
   release authority. Preserve ADR 0010.

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
- The HTTP/UI shell, repository import, context preview, draft persistence, and
  loopback planning support Linux, macOS, and Windows. Planning is read-only
  with respect to the imported checkout, and SQLite atomically admits one
  started operation per run before provider work.
- Approval and execution are supported only on Linux because they inherit the
  kernel lease through `/usr/bin/flock` and `/proc`; execution also inherits
  the Docker sandbox requirements.

## Explicit non-goals

Public signup, billing, teams, browser-held provider keys, Kubernetes, semantic
retrieval, arbitrary commands, creates/deletes, binary patches, commits, pushes,
deployments, application previews, remote API exposure, database migrations,
customer data, production access, backend-as-a-service primitives, distributed
execution, accounts, and telemetry.

## Preserved future contracts

Later milestones retain these product requirements without implying that they
exist in Milestone 1:

- Context intelligence will add project skills, language/framework detection,
  `rg`-based search, syntax/LSP signals, semantic retrieval, project memory,
  file-and-line provenance, and measured context-budget fixtures.
- The first local-workspace slice exposes persisted projects, context metadata,
  task drafts, loopback planning, run state, and allowlisted evidence. The
  accepted second- and third-slice designs add only the bounded observation and
  metadata-only older-activity contracts above. Later M3 slices may add sessions,
  current file/status plus multi-file and payload-bearing diff/history
  navigation, application previews, approvals, checkpoints, prompt history, and
  token/cost telemetry without placing provider keys in a browser.
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
- The workspace API rejects non-loopback Host/Origin requests, oversized or
  malformed mutations, and remote planning endpoints without mutating state.
  Malformed provider URLs and missing repositories return useful
  `INVALID_PROVIDER_URL` and `INVALID_REPOSITORY` errors without persistence.
- Context preview is deterministic for one commit and target, returns metadata
  rather than source contents, and omits every prohibited path/content class.
- A task draft survives process restart before planning, and unavailable
  providers/execution or absent checks are never presented as completion or pass.
- Project import, context preview, draft, and planning leave the source checkout
  content and Git metadata unchanged.
- A production-asset smoke drives the golden path in real Chromium through a
  draft reload, planning, and truthful evidence.
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
