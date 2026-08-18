# Implementation plans

## Accepted Gate 1 Slice 1 offline benchmark checkpoint

Status: the versioned, deterministic, zero-external-effect offline benchmark
contract is implementation-complete in the current tree. This closes Slice 1's
offline contract deliverable only. Gate 1 remains open. This offline report
itself claims no live provider/model run, GitHub object or ref effect, draft pull
request, landing/GitHub receipt, or durable landing-coordinator evidence;
Packet 2's separate browser-authority record appears below.

### Completed offline contract

- [x] Add one closed three-case input manifest for a TypeScript-library
      repair, Python-CLI repair, and dependency-free React/Node module repair
      fixture; the React/Node case is not runnable-React-application evidence
- [x] Pin raw task/source/approved-repair bytes, repository and candidate Git
      identities, prompt-revision labels and production planning/edit
      system-instruction hashes, exact ordered registered-check vectors, expected
      changed paths, immutable sandbox images, and budgets
- [x] Run the production Ollama adapter only against deterministic loopback HTTP,
      registered checks only in production no-network sandboxes, and candidate/
      absent-only-ref work only in temporary Icarus-owned state
- [x] Generate an ignored closed schema-v1 success/failure result; bind the exact
      validated manifest digest and all three observations only on success;
      retain only the ordered completed-case prefix and
      `partial_completed_cases_only` counters on failure, with bounded stage/
      case/safe-code-or-null/message-digest identity and a `null` manifest digest
      only when raw manifest bytes were unavailable
- [x] Label completed-case draft-PR and receipt effects
      `not_executed_contract_only`; keep credential, paid-model, external-network,
      remote-mutation, migration, force-push, merge, and deployment authority at
      zero
- [x] Reopen the production runtime and replay a harness-only candidate journal
      into a new local controller, then reject duplicate local-ref replay; do not
      present this as browser reload, foreground-server restart, or durable
      landing-coordinator evidence
- [x] Treat the manifest's derivative-effect declaration as
      `contract-only-unassessed`, not as evidence about automation configured on
      a real repository

### Gate 1 live-evidence hold

- [ ] Define and separately approve a versioned credential-gated live-evidence
      profile bound to the offline manifest digest and exact immutable case/task/
      check/source/expected-change/candidate pins
- [ ] Pin the real provider/model and adapter version, captured pricing and
      spend/runtime budgets, and an operator-produced assessment of each real
      repository's branch/PR-triggered automation with disposition and raw digest
- [ ] Authorize only named, separately approved Git object upload, absent-only
      remote-ref creation, draft-PR creation, and receipt effects; retain every
      force-push, update/delete, merge, deployment, and source-checkout mutation
      prohibition
- [ ] Record 3/3 live evidence with passing complete checks, exact changed paths,
      unchanged source checkouts, reviewable draft PRs, matching immutable
      receipts, restart/reconciliation evidence, and exact candidate/live
      identities

### Slice 1 candidate-tree verification (recorded 2026-08-02 at `9c5ba19`)

These boxes record the verification run at the Slice 1 candidate head. They are
a historical record, not a claim about the current tree; four merges and one new
package have landed since. The most recent whole-tree verification appears under
"Current-tree verification" below.

- [x] `pnpm exec vitest run tests/security/gate1-benchmark-contract.test.ts`
- [x] `pnpm exec vitest run tests/security/gate1-benchmark-fixture-boundary.test.ts`
- [x] `pnpm exec vitest run tests/security/gate1-benchmark-result-contract.test.ts`
- [x] `pnpm benchmark:gate1`
- [x] `pnpm format:check`
- [x] `pnpm lint`
- [x] `pnpm typecheck`
- [x] `pnpm test`
- [x] `pnpm test:integration`
- [x] `pnpm eval`
- [x] `pnpm security`
- [x] `pnpm build`
- [x] `pnpm check`
- [x] workspace and real-browser smoke checks
- [x] production and full dependency audits
- [x] `git diff --check`
- [x] independent review has no remaining blocker, high, or medium finding

### Current-tree verification (2026-08-09, docs-only tree over `396a804`)

The complete local gate passed on Linux with Node 22.23.2, pnpm 9.15.4, and
Docker 29.1.3. `pnpm check` exited 0 with unit 815/815, integration 117/117,
security 158/158, `Gate 1 benchmark contract: 3 passed, 0 failed, 3
live-evidence not run`, and a successful build.

- [x] `pnpm check` (workflow lint, format, lint, typecheck, test,
      test:integration, eval, security, build)

Environment prerequisite, recorded because its absence looks like a test
failure rather than a missing dependency: the integration and eval suites need
both digest-pinned sandbox images present locally
(`python:3.12-slim@sha256:c3d81d25…` and `node@sha256:d9f85009…`). Without them
the sandbox correctly fails closed and verification outcomes report
`unavailable`.

Not run in this session, and therefore not claimed: native macOS and Windows
acceptance, the real-browser workspace smoke (needs
`ICARUS_CHROMIUM_EXECUTABLE`), and the production/full dependency audits. This
change is documentation only and alters no runtime behavior, but the omission
is listed rather than implied.

## Accepted implementation record: Change Handoff Pack v1 (ADR 0042)

Status values are evidence claims. ADR 0042 is Accepted. The implementation,
local evidence, independent review, direct-main integration, and exact
published-head hosted CI are complete. This accepts only the offline Handoff
Pack slice, not Athena integration, M3, Gate 1, Git landing, or deployment.

### Separate default-deny payload

- [x] Build `icarus.change-handoff.v1` directly from validated authoritative
      Icarus records through a closed safe-facts projection; do not serialize,
      spread, filter, or import `icarus.change-room.v1`, a full run, event,
      annotation, plan, PatchSet, verification record, or provider response
- [x] Emit only schema/version; deterministic handoff, run, project, correlation,
      and optional external-task identifiers; run state/host phase; bounded safe
      provider metadata; fixed lifecycle status; fixed summaries; counts; typed
      digest-only artifact references; disclosure class; the fixed integrity
      statement; omissions; and bounded uncertainty
- [x] Validate correlation IDs with
      `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`; validate an optional 1–256-byte
      external task reference with the same alphabet; expose a persisted model
      only when it matches the same 1–128-byte safe-token syntax; reject
      recognizable credential material and fail closed rather than truncate
- [x] Seed unique canaries through task, targets, repository/context/source paths,
      plan summary/steps/risks/rationale/grants, PatchSet paths and bytes, diff,
      check command/argv/stdout/stderr/sandbox, annotations/actors, event payloads,
      cache/worktree/artifact paths, URLs, credentials, headers, research, and
      code, then prove none can enter payload, errors, summaries, or inspection

### Pure preview and digest binding

- [x] Add `run handoff-preview` as a read-only, non-migrating command that performs
      zero network or credential access and zero database, source, cache, worktree,
      or artifact writes; emit the exact canonical payload, its newline-inclusive
      SHA-256, a distinct request/preview SHA-256, and every omitted category
- [x] Use strict canonical JSON with fixed member order, exact keys, safe values,
      no duplicates, and exactly one trailing newline; derive handoff ID and
      preview digest deterministically without clocks, random values, paths, or
      omitted raw text
- [x] Bind the preview digest to the versioned request, validated operator inputs,
      safe source snapshot, payload schema, and complete payload digest so export
      refuses every digest-bound change before publication
- [x] Refuse missing, corrupt, contradictory, unsafe, or unrepresentable run
      evidence instead of guessing an outcome or repairing state

### Explicit local export

- [x] Add `run handoff-export` with the exact expected preview SHA-256; reopen and
      revalidate evidence, regenerate bytes, and refuse stale or corrupt input
      before creating either output
- [x] Create only `icarus-change-handoff.json` and
      `icarus-change-handoff-result.json` as owner-only regular files using
      descriptor-relative no-follow exclusive creation, no overwrite, payload
      then result ordering, file/output-directory/parent-entry `fsync`, and
      identity-checked cleanup of only partial files created by the failed attempt
- [x] Keep the result shape exact: `exportStatus`, `previewSha256`,
      `outputSchema`, and `payloadSha256`, where `payloadSha256`
      binds the complete newline-terminated payload; persist no path, delivery,
      receiver, retry, callback, outbox, or workflow state
- [x] Keep secure preview, export, verification, and inspection Linux-only;
      fail platform/capability checks before protected file access or output
      directory creation, with no weaker path-only fallback

### File-only verification and inspection

- [x] Dispatch `handoff verify` and `handoff inspect` before state-root resolution,
      migration checks, runtime creation, database access, or environment
      credential reads; prove both work while `ICARUS_HOME` is absent/inaccessible
- [x] Reject symlinked components/finals, hardlinks, special files, non-owner or
      over-permissive files, identity/size races, invalid UTF-8, BOM/NUL, duplicate
      or unknown fields, excessive bytes/depth, malformed and noncanonical JSON,
      and incorrect SHA-256 relationships
- [x] Make `verify` report internal consistency only and make `inspect` print only
      allowlisted fields plus fixed caveats; neither may reveal omitted evidence
      or imply authenticity, authorization, truth, disclosure permission, or
      execution/landing authority

### Authority preservation and future seam

- [x] Add no API route, browser action, schema/table, lifecycle event, provider or
      network call, Git action, landing/deployment flow, delivery ledger, outbox,
      queue, retry, worker, callback, webhook, message bus, chat, or secondary
      workflow state
- [x] Document only the conceptual one-way Athena mapping: handoff schema, complete
      handoff digest, Icarus run ID, correlation ID, safe lifecycle outcome, and
      disclosure class may later become an imported `constellation.event.v1`
      timeline record; implement no shared protocol/runtime, client, receiver,
      credentials, remote identity, delivery, or automatic Task Room creation
- [x] Prove a receiver cannot use a pack to create a run; approve egress, plan,
      review, rollback, restoration, landing, or deployment; inspect local
      evidence; infer task/code/path/check output; or trigger Minerva/another system
- [x] Preserve all Change Room guarantees: fixed eleven-card projection, GET-only
      routes, deterministic replay, redaction, model-free five-question packets,
      append-only annotation non-authority, and no represented commit/push/merge/
      deployment

### Required acceptance evidence

- [x] Focused unit/integration coverage for deterministic preview/export identity,
      preview purity, strict inputs, default-deny canaries, stale previews, corrupt
      records, exact canonical bytes, hostile files, no overwrite, partial cleanup,
      result hash verification, and database-independent file commands
- [x] Existing Change Room unit, integration, real-workspace, and static security
      assertions remain green without weakening or replacing them
- [x] `pnpm workflow:setup`
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
- [x] Independent review has no remaining blocker, high, or medium finding
- [x] Hosted `ci` succeeds at the exact published implementation head; the
      Linux-only native filesystem claims carry matching exact-commit Linux
      evidence

Fresh acceptance evidence on 2026-08-01:

- `pnpm exec vitest run tests/unit/session-iterations.test.ts
  tests/unit/change-handoff.test.ts --reporter=dot` passed 119/119 focused
  Store/reader provenance and handoff tests.
- `pnpm check` exited 0: workflow lint and formatting passed across 153 files;
  lint reported no errors and only inherited diagnostics; typecheck passed; 652
  unit/provider tests across 48 files and 93 integration tests across 12 files
  passed; the evaluator reported 7 passed, 0 failed, and 3 explicitly
  unsupported; 134 security tests and all 129 static assertions passed; and the
  production build completed.
- `pnpm smoke:workspace` exited 0 on exact IPv4 loopback with one provider
  request, two served assets, `awaiting_approval` state, `not_run`
  verification, and unchanged source. The real-browser smoke passed under
  Brave `Chrome/151.0.7922.71` with zero browser errors, zero external
  requests, every existing Change Room/verification/history/session assertion,
  and unchanged source.
- Both high-severity dependency audits reported no known vulnerabilities;
  `pnpm format:check` checked 153 files without changes and `git diff --check`
  exited 0.
- Two independent exact-snapshot reviews returned PASS with no blocker, high,
  or medium finding. Their focused evidence passed 119/119 repository tests, a
  separate 5/5 adversarial provenance/recovery matrix, and a 6/6 parity
  regression. A provisional HOLD found against stale Store/reader hashes was
  re-run against the current snapshot and closed: a session-only check outside
  an open repair epoch now fails before recording either an operation or a
  checkpoint, and the reader rejects forged equivalent history.
- The reviewed implementation snapshot is bound by SHA-256 to Store
  `02427927d002b0d53a7d765fb958934867e568786f71bf910f739ae9437f1193`,
  reader `bf7fc5ed173efc34043d2764f2bd21c4290dc5e1340f273aed46efeb6e202709`,
  session tests
  `b497aadec81a241d3847f66e94287573e03bf8d0df6f1922e69bce3862639885`,
  handoff tests
  `7d7fd90e908c80bf9e70d82dc175879fdace248592378aef23c4820dc442e9c3`,
  and the static security gate
  `dc1cfb41604b533439ffac65815b3be36457ad065f30e3f65b98ea8d999f1f66`.

- Initial exact-head `ci` run
  [30724930551](https://github.com/Ayyitskevin/Icarus/actions/runs/30724930551)
  safely failed the concurrent Gate 1 migration regression because one losing
  process surfaced an unclassified SQLite contention error.
- Repair commit
  [133aa38d](https://github.com/Ayyitskevin/Icarus/commit/133aa38d9b631d794ca724f64d97987662541ff3)
  maps `SQLITE_BUSY*` and the canonical rollback journal to `RUN_BUSY` while
  retaining `DATABASE_ERROR` for arbitrary siblings. The deterministic writer
  lock test proved red before green, five concurrent stress runs passed, and
  final `pnpm check` passed 654 unit/provider, 93 integration, 7/0/3 evaluator,
  134 security, static-security, typecheck, workflow, lint, and build gates.
- Exact published implementation-head `ci` run
  [30725709403](https://github.com/Ayyitskevin/Icarus/actions/runs/30725709403)
  passed the deterministic release gate, production dependency audit, and
  whitespace check in 1 minute 46 seconds.

This is full coherence for the bounded offline implementation. ADR 0042 is
Accepted on direct-main commit `133aa38d` with independent review and exact-head
hosted evidence. No PR, migration, deployment, provider call, or Change Handoff
artifact delivery occurred.

### Explicitly deferred

Athena or Minerva integration; `constellation.event.v1` runtime types; HTTP,
receiver authentication, signing, delivery, callback, webhook, retry, outbox,
message bus, chat, automatic Task Room creation, and every remote or executable
action. A future authenticated/imported protocol requires a separate ADR and
does not silently widen this offline artifact.


## Merged implementation record: Change Rooms slice (ADR 0041 remains Proposed)

Status values are evidence claims. The Change Rooms implementation merged
through [PR #21](https://github.com/Ayyitskevin/Icarus/pull/21) as exact `main`
`683c123d37645d0e161e55b2368ef66cff79ef75`. Local acceptance below, exact
published PR-head CI, and resulting-main CI passed. The PR carries no independent
review record, so ADR 0041 honestly remains Proposed under the repository's
local, independent-review, merge, and exact-head evidence policy. This preserves
the completed implementation evidence without accepting full M3 or Gate 1.

### Read-only Change Room projection

- [x] Derive `icarus.change-room.v1` per run in one SQLite read transaction
      from the run row, approvals, the bounded 200-event metadata tail, safe
      checkpoint columns, project check/sandbox configuration, and CLI
      annotations; `roomId` is the run ID with no room table, event bus, or
      parallel state machine
- [x] Project exactly eleven evidence cards in fixed lifecycle order with
      host-controlled titles, six provenance classes, explicit
      `available`/`pending`/`not_applicable`/`unavailable` statuses, bounded
      event/digest/approval references, and
      `truncated`/`redacted`/`unavailableEvidence` indicators
- [x] Reuse only the disclosure classes the existing full-run presenter
      already crosses; never select checkpoint bytes, private runtime paths,
      event payloads, raw provider prompts, or source blobs
- [x] State digest semantics explicitly: byte binding and recorded-evidence
      integrity only, never fresh authorization or semantic correctness; the
      checkpoint digest is a recorded byte binding, not a fresh rehash; the
      provider plan is an untrusted proposal until host checks and approvals
      land
- [x] Project a review rejection as a rollback record carrying the rejecting
      decision, with completion sequences marked as observed events rather
      than causal links

### Bounded index and deterministic answers

- [x] Serve `GET /api/change-rooms` under the ADR 0017 rowid discipline with
      provider/verification JSON extracted in SQL only behind
      `typeof`/`octet_length` preflight and strict JSON validity; fail closed
      as database corruption otherwise
- [x] Answer exactly five fixed questions through `GET
      /api/runs/:id/change-context` with an `icarus.change-context.v1` packet
      of at most eight host-templated statements, each carrying evidence-card,
      event-sequence, and digest receipts, plus explicit omissions and
      uncertainty; no LLM, provider, network, or external tool participates

### CLI-only append-only annotations

- [x] Add `run annotate` / `run annotations` with run-existence, closed-card,
      approval-actor, and 1 KiB non-blank body validation, fail-closed
      credential rejection, and a 32-per-run cap
- [x] Prove annotations are append-only and non-authoritative: no update or
      delete path, no event append, no event-cursor advance, no run-state,
      gate, digest, approval, verification, or execution input
- [x] Advance the schema to version 2 additively and forward-only (the
      `run_annotations` table only), raise `user_version` only when lower, and
      fail closed on newer databases; cover the version-1 migration and the
      newer-version refusal with tests

### Browser boundary

- [x] Keep all three routes GET-only with 404 for non-GET verbs and unknown
      runs and 422 for invalid query contracts; zero durable writes on reads;
      byte-identical restart replay
- [x] Add the review-only React Change Rooms section: explicit-load bounded
      index in a four-page replace-not-accumulate window, room detail with
      pinned event revision, read-only annotations, and the five-question
      explain panel; exact-key bounded client validation; single-flight
      generation-guarded requests; React text only

### Acceptance coverage and commands

- [x] Unit coverage: projection across draft/planned/review/completed/failed/
      rolled-back/restored states, determinism, bounded-tail truthfulness,
      corrupt-checkpoint fail-closed, checkpoint-byte exclusion; every
      question across representative states with receipt validation;
      annotation validation, cap, ordering, migration, and non-authority;
      index page boundaries, provider/verification extraction, terminal
      reasons, and corruption fail-closed; client validators and page session
- [x] Integration coverage: a completed Docker-verified CLI run presented as a
      room with annotation visibility, restart replay, redaction scans, query
      and method negatives, and zero durable writes; a browser-planned draft
      room with honest pending evidence
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
- [x] `ICARUS_CHROMIUM_EXECUTABLE=$(which brave-browser) pnpm smoke:workspace:browser`
- [x] `pnpm audit --audit-level high`
- [x] `pnpm audit --prod --audit-level high`
- [x] `git diff --check`
- [x] Hosted `ci` succeeds at the exact published implementation head

Fresh local candidate evidence on 2026-08-01, recorded on the merged tree
(Gate 1 baseline plus the Change Rooms slice):

- `pnpm check` exited 0: formatting 147 files; lint reported no errors with
  inherited informational diagnostics only; typecheck passed; 572
  unit/provider tests across 47 files passed; 89 integration tests across 11
  files passed; evaluation reported 7 passed, 0 failed, and 3 explicitly
  unsupported; 134 security tests and 116 static assertions passed; the
  26-module Vite build completed.
- Unit coverage on the merged store proves: projection across
  draft/planned/review/completed/failed/rolled-back/restored states against
  ADR 0023 patch sets and tree checkpoints; determinism; bounded-tail
  truthfulness; corrupt-checkpoint fail-closed; every change-context question
  with receipt validation; annotation validation, cap, ordering, and
  non-authority; the operator-gated annotation migration
  (`DATABASE_MIGRATION_REQUIRED` without the token, shape-validated
  `run-annotations-v1` approval, invalid-shape refusal); and the index
  page's provider/verification extraction, terminal reasons, and corruption
  fail-closed.
- Integration coverage proves a completed Docker-verified CLI run presented
  as a room with annotation visibility, restart replay, redaction scans,
  action-session refusal (401) of mutation verbs and 404 behind it, zero
  durable writes across every table, and the one-shot
  `ICARUS_APPROVE_SCHEMA_MIGRATION=run-annotations-v1` CLI flow including
  unrelated-token refusal.
- `pnpm smoke:workspace` passed with the Change Room index, projection,
  receipt packet, and 401 action-session refusal assertions.
- The real Brave smoke (Brave Browser 151.1.93.129) passed with zero browser
  errors and zero blocked external requests, including the Change Room
  scenario (toggle, bounded index, eleven-card room, pinned revision,
  `why_blocked` packet with receipts, GET-only reads) and the restored
  workspace view.
- Both dependency audits reported no known vulnerabilities; `git diff --check`
  reported no errors.
- The earlier pre-merge evidence at base `8f0cf49` (211/42 tests, 5/0/5
  evaluation, both smokes) was superseded by this merged-tree record.
- Hosted `ci` run
  [30684614501](https://github.com/Ayyitskevin/Icarus/actions/runs/30684614501)
  passed its real `quality` job in 1 minute 52 seconds at exact published
  implementation head `05f1519b85b1baaef6d5800fd2dc8186b2fbd5c5`.
- PR-head `ci` run
  [30684698766](https://github.com/Ayyitskevin/Icarus/actions/runs/30684698766)
  passed at documentation head `eacaeb12affcf7307f41e850ef05f4a3e22aeeac`.
- Resulting-main `ci` run
  [30698803412](https://github.com/Ayyitskevin/Icarus/actions/runs/30698803412)
  passed at merge commit `683c123d37645d0e161e55b2368ef66cff79ef75`.
- PR #21 records no independent review or review decision; those successful
  publication gates therefore do not change ADR 0041 from Proposed to Accepted.

### Explicitly deferred

Browser annotation authoring; live room polling or streaming; LLM/BYOK
summarization of the change-context packet; free-text questions; room search;
annotation editing or deletion; per-card deep links into raw payloads;
provider-usage rollups inside room cards (the existing full-run usage view
and operation timeline events remain the usage surface); anything
Nostr/relay/federation/forge/Git-hosting/chat-like; and any claim that a
change landed outside the Icarus-private worktree.
## Current product execution program

The dependency-ordered plan for making Icarus a trustworthy Cursor rival with
a Buzz-inspired multi-agent mission room is
[`ICARUS_COLLABORATIVE_IDE_GAME_PLAN.md`](ICARUS_COLLABORATIVE_IDE_GAME_PLAN.md).
It records the closure of the historical ADR 0026 release hold, makes Gate 1
browser authority plus isolated create-only Git landing with reconciliation the
first forward product slice,
places a thin VS Code workbench in the center, introduces a bounded read-only
Council before write-capable collaboration, and requires isolated child runs
plus deterministic integration for the later Crew.

Gate 0 release closure was recorded on 2026-07-31. [PR
#18](https://github.com/Ayyitskevin/Icarus/pull/18) merged the candidate as
`d4bbcd4aab713bee23237099286e6d9b9f74283b`; the native-fixture correction
followed as exact `main` `802b91e6f6c9b392f56c9ee3660be818a0f74a62`. Linux
[run 30602942008](https://github.com/Ayyitskevin/Icarus/actions/runs/30602942008)
and both native jobs in
[run 30602949132](https://github.com/Ayyitskevin/Icarus/actions/runs/30602949132)
succeeded at that exact head.

The immediate forward sequence continues through Gate 1:

1. preserve Packet 2's published exact-head hosted and native macOS/Windows
   acceptance for ADR 0029's closed guarded lifecycle actions;
2. complete ADR 0027's durable landing coordinator and digest-bound decision
   flow on the merged schema, records, deterministic candidate builder, and
   absent-only local `icarus/<run-id>` reference, then add bounded GitHub REST
   object upload, draft PR, and metadata-only reconciliation receipt;
3. prove deterministic retrieval and typed read-only outcomes;
4. ship the shared client and VS Code workbench; and
5. accept ADR 0037, then prove read-only Council lift before ADR 0033/0038
   executable Crew work.

### Gate 1 implementation checkpoint

ADR 0029 is accepted. PR #22's published Packet 2 slice extends the merged
origin, authentication, request-ledger, and shutdown foundations with exact
server-derived descriptors, readable authority context, bounded receipts, and
one Linux service dispatcher for egress approval, plan approval, review
accept/reject, rollback, restore, resume, and cancellation. Each ordinary
action holds one kernel run lease from admission through settlement. The only
lease-bypassing path is a parent-bound cancellation that must match the current
coordinator generation, action ID, digest, kind, and execution context before
it emits one structured abort signal. Startup marks started operations
interrupted, refuses prepared rows, and terminally reconciles admitted rows
without replay. Non-Linux authority contains no actions and execution fails
before persistence.

The Packet 2 actions reuse existing private-worktree/provider/sandbox effects.
They add no commit, push, Git-ref, pull-request, merge, deployment, or imported
source-checkout effect. Fresh local acceptance on 2026-08-02 covers same-ID
admitted no-replay, exact and mismatched cancellation bindings, stale structured
signals, bounded receipts, prepared/admitted restart reconciliation, all eight
protected API mappings, and the compiled guarded-action workflow in
`Chrome/149.0.7827.55`. Candidate
`701952349e0818cead37672df951ed09c0edd27c` passed hosted run `30760607215` and
native run `30760619650`, then rebase-merged as
`ba38856a0e0e63d1045500185b2158a0859469d1`. After a timing-only smoke-harness
correction, implementation head `3683087066efb65255f05b2493fd31051c3ad7c6`
passed hosted run `30761189188` and native run `30761192370`. This closes only
Packet 2's eight guarded Linux browser action kinds; Gate 1 remains incomplete.

ADR 0027 and its normative v1 record companion are accepted after independent
P0/P1 authority reviews. PR #20 implements the exact landing schema and
migration gates, closed records and state tables, deterministic local candidate
construction, and an absent-only local `refs/heads/icarus/<run-id>` reference.
PR #23 completes Packet 3's durable landing persistence, service coordination,
digest-bound decision transaction, CLI/browser presentation, interruption
reconciliation, and real-process crash matrix on that foundation; its record
appears below. The provider gateway package merged separately as Packet 4a and
is imported by nothing. Remote landing coordination, the remote branch, the
draft pull request, the metadata-only receipt, credential-gated live evidence,
and Gate 1 completion remain incomplete. No live state migration was run.

The local server now closes mutation admission, drains registered handlers, and
closes SQLite last. Fresh handler, API, and real-browser suites prove action
admission, stale confirmation, disconnect, shutdown, receipt, and settlement
boundaries against the wired route. Those local suites support the separately
accepted exact-head record above. Neither evidence set satisfies durable
landing, landing/GitHub receipts, the credential-gated live profile,
deployment, migration, or Gate 1 completion; Packet 3's separate acceptance
matrix below supplies durable local landing only.

### Packet 3 acceptance record — durable local landing (completed 2026-08-02)

Status: **COMPLETE AND MERGED** as
[PR #23](https://github.com/Ayyitskevin/Icarus/pull/23), published on `main` as
`f2fd48b`. A reviewed, passing run can prepare an exact candidate commit,
receive a digest-bound landing decision, and create one local private branch
without touching the source checkout or any network.

The durable ledger binds immutable run/profile evidence, a canonical landing
digest, a one-shot decision, ten-minute active attempts, an eight-attempt
ceiling, operation intent/observation/settlement, and explicit resume. Candidate
replay is deterministic. Private-ref creation uses an absent-only
compare-and-swap and reconciles an exact direct ref only from this landing's
durable prior-absence and intent. CLI, API, and browser expose the same bounded
authority/evidence projection; non-Linux mutation refuses before persistence,
Git, credential, or network effects. Real child-process termination covers
candidate construction, approval, local-ref ambiguity, cold reopen, explicit
resume, cross-process landing/rollback exclusion, and exhausted-attempt truth.

Packet 3 performs no credential lookup, network request, GitHub mutation,
live-state migration, source-checkout mutation, merge, or deployment. Those
boundaries remain with Packet 4 and the Gate 1 exit gate.

### Packet 4a record — bounded GitHub gateway (merged, unwired)

Status: **PACKAGE MERGED; WIRED TO NOTHING**. `packages/github-gateway` merged
as [PR #25](https://github.com/Ayyitskevin/Icarus/pull/25) with two subsequent
security corrections,
[PR #26](https://github.com/Ayyitskevin/Icarus/pull/26) and
[PR #27](https://github.com/Ayyitskevin/Icarus/pull/27). This closes Packet 4a's
package deliverable only. It is not Packet 4, and it is not Gate 1 item 5:
no runtime path reaches it.

The package supplies a dependency-free, injectable-transport gateway over a
closed operation table: actor read, blob/tree/commit object upload, absent-only
reference creation, draft pull-request creation, and reference/pull-request
read-back for reconciliation. Authority is bounded by construction — the HTTP
method union is `GET | POST` only, so force update, reference deletion, and
merge are inexpressible rather than merely unused; the origin is pinned to
`api.github.com` at parse time and again at dispatch; a loopback origin requires
an explicit construction opt-in because it would receive the credential in
cleartext; repository-automation paths are denied before any object upload; and
no mutating request is ever retried inside the package, because ADR 0027 places
retry with the coordinator's durable intent. Tokens are read from the
environment at call time, never persisted, and redaction is asserted on every
error path.

PR #26 closed a remote code-execution path: a shape-only path allowlist
accepted `.github/workflows/*`, `.circleci/config.yml`, `Jenkinsfile`, and
similar files, and creating the head ref or opening a same-repo draft PR would
have executed those definitions with repository secrets before any human review.
PR #27 corrected a reconciliation deadlock in which an ordinary
close-and-reopen made a run permanently unreconcilable, and added the loopback
opt-in above.

Not done, and required before Gate 1 item 5 can be claimed: coordinator wiring,
remote landing states, the metadata-only receipt, and the interface
reconciliation recorded in
[`OPUS_CONTINUATION_PLAN_2026-08-09.md`](OPUS_CONTINUATION_PLAN_2026-08-09.md)
§3 — mixed-case owner handling, a base-reference read, and the reconciliation
page ceiling. No independent review record was filed with PRs #25–27; that debt
is carried forward with the ADR that records this package's authority
decisions.

### Packet 4b sub-slice record — S2b-ii-a read-only remote preflight

Status: **IMPLEMENTED (read-only preflight only); the mutation stages remain
fenced.** This is the first sub-slice of Packet 4b's coordinator work, per the
sub-slicing recommended in the continuation plan's S2b-ii ledger survey.

What exists now: from an approved `local_ready` landing, an explicit
`landing resume` runs the read-only `github.preflight` stage — the actor read,
the base-reference read, and the head-ref absence read — through the Packet 4a
gateway, against the pinned origin. Every request is admitted to the durable
ledger with its conservative per-attempt charge (`2 * changedPaths + 32`) and
its `landing.github.request.admitted` event in one transaction **before** any
network I/O, then settled with its canonical result. The credential resolves
env-only at call time through the existing allowlist and is never persisted; a
missing credential fails before any HTTPS request is admitted. Preflight maps
to no action state: it completes without a landing transition, and its
deterministic failures enter `failed` with the retry-safe `local_ready` resume
marker while interruptions leave the landing in `local_ready`. Takeover of an
interrupted preflight settles an admitted-but-unsettled read as
`ambiguous`/`GITHUB_OUTCOME_AMBIGUOUS` before interrupting the operation —
never inferring failure from an absent response — and emits no false
state-change event. The operation-kind fence widened by exactly one kind
(`github.preflight`); the state fence did not move, so this slice is
structurally incapable of a remote mutation. `landing_receipts` stays
write-fenced, and the `github.objects.upload`, `github.ref.create`, and
`github.pull_request.create` kinds remain inadmissible.

What remains: S2b-ii-b (object upload and the absent-only remote ref — the
first mutations, plus remote-reconciliation subjects), S2b-ii-c (draft PR and
the receipt), and S2b-iii (receipt presentation through the four-file
lockstep chain). The gateway's two open contract-level questions in ADR 0043
(head-filter identity case; page size versus the response ceiling) remain
open and unrelied-upon: this slice's reads do not include the reconciliation
list read.

Evidence: unit suites assert the admission-before-I/O ordering, grammar and
cardinality fences, derived-not-proposed settlement, fail-closed row/event
decoding, takeover ambiguity, and credential non-persistence (sentinel scans
of persisted state on success and hostile-error paths). The real-process
crash matrix adds twelve preflight phases — before, during, and after each
GET class through the loopback transport, plus both sides of the settlement
commit — each reopened and resumed with duplicate-effect and
ambiguous-outcome assertions and zero real-network proof. No live GitHub call
exists anywhere in tests; no schema or migration change was required (the
merged DDL already carries `landing_http_requests`).

### Packet 4b sub-slice record — S2b-ii-b object upload + absent-only remote ref

Status: **IMPLEMENTED (object upload and remote-ref creation; the draft PR and
receipt remain fenced).** This is the second sub-slice of Packet 4b, per the
continuation plan's recommended sub-slicing. It contains the first remote
**mutation** authority in the system: bounded GitHub object writes and one
absent-only reference creation.

What exists now: an explicit `landing resume` at `local_ready` runs the
read-only preflight and then the `github.objects.upload` stage in the same
attempt — one blob per non-deleted manifest path in canonical order, then the
tree, then the commit — with the effect's durable intent binding the
immediately preceding completed preflight (`preflightOperationId`/
`preflightResultSha256`) before any POST is admitted. A further resume at
`objects_ready` runs preflight and then `github.ref.create`: the three
pre-effect reads and the observation commit before exactly one absent-only
`POST /git/refs`, then the fixed post-read suffix proves the outcome.
`created` versus `reconciled` is evidence-derived, never caller-chosen; a
definitive no-effect suffix (absent head, unchanged base) fails back to
`objects_ready` for an explicit retry; drift or conflict holds
`reconciliation_required` with the honestly derived `remoteResidue`
(`none`/`branch`/`ambiguous` from the freshest durable head proof). An
interrupted upload reconciles without new reads and either proves the stage
or authorizes the byte-identical retry; the retry binds the interrupted
subject and its reconciliation grant. Two gateway gaps found while wiring are
closed in the same change: `createCommit` now sends the exact author/
committer identity the landing digest binds (GitHub's substitution would
never reproduce the candidate commit name), and `createTree` carries
null-sha deletion entries; every gateway mutation body serializes in the
record contract's canonical ascending-ASCII key order, so the durable
`bodySha256` binds the actual wire bytes.

What remains: S2b-ii-c (draft-PR creation with its one-POST-ever discipline,
the pull-request reconciliation reads, and the metadata-only receipt — the
`github.pull_request.create` kind, `opening_draft_pr`, `landed`, and
`landing_receipts` all stay fenced) and S2b-iii (receipt presentation).
`remote_ready` currently parks: a resume there refuses truthfully until ii-c.

Evidence: the store-level suite pins the exact attempt shapes, subject/body
derivation, outcome and residue mappings, and fail-closed loads; the
coordinator suite drives refusal, ambiguity, drift, conflict, and redaction
paths through a fake gateway. The crash matrix adds sixteen phases — before,
during, and after each POST class and both settlement commits — through the
loopback transport, including the mid-flight ref-POST loss reconciled under
both remote answers (absent and exact) and the proof that an interrupted
upload replays byte-identically with no second ref creation. No live GitHub
call exists anywhere in tests.

### Packet 4b sub-slice record — S2b-ii-c draft PR + landing receipt

Status: **IMPLEMENTED (draft-PR creation and the immutable receipt; the
presentation chain remains fenced).** This is the final runtime sub-slice of
Packet 4b. It admits `remote_ready` and opens exactly one operation kind,
`github.pull_request.create`, plus the `landed` state and the
`landing_receipts` write.

What exists now: an explicit `landing resume` at `remote_ready` runs the
preflight with its fourth grammar member — the complete empty pull-request
list under `pull_requests.get` — and then the draft-PR stage in the same
attempt: the exact base, the exact candidate head, and the prior-absence
proof commit durably before the one POST is admitted. The POST is admitted
**at most once per landing, ever**: the `one_create_pr_post_per_landing`
unique index refuses a second row at write, the store-level invariant survey
refuses any load that lost that discipline, and a lost or contradicted
response is never retried — only the fixed post-read suffix (base, head, and
a fresh complete list) decides. `created` versus `reconciled` is
evidence-derived from the durable rows, never caller-chosen; a definitive
pre-POST refusal (conflict, missing head, drifted base) fails back to
`remote_ready` for an explicit retry with the admission unspent, while a
spent admission without proof holds `reconciliation_required` with the
honestly derived residue. The receipt commits in the settlement's one
transaction — insert `landing_receipts` (the canonical LandingReceiptV1
digest; metadata and digests only, never credentials, paths, or text), settle
the operation, append the event, transition to `landed` — so a crash anywhere
around it replays to exactly one receipt. `landed` is terminal: resume
refuses with zero network and the stored receipt reloads byte-identically.
One contract decision is recorded here: the PR-POST `head` field is
owner-qualified (`owner:branch`) on the wire, aligning the gateway to the
record contract's spelling rather than bending the record to the earlier
bare-branch accident. ADR 0043's two open questions (head-filter case
sensitivity, page size against the response ceiling) remain open and still
fail closed: a case-sensitive filter would surface as a 422 refusal and an
operator hold, never a duplicate pull request; the live observation that
settles them belongs to S3.

What remains: S2b-iii (receipt presentation through the four-file
presentation chain) and S3 (the live-evidence profile plus the operator's
credentialed 3/3 run — only that closes Gate 1).

Evidence: the store-level suite pins the admission, settlement, residue, and
one-POST-ever invariants; the coordinator suite drives the full chain to
`landed`, the refusal/conflict/ambiguity holds, credential and platform
gates, and hostile-error redaction through a fake gateway. The crash matrix
adds five draft-PR phases — before the POST admission, during the POST under
both remote answers (absent and exact), and both sides of the settlement
commit that carries the receipt — each reopened and resumed with
exactly-one-POST, receipt-idempotence, and zero-real-network assertions. No
live GitHub call exists anywhere in tests.

## Released Gate 0 baseline: ADR 0026 slice 2b production wiring

Status: **MERGED AND RELEASED AT THE GATE 0 RELEASE HEAD**. The corrected ADR 0026
implementation, exact-head Linux gate, and exact-head macOS/Windows native
acceptance pass at `802b91e6f6c9b392f56c9ee3660be818a0f74a62`. Gate 1 is
the current forward work.

At authoring/candidate time, status was **LOCAL CORRECTIONS PASS; PUBLICATION
HOLD**. Explicit human approval authorized the High remote-egress and Medium
mutation-scope/worktree-consistency corrections. Both failed closed under
adversarial regression, and the complete local gate passed, but the tree was
then uncommitted and unpublished; exact implementation-head hosted CI, native
acceptance, and the remaining release reviews had not yet been recorded.

### Corrective release gate

- [x] Keep complete check stdout/stderr in local SQLite/operator evidence while
      projecting only host-owned metadata into remote session prompts and
      rehydrated tool results; prove a safe canary outside context and the
      readable manifest never reaches any remote request
- [x] Validate `mutation.patchset` grants against the plan's exact target set,
      recheck the invariant before worktree restoration, and prove a malformed
      broader grant changes no private-worktree bytes
- [x] Replace the synthetic tight-margin ledger setup with an actual CheckRunner
      interruption and failed settlement; add exact check subset/order refusal,
      durable service cancellation, whole-fence compaction, and persisted
      truncation evidence
- [x] Add transaction-abort atomicity and direct Docker reconciliation evidence
- [x] Add a true process-level reopen/restart after a completed session
      iteration boundary; prove the fresh process does not replay provider,
      mutation, or check effects and does not duplicate charges
- [x] Synchronize README, roadmap, ADR, evaluator sequencing, and manifest SHA
      after the runtime corrections
- [x] On the held pre-correction tree, rerun focused suites, `pnpm check`,
      evaluator, production and full dependency audits, and `git diff --check`
- [x] After the two runtime corrections, rerun the local gates plus cold
      security-boundary review on one tree
- [x] Commit/publish one candidate, pass exact-head hosted CI and native
      acceptance, and persist the final role-neutral architecture/release
      review artifact with exact tree, reviewed surfaces, rerunnable evidence,
      findings, and disposition. Fleet guard or independent agent lanes may
      supply review artifacts, but no named reviewer is a repository-level
      dependency. PR #18, Linux run 30602942008, and native run 30602949132
      record the published exact-head evidence at `802b91e6...`

Fresh corrected-tree local evidence recorded on 2026-07-30, before publication
and release clearance:

- Focused ADR 0026/store/grant/tool/state/Docker verification: 8 files and
  213 tests passed.
- Full unit/provider verification: 29 files and 391 tests passed; full
  integration verification: 9 files and 78 tests passed.
- `pnpm check`: exit 0, including workflow validation, formatting, lint,
  typecheck, both test groups, evaluation, 133 security tests, static security
  assertions, and the production build.
- `pnpm eval`: schema v2, 7 passed, 0 failed, and 3 honestly unsupported;
  manifest SHA-256
  `f395b0eb2bc953f60d58719039ce2418caaa6d1cf64261e5462dd8915c2da6b0`.
- `pnpm audit --audit-level high` and
  `pnpm audit --prod --audit-level high`: no known vulnerabilities.
- Remote roomy/live, compacted, and legacy-resume canaries prove no raw
  stdout/stderr or keys reach a remote request; loopback and raw SQLite retain
  the exact output. The persisted-resume test rewrites a completed tool
  transcript to raw malformed truncated evidence and still reconstructs only
  host metadata from the atomic verification event.
- A fresh-plan unit regression rejects broader mutation authority; a mutually
  consistent legacy plan/digest/approval regression reaches zero provider,
  reconcile, or session operations and leaves both selected files plus durable
  patch/checkpoint intent byte-exact.
- `git diff --check`, Biome formatting, local Markdown targets, and two
  independent read-only security reviews pass.

[ADR 0036](adr/0036-proof-carrying-software-factory-product-direction.md)
records the product plan beyond release closure: Verified Change Gate
(browser approval plus Git landing), context/agent quality, a VS Code
workbench, Replit-class environments, Supabase change packs, then delivery and
scale. It supersedes current Fable sequencing without weakening any accepted
authority boundary.

Phase 1's transactional multi-file PatchSet boundary is complete under ADR
0023. This continuation wires the already landed ADR 0026 registry and loop into
the guarded CLI repair path without adding browser authority or a live schema
migration:

- [x] Keep the approved initial provider patch-set attempt; enter the session
      only after failed formal verification, with `iterationCeiling: 0` still
      single-shot
- [x] Require explicit plan grants and bind their readable-manifest digest into
      approval; retain `plan_json` plus approval digest as the sole grant source
- [x] Admit `provider.revise` before provider I/O and every tool operation before
      grant check/host action; charge refusal, failure, interruption, and cancel
- [x] Wire the closed read/patch/check/control tools through existing manifest,
      PatchSet, guarded write, checkpoint, and sandbox primitives
- [x] Keep `propose_patch` advisory; require `apply_patchset` to carry and
      independently revalidate its own bounded PatchSet, then persist exact
      patch intent before writes
- [x] Resume interrupted apply from persisted intent with `unavailable`,
      non-approvable verification; require complete approved checks and
      host-gate `report_done` on current passing checkpoint/diff evidence
- [x] Persist human-input and exhaustion blockers in `awaiting_review`, where
      ordinary review approval refuses them
- [x] Reconcile interrupted private checkpoints, retain conservative charges,
      rehydrate only completed boundaries, and preserve cancellation recovery
- [x] Reserve one ordinary operation plus `commandTimeoutMs` across session
      entry and every provider/tool admission, and prove a genuinely interrupted
      check can still reconcile under tight custom ceilings
- [x] Set the measured default/host maximum to two: local fresh, remote fresh,
      and remote resumed worst cases consume 30, 31, and 32 of 40 ordinary
      operations, retaining at least eight for settlement/retries
- [x] Add no `capability_grants`, `agent_sessions`, or `tool_invocations` table;
      operations/events remain the sole session record
- [x] Settle tool-operation finish with verification/terminal evidence, and
      `review.validate`/rollback/restore finish with state transition, in one
      SQLite transaction
- [x] Make `repair-failing-test` an executable deterministic two-turn lifecycle
      over the operator-selected target, without claiming diagnostic target
      selection
- [x] Fresh `pnpm eval` reports 7 passed, 0 failed, and 3 honestly unsupported
- [x] Focused unit/integration session and policy tests pass from fresh output
- [x] `pnpm check`, dependency audit, and `git diff --check` pass from fresh output
- [x] The later cold audit's remote-egress and mutation-scope blockers are
      corrected and independently re-reviewed
- [x] Exact implementation-head hosted `ci`
      [run 30602942008](https://github.com/Ayyitskevin/Icarus/actions/runs/30602942008)
      passes at `802b91e6f6c9b392f56c9ee3660be818a0f74a62`

Historical pre-hold evaluator and local-gate evidence on 2026-07-30:

- `pnpm eval`: exit 0; build and production-sandbox evaluation completed with
  7 passed, 0 failed, and 3 honestly unsupported scenarios; manifest SHA-256
  `4571bd3cf4d8fddcf04e6c6c098cae6a3ff7b9d32c7c02fe24322f0e3cb837f7`;
  all 7 measured scenarios reported zero incorrect edits.
- Focused ADR 0026 verification: 161/161 unit tests and 24/24 repair
  convergence integration tests passed.
- `pnpm check`: exit 0; workflow validation, formatting, lint, typecheck, 383
  unit/provider tests, 68 integration tests, evaluation, 133 security tests,
  static security assertions, and the production build passed.
- `pnpm audit --audit-level high`: no known vulnerabilities; `git diff
  --check`: no errors.
- An earlier adversarial re-review passed the context, evaluator, and
  single-crash reconciliation policy. A later cold audit found the two blockers
  in the corrective gate above, so this evidence does not clear the candidate.
  At that pre-publication checkpoint, publication and exact-head hosted CI
  remained deliberately unclaimed; the Gate 0 closure above records their later
  completion.

Deferred beyond this slice: browser approval/execution (2c), capability-aware
provider routing, richer retrieval, package installation, previews, landing,
backend primitives, multi-agent orchestration, and distributed workers.

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
- [x] At this historical slice, leave the inherited OpenCode workflow and ADR
      0010 hold unchanged; ADR 0025 later chose and implemented hardening

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

## Native-host acceptance: accepted at the exact Gate 0 head

ADR 0022 and its manual workflow are merged and registered on the default
branch. The exact-head native workflow now passes on macOS 15 arm64 and Windows
Server 2025 x64 at `802b91e6f6c9b392f56c9ee3660be818a0f74a62`.

### Portable boundary and authority

- [x] Use explicit `macos-15` arm64 and `windows-2025` x64 jobs, exact Node
      and pnpm versions, immutable action commits, frozen dependencies,
      `contents: read`, exact-SHA checkout, no secrets or shared cache, and
      manual dispatch only
- [x] Fail closed on workflow-byte, action, command, host, toolchain, permission,
      trigger, or cache drift through the repository-owned native policy
- [x] Exercise portable policy/provider/unit boundaries and a real native state
      root beneath the user profile
- [x] Exercise the portable composition path through a temporary Git repository,
      loopback HTTP and Ollama fixtures, project import, committed-tree context
      preview, persisted draft restart, planning, bounded evidence, and unchanged
      source state
- [x] Add no product schema/runtime change, approval, execution, arbitrary
      command, repository mutation, credential, push, deployment, or public
      endpoint authority

### Local and hosted evidence

- [x] Fresh combined `pnpm check`: three workflows validated; formatting 95
      files; 169 unit/provider and 44 integration tests; evaluation 5 passed,
      0 failed, 5 unsupported; 118 security tests plus 49 static assertions; and
      a 23-module production build
- [x] Native workflow policy/security tests and the selected portable composition
      smoke passed locally on Linux; at that candidate-time checkpoint this did
      not yet claim native-host execution
- [x] Combined cached-Chromium acceptance passes with zero browser errors,
      external requests, or source-state changes
- [x] Publish and register the manual workflow on the default branch
- [x] With explicit authorization, dispatch exact main and record successful
      [native run 30602949132](https://github.com/Ayyitskevin/Icarus/actions/runs/30602949132):
      [macOS 15 arm64](https://github.com/Ayyitskevin/Icarus/actions/runs/30602949132/job/91069305460)
      used `macos-15-arm64` image `20260715.0234.1`, and
      [Windows Server 2025 x64](https://github.com/Ayyitskevin/Icarus/actions/runs/30602949132/job/91069305501)
      used `windows-2025-vs2026` image `20260714.173.1`; both succeeded at
      `802b91e6f6c9b392f56c9ee3660be818a0f74a62`

## Accepted eighth M3 observation slice: bounded project catalog and JSON transport

ADR 0021 and its implementation are merged. The recorded combined local gate,
independent review, and exact implementation-head hosted CI passed. This accepts
only this bounded observation slice; it does not complete M3 or close ADR
0025's residual release work.

### Pinned joined project pages

- [x] Replace the workspace's complete project collection with one newest-first
      page of at most 12 joined project/repository records and strict
      `before` plus `snapshot` continuation
- [x] Use one intrinsic-project-rowid `LIMIT 13` range query and one repository
      primary-key join, with no project/repository N+1 hydration or complete-list
      scan
- [x] Gate persisted storage classes, text bytes, and strict JSON before parsing;
      cap checks at 1 MiB and sandbox/ceiling profiles at 16 KiB, validate exact
      nested keys and policy, and enforce the JSON caps on supported writes
- [x] Present only allowlisted project/repository fields and omit repository
      device/inode identity even though the joined store record validates it
- [x] Replace project pages in a four-position browser cursor window; reject
      stale responses, abort superseded/lifecycle reads, retain the last success
      for retry, and preserve an independently selected project
- [x] Use exact indexed repository/project-name and project-ID lookups for
      creation and draft planning instead of complete collection scans, while
      retaining the same SQL storage/byte preflight on direct hydration

### Aggregate response safety and scope

- [x] Serialize every JSON body, including its trailing newline, before sending
      headers; reject more than 8 MiB with fixed `RESPONSE_TOO_LARGE` copy and
      never write a partial success body; cap trusted error messages and retain
      a fixed pre-serialized non-recursive internal-error fallback
- [x] Add no schema/migration, dependency, data deletion, Git/source read,
      provider call, browser approval/execution, command, commit, push,
      deployment, or release authority
- [x] Pass 50 focused store/client/response/service/API tests, the API smoke with
      unchanged source, and fresh full `pnpm check`: workflow validation;
      formatting 92 files; lint/typecheck; 169 unit/provider and 44 integration
      tests; evaluation 5 passed, 0 failed, 5 unsupported; 109 security tests
      plus 49 static assertions; and a 23-module production build
- [x] Complete cached-Chromium acceptance over 50 projects: 12-row pages,
      failure/retry, request contention, hidden/selection cancellation,
      delayed-success rejection, four retained pages, an off-page run/project
      ownership refresh, keyboard skip navigation, zero browser errors/external
      requests, and unchanged SQLite/source state
- [x] Combined independent review found no remaining blocker, high, or medium
      finding
- [x] Exact implementation-head hosted CI
      [29963114892](https://github.com/Ayyitskevin/Icarus/actions/runs/29963114892)
      passed at `cb3b97f8fc68b0bf451709b2a023031dc10c1177`

## Accepted seventh M3 observation slice: bounded persisted diff and run-status review

ADR 0020 and its implementation are merged. The recorded combined local gate,
independent review, and exact implementation-head hosted CI passed. This accepts
only this bounded observation slice; it does not complete M3 or close ADR
0025's residual release work.

### Bounded presentation and truthful status

- [x] Preserve the normal `diff: string | null` contract while adding an exact
      absent/available/outside-browser-bound metadata union
- [x] Show no more than 262,144 complete UTF-8 diff bytes and never return a
      prefix, suffix, or other partial patch
- [x] Require paired diff/verification presence, project-ceiling compliance,
      one exact changed target, canonical digest, exact displayed-byte rehash,
      one patch header, and at least one hunk/change before claiming statistics
- [x] Put exact persisted run state, verification outcome, path, bytes, physical
      patch lines, additions, deletions, hunks, digest, and provenance together
- [x] Render the patch in one bounded-height React text node, keep hostile HTML
      inert, use a focusable fixed anchor, and expose no action control
- [x] Map `verification.completed` to `#run-diff` while preserving
      `checkpoint.saved` at verification and the distinct warning/approval
      anchors from ADR 0019

### Scope and evidence

- [x] Add no route, schema, store/service change, database query, Git/source
      read, provider call, poller, browser mutation, command, commit, push, or
      deployment authority
- [x] Unit and API coverage prove exact shapes, patch statistics, no-partial
      oversized handling, inert HTML-like text, sanitized corruption failures,
      and unchanged SQLite/repository fingerprints
- [x] Security tests pass with static response-cap, fail-closed validation,
      no-read-authority, text-only UI, and fixed-anchor assertions
- [x] Complete real-browser acceptance with explicit cached Chromium 1228: the
      compiled workspace rendered hostile patch text inertly, moved focus by
      Tab to the labelled patch region, scrolled it with PageDown, followed the
      fixed evidence anchor, cancelled held requests, made zero external
      requests, reported zero browser errors, and preserved SQLite/source state
- [x] Run the full local `pnpm check`: workflow validation, formatting, lint,
      typecheck, unit/provider/integration/evaluation/security suites, and the
      Vite production build all completed successfully
- [x] Complete independent review with no blocker, high, or medium findings
- [x] Exact implementation-head hosted CI
      [29963114892](https://github.com/Ayyitskevin/Icarus/actions/runs/29963114892)
      passed at `cb3b97f8fc68b0bf451709b2a023031dc10c1177`

## Accepted sixth M3 observation slice: bounded approval provenance

ADR 0019 and its implementation are merged. The recorded combined local gate,
independent review, and exact implementation-head hosted CI passed. This accepts
only this bounded observation slice; it does not complete M3 or close ADR
0025's residual release work.

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
- [x] Exact implementation-head hosted CI
      [29963114892](https://github.com/Ayyitskevin/Icarus/actions/runs/29963114892)
      passed at `cb3b97f8fc68b0bf451709b2a023031dc10c1177`

## Fifth M3 slice: bounded verification-attempt provenance

Status values are evidence claims. ADR 0018 and its implementation are complete,
with fresh local acceptance recorded on 2026-07-22. Exact published-head hosted
CI [29934193961](https://github.com/Ayyitskevin/Icarus/actions/runs/29934193961)
passed before merge at `10b4dfed65a473b3da8d886bf0e5ed8c4078cd21`.
This accepts only the fifth bounded slice, not full M3.

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
      ADR 0025 residual third-party review and secret-rotation holds
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
      source isolation, portability, guarded CLI, and ADR 0025 release boundaries
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
      guarded CLI, source-isolation, portability, and ADR 0025 release boundaries
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
- [x] At this historical slice, preserve the inherited ADR 0010 operator hold
      without changing or blessing `.github/workflows/opencode.yml`; ADR 0025
      later chose and implemented hardening

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

At this slice's authoring/candidate-time checkpoint, native macOS and Windows
host runs remained unrecorded and platform-policy paths were covered on the
Linux test host. Exact-head native acceptance was later recorded in run
30602949132. Registry dependency audit was intentionally not part of that
no-network local slice.

## Prior plan: Milestone 0 plus minimal Milestone 1

Status values are evidence claims. A checked item must be backed by a command or
test named below.

Status: final-adversarial-audit repairs were implemented; the fresh local gate
and exact implementation-head hosted CI passed. This is historical M1 evidence;
ADR 0023 later superseded its one-file mutation boundary and ADR 0025 resolved
its pending workflow decision by hardening.

ADR 0025 records Kevin's hardening decision. Its third-party action review and
secret rotation remain release work; the decision itself is no longer open.

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
- [x] Strict one-file proposal validation and `awaiting_approval` stop for this
      historical slice; ADR 0023 later superseded the mutation boundary

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
- [x] Kevin chose hardening in ADR 0025; third-party action review and secret
      rotation remain separate release holds

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
and `git diff --check`. Hosted CI and ADR 0025's residual security work are
separate mandatory release evidence; neither can be inferred from a local pass.

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

ADR 0025 resolved ADR 0010 by hardening; its third-party review and secret
rotation remain separate from local feature work.
ADR 0016 implements only bounded older event metadata for the third M3 slice.
ADR 0017 implements only bounded workspace-wide run summaries for the fourth.
ADR 0019 bounds only the ordinary newest approval suffix. ADR 0020 presents only
the legacy browser projection of an already persisted one-file diff. ADR 0021
bounds the project/repository catalog and aggregate JSON transport. ADR 0023's
CLI transactional PatchSets and ADR 0026's failed-verification session are now
implemented in the released Gate 0 baseline. Older approval pagination, current
file/status views, multi-file or payload-bearing browser diff/history, and
browser action kinds outside ADR 0029's closed eight-kind Linux matrix remain
later, explicitly reviewed expansions.
See `docs/ROADMAP.md`.
