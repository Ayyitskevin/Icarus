# Roadmap

## M0 — Foundation

Status: fresh local and exact implementation-head hosted gates passed; security
release hold remains (2026-07-19).

Deliver documentation contracts, workspace tooling, CI, security checks, and
the versioned evaluation fixture catalog.

Release requires Kevin's explicit decision on the inherited OpenCode workflow
in ADR 0010.

## M1 — Golden path

Status: fresh local and exact implementation-head hosted gates passed; security
release hold remains (2026-07-19).

Deliver one planned, approved, isolated, verified, reviewable, resumable, and
reversible one-file change with Ollama and OpenAI adapters.

Exit gate: every item in `docs/PLANS.md` Phase A-D, Repair continuation, and
Final adversarial continuation is checked with evidence, hosted `ci` is green
at the exact candidate commit, and the ADR 0010 security hold is resolved.

## M2 — Context intelligence

Status: planned.

Add syntax-aware maps, deterministic task/file matching, LSP diagnostics,
language/framework detection, project rules and skills, `rg`-based search,
file-and-line provenance, project memory, semantic retrieval only after baseline
evals, context budget allocation, and retrieval-quality fixtures.

## M3 — Workspace UI

Status: the first five bounded slices are merged after fresh local evidence and
exact implementation-head hosted CI. Sixth approval-provenance and seventh
persisted-diff-review candidates remain under their merge gates. The eighth
bounded-project-catalog and JSON-transport candidate is implemented locally and
still requires its local, independent-review, and exact-head hosted gates. Full
M3 remains open.

The first slice adds a fixed-loopback Node API and same-origin React workspace
for persisted project registration, deterministic committed-tree context
metadata, persisted task drafts, loopback Ollama planning, exact internal run
state plus product phases, and allowlisted plan/action/file/check/output/warning/
timestamp evidence. Registration, preview, drafts, and loopback planning support
Linux, macOS, and Windows under atomic SQLite operation admission. It is
review-only: browser approval, edit execution, checks, commit, push, and
deployment are not exposed. Guarded approval and execution remain Linux CLI-only
under the kernel lease and Docker boundary. Missing providers/execution are
shown as `unconfigured`, and checks that did not run remain `not_run`.

Acceptance was recorded from fresh output of these commands; exact results are
in `docs/PLANS.md`:

```text
pnpm exec vitest run tests/unit tests/provider --reporter=dot
pnpm exec vitest run tests/integration --reporter=dot
pnpm smoke:workspace
ICARUS_CHROMIUM_EXECUTABLE=/absolute/path/to/chromium pnpm smoke:workspace:browser
pnpm check
git diff --check
```

Native macOS and Windows host acceptance remains to be recorded; the current
branch exercises its platform-policy paths under the Linux test host. A registry
dependency audit is also intentionally outside this no-network local slice.

ADR 0015 implements project-scoped, sanitized, nonpersistent repository
observation and selected-run live event metadata.
Repository availability, worktree, HEAD, branch, and configured-base relation
remain independent; missing or unresolved state never appears clean. Dirty
filenames/counts, file content, raw Git output, and event payloads are omitted.
Event pages have a fixed service-owned bound and exclusive sequence cursor, and
each separate full run response reads its run row, approvals, and timeline from
one coherent SQLite snapshot. Foreground selected-run short polling pauses with
document visibility, aborts on selection or unmount, backs off within fixed
bounds, and rejects stale responses. It accepts a full response only when its
event cursor is at least the newest observed event revision. Evidence links use
only fixed host-generated anchors. A truncated action history that cannot
re-establish its prerequisite is shown as `unknown`, never guessed from an
incomplete suffix.

The slice adds no SSE, WebSocket, watcher, schema migration, runtime dependency,
or browser authority. Later M3 scope includes richer run timelines, current
file/status, multi-file or payload-bearing diff/history navigation, checkpoints,
prompt history, a small task board, token/cost telemetry, server-held provider
profiles, and deliberately designed approval/recovery controls. Patch
materialization is not the next slice.
Any browser execution path needs a separate safety contract and evidence;
provider keys remain server-side.

ADR 0016 implements the smallest substantive history extension: an explicit,
selected-run page immediately before the recent 200-event tail. It pins a
revision, uses a fixed reverse sequence cursor, selects metadata rather than
payloads, pauses live polling while the bounded historical panel is open, and
keeps only one 64-row page plus a four-page cursor window in the browser. It adds
no Git/source read or action authority. It left workspace-wide run enumeration
and selected-run approval lists as separate follow-up debt at that stage; ADR
0017 and ADR 0019 address those two bounds respectively.

ADR 0017 implements the next outer chronological layer: replace the workspace's
unbounded full-run hydration with a fixed 12-row metadata page and lazily fetch
full evidence only for a selected run. A session-only pinned SQLite insertion
cursor provides indexed `LIMIT 13` work without a schema migration. The browser
replaces pages inside a four-page cursor window and labels project matches as
only the loaded workspace page. Project/repository enumeration remained separate
debt at that stage; ADR 0019 later bounded the ordinary selected-run approval
response and ADR 0021 addresses that catalog debt.

ADR 0018 implements the fifth bounded slice as a separate,
explicit selected-run projection over the latest suffix of at most 200 events,
retains at most eight verification-state intervals, and exposes only validated
statuses, digests, sequences, timestamps, coverage flags, and safe checkpoint
relations. Completed, cancelled, failed-before-completion, and open intervals
are distinguished only when explicit state transitions support the claim.
Missing starts, timeout detail, process identity, formal supersession, and
rollback causality remain unknown. Selected payload scalars sit behind fixed
byte and strict-JSON gates; existing activity routes remain payload-free.

The implementation does not expose raw evidence, checkpoint bytes, complete
invocation history, or guarded actions; those remain CLI concerns.

ADR 0019 implements the sixth candidate slice. The ordinary selected-run
response retains the newest 12 validated approval decisions and explicit
coverage metadata while complete approval history remains available through the
CLI. The page distinguishes recorded provenance from current authentication or
byte-integrity proof, renders actors only as text, and exposes no approval
action. The fixed result bounds response size and host decoding; it does not
add action authority. A single additive `(run_id)` index plus reverse rowid seek
makes the fixed `LIMIT 13` query avoid a history-sized scan while preserving
append order across equal timestamps and random UUIDs. Building it against
existing non-test state remains an explicit backup and operator rollout gate.

ADR 0020 implements the seventh candidate slice without adding another route.
The existing coherent selected-run snapshot now labels absent, exact, and
browser-oversized persisted diffs explicitly. Complete patch text is capped at
256 KiB, rehashed against its recorded verification digest, and accompanied by
the exact persisted run state, verification outcome, changed path, size, and
patch statistics. Larger recorded diffs receive metadata-only CLI guidance
rather than a partial preview; this projection does not parse or rehash their
hidden text. The browser does not re-read Git or source and gains no review
action.

ADR 0021 implements the eighth candidate slice. Workspace bootstrap returns one
pinned newest-first page of at most 12 projects joined to their repositories;
strict `before` and `snapshot` continuation uses an intrinsic-rowid
`LIMIT 13` seek without per-record hydration. Persisted project JSON is
storage- and byte-gated before exact decoding, and supported writes enforce the
same caps. The browser replaces pages inside four retained positions while
preserving independent project selection. Indexed exact lookups replace
creation-path collection scans. A shared pre-header serializer also places an
8 MiB UTF-8 ceiling on every JSON response and emits only fixed safe overflow
copy. The slice adds no schema, source read, provider call, or browser action.

## M4 — Runtime and previews

Status: planned.

Add stronger sandbox profiles, declared application commands, local preview,
environment references, resource limits, and crash recovery drills.

Add capability-aware provider routing only after task/context evaluation has a
measured baseline. Route private/routine work to local models, ordinary reasoning
to configured mid-cost APIs, and difficult planning/review to explicitly
approved frontier models. Add Anthropic, xAI, GLM, and other adapters one at a
time with capability metadata, pricing/privacy policy, and production-adapter
contract tests; never silently substitute providers.

## M5 — Backend platform

Status: planned.

Add only primitives demanded by an Icarus-managed application: PostgreSQL,
authentication, storage, realtime events, vector search, and background jobs.
When a real application needs them, add a starter/template contract, API layer,
environment references, and deployment configuration rather than claiming a
generic backend platform in advance. Prefer understandable Docker Compose-style
local orchestration; Kubernetes remains out of scope.

## M6 — Multi-agent and fleet workers

Status: planned.

Add isolated parallel sessions, role specialization, job envelopes, Mickey/Flow
worker scheduling, Highwind capability routing, heartbeats, retries,
cancellation, idempotency, and resource/cost policies. Treat every host as a
separate node and retain Zenbook as an operator client rather than a worker.

## M7 — Dogfood and hardening

Status: planned.

Use safe clones/worktrees of the fixture app and, only with explicit scope,
Mise, Kleephotography, Athena, and Chronos. Add the deferred repair, refactor,
diagnostic, and review capability gates before widening autonomy. Live
production, customer data, deployment targets, schema changes, and secrets
remain human-gated and outside automatic dogfood.

## Current merge gate

Preserve the ADR 0010 security hold. Do not accept ADR 0021 until its fresh full
local gate, independent review, and exact published-head hosted CI pass with all
blocker, high, and medium findings resolved. Keep the sixth and seventh
candidate gates independent rather than treating this slice as evidence for
them.

Older approval pagination, current file/status views, multi-file or raw payload
diff/history, complete checkpoint inspection, patch materialization, browser
approval, rerun/restore, and execution remain separate expansions until
explicitly designed and evidenced.
