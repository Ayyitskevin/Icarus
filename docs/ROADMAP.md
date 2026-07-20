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

Status: planned.

Add a local API and React workspace for projects, run timeline, approvals, diff,
tests, terminal evidence, prompt history, and a small task board. Include
repository status, live events, file tree, checkpoints, and token/cost telemetry.
Provider keys remain server-side.

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

Close the M0/M1 repair, exact-head hosted-CI, and inherited-workflow security
holds first. Then add a read-only explanation run and its evaluation. It
exercises richer context without widening filesystem or command authority.
