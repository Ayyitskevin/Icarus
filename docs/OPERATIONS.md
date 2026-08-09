# Operations

## Supported operating mode

Milestone 1 guarded execution runs on one Linux host as one OS user and only
against local repositories explicitly registered by absolute path. The
optional workspace is a foreground process bound to exact IPv4 `127.0.0.1`; it
does not install a daemon, accept remote traffic, depend on
fleet/homelab/cloud services, or touch production systems.

The HTTP server and explicit-port review UI support Linux, macOS, and Windows
using platform-neutral Node/browser primitives. Mutation-capable
repository import, context preview, draft persistence, and loopback planning
are limited to a supported Chromium-family browser. ADR 0040's implementation
and exact-head technical evidence are complete at
`eb01b6406c12126c60add7ac83800f8eba8ffdc9` in Linux CI `30618041483` and
native real-Chrome run `30618043377`; explicit human acceptance of the interim
operator-controlled browser/resolver/proxy residual risk was recorded on
2026-07-31. Remaining Gate 1 runtime slices still gate release, and this
acceptance does not change that gate. No live migration, merge, deployment, or
public release was authorized or performed as part of it. Planning creates no
private worktree and executes no project code. SQLite atomically admits one
started operation per run before bounded context/provider work and rejects a
concurrent planner. Approval and execution remain Linux-only because they
require the stronger kernel lease through `/usr/bin/flock` and `/proc`;
execution checks also require a local Docker daemon.

Default state layout:

```text
ICARUS_HOME/
  .icarus-state-v1
  icarus.sqlite3{-wal,-shm}
  controller-home/
  artifacts/<run-id>/context.json
  locks/<run-id>.lock
  runs/<run-id>/{git-cache.git,worktree}/
  snapshots/<run-id>/                 # temporary, removed after checks
```

On POSIX systems, the state root must be dedicated, current-user-owned, mode
`0700`, and reached without a symlink parent. On Windows, it must be strictly
beneath the current user profile and inherit that profile's ACL; a location
outside the profile is refused. A pre-existing root must be empty or contain the
exact Icarus marker. Icarus never repurposes a broad or general-purpose root.
Never place a state root inside any Git checkout, even before that repository is
registered. Avoid network, shared, or synced filesystems for SQLite and private
worktrees.

Before state-root initialization writes anything, Icarus walks the lexical and
canonical ancestors and rejects any `.git` marker. During `repo add`, it also
checks repository/state containment in both directions before creating or
opening the requested state root. A rejected path therefore leaves both the
repository and prospective state path untouched.

## Local workspace runbook

Use Node 22.23 and pnpm 9.15 from a trusted local checkout. Choose a dedicated
`ICARUS_HOME` outside every imported repository, then build and start the
foreground server:

```text
ICARUS_HOME=/private/dedicated/icarus-state pnpm workspace:start
```

Windows PowerShell:

```text
$env:ICARUS_HOME = Join-Path $HOME ".icarus-state"
pnpm workspace:start
```

The process prints JSON containing its one-time launch URL, exact socket
binding, and state root. With `ICARUS_PORT` unset, the server binds exact
`127.0.0.1` on an operating-system-chosen ephemeral port and verifies that IPv4
address before creating a CSPRNG-selected 16-byte lowercase-hex `.localhost`
public origin and an independent mutation-session bearer:

```text
socket bind:   127.0.0.1:<ephemeral-port>
public origin: http://<32-lowercase-hex-origin-nonce>.localhost:<ephemeral-port>/
```

Open the fragment-bearing URL exactly as emitted in a supported
Chromium-family browser and do not copy it into logs. Icarus performs no
Node/operating-system lookup, hosts-file edit, or browser resolver injection;
the browser's built-in reserved-name handling must navigate the public origin.
The client removes the fragment before render and retains the bearer only in
that origin's `sessionStorage`. Its implementation and native evidence are
complete, and explicit human acceptance of the interim
browser/resolver/proxy risk was recorded on 2026-07-31. This accepted operating
contract does not attest the browser process and does not make Gate 1
release-complete.

Setting `ICARUS_PORT` to an explicit integer from 1 through 65535 instead starts
`http://127.0.0.1:<port>` in stable review-only mode: it emits no bearer and
rejects every POST. An explicit `ICARUS_PORT=0`, invalid value, binding
conflict, or port conflict fails closed without fallback. Stop the foreground
process with `SIGINT` or `SIGTERM`; projects and drafts are rediscovered from
SQLite on restart, but mutation authority requires the newly emitted launch
URL.

Use that explicit-port review-only mode for Safari, Firefox until separately
accepted, embedded webviews, and every unverified/default browser. The server
does not trust `User-Agent`, cannot determine which browser will open a printed
URL, and cannot automatically downgrade a random `.localhost` navigation that
never reaches it. Failure to bind exact `127.0.0.1` remains fatal.

The first `SIGINT` or `SIGTERM` closes request admission, drains every HTTP
handler registered before that boundary, waits for response settlement, and
then closes residual sockets and SQLite. A second signal keeps the operating
system's default hard-termination behavior as the manual escape hatch. Icarus
never automatically retries an interrupted mutation POST. For a Packet 2
guarded action, keep the original action ID and inspect its bounded receipt
after restart. Linux startup acquires the run lease, marks any started operation
interrupted, refuses prepared intent as `ACTION_NOT_ADMITTED`, and reconciles an
admitted request only from durable terminal evidence. Missing or ambiguous
evidence settles as `reconciliation_required`; it never replays the effect.
A busy run remains untouched and is reported for later operator inspection.

The browser golden path is:

1. Import a clean committed local repository and create a project. Icarus records
   the canonical source identity but leaves source content and Git metadata
   unchanged.
2. Select a tracked text target and request context preview. The response contains
   committed-tree metadata only and deterministically filters all `.env*`,
   dependency/generated paths, binary or invalid UTF-8 files, model-hidden paths,
   and secret-shaped content.
3. Enter a task plus explicit loopback Ollama model/base URL. Draft creation
   first persists a real `preparing` run without contacting the provider.
   Stopping and restarting the foreground server before planning must rediscover
   the same draft.
4. Select Plan as a separate action. SQLite admits the bounded planning
   operations before provider work, and the run stops at the real approval gate.
5. Review exact state, product phase, plan, any edit action that actually exists,
   involved/changed files, verification/check output, warnings, approvals, usage,
   failures, and timestamps. `unconfigured` and `not_run` are real outcomes,
   never aliases for completion or passing checks.
6. On Linux, Packet 2 presents only server-derived descriptors for egress
   approval, plan approval, review accept/reject, rollback, restore, resume, and
   cancellation. Read the displayed consequence, confirm the exact descriptor,
   and submit it once. A disconnect is not cancellation and is not a reason to
   repeat the POST; recover by the same action ID and receipt.
7. These lifecycle actions stop before every commit, push, Git-ref, pull-request,
   merge, and deployment effect. Non-Linux hosts show no guarded action buttons.
   Fresh local API and compiled Chrome 149 acceptance passed on 2026-08-02.
   PR #22 candidate `701952349e0818cead37672df951ed09c0edd27c` then
   passed hosted run `30760607215` and both native jobs in run `30760619650`.
   Rebase-merged `main` `ba38856a0e0e63d1045500185b2158a0859469d1`
   passed hosted run `30760769288`; its post-merge native run exposed a macOS
   timing-only smoke-harness assertion. The corrected Packet 2 implementation
   head `3683087066efb65255f05b2493fd31051c3ad7c6`, published on `main`, passed
   hosted run `30761189188` and both native jobs in run `30761192370`. The guarded
   CLI remains the full-fidelity fallback; this does not widen browser authority.

With `ICARUS_CHROMIUM_EXECUTABLE` set to an explicit local Chromium binary,
`pnpm smoke:workspace:browser` drives this path through the compiled application
in real headless Chromium. It proves fragment removal before render,
session-scoped reload, tokenless GETs, authenticated POSTs, stale/malformed
revocation, stable review-only suppression, token non-disclosure, and an
unchanged source fingerprint without a resolver override. That exact-origin
composition passed at implementation commit
`eb01b6406c12126c60add7ac83800f8eba8ffdc9` in native run `30618043377`: both
macOS 15 arm64 and Windows Server 2025 x64 used
`Chrome/150.0.7871.187` with CDP `1.3` at the pinned Google Chrome paths. A
Node HTTP client, resolver injection, hosts-file edit, review-only run, or
mocked browser is not substitute evidence.

The local Packet 2 run used `Chrome/149.0.7827.55` with CDP `1.3` and
additionally proved complete immutable action confirmation, one protected POST
per submission, stale `409 refused/STALE_ACTION` recovery without a provider
effect, exact parent-bound cancellation, focus recovery, and bounded receipts.
This local evidence is complemented by the candidate and corrected
implementation-head hosted/native acceptance above. It remains separate from Gate 1's live
provider and landing profile and grants no commit, push, Git-ref, pull-request,
merge, deployment, or migration authority.

Treat the loopback server and launch URL as same-user local authority. The
per-start bearer authenticates POST transport but is not a remote-service or
hostile-local-user security boundary: do not reverse-proxy it, bind it to a LAN
or Tailscale address, publish it through a tunnel, paste the launch URL into
shared logs, or weaken Host/Origin checks. Every non-GET/HEAD request requires
the exact session transport before its bounded strict-JSON body is read; GETs
and HEADs carry no bearer, and no CORS permission is granted. API presenters omit raw
context/source blobs and private cache/worktree/artifact paths; explicitly
stored diff/check output stays bounded and redacted.

The browser accepts loopback Ollama planning only. It has no cloud-provider key
entry, provider fallback, arbitrary shell, account, telemetry, commit, push,
deployment, or fleet-control integration.

## Second M3 observation behavior

Selecting a project requests one point-in-time repository observation. Read
availability, worktree, HEAD, branch, and configured-base relation as independent
fields. A missing repository,
identity mismatch, unresolved ref, or observation error must stay explicit and
must never be interpreted as `clean`. Detached HEAD appears as `branch: null`;
the independent worktree field still reports truthful cleanliness.

The repository response intentionally contains no dirty filenames or counts,
file content, repository/private runtime paths, or raw Git output. It is not
stored in SQLite and appends no event. Treat it as advisory display state only;
approval or execution must pass either Packet 2's exact guarded browser-action
boundary or the guarded CLI. Both perform their own authoritative revalidation
immediately before acting.

Repository inspection ignores system/global Git config, permits only local-file
transport, disables lazy fetch, and fails closed when effective repository,
included, or worktree config defines a clean/smudge/process filter,
`core.alternateRefsCommand`, or a configured `hook.*.command`. The controller also
disables the `post-checkout` event at command scope, and existing private caches
receive the same preflight before a worktree is added. A repository that depends
on one of those helpers, or a promisor repository whose required objects are
absent, is reported unavailable instead of running the helper or fetching. The
preflight and Git command are separate processes, so hostile concurrent same-user
config mutation remains out of scope rather than being presented as isolated.

Selecting a run may start short polling only while the page is visible. The UI
keeps one current request, pauses on document visibility loss, aborts on run
selection change or component unmount, uses bounded backoff after errors, and
returns to its short interval after success. A request revision prevents a late
response from replacing a newer selection. Poll failures remain visible errors;
they are not rendered as an empty history or successful state. The UI accepts a
full run response only when its event cursor is at least the newest event
revision it has already observed.

Event pages advance strictly after an exclusive sequence cursor and use one
fixed service-owned maximum. Operators see only sequence, type, a
host-controlled label, timestamp, and a fixed host-generated `evidenceSection`;
event payloads are unavailable through this route. Separately, each full run
response reads its run row, the newest 12 validated approvals, and the 200 most
recent timeline metadata rows from one coherent SQLite snapshot. Approval
coverage and the append-only event high-water mark make both suffixes explicit;
CLI history remains complete. When an earlier prerequisite falls outside a
retained suffix, the browser reports truncation or `unknown` and points the
operator to CLI history instead of guessing. Live links target only fixed
Icarus-generated evidence anchors, not repository, provider, event, or check
text. Approval response size is bounded, and a history-sized scan is forbidden:
`approvals_by_run` must appear in
`EXPLAIN QUERY PLAN`. Before the first candidate build opens an existing state
database, take a timestamped backup and explicitly approve the additive index
build; tests create it only in disposable state. Startup first opens existing
state read-only, validates the exact index shape, and refuses a missing or
misdefined index before WAL mode or schema setup can mutate the database.

For an existing state root, stop every Icarus process, back up the SQLite
database together with any `-wal` and `-shm` companions, and verify the backup
before migration. Then run exactly one normal CLI invocation with
`ICARUS_APPROVE_SCHEMA_MIGRATION=approval-index-v1`. Without that exact value,
startup fails with `DATABASE_MIGRATION_REQUIRED`; any other value fails as
`INVALID_DATABASE_CONFIGURATION`. Remove the variable immediately after the
index exists. This is an operator gate, not a persistent configuration.

The ADR 0023 patch-set schema uses the same gate with its own exact token,
`ICARUS_APPROVE_SCHEMA_MIGRATION=patch-set-v2`. It adds two tables and rewrites
no existing row, so runs recorded under schema v1 keep their single-file edit
and checkpoint columns and remain readable. Each migration is approved only by
its own token: a state root needing both runs two separate invocations, one per
token, each after its own verified backup. Startup inspects the existing
database read-only and fails with `DATABASE_MIGRATION_REQUIRED` before opening
it for writing.

The local Gate 1 ledger foundation adds two further one-shot tokens in an exact
order:

```text
ICARUS_APPROVE_SCHEMA_MIGRATION=browser-action-ledger-v1
ICARUS_APPROVE_SCHEMA_MIGRATION=landing-ledger-v1
```

Use two separate stopped maintenance processes and take a fresh verified backup
before each. The browser-action token must run first; the landing token refuses
while that schema is absent. Each invocation exits immediately after applying
and re-inspecting only its named schema, before normal runtime startup. Reusing
a token, racing two copies of one token, supplying a combined value, finding a
partial/lookalike Gate 1 object, using a permissive state/database/marker mode,
or placing the state root inside a Git checkout fails closed. This repository
implementation and its temporary-database tests do not authorize or perform a
live migration.

Gate 1 preflight never opens the source SQLite family. It fingerprints the
owned regular main, WAL, and SHM files; copies only the main database and WAL
into a private `0700` temporary directory with `0600` files; lets SQLite rebuild
SHM there; and verifies the source fingerprints again before and after exact
schema inspection. An unexpected journal/sibling or any detected race fails
closed, and the private snapshot is removed in `finally`. This preserves
committed uncheckpointed WAL truth without creating or changing source
sidecars. An uncatchable process termination can leave a private,
mode-restricted temporary snapshot for host cleanup, but cannot turn it into a
source-family write.

Because the plan approval digest now binds the approved target set, the policy
version advances. A run already parked in `awaiting_approval` under the previous
policy cannot be approved after the upgrade and must be replanned; this is
deliberate, since the approval no longer describes what it would authorize.

The accepted ADR 0016 implementation adds an explicit selected-run
older-activity panel pinned to the coherent run revision, backed by a direct
reverse 64-row metadata page rather than a forward drain from sequence zero.
While that panel is open, live polling pauses; the client replaces pages within a
four-page cursor window and complete payload-bearing history remains available
only through `run history`. Use the CLI for events outside that bounded browser
window.

ADR 0017 is accepted. Workspace bootstrap returns one 12-row metadata-only
summary page and loads full evidence only after selection. Older/newer pages use
an ephemeral pinned SQLite insertion cursor and a four-page browser window;
project matches describe only the loaded workspace page. The workspace no longer
hydrates every run for its bounded sidebar. Use
`icarus run list [--project NAME]` for complete run listing beyond the browser
window.

Other than the explicitly operator-gated `approval-index-v1` index build above,
these observation slices add no table/column migration, dependency install,
daemon, watcher, Server-Sent Events, or WebSocket setup. They themselves add no
browser approval, mutation, execution, command, commit, push, or deployment
authority. Packet 2 separately adds only its closed, server-derived guarded
lifecycle descriptors and receipts; it still adds no arbitrary command, commit,
push, Git-ref, pull-request, merge, or deployment effect. Current file/status
and multi-file or payload-bearing diff/history remain deferred, and ADR 0025's
third-party review and secret-rotation release holds remain in force.

## Fifth M3 verification-attempt view

ADR 0018 implements an explicit “Verification & Recovery Evidence” panel beneath
the selected run's current verification snapshot. An operator can load at most
eight verification-state intervals derived from up to the latest 200 persisted
events ending at that exact revision. Completed, cancellation-requested,
incomplete-failed, and open states are distinguished only from explicit
transitions. Missing starts, timeout detail, formal supersession, commands,
diffs, paths, checkpoint bytes, and complete history remain omitted or unknown.

A stale request fails if the run advanced before its read transaction. A
conflict preserves any last successful panel and directs the operator to
“Refresh persisted run.” A later explicit Load/Refresh/Retry captures the new
current cursor; it never replays the conflicted request. Automatic live
reconciliation does not cancel the panel. Instead, a loaded projection remains
pinned and becomes visibly stale when newer events arrive.

The panel displays its revision, inspected sequence range, fixed 200/8 limits,
loaded-summary count, and independent truncation/unknown states. It does not
claim complete invocation history. Complete private evidence continues through:

```text
icarus run history <run-id>
```

Completed intervals show only a recorded checkpoint-digest match; incomplete
intervals show only snapshot-level run-checkpoint availability. The panel does
not read or rehash baseline/approved bytes or claim checkpoint integrity.
Attempt-panel Close and “Refresh persisted run” abort only the attempt request
and never an older-history request. Opening older activity aborts the attempt
request before marking history open and launching its first request. The
aggregate selected-run auxiliary cancellation callback is reserved for
parent-owned selected-run/project changes and Back, where it invalidates both
request kinds. Each request retains its own hidden-document, panel-Close, and
unmount cleanup. The last valid panel survives a failed retry, and operator Close
uses the verification section as a focus fallback when the launcher is disabled.

This implementation adds one GET-only read and inline presentation. It does not
alter the payload-free event APIs, schema, dependencies, source repository,
browser action authority, guarded CLI, or ADR 0025's residual release holds.

## Seventh M3 persisted diff review

The selected-run page now groups the persisted run state, latest verification
outcome, recorded changed path, diff size, physical patch lines, additions,
deletions, hunks, digest, and digest provenance under “Persisted diff review.”
This is stored evidence only; it is not current repository status.

For an available patch, `displayed text rehash match` means the local API hashed
the exact displayed string and it matched the recorded verification digest. It
does not mean Icarus re-read or revalidated the imported checkout or private
worktree. Review actions still perform their independent CLI revalidation.

The browser shows complete patch text only at or below 256 KiB. If the status is
`metadata only`, no patch prefix or suffix was returned. Inspect the complete
persisted evidence with:

```text
icarus run status <run-id>
```

`not produced` means no persisted verification diff exists; it does not mean a
check passed. A sanitized `DATABASE_ERROR` indicates inconsistent persisted
diff/verification evidence and requires operator investigation rather than a
browser workaround.

This view reuses the ordinary selected-run read and adds no route, Git/source
read, mutation, or action. `verification completed` activity navigates to the
fixed diff section; `checkpoint saved` continues to navigate to verification.

## Bounded project catalog and JSON transport

The workspace loads at most 12 newest projects. Use the explicit Newer/Older
buttons within the four-page browser window. The membership snapshot does not
include projects created after the page session opened; Refresh workspace or a
successful project registration opens a new newest session. Use
`icarus project list` when complete catalog output is required.

Direct project and repository lookups use the same storage-class and byte
projections as catalog pages; they do not decode an unrestricted persisted
configuration first. While a run is visible, paging or refreshing resolves only
that run's owning project. An unrelated project is never marked active merely
because it appears on the newly loaded page.

`INVALID_PROJECT_CURSOR` means the pinned session is stale, malformed, or was
invalidated by unsupported external SQLite deletion/replacement/`VACUUM`; open
a fresh page rather than editing cursor values. `DATABASE_ERROR` while loading
a project page means selected persisted identity/configuration failed its
storage, byte, JSON, or policy checks. Preserve and back up state for operator
inspection; do not patch the database in place.

Every API JSON body is serialized before headers and may be at most 8 MiB,
including its newline. `RESPONSE_TOO_LARGE` is a fixed HTTP 500 safety response,
not permission to raise the limit or return partial evidence. Use the narrower
CLI listing/status command and investigate which persisted presentation
exceeded its intended field bound. Trusted error text is capped at 4 KiB and an
oversized or unserializable failure uses a fixed pre-serialized internal-error
response, so the response fail-safe cannot recursively exceed its own bound.
Static assets are not part of this JSON cap.

The first keyboard focus in the workspace is a skip link. Press Enter to move
focus to the main workspace landmark; selected project and run controls expose
their current/pressed state without changing browser authority.

## Change Room observation

ADR 0041 adds three GET-only observation routes. `GET /api/change-rooms` opens a
new newest-first index session when called without a query, or continues one
with exactly `before` plus `snapshot`, returning twelve retained room summaries
per page under an ephemeral pinned-rowid cursor. `GET /api/runs/:id/change-room`
derives the run's eleven-card evidence projection in one SQLite read
transaction. `GET /api/runs/:id/change-context?question=<question>` accepts
exactly one of the five fixed questions and returns the deterministic,
model-free answer packet whose statements carry receipts plus explicit omissions
and uncertainty. A non-GET verb is refused by the action-session boundary (401 without it, 404 behind it), an unknown run 404, and an invalid
query contract 422 (`INVALID_REQUEST` or `INVALID_RUN_CURSOR`).

Restarting the process and re-reading returns byte-identical projections, and
GET reads perform no durable writes. Treat the room's integrity block literally:
its digests prove byte binding and recorded-evidence integrity only, never fresh
authorization or semantic correctness, and the checkpoint digest is a recorded
byte binding rather than a fresh rehash. Operator annotations are read through
the room but authored only through `run annotate`; they carry no authority over
the run. Complete payload-bearing history remains CLI-only through `run history`;
the Change Room surface stays read-only and gains no annotation-authoring or
Packet 2 action control. Packet 2's separately accepted guarded action routes
remain outside the Change Room contract and add no arbitrary command, commit,
push, Git-ref, pull-request, merge, or deployment authority.

## Offline Change Handoff Pack runbook

A Handoff Pack is an operator-published local evidence file, not a Change Room
export and not a delivery action. Use an owner-controlled local filesystem.
Do not choose a shared, network, synchronized, repository, cache, worktree, or
publicly served directory.

First preview the exact artifact without writing state or output files:

```text
icarus run handoff-preview RUN_ID \
  --correlation-id CORRELATION_ID \
  --external-task-ref OPAQUE_REFERENCE
```

`--external-task-ref` is optional. Correlation IDs must be 1–128 ASCII bytes
matching `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`. The external reference uses the
same alphabet and is 1–256 bytes. The persisted model is publishable only when
it matches the same 1–128-byte safe-token grammar. These values are opaque:
they are not URLs, paths, actors, credentials, routing destinations, or
approval subjects.

Preview uses a read-only, non-migrating state path. It must make no network or
provider call, read no credential, and write neither SQLite nor the state root,
source checkout, cache, worktree, temporary snapshot, or output directory. The
reader securely captures a stable main-database image in memory and never opens
the source path with SQLite. A non-empty `icarus.sqlite3-wal` is refused as
`RUN_BUSY`; stop the normal writer and retry after its clean close/checkpoint.
Never delete, truncate, or move WAL/SHM companions to make preview proceed. It
prints:

- the exact newline-terminated canonical `icarus.change-handoff.v1` payload;
- `payloadSha256`, which binds those complete payload bytes;
- a separate `previewSha256`, which binds the request and safe source snapshot;
  and
- the complete fixed omission list.

Read the payload and omissions. In particular, verify that it contains no task,
path, plan, diff, command/output, annotation, event payload, credential, URL,
or executable instruction. The preview digest is the value passed to export;
the payload digest is not interchangeable with it.

Create or choose the private output directory, then export explicitly. Its parent
must be owned by the current user and must not be group- or other-writable; an
existing output directory must have mode `0700`:

```text
icarus run handoff-export RUN_ID \
  --correlation-id CORRELATION_ID \
  --external-task-ref OPAQUE_REFERENCE \
  --expected-preview-sha256 PREVIEW_DIGEST \
  --output-dir ./icarus-handoff
```

Export rereads and revalidates the run. If any digest-bound input changed,
repeat preview and review the new bytes; never bypass the stale-preview
refusal. Successful export creates exactly:

```text
icarus-change-handoff.json
icarus-change-handoff-result.json
```

Both files are owner-only, no-follow, exclusively created regular files. Export
never overwrites either name. It writes and syncs the payload first, then the
result, then syncs the output directory and its parent directory entry. If a
caught failure occurs, it removes only
a partial file whose still-open descriptor and current path match the inode
created by this invocation; a pre-existing file is never changed. A newly
created empty directory may remain on failure rather than risk deleting a
path-raced replacement. Inspect unexpected partial files after a process kill
or power loss manually—there is no background cleanup, retry, or recovery
daemon.

Secure Handoff Pack preview, descriptor-relative export, verification, and
inspection are Linux-only in v1. Platform and capability checks fail closed
before source or handoff-file access and, for export, before creating the output
directory. There is no weaker path-only fallback on macOS or Windows.

The result is strict canonical JSON with exactly `exportStatus`,
`previewSha256`, `outputSchema`, and `payloadSha256`. `payloadSha256` hashes the
complete handoff file including its final newline. It contains no path,
destination, evidence body, receiver, delivery, timestamp, or retry state.

Verify or safely inspect a handoff file without opening Icarus state:

```text
icarus handoff verify --input ./icarus-handoff/icarus-change-handoff.json
icarus handoff inspect --input ./icarus-handoff/icarus-change-handoff.json
```

These commands dispatch before `ICARUS_HOME`, migration, database, runtime,
service, provider, Git, or credential setup. They reject symlinks, hardlinks,
special or over-permissive files, ownership/identity/size races, invalid UTF-8,
BOM/NUL, duplicate/unknown members, excessive bytes/depth, malformed or
noncanonical JSON, and invalid hash semantics. `inspect` prints only allowlisted
fields and fixed caveats; it cannot recover an omitted category.

A successful result means the file is internally consistent. It does not prove
who made or supplied it, whether local evidence was true, whether the change is
correct, whether disclosure was authorized, or whether anyone may approve,
execute, land, merge, or deploy code. Every payload states:

> Digests prove byte binding and recorded local evidence integrity only. They
> do not establish fresh authorization, semantic correctness, evidence truth,
> disclosure permission, or permission to execute/land code.

No command in this runbook contacts Athena or Minerva, creates a Task Room,
sends a webhook, reads a callback, records delivery, retries, or changes a run.
Moving the finished file elsewhere is outside Icarus and remains an explicit
operator responsibility. A future one-way Athena importer needs its own accepted
ADR, authentication and replay model, operational runbook, and evidence.


## Preflight

Approval and execution require util-linux `flock` at `/usr/bin/flock` and a
local filesystem with working `flock(2)` semantics. Lease acquisition fails
closed if that fixed helper or kernel behavior is unavailable. Portable
loopback planning uses SQLite operation admission and does not require these
Linux lease primitives.

Version-2 leases do not support an online transition from metadata-only
owners. Before upgrading, stop every Icarus process, verify none remain, and
back up state. A v1 process already past its stale-path check cannot be fenced
by v2. Malformed or partial lease metadata is never aged into ownership;
preserve the state and require explicit operator recovery.

1. Confirm the repository is a non-bare, clean Git worktree with at least one
   commit. Confirm the prospective state root is outside every Git checkout and
   that it and the repository do not contain one another. The configured base
   ref must resolve to the source HEAD when a run is prepared and again before
   plan approval.
2. Register only offline verification commands that can run against a read-only
   tracked-file export with temporary writes confined to `/tmp`.
3. Choose a provider whose privacy class permits the selected repository.
4. Set credentials only in the process environment or a user-owned secret
   manager; never pass them as CLI arguments.
5. Remove tracked credentials before planning. Icarus audits no more than 16
   MiB per file and 64 MiB total before creating derived state; exceeding either
   limit or finding an intrinsically secret path/content fails closed.
6. For any non-loopback provider, configure HTTPS and both current token rates.
7. Pull and inspect the exact sandbox image outside a run and configure its
   manifest digest. Icarus uses `--pull=never` and rejects image-declared
   volumes or a daemon without confirmed seccomp.
8. Back up `icarus.sqlite3` and its WAL/SHM companions before upgrading.

## Provider configuration

- Ollama defaults to `http://127.0.0.1:11434`. Plain HTTP is loopback-only.
  LAN, Tailscale, and public endpoints are remote: they require HTTPS, explicit
  pricing, and exact context-egress approval.
- OpenAI defaults to `https://api.openai.com/v1`, reads `OPENAI_API_KEY`, and
  sends `POST /responses` with `store: false`, no provider-native tools, and no
  redirects. Session call batches remain Icarus-owned structured JSON.
  Remote OpenAI credentials are restricted to `api.openai.com:443`.
- Provider transport exceptions are converted to bounded Icarus errors and
  sanitized with the adapter's known credential before they can reach state or
  CLI output. Non-success HTTP response bodies are not copied into surfaced or
  durable errors.
- Model identifiers are explicit. Icarus never silently substitutes a model.
- A non-loopback session turn is a fresh remote provider call and requires the
  exact approved context egress digest again. The approved readable-manifest
  digest is the only additional context authority; a prior provider response
  cannot widen it.
- The workspace accepts only an explicit loopback Ollama model/base URL. It
  rejects remote, LAN, Tailscale, public, OpenAI, and other cloud endpoints
  before persisting the draft; the broader CLI provider contract is unchanged.

## GitHub gateway (Packet 4a package; not reachable at runtime)

`packages/github-gateway` is merged but imported by no runtime module. There is
no operator procedure for it yet, and no Icarus command can perform a GitHub
effect. This section records its operating boundary so that the procedure
written for Packet 4b does not have to reconstruct it.

- The gateway pins `https://api.github.com` and follows no redirect. A loopback
  origin requires an explicit construction opt-in, used only by tests, because
  such an origin would receive the credential in cleartext.
- A token is read from the process environment at call time under the existing
  landing credential-name allowlist. It is never written to the database, a
  receipt, an error, or a log, and it never reaches the browser.
- The expressible authority is exactly: read the authenticated actor, upload
  blob/tree/commit objects, create an absent reference, create a draft pull
  request, and read a reference or pull request back for reconciliation. Force
  update, reference deletion, merge, and deployment are inexpressible.
- Objects under repository-automation paths are refused before upload. Creating
  a head reference or opening a same-repo draft pull request causes the head
  branch's own automation to run with repository secrets, so those paths are a
  code-execution boundary rather than a style preference.
- No mutating request is retried inside the package. An interrupted mutation is
  reported as an ambiguous outcome and must be settled by the coordinator's
  durable intent and a reconciliation read, never by a blind repeat.
- A 422 on reference or pull-request creation is reported as a refusal, not as
  benign prior existence; branch protection and rulesets refuse the same way an
  existing reference does, and the gateway reads no upstream bytes to tell them
  apart.

## Runbook

- `run list [--project <name>]` rediscovers persisted runs without exposing
  private worktree, cache, context-content, or credential fields.
- `run status <run-id>` shows public state, context provenance, plan, usage,
  diff, and latest verification; private cache/worktree paths are intentionally
  omitted from CLI output.
- `run history <run-id>` shows append-only events and approval records. Every
  completed verification event contains that attempt's bounded check evidence
  and diff; later restore/reverify attempts do not erase earlier evidence.
- `run approve-egress <run-id> --context-sha <sha> --actor <actor>` binds exact
  remote context release.
- `run approve <run-id> --plan-sha <sha> --actor <actor>` revalidates the source
  and binds the complete plan manifest before workspace creation.
- `run resume <run-id>` is explicit. A started operation without a result is
  first marked interrupted and charged its full runtime/token/cost reservation;
  a fresh retry may then run only if ceilings still permit it.
- `run cancel <run-id> --actor <actor>` first persists a recoverable
  `cancelling` state, reconciles any managed container, restores known baseline
  bytes, and only then records `cancelled`. Resume completes an interrupted
  cancellation. This exact recovery operation has a fixed 120-second
  reservation and at most two persisted attempts; it remains visible and
  charged even when landing makes usage exceed the ordinary run ceiling.
- `run rollback <run-id> --diff-sha <sha> --actor <actor>` restores baseline
  bytes in the owned worktree and preserves the checkpoint.
- `run restore <run-id> --checkpoint-sha <sha> --actor <actor>` restores exact
  approved bytes, reruns checks, and returns to review.
- `run review <run-id> --decision reject --diff-sha <sha> --actor <actor>`
  performs the same bounded rollback. Review approval uses the same diff digest
  and is refused unless verification passed and the live source/worktree,
  changed-path set, diff, and checkpoint still match the reviewed evidence.
- `run annotate <run-id> --card <card|room> --text <text> --actor <actor>`
  appends one bounded operator annotation to a run's Change Room or to one of
  its eleven evidence cards. The card enum is closed, the actor follows the
  approval-actor rules, and the body must be non-blank, at most 1 KiB, and free
  of NUL bytes. Recognizable credential material in actor or body is rejected
  before write with `SECRET_INPUT_DETECTED`, and each run holds at most 32
  annotations (`ANNOTATION_LIMIT_REACHED`). Annotations are append-only with no
  update or delete path; they never append events, change run state, satisfy
  gates, or feed digests, approvals, verification, or execution.
- `run annotations <run-id>` lists a run's persisted annotations. The browser
  shows the same annotations read-only inside the room projection; no browser
  annotation route exists.

The approved first execution remains a single strict patch-set proposal and
formal verification. Only a failure enters the ADR 0026 session, and only when
the approved plan has explicit grants and `iterationCeiling > 0`; zero is a
single-shot run. The plan JSON and approval digest are the sole durable grant
source. No session/grant table or migration is introduced.

A session turn admits `provider.revise` before provider I/O and at most eight
closed tool operations before their grant checks or host actions. Refused,
failed, interrupted, and cancelled operations remain charged. The registry is
limited to `read_file`, `list_tree`, `search`, `get_check_catalog`,
`propose_patch`, `apply_patchset`, `run_checks`, `report_done`, and
`request_human_input`; it accepts no shell text or provider-defined tool.
`read_file` may return exact base-manifest bytes or current bytes recorded as
written by this session, including a created file. `list_tree` and `search`
enumerate only the approved base manifest.

`propose_patch` only previews and validates the bounded PatchSet supplied to
that call. It persists no authority or patch/checkpoint effects on any terminal
outcome, and a later apply never depends on an in-memory proposal.
`apply_patchset` carries its own exact PatchSet,
independently repeats grant, path, preimage, secret, and ceiling validation,
restores the private baseline, persists the exact new patch/checkpoint intent,
and only then materializes through the guarded file-write path. If apply is
interrupted after intent persistence, resume reconciles from that persisted
intent and records `unavailable`, non-approvable verification rather than
claiming that checks completed.
The Store accepts a repair replacement intent only while its mutation operation
is active; a missing repair checkpoint may be created only by that operation or
`session.reconcile`. Apply, failed/cancelled apply, and reconciliation may record
only `unavailable`. Every session `running` verification must immediately follow
the operation that produced it, and only `run_checks` may establish passed or
failed current check evidence. `run_checks` must name the complete approved check
list in order. `report_done` rechecks live bytes, changed paths,
diff, checkpoint, and passing evidence. A bounded secret-scanned human question
or iteration exhaustion lands `awaiting_review` with a blocker, so ordinary
review approval refuses it.

Effectful `apply_patchset`/`run_checks` and session-control operation finishes
commit with their verification/session-terminal evidence in one SQLite
transaction; advisory/read tools settle only their operation. The patch
operation's own intent/checkpoint events distinguish apply from proposal and
must agree with its redundant tool discriminator. Every proposal terminal is
zero-effect; failed/cancelled effectful apply may retain only its bounded partial
apply shape, and a complete effect shape requires an immediate unavailable
snapshot. `review.validate`, rollback,
and restore finishes commit with their corresponding state transition. A crash
cannot leave an effectful successful operation detached from its evidence or
state.

On resume, unfinished operations are conservatively charged, the private
checkpoint is reconciled, and only completed session boundaries are rehydrated.
Cancellation propagates into provider/tool/check work, then follows the existing
`cancelling` reconciliation, baseline restore, and emergency-recovery path.
The default and maximum session budget is two turns. Under the default
40-operation ceiling, two full turns cost 18 operations: local fresh execution
tops out at `12 + 18 = 30`, remote fresh execution at `13 + 18 = 31` because
`egress.validate` is metered, and a remote resumed session at
`13 + 18 + 1 session.reconcile = 32`. At least eight ordinary operations remain
for atomic review/rollback settlement and bounded retries. A global
tool-call/runtime/token/cost ceiling still binds first; admission failure lands
the session exhausted and non-approvable. The ordinary operation and
active-runtime ceilings must also retain one `session.reconcile` slot plus
`commandTimeoutMs` at session entry and after every provider or tool admission.
If that margin is absent, no new operation is admitted and the session
exhausts against its persisted evidence. Do not raise
`MAX_SESSION_ITERATIONS` above 2 without re-measuring every path and
settlement reserve.

Egress, plan, and review requests validate actor, digest, persisted gate, active
run ownership, and any verification prerequisite under the run lease before
metered host validation or reconciliation begins. A malformed, stale,
wrong-state, conflicting, or failed-verification request leaves run state,
usage, operations, events, approvals, provider calls, and worktree bytes
unchanged. Accepted requests are rechecked in the final SQLite approval
transaction after authoritative live validation where that validation is
required, preserving the gate against time-of-check/time-of-use drift.

Portable planning first inserts a SQLite `started` operation in a transaction.
The partial unique index allowing one started operation per run rejects
concurrent planning before a second process performs provider work.

Linux planning, approval, and execution additionally use per-run stable lock
files. The kernel owns exclusion through `flock(2)` on an open descriptor and is
authoritative among current-version participants. Protocol-version and
owner-nonce metadata are required compatibility and release evidence; PID/start
values are diagnostic. Acquisition refuses live or indeterminate legacy
metadata, migrates only a valid, proved-dead legacy owner in place, and fails
closed on malformed, partial, or unknown-version metadata. There is no
concurrent v1/v2 upgrade protocol. Acquisition and release revalidate
descriptor/path inode identity, and production lease code never unlinks or
renames a lock pathname. Process death releases the kernel lock while leaving a
harmless metadata file for the next owner. Icarus never automatically deletes
artifacts, caches, or worktrees. Missing or drifted private state is preserved
for investigation; Milestone 1 has no reconstruction or cleanup command.

Atomic replacement writes its pre-rename temporary in the Icarus-private run
directory, not the Git worktree. A failed write or rename is cleaned best-effort;
even a process death cannot introduce an extra worktree path that blocks
deterministic resume or rollback.

## Backup and recovery

Stop active Icarus CLI processes. Copy `icarus.sqlite3` together with any
`-wal`/`-shm` companions, plus `artifacts/`, `runs/`, and `locks/`, to a
private backup.
Icarus does not yet provide an integrity-check or restore command. If the
external `sqlite3` utility is available, run `PRAGMA integrity_check` against a
copy; do not imply that an empty journal or successful copy proves integrity.

The fleet NAS is currently a single-disk archive target, not a redundant backup.
Do not count a NAS copy as the only recoverable copy of Icarus state.

If a process stops:

1. Run `run status` and `run history`; inspect the last state and operation.
2. Confirm the registered source checkout remains clean and at the pinned HEAD.
3. Use `run resume`; never edit SQLite state manually.
4. If worktree bytes differ from both baseline and approved bytes, stop and
   preserve the tree. Recovery fails closed on unexpected bytes.

## Observability

The workspace reads the same SQLite state and append-only history through an
allowlisted presenter. It exposes exact state plus a derived product phase,
warnings, timestamps, and bounded/redacted evidence. Missing provider/execution
capability stays `unconfigured`; missing checks stay `not_run`. An already
completed CLI run is presented with its populated plan, action, involved and
changed files, verification, check output, approvals, usage, and timestamps
while private runtime paths remain omitted.

Events record transition, actor where applicable, bounded/redacted detail, and
timestamps. Operation events expose reservations, interruption, and final
outcome. Verification evidence records exact argv, exit status/signal, duration,
timeout message, truncation, and redacted stdout/stderr. Empty output is never
proof; exit status, containment, changed-path, diff, and checkpoint assertions
are required.

Session observability uses those same operations/events rather than a parallel
session row. Provider turns, per-capability/control tool calls, completed
boundaries, human questions, exhaustion, and done outcomes are explicit.
Only settled, bounded, secret-scanned tool evidence is eligible for a resumed
prompt; a started/interrupted operation is visible and charged but never
presented as a successful result.

A check is failed if it timed out or was cancelled, even if it traps termination
and eventually exits zero. The historical event evidence and the latest run
snapshot should agree on the current attempt while preserving earlier attempts.

## Gate 1 benchmark contract runbook

The committed, populated offline input is
`fixtures/evals/gate1/manifest.v1.json`. Run its focused strict validator and
evaluator with:

```text
pnpm benchmark:gate1
```

The ordinary `pnpm eval` gate includes the same focused contract. Both paths use
the production Ollama adapter only through deterministic loopback HTTP and run
registered checks inside the production no-network sandboxes. They may create
one deterministic local candidate and one absent-only private `icarus/` ref per
case in temporary Icarus-owned state. They resolve no GitHub credential, contact
no external network, mutate no remote ref or pull request, run no live state
migration, and perform no force-push, merge, or deployment.

Treat every repository fixture as untrusted plain-tree input. A fixture root
must not contain any `.git` path, and its exact inventory must contain neither a
`.git` component nor a `.gitattributes` file. The copy step independently
excludes root `.git` and rechecks that it is absent before initializing Git.
Fixture Git runs only as fixed `/usr/bin/git` with `/usr/bin:/bin`, an isolated
home/configuration, system/global configuration and attributes disabled, hooks
and credential helpers disabled, prompts and SSH suppressed, and network
protocols denied. The focused fixture-boundary suite injects `.git` as a
directory, file, and symlink plus a malicious local clean filter, then proves
the benchmark refuses before the filter can execute.

The generated result path is `.local/gate1-benchmark-report.json`. It is ignored;
the runner removes any stale result before starting Gate 1 work, and it must not
be committed as a replacement for the manifest. Report schema v1 is a closed
success/failure union. A success report binds the validated committed-input
digest and records all three completed cases with their observed task, source,
provider-instruction, registered-check, and candidate identities. Each completed
case marks draft-PR and receipt effects `not_executed_contract_only`; their
closed future requirements live in the input manifest. The manifest's
derivative-effect declaration is `contract-only-unassessed`; do not treat it as
an operator assessment of automation configured on a real repository.

A handled failure after report-output preflight records only the ordered prefix
of fully completed cases. `counts.contractPassed` and the aggregate effect
counters cover that prefix only, and `effects.status` is
`partial_completed_cases_only`; never infer the active failed case's incomplete
effects from those counters. The failure record includes its stage, the next case
ID only for case execution, a bounded safe error code or `null`, and a SHA-256 of
the error message rather than the message. `manifestSha256` is the digest of the
raw manifest bytes when available and is `null` only when those bytes could not
be read. The failure report adds an explicit incomplete-effects limitation. Both
variants reject missing or extra fields, are strict-parsed and validated before
and after atomic persistence, and say Gate 1 remains incomplete. If report
construction, validation, or persistence fails and the failure variant cannot
itself be validated and persisted, the command raises a combined failure and no
report should be trusted.

The offline recovery exercise closes and reopens the production runtime, reads a
benchmark-harness candidate journal, and re-instantiates the local landing
controller before creating the absent-only ref. It rejects a duplicate replay,
but it does not execute a browser reload or foreground-server process restart
and does not prove durable landing coordination. Browser reload and server
restart remain separate acceptance cases: same-tab reload retains its
`sessionStorage` bearer, while a foreground-server restart rotates origin and
bearer and requires the newly emitted launch URL. Never preserve, copy, or report
the old bearer as restart evidence.

The offline command is not the Gate 1 release benchmark. Completion still needs
a separate versioned, human-approved, credential-gated Linux live-evidence
profile bound to the offline manifest digest. It must reuse the exact immutable
case/task/check/source/expected-change/candidate pins while separately pinning
the real provider/model and adapter version, captured pricing and budgets, and
an operator assessment of each real repository's automation with its disposition
and raw assessment digest. The profile must name and separately approve every
allowed Git object upload, absent-only remote-ref creation, draft-PR creation,
and receipt effect; nothing else becomes authorized. Its result must record exact
candidate and live branch/commit/draft-PR/receipt identities and prove 3/3
success. Mock, synthetic, loopback, or contract-only results cannot substitute.
No credential value belongs in either manifest or result, and this offline
runbook does not authorize the live profile.

## Repository automation and release hold

The inherited `.github/workflows/opencode.yml` is outside the local runtime but
inside the repository's security posture. ADR 0025 resolved ADR 0010 by choosing
hardening: a repository-owned `authorize` job admits only `OWNER`, `MEMBER`, or
`COLLABORATOR`, the privileged job depends on it, permissions default to none,
third-party actions are commit-SHA pinned, untrusted comment fields enter shell
only through `env:`, and upstream session sharing is disabled. Do not weaken
that gate or treat a pin as a supply-chain review.

Two release holds remain: review the exact pinned third-party action and rotate
the named OpenCode secret that was reachable under the former trigger. Branch
protection is tracked separately. The hardening decision itself is no longer
pending.

The deterministic release gate pins actionlint v1.7.12 by the official release
archive SHA-256 plus an independently recorded extracted-executable SHA-256.
Bootstrap is explicit and writes only to ignored `.local/tools/` state:

```text
pnpm workflow:setup
pnpm workflow:lint
```

The target table covers x64 and arm64 Linux, macOS, and Windows release
artifacts; all archive/executable hashes were checked, while this change records
native execution only on Linux x64. Setup fails on a missing extractor,
redirect/download error, time or size ceiling, checksum mismatch, unexpected
binary/version, symlinked default tool directory, or unsupported platform. It
never searches for or silently substitutes a system binary. An explicit
`ACTIONLINT_BIN` override is accepted only when it is a regular file with the
exact current-target executable hash and version.

Linting disables host-dependent shellcheck/pyflakes integrations, requires at
least one regular `.yml` or `.yaml` workflow, validates every such file, and
requires the exact binary to reject a generated known-invalid workflow. Missing
or modified tool state therefore fails `pnpm check`. Hosted `ci` bootstraps
and runs workflow lint before dependency installation; the later release gate
repeats it. Syntax-checking the inherited OpenCode workflow does not satisfy ADR
0025's remaining third-party review or secret-rotation work.

Hosted CI is separate evidence. Workflow lint and a local `pnpm check` do not
prove that GitHub accepted or executed the workflow. For every candidate release,
query the exact head and require a successful `ci` run:

```text
git rev-parse HEAD
gh workflow list -R Ayyitskevin/Icarus
gh run list -R Ayyitskevin/Icarus --workflow ci.yml --commit "$(git rev-parse HEAD)"
gh api "repos/Ayyitskevin/Icarus/commits/$(git rev-parse HEAD)/check-runs"
```

## Re-runnable adversarial evidence

The durable review evidence is the named test source plus fresh command output;
do not replace it with a prose claim. `pnpm smoke:workspace:browser` launches
real headless Chromium without resolver injection;
`pnpm smoke:workspace` separately exercises the API and production assets
across restart but cannot prove browser-owned `.localhost` resolution. Run
these from a clean candidate tree and record the observed exit status and
counts in `docs/PLANS.md`:

```text
pnpm workflow:setup
pnpm workflow:lint
pnpm exec vitest run tests/integration/security-regressions.test.ts
pnpm exec vitest run tests/integration/runtime-ceiling-cancellation.test.ts
pnpm exec vitest run tests/unit/runtime-state-root.test.ts tests/unit/service-draft.test.ts
pnpm exec vitest run tests/integration/local-workspace-api.test.ts tests/integration/lifecycle-restart.test.ts
pnpm smoke:workspace
ICARUS_CHROMIUM_EXECUTABLE=/absolute/path/to/chromium pnpm smoke:workspace:browser
pnpm exec vitest run tests/integration/docker-containment.test.ts
pnpm exec vitest run tests/unit/git-file-safety.test.ts tests/unit/lease.test.ts tests/unit/sandbox-wire.test.ts
pnpm eval
pnpm check
pnpm audit --audit-level high
git diff --check
```

The evaluation report is generated at `.local/eval-report.json` and is ignored
by Git. Preserve command output in the release handoff; never commit provider
credentials, raw secret-bearing output, or private repository content.

## Upgrade policy

The `run_annotations` table (ADR 0041) is additive and forward-only. Fresh
databases always contain it. A database that already has `runs` but lacks the
table follows the same operator-gated migration contract as the earlier
additive ledgers: back up `icarus.sqlite3` and its WAL/SHM companions, then
open state once with exactly
`ICARUS_APPROVE_SCHEMA_MIGRATION=run-annotations-v1`. One token approves
exactly one migration; without it the store refuses to open with
`DATABASE_MIGRATION_REQUIRED` before writing anything, and a table whose shape
does not match fails closed as `DATABASE_ERROR`. There is no backfill and no
change to any existing table or index. Back up before upgrades. Any further
schema change still needs an ADR, migration tests, and explicit operator
approval before existing state is opened by new code.
