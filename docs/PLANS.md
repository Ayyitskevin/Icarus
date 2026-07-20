# Implementation plans

## Current plan: Milestone 0 plus minimal Milestone 1

Status values are evidence claims. A checked item must be backed by a command or
test named below.

Status: complete on 2026-07-19.

### Phase A — foundation

- [x] Repository guidance and all required product/architecture/operations docs
- [x] ADRs for stack, persistence, mutation boundary, providers, and context
- [x] pnpm workspace, strict TypeScript, formatting, lint, test, build, security,
      fixture validation, and CI commands
- [x] Evaluation fixtures for all ten required scenario classes

### Phase B — planning boundary

- [x] Project registration and exact check configuration
- [x] SQLite schema, transactional state transitions, events, and artifacts
- [x] Deterministic repository map, rules loading, `.gitignore`, provenance, and
      context budget
- [x] Provider-neutral port and capability metadata
- [x] Real Ollama and OpenAI Responses HTTP adapters
- [x] Strict one-file proposal validation and `awaiting_approval` stop

### Phase C — controlled execution

- [x] Separate remote-egress and plan-digest approval records
- [x] Stale-HEAD refusal, private Git cache, and detached worktree at base commit
- [x] Lexical and symlink-safe path validation
- [x] Preimage-bound, unique exact replacement with baseline capture
- [x] Exact registered checks in a digest-pinned no-network Docker sandbox with
      no host fallback, timeout, cancellation, resource limits, redaction, and
      bounded output
- [x] Changed-file verification, diff, usage, evidence, and checkpoint storage
- [x] Review approval/rejection, rollback, checkpoint restoration, and resume

### Phase D — evidence and closeout

- [x] Unit tests for state, budgets, path safety, redaction, and proposal parsing
- [x] HTTP adapter integration tests
- [x] Full golden-path integration test proving source-checkout isolation
- [x] Permission rejection, provider retry/resume, rollback, and restore tests
- [x] Fixture evaluator reports supported, failed, and unsupported honestly
- [x] Format, lint, typecheck, tests, eval, security, build, audit, and final diff
- [x] Adversarial review; synchronize this plan, decisions, and roadmap

## Acceptance evidence

The milestone release gate is `pnpm check`, followed by `pnpm audit --audit-level
high`, an end-to-end CLI smoke run against a temporary fixture, and `git diff
--check`. Network-dependent audit results are reported separately from the
deterministic gate.

Closeout evidence on 2026-07-19:

- `pnpm check`: formatting, lint, typecheck, 46 unit/provider tests, 7
  integration tests, the fixture evaluator, 12 security tests plus the static
  security scan, and the final build passed.
- `pnpm eval`: 5 passed, 0 failed, and 5 explicitly unsupported; the executable
  replacement check ran through the production no-network Docker sandbox.
- `pnpm audit --audit-level high`: no known vulnerabilities.
- The CLI integration suite covered both Ollama and OpenAI lifecycles, separate
  egress/plan approvals, source isolation, review, rollback, restore, resume,
  cancellation, and interrupted-operation charging.
- Independent adversarial review findings were fixed and re-reviewed with no
  remaining runtime blocker.
- The workflow syntax was parsed and the staged patch passed whitespace checks.
  The repository is published at `Ayyitskevin/Icarus`; `.github/workflows/ci.yml`
  runs the same gate on `main` pushes and pull requests. Hosted results remain
  separate evidence and must be checked at the exact commit being reviewed.

## Deferred plan

The next recommended slice is a read-only explanation run using the same context
and history boundaries. It should not widen write or shell permissions. See
`docs/ROADMAP.md`.
