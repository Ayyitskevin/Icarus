# Architecture

## Shape of the first system

Icarus is a pnpm workspace with four packages:

- `@icarus/core`: domain types, state machine, SQLite repositories, context
  assembly and preview, provider ports/adapters, safety policy, Git worktree
  operations, sandbox execution, and the run application service.
- `@icarus/cli`: argument parsing, environment configuration, human approval
  commands, signal cancellation, and text/JSON presentation.
- `@icarus/api`: a fixed-loopback Node HTTP composition layer, bounded request
  contracts, safe response presenters, and same-origin static UI serving.
- `@icarus/workspace`: a React/Vite review surface for projects, deterministic
  context metadata, task drafts, planning, run state, and evidence.

The CLI retains the full guarded lifecycle. The browser packages call the same
application service and add no second state machine or policy authority.

## Dependency direction

```text
CLI ------------------------\
                              -> application service -> injected collaborators
React workspace -> HTTP API/                          |-- SQLite run store
                                                     |-- artifact/Git controllers
                                                     |-- deterministic context
                                                     |-- Ollama/OpenAI/Anthropic/Vulcan adapters
                                                     `-- Docker check runner
```

The domain does not import CLI, HTTP, or React code. HTTP handlers validate and
orchestrate calls; they do not duplicate lifecycle policy. Provider-specific JSON
ends at the adapter. Git and process adapters receive constructed argument
arrays, never shell text. The current service injects concrete `IcarusStore`,
`ArtifactStore`, and `GitController` instances. That is a testable composition
boundary, not a claim that interchangeable storage, artifact, or Git ports
already exist. Extract an interface only when a second implementation or isolated
contract test requires one.

## Local workspace boundary

The production server binds exact IPv4 `127.0.0.1` and serves compiled UI
assets and `/api` from one public origin. Under accepted ADR 0040, an ordinary
start asks the operating system for an ephemeral port, verifies the exact
`127.0.0.1` IPv4 binding, then CSPRNG-selects a 16-byte nonce encoded as 32
lowercase hexadecimal characters. The socket remains
`127.0.0.1:<ephemeral-port>` while the public origin is
`http://<nonce>.localhost:<ephemeral-port>/`. The server does not use Node or
operating-system lookup, a hosts-file edit, or browser resolver injection;
real-accepted Chromium-family browsers resolve the reserved hostname through
their own built-in behavior.

Only after the exact bind succeeds does the server create one independent
fragment-only 32-byte mutation-session bearer. A synchronously bootstrapped
client stores it only in `sessionStorage` and removes the fragment before
render. Every non-`GET`/`HEAD` request requires the exact public Host, Origin,
canonical bearer, JSON content type, and `workspace.mutate` action header before
body parsing or service work. `GET` and `HEAD` requests remain tokenless. An explicitly configured stable
port uses `http://127.0.0.1:<port>/`, emits no bearer, and is strictly
review-only. Bind failures stay loud. The server emits no CORS permission. It
is a foreground local process, not a remotely reachable daemon.

Mutation support is a browser-family release contract, not a `User-Agent`
authorization check. Accepted ADR 0040 supports only Chromium-family versions
covered by real-browser acceptance. Safari and every unverified browser must
use the explicit-port review-only mode; Icarus cannot automatically downgrade a
random `.localhost` navigation that never reaches the server. Exact-head real
Chrome composition passed at implementation commit
`eb01b6406c12126c60add7ac83800f8eba8ffdc9` in Linux CI `30618041483` and
native run `30618043377` on macOS and Windows. Explicit human acceptance of the
interim operator-controlled browser/resolver/proxy residual risk was recorded
on 2026-07-31. That architectural acceptance does not make Gate 1
release-complete. No live migration, merge, deployment, or public release was
authorized or performed as part of the acceptance.

The API projects server-side mutation/planning availability separately from
the client-held session. React combines only those booleans, never the bearer,
and disables protected controls immediately when the server is stable
review-only or the tab session is absent, malformed, or rejected as stale.

The original route set can inspect workspace state, register a
repository/project, preview committed-tree context metadata, persist a task
draft, plan that draft with loopback Ollama, and read a run. Repository import,
preview, draft, and planning do not create a private worktree or modify the
source checkout.

The accepted Gate 1 Packet 2 slice adds exact browser authority descriptors and
bounded receipts for eight existing lifecycle operations: egress approval, plan
approval, review accept/reject, rollback, restore, resume, and cancellation.
Execution is Linux-only, acquires one kernel run lease, persists
prepare/admit/settle boundaries, and revalidates the immutable action tuple
before dispatch. A cancellation of an in-flight browser action is the sole
parent-bound carve-out: it must match the current coordinator generation,
action ID, descriptor digest, kind, and process-local execution context before
one structured abort signal may propagate. These actions use the existing
private-worktree/provider/sandbox lifecycle. They do not commit, push, create or
change Git refs, merge, open a pull request, deploy, or mutate the imported
source checkout.

Process shutdown closes mutation admission synchronously, drains the exact set
of HTTP handlers registered before that boundary, waits for their response
settlement, and only then closes residual sockets and the SQLite runtime. At
Linux startup, started operations are first marked interrupted under the run
lease, orphaned prepared actions are refused, and admitted actions are settled
only from durable terminal evidence; incomplete evidence becomes
`reconciliation_required` and is never replayed. Non-Linux presentations expose
no action buttons and execution fails before intent persistence. Fresh local API
and compiled-product browser acceptance passed on 2026-08-02, including all
eight protected route mappings, stale refusal, receipt recovery, cancellation,
reload, and unchanged-source evidence in Chrome 149. PR #22 candidate
`701952349e0818cead37672df951ed09c0edd27c` passed hosted run `30760607215` and
native run `30760619650`, then rebase-merged as
`ba38856a0e0e63d1045500185b2158a0859469d1`.
After a timing-only smoke-harness correction, implementation head
`3683087066efb65255f05b2493fd31051c3ad7c6` passed hosted run `30761189188` and
native run `30761192370`. That exact-head evidence closes Packet 2. Packet 3
adds a separate Linux-only local landing coordinator over the existing SQLite
landing ledger. Preparation snapshots immutable completed-run evidence and
deterministically constructs the candidate in the private cache; a one-shot
decision binds the reconstructed landing digest; explicit resume creates or
reconciles only the absent private `refs/heads/icarus/<run-id>` ref. Each
coordinator attempt is bounded to ten minutes of active runtime and the ledger
admits at most eight explicit attempts. The shared run lease serializes landing
against rollback, cold startup is inert until explicit resume, and interruption
recovery is derived from durable intent and observation rather than blind
replay. CLI, API, and browser presentation share one bounded projection. The
source checkout remains unchanged and this slice performs no credential lookup,
network request, GitHub effect, migration, merge, or deployment. The bounded
GitHub gateway is now consumed by the durable landing coordinator. ADR 0055 adds
a one-shot headless layer above it: one reviewed completed run per manifest
case, durable-admission effect replay, and all three cases under one exact resume
id. It adds no daemon, queue, plugin path, merge, or deployment. The separately
approved live 3/3 evidence run completed on 2026-08-23 and is recorded in
`docs/evals/2026-08-23-gate1-live-3of3.md`. This closes Gate 1's live-evidence
requirement but does not grant merge, deployment, or unattended
active-repository authority.

The API presenter allowlists product evidence instead of returning `RunRecord`
or history rows. It omits raw context/source blobs and private cache, worktree,
and artifact paths; explicit diff/check output remains bounded and redacted.
Missing verification is `not_run`; unavailable provider or execution capability
is `unconfigured`; neither is inferred as success.

The persisted `preparing` state appears as product phase `draft`. The other
derived phases are `planned`, `awaiting_approval`, `running`, `completed`,
`failed`, and `cancelled`, while the exact internal state remains visible. An
approval/recovery state is never flattened into completion.

The HTTP server and explicit-port review shell support Linux, macOS, and Windows
with no fleet or cloud dependency. Mutation-capable repository import, context
preview, draft persistence, and loopback planning mutations require a supported
Chromium-family browser covered by the acceptance record. ADR 0040's exact-head
native technical gate passed at
`eb01b6406c12126c60add7ac83800f8eba8ffdc9`, and human acceptance of its interim
operator-controlled browser/resolver/proxy residual risk was recorded on
2026-07-31. Remaining Gate 1 runtime slices still gate release. Planning creates
no private worktree and executes no project code. Before each bounded
context/provider operation,
SQLite atomically admits one `started` operation per run; a concurrent planner
receives `RUN_BUSY`.
Approval and execution remain Linux-only and use the stronger kernel lease
through `/usr/bin/flock` and `/proc`; execution checks also require a local
Docker daemon.

## State and feedback

Authoritative control state lives in one SQLite database under `ICARUS_HOME`
(default: the platform-local state directory). The database stores projects,
runs, append-only events, check evidence, provider usage, checkpoints,
browser-action authority, and the landing profiles, decisions, attempts,
operations, observations, results, and events needed through `local_ready`. It
does not store credentials or environment snapshots.

Session authority adds no second persistence model. The approved `plan_json`
and its approval digest are the sole grant source; there is no
`capability_grants` table. Existing admitted operations plus bounded
boundary/terminal events are the sole session source; there is no
`agent_sessions` or `tool_invocations` table. Interrupted operations remain
charged, while only completed boundary events are eligible for evidence
rehydration after restart.

Session entry and every provider or tool admission preserve one
ordinary-operation slot and `commandTimeoutMs` of active runtime for
`session.reconcile`. A hard-margin refusal admits no effect and lands exhaustion
from persisted evidence; a started operation is charged conservatively before
that reserved recovery runs.

Settlement preserves that single source of truth. Effectful
`apply_patchset`/`run_checks` and session-control operation finishes commit
with their verification or session-terminal event in one SQLite transaction;
advisory/read tools settle only their operation. Patch settlement is classified
from both its closed tool discriminator and the intent/checkpoint events emitted
inside that exact active operation, so an applied patch cannot be relabeled as a
proposal. Every `propose_patch` terminal is zero-effect, including failed and
cancelled proposals; only `apply_patchset` may retain bounded partial effects on
failure. A repair replacement intent must originate inside that mutation
operation, and a newly created repair checkpoint must originate there or in
`session.reconcile`. Within a session, every `running` verification is the
immediate successor of its effectful operation: apply, failed/cancelled apply,
and reconciliation may record only `unavailable`; only `run_checks` may
establish passed or failed current check evidence. `review.validate`, rollback,
and restore operation finishes commit with their corresponding state
transition. A crash therefore cannot leave an effectful settled operation
without its boundary or a boundary whose operation still appears started.

The run row retains the latest verification for efficient status reads. Every
completed verification also appends its complete bounded evidence and diff to
the event stream, so restore/reverify does not erase earlier completed evidence.
Interrupted verification intervals retain explicit state transitions, not a
synthetic complete attempt record.

Operator feedback lives in CLI output, allowlisted API views, the React workspace,
and the same durable event/evidence records. Provider and command output is
bounded and redacted before storage; raw domain records are never serialized
directly to the browser.

Before state-root initialization creates or opens the requested directory, it
walks both lexical and canonical ancestors and rejects a `.git` marker. A state
root inside any Git checkout therefore fails before Icarus writes the directory.
POSIX roots additionally require current-user ownership and mode `0700`.
Windows roots must remain strictly beneath the current user profile and inherit
that profile's ACL because POSIX mode bits are unavailable there.
During `repo add`, the CLI also resolves the existing repository and prospective
state path through their nearest existing ancestors and rejects either path
containing the other. The registered source repository is then read-only from
Icarus's perspective and never owns an Icarus worktree. A copied Git cache and
mutable worktree live only below `ICARUS_HOME/runs/<run-id>/`, whose ownership
is proved by generated IDs, path containment, and the persisted run record.
Before any artifact, provider request, cache, or worktree is created,
preparation audits the complete tracked tree directly through bounded Git object
reads. A file larger than 16 MiB, more than 64 MiB of tracked content, an
intrinsically secret path, or recognizable credential content fails closed.


## Explicit run state machine

```text
                         /-> awaiting_egress_approval --approval--\
preparing --atomic split                                         -> planned
                         \--------------------------- local -----/     |
                                                                       v
                                                              awaiting_approval
                                                                       |
                                                                       v
                                                                    running
                                                                       |
                                                                       v
                                                                   verifying
                                                                       |
                                                                       v
                                                             awaiting_review
                                                               /           \
                                                      completed       rolling_back
                                                          |                 |
                                                          +------->     rolled_back
                                                                          |
                                                                      restoring
                                                                          |
                                                                          +--> verifying

cancellable state -> cancelling -> cancelled
failed --explicit resume--> persisted preparing/planned/running/verifying/recovery state
```

Every transition is validated and written with an event in the same database
transaction. Waiting for a human is not active runtime. Planning creates no
worktree and executes no project code. Before its bounded context and provider
work, a SQLite transaction inserts a `started` operation; a partial unique index
permits only one such operation for a run. That admission supplies portable
cross-process exclusion on Linux, macOS, and Windows.

On Linux, planning also nests under the stable kernel lease used by the mutating
lifecycle. Approval and execution require that lease and are not offered on
other platforms. Stable per-run files use `flock(2)` on a retained descriptor,
with descriptor/path inode checks; process death releases exclusion without
pathname cleanup. These leases prevent concurrent cooperative current-version
mutators inside the private state-root boundary; online mixed-version upgrades
and arbitrary same-UID state tampering are outside that guarantee. Resume
re-enters only a persisted safe stage. Exact writes are replay-safe: a retry may
accept baseline or identical approved bytes, but unexpected bytes are preserved
and fail closed.

The ordinary first patch attempt follows `running → verifying`. A failed
verification may take the dedicated, plan-gated `verifying → running` session
edge while iterations and all ordinary budgets remain. Inside that session,
`run_checks` records formal evidence and returns to `running`; only a
host-validated `report_done` may land an approvable `awaiting_review`. A human
question or exhaustion also lands `awaiting_review`, but records a blocker that
review approval must refuse.

The H2b headless entry point is a sibling of ordinary plan approval, not a
second dispatcher. `approveHeadlessPlan` holds the same Linux run lease while
it validates and records the ordinary approval, reconstructs the ADR 0047
binding from SQLite, records `headless.worker.started`, and invokes the existing
execution path. The binding's tighter `SunCeiling` is supplied to service
calculations and every ordinary SQLite operation reservation; SQLite rejects a
supplied ceiling above the persisted project ceiling. Cumulative planning and
approval usage is not reset. The profile's tool set additionally filters the
metered session registry but never replaces a plan capability grant.

Worker return is allowed only after history proves no operation remains active.
Exactly one `headless.worker.settled` event records review-ready, human-input,
exhausted, cancelled, or failed disposition and its process exit semantics.
An `awaiting_review` snapshot with failed or unavailable registered-check
evidence derives a named verification error for exit 1; a failed disposition
without either that evidence or an explicit persisted error remains an
incomplete settlement and is refused.
The CLI then renders the complete checksum-terminated H0 history as JSONL. A
started worker is not restart authority. H3a's explicit
`run reconcile-headless` path reacquires the same run lease, marks started
operations interrupted with their full reservations, proves operation
quiescence, and appends one `icarus.headless.worker-interruption.v1` settlement
without changing run state or re-entering execution. Repeated reconciliation
returns the existing settlement. Ordinary resume refuses any headless lifecycle;
binding reconstruction and exactly-once continuation remain H3b work.

The first H3b slice (ADR 0057) is evidence-only. `run reconstruct-headless`
reads the persisted run, project, approvals, events, and readable manifest —
holding no lease and writing nothing — rebuilds the source profile from the
durable start payload, re-resolves it against the plan-digest-pinned provider
identity, and recomputes the complete ADR 0047 binding, requiring the recorded
profile, resolution, and binding digests exactly. Each crash-tail operation is
classified `durably_settled` only with an intact finished receipt, `no_effect`
only for the two closed read-only kinds, and `ambiguous` for anything missing,
contradictory, extra, or unknown. The command emits one canonical
`icarus.headless.reconstruction.v1` metadata record; repeated runs over the
same durable bytes are byte-identical. The record is evidence for a later
continuation design and grants no resume, replay, fork, or execution
authority.

## Guarded CLI golden-path sequence

1. State-root initialization first rejects a location inside any Git checkout,
   and registration rejects lexical or canonical repository/state overlap,
   without creating the requested state root. It then canonicalizes a clean
   repository, stores its device/inode, and project creation stores a
   syntactically valid base ref and exact check arrays.
2. `run plan` first persists a `preparing` intent. It then verifies repository
   identity, resolves the base ref to the clean source HEAD, and immediately
   persists that immutable commit before further work.
3. Context assembly is a reserved operation. It first audits the complete
   committed tree within fixed credential-scan bounds, before landing any
   derived copy. It then reads through Git object commands, includes bounded
   root/target-ancestor `AGENTS.md`/seed files, records SHA-256 provenance, and
   labels repository text as untrusted.
4. Context persistence atomically lands a non-loopback run at
   `awaiting_egress_approval`; every remote provider call independently checks
   approval of that exact digest before any bytes leave the host.
5. The provider returns a strict JSON plan with an explicit grant array and
   iteration ceiling. Icarus resolves any readable scope into an exact
   base-commit path/digest manifest, hashes the full run manifest, and stops at
   `awaiting_approval`.
6. Icarus revalidates source HEAD before recording approval, then copies a private
   Git cache without hardlinks, creates its detached worktree, and captures the
   approved target preimages.
7. The provider returns one strict transactional patch set over approved
   targets. Icarus discards recognizable credential material before persistence,
   validates every modify/create/delete operation, persists tree intent, and
   applies the set through private temporaries outside the Git worktree. A
   partial apply compensates earlier paths and fails closed.
8. Icarus exports only tracked worktree files to a private snapshot and runs
   exact registered checks in a digest-pinned Docker container with network
   disabled. A timeout or cancellation cannot pass even when the child traps the
   signal and exits zero. Icarus verifies the changed-file set, stores a
   binary-capable Git diff and checkpoint, appends the full bounded verification
   attempt to history. Passing evidence stops at `awaiting_review`. Failed
   evidence enters the approved ADR 0026 session only when
   `iterationCeiling > 0`; zero remains single-shot.
9. Each session turn admits `provider.revise` before network I/O and at most
   eight closed tool operations before grant checks or host actions. Read tools
   see manifest-pinned base bytes or current session-written bytes;
   `list_tree`/`search` stay on the enumerated base manifest. `propose_patch` is
   advisory preview/validation only. `apply_patchset` carries and independently
   revalidates its own bounded PatchSet, then records exact intent before writes.
   Interrupted materialization resumes from persisted intent with `unavailable`,
   non-approvable verification. Apply and reconciliation cannot claim passing
   checks; `run_checks` records the current full-plan
   verification. `report_done` must revalidate the live checkpoint/diff and
   passing evidence. Human input or exhaustion records a non-approvable review
   blocker.
10. Review approval rereads the live targets, changed-path set, diff, source HEAD,
   and checkpoint binding; it is refused unless those still match passing
   evidence. It then marks the run complete without committing, pushing, or
   deploying. Rejection enters
   `rolling_back`, restores only baseline bytes, verifies a clean private
   worktree, and then marks it `rolled_back`. Restore enters `restoring`, writes
   only checkpoint-approved bytes, and returns through verification.

Before a bounded external operation, SQLite reserves its worst-case runtime,
tokens, and cost and records a started operation. Completion charges observed
wall-clock runtime within the reservation; token and cost fields use validated
provider-reported usage when available. On restart, an unfinished operation is
marked interrupted and charged its entire reservation before a new request can
be attempted. This intentionally favors bounded spend over optimistic replay.
Cancellation first persists `cancelling`. Runs with a worktree reconcile sandbox
state before restoring baseline bytes; pre-workspace runs skip reconciliation.
A crash resumes that recovery state rather than leaving reviewable evidence
attached to rewritten bytes.
One dedicated `cancellation.recovery` operation kind can land a run even after its
ordinary ceiling is exhausted. It is allowed only in `cancelling`, reserves a
fixed 120 seconds, has at most two persisted attempts, and remains charged and
visible in usage. No other productive operation receives that exception.


## Workspace review path

1. The workspace reads a safe snapshot backed by the same SQLite store used by
   the CLI; an empty store is rendered as an empty state, not sample data.
2. Project creation first applies the existing repository/state separation and
   clean local Git registration rules, then atomically persists a new repository
   and project in one SQLite transaction.
3. Context preview resolves the clean base commit and produces deterministic
   filtered metadata without persisting source text or touching the checkout.
4. Task submission persists a `preparing` run before provider work. A separate
   plan request runs the existing context/planning service with explicit
   loopback Ollama or Vulcan configuration and lands at the real guarded
   approval state.
   Linux, macOS, and Windows use the same SQLite started-operation admission
   before provider work.
5. Restarted API processes rediscover a draft before planning and can then plan
   it. The presenter also reads an already completed CLI run with populated,
   bounded plan/action/file/check/output/approval/usage/timestamp evidence.
   Absent work remains absent and the UI offers no control that can execute it.

Focused API coverage asserts useful `INVALID_PROVIDER_URL` and
`INVALID_REPOSITORY` responses without persistence, plus restart-before-plan
durability and completed-run evidence. A production-asset smoke drives the
project → context → draft → browser reload → plan → evidence flow in real
headless Chromium and rechecks the imported source fingerprint.

## Second M3 observation path

ADR 0015 is implemented through the existing HTTP/API, application-service, Git
controller, SQLite, and React boundaries. It adds no package, schema, migration,
or runtime dependency.

1. A project-scoped repository-observation handler resolves the persisted
   repository identity and runs only fixed read-only Git controller operations.
   Network transports, lazy fetch, hooks, prompts, and optional index locking stay
   disabled. Before any Git operation that can invoke a repository-configured
   helper, an effective-config name-only preflight follows includes and worktree
   config and rejects clean/smudge/process filters,
   `core.alternateRefsCommand`, and configured `hook.*.command` programs. The
   controller also disables the `post-checkout` hook event at command scope;
   private caches are checked again before `worktree add`. The presenter returns
   independent availability, worktree, HEAD, branch, and configured-base-relation
   fields. Missing or mismatched
   identity, unresolved refs, and observation errors stay explicit instead of
   collapsing into `clean`. Detached HEAD is `branch: null`, while the
   independent worktree field continues to report truthful cleanliness.
2. Repository observation returns no dirty filenames or counts, file contents,
   repository/private runtime paths, or raw Git output. It is a point-in-time
   projection only: no project/run record changes, event append, cache, worktree,
   or source-checkout mutation occurs.
3. A read-only selected-run event handler returns sequence-ordered pages strictly
   after an exclusive sequence cursor and enforces one fixed service-owned page
   maximum. Each event exposes only sequence, type, a fixed host-controlled label,
   timestamp, and a fixed host-generated `evidenceSection`; `payload_json` is
   neither returned nor used as browser copy.
4. The full run presenter reads its run row, newest 12 validated approvals, and
   200 most recent timeline metadata rows inside one SQLite read transaction.
   Approval coverage makes earlier decisions explicit. The append-only sequence
   high-water mark is both `eventCursor` and timeline total without decoding or
   scanning every event payload. Action presentation is derived only from that
   bounded tail. Event metadata pages are separate requests; their exclusive
   sequence cursor makes successive pages monotonic and overlap-free. CLI
   history continues to expose complete approval and event history, including
   event payloads. If the bounded suffix omits the prerequisite for an
   action transition, the browser reports the action status as `unknown` with
   CLI guidance instead of guessing `proposed`, `cancelled`, or `reverted`.
5. React short-polls only the selected run while `document.visibilityState` is
   visible. One request is current at a time; selection changes and unmount abort
   it, failures use bounded backoff, success restores the short interval, and a
   selection/request revision rejects late or out-of-order responses. A full run
   response is accepted only when its `eventCursor` is at least the newest event
   revision the client has already observed.
6. Live items target only a closed map of Icarus-generated evidence anchors.
   Untrusted repository, provider, event, and check strings remain text and never
   become element identifiers or fragment targets.

This path is observation-only. It adds no Server-Sent Events, WebSocket,
filesystem watcher, background process, approval, edit, check execution,
arbitrary command, commit, push, deployment, or other browser authority. Current
file/status and multi-file or payload-bearing diff/history navigation remain
deferred, and guarded actions must still revalidate authoritative repository
state immediately before use.

The ordinary full-run response retains at most the newest 12 approval decisions
and the newest 200 event summaries, with independent truncation metadata.
Complete approvals and events remain available through CLI history. The
approval projection bounds selected columns, decoded rows, and response size,
preflights storage/bytes before materialization, and uses the additive
`approvals_by_run` index plus reverse rowid seek for fixed per-run work and true
append ordering. A read-only startup preflight validates the exact index shape
before opening existing state for mutation. Building that index against existing
non-test state is a human-gated maintenance action. Workspace-
wide run enumeration is already a fixed 12-row page.

The helper-config preflight and the following Git subprocess are separate host
operations. A same-user process can change repository or included config between
them; Icarus does not claim hostile multi-user isolation. Repositories that use
effective clean/smudge/process helpers, `core.alternateRefsCommand`, or configured
hook commands therefore fail closed, and partial/promisor repositories must
already contain every object needed by the requested operation because lazy fetch
is disabled.

## Third M3 older-activity path

ADR 0016 implements this accepted path without adding another source of truth. A
selected run may request one metadata page strictly before an exclusive
sequence and at or below a pinned event revision. SQLite validates the run,
revision, and cursor in one read transaction, uses the unique
`(run_id, sequence)` index in descending order with `LIMIT 65`, retains 64 rows,
and reverses them for ascending display. The query selects no payload column.

The manual historical cursor is separate from the existing forward live cursor.
Opening the bounded panel aborts and pauses live polling; closing it resumes the
poll from its unchanged high-water mark. Historical requests are explicit and
single-flight, abort on visibility loss, close, selection, or unmount, and use a
generation guard against late responses. The client replaces pages, reaches at
most four per panel session, and retains only one page plus three newer-page
cursors. Complete payload-bearing history remains CLI only.

This path adds no persistence, repository/Git/source access, schema, dependency,
streaming, background work, or browser action route. Workspace-wide run and
approval enumeration remain the existing unpaginated local reads and are not
made bounded by ADR 0016.

## Fourth M3 workspace-run summary path

ADR 0017 replaces the run portion of workspace bootstrap with a direct,
metadata-only page. The first store transaction pins
`CAST(COALESCE(MAX(rowid), 0) AS TEXT)` as a session-only membership snapshot and
reads at most 13 rows through the intrinsic rowid B-tree. It returns 12 summaries
and a next exclusive cursor without a count or full-run decode. Continuations
require the exact pinned snapshot and cursor. Empty history uses snapshot zero.
The implementation was accepted on 2026-07-21.

Summary rows contain only IDs, bounded task/target text, state, host-derived
phase, and timestamps. Provider configuration, context, plan, edit, diff,
verification, errors, usage, approvals, and events remain absent. Full evidence
continues through the existing selected-run route only after explicit selection.
The snapshot fixes page membership, not live run state.

React retains one page plus three newer cursors, replaces pages, guards one
request by exact generation/cursors, preserves the last page on failure, and
aborts on lifecycle or selection changes. Project matches are explicitly scoped
to the loaded workspace page. Selected-run polling and event-history cursors stay
independent.

The rowid cursor is ephemeral and not a public run identity. Icarus exposes no
run deletion, replacement, or database-vacuum route; unsupported external
rewrites invalidate the page session. Durable cross-maintenance chronological
pagination would require a separately approved schema index.

This path adds no write, migration, dependency, Git/source read, disclosure of a
new run data class, stream, background work, or browser action route. Project and
repository enumeration remain unpaginated local reads and are not claimed
bounded by ADR 0017; ADR 0019 separately bounds ordinary selected-run approval
responses.

## Fifth M3 verification-attempt provenance

ADR 0018 defines a separate lazy selected-run read instead of extending the
automatically refreshed full-run response. The browser supplies the exact
coherent run event cursor. One transaction selects only safe run-state fields,
never the full-run loader, and requires that cursor to remain the current
high-water mark before reading the fixed up-to-200-event metadata suffix. A
stale race fails rather than joining that suffix to newer checkpoint state.

The store derives non-overlapping `verifying` intervals only from validated
state transitions and retains the newest eight anchors. A terminal inside the
window can have an unknown start; an open interval can start outside coverage.
Completed, cancelled, incomplete-failed, and incomplete-at-snapshot states are
distinct. Check timeout detail and formal supersession are not persisted and are
never inferred. Before scalar extraction, the store verifies TEXT storage and
direct-column byte length: 8 MiB per retained completion, 16 KiB per selected
lifecycle transition, and 1 KiB for an observed checkpoint-save event. Strict
RFC-8259 validity, exactly-once selected keys, fixed transitions, outcome
agreement, and digest agreement fail closed. Existing event routes remain
payload-free.

Checkpoint provenance uses a dedicated query for only expected run ID, canonical
digest, and bounded canonical timestamp. Baseline and approved bytes and all
unrelated run fields are never selected. Completed-attempt digests must match the
recorded immutable-checkpoint digest. Incomplete/cancelled intervals can claim
only run-checkpoint availability. The host does not rehash bytes or claim current
integrity; restore starts do not establish rollback cause.

The response separately reports events excluded before the 200-sequence window
and attempt-shaped anchors omitted by the eight-summary cap. The inline panel
visibly pins its revision/range and never claims complete invocation history. Automatic
live reconciliation marks the static panel stale without replacing it. Each
explicit load/retry uses a fresh current run cursor; conflicts require an
operator-triggered persisted-run refresh, never replay of the old request.

One aggregate parent cancellation callback is reserved for selected-run/project
changes and Back, where it invalidates both auxiliary request kinds.
Attempt-panel Close and run refresh never abort history, and older-activity
opening invalidates an attempt before launching history. Each request kind keeps
its own visibility, panel-Close, and unmount cleanup.
Exact-key and relational validation enforces fixed coverage/collection bounds,
outcome/relation enums, single-flight lifecycle guards, retained failure state,
honest copy, and a defined focus fallback.
Complete private evidence remains in CLI run history.

This implementation adds no schema, dependency, write, event append, Git/source
read, raw evidence disclosure, browser mutation, or release authority. ADR
0025's residual third-party review and secret-rotation work remains independent.

## Sixth and seventh M3 selected-run presentation bounds

ADR 0019 caps the approval suffix inside the existing coherent full-run read.
ADR 0020 adds no read at all: the API presenter derives `diffReview` from that
same run record, its verification evidence, the selected target, and the
registered project ceiling.

The presenter returns complete diff text only at or below a fixed 262,144-byte
browser cap. It validates paired presence, the project ceiling, one exact target,
canonical recorded digest, exact displayed-byte rehash, ordered per-file
Git patch bound to that target, and internally consistent hunk counts. The
resulting metadata distinguishes absent, available/rehashed, and larger
recorded-only evidence. A larger recorded diff is not parsed, rehashed, or
sliced by this projection; only metadata and CLI guidance cross the response
boundary.

The React page places persisted run state, verification outcome, path, byte and
patch-line counts, additions, deletions, hunks, digest, provenance, and the exact
patch together at fixed `#run-diff`. One keyboard-focusable, labelled `<pre>`
text node sits inside a bounded scroll region; no line-derived nodes, HTML sink,
link, or action control is created.
`verification.completed` targets this section, while `checkpoint.saved` remains
at verification.

The 256 KiB cap bounds response/rendered patch bytes, not the pre-existing full-
run SQLite hydration. A dedicated scalar projection for every full-run field is
separate future work. This slice adds no route, query, Git/source read, timing
source, browser action, or release authority.

## Eighth M3 project-catalog and response bounds

`GET /api/workspace` opens independent project and run insertion snapshots.
The project half is one newest-first page, not a catalog total. Its data query
seeks the projects rowid B-tree, joins the repository primary-key index, visits
13 rows, retains 12, and validates every selected column before presentation.
Continuation requests carry only the pinned `snapshot` and exclusive `before`;
external database maintenance invalidates the session rather than being hidden.

Project checks cross the store boundary only as strict TEXT JSON at or below
1 MiB; sandbox and ceiling profiles are at most 16 KiB. Direct SQL `CASE`,
`typeof`, `octet_length`, and `json_valid(..., 1)` gates precede JavaScript
parsing. Exact nested-key and policy validation reconstructs the domain records.
The same projected gates are used by direct ID/name hydration before create-run
or selected-run work; indexed lookup never becomes an unbounded decode path.
The same JSON byte caps apply on supported project writes. API presentation
omits repository device/inode metadata even though the joined record validates
it. Indexed exact-name and project-ID paths replace complete-list scans in
creation.

The React project session mirrors the bounded run session: one current page,
three newer cursors, one request generation, exact response validation, and
abort/retry behavior. Project selection is an independent retained object, so
catalog navigation does not silently erase the detail being inspected. If a
full run's owner is outside the current page, navigation and refresh retain or
resolve only that owner and never substitute the first unrelated project.

All API JSON goes through one final serializer. Serialization and the 8 MiB
UTF-8 check complete before `writeHead`; only then are status and safe headers
sent. An overflow reaches the ordinary top-level error boundary as
`RESPONSE_TOO_LARGE`, allowing a small fixed HTTP 500 response instead of a
partial success. Trusted error messages above 4 KiB are replaced with fixed
copy, and a pre-serialized internal-error body prevents recursive serializer
failure. Static assets retain their existing file-serving path.

## Sixth M3 change-room path

ADR 0041 is implemented through the existing store, HTTP/API, CLI, and React
boundaries. A Change Room is not a new entity: the room of a run is the run, and
`roomId` is the run ID.

1. Each `GET /api/runs/:id/change-room` read derives the
   `icarus.change-room.v1` projection inside one SQLite read transaction from
   the run row, approvals, the bounded 200-event metadata tail, the checkpoint
   row's safe columns (run ID, digest, timestamp), project check/sandbox
   configuration, and CLI annotations. There is no room table, event bus, or
   parallel state machine. Exactly eleven evidence cards appear in fixed
   lifecycle order, each with a host-controlled title, a provenance class
   (`operator_assertion`, `provider_output`, `host_fact`, `approval_decision`,
   `verification_evidence`, `system_failure`), an explicit status (`available`,
   `pending`, `not_applicable`, `unavailable`), bounded references to the
   authoritative records, a bounded body, and `truncated`, `redacted`, and
   `unavailableEvidence` indicators. Card bodies reuse only the disclosure
   classes the existing full-run presenter already crosses; checkpoint bytes,
   private cache/worktree/artifact paths, event payloads, raw provider prompts,
   and source blobs are never selected. The integrity block states that digests
   prove byte binding and recorded-evidence integrity only; the provider plan is
   labeled an untrusted proposal; the checkpoint card notes its digest is a
   recorded byte binding, not a fresh rehash. A review rejection projects as a
   rollback record carrying the rejecting decision, and completion sequences on
   rollback/restore records mark observed completion events, not causal links.
2. `GET /api/change-rooms` mirrors the ADR 0017 rowid-page discipline exactly:
   one pinned `MAX(rowid)` snapshot, descending `LIMIT 13`, twelve retained
   summaries, an ephemeral exclusive cursor, and fail-closed cursor validation.
   Summaries add only the latest verification outcome, provider
   kind/model/locality/privacy class, and a host-derived terminal reason.
   Provider and verification JSON are projected in SQL only behind
   `typeof`/`octet_length` preflight (16 KiB provider, 4 MiB verification) and
   strict `json_valid(..., 1)`; an unprojectable or invalid value fails the page
   closed as database corruption rather than guessing an unknown model or
   outcome.
3. `GET /api/runs/:id/change-context?question=...` answers exactly five fixed
   questions with an `icarus.change-context.v1` packet built by a pure host
   function over the room projection. No LLM, provider, network, or external
   tool participates. Each of at most eight component statements is a
   host-controlled template interpolating only bounded facts and carries
   receipts — the evidence-card IDs, event sequences, and digests it stands on —
   and packets carry explicit omission and uncertainty lists. A completed run's
   `what_changed` states that nothing was committed, pushed, merged, or
   deployed. The packet is shaped so a future optional local/BYOK assistant
   could summarize it with citations; this slice does not build that assistant.
4. `run annotate` validates before any write: run existence, a closed card enum
   (the eleven card kinds or `room`), the approval-actor rules, a 1 KiB
   non-blank body without NUL bytes, and fail-closed `SECRET_INPUT_DETECTED`
   rejection of recognizable credential material in actor or body. A run holds
   at most 32 annotations (`ANNOTATION_LIMIT_REACHED`). The `run_annotations`
   table is append-only with no update or delete path anywhere; annotations
   never append lifecycle events, advance event cursors, change run state,
   satisfy gates, or feed digests, approvals, verification, or execution.
   The annotation schema is additive and operator-gated: the table lives in
   `ICARUS_ANNOTATION_SCHEMA`, applied idempotently on every open, and a
   database with `runs` but no table is refused with
   `DATABASE_MIGRATION_REQUIRED` until the operator reruns with exactly
   `ICARUS_APPROVE_SCHEMA_MIGRATION=run-annotations-v1` after a backup. One
   token approves exactly one migration and an invalid table shape fails
   closed; there is no backfill and no existing table or index change.
5. This path adds no schema beyond `run_annotations`, no dependency, no write
   route, no stream, watcher, or daemon, and no browser authority. All three
   routes are GET-only reads: mutation verbs are refused by the ADR 0029
   action-session boundary (401) before routing and match no route even
   behind it, and GET reads perform no
   durable writes. Restart replay returns byte-identical projections. The React
   workspace gains a Change Rooms section — a bounded newest-first index
   (12-row replace-not-accumulate pages in a four-page window, explicit
   load/refresh, no polling), room detail with the eleven cards and a pinned
   event revision, read-only annotations, and an explain panel for the five
   fixed questions. The guarded CLI lifecycle and the ADR 0010 hold are
   unchanged.

## Offline Change Handoff Pack path

ADR 0042 adds a CLI/filesystem projection beside, not on top of, the Change
Room. The dependency and data flow is:

```text
WAL-clean SQLite family -> stable main-file bytes -> private in-memory SQLite
                                                -> default-deny safe facts
                                                -> canonical payload + digests

export request + expected preview digest -> recapture/revalidate safe snapshot
                                         -> regenerate/compare exact bytes
                                         -> exclusive local payload/result files

arbitrary handoff file -> hostile-file reader -> strict canonical decoder
                                               -> verify or safe inspection
```

The first two paths are run-scoped but do not construct the ordinary writable
runtime. The reader fingerprints the owned database family, refuses a non-empty
WAL with `RUN_BUSY`, captures stable main-database bytes, normalizes only the
private buffer's journal header, and opens that buffer in query-only SQLite.
It re-fingerprints the source around the read and never SQLite-opens the source
path or creates a temporary snapshot. Refusing uncheckpointed WAL truth is the
deliberate price of preview purity; the operator must let the normal writer
close/checkpoint and retry, never remove SQLite companions manually. The reader
then projects a dedicated internal source snapshot. It may inspect bounded local
records to validate relationships, but the safe-facts object contains only
opaque IDs, state/phase, the four safe provider scalars, lifecycle statuses,
counts, and typed digests. Annotation rows, event payloads, repository records
and paths, task/target text, plan/PatchSet/check content, diff/checkpoint bytes,
cache/worktree paths, actors, URLs, credentials, and landing/browser ledgers do
not cross that boundary. The builder enumerates every payload member; no object
spread or Change Room/full-run conversion exists.

The correlation ID is 1–128 ASCII bytes under
`[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`. The optional external reference uses the
same alphabet for 1–256 bytes. A provider model is copied only if it also passes
the 1–128-byte safe-token grammar. Every remaining string is a fixed enum,
canonical UUID/digest, or host template. Unsafe permitted-looking data refuses
the whole projection, so late redaction never becomes the disclosure boundary.

Canonical encoding sorts/places exact schema members deterministically, rejects
unknown prototypes, unsafe numbers and malformed Unicode, and emits compact JSON
plus exactly one LF. The payload SHA-256 covers those complete bytes. A separate
domain-separated preview SHA-256 binds the versioned operator request, safe
source binding/revision, schema, and payload SHA-256. The source binding contains
only safe facts and evidence digests, never omitted task or secret-bearing bytes;
it is not an offline oracle over private content. Handoff ID, payload bytes, and
both digests are reproducible without time or randomness.

Preview returns those exact bytes and digests without a write. Export is a new
read/validate operation, not continuation of an open snapshot: it recomputes
everything and compares the expected preview digest before opening a destination.
It requires the selected parent directory to be current-user-owned and not
group- or other-writable, and any existing output directory to be mode `0700`.
It then creates only `icarus-change-handoff.json` followed by
`icarus-change-handoff-result.json`. Both are owner-only, single-link regular
files opened descriptor-relative with no-follow/exclusive semantics. Each file,
the output directory, and its parent directory entry are `fsync`ed before
successful publication is reported; no overwrite is possible. Caught-error
cleanup may remove only a partial file created by that
invocation whose open descriptor and path still identify the same inode; an
empty newly created directory may remain rather than risk a path-racy removal.
The secure source reader, descriptor-root export implementation, and file-only
verification/inspection reader are Linux-only. Platform and capability
preflight fails with `HANDOFF_EXPORT_UNSUPPORTED` before output-directory
creation and before source or handoff-file access; there is no weaker path-only
fallback on macOS or Windows. The result's closed
four fields are `exportStatus`, `previewSha256`, `outputSchema`, and
`payloadSha256`; the last binds the newline-terminated payload.

File-only verify/inspect dispatch before state-root resolution, migration,
runtime, service, or environment credential setup. Their bounded hostile-file
reader rejects symlinked ancestors/finals, hardlinks, special files, unsafe
ownership/modes, growth or identity races, invalid UTF-8/BOM/NUL, excessive
bytes/depth, duplicate or unknown members, and noncanonical framing. It
re-encodes and compares exact bytes before reporting consistency. Inspection
uses a separate allowlisted presenter, so an unexpected input never becomes a
way to echo omitted material.

This path adds no SQLite object, lifecycle event, operation, API route, browser
component, provider/network dependency, Git/landing action, delivery state,
worker, or retry loop. The output files are operator-owned copies, not a new
Icarus source of truth. Their integrity statement distinguishes byte binding and
recorded local evidence from authenticity, authorization, truth, disclosure
permission, and execution/landing authority.

The future Athena seam is documentation only. A later importer may use six
meanings — handoff schema, complete payload digest, Icarus run ID, correlation
ID, safe lifecycle outcome, and disclosure class — in an evidence-only
`constellation.event.v1` timeline record. No other payload field maps, and no
Athena response becomes Icarus input. There is no shared runtime type, client,
receiver, authentication, credential, outbox, callback, retry, automatic Task
Room creation, or Minerva trigger in this architecture.

The four invariants remain:

- **State:** SQLite remains run truth. Preview is ephemeral; exported files are
  operator-owned evidence copies and never re-enter the lifecycle.
- **Feedback:** CLI preview/export/verify/inspect output and the fixed result file
  report local consistency. There is no receiver or delivery status to observe.
- **Deletion coupling:** ordinary Icarus cleanup remains unchanged. Export never
  deletes pre-existing output; failure may clean only its identity-matched
  partial files, while later artifact retention is the operator's responsibility.
- **Timing:** preview reads one coherent snapshot; export always rereads and
  compares before publication; file verification is independent of live Icarus
  state. No asynchronous delivery, retry, or callback ordering exists.


## Provider contract

The provider-neutral port accepts model identity, capability metadata, a typed
structured-generation request, token/output ceilings, a timeout, and an abort
signal. It returns validated plan or edit data plus normalized
token/latency/cost usage.

Milestone 1 adapters:

- Ollama: documented `/api/chat`, non-streaming JSON response. Plain HTTP is
  loopback-only; any LAN/Tailscale/public endpoint is remote and must use HTTPS,
  explicit pricing, and context-egress approval.
- OpenAI: official `POST /v1/responses` with environment bearer token,
  `store: false`, bounded output, and text extracted from response output items.
- Anthropic: official `POST /v1/messages`, an origin-pinned `x-api-key`, fixed
  API version, bounded output, and one forced schema tool whose input is treated
  only as structured response transport. It does not grant provider-native tool
  authority to a run.
- Vulcan: loopback-only OpenAI-subset `POST /v1/chat/completions` (default
  `http://127.0.0.1:8140/v1/`). The gateway holds no credential — the loopback
  bind is the boundary — and its closed request contract admits no
  `response_format` or `tools` field, so the schema travels in the system
  message and the response text faces the same downstream validators as every
  other adapter. Every request carries `seat: "icarus"` for attribution; model
  IDs are Vulcan's stable aliases and pass through verbatim, and hosted aliases
  are metered by Vulcan's own budget ledger rather than by Icarus pricing.

The browser narrows that provider contract: draft planning accepts only an
explicitly configured Ollama or Vulcan endpoint that classifies as loopback.
Remote, LAN, Tailscale, public, OpenAI, and other cloud planning endpoints are
rejected by the workspace route before a draft is persisted; CLI egress policy
is unchanged.

The CLI session loop continues to use typed structured generation rather than
provider-native tool authority. Its response schema is a closed batch of at most
eight registered calls with exact per-tool arguments. Every repeated remote
turn rechecks the exact approved context egress digest; the approved readable
manifest is the only additional file authority. Completed tool results and
errors are bounded, secret-scanned, and fenced as untrusted before reuse.

OpenAI request shape follows the official [Responses API reference](https://developers.openai.com/api/reference/resources/responses/methods/create).
No provider SDK is required for this narrow contract. Provider contract tests
exercise all three adapters against deterministic HTTP servers. Separate
lifecycle coverage currently exists for Ollama and OpenAI; the OpenAI lifecycle
uses the production adapter from exact egress approval through review without
making a paid request. An equivalent Anthropic lifecycle is not yet claimed.
Known credentials are supplied to transport-error sanitization, so a thrown
HTTP transport error cannot copy a credential into durable state or CLI output.
Non-success HTTP bodies are not retained in surfaced errors. Tests do not
substitute a fake production adapter.

## Context boundary

Repository files are data, not authority over the host. Context entries retain
path, reason, size, and digest. Root and nested rules can inform the plan, but
cannot expand permissions, commands, network access, budgets, or writable paths.
Semantic retrieval is deferred until deterministic selection has evaluation
evidence.
Path classification answers three separate questions: whether a file can be
edited, whether its bytes can be shown to a model, and whether its pathname is
intrinsically secret. For example, a safe `.npmrc` is protected and omitted
from model context but may be exported to the no-network sandbox; detected
credential bytes never reach any of those derived surfaces.

Workspace preview is a separate, non-persisted projection over committed Git
objects. It returns only path/reason/size/digest/count/warning metadata and
filters every `.env*` path, dependency/generated directory, binary or invalid
UTF-8 file, model-hidden or intrinsically secret path, and secret-shaped text.
This narrower display filter does not weaken the guarded run's full-tree,
fail-closed audit or make imported repositories writable.


## Safety boundary

- The HTTP server binds exact `127.0.0.1`. Accepted interim mutation sessions
  use a fresh 16-byte `.localhost` public-origin nonce and independent bearer
  only after the bind succeeds, with no Node/OS lookup or resolver injection.
  Every non-GET/HEAD request receives exact
  Host/Origin/authorization/action-header validation,
  duplicate-member-rejecting bounded JSON contracts, no CORS grant, and safe
  response headers. Explicit-port numeric origins are bearer-free and GET-only.
  It fails closed on malformed or unrecognized mutations.
- Browser repository data is rendered as untrusted text from allowlisted
  presenters. Raw domain records, context/source blobs, private runtime paths,
  and provider credentials do not cross the response boundary.
- The supported Linux Chromium browser exposes protected project/draft/planning
  mutations plus exactly eight server-derived guarded lifecycle actions: egress
  approval, plan approval, review accept/reject, rollback, restore, resume, and
  cancellation. It cannot invent an action descriptor or invoke an arbitrary
  command, commit, publish a ref or PR, push, merge, or deploy. Non-Linux and
  explicit-port presentations remain review-only with no guarded action
  controls.
- Remote-context approval gates non-loopback egress, plan approval gates the
  first write/edit call, and human review gates completion.
- Provider output with recognizable credential material fails before plan/edit
  persistence; known credentials, including credentials reflected by thrown
  transport errors, and command/error output are redacted.
- A failed first verification may re-enter execution only under explicit,
  digest-bound plan grants and a positive `iterationCeiling` (ADR 0026). The
  host maximum is two. `provider.revise` is admitted before provider I/O and
  each tool operation before grant check or host action; interruption, refusal,
  and failure remain charged. A patch revision returns the worktree to its
  immutable baseline, is validated against the same approved target scope and
  ceilings, persists intent before writes, and supersedes its predecessor in
  append-only history. Only current full-plan passing evidence plus a
  host-validated `report_done` is approvable. Human input and exhaustion land
  `awaiting_review` with a blocker, never a pass.
- A proposal is a patch set over the operator-approved target subset (ADR 0023):
  ordered exact replacements in existing tracked UTF-8 text files, complete
  content for a created path, and preimage-bound removal for a deleted path.
  Every path is validated independently and protected paths always refuse.
- Protected edit names include `.git`, non-template `.env*`, credential/key
  configuration; safe `.env.{example,sample,template}` files remain eligible,
  Icarus metadata, and repository rule files. Model visibility and intrinsic
  secret-path policy are evaluated separately.
- Reads open the final file with `O_NOFOLLOW`, verify descriptor identity and
  bounds, and reject symlinked components, special files, and hardlinks.
- Model-suggested commands are ignored. Only exact registered `argv` executes in
  a no-network sandbox; project code never executes on the host.
- Docker exports tracked files only after secret-shaped path/content screening
  and uses a locally present digest-pinned image, `--pull=never`, non-root
  user, read-only root, all capabilities dropped, no-new-privileges, no host
  sockets/secrets, PID/memory/CPU limits, timeout, cancellation, truncation, and
  redaction. Timeout, cancellation, or preflight failure is a hard verification
  failure regardless of the child process's eventual exit code.
- Network access for providers is separate from command network permission.
- Git subprocesses are fixed controller operations with system/global config,
  hooks, filters, pagers, prompts, external diffs, and network fetch disabled.

## Four invariants

- **State:** SQLite owns run truth; worktree bytes and Git status prove mutation
  truth.
- **Feedback:** append-only events retain every complete bounded verification
  attempt and diff; latest check evidence, CLI status, allowlisted API views, and
  the workspace expose current progress without erasing earlier failures or
  inventing results.
- **Deletion coupling:** removing SQLite, a private cache, or a worktree destroys local run
  recovery, so cleanup is never automatic in Milestone 1.
- **Timing:** a workspace task draft is persisted before planning; SQLite admits
  one started operation per run before portable planning work; all other
  run/operation intent precedes bounded external actions; approval pauses are
  excluded from active budgets; interrupted reservations are charged
  conservatively; cancellation intent precedes rollback writes; a fixed,
  two-attempt emergency recovery is the only ordinary-ceiling carve-out; and
  only replay-safe stages may resume.
