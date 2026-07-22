# Operations

## Supported operating mode

Milestone 1 guarded execution runs on one Linux host as one OS user and only
against local repositories explicitly registered by absolute path. The optional
workspace is a foreground process fixed to `127.0.0.1`; it does not install a
daemon, accept remote traffic, depend on fleet/homelab/cloud services, or touch
production systems.

The HTTP/UI shell, repository import, context preview, draft persistence, and
loopback planning support Linux, macOS, and Windows using platform-neutral
Node/browser primitives. Planning creates no private worktree and executes no
project code. SQLite atomically admits one started operation per run before
bounded context/provider work and rejects a concurrent planner. Approval and
execution remain Linux-only because they require the stronger kernel lease
through `/usr/bin/flock` and `/proc`; execution checks also require a local
Docker daemon.

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

The process prints JSON containing its exact URL, fixed binding, and state root.
The default is `http://127.0.0.1:8787`; `ICARUS_PORT` may select another explicit
local port. Binding or port conflicts fail closed without address/port fallback.
Stop the foreground process with `SIGINT` or `SIGTERM`; projects and drafts are
rediscovered from SQLite on restart.

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
6. Continue any digest approval, edit, sandbox check, review decision, rollback,
   or restore through the Linux CLI. The browser intentionally has no such route.

With `ICARUS_CHROMIUM_EXECUTABLE` set to an explicit local Chromium binary,
`pnpm smoke:workspace:browser` drives this path through the compiled application
in real headless Chromium, reloads before planning, and verifies the source
fingerprint remains unchanged.

Treat the loopback server as same-user local authority. It has no authentication
because it is not a remote service: do not reverse-proxy it, bind it to a LAN or
Tailscale address, publish it through a tunnel, or weaken Host/Origin checks. The
server accepts bounded JSON mutations, serves UI/API from one origin, and grants
no CORS permission. API presenters omit raw context/source blobs and private
cache/worktree/artifact paths; explicitly stored diff/check output stays bounded
and redacted.

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
approval or execution must continue through the guarded CLI, which performs its
own authoritative revalidation immediately before acting.

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
response reads its run row, approvals, and the 200 most recent timeline metadata
rows from one coherent SQLite snapshot. The append-only sequence high-water mark
is the event cursor and total; CLI history remains complete. When an action's
prerequisite falls before the bounded tail and the retained suffix cannot
re-establish it, the browser reports `unknown` and points the operator to CLI
history instead of guessing. Live links target only fixed Icarus-generated
evidence anchors, not repository, provider, event, or check text. Only event
history has the fixed bound; existing approval lists and workspace-wide run
enumeration remain unpaginated local reads.

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

No migration, dependency install, daemon, watcher, Server-Sent Events, or
WebSocket setup accompanies these read-only slices. They add no browser approval,
mutation, execution, command, commit, push, or deployment authority. File/status,
richer diff or payload-bearing history, and action controls remain deferred, and
the ADR 0010 release hold remains in force.

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
browser action authority, guarded CLI, or ADR 0010 hold.

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
  sends `POST /responses` with `store: false`, no tools, and no redirects.
  Remote OpenAI credentials are restricted to `api.openai.com:443`.
- Provider transport exceptions are converted to bounded Icarus errors and
  sanitized with the adapter's known credential before they can reach state or
  CLI output. Non-success HTTP response bodies are not copied into surfaced or
  durable errors.
- Model identifiers are explicit. Icarus never silently substitutes a model.
- The workspace accepts only an explicit loopback Ollama model/base URL. It
  rejects remote, LAN, Tailscale, public, OpenAI, and other cloud endpoints
  before persisting the draft; the broader CLI provider contract is unchanged.

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

A check is failed if it timed out or was cancelled, even if it traps termination
and eventually exits zero. The historical event evidence and the latest run
snapshot should agree on the current attempt while preserving earlier attempts.

## Repository automation and release hold

The inherited `.github/workflows/opencode.yml` is outside the local runtime but
inside the repository's security posture. It was preserved from remote commit
`0fb3476787573c1285974c2d53cfa28ec2233fc0`; see ADR 0010. Do not change,
disable, or bless it without Kevin's explicit decision. Do not treat its current
upstream collaborator check as a repository-owned gate, and do not claim M0/M1
security completion while the decision remains pending.

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
repeats it. Syntax-checking the inherited OpenCode workflow does not alter or
satisfy its separate ADR 0010 security hold.

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
real headless Chromium; `pnpm smoke:workspace` separately exercises the API and
production assets across restart. Run these from a clean candidate tree and
record the observed exit status and counts in
`docs/PLANS.md`:

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

Milestone 1 has schema version 1 and no automated migration against live state.
Back up before upgrades. A schema change needs an ADR, migration tests, and
explicit operator approval before existing state is opened by new code.
