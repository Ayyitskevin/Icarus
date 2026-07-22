# Implementation plans

## Most recently accepted reliability slice: approval preflight and workflow startup diagnostics

Status values are evidence claims. The candidate implementation, full local
gate, dependency audits, focused adversarial coverage, and independent review
pass. Exact published implementation-head hosted CI also passes; this records
the reliability slice without claiming a broader milestone is complete.

### Zero-job startup forensic conclusion

- GitHub Actions runs
  [29708956142](https://github.com/Ayyitskevin/Icarus/actions/runs/29708956142)
  at `dd081a85d7649a155938b90474366ab6ffc01c13` and
  [29708980883](https://github.com/Ayyitskevin/Icarus/actions/runs/29708980883)
  at `2b0c14f3504aaadcc009043cec02434d0a30bd05` ended immediately as
  `startup_failure` at 00:05:37Z and 00:06:32Z on 2026-07-20. Both expose
  synthetic `BuildFailed` path/workflow metadata, zero jobs, zero check runs,
  and no logs.
- Both commits and the later successful run
  [29712657768](https://github.com/Ayyitskevin/Icarus/actions/runs/29712657768)
  at `39efbf41d3b6a387a3a55e00d26b68b7420ca17d` contain the exact same
  `.github/workflows/ci.yml` Git blob,
  `0cca976adde1f4ed694e9578f328f467dde512ac`. The successful run was
  admitted as the real `ci` workflow and executed its `quality` job.
- The failures fall inside GitHub's critical
  [Incident with GitHub Actions](https://www.githubstatus.com/incidents/8vfyvq16hzh9),
  open from 2026-07-19T23:34:03Z through 2026-07-20T04:44:03Z. GitHub warned
  that new workflows could delay or fail to start; OpenAI
  [independently reported failures and delays](https://status.openai.com/incidents/x65r5tj8)
  for GitHub-dependent workflows during the same incident. As of 2026-07-21, no
  detailed provider root-cause analysis is public.
- The evidence therefore supports a transient GitHub control-plane failure, not
  a repository YAML revision. It is not reproducible after recovery, so no
  runtime or workflow behavior is changed to disguise it. Exact-head hosted
  success remains mandatory evidence.

### Repository-owned workflow validation and guarded execution

- [x] Pin actionlint v1.7.12 by official release-archive and independently
      recorded executable SHA-256 for x64/arm64 Linux, macOS, and Windows;
      execute the Linux x64 path locally and keep other native acceptance explicit
- [x] Make bootstrap explicit, local, ignored, time/size bounded, symlink-aware,
      and fail-closed; never silently fall back to a mutable action or system binary
- [x] Require `pnpm check` to lint every workflow with host-dependent external
      linters disabled and prove the exact binary rejects a known-invalid fixture
- [x] Preflight egress, plan, and review actor/digest/gate prerequisites under
      the run lease before metered validation, while retaining the final
      transactional recheck
- [x] Prove stale egress/plan/review, malformed egress, and failed-verification
      review inputs change no run state, usage, operation/event/approval history,
      provider calls, source checkout, or private worktree
- [x] Run a real failing registered check in the production Docker sandbox,
      refuse review approval, preserve evidence, reject phantom approvals, and
      roll the isolated worktree back to a clean baseline
- [x] Leave the inherited OpenCode workflow and ADR 0010 security hold unchanged

### Acceptance checklist

- [x] Focused build plus store/OpenAI/CLI lifecycle suites
- [x] Pinned workflow bootstrap, idempotence, valid-workflow pass, missing-tool
      failure, and known-invalid negative self-test
- [x] Full `pnpm check`: formatting 82 files; unit/provider 122 tests in 15
      files; integration 38 tests in 8 files; evaluation 5 passed, 0 failed,
      5 unsupported; security 109 tests plus 23 static assertions; build 19 modules
- [x] Full and production dependency audits: no known vulnerabilities
- [x] `git diff --check`
- [x] Independent final review: no blocker, high, or medium findings remain
- [x] Hosted `ci` run
      [29863768917](https://github.com/Ayyitskevin/Icarus/actions/runs/29863768917)
      passed its real `quality` job at exact implementation head
      `f8fe03e399fb46f197bbcbc0df8f1edabbe2e0c9`

## Sixth M3 candidate: bounded approval provenance

Status values are evidence claims. ADR 0019 and its implementation are present
as a local candidate on 2026-07-22. This records only the bounded ordinary
approval projection; the full local gate, independent review, and exact
published-head hosted CI remain required before acceptance.

### Bounded projection and truthful browser copy

- [x] Retain at most the newest 12 approval rows in the ordinary selected-run
      response, ordered oldest to newest within that suffix, with an explicit
      fixed limit, loaded count, and earlier-row exclusion flag
- [x] Query only approval run ID, kind, digest, actor, decision, and timestamp;
      preflight all six direct columns with SQLite storage/byte caps, validate at
      most 13 returned rows, and fail closed on malformed storage class, enum,
      digest, actor, credential-shaped content, or timestamp
- [x] Add and prove the per-run `(run_id)` index plus reverse rowid seek so the
      two-second selected-run poll never scans global approval history and
      same-timestamp random UUIDs cannot reorder append history
- [x] Reconstruct an exact presenter allowlist and omit approval IDs, rowids,
      payloads, private paths, commands, provider material, and errors
- [x] Label actors and digests as recorded provenance rather than current
      authentication or byte-integrity proof; show truncation and complete-CLI
      guidance without claiming a total
- [x] Keep warnings and approval provenance on distinct stable evidence anchors,
      semantic lists and times, focusable targets, and React text rendering

### Scope and evidence

- [x] Preserve complete CLI history and one coherent SQLite read transaction
- [x] Add only one backwards-compatible approval index, with no table/column
      migration, data write, event, Git/source read, provider call, browser
      approval, execution, command, commit, push, or deployment
- [x] Require backup and explicit operator approval before building the index
      against existing non-test state
- [x] Prove an indexed seek with no history-sized scan plus fixed
      returned/decoded approval rows and response size
- [x] Cover 0/1/12/13-row suffixes, all kinds and decisions, same-timestamp
      append ordering with adversarial UUIDs, multibyte/control/format/line-
      separator actor rejection, impossible kind/decision pairs, malformed
      and oversized persisted fields, the exact query plan, API coverage,
      omitted database IDs, client anchor routing, duplicate display identity,
      inert hostile-actor rendering, the no-env/invalid/exact CLI migration
      gate with byte-identical refused state, and static projection/presenter
      guards
- [x] Run the fresh full local gate: 89 files passed formatting; lint had no
      errors; typecheck passed; 158 unit/provider tests and 41 integration tests
      passed; evaluation reported 5 passed and 5 honestly unsupported; 109
      security tests plus 37 static assertions passed; and Vite built 22 modules
- [x] Complete independent final review with no blocker, high, or medium finding
- [ ] Require exact published-head hosted CI before acceptance

## Fifth M3 slice: bounded verification-attempt provenance

Status values are evidence claims. ADR 0018 and its implementation are complete,
with fresh local acceptance recorded on 2026-07-22. Exact published-head hosted
CI remains the PR merge gate and is recorded on the PR; this accepts only the
fifth bounded M3 slice once that gate passes, not full M3.

### Pinned scalar projection

- [x] Add one lazy GET route with exactly one canonical positive selected-run
      event snapshot and no caller-controlled limit, filter, sort, search, or
      pagination
- [x] Select only safe run ID/state fields, never `getRun()` or another full-row
      loader; require the requested snapshot to equal the current high-water mark
      in one SQLite read transaction
- [x] Inspect up to the latest 200 sequences through the existing per-run
      sequence index, validate a contiguous metadata suffix, derive only explicit
      verification-state intervals, retain the newest eight anchors, and
      distinguish event-window truncation from the eight-summary cap
- [x] Preflight `typeof(payload_json) = 'text'` and direct-column
      `octet_length(payload_json)` before parsing: at most 8 MiB per retained
      completion, 16 KiB per selected lifecycle transition, and 1 KiB for the
      observed checkpoint-save event; do not wrap the column in a cast, JSON
      function, or other expression
- [x] Require strict `json_valid(payload_json, 1)`, exactly-once root/nested
      selected keys, expected scalar types, fixed transitions, matching
      outer/nested outcomes and diff digests, and canonical SHA-256 values
- [x] Leave unrelated payloads unread and never return or materialize raw JSON,
      diff, checks, argv, output, changed paths, or extra fields in JavaScript
- [x] Select only expected checkpoint run ID, canonical digest, and bounded
      canonical timestamp through a dedicated query; never materialize baseline,
      approved, or unrelated full-run fields
- [x] Label completed linkage only as recorded digest agreement and
      incomplete/cancelled linkage only as run-checkpoint availability. An absent
      save event in truncated coverage remains not observed, never corrupt

### Explicit bounded browser panel

- [x] Place an inline attempt-summary panel below the current verification
      snapshot and visibly show pinned revision, sequence range, fixed limits,
      loaded summaries, and independent truncation states
- [x] Keep automatic live reconciliation independent, retain a static pinned
      panel, and mark it stale when the selected run advances without
      auto-reloading or advancing the live cursor
- [x] Capture a fresh current run ID/cursor for every explicit Load, Refresh, or
      Retry. Never replay a conflicted request; require operator-triggered
      “Refresh persisted run” before reseeding after a snapshot conflict
- [x] Keep one attempt request current; its local aborter handles hidden document,
      Close, “Refresh persisted run,” older-activity opening, and unmount, while
      parent selection/project changes and Back use aggregate cancellation; reject
      late/mismatched success by run/snapshot/generation
- [x] Attempt-panel Close and run refresh must not cancel an older-history
      request. Before opening older activity, abort the attempt request first,
      then mark history open and launch its request without aggregate cancellation
- [x] Register one aggregate parent auxiliary-read cancellation callback invoked
      only for selected-run/project changes and Back; it invalidates both
      controllers and generations
- [x] Enforce exact keys and constants; coverage formula and count from 1 through
      200; no more than eight attempts; sequence order; exact outcome/relation
      enums; canonical timestamps/digests; checkpoint unions/relations; and
      truncation implications before accepting a response
- [x] Preserve the last valid panel after failure, render honest snapshot-scoped
      empty/completeness copy, and provide CLI guidance without implying a pass,
      byte rehash, current completeness, or a total
- [x] Use labelled/busy/status semantics, digest wrapping, semantic lists/times,
      non-focus-stealing updates, and an enabled verification-section fallback
      when operator Close cannot return focus to a disabled launcher

### Scope and acceptance gate

- [x] Add no schema/migration, dependency, write, event append, checkpoint
      creation/rehash, Git/source read, private evidence disclosure, total count,
      older-attempt pagination, stream, watcher, daemon, browser approval,
      rerun/restore/execution, command, commit, push, deployment, or workflow
      authority
- [x] Preserve the payload-free existing event routes, loopback/same-origin/CSP
      boundary, guarded CLI, workspace-run page, older-activity behavior, and
      unresolved ADR 0010 security hold
- [x] Prove 0/1/8/9 attempts, both truncation modes, exact snapshot conflict,
      concurrent append, save-before-attempt ordering/checkpoint states, gaps,
      TEXT-only storage, strict RFC-8259 acceptance, relevant JSON5 and duplicate
      selected-key rejection, wrong scalar types, unrelated private-payload
      immunity, and ASCII/multibyte exact-bound and over-bound cases at both the
      8 MiB completion, 16 KiB transition, and 1 KiB checkpoint-event ceilings,
      plus fixed response size
- [x] Prove index plans, zero durable writes/events, unchanged source/Git, and
      SQL shape that never selects private checkpoint/full-run columns or returns
      raw event payloads; poisoned excluded columns must not affect the route
- [x] Prove fixed coverage/collection bounds, outcome/relation enums, exact client
      relations, fresh-seed conflict recovery, live reconciliation versus
      operator-refresh behavior, request-local/aggregate cancellation ordering,
      retained retry, staleness, lifecycle/late guards, focus fallback, visible
      copy, and private-sentinel absence in real-browser coverage
- [x] Run the fresh full local gate, both audits, API and real-browser smokes,
      `git diff --check`, and seven independent review passes. Require exact
      published-head hosted CI on the PR before merge; that external result cannot
      be self-recorded in the commit it validates

## Most recently accepted M3 slice: fourth bounded workspace run summaries

Status values are evidence claims. ADR 0017, its implementation, fresh local
acceptance, independent review, and exact published implementation-head hosted
CI passed on 2026-07-21. This accepts the fourth bounded M3 slice; it does not
claim that full M3 is complete.

### Metadata-only run page

- [x] Replace the unbounded full-run collection in `GET /api/workspace` with
      one fixed 12-row summary page; add `GET /api/runs` for a new session or
      strict `before` plus `snapshot` continuation
- [x] Use the intrinsic SQLite rowid B-tree, coherent `MAX(rowid)` snapshot,
      descending `LIMIT 13`, and safe canonical decimal parsing without a
      schema migration or full-run N+1 hydration
- [x] Validate empty history, snapshot/cursor existence and relation, safe rowid
      bounds, run/project IDs, task/target byte limits, exact state, and canonical
      timestamps in one read transaction
- [x] Return only IDs, bounded task/target, state, host-derived phase, timestamps,
      and ephemeral page metadata; never select or decode heavier run columns,
      approvals, or events

### Explicit browser navigation

- [x] Replace rather than accumulate pages; retain one 12-row page plus at most
      three newer cursors for a four-page session with older/newer controls and
      CLI guidance beyond it
- [x] Keep one page request current; abort on hidden/new-page/refresh/selection/
      unmount and reject late or mismatched responses by generation and exact
      `before`/`snapshot`
- [x] Preserve the last successful page on failure with truthful retry/busy
      states; opening a summary lazily fetches the existing full selected-run
      view
- [x] Label sidebar counts as loaded rows and project matches as only the current
      workspace page; never claim a total or complete project history
- [x] Reset to a newest pinned session on run creation or explicit workspace
      refresh without coupling summary cursors to selected-run live/history
      cursors

### Scope and safety

- [x] Add no schema/migration, dependency, write, event append, run deletion,
      database maintenance route, Git/source read, new data disclosure, stream,
      watcher, daemon, or browser action authority
- [x] Preserve loopback Host/Origin, same-origin/CSP, fixed presenter, React text,
      source isolation, portability, guarded CLI, and ADR 0010 boundaries
- [x] Leave project/repository enumeration, selected-run approvals, file/status,
      richer diff or payload-bearing history, patch materialization, browser
      approval, and execution explicitly deferred

### Acceptance coverage and commands

- [x] Store/API tests cover more than 200 runs, fixed page boundaries, empty
      history, rowid gaps, reopen behavior, concurrent insertion, invalid
      cursors/snapshots, query-plan use, corrupt/private heavy-column omission,
      malformed summary metadata, zero writes, and negative action routes
- [x] Pure client tests cover replacement, four-page depth, older/newer, exact
      cursor/snapshot identity, stale responses, retained failure state, and
      summary-to-full-run separation; failed or stale lazy detail cannot discard
      the summary page or replace a newer selection
- [x] Real-browser acceptance covers bounded bootstrap, explicit run paging,
      lazy older-run selection, truthful project-page labels, failure/retry,
      replacement contention, hidden/selection/unmount cancellation,
      reverse-order refresh guarding, delayed-response rejection, and
      source/SQLite nonmutation
- [x] `pnpm workflow:setup` (pinned `actionlint` v1.7.12)
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
- [x] Hosted `ci` run
      [29870599549](https://github.com/Ayyitskevin/Icarus/actions/runs/29870599549)
      passed its real `quality` job at exact implementation head
      `01d79b71d10f95e4be9657364057fc6c077ef4fb`

### Acceptance evidence (2026-07-21)

- `pnpm workflow:setup` confirmed pinned `actionlint` v1.7.12, and
  `pnpm check` validated both workflows plus the known-invalid negative fixture,
  formatted 84 files, ran 132 unit/provider tests in 16 files and 39 integration
  tests in 8 files, evaluated 5 passed / 0 failed / 5 unsupported scenarios,
  passed 109 security tests plus 25 static assertions, and built 20 UI modules.
- The real Brave smoke pinned snapshot 50, retained 12 rows inside a four-page
  window, issued 13 strict continuation requests, proved failure retention,
  retries, predecessor replacement, reverse-order refresh guarding, visibility
  and selection cancellation, and delayed page/detail rejection. The unmount
  interception was invalidated by browser teardown while the generation guard
  rejected its late state; private heavy columns remained absent and durable and
  source state remained unchanged.
- `pnpm smoke:workspace` completed with one provider request and an unchanged
  source checkout. Full and production dependency audits reported no known
  vulnerabilities; both working-tree and staged whitespace checks passed.
- Independent backend, frontend, and scope/safety reviews found no remaining
  blocker, high, or medium implementation finding.

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
ADR 0017 implements only bounded workspace-wide run summaries for the fourth.
ADR 0019 bounds only the ordinary newest approval suffix. Project/repository
enumeration, older approval pagination, file/status views, richer diff or
payload-bearing history, patch materialization, browser approval, and execution
remain later, explicitly reviewed expansions. See `docs/ROADMAP.md`.
