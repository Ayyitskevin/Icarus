# Icarus

> Fly high. Know the ceiling. Land safely.

The name comes from the Greek story of Icarus: the product is designed for
ambitious capability with an explicit ceiling and a safe landing path.

Icarus is a local-first, self-hosted, model-agnostic AI software factory. The
current foundation deliberately implements one bounded workflow well: plan a
transactional PatchSet over operator-selected paths, obtain human approval,
apply it in a private Git worktree, run operator-registered checks in a
no-network sandbox, present evidence, and retain enough history to review,
resume, roll back, or restore the run. A failed first verification may enter a
separately approved, two-turn maximum session with a closed host-owned tool
registry; it never becomes arbitrary shell or deployment authority.

Icarus is not a chatbot shell, an autonomous production deployer, or a claim
that later roadmap features already exist.

> **Release status:** Gate 0 is released at exact `main`
> `802b91e6f6c9b392f56c9ee3660be818a0f74a62` with Linux, macOS, and Windows
> evidence. The current Gate 1 worktree carries only a candidate authenticated
> browser-mutation session and its client capability state. Random numeric
> `127/8` origins were rejected after native run `30613980911` passed Windows
> and failed macOS. Candidate ADR 0040 instead requires exact-head real Chrome
> acceptance on both platforms. It is not a Gate 1 release: that evidence, the
> durable guarded-action ledger, and the Git landing runtime do not yet exist.

## Current scope

Milestone 0 supplies the product, architecture, security, operations, eval, and
roadmap contracts plus repeatable quality gates. The Milestone 1 slice supplies:

- local repository registration and project metadata;
- deterministic pinned-tree maps and target-applicable `AGENTS.md` context;
- an explicit persisted run state machine;
- Ollama, OpenAI Responses, and Anthropic Messages planning adapters;
- explicit cloud-context approval before remote egress;
- a plan-digest approval step before private workspace creation or code mutation;
- an Icarus-private Git cache and detached worktree;
- transactional modify/create/delete PatchSets over an approved target subset,
  with guarded atomic writes, compensation, and tree checkpoints;
- exact operator-registered verification commands in a no-network Docker
  sandbox with no host fallback;
- explicit digest-bound capability grants, an enumerated readable manifest, and
  a bounded failed-verification session using only host-registered tools;
- diff, event, usage, and checkpoint persistence in SQLite;
- run resume, review, rollback, and checkpoint restoration.

Remote preparation reaches its egress gate atomically, successful provider
output containing recognizable credential material is discarded before
persistence, and completion revalidates the live worktree against the reviewed
diff. Before any context artifact, provider request, private Git cache, or
worktree exists, preparation also audits the complete tracked tree within fixed
file and aggregate byte limits and fails closed on credential material.

The first Milestone 3 vertical slice adds a same-origin React workspace and a
loopback-only local API. It can persist a repository/project, preview a
deterministic filtered map of the committed tree, save a task as a draft, ask a
configured loopback Ollama model for a plan, and reopen browser-safe evidence
after restart. The current Gate 1 candidate binds exact `127.0.0.1` while using
a fresh 128-bit `.localhost` public origin and an independent authenticated
mutation session. That mutation path is supported only in real-accepted
Chromium-family browsers and remains held pending exact-head native Chrome
evidence. Explicit-port sessions remain bearer-free and review-only for Safari
and every unverified browser. The guarded lifecycle remains review-only in the
browser: it cannot approve a plan, create a worktree, execute checks, mutate the
imported repository, or claim that unrun work completed.
The workspace reports mutation and planning capability from both the server
mode and the tab's live session; stable or revoked sessions become visibly
review-only and disable the corresponding controls.

The second Milestone 3 slice adds project-scoped, nonpersistent repository
observation with independent
availability, worktree, HEAD, branch, and configured-base-relation fields, plus
fixed-size event metadata pages addressed by sequence cursor. It omits dirty
filenames and counts, file content, raw Git output, and event payloads. The
selected run may short-poll only in the visible foreground, with abort, bounded
backoff, request-revision guards, coherent full-run/approval/timeline SQLite
snapshots, an event-cursor freshness guard, and fixed Icarus-generated evidence
anchors. Full browser timelines retain only the 200 most recent metadata rows;
the CLI history contract remains complete. This slice adds no streaming
transport, schema, dependency, or browser authority.

The third and fourth Milestone 3 slices bound older selected-run event metadata
and workspace-wide run summaries. Historical activity retains one 64-row
metadata page in a four-page cursor window; workspace bootstrap now returns one
12-row metadata-only page, and full run evidence loads only after selection. The
run-page membership snapshot is ephemeral, inserted runs do not shift the
session, and the browser retains one page plus three newer cursors. Both paths
replace rather than accumulate pages, preserve the last successful page on
failure, cancel superseded or lifecycle requests, and add no schema, dependency,
Git/source read, stream, watcher, or browser action authority.

The fifth Milestone 3 slice adds an explicit, lazy selected-run verification and
checkpoint provenance view. It examines only the latest 200 event sequences,
returns at most eight evidence-backed verification intervals, and exposes only
validated states, sequences, timestamps, digests, coverage, and recorded
checkpoint relations. Raw payloads, diffs, paths, checks, output, checkpoint
bytes, complete history, and every guarded action remain CLI-only.

The sixth merged observation slice bounds ordinary selected-run approval provenance to
the newest 12 validated recorded decisions, reports when earlier decisions were
excluded, and keeps complete history in the CLI. Recorded actors and digests are
provenance facts, not fresh authentication or byte-integrity checks. Existing
state requires a verified backup and one explicitly approved
`approval-index-v1` migration; see `docs/OPERATIONS.md`.

The seventh merged observation slice turns the already persisted one-file verification
diff into explicit review evidence. At most 256 KiB of complete patch text is
shown; displayed bytes are rehashed against the recorded digest, while a larger
recorded diff becomes metadata-only with no partial preview or format validation
by this projection. Exact persisted run state, verification outcome, path, size,
patch statistics, and digest provenance
appear together without another Git/source read or any browser action.

The eighth merged observation slice replaces the workspace's unbounded project catalog
with one pinned, newest-first page of at most 12 joined project/repository
records. The browser replaces pages inside a four-position cursor window,
preserves an independently selected project or the exact owner of a visible
run, and keeps complete listing in the CLI. Catalog and direct hydration both
storage- and byte-gate persisted project JSON before strict decoding; creation
uses exact indexed lookups. Every HTTP JSON response is completely serialized
under an 8 MiB UTF-8 ceiling before success headers are sent, with bounded error
copy and a fixed non-recursive fallback.

These bounded observation slices are merged and exact implementation-head
hosted CI verified. At their original slice checkpoints they did not establish
native macOS or Windows acceptance; exact-head native acceptance was later
recorded for the Gate 0 release at `802b91e6`. They still do not complete full
M3, close ADR 0025's third-party review/secret-rotation work, authorize a live
approval-index migration, or make Icarus production-ready.

ADR 0026 slice 2b is implemented and released in the Gate 0 baseline: the initial approved
PatchSet attempt remains, only failed formal verification enters the session,
and `iterationCeiling: 0` remains single-shot. Provider turns and tool calls are
durably admitted before effects; completion is host-gated on current passing
full-plan evidence. The released implementation projects only host-owned
check metadata to remote session prompts while retaining full raw output in
local evidence, and it revalidates mutation grants against the plan's narrowed
targets before session admission or worktree effects. Roomy, compacted, live
tool, loopback, legacy-resume, and malformed-grant regressions pass with the
complete local gate. Exact-head Linux and native evidence are linked in
`docs/PLANS.md`; that Gate 0 evidence does not validate the current Gate 1
worktree until it is published and rerun at the new exact head.

[ADR 0036](docs/adr/0036-proof-carrying-software-factory-product-direction.md)
sets the next product direction: Verified Change Gate, browser and VS Code
surfaces, reversible Git landing, governed preview environments, and Supabase
change packs. Icarus will own the authority/evidence kernel and integrate editor,
environment, and backend primitives rather than rebuild them.

Not yet included: browser approval or execution, arbitrary/provider-native
tools, model-written shell commands, semantic search, commits or pushes,
application previews, current file/status or multi-file and payload-bearing
browser diff/history navigation, deployment, backend platform primitives,
multi-agent orchestration, and distributed workers.

## Requirements

- Node.js 22.23 or newer in the Node 22 line
- pnpm 9.15 or newer in the pnpm 9 line
- Git 2.40 or newer
- a clean local repository with at least one commit for workspace import

The loopback server and explicit-port review UI support Linux, macOS, and
Windows and require no homelab, cloud service, account, telemetry, or global
install. Candidate browser registration, context preview, draft persistence,
and loopback planning mutations additionally require a supported
Chromium-family browser; release support remains held until real Chrome passes
the exact-head macOS and Windows composition in ADR 0040. Planning is read-only
with respect to the imported checkout and uses an atomic SQLite operation
admission record to reject concurrent provider work. Approval and execution
remain Linux-only: they use the Milestone 1 kernel lease through util-linux
`flock` at `/usr/bin/flock`, and execution additionally requires Docker with
seccomp support and a locally present digest-pinned check image.

## Quick start

```text
pnpm install --frozen-lockfile
pnpm workflow:setup
pnpm check
```

`workflow:setup` is a one-time, checksum-verified bootstrap of the pinned
actionlint release into ignored `.local/` state. The release gate then lints
every GitHub Actions workflow and proves the validator rejects a known-invalid
fixture before running the remaining checks.

Start the local workspace with a dedicated state root:

```text
export ICARUS_HOME="${XDG_STATE_HOME:-$HOME/.local/state}/icarus"
pnpm workspace:start
```

On Windows PowerShell, keep the state beneath the current user profile:

```text
$env:ICARUS_HOME = Join-Path $HOME ".icarus-state"
pnpm workspace:start
```

Open the exact one-time launch URL printed by the process only in a supported
Chromium-family browser. The default server binds exact IPv4 `127.0.0.1` on an
ephemeral port and, after verifying that bind, creates a CSPRNG-selected
16-byte lowercase-hex `.localhost` public origin plus an independent
fragment-only mutation bearer. It performs no Node/operating-system lookup,
hosts-file edit, or browser resolver injection. The client removes the
fragment before render, every non-GET/HEAD request requires the exact session
headers, and no cross-origin access is enabled. This remains a candidate boundary until ADR
0040's real Chrome native gate passes. Importing and previewing a repository
reads its committed Git objects;
it does not copy, edit, check, commit, or push the source. Planning is available
through the candidate mutation session only when the chosen model is served by
loopback Ollama. Until an endpoint and model are entered, the workspace clearly
reports provider and execution capabilities as `unconfigured`. Saving a
configured draft contacts no provider; the separate plan action does. Approval
and execution continue through the Linux CLI only.

For presentation-only Vite development, start a stable GET-only API with
`ICARUS_PORT=8787 pnpm workspace:start`, then run `pnpm workspace:ui` in a
second terminal. Use this explicit-port `127.0.0.1` mode for Safari, Firefox,
embedded webviews, and every unverified/default browser. It emits no bearer and
intentionally cannot submit forms; the server cannot detect an unsupported
browser or automatically downgrade a random `.localhost` navigation that never
reaches it.

The existing CLI golden path begins with:

```text
node packages/cli/dist/main.js init
node packages/cli/dist/main.js repo add \
  --name fixture \
  --path /absolute/path/to/repository
node packages/cli/dist/main.js project add \
  --name fixture-project \
  --repo fixture \
  --base-ref main \
  --check '{"id":"verify","name":"Verify fixture","argv":["python","checks/verify.py"]}' \
  --sandbox-image 'python:3.12-slim@sha256:c3d81d25b3154142b0b42eb1e61300024426268edeb5b5a26dd7ddf64d9daf28'
```

On POSIX systems, the state root must be a dedicated, current-user-owned `0700`
directory. On Windows, it must be strictly beneath the current user profile and
inherits that profile's ACL; locations outside the profile are rejected. On
every platform, an existing root must be empty or already contain Icarus's exact
marker. Filesystem roots, symlink parents, and any path inside a Git checkout are
rejected before Icarus creates the state root. Project registration separately
rejects repository/state containment in either direction before persisting the
repository or project. Network, shared, and synced directories are unsupported
and must not be used for Icarus state.

Set `ICARUS_CHROMIUM_EXECUTABLE` to an explicit local Chromium binary, then
`pnpm smoke:workspace:browser` builds the production assets and drives the
project → context → draft → browser reload → plan → evidence path in real
headless Chromium without a resolver override. Candidate release acceptance
additionally requires the same composition in real Chrome at one exact commit
on macOS 15 arm64 and Windows Server 2025 x64.
Focused integration tests also cover restart before planning, useful errors for
malformed provider URLs and missing repositories, and populated HTTP evidence
for an already completed CLI run.

Plan with local Ollama:

```text
node packages/cli/dist/main.js run plan \
  --project fixture-project \
  --task "Replace the greeting and run the registered check" \
  --target src/greeting.txt \
  --provider ollama \
  --model <installed-model>
```

Plan with OpenAI's Responses API:

```text
# Set OPENAI_API_KEY through your shell's secret manager first.
test -n "$OPENAI_API_KEY"
node packages/cli/dist/main.js run plan \
  --project fixture-project \
  --task "Replace the greeting and run the registered check" \
  --target src/greeting.txt \
  --provider openai \
  --model <approved-model> \
  --input-usd-per-million <current-rate> \
  --output-usd-per-million <current-rate>
```

Icarus does not embed model pricing because pricing changes. A remote run with a
cost ceiling requires explicit rates so that the ceiling is enforceable. The
first remote command stops before egress and prints a context digest; continue
only after reviewing it:

```text
node packages/cli/dist/main.js run approve-egress <run-id> \
  --context-sha <displayed-digest> --actor kevin
```

Continue the run with separate operator decisions:

```text
node packages/cli/dist/main.js run approve <run-id> \
  --plan-sha <displayed-digest> --actor kevin
node packages/cli/dist/main.js run status <run-id>
node packages/cli/dist/main.js run review <run-id> \
  --decision approve --diff-sha <displayed-diff-digest> --actor kevin
node packages/cli/dist/main.js run rollback <run-id> \
  --diff-sha <displayed-diff-digest> --actor kevin
node packages/cli/dist/main.js run restore <run-id> \
  --checkpoint-sha <displayed-checkpoint-digest> --actor kevin
```

Use `run list [--project <name>]` to rediscover persisted run IDs and `run
history <run-id>` to inspect the append-only transition and approval record.

Review rejection performs the bounded rollback directly. A later explicit
restore rewrites only the recorded approved bytes and reruns verification.

Provider secrets are read from the process environment and are never stored in
the Icarus database. Credential-prone configuration paths are protected from
model context and edits; safe configuration content may still be included in a
tracked sandbox snapshot. See `docs/OPERATIONS.md` before using a non-fixture
repository.

## Documentation

- [Release readiness](docs/README.md)
- [Product requirements](docs/PRD.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Implementation plan](docs/PLANS.md)
- [Decision index](docs/DECISIONS.md)
- [Threat model](docs/THREAT_MODEL.md)
- [Operations](docs/OPERATIONS.md)
- [Evaluation strategy](docs/EVALS.md)
- [Roadmap](docs/ROADMAP.md)
