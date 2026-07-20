# Implementation plans

## Current plan: first M3 local workspace vertical slice

Status values are evidence claims. The bounded implementation and acceptance
coverage passed on the final working tree on 2026-07-20. This accepts the first
workspace slice; it is not a claim that full M3 is complete.

### Product and persistence

- [x] Add `@icarus/api` and a React/Vite workspace that call the existing core
      service and SQLite store
- [x] Persist repository/project state and a `preparing` task draft before any
      planning request
- [x] Add deterministic, metadata-only committed-tree context preview with
      `.env*`, dependency/generated, binary/invalid-UTF-8, model-hidden, and
      secret-content filtering
- [x] Keep imported source repositories read-only and keep context previews
      non-persisted
- [x] Reject a state root inside any Git checkout before creating the directory
- [x] Support registration, context preview, draft persistence, and loopback
      planning on Linux, macOS, and Windows, with atomic SQLite operation
      admission before planning work

### Browser authority and evidence

- [x] Bind the server to `127.0.0.1`, serve UI/API from one origin, validate
      Host/Origin, bound JSON bodies, and emit no CORS permission
- [x] Allow only explicitly configured loopback Ollama planning from the browser
- [x] Expose exact internal state plus the seven product phases, allowlisted
      evidence, explicit `unconfigured` capabilities, and `not_run` checks
- [x] Expose no browser route for approval, edit/check execution, arbitrary
      commands, commit, push, deployment, accounts, telemetry, or fleet services
- [x] Return useful errors without persistence for malformed provider URLs and
      missing repositories
- [x] Present populated, bounded evidence for an already completed CLI run
      without exposing private runtime paths

### Acceptance coverage and commands

The focused suites cover state-root rejection before any write, portable
planning admission, draft restart before planning, malformed provider URLs,
missing repositories, and populated completed-run HTTP evidence. The production
browser smoke drives compiled React in real Chromium through project creation,
deterministic context, draft, browser reload, plan, and truthful evidence
while proving the imported source fingerprint remains unchanged.

Fresh acceptance recorded on 2026-07-20:

- [x] `pnpm exec vitest run tests/unit tests/provider --reporter=dot`: 99/99
      tests passed across 13 files
- [x] `pnpm exec vitest run tests/integration --reporter=dot`: 31/31 tests
      passed across 7 files
- [x] `pnpm smoke:workspace`: persisted draft and plan survived restarts,
      provider requests were exactly one, verification remained `not_run`, and
      the source fingerprint was unchanged
- [x] `ICARUS_CHROMIUM_EXECUTABLE=/absolute/path/to/chromium pnpm smoke:workspace:browser`:
      compiled React completed the real Chromium workflow with zero browser
      errors, zero blocked external requests, one provider request, persisted
      reload state, `not_run` verification, and unchanged source
- [x] `pnpm check`: exit 0; formatting, lint, typecheck, 99 unit/provider tests,
      31 integration tests, evaluation (5 passed, 0 failed, 5 unsupported), 109
      security tests, 17 static security assertions, and the 17-module build
      passed
- [x] `git diff --check`: no errors

Native macOS and Windows host runs remain unrecorded; platform-policy paths are
covered on the Linux test host. Registry dependency audit is intentionally not
part of this no-network local slice.

## Prior plan: Milestone 0 plus minimal Milestone 1

Status values are evidence claims. A checked item must be backed by a command or
test named below.

Status: final-adversarial-audit repairs are implemented; the fresh local gate
and exact implementation-head hosted CI passed. The separate security release
hold remains in force on 2026-07-19.

M0/M1 must not be called complete until Kevin makes the security decision
recorded in ADR 0010 for the inherited OpenCode workflow.

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
- [x] Hosted `ci` succeeds at the exact repaired candidate commit
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

### Final adversarial continuation

A final source-level audit reopened the following evidence gaps. Checkmarks are
added only after the fresh full gate and exact-head CI complete:

- [x] Reject common credential paths/content before context or check snapshots,
      including short known secrets supplied to redaction
- [x] Replace stale-path lease cleanup with stable kernel-backed exclusion and
      adversarial race coverage
- [x] Meter bounded Git/filesystem control work against aggregate active runtime
- [x] Prove tool, token, runtime, and cost ceilings with negative tests
- [x] Land operator signal aborts in durable `cancelled` state
- [x] Kill a real approval process during a started provider operation and prove
      conservative resume
- [x] Validate representative scenario-specific fixtures for every deferred eval
- [x] Re-run the complete local gate, security/audit checks, and adversarial review
- [x] Publish the candidate and verify hosted CI at the exact implementation head.

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
untracked. Hosted evidence for implementation commit
`39efbf41d3b6a387a3a55e00d26b68b7420ca17d`:

```text
gh run view 29712657768 -R Ayyitskevin/Icarus
observed: completed successfully; quality job passed in 42 seconds
```

Final adversarial candidate local evidence on 2026-07-20:

- `pnpm check`: exit 0; formatting, lint, typecheck, 74 unit/provider tests, 29
  integration tests, evaluation, 109 security tests, 12 static security
  assertions, and the final build passed.
- `pnpm eval`: 5 passed, 0 failed, 5 honestly unsupported; manifest SHA-256
  `c641797acac61a7cf01e5900d472bb7d346a1922629df46b86473ef19b4d0d1a`.
- Focused adversarial suites passed 161/161 tests; independent cross-cut review
  found no remaining code release blocker.
- Both full and production dependency audits reported no known vulnerabilities.
  Checksum-verified `actionlint` v1.7.12 accepted both workflow files, and
  `git diff --check` reported no errors.
- Hosted `ci` run 29719143172 passed all jobs in 50 seconds at exact
  implementation commit `c56bd9e4026a9c09649110fe1133aea3799f90b6`.

## Deferred plan

The inherited ADR 0010 security hold remains separate from this local feature
branch. After the first workspace slice passes its gate, the next bounded M3
feature is read-only repository status plus live event and evidence navigation.
Patch materialization, file/diff editing, browser approval, and execution remain
later, explicitly reviewed authority expansions. See `docs/ROADMAP.md`.
