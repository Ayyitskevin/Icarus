# ADR 0036: Proof-carrying software factory product direction

- Status: Accepted product direction — Gate 0 released; Gate 1's bounded
  browser and landing paths plus credential-gated live 3/3 evidence are
  complete; Gate 2 has measured deterministic explanation, security-review,
  refactor, repair, scaffold, and schema-successor cohorts plus immutable v1/v2
  30-task contracts and one closed deterministic v2 adoption/replay receipt.
  Live-model, autonomous-planning, and routing evidence remain open. Canary,
  live-state migration, merge, deployment, and unattended authority remain
  closed
- Date: 2026-07-30; progress status updated 2026-08-28
- Supersedes: the current product positioning and roadmap sequencing in
  [`FABLE_ICARUS_VISION.md`](../FABLE_ICARUS_VISION.md) sections 1, 11, and 13.
  Its point-in-time audit,
  accepted-ADR history, safety boundaries, and reserved ADR numbers 0027–0035
  remain intact.
- Related:
  [ADR 0023](0023-transactional-multi-file-patch-sets.md) (transactional
  PatchSets),
  [ADR 0026](0026-agent-session-loop-and-tool-registry.md) (bounded agent
  session), [ADR 0022](0022-native-macos-windows-acceptance.md) (native
  acceptance), and the
  [collaborative IDE game plan](../ICARUS_COLLABORATIVE_IDE_GAME_PLAN.md)

## Context

Icarus began as a local provenance and recovery kernel. At this ADR's
authoring/candidate time, the held Gate 0 tree had the beginnings of a software
factory: transactional multi-file PatchSets, digest-bound approvals and
capability grants, a two-turn failed-verification session, private Git
worktrees, no-network registered checks, append-only evidence, rollback and
restore, and Ollama, OpenAI, and Anthropic adapters. That candidate is now the
released Gate 0 baseline recorded below.

That Gate 0 foundation was unusually rigorous, but it was not yet a competitive
product. At that baseline, the workspace was review-only and finished work could
not land on a branch or pull request; context retrieval was shallow, and Icarus
had no editor integration, preview environment, application service catalog,
customer database, deployment plane, collaboration model, or extension protocol.

The operator has now made the intended category explicit: Icarus should become
his AI software factory and compete directly for the outcomes served by Cursor,
VS Code, Replit, and Supabase. That goal conflicts with the historical wording
that Icarus is “not a browser IDE” and “not a hosted platform” if those phrases
are interpreted as permanent product limits.

The operator has also made multi-agent collaboration a product requirement:
agents should be visible participants in a shared mission room where they can
investigate, disagree, propose a task graph, and then execute through the IDE.
That interaction may resemble Block's Buzz, but Icarus retains host-owned
authority: conversation is not permission, child writes remain isolated, and
only verified PatchSets may enter deterministic integration.

It does not require Icarus to reimplement an editor engine, Postgres, Auth,
Storage, Realtime, or cloud infrastructure. Current category leaders already
have those surfaces:

- Cursor provides cloud agents, parallel work, remote environments, plugins,
  and sandboxing:
  [Cloud Agents](https://cursor.com/cloud),
  [plugins](https://cursor.com/blog/marketplace), and
  [agent sandboxing](https://cursor.com/blog/agent-sandboxing).
- VS Code and GitHub provide mature editing, extensions, local/background/cloud
  agents, approval modes, Codespaces, and pull-request landing:
  [agent model](https://code.visualstudio.com/docs/agents/concepts/agents),
  [approval controls](https://code.visualstudio.com/docs/agents/approvals), and
  [GitHub cloud agent](https://docs.github.com/en/copilot/concepts/agents/cloud-agent/about-cloud-agent).
- Replit combines an editor, agent, shell, preview, managed publishing,
  Postgres, authentication, and object storage:
  [Project Editor](https://docs.replit.com/learn/projects-and-artifacts/project-editor),
  [publishing](https://docs.replit.com/learn/projects-and-artifacts/replit-deployments),
  and [database](https://docs.replit.com/features/data-and-storage/sql-database).
- Supabase supplies Postgres, Auth, Storage, Realtime, Edge Functions, local
  development, isolated branches, and MCP:
  [platform documentation](https://supabase.com/docs),
  [branching](https://supabase.com/docs/guides/deployment/branching), and
  [MCP](https://supabase.com/docs/guides/ai-tools/mcp).

The practical opportunity is therefore not a feature-for-feature clone. It is a
vendor-neutral authority and evidence kernel with initial GitHub and Supabase
adapters. Portability is a contract to prove per adapter, not a claim inferred
from provider-neutral core types.

## Baseline score

The score is against the requested end state, not against the narrower original
milestone:

| Area | Weight | Current score |
| --- | ---: | ---: |
| Trust, safety, and evidence | 20% | 8.0 |
| Autonomous coding capability | 20% | 5.5 |
| IDE/workbench experience | 15% | 2.5 |
| Runnable app/platform capability | 15% | 1.5 |
| Architecture and maintainability | 10% | 6.0 |
| Tests, evals, and release discipline | 10% | 7.5 |
| Extensibility and ecosystem | 5% | 2.0 |
| Product/document coherence | 5% | 4.5 |
| **Weighted product score** | **100%** | **5.0 / 10** |

At the baseline review, the trust score was held below its architectural
potential by two defects in the ADR 0026 implementation candidate:

1. check stdout/stderr can carry repository bytes outside the readable manifest
   into a later remote-provider request; and
2. a mutation grant can be validated against the broader operator selection
   rather than the plan's narrower target set, allowing private-worktree bytes
   to move before durable intent rejects the scope.

The explicitly authorized local correction closed both paths with
initial/live/compacted/resumed remote canaries, full local evidence retention,
and a byte-exact legacy broad-grant refusal. At authoring/candidate time this was
the release-adjusted baseline while publication, exact-head hosted CI, native
acceptance, and the remaining release reviews were still open. Those Gate 0
publication and exact-head evidence conditions are now closed; the 5.0/10 score
still stands because release closure does not by itself raise the sparse
product-surface scores.

## Decision

### Product promise

Icarus will compete on the governed task-to-running-application outcome:

> Task → explicit authority → bounded agent work → transactional change →
> reproducible verification → evidence receipt → isolated create-only Git
> landing with reconciliation → isolated preview or service change.

The differentiated first product is **Icarus Verified Change Gate**:

1. A browser or VS Code entry point submits a task and candidate authority.
2. The headless Icarus kernel assembles context, negotiates grants, and records
   exact approvals.
3. A bounded agent session produces a transactional PatchSet in an isolated
   workspace.
4. Registered checks run in a pinned, fail-closed environment.
5. The operator reviews one evidence bundle.
6. A separate landing grant creates a branch, commit, and draft pull request.
7. Rejection, interruption, or failure restores a durable checkpoint.

Browser approval without Git landing is only a better demo. Git landing without
the evidence contract is only another coding agent. The wedge requires both.

### What Icarus owns

Icarus will build and own:

- the authority, policy, budget, evidence, and recovery kernel;
- provider-neutral, resumable agent-session orchestration;
- transactional code, schema, service, and deployment change contracts;
- browser and IDE review, approval, exception, and recovery experience;
- the mission-room, agent-identity, task-graph, write-isolation, and
  proof-preserving integration contracts;
- Git landing plus CI-result ingestion;
- regression evals, provider comparisons, and signed evidence exports;
- cross-resource receipts tying code, migrations, services, and deployment to
  the approvals that authorized them.

### What Icarus integrates

Icarus will integrate rather than recreate:

- **Editor:** a VS Code extension first, using VS Code's editor, LSP, debugger,
  terminal, SCM, remote workspace, and extension ecosystem. A Code-OSS or
  Monaco shell is conditional on adoption proving it necessary.
- **Source collaboration:** GitHub issues, branches, draft pull requests, CI,
  and review. CRDT live editing is deferred.
- **Workspace:** devcontainer/Docker-compatible environment declarations, with
  optional Codespaces or remote-runner adapters.
- **Preview and testing:** bounded dev-server processes, tokenized forwarded
  ports, and Playwright.
- **Backend:** Supabase local and hosted branch adapters. Icarus does not
  reimplement Postgres, Auth, Storage, Realtime, or Edge Functions.
- **Extensibility:** MCP and plugin manifests wrapped by Icarus grants,
  ceilings, durable operations, and evidence.
- **Hosting and identity:** deployment adapters and established OIDC/SAML
  providers when multi-user demand exists.

Integration never bypasses Icarus authority. An editor command, MCP call,
database migration, preview process, push, or deployment is still a typed,
bounded, separately reviewable operation.

## Reserved follow-on decisions

ADR numbers reserved by the Fable plan remain stable:

| ADR | Reserved decision |
| --- | --- |
| 0027 | Git landing authority |
| 0028 | preview/dev-server sandbox and proxy |
| 0029 | browser approval authority |
| 0030 | retired unused reservation for the ADR 0010 disposition; ADR 0025 is authoritative and no duplicate 0030 will be created |
| 0031 | environments and service catalog |
| 0032 | database migration ledger |
| 0033 | concurrency and branch-pinned base authority |
| 0034 | Athena task-envelope API and standing-policy pre-approval boundary |
| 0035 | signed evidence-bundle export |
| 0037 | Mission Rooms, agent identities, membership, transcript projection, and bounded deliberation |
| 0038 | local child-run and task-envelope authority |

## Delivery sequence and exit gates

### Gate 0 — restore release truth (released 2026-07-31)

1. Close the remote check-output egress defect without discarding full local
   operator evidence.
2. Bind mutation grants to exact plan targets and recheck that invariant before
   any private-worktree effect.
3. Complete the remaining ADR 0026 crash, cancellation, atomicity, compaction,
   truncation, check-order, and Docker-reconciliation evidence.
4. Synchronize candidate documentation and evaluator sequencing.
5. Run the exact-tree focused suites, `pnpm check`, evaluator, dependency
   audits, diff check, cold security review, and hosted CI.

Historical local status on 2026-07-30: items 1–4 were complete, and item 5
passed through the focused/full gates, evaluator, both dependency audits, diff
check, and two independent security-boundary reviews. At that
authoring/candidate-time checkpoint, exact-head hosted CI, native acceptance,
and final release review remained open because the tree was intentionally
uncommitted and unpublished.

Gate 0 release closure was recorded on 2026-07-31. [PR
#18](https://github.com/Ayyitskevin/Icarus/pull/18) merged the candidate as
`d4bbcd4aab713bee23237099286e6d9b9f74283b`; the native-fixture correction
followed as exact `main` `802b91e6f6c9b392f56c9ee3660be818a0f74a62`. Linux
[run 30602942008](https://github.com/Ayyitskevin/Icarus/actions/runs/30602942008)
and both jobs in native
[run 30602949132](https://github.com/Ayyitskevin/Icarus/actions/runs/30602949132)
succeeded at that exact head. Gate 0 is merged and released; forward
implementation began at that point with the Gate 1 contracts and benchmark.
Those contracts and PR #20's repository-only foundations subsequently landed;
the section below preserves the Gate 1 program and records its later outcome.

Exit gate: zero known authority bypasses; remote canary data outside approved
context/manifest never reaches a provider; malformed mutation scope changes no
worktree bytes; all local gates pass on one tree; exact-head hosted CI and
native acceptance are recorded honestly. Two role-neutral review artifacts must
name the exact tree, reviewer lane, reviewed surfaces, rerunnable commands,
findings, and disposition: one security-boundary review and one final
architecture/release review. Fleet guard or independent agent lanes may produce
those artifacts, but the repository gate does not depend on a named proprietary
reviewer.

### Gate 1 — Verified Change Gate

ADR 0029 browser approval authority and ADR 0027 Git landing authority are
accepted. The following was the remaining implementation program:

PR #20 (`79e6dc7`, implementation head `bba1591`) merged the repository-only
browser-action ledger and shutdown settlement plus the landing schema, records,
deterministic candidate builder, and absent-only local-reference foundations.
PR #22 then completed the guarded browser routes, terminal reconciliation, and
bounded recovery slice. Its exact implementation candidate
`701952349e0818cead37672df951ed09c0edd27c` passed hosted run `30760607215` and
native macOS/Windows run `30760619650`, then rebase-merged as
`ba38856a0e0e63d1045500185b2158a0859469d1`. The timing-harness correction is
the Packet 2 implementation head published on `main` as
`3683087066efb65255f05b2493fd31051c3ad7c6`; hosted run `30761189188` and native
run `30761192370` succeeded there. Packet 3 now completes the durable local
portion through `local_ready`: persistence, bounded coordination, digest-bound
decision, deterministic candidate/private-ref creation, presentation, and local
crash recovery. Packet 4a first merged the bounded GitHub gateway without a
runtime caller; Packet 4b later wired the unchanged closed operation table into
the coordinator, added remote landing/PR receipts, and supported the separately
approved credential-gated live 3/3 record completed on 2026-08-23. The list
below names that Gate 1 outcome. Canary, live-state migration, merge,
deployment, and unattended use remain outside it.

Slice 1 adds the populated closed benchmark input at
`fixtures/evals/gate1/manifest.v1.json`. Its focused `pnpm benchmark:gate1`
command is integrated under `pnpm eval` and owns the ignored schema-v1
`.local/gate1-benchmark-report.json`. The report is a closed success/failure
union. Success binds the validated manifest digest and all three case
observations. Failure retains only the ordered completed-case prefix, labels its
aggregate counters `partial_completed_cases_only`, and binds the failure stage,
applicable next case, safe code or `null`, and message digest; its manifest digest
is `null` only when raw manifest bytes were unavailable. The local evaluator uses
deterministic loopback production-Ollama transport, production no-network
sandboxes, and the real local candidate plus absent-only-ref foundation. It has
no credential, paid-model, external-network, remote-mutation, migration,
force-push, merge, or deployment authority. Each completed-case record marks
draft-PR and receipt effects contract-only and not executed, and no command-pass
claim is made by this record. The manifest's derivative-effect declaration is
`contract-only-unassessed`; it is not an operator assessment of real repository
automation. For each completed case, the runner reopens the production runtime
and replays a harness-only candidate journal into a new local controller, but
does not execute browser reload, foreground-server restart, or durable landing
coordination.

- server-start session token, same-origin/CSRF protection, digest-bound action
  forms, CLI parity, live activity, and explicit capability display;
- deterministic candidate commit plus an absent-only
  `refs/heads/icarus/<run-id>` reference inside the private Git cache;
- bounded GitHub REST object upload, absent-only remote-reference creation, and
  draft-PR creation behind a separate landing grant;
- evidence receipt attached to the pull request;
- no direct ref update/deletion, force-push, merge, deployment, or
  source-checkout mutation endpoint; ADR 0027 must disclose and bind the
  repository automation that branch and draft-PR events may trigger.

Exit gate: task → plan/grants → repair → review → draft PR succeeds on three
representative repositories. Same-tab reload retains the current tab-scoped
action session. A foreground-process restart rotates origin and bearer, requires
operator relaunch through the new URL, and recovers the durable workflow rather
than preserving the bearer. Rejection and interruption are reversible; every
external mutation has an exact approval.

The committed versioned input manifest pins exactly one TypeScript-library
repair, one Python-CLI repair, and one dependency-free React/Node module repair
fixture by repository and commit. The third fixture checks Node behavior and a
JSX-to-module contract; it is not runnable-React-application evidence. Each case
pins one repair task and raw task digest, provider/model version,
prompt-revision labels and production planning/edit system-instruction hashes,
complete ordered registered-check IDs, names, and argv, exact expected
changed-path set, expected object format, raw source and approved-repair pins,
and deterministic candidate-object identities. The manifest is immutable input,
not a place to write run outcomes. A separate generated result records the
input-manifest digest and resulting local candidate and branch identities only
on success, while explicitly marking draft-PR and receipt effects not executed.
A failure result instead contains only its completed-case prefix, partial effect
counters, and bounded failure identity; it cannot infer observations from the
active failed case.

The committed populated contract and its synthetic local report do not satisfy
the exit gate. Before claiming Gate 1, a separate versioned, human-approved,
credential-gated live-evidence profile must bind the offline manifest digest and
reuse its exact immutable case, task, registered-check, source, expected-change,
and candidate pins. The live profile must additionally pin the real
provider/model and adapter version, captured pricing and spend/runtime budgets,
and an operator-produced assessment of each real repository's branch/PR-triggered
automation, including the assessment disposition and raw digest. It may authorize
only named, separately approved Git object upload, absent-only remote-reference
creation, draft-PR creation, and receipt effects. Success remains three of three
tasks with passing registered checks, exactly the expected changed paths, exact
candidate and live branch/commit/draft-PR/receipt identities, a reviewable draft
PR, and an unchanged source checkout. Mock or synthetic model, GitHub,
automation, or receipt evidence can never substitute.

### Gate 2 — context and agent quality

Add deterministic `rg`, repository map v2, stack detection, symbols/LSP,
project rules and memory, retrieval budgets, and planner/coder/reviewer routing.
Provider-native tools remain adapters behind the same host authority rather
than an alternate execution path.

Exit gate: codebase explanation, security review, and module refactor evals
become measured; retrieval recall is at least 0.90 and precision at least 0.60;
first-pass plan acceptance is at least 80%. Before claiming routing improvement,
publish a versioned 30-task benchmark manifest with fixed task/repository
revisions, ten repair tasks, five refactors, five explanations, five security
reviews, and five scaffolds. A success means the scenario evaluator passes with
zero incorrect edits. Compare the same model versions, captured price table,
and tasks against a fixed single-provider baseline; routing must lower median
cost per success by at least 30% without lowering the success count.

Progress checkpoint (2026-08-28): the first closed retrieval baseline still
measures one pinned unfamiliar-codebase fixture at recall `1.0` and precision
`1.0`. The retriever now also normalizes test/check vocabulary and follows one
deterministic source-reference hop from query-matched files inside the same
file/byte ceilings. A separate cohort executes all five manifest-bound
explanation cases through the production Ollama adapter against frozen loopback
responses. Every case retrieves every expected path under one independent
eight-file budget,
host-validates its file-and-line citations, binds task/base/retrieval/provider/
evaluator evidence, and proves zero source or Git-metadata change. Recall and
digest coverage are `1.0` in all cases; precision is `1.0` once and `0.75` four
times (macro `0.80`). This is five-case contract-integration evidence, not
live-model semantic quality or Gate 2 exit evidence. A second cohort executes
all five manifest-bound security-review cases through a dedicated bounded result
seam. Three cases require exact finding IDs and two require explicit
source-backed no-finding evidence. Recall and digest coverage are `1.0`; precision
is `1.0`, `0.50`, and `0.75` three times (macro `0.75`). It preserves the same
source/Git and zero-mutation boundaries, but frozen responses and citations do
not establish live-model security judgment, semantic entailment, or whole-
codebase coverage. A third cohort executes all five refactor cases through
production plan approval, PatchSet application in private workspaces,
digest-pinned no-network Docker checks, local review, and durable runtime
reopen. Every final check passes with exact changed paths and final bytes;
retrieval recall/provenance are `1.0`, macro precision is `0.80`, and all five
first plans reach approval. Operator-selected targets, including one existing
non-mutating create-path anchor, mean that acceptance measures host-contract
integration rather than autonomous discovery or live-model planning quality.
The required versioned
30-task manifest and result vocabulary are published:
they pin seven repository fixtures, task and evaluator identities, each selected
model route, the common versioned model pool and per-model estimated rates, and
all exit thresholds. The contract-only command still validates 30 cases and
executes 0 by design. Each partial cohort executes 5 and leaves 25 unexecuted.
A fourth cohort executes five repair cases through the same production
lifecycle with exact operator-selected paths, final bytes, baseline outcomes,
sandbox checks, local review, source/Git invariance, and durable reopen. Its
retrieval recall and provenance are `1.0`, macro precision is `0.80`, and all
five first plans reach approval; operator selection still means autonomous
discovery is not measured. The four cohorts' union covers 20 distinct cases and
leaves 10 repair/scaffold cases without execution evidence. Manifest v1's
schema repair and scaffold cases request protected `migrations/` paths; current
production policy correctly refuses them, so resolving that mismatch requires a
versioned benchmark decision rather than weakened policy or an in-place rewrite
of immutable input. A fifth cohort executes four more modify-only repair cases
through the same lifecycle: all four failing baselines reproduce, final checks
pass, source/Git state remains unchanged, and durable runs reopen. Its
recall/provenance are `1.0` and macro precision is `0.875`. The five partial
reports cover 24 distinct cases and leave 6 unexecuted, but their union is not a
synthetic full-suite result or a claim that the 24/30 threshold passed. None
supplies a routing claim. A sixth cohort executes four policy-compatible
scaffold cases through the same lifecycle: all four failing baselines reproduce,
seven creates and one modification reach their exact final bytes, and every
completed run survives reopen. Scaffold-A retrieval provenance is `1.0`, macro
precision is `0.875`, and macro recall is honestly `0.9375` because one expected
greeting context path is absent. The six partial reports cover 28 distinct
cases and leave only the schema-repair and task-priority migration cases
unexecuted. Their identity union remains neither a synthetic full-suite result
nor a claim that the full-suite threshold passed. Live-model quality,
autonomous target discovery, the full-suite threshold, and paired routing
comparison remain open.

Manifest v2 resolves that input mismatch without weakening production policy.
It exact-binds manifest v1 SHA-256
`43159d8a174312e7fd720fbb625173601e7c90f6e5983c62c206b69ce99c9558`,
preserves 28 cases byte-for-byte, and replaces only the two protected-path tasks
with offline `schema/` snapshot and `checks/` contract work. Its SHA-256 is
`0eca6348be7848bac44922bcf426defdbd581af8ef790515e28c231b5fbc69c5`.
The two-case successor cohort reproduces both failing baselines, passes both
registered final checks, records recall/provenance `1.0` and precision `0.75`,
and reopens both completed private runs. Its independent report leaves 28 v2
cases unexecuted. The seven source reports are not added arithmetically: a
separate adoption contract freezes and exact-validates their bytes, replays each
through its owning result validator, proves every adopted v1 case is unchanged
under v2, and binds 28 adopted plus two direct observations into one v2-ordered
30-case receipt. That receipt meets the deterministic task-count, success,
retrieval, provenance, and incorrect-edit thresholds. It leaves the plan
threshold unmet because plan evidence covers only 20 mutation cases, and it
does not measure live-model quality, autonomous target discovery, or the paired
routing comparison; Gate 2 therefore remains incomplete.

### Gate 3 — VS Code workbench

Ship a thin extension over the headless API: selection/task submission,
plan/grant review, session activity, diff/check evidence, recovery, and landing.
Place the IDE in the center of a three-surface workbench with reserved agent
mission-room and authority/evidence containers. Gate 3 does not admit
participant provider calls or room-state migrations. Do not fork Code-OSS until
this extension proves product demand.

Exit gate: Linux, macOS, and Windows installation; three language stacks;
selection/task → verified draft PR; session survives window reload. A versioned
30-task manifest must contain ten TypeScript, ten Python, and ten full-stack
tasks across repair, refactor, and scaffold classes. Completion means registered
checks pass and a reviewable draft PR is produced. “No manual file edit” means
the operator changes no repository content between plan approval and landing;
at least 21 of 30 tasks must meet that definition.

### Collaboration track C1 — read-only Council

Draft and accept ADR 0037 before the first participant provider call or
collaboration schema change. It governs identity, membership, per-participant
egress authority, exact transcript/context projection digests, provider-
operation intent and reconciliation, cancellation/replay, payload bounds and
retention, and additive migration backup/rollback.

Council then provides independent read-only proposals, comparison, dissent,
synthesis, and operator approval that may create one ordinary Icarus run. No
participant receives mutation authority.

Exit gate: a versioned 30-task planning/review benchmark runs across three fixed
seeds with predeclared primary outcomes, defect denominator/severity, and
per-class success non-inferiority. Council must produce at least three
additional primary-outcome successes or at least 25% fewer actionable review
defects at non-inferior success versus the same-model single-agent baseline.
Require no security-task regression, zero unapproved access, 100% replay and
recovery under injected interruption, median cost per success at most 1.75×
baseline, and median latency at most 2×. Failure keeps Council optional and
blocks write-capable collaboration.

### Collaboration track — executable Crew and branch rooms

After Gates 1–3 and the read-only Council exit evidence, draft and accept ADR
0033 concurrency/branch-pinned base authority and ADR 0038 local child-run and
task-envelope authority. ADR 0034 retains the Fable plan's Athena delegation
boundary for Gate 6. ADR 0037 separately governs room identity, membership,
transcript projection, and bounded deliberation.

Add a host-scheduled task graph, explicit write sets, isolated branch-pinned
child worktrees, per-child grants and budgets, PatchSet-plus-evidence return,
deterministic integration, combined-tree verification, and a branch room
joining decisions, patches, checks, review, and landing receipts. Every
dependent task pins an immutable input tree materialized from the root plus
ordered accepted ancestor PatchSets; independent nodes alone may share the root
and run concurrently.

Exit gate: 30 fixed multi-module tasks run across three fixed seeds with
predeclared primary outcomes, defect rubric, and per-class success
non-inferiority. At least 24 of 30 succeed per seed with passing combined
checks. Crew must add at least three primary-outcome successes or reduce
actionable review defects by at least 25% at non-inferior success against the
strongest single-agent baseline. Adversarial write-collision, egress,
stale-lineage, cancellation, and restart fixtures are mandatory. There are zero
write races, authority widenings, duplicate external effects, or source-
checkout mutations; median cost per success stays below three times baseline
and median latency below 2.5×. Public effects, background fleet execution, and
team identity remain Gate 6.

### Gate 4 — Replit-class environments

Draft and accept ADR 0028 preview authority and ADR 0031 environments, then
implement them:

- first-class `Environment`, `SecretRef`, declared dev-server process, bounded
  logs, tokenized preview proxy, restart/cleanup, and templates;
- registry-scoped package installation with lockfile evidence;
- no arbitrary network or host-shell fallback.

Exit gate: React/Node, Python, and one full-stack template preview on a
versioned Linux benchmark runner with at least 4 vCPU, 8 GiB RAM, SSD storage,
and pinned base images. Cold means an empty project/package cache with the
declared base image already present; warm means an unchanged lockfile and
populated project cache. Median of five runs per template must be under 60
seconds cold and 10 seconds warm. Restart and crash cleanup are proven; no
unapproved egress; locks, logs, process identity, and environment digests remain
in the evidence chain.

### Gate 5 — Supabase change packs

Draft and accept ADR 0032 migration evidence, then implement it on isolated
Supabase-local or preview branches:

- migration and RLS changes, functions, Auth configuration, Storage policy,
  Realtime declarations, read-only inspection, backup, and restore;
- exact project/environment identity and secret references, never stored secret
  values;
- a separate production-apply approval. A preview success never implies
  production authority.

Exit gate: on the Gate 4 benchmark runner, a local-provider run reaches a
running full-stack application in at most 30 minutes and at most three
interactive approvals: plan/grants, review plus preview landing, and isolated
service/migration apply. Approval count means distinct persisted approval
records; no standing policy is silently counted as human consent. Remote egress
adds its existing separate approval, and production apply always adds another
separate approval outside this target. Migration rollback/restore and Auth,
Storage, Realtime, and function smoke tests pass; production remains impossible
without its own gate. A versioned change-pack benchmark manifest must pin the
full-stack template and repository revisions, task and prompt digests, local
provider/model/version and generation settings, Supabase CLI and service-image
digests, registered smoke tests, and expected resource identities. Timing starts
when the persisted task is submitted after the runner and declared base images
are ready, and ends only when the tokenized preview, smoke checks, and evidence
receipt are complete.

### Gate 6 — delivery and scale

Add deployment adapters, concurrent branch-pinned runs, a queue/worker protocol,
grant-scoped MCP, signed evidence bundles, and enterprise policy/identity only
after the single-operator product is proven.

Exit gate: five concurrent tasks on one repository without cross-talk;
idempotent process/worker recovery; replayable signed evidence; explicit human
approval for every public, production, or irreversible mutation.

## Product measures

The roadmap is governed by outcomes rather than feature count:

- successful verified tasks per operator-week;
- median task-to-draft-PR and task-to-running-preview time;
- percent completed without manual file editing;
- first-pass plan acceptance and first-pass check pass rate;
- recovery success after injected crashes and cancellations;
- provider cost and tokens per successful task;
- Council/Crew quality lift, duplicate-work ratio, and cost/latency multiplier;
- approval count per successful application;
- zero unapproved reads, writes, egress, pushes, migrations, deployments, or
  secret persistence.

## Consequences

- Icarus remains headless at its authority boundary while gaining browser, IDE,
  environment, and backend surfaces through adapters.
- The direction positions Icarus to compete with Cursor/VS Code without funding
  an editor engine, and with Replit/Supabase without rebuilding their
  infrastructure; adoption and benchmark evidence must prove that consequence.
- The strategy increases product scope substantially, so each external effect
  requires an ADR, typed grant, recovery contract, and executable evidence.
- The single-operator local-first path remains the proving ground. Bounded
  multi-agent collaboration is now a differentiated product track; hosted
  multi-tenancy, Kubernetes, an editor fork, and proprietary backend primitives
  remain non-goals until measured demand changes the decision.
- This ADR authorizes product direction only. It does not authorize a commit,
  push, PR, schema migration, provider egress, service creation, deployment, or
  other live mutation.
