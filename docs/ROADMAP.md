# Roadmap

[ADR 0036](adr/0036-proof-carrying-software-factory-product-direction.md)
supersedes the current product positioning and sequencing in
`docs/FABLE_ICARUS_VISION.md`. Icarus now targets the governed
task-to-running-application outcome: a proof-carrying authority kernel with
browser and VS Code surfaces, isolated create-only Git landing with
reconciliation, isolated Replit-class environments, and Supabase integration.
It will integrate editor and backend primitives instead of reimplementing them.
The executable program, including the Buzz-inspired agent mission room and
center-IDE layout, is in the
[Icarus collaborative IDE game plan](ICARUS_COLLABORATIVE_IDE_GAME_PLAN.md).

The current sequence is:

| Gate | Product outcome | Exit evidence |
| --- | --- | --- |
| 0 | Restore release truth for ADR 0026 — **released** | remote-egress and mutation-scope defects closed; missing crash/atomicity/cancellation/compaction evidence added; exact-tree local/hosted/security gates green at `802b91e6f6c9b392f56c9ee3660be818a0f74a62` |
| 1 | Verified Change Gate | populated closed three-stack offline input contract present; a separate human-approved, credential-gated live-evidence profile must bind its digest and immutable case pins, real provider/model and budgets, operator-assessed repository automation, named remote effects, browser digest approvals, deterministic candidate commit, absent-only `icarus/<run-id>` reference, bounded GitHub REST object upload, draft PR, and reconciliation receipt, then succeed 3/3; no direct ref update/deletion, force-push, merge, deployment, or source-checkout mutation endpoint |
| 2 | Context and agent quality | measured explanation/security/refactor evals, retrieval recall ≥0.90 and precision ≥0.60, first-pass plan acceptance ≥80% |
| 3 | VS Code workbench | Linux/macOS/Windows extension, three language stacks, 30 IDE dogfood tasks with ≥70% completed without manual file editing |
| C1 | Read-only agent Council | accepted ADR 0037; 30 tasks across three fixed seeds show predeclared quality lift at non-inferior per-class success, bounded cost/latency, and zero authority violations |
| C2 | Executable Crew | isolated lineage-pinned child runs, explicit write sets, deterministic integration, ≥24/30 fixed multi-module tasks per seed, measurable lift at non-inferior per-class success |
| C3 | Branch rooms | one searchable record joins accepted decisions, patches, combined checks, review, draft PR, and landing receipt |
| 4 | Replit-class environments | three preview templates, cold <60s and warm <10s, bounded logs/processes/package egress, proven restart cleanup |
| 5 | Supabase change packs | isolated migrations/RLS/Auth/Storage/Realtime/functions, rollback/restore and smoke evidence, separate production approval |
| 6 | Delivery and scale | five concurrent branch-pinned tasks, idempotent worker recovery, signed evidence, explicit public-effect approvals |

Gate C2 begins only after Gates 1–3 and the read-only Council evidence. It pulls
the single-operator collaboration contracts in ADR 0033 and ADR 0038 forward.
ADR 0034 retains Athena task envelopes and standing-policy pre-approvals for
Gate 6, which also retains durable background/fleet workers, hosted team
identity, automation, and public-effect scale.

Phase 1's transactional PatchSet boundary is implemented under ADR 0023. Phase
2a's grants, readable manifest, and registry are present. The ADR 0026 slice 2b
candidate closed the cold review's remote check-output egress and
mutation-grant/plan-target defects. At authoring/candidate time, the full local
gate and adversarial regressions passed but the tree remained **HOLD** because
it was uncommitted/unpublished and exact-head hosted CI, native acceptance, and
the remaining release reviews had not yet been recorded.

That historical hold is closed. [PR #18](https://github.com/Ayyitskevin/Icarus/pull/18)
merged as `d4bbcd4aab713bee23237099286e6d9b9f74283b`; the native-fixture
correction followed as the Gate 0 release/evidence head
`802b91e6f6c9b392f56c9ee3660be818a0f74a62`. Linux
[run 30602942008](https://github.com/Ayyitskevin/Icarus/actions/runs/30602942008)
and both macOS and Windows jobs in native
[run 30602949132](https://github.com/Ayyitskevin/Icarus/actions/runs/30602949132)
succeeded at that exact head. Gate 0 is merged and released. At that point,
forward work began with Gate 1 authority contracts and benchmark evidence;
those contracts and PR #20's repository-only foundations have since landed.

The milestone records below are retained as history and as the source of release
holds that remain open. Where their order conflicts with ADR 0036, ADR 0036
governs current sequencing.

## M0 — Foundation

Status: historical foundation gates passed. ADR 0025 later resolved the
inherited workflow decision by hardening; third-party action review and secret
rotation remain release work.

Deliver documentation contracts, workspace tooling, CI, security checks, and
the versioned evaluation fixture catalog.

Release still requires ADR 0025's exact third-party action review and secret
rotation; the disable-versus-harden decision is closed.

## M1 — Golden path

Status: historical golden-path gates passed; its one-file mutation boundary was
superseded by ADR 0023's transactional PatchSets and its fixed repair by ADR
0026's failed-verification session.

Deliver one planned, approved, isolated, verified, reviewable, resumable, and
reversible transactional PatchSet with Ollama and OpenAI adapters. A failed
initial attempt may use the separately approved, bounded ADR 0026 session; its
operator-selected-target lifecycle is covered by the executable fixture eval.

Historical exit gate: every item in `docs/PLANS.md` Phase A-D, Repair
continuation, and Final adversarial continuation is checked with evidence,
hosted `ci` is green at the exact candidate commit, and ADR 0025's residual
release work is closed. Gate 0's exact-head hosted and native evidence is
recorded above; ADR 0025's separate third-party review and secret-rotation work
is not silently discharged by that Gate 0 release.

## M2 — Context intelligence

Status: historical planning record — superseded by ADR 0036 Gate 2.

Add syntax-aware maps, deterministic task/file matching, LSP diagnostics,
language/framework detection, project rules and skills, `rg`-based search,
file-and-line provenance, project memory, semantic retrieval only after baseline
evals, context budget allocation, and retrieval-quality fixtures.

## M3 — Workspace UI

Status: historical implementation record. Eight bounded observation slices were
merged with recorded local, independent-review, and exact implementation-head
hosted evidence. At that slice's authoring/candidate time, native macOS and
Windows host acceptance remained pending, the approval-index rollout against
existing state remained operator-gated, and ADR 0025's residual work
independently blocked release. Exact-head native acceptance is now recorded in
run 30602949132. The browser authority and execution outcome remains governed by
ADR 0036 Gate 1. The Change Rooms implementation merged through
[PR #21](https://github.com/Ayyitskevin/Icarus/pull/21) as
`683c123d37645d0e161e55b2368ef66cff79ef75`; local acceptance, published
implementation-head CI, PR-head CI, and resulting-main CI passed. PR #21 records
no independent review or review decision, however, so ADR 0041 remains Proposed
under the repository's local, independent-review, merge, and exact-head evidence
policy. Full M3 remains open.

Accepted ADR 0042 implements the next bounded offline artifact:
a default-deny `icarus.change-handoff.v1` projection with pure preview,
stale-preview-guarded export, and file-only verify/inspect. The implementation
landed directly on `main` at `133aa38d`; the complete local gate and independent
reviews are green with no remaining blocker, high, or medium finding, and exact
published-head `ci` run `30725709403` passed. It exports fixed local files for an
operator to review and move deliberately. It does not send to Athena, add a
receiver, synchronize lifecycle state, or grant landing or execution authority.

The first slice added a fixed-loopback Node API and same-origin React workspace
for persisted project registration, deterministic committed-tree context
metadata, persisted task drafts, loopback Ollama planning, exact internal run
state plus product phases, and allowlisted plan/action/file/check/output/warning/
timestamp evidence. Registration, preview, drafts, and loopback planning support
Linux, macOS, and Windows under atomic SQLite operation admission. At that slice
boundary, it was review-only for the guarded lifecycle: protected project
registration, draft, and loopback-planning POSTs existed, but browser approval,
edit execution, checks, commit, push, and deployment were not exposed. Guarded
approval and execution remained Linux CLI-only under the kernel lease and Docker
boundary. Missing providers/execution were `unconfigured`; checks that did not
run remain `not_run`.

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

At this slice's authoring time, native macOS and Windows host acceptance
remained to be recorded and the candidate exercised its platform-policy paths
under the Linux test host. Exact-head native acceptance was later recorded for
both hosts in run 30602949132. A registry dependency audit was intentionally
outside that no-network local slice.

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
Packet 2 now supplies that separate safety contract and acceptance evidence for
exactly eight existing lifecycle actions. Any wider browser execution path needs
another explicit contract and evidence; provider keys remain server-side.

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

That observation slice did not expose raw evidence, checkpoint bytes, complete
invocation history, or guarded actions; those remained CLI concerns at its
boundary. Packet 2 later exposed only its closed eight-action matrix.

ADR 0019 implements the sixth merged observation slice. The ordinary selected-run
response retains the newest 12 validated approval decisions and explicit
coverage metadata while complete approval history remains available through the
CLI. The page distinguishes recorded provenance from current authentication or
byte-integrity proof, renders actors only as text, and exposes no approval
action. The fixed result bounds response size and host decoding; it does not
add action authority. A single additive `(run_id)` index plus reverse rowid seek
makes the fixed `LIMIT 13` query avoid a history-sized scan while preserving
append order across equal timestamps and random UUIDs. Building it against
existing non-test state remains an explicit backup and operator rollout gate.

ADR 0020 implements the seventh merged observation slice without adding another route.
The existing coherent selected-run snapshot now labels absent, exact, and
browser-oversized persisted diffs explicitly. Complete patch text is capped at
256 KiB, rehashed against its recorded verification digest, and accompanied by
the exact persisted run state, verification outcome, changed path, size, and
patch statistics. Larger recorded diffs receive metadata-only CLI guidance
rather than a partial preview; this projection does not parse or rehash their
hidden text. The browser does not re-read Git or source and gains no review
action.

ADR 0021 implements the eighth merged observation slice. Workspace bootstrap returns one
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

Status: historical planning record — superseded by ADR 0036 Gates 2 and 4.

Add stronger sandbox profiles, declared application commands, local preview,
environment references, resource limits, and crash recovery drills.

The retained routing direction requires a measured task/context baseline.
Anthropic is implemented in the released Gate 0 baseline. Any xAI, GLM, or
other adapter must arrive one at a time with capability metadata,
pricing/privacy policy, and production-adapter contract tests; providers are
never silently substituted.

## M5 — Backend platform

Status: historical planning record — superseded by ADR 0036 Gate 5.

Add only primitives demanded by an Icarus-managed application: PostgreSQL,
authentication, storage, realtime events, vector search, and background jobs.
When a real application needs them, add a starter/template contract, API layer,
environment references, and deployment configuration rather than claiming a
generic backend platform in advance. Prefer understandable Docker Compose-style
local orchestration; Kubernetes remains out of scope.

## M6 — Multi-agent and fleet workers

Status: historical planning record — superseded by ADR 0036 Gate 6.

Add isolated parallel sessions, role specialization, job envelopes, Mickey/Flow
worker scheduling, Highwind capability routing, heartbeats, retries,
cancellation, idempotency, and resource/cost policies. Treat every host as a
separate node and retain Zenbook as an operator client rather than a worker.

ADR 0042 reserves only a future conceptual Athena seam: handoff schema, complete
payload digest, Icarus run ID, correlation ID, safe lifecycle outcome, and
disclosure class may map one way into a future Athena contract. No other handoff
field maps, and the seam currently has no delivery, callback, retry, shared
database, command, landing, or execution path. Any runtime integration requires
a separate ADR and authority review under Gate 6.

## M7 — Dogfood and hardening

Status: historical planning record — its measurable continuation is distributed
across ADR 0036 Gates 0–6.

Use safe clones/worktrees of the fixture app and, only with explicit scope,
Mise, Kleephotography, Athena, and Chronos. Use the landed bounded
`repair-failing-test` evaluator as the fixture baseline, then add the
still-deferred autonomous diagnostic, refactor, and review capability gates
before widening autonomy. Live production, customer data, deployment targets,
schema changes, and secrets remain human-gated and outside automatic dogfood.

## Current release and acceptance gates

Gate 0 is merged and released at release/evidence head
`802b91e6f6c9b392f56c9ee3660be818a0f74a62`, with successful Linux and native
evidence linked above. This does not claim that the historical observation
slices complete the broader M3/IDE outcome, nor does it silently discharge ADR
0025's separate third-party action review and secret-rotation work. Existing
non-test state still requires a verified backup and explicit operator approval
before the approval-index migration.

Current forward work is Gate 1. PR #20 (`79e6dc7`, implementation head
`bba1591`) merged repository-only foundations for ADR 0029's browser-action
ledger and shutdown settlement plus ADR 0027's landing schema, records,
deterministic candidate construction, and absent-only local reference.
[PR #22](https://github.com/Ayyitskevin/Icarus/pull/22) published the
closed eight-action Linux dispatcher, exact descriptor/receipt authority,
coordinator-bound in-flight cancellation, and prepared/admitted restart
reconciliation without replay. Candidate
`701952349e0818cead37672df951ed09c0edd27c` passed hosted run `30760607215` and
native macOS/Windows run `30760619650`, then rebase-merged as
`ba38856a0e0e63d1045500185b2158a0859469d1`. A post-merge macOS smoke exposed a
timing-only harness defect; corrected Packet 2 implementation head
`3683087066efb65255f05b2493fd31051c3ad7c6`, published on `main`, passed hosted
run `30761189188` plus native run `30761192370` and completed Packet 2 release
acceptance. These guarded lifecycle actions stop before every commit, push, ref,
pull-request, merge, and deployment effect. Packet 3 now completes durable local
landing through `local_ready`: the existing SQLite ledger, ten-minute/eight-
attempt coordinator, digest-bound decision, deterministic candidate, absent-only
private ref, shared CLI/browser projection, and explicit crash recovery operate
without network or source-checkout mutation. Packet 4a's bounded GitHub gateway
package is merged; the S2b-ii slices wire the landing coordinator to it through
`landed`: read-only preflight, immutable object upload, one absent-only remote
reference, and the one-POST-ever draft pull request with its immutable receipt.
S2b-iii presents the receipt read-only through the shared CLI/API/browser
projection. Packet 4's credential-gated live
evidence, live-state migration, and Gate 1 completion remain incomplete.

Slice 1 adds the populated closed input contract at
`fixtures/evals/gate1/manifest.v1.json`, the focused `pnpm benchmark:gate1`
command integrated under `pnpm eval`, and the ignored schema-v1
`.local/gate1-benchmark-report.json`. That report is a closed success/failure
union: success binds the validated manifest digest and all three case
observations, while failure retains only the ordered completed-case prefix,
labels its aggregate counters `partial_completed_cases_only`, and binds the
failure stage, applicable next case, safe code or `null`, and message digest. A
failure report's manifest digest is `null` only when the raw manifest bytes were
unavailable. The local path uses deterministic loopback production-Ollama
transport, no-network sandboxes, and the real local candidate plus absent-only-
ref foundation; each completed-case record's draft-PR and receipt values are
explicitly `not_executed_contract_only`. The manifest's derivative-effect
declaration is `contract-only-unassessed`. For each completed case, the offline
runner reopens the production runtime and replays a harness-only candidate
journal into a new local controller; it does not execute browser reload,
foreground-server restart, or durable landing coordination.

Gate 1 still requires a separate versioned, human-approved, credential-gated
live-evidence profile bound to the offline manifest digest and exact immutable
case/task/check/source/expected-change/candidate pins. It must pin a real
provider/model and adapter version, captured pricing and budgets, and an
operator-produced repository-automation assessment with disposition and raw
assessment digest. It may authorize only named, separately approved Git object
upload, absent-only remote-ref creation, draft-PR creation, and receipt effects,
and must succeed 3/3 against approved real repositories with exact candidate and
live identities. Mock or synthetic model, GitHub, automation, or receipt results
cannot satisfy that gate. No credential, paid model, external network, remote
mutation, live state migration, force-push, merge, deployment, or public release
is authorized or performed by the offline contract runner.

The merged Change Rooms implementation is available as a read-only observation
surface, but ADR 0041 remains Proposed until an independent review is recorded.
The accepted adjacent slice is ADR 0042's standalone Change Handoff Pack v1.
It preserves the existing Change Room behavior and has satisfied fresh focused
unit, integration, CLI, adversarial, full repository, smoke, security,
workflow-audit, dependency-audit, independent-review, direct-main, and exact
published-head gates. Its acceptance does not authorize Athena integration,
establish disclosure permission, or widen any landing or execution authority.

Every future release candidate still requires fresh local evidence, independent
review, merge, and exact published-head hosted CI; platform claims require the
matching exact-commit native evidence.

Older approval pagination, current file/status views, multi-file or raw-payload
browser diff/history, complete browser checkpoint inspection, and every browser
action outside Packet 2's closed eight-kind lifecycle matrix remain separate
expansions until explicitly designed and evidenced. CLI PatchSet materialization
and the failed-verification
session are no longer deferred.

## Measurement tooling

The `icarus probe` verb (2026-08-18) is measurement-only model characterization
through the production provider gateway. It is not a gate, carries no
authority, and its results are never acceptance evidence. Deeper evaluation
entry points (parameterized benchmark runs, unattended eval grants) remain
future, separately reviewed work.

## Gate 1 live-evidence record

ADR 0045 adds the offline live-evidence profile record and its validation. It
authorizes no run by itself: a runner that consumes it, the operator's
repository assessments and credential, the profile approval, and the 3/3 live
attempt all remain outstanding. Gate 1 still closes only on that run.

Its authorization surface was reviewed independently after merge and held on
four findings, fixed 2026-08-21: the pinned provider's credential is now
preflighted alongside each landing credential, manifest case identities must be
distinct, the returned authorization is frozen and the effect ledger copies
rather than retains it, and the ledger binds the landing chain order per case.
Runtime authority is enforced at runtime, not by `readonly`.

ADR 0050 then closed a fourth gap of the same class, found before it could
matter: the record bound the manifest fields deciding which repositories receive
effects but not those deciding which model runs or whether money is spent. The
provider kind, the unpaid-adapter declaration and the case cost ceiling are now
bound at authorization, so the loopback pin chosen for the 3/3 run is an enforced
bound rather than an intention, and reaching a paid model requires a manifest
edit that visibly invalidates the approval.
