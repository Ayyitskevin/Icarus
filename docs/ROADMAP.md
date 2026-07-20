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

Status: first bounded vertical slice accepted on the final working tree
(2026-07-20); full M3 remains open.

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

The next M3 feature slice is read-only repository status plus live event and
evidence navigation. Later M3 scope includes richer run timelines, file and diff
views, checkpoints, prompt history, a small task board, token/cost telemetry,
server-held provider profiles, and deliberately designed approval/recovery
controls. Patch materialization is not the next slice. Any browser execution
path needs a separate safety contract and evidence; provider keys remain
server-side.

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

## Next recommended slice

Preserve the ADR 0010 security hold and implement only the next bounded feature
slice: read-only repository status plus live event and evidence navigation.
Keep patch materialization, browser approval, and execution out of that slice;
each authority expansion needs its own contract and evidence.
