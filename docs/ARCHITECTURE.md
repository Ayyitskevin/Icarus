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
                                                     |-- Ollama/OpenAI adapters
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

The production server binds only to `127.0.0.1` and serves compiled UI assets
and `/api` from one origin. It rejects non-loopback Host or Origin values,
accepts only allowlisted methods/routes and bounded JSON mutation bodies, emits
no CORS permission, and fails rather than choosing a different address or port.
It is a foreground local process, not a remotely reachable daemon.

The first route set can inspect workspace state, register a repository/project,
preview committed-tree context metadata, persist a task draft, plan that draft
with loopback Ollama, and read a run. Repository import, preview, draft, and
planning do not create a private worktree or modify the source checkout. There
is no HTTP route for approval, edit or check execution, arbitrary commands,
commit, push, or deployment.

The API presenter allowlists product evidence instead of returning `RunRecord`
or history rows. It omits raw context/source blobs and private cache, worktree,
and artifact paths; explicit diff/check output remains bounded and redacted.
Missing verification is `not_run`; unavailable provider or execution capability
is `unconfigured`; neither is inferred as success.

The persisted `preparing` state appears as product phase `draft`. The other
derived phases are `planned`, `awaiting_approval`, `running`, `completed`,
`failed`, and `cancelled`, while the exact internal state remains visible. An
approval/recovery state is never flattened into completion.

The HTTP/UI shell, repository import, context preview, draft persistence, and
loopback planning support Linux, macOS, and Windows with no fleet or cloud
dependency. Planning creates no private worktree and executes no project code.
Before each bounded context/provider operation, SQLite atomically admits one
`started` operation per run; a concurrent planner receives `RUN_BUSY`.
Approval and execution remain Linux-only and use the stronger kernel lease
through `/usr/bin/flock` and `/proc`; execution checks also require a local
Docker daemon.

## State and feedback

Authoritative control state lives in one SQLite database under `ICARUS_HOME`
(default: the platform-local state directory). The database stores projects,
runs, append-only events, check evidence, provider usage, and checkpoints. It
does not store credentials or environment snapshots.

The run row retains the latest verification for efficient status reads. Every
verification attempt also appends its complete bounded evidence and diff to the
event stream, so restore/reverify does not erase the earlier attempt from
history.

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
5. The provider returns a strict JSON plan. Icarus hashes the full run manifest
   and stops at `awaiting_approval`.
6. Icarus revalidates source HEAD before recording approval, then copies a private
   Git cache without hardlinks, creates its detached worktree, and captures the
   approved target preimage.
7. The provider returns one strict path/hash/find/replace edit. Icarus discards
   recognizable credential material before persistence, then validates a
   unique match and atomically applies it. The pre-rename temporary is created
   in the Icarus-private run directory outside the Git worktree, so a process
   death cannot strand an extra changed path inside the review surface.
8. Icarus exports only tracked worktree files to a private snapshot and runs
   exact registered checks in a digest-pinned Docker container with network
   disabled. A timeout or cancellation cannot pass even when the child traps the
   signal and exits zero. Icarus verifies the changed-file set, stores a
   binary-capable Git diff and checkpoint, appends the full bounded verification
   attempt to history, and stops at `awaiting_review`.
9. Review approval rereads the live target, changed-path set, diff, source HEAD,
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
   loopback Ollama configuration and lands at the real guarded approval state.
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
4. The full run presenter reads its run row, approvals, and the 200 most recent
   timeline metadata rows inside one SQLite read transaction/snapshot. It uses
   the append-only sequence high-water mark as both `eventCursor` and timeline
   total without decoding or scanning every event payload. Action presentation
   is derived only from that bounded tail. Event metadata pages are separate
   requests; their exclusive sequence cursor makes successive pages monotonic
   and overlap-free. The CLI history path continues to read the complete event
   history and payloads. If the bounded suffix omits the prerequisite for an
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
arbitrary command, commit, push, deployment, or other browser authority. Richer
file/status, diff, and payload-bearing history navigation remains deferred, and
guarded actions must still revalidate authoritative repository state immediately
before use.

Only the event-history portion of a full run response is fixed-size. Approval
lists and workspace-wide run enumeration retain their existing unpaginated local
behavior and are not claimed to have constant work or response size.

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

ADR 0017 selects a planned replacement for the run portion of workspace
bootstrap: a direct, metadata-only page. The first store transaction will pin
`CAST(COALESCE(MAX(rowid), 0) AS TEXT)` as a session-only membership snapshot
and read at most 13 rows through the intrinsic rowid B-tree. It will return 12
summaries and a next exclusive cursor without a count or full-run decode.
Continuations require the exact pinned snapshot and cursor. Empty history uses
snapshot zero.

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
repository enumeration plus selected-run approvals remain unpaginated local
reads and are not claimed bounded by ADR 0017.

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

The browser narrows that provider contract: draft planning accepts only an
explicitly configured Ollama endpoint that classifies as loopback. Remote, LAN,
Tailscale, public, OpenAI, and other cloud planning endpoints are rejected by
the workspace route before a draft is persisted; CLI egress policy is unchanged.

OpenAI request shape follows the official [Responses API reference](https://developers.openai.com/api/reference/resources/responses/methods/create).
No provider SDK is required for this narrow contract. Tests exercise both
adapters against deterministic HTTP contracts; an OpenAI lifecycle test uses
the production adapter from exact egress approval through review without making
a paid request. Known credentials are supplied to transport-error sanitization,
so a thrown HTTP transport error cannot copy a bearer value into durable state
or CLI output. Non-success HTTP bodies are not retained in surfaced errors.
Tests do not substitute a fake production adapter.

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

- The HTTP server has a fixed loopback bind, same-origin UI/API, loopback Host
  and Origin validation, bounded JSON contracts, no CORS grant, and safe response
  headers. It fails closed on malformed or unrecognized mutations.
- Browser repository data is rendered as untrusted text from allowlisted
  presenters. Raw domain records, context/source blobs, private runtime paths,
  and provider credentials do not cross the response boundary.
- The browser exposes planning and review only; it cannot approve a digest,
  execute an edit/check/command, or commit, push, or deploy.
- Remote-context approval gates non-loopback egress, plan approval gates the
  first write/edit call, and human review gates completion.
- Provider output with recognizable credential material fails before plan/edit
  persistence; known credentials, including credentials reflected by thrown
  transport errors, and command/error output are redacted.
- A proposal is one exact replacement in an existing tracked UTF-8 text file.
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
