# ADR 0036: Proof-carrying software factory product direction

- Status: Accepted product direction — implementation staged; ADR 0026 local
  corrections pass, with publication/hosted/native release evidence outstanding
- Date: 2026-07-30
- Supersedes: the current product positioning and roadmap sequencing in
  [`FABLE_ICARUS_VISION.md`](../FABLE_ICARUS_VISION.md) sections 1, 11, and 13.
  Its point-in-time audit,
  accepted-ADR history, safety boundaries, and reserved ADR numbers 0027–0035
  remain intact.
- Related:
  [ADR 0023](0023-transactional-multi-file-patch-sets.md) (transactional
  PatchSets),
  [ADR 0026](0026-agent-session-loop-and-tool-registry.md) (bounded agent
  session), and [ADR 0022](0022-native-macos-windows-acceptance.md) (native
  acceptance)

## Context

Icarus began as a local provenance and recovery kernel. The current candidate
has the beginnings of a software factory: transactional multi-file PatchSets,
digest-bound approvals and capability grants, a two-turn failed-verification
session, private Git worktrees, no-network registered checks, append-only
evidence, rollback and restore, and Ollama, OpenAI, and Anthropic adapters.

That foundation is unusually rigorous, but it is not yet a competitive product.
The workspace is review-only, finished work cannot land on a branch or pull
request, context retrieval is shallow, and Icarus has no editor integration,
preview environment, application service catalog, customer database, deployment
plane, collaboration model, or extension protocol.

The operator has now made the intended category explicit: Icarus should become
his AI software factory and compete directly for the outcomes served by Cursor,
VS Code, Replit, and Supabase. That goal conflicts with the historical wording
that Icarus is “not a browser IDE” and “not a hosted platform” if those phrases
are interpreted as permanent product limits.

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

The explicitly authorized local correction now closes both paths with
initial/live/compacted/resumed remote canaries, full local evidence retention,
and a byte-exact legacy broad-grant refusal. This remains the baseline,
release-adjusted product score: closing the defects improves trust evidence but
does not by itself raise the sparse product-surface scores. Publication,
exact-head hosted CI, native acceptance, and the remaining release reviews are
still open.

## Decision

### Product promise

Icarus will compete on the governed task-to-running-application outcome:

> Task → explicit authority → bounded agent work → transactional change →
> reproducible verification → evidence receipt → reversible Git landing →
> isolated preview or service change.

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
| 0034 | worker/task-envelope boundary |
| 0035 | signed evidence-bundle export |

## Delivery sequence and exit gates

### Gate 0 — restore release truth

1. Close the remote check-output egress defect without discarding full local
   operator evidence.
2. Bind mutation grants to exact plan targets and recheck that invariant before
   any private-worktree effect.
3. Complete the remaining ADR 0026 crash, cancellation, atomicity, compaction,
   truncation, check-order, and Docker-reconciliation evidence.
4. Synchronize candidate documentation and evaluator sequencing.
5. Run the exact-tree focused suites, `pnpm check`, evaluator, dependency
   audits, diff check, cold security review, and hosted CI.

Local status on 2026-07-30: items 1–4 are complete, and item 5 passes through
the focused/full gates, evaluator, both dependency audits, diff check, and two
independent security-boundary reviews. Exact-head hosted CI, native acceptance,
and final release review remain open because the tree is intentionally
uncommitted and unpublished.

Exit gate: zero known authority bypasses; remote canary data outside approved
context/manifest never reaches a provider; malformed mutation scope changes no
worktree bytes; all local gates pass on one tree; exact-head hosted CI and
native acceptance are recorded honestly. Two role-neutral review artifacts must
name the exact tree, reviewer lane, reviewed surfaces, rerunnable commands,
findings, and disposition: one security-boundary review and one final
architecture/release review. Fleet guard and Sonnet lanes may produce those
artifacts, but the repository gate does not depend on a named proprietary
reviewer.

### Gate 1 — Verified Change Gate

Draft and accept ADR 0029 browser approval authority and ADR 0027 Git landing,
then implement them:

- server-start session token, same-origin/CSRF protection, digest-bound action
  forms, CLI parity, live activity, and explicit capability display;
- branch and commit inside the private Git cache;
- allowlisted push plus draft-PR creation behind a separate landing grant;
- evidence receipt attached to the pull request;
- no force-push, merge, deployment, or source-checkout mutation authority.

Exit gate: task → plan/grants → repair → review → draft PR succeeds on three
representative repositories; reload/restart preserves the session; rejection
and interruption are reversible; every external mutation has an exact approval.
Before claiming this gate, publish a versioned benchmark manifest that pins one
TypeScript library, one Python CLI, and one React/Node application by repository
and commit; pins one repair task, task digest, provider/model version, prompt
revision, registered checks, and expected changed-path set per repository; and
records the resulting branch, commit, draft-PR, and evidence-receipt identities.
Success is three of three tasks with passing registered checks, exactly the
expected changed paths, a reviewable draft PR, and an unchanged source checkout.

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

### Gate 3 — VS Code workbench

Ship a thin extension over the headless API: selection/task submission,
plan/grant review, session activity, diff/check evidence, recovery, and landing.
Do not fork Code-OSS until this extension proves product demand.

Exit gate: Linux, macOS, and Windows installation; three language stacks;
selection/task → verified draft PR; session survives window reload. A versioned
30-task manifest must contain ten TypeScript, ten Python, and ten full-stack
tasks across repair, refactor, and scaffold classes. Completion means registered
checks pass and a reviewable draft PR is produced. “No manual file edit” means
the operator changes no repository content between plan approval and landing;
at least 21 of 30 tasks must meet that definition.

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
- The single-operator local-first path remains the proving ground. Hosted
  multi-tenancy, collaboration, Kubernetes, an editor fork, and proprietary
  backend primitives remain non-goals until measured demand changes the
  decision.
- This ADR authorizes product direction only. It does not authorize a commit,
  push, PR, schema migration, provider egress, service creation, deployment, or
  other live mutation.
