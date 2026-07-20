# Implementation plans

## Current plan: Milestone 0 plus minimal Milestone 1

Status values are evidence claims. A checked item must be backed by a command or
test named below.

Status: repaired candidate passes the local gate; release hold on 2026-07-19.

M0/M1 must not be called complete until a candidate commit passes the full local
gate, GitHub reports a successful `ci` run for that exact commit, and Kevin makes
the security decision recorded in ADR 0010 for the inherited OpenCode workflow.

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
- [x] Baseline format, lint, typecheck, tests, eval, security, build, audit, and
      diff checks at published commit `2b0c14f`
- [x] Adversarial review identified release blockers and produced re-runnable
      test targets
- [x] Full repaired candidate gate and adversarial targets pass
- [ ] Hosted `ci` succeeds at the exact repaired candidate commit
- [ ] Kevin decides whether to disable or harden the inherited OpenCode workflow

### Repair continuation

The named tests and full local gate now pass on one candidate tree:

- [x] Reject repository/state overlap before creating the requested state root
- [x] Keep atomic-write temporaries outside the worktree and clean failed writes
- [x] Fail timed-out checks even when the child exits zero
- [x] Redact known credentials reflected by thrown provider transport errors
- [x] Retain complete bounded evidence for every verification attempt in
      append-only history
- [x] Exercise malicious repository instructions through the real prompt and
      prove they cannot widen the selected target or host policy
- [x] Prove the production Docker sandbox cannot reach public, host-loopback, or
      Tailscale address space
- [x] Emit and validate the schema-v2 measured evaluation report with five M1
      executable outcomes and five honest unsupported M2+ capabilities

## Acceptance evidence

The milestone release gate is `pnpm check`, followed by `pnpm audit --audit-level
high`, the schema-v2 production-lifecycle evaluator, the named adversarial tests,
and `git diff --check`. Hosted CI and the OpenCode decision are separate mandatory
release evidence; neither can be inferred from a local pass.

Baseline local evidence at published commit `2b0c14f` on 2026-07-19:

- `pnpm check`: formatting, lint, typecheck, 46 unit/provider tests, 7
  integration tests, the fixture evaluator, 12 security tests plus the static
  security scan, and the final build passed.
- `pnpm eval`: 5 passed, 0 failed, and 5 explicitly unsupported; the executable
  replacement check ran through the production no-network Docker sandbox.
- `pnpm audit --audit-level high`: no known vulnerabilities.
- The CLI integration suite covered both Ollama and OpenAI lifecycles, separate
  egress/plan approvals, source isolation, review, rollback, restore, resume,
  cancellation, and interrupted-operation charging.
- Subsequent adversarial review found gaps in pre-write overlap validation,
  atomic-write crash placement, timeout outcome handling, known-secret transport
  errors, historical verification evidence, and evaluation depth. The repair
  checklist above supersedes the earlier no-runtime-blocker conclusion.
- The workflow syntax was parsed and the staged patch passed whitespace checks.
  The repository is published at `Ayyitskevin/Icarus`; `.github/workflows/ci.yml`
  is configured for `main` pushes and pull requests. GitHub reported the
  `2b0c14f` push as `startup_failure` with no jobs, and the active `ci` workflow
  had no run. Hosted success therefore remains missing rather than passed.

Repaired candidate local evidence on 2026-07-19:

- `pnpm check`: exit 0; formatting, lint, typecheck, 52 unit/provider tests,
  10 integration tests, schema-v2 evaluation, 12 security tests plus the static
  security scan, and the final build passed.
- `pnpm eval` within the gate: 5 passed, 0 failed, 5 honestly unsupported;
  all ten required measurement categories were present and aggregated.
- Focused state-root, Git-write, provider-redaction, timeout, store-history, and
  security regressions passed; the real Docker containment integration passed.
- Independent adversarial re-review closed every reported runtime/evidence
  finding and found no new blocker.
- `pnpm audit --audit-level high` and `pnpm audit --prod --audit-level high`:
  no known vulnerabilities.
- Checksum-verified `actionlint` v1.7.12 accepted both workflow files; `git diff
  --check` produced no errors.

The generated measured eval artifact is `.local/eval-report.json` and remains
untracked. After publication, the remaining exact-head command is:

```text
gh run list -R Ayyitskevin/Icarus --workflow ci.yml --commit <candidate-sha>
```

## Deferred plan

First close the repair, exact-head hosted-CI, and ADR 0010 security holds. The
next feature slice after release is a read-only explanation run using the same
context and history boundaries. It should not widen write or shell permissions.
See `docs/ROADMAP.md`.
