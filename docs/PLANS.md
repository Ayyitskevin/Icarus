# Implementation plans

## Most recently accepted plan: third M3 bounded older-activity navigation

Status values are evidence claims. The ADR 0016 implementation, fresh local
acceptance, independent audit, and exact published implementation-head hosted CI
passed on 2026-07-20. This accepts the third bounded M3 slice; it does not claim
that full M3 is complete.

### Historical metadata contract

- [x] Add one selected-run reverse metadata endpoint with exactly one canonical
      positive `before` cursor, one canonical positive pinned `snapshot`, and a
      fixed service-owned 64-event page
- [x] Use an index-backed descending `LIMIT 65` query over sequence, run ID,
      type, and timestamp only; never select or decode `payload_json`
- [x] Validate run existence, current high-water, pinned snapshot, exclusive
      cursor, contiguous sequences, bounded event type/timestamp, `nextBefore`,
      and `hasMore` in one coherent SQLite read transaction
- [x] Return only the existing host-label/fixed-anchor metadata projection and
      keep historical and live cursors completely independent

### Explicit browser navigation

- [x] Open older activity only from an operator action when the coherent recent
      timeline is truncated; pin the first page to that run response's revision
- [x] Pause and abort live polling while the panel is open, then resume it
      immediately on close without advancing its cursor from historical pages
- [x] Permit one historical request, abort on hidden/close/selection/unmount,
      and reject late responses with exact run/cursor/snapshot generations
- [x] Replace rather than accumulate pages, allow at most four historical pages
      per panel session while retaining one 64-row page plus at most three
      newer-page cursors, and provide older/newer controls with CLI guidance
      beyond that window
- [x] Preserve the last successful page on failure, expose honest retry/busy/
      partial states, and describe any evidence link as current—not historical

### Scope and safety

- [x] Add no schema/migration, dependency, write, event append, Git/source read,
      dirty-path/file-content disclosure, diff/check/event payload presentation,
      stream, watcher, daemon, or browser action authority
- [x] Preserve loopback Host/Origin, same-origin/CSP, fixed presenter, React-text,
      guarded CLI, source-isolation, portability, and ADR 0010 boundaries
- [x] Leave workspace-wide run and approval pagination, file/status views, richer
      diff/history payloads, patch materialization, browser approval, and
      execution explicitly deferred

### Acceptance coverage and commands

- [x] Store/API tests cover more than 200 events, reverse page boundaries,
      reopen stability, invalid cursors/snapshots, gaps, index use, corrupt and
      private payload non-disclosure, zero writes, and negative action routes
- [x] Pure client tests cover page replacement, four-page depth, older/newer,
      mismatched run/cursor/snapshot, noncontiguous data, and stale responses
- [x] Real-browser acceptance covers explicit load-older navigation, fixed
      current-evidence anchors, failure/retry, no overlap, live pause/resume,
      hidden/selection/unmount cancellation, and preserved newer selection
- [x] Source and SQLite evidence proves browsing changes no checkout or durable
      state
- [x] `pnpm format:check`
- [x] `pnpm lint`
- [x] `pnpm typecheck`
- [x] `pnpm test`
- [x] `pnpm test:integration`
- [x] `pnpm security`
- [x] `pnpm build`
- [x] `pnpm check`
- [x] `pnpm smoke:workspace`
- [x] `ICARUS_CHROMIUM_EXECUTABLE=/absolute/path/to/chromium pnpm smoke:workspace:browser`
- [x] `pnpm audit --audit-level high`
- [x] `pnpm audit --prod --audit-level high`
- [x] `git diff --check`
- [x] Hosted `ci` succeeds at the exact published implementation head

Fresh local candidate evidence on 2026-07-20:

- `pnpm check` exited 0: 122/122 unit/provider tests across 15 files and
  37/37 integration tests across 8 files passed; evaluation reported 5 passed,
  0 failed, and 5 explicitly unsupported; 109 security tests and 21 static
  assertions passed; typecheck, formatting, lint, and the 19-module Vite build
  completed successfully. Lint retained 26 inherited informational
  `useTemplate` diagnostics and no errors.
- Store/API regressions exercise more than 200 events, exact reverse boundaries,
  reopen stability, malformed metadata and sequence gaps, index use, corrupt
  private payloads, and zero logical writes. Pure client tests exercise
  replacement, the four-page cursor window, older/newer navigation, exact
  response identity, and stale-response rejection.
- The real Brave smoke pinned revision 507, displayed first-page sequences
  244–307, navigated and replaced four pages, retained the last page across an
  injected failure, and followed the historical `#run-context` current-evidence
  anchor. It proved active-live, hidden, close, and selection request
  cancellation; contended single-flight controls; rejection of a delayed
  cancellation-ignoring success; focus restoration; private-payload omission;
  unchanged logical SQLite state; zero browser errors; zero blocked external
  requests; and an unchanged source fingerprint.
- `pnpm smoke:workspace`, both high-severity dependency audits, and
  `git diff --check` exited 0. The dependency audits reported no known
  vulnerabilities.
- Independent backend, UI, safety, and final correctness audits approved the
  implementation. The query-plan regression currently copies the production SQL
  literal exactly; that low-severity maintenance drift risk remains documented
  rather than introducing a one-use query abstraction.
- Hosted `ci` run 29779180238 passed the deterministic release gate,
  production dependency audit, and whitespace check in 1 minute 2 seconds at
  exact published implementation commit
  `e99067c4d21aa5991b9cc49b17a925c0b9b4529a`.

## Prior accepted plan: second M3 read-only observation slice

Status values are evidence claims. The ADR 0015 implementation, fresh local
acceptance, and exact published implementation-head hosted CI passed on
2026-07-20. This accepts the second bounded M3 slice; it does not claim that full
M3 is complete.

### Repository observation

- [x] Add a project-scoped, read-only repository observation endpoint whose
      availability, worktree, HEAD, branch, and configured-base-relation fields
      are independent
- [x] Keep missing repositories, identity mismatches, unresolved refs, and
      observation failures explicit so none can masquerade as a clean worktree;
      represent detached HEAD as `branch: null` without changing truthful
      worktree cleanliness
- [x] Return no dirty filenames or counts, file content, repository/private
      runtime paths, or raw Git output
- [x] Use only fixed read-only Git controller operations with network, hooks,
      external programs, prompts, and optional index locks disabled
- [x] Keep every observation point-in-time and nonpersistent: no project/run
      update, event append, cache, worktree, or source-checkout mutation

### Event metadata and live review

- [x] Add a read-only selected-run event endpoint ordered by sequence, with an
      exclusive sequence cursor and one fixed service-owned maximum page size
- [x] Return only event sequence, type, host-controlled label, timestamp, and a
      fixed host-generated `evidenceSection`; never return `payload_json` or
      derive browser text from it
- [x] Build each full run response—run, approvals, and timeline—from one coherent
      SQLite read snapshot, with the latest included event sequence as its event
      cursor; keep event metadata pages as separate requests
- [x] Short-poll only the selected run while the document is visible, with one
      current request, visibility pause, selection/unmount abort, bounded failure
      backoff, success reset, and a revision guard against late responses; accept
      a full run response only when its event cursor is at least the newest
      observed event revision
- [x] Link live items only to a closed set of Icarus-generated evidence anchors;
      never form identifiers or navigation targets from untrusted text

### Scope and safety

- [x] Add no Server-Sent Events, WebSocket, filesystem watcher, schema migration,
      runtime dependency, background daemon, or browser action authority
- [x] Preserve the existing loopback Host/Origin, same-origin, bounded-response,
      text-rendering, source-isolation, guarded CLI, and Docker boundaries
- [x] Keep browser approval, mutation, checks, arbitrary commands, commit, push,
      deployment, and patch materialization out of the slice
- [x] Keep richer file/status, diff, and history navigation, including dirty
      filenames/counts and event payload presentation, explicitly deferred
- [x] Preserve the inherited ADR 0010 operator security hold without changing or
      blessing `.github/workflows/opencode.yml`

### Acceptance coverage and commands

- [x] Focused unit/integration coverage proves sanitized independent status
      fields, nonpersistence, fixed event bounds/cursors, payload omission, and
      coherent full-run reads plus the cross-request event-revision guard
- [x] UI coverage proves selected-run-only polling, visibility pause,
      selection/unmount abort, bounded backoff, stale-response rejection, fixed
      anchors, truthful failures, and no added browser authority
- [x] Source fingerprint and Git-metadata evidence proves observation leaves the
      imported checkout unchanged
- [x] `pnpm format:check`
- [x] `pnpm lint`
- [x] `pnpm typecheck`
- [x] `pnpm test`
- [x] `pnpm test:integration`
- [x] `pnpm security`
- [x] `pnpm build`
- [x] `pnpm check`
- [x] `pnpm smoke:workspace`
- [x] `ICARUS_CHROMIUM_EXECUTABLE=/absolute/path/to/chromium pnpm smoke:workspace:browser`
- [x] `pnpm audit --audit-level high`
- [x] `pnpm audit --prod --audit-level high`
- [x] `git diff --check`
- [x] Hosted `ci` succeeds at the exact published implementation head

Fresh local candidate evidence on 2026-07-20:

- The six focused changed-file suites passed 58/58 tests. The full gate passed
  116/116 unit/provider tests across 14 files and 37/37 integration tests across
  8 files. Final-audit regressions cover configured-hook rejection from a
  tampered private cache and an ambiguous action transition whose prerequisite
  falls before the 200-row tail.
- `pnpm check` exited 0: 77 files passed formatting; lint reported no errors and
  26 inherited informational `useTemplate` diagnostics; typecheck passed;
  evaluation reported 5 passed, 0 failed, and 5 explicitly unsupported; 109
  security tests and 20 static assertions passed; and Vite built 18 modules.
- `pnpm smoke:workspace` reached `awaiting_approval` with one provider request,
  `not_run` verification, two assets, and an unchanged source fingerprint.
- The real Brave/Chromium smoke observed repository status
  `not_observed -> clean -> dirty -> clean`, without disclosing the dirty marker;
  proved deferred project-selection safety, visible/hidden polling pause and
  resume, one held request with no overlap, cancellation on unmount, late-response
  rejection, selected-run URL binding, injected event failure with about 4.0 s
  recovery, and fixed `#run-context` evidence navigation. A metadata-only event
  appended while the run remained selected caused a successful event-page read,
  a subsequent exact-run snapshot GET, and rendered `resume requested` evidence
  without refresh or reselection. The smoke reported zero browser errors, zero
  blocked external requests, and an unchanged source.
- The coherent full-run claim is backed by one explicit SQLite read transaction
  plus bounded/corrupt-payload store and endpoint tests. No separate
  cross-process WAL-contention stress run is claimed.
- `git diff --check` reported no errors. Four concurrent focused reruns of the
  sandbox wire suite passed 40/40 tests after its hosted-runner cold-start budget
  was separated from the fake command's deliberate hang.
- Full and production dependency audits reported no known vulnerabilities.
- Hosted `ci` run 29772889807 passed the release gate, production dependency
  audit, and whitespace check in 1 minute 9 seconds at exact published
  implementation-and-test-fix commit
  `59507808e58ef2090aa9cebe4af5a165f00f1078`.
- Config-hook rejection and command-scope `post-checkout` disabling are exercised
  structurally on the Git 2.43 host. The fail-closed regression does not depend on
  Git executing the command, but a real Git 2.55 configured-hook execution run is
  not claimed.

## Prior accepted plan: first M3 local workspace vertical slice

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

The inherited ADR 0010 security hold remains separate from local feature work.
ADR 0016 implements only bounded older event metadata for the third M3 slice.
Workspace-wide run and approval pagination, file/status views, richer diff or
payload-bearing history, patch materialization, browser approval, and execution
remain later, explicitly reviewed expansions. See `docs/ROADMAP.md`.
