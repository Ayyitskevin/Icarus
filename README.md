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

> **Release status:** Gate 0's release/evidence head is
> `802b91e6f6c9b392f56c9ee3660be818a0f74a62`, with Linux, macOS, and Windows
> evidence. The current repository carries an implemented interim
> authenticated browser-mutation session and its client capability state.
> Random numeric `127/8` origins were rejected after native run `30613980911`
> passed Windows and failed macOS. ADR 0040's technical gate subsequently
> passed at exact implementation commit
> `eb01b6406c12126c60add7ac83800f8eba8ffdc9` in Linux CI
> `30618041483` and native real-Chrome run `30618043377` on both platforms.
> Explicit human acceptance of the interim operator-controlled
> browser/resolver/proxy residual risk was recorded on 2026-07-31. This is not
> a Gate 1 release. Packet 2's closed eight-action browser lifecycle is
> release-accepted at implementation head
> `3683087066efb65255f05b2493fd31051c3ad7c6`, which was published on `main`.
> [PR #22](https://github.com/Ayyitskevin/Icarus/pull/22) candidate
> `701952349e0818cead37672df951ed09c0edd27c` passed hosted run
> `30760607215` and native macOS/Windows run `30760619650`, then rebase-merged
> as `ba38856a0e0e63d1045500185b2158a0859469d1`. A post-merge macOS smoke
> exposed a timing-only acceptance-harness defect; the timing-harness
> correction at
> `3683087066efb65255f05b2493fd31051c3ad7c6` passed hosted run `30761189188`
> and native macOS/Windows run `30761192370`. Packet 3 now completes the
> durable, no-network local landing slice through `local_ready`: it snapshots one
> exact completed run, binds one landing decision to the canonical digest,
> deterministically builds the reviewed candidate in the private cache, and
> creates or reconciles the exact private `refs/heads/icarus/<run-id>` ref only
> under durable prior-absence and intent evidence. Packet 4a's bounded GitHub
> gateway package is merged; the S2b-ii slices wire the landing coordinator to
> it through `landed` (read-only preflight, immutable object upload, one
> absent-only remote ref, and the one-POST-ever draft PR with its immutable
> receipt), and S2b-iii presents that receipt read-only through the CLI, the
> API run projection, and the workspace landing panel.
> Packet 4's credential-gated live-evidence profile completed 3/3 on 2026-08-23
> against disposable private repositories with Actions disabled, producing
> three reviewable draft pull requests and immutable landing receipts. This
> closes the Gate 1 live-evidence requirement. Live-state migration, deployment,
> and unattended use against an active repository remain held behind a
> supervised canary; the live record authorized no merge or deployment.

## Current scope

Milestone 0 supplies the product, architecture, security, operations, eval, and
roadmap contracts plus repeatable quality gates. The Milestone 1 slice supplies:

- local repository registration and project metadata;
- deterministic pinned-tree maps and target-applicable `AGENTS.md` context;
- an explicit persisted run state machine;
- Ollama, OpenAI Responses, Anthropic Messages, and Vulcan chat-completions
  planning adapters;
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
after restart. The accepted Gate 1 browser transport binds exact `127.0.0.1`
and uses a fresh 128-bit `.localhost` public origin plus an independent
authenticated mutation session. That path is supported only in real-accepted
Chromium-family browsers. Its exact-head technical evidence now passes; the
operator-controlled browser/resolver/proxy residual risk was explicitly
accepted on 2026-07-31. The Gate 1 live 3/3 requirement later completed on
2026-08-23, while unattended active-repository use remains held behind a
supervised canary. On Linux, an accepted Chromium-family mutation session
now exposes exactly eight server-derived, descriptor-bound lifecycle actions:
egress approval, plan approval, review accept/reject, rollback, restore, resume,
and cancellation. Effects stay inside the existing private-worktree, provider,
checkpoint, and sandbox lifecycle; the browser cannot invent an action or
mutate the imported repository. Explicit-port sessions, non-Linux platforms,
Safari, and every unverified browser remain review-only and expose no guarded
actions.
The workspace reports mutation and planning capability from both the server
mode and the tab's live session; stable or revoked sessions become visibly
review-only and disable the corresponding controls.

The Packet 3 landing mutation path is Linux-only. CLI
`landing prepare/status/decide/resume` commands and the API/browser use the same
bounded landing projection, including the exact authority digest, candidate and
private-ref identities, decision, effects, disposition, warnings, evidence,
revision, and — once the landing has landed — the immutable receipt. Non-Linux
mutation refuses before persistence, Git, credential, or
network effects; the browser presentation itself grants no landing authority.

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
bytes, complete history, and guarded actions remained CLI-only at that
observation slice boundary. Packet 2 later exposed only its closed eight-action
matrix through a separate guarded action contract; the omitted evidence remains
CLI-only.

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
`docs/PLANS.md`; that Gate 0 record remains distinct from Packet 2's later
exact-head acceptance.

[ADR 0036](docs/adr/0036-proof-carrying-software-factory-product-direction.md)
sets the next product direction: Verified Change Gate, browser and VS Code
surfaces, reversible Git landing, governed preview environments, and Supabase
change packs. Icarus will own the authority/evidence kernel and integrate editor,
environment, and backend primitives rather than rebuild them.

The merged Change Rooms implementation (ADR 0041, still Proposed pending an
independent review record) adds a per-run Change Room: a strict
read-only projection derived in one SQLite read transaction from the run row,
approvals, the bounded 200-event metadata tail, safe checkpoint columns,
project check/sandbox configuration, and CLI annotations — the room is the run,
with no room table or parallel state machine. Exactly eleven evidence cards in
fixed lifecycle order carry host-controlled titles, provenance classes, explicit
statuses, bounded references, and truncation/redaction/unavailable-evidence
indicators; the integrity block states that digests prove byte binding and
recorded-evidence integrity only, never fresh authorization or semantic
correctness. A bounded index pages twelve newest-first room summaries under the
same pinned-rowid cursor discipline as the workspace run page, and five fixed
change-context questions return deterministic, model-free answers whose
statements carry evidence receipts plus explicit omissions and uncertainty.
Annotations are CLI-only and append-only — at most 32 per run with 1 KiB bodies,
with recognizable credential material rejected before write — and never advance
run state, events, gates, or digests. Existing state requires a verified backup
and one explicitly approved `run-annotations-v1` migration; see
`docs/OPERATIONS.md`. Those Change Room routes are GET-only reads and add no
browser authority beyond their observation boundary.

The accepted Change Handoff Pack v1 implementation
([ADR 0042](docs/adr/0042-change-handoff-packs.md)) is deliberately separate.
`icarus.change-handoff.v1` is a strict default-deny, lifecycle-metadata-only
artifact built directly from validated Icarus records; the Change Room is never
serialized or filtered into it. It can carry opaque IDs, state/phase, bounded
provider metadata, safe approval/verification/recovery outcomes, fixed host
summaries, counts, digest-only artifact references, a disclosure class, and
explicit omissions/uncertainty. It cannot carry task, plan, code, path, diff,
command/output, annotation, event-payload, credential, URL, or executable-action
content.

The operator must preview exact canonical bytes and their separate payload and
request/preview SHA-256 values, then export with that exact preview digest.
Preview reads a stable WAL-clean database image entirely in memory and returns
`RUN_BUSY` rather than opening or changing source SQLite state when a non-empty
WAL exists. Export requires a current-user-owned parent that is not group/other-writable,
then writes only `icarus-change-handoff.json` and
`icarus-change-handoff-result.json` as owner-only, no-follow, exclusive local
files and never overwrites. Secure Handoff Pack preview, export, verification,
and inspection are Linux-only in v1. Export preflights Linux
descriptor-root/no-follow support and syncs the new directory entry before
success; every handoff command fails closed on other platforms. File-only
`handoff verify` and `handoff inspect` do not open Icarus state or use the
network. All surfaces repeat the governing limit: digests bind bytes and
recorded local evidence; they do not prove authenticity, authorization, truth,
disclosure permission, or authority to execute or land code. Digest references
are integrity identifiers rather than confidentiality controls and may confirm
a correctly guessed low-entropy value.

A later Athena design may map only the handoff schema and digest, Icarus run ID,
correlation ID, safe lifecycle outcome, and disclosure class into an imported
`constellation.event.v1` timeline record. This milestone implements no Athena
client, shared protocol/runtime, receiver identity, delivery, callback, retry,
outbox, message bus, Task Room creation, Minerva trigger, API route, browser
action, Git action, landing, or deployment.

Not yet included: browser actions outside Packet 2's closed eight-kind
lifecycle matrix, arbitrary/provider-native tools, model-written shell commands,
semantic search, commits or pushes,
application previews, current file/status or multi-file and payload-bearing
browser diff/history navigation, deployment, backend platform primitives,
multi-agent orchestration, distributed workers, browser annotation authoring,
live room polling, change-context packet summarization by a future assistant,
free-text questions, and room search.

## Requirements

- Node.js 22.23 or newer in the Node 22 line
- pnpm 9.15 or newer in the pnpm 9 line
- Git 2.40 or newer
- a clean local repository with at least one commit for workspace import

The loopback server and explicit-port review UI support Linux, macOS, and
Windows and require no homelab, cloud service, account, telemetry, or global
install. Browser registration, context preview, draft persistence, and
loopback planning mutations additionally require a supported Chromium-family
browser. The required real-Chrome composition passed at exact implementation
commit `eb01b6406c12126c60add7ac83800f8eba8ffdc9` in native run
`30618043377`; explicit human acceptance of ADR 0040's interim
operator-controlled browser/resolver/proxy risk was recorded on 2026-07-31.
That acceptance does not complete Gate 1. Planning is read-only with respect
to the imported checkout and uses an atomic SQLite operation admission record
to reject concurrent provider work. Approval and execution remain Linux-only:
they use the Milestone 1 kernel lease through util-linux `flock` at
`/usr/bin/flock`, and execution additionally requires Docker with seccomp
support and a locally present digest-pinned check image.

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

`pnpm typecheck`, and therefore `pnpm check`, strictly type-checks the production
Node projects, workspace, tests, native acceptance tests, and shared test
support; `tsconfig.tests.json` closes the test and support source boundary.

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
headers, and no cross-origin access is enabled. The native technical gate has
passed, and the residual operator-controlled browser/resolver/proxy risk was
accepted as an interim boundary on 2026-07-31. Gate 1's live-evidence
requirement is complete; unattended active-repository use remains unreleased.
Importing and previewing a repository reads its committed Git objects;
it does not copy, edit, check, commit, or push the source. Planning is available
through the authenticated mutation session only when the chosen model is served by
loopback Ollama. Until an endpoint and model are entered, the workspace clearly
reports provider capability as `unconfigured`; execution is `unconfigured` on
Linux and `unsupported` elsewhere. Saving a configured draft contacts no
provider; the separate plan action does. On Linux, an accepted Chromium-family
session offers Packet 2's exact guarded lifecycle matrix, with the guarded CLI
as the full-fidelity fallback. Non-Linux and review-only browser sessions
expose no action buttons.

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
headless Chromium without a resolver override. The technical acceptance record
at exact implementation commit `eb01b6406c12126c60add7ac83800f8eba8ffdc9` used real
`Chrome/150.0.7871.187` with CDP `1.3` at
`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` and
`C:\Program Files\Google\Chrome\Application\chrome.exe`; both native jobs
passed in run `30618043377`.
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

Preview and explicitly export a redacted offline Handoff Pack:

```text
node packages/cli/dist/main.js run handoff-preview <run-id> \
  --correlation-id project.change-42 \
  --external-task-ref ATHENA-42
node packages/cli/dist/main.js run handoff-export <run-id> \
  --correlation-id project.change-42 \
  --external-task-ref ATHENA-42 \
  --expected-preview-sha256 <displayed-preview-digest> \
  --output-dir ./icarus-handoff
node packages/cli/dist/main.js handoff verify \
  --input ./icarus-handoff/icarus-change-handoff.json
node packages/cli/dist/main.js handoff inspect \
  --input ./icarus-handoff/icarus-change-handoff.json
```

The expected preview value is the separate request/preview digest, not the
payload digest. Preview makes no writes; it refuses a non-empty SQLite WAL as
`RUN_BUSY`, so stop the ordinary writer and retry after a clean close rather
than manipulating journal files. Export rereads and revalidates state and
refuses stale evidence or either pre-existing fixed output filename.
Secure Handoff Pack commands are Linux-only in v1. Export fails
before output-directory creation when descriptor-root/no-follow support is
unavailable; `verify` and `inspect` remain file-only and do not require or open
`ICARUS_HOME`. They establish internal consistency only, never authenticity or
authority.

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
node packages/cli/dist/main.js run annotate <run-id> \
  --card check_outcomes --text "..." --actor kevin
node packages/cli/dist/main.js run annotations <run-id>
```

To approve and execute exactly one task through the bounded H2b headless path,
pass a strict source profile and host provider catalog as bounded JSON. Each
input accepts exactly one transport: inline JSON, or an operator-owned file for
commands that need stable, reviewable inputs. File inputs are capped at 256 KiB,
must be single-link regular files without symlinked path components or shared
write permissions, and are checked for identity/content changes while read.
Neither record may contain credentials; provider secrets remain in the normal
host environment:

```text
node packages/cli/dist/main.js run approve-headless <run-id> \
  --plan-sha <displayed-digest> \
  --actor kevin \
  --profile-file ./headless-profile.json \
  --provider-catalog-file ./headless-provider-catalog.json
```

Use `--profile-json '<strict HeadlessProfileV1 JSON>'` and
`--provider-catalog-json '<host provider profile array JSON>'` for the equivalent
inline form. Mixing a file and inline form for the same input is refused. The
transport changes no profile, provider, approval, or execution authority; both
forms reach the same strict decoders and canonical digest path.

The command holds the existing Linux run lease from approval through
quiescence, reconstructs the persisted authority binding before the first
effect, and writes the checksum-terminated headless history as JSONL. Since
ADR 0060 the default is propose-only: without `worker.mutation` in the
profile the worker stops after durable patch-set intent and settles
`icarus.headless.worker-proposal.v1` with exit `10`, materializing nothing.
`"mutation": "apply"` in the profile's worker policy is the explicit
approve-and-run opt-in. Exit codes: `0` complete and review-ready, `1`
failure, `2` envelope exhaustion (turns, budget, or doom loop), `3` human
input required, `10` proposed, `130` settled signal cancellation; refusals
exit `1` with a named error before any effect, except an already-spent
invocation envelope, which exits `2` before recording validation or approval.

A Vulcan host-catalog entry is deliberately narrower under ADR 0065. Its URL
must normalize to loopback, both token rates must be explicit and positive,
the worker must be child-free and proposal-only, and the resolution digest
binds seat `icarus` with those limits. The later `apply-headless` act refuses a
Vulcan proposal before recording an apply approval or effect. This conservative
pricing lets Icarus enforce its own per-run dollar ceiling while Vulcan
independently enforces its daily per-seat hosted budget; it does not admit
Vulcan to Gate 1 or authorize a live deployment.

Applying a proposal takes the digest-bound act, which records an `apply`
approval against the exact persisted patch set:

```text
node packages/cli/dist/main.js run apply-headless <run-id> \
  --patchset-sha <proposal-digest> --actor kevin
```

The command re-proves the run, requires the flag to equal the durable
versioned digest over every path, operation, baseline, and approved byte set,
then appends the `icarus.headless.worker-application.v1`
settlement, and repeats byte-identically. A mismatched digest is refused
before any effect. `run approve-headless` and `run apply-headless` also
accept `--max-turns N` and `--max-budget-usd USD`, which only ever narrow the
approved envelope, and the ADR 0061 `--output-format history|stream-json`
selector, which prints the receipt-bound NDJSON stream instead of the default
H0 history; a third identical session tool call lands the run in
`session.exhausted` (`doom_loop`) with exit `2`.
Headless evidence uses H0 history or the ADR 0061 stream; the generic Change
Handoff export remains closed to the headless lifecycle grammar.
It does not approve review, commit, push, deploy, schedule, create child runs,
or configure an external research adapter.

If the process dies after `headless.worker.started`, close that worker's durable
tail explicitly:

```text
node packages/cli/dist/main.js run reconcile-headless <run-id>
```

The H3a command holds the run lease, marks any open operation interrupted with
its full conservative reservation, appends one
`icarus.headless.worker-interruption.v1` settlement, emits checksum-verified
JSONL, and exits `1`. Repeating it returns the same history. It never resumes
execution; ordinary `run resume` is refused until H3b can reconstruct the exact
headless binding.

To inspect what a crashed or settled headless worker durably proves, run the
evidence-only H3b projection:

```text
node packages/cli/dist/main.js run reconstruct-headless <run-id>
```

The command mutates nothing: it holds no lease, appends no event, and records
no resume intent. It recomputes the exact ADR 0047 binding from current
persisted authority and requires the recorded profile, resolution, and binding
digests, then classifies every crash-tail operation as `durably_settled`,
`no_effect`, or `ambiguous`. The single canonical
`icarus.headless.reconstruction.v1` record is metadata for a later
continuation design; it grants no resume, replay, fork, or execution
authority, and repeating the command over unchanged durable bytes prints
byte-identical output.

To continue a reconciled crashed worker exactly once, run the governed H3b
continuation:

```text
node packages/cli/dist/main.js run resume-headless <run-id>
```

The command holds the run lease, recomputes the exact binding from current
persisted authority, and admits continuation only when every crash-tail effect
is durably settled or provably effect-free and each settled
workspace/provider/sandbox effect retains its durable successor intent, so
nothing already settled is re-executed. It records one digest-bound
`headless.worker.resume_requested` event, re-drives only replay-safe stages,
and appends one `icarus.headless.worker-continuation.v1` settlement with the
H2b exit semantics. Repeating it returns byte-identical history. An ambiguous
tail, drifted identity, missing successor intent, or incomplete/effectful
session turn fails closed before any resume intent is recorded. ADR 0063 adds
one closed session case: after a fully settled provider-plus-read-only batch,
the digest-bound `icarus.headless.reconstruction.v2` boundary permits only the
next unspent turn; prior provider and read operations are not replayed. A
crashed continuation is closed by `run reconcile-headless`, after which a
second resume is refused. Ordinary `run resume` still refuses every headless
lifecycle.

A source profile may also declare bounded child runs (ADR 0059) by setting
`worker.childRuns` to `{ "maxDepth": 1, "maxChildren": N }` and adding a
`children` list. Each child specification names a canonical `childId`, a
task, targets strictly inside the parent's approved plan targets, tools
strictly inside the parent's tool set, and budgets strictly inside the
parent's profile budgets; children require a loopback provider. When the
parent's own task reaches review-ready evidence, the worker runs the declared
children sequentially before settling: each child is an ordinary run with
recorded lineage (`run list` shows it), its own plan admitted inside the
spec envelope, its own private worktree, and its own settlement. The child
must also fit the parent's remaining cumulative budget envelope at spawn.
The parent settles only after every declared child settles, and fails with
`HEADLESS_CHILD_FAILED` unless every child reached review-ready evidence.
Children never write into the parent's workspace. Existing state roots take
the one-shot lineage migration via
`ICARUS_APPROVE_SCHEMA_MIGRATION=headless-children-v1` after a backup.
Concurrency, remote-provider children, grandchildren, model-initiated
children, and child write-back remain unavailable.

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
