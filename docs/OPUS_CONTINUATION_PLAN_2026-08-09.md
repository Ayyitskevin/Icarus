---
document: OPUS_CONTINUATION_PLAN
repository: Ayyitskevin/Icarus
window: 2026-08-09 (Sat) through 2026-08-11 (Mon)
base_commit: ec0c1403dfdf252d9852557f72453555f9a40834
status: READY_FOR_OPUS
supersedes: docs/OPUS_WEEKEND_PLAN_2026-08-08.md
governing_direction: docs/adr/0036, docs/ICARUS_COLLABORATIVE_IDE_GAME_PLAN.md
---

# Icarus continuation plan (Fable review, 2026-08-09)

This plan supersedes `docs/OPUS_WEEKEND_PLAN_2026-08-08.md`. That plan's S1
(the bounded GitHub gateway) merged as PRs #25/#26/#27; its S2–S6 did not
start, and two of its assumptions no longer hold (Packet 4 is no longer "not
started", and the accepted gateway design deliberately rejects the retry
policy S1's brief specified). This document records intent and sequencing
only. It grants no authority: no session may use it to justify live
credentials, live-state migration, force-push, merge, deployment, production
access, or any external effect beyond pushing commits to its own working
branch and opening a draft pull request. Human approval gates named in the
ADRs remain human.

## 1. Where Icarus stands (verified at base commit)

Verification performed 2026-08-09 on Linux (Node 22.23.2, pnpm 9.15.4,
Docker 29.1.3, both digest-pinned sandbox images present):

- `pnpm check` passes completely: workflow lint, format, lint, typecheck,
  unit 815/815, integration 117/117, eval ("Gate 1 benchmark contract:
  3 passed, 0 failed, 3 live-evidence not run"), security, build.
  Without the pinned images the sandbox correctly fails closed
  (verification `unavailable`), so a fresh environment must
  `docker pull` both pins before trusting local red.
- Hosted CI on `main` is green through PR #27 (run 31256038987).
- Every remote branch is at or behind `main` except two stale pre-rebase
  duplicates of already-merged work. There is no in-flight unmerged work.
- Gate state: Gate 0 released at `802b91e6`. Gate 1 Packets 1–3 complete
  (browser authority + durable local landing through `local_ready`).
  Packet 4a — the gateway package — is merged but **wired to nothing**:
  no package imports `@icarus/github-gateway`; it is reachable only from
  its tests, the root tsconfig, and `scripts/security-check.mjs`.
  Packets 4b (remote landing coordination + receipt) and 4c
  (credential-gated live-evidence profile) are not started. Gate 1 closes
  only on Kevin's live 3/3 acceptance.

## 2. Fable assessment update

Scored on ADR 0036's axes against the requested end state. The previous
review scored ≈5.2.

| Area | Weight | Prior | Now | Movement |
| --- | ---: | ---: | ---: | --- |
| Trust, safety, and evidence | 20% | 8.5 | 8.5 | gateway extends the boundary discipline; two real vulnerabilities (workflow-file RCE path, loopback credential leak) were found and closed by review before any wiring existed |
| Autonomous coding capability | 20% | 5.5 | 5.5 | unchanged; still no retrieval |
| IDE/workbench experience | 15% | 3.0 | 3.0 | unchanged |
| Runnable app/platform capability | 15% | 1.5 | 1.5 | unchanged |
| Architecture and maintainability | 10% | 6.0 | 6.0 | gateway is clean (zero deps, closed operation table); `service.ts` at 5,032 lines and `store.ts` at 7,134 remain the watch item |
| Tests, evals, and release discipline | 10% | 8.0 | 7.5 | PRs #25–27 merged with no independent-review record and no doc updates; `docs/PLANS.md` "exact-tree verified" checklist is four merges stale |
| Extensibility and ecosystem | 5% | 2.0 | 2.0 | unchanged |
| Product/document coherence | 5% | 5.0 | 4.5 | `docs/PLANS.md:489-496` still denies Packet 3 exists; every status doc predates the gateway |
| **Weighted** | | **≈5.2** | **≈5.15** | |

Honest reading: the newest code is good and the review process demonstrably
works — but the repository's own governance ("docs move with behavior",
independent review before acceptance) was not applied to its newest merges.
The moat is only a moat if the evidence discipline holds under velocity.
This plan therefore starts by paying the truth debt, then spends the rest of
the window on the Gate 1 spine.

## 3. Findings the sessions below must consume

Gateway interface gaps (all in `packages/github-gateway`), found by review
at the base commit — S1b exists to close these before S2 builds on the
surface:

1. **Owner case.** `assertOwner` (`src/identifiers.ts:79-86`) accepts
   lowercase only, but the real remote is `github.com/Ayyitskevin/Icarus`.
   `readActor("Ayyitskevin")` throws outright, and the reconciliation
   filter `head=${owner}:branch` (`src/gateway.ts:536`) compares a value
   GitHub builds from the canonical login case. As shipped, reconciliation
   against this very repository would return `[]`, then duplicate the PR.
2. **Base-ref read is inexpressible.** Core's contract defines
   `github.base_ref.get` (`packages/core/src/landing-records.ts:1920`),
   and the coordinator needs the base branch's commit SHA as the new
   commit's parent — but `readReference` hard-requires an
   `refs/heads/icarus/*` ref (`src/gateway.ts:494`). No gateway method can
   read `refs/heads/main`.
3. **Reconciliation page vs response ceiling.** `per_page=100` with a
   1 MiB `MAX_RESPONSE_BYTES` (`src/http.ts:5`): PR list entries carry
   full body text, so a busy head can exceed the ceiling and produce
   `GITHUB_RESPONSE_TOO_LARGE` on a legitimate read — a new reconciliation
   deadlock in the exact place PR #27 fixed one.
4. **`headOwner` conflation** — the gateway hardcodes the repository owner
   as the PR head owner (`src/gateway.ts:536`); core's contract carries a
   distinct `headOwner` (`landing-records.ts:1982`). Fork heads are
   inexpressible; fine, but undocumented.
5. **Rate limits** collapse to bare `GITHUB_HTTP_ERROR`; no
   `Retry-After`/remaining-quota integer is surfaced.
6. **`merged_at: ""` inconsistency** — selection treats any string as
   merged (`src/gateway.ts:661`) while `isMerged` requires non-empty
   (`:627`); divergent verdicts on the same row.
7. **Untested paths**: `buildOperationUrl` coordinates invariant
   (`src/operations.ts:118-122`), opaque `status: 0` redirect guard
   (`src/http.ts:146`), `GITHUB_REQUEST_TOO_LARGE`, `GITHUB_TREE_INVALID`,
   `GITHUB_COMMIT_PARENTS_INVALID`, the `GITHUB_TIMEOUT` classification
   branch, the merged/closed ambiguity branches of
   `selectReconciledPullRequest`, and the loopback opt-in error code.
   All three test files import deep `src/` paths, so the published
   `index.ts` export surface is itself untested.
8. **Open design decision** (recorded in PR #25): value-argument API vs
   consuming decoded `LandingHttpRequestV1` records. Decide before S2.

Kernel readiness facts (verified) that make S2 smaller than the previous
plan assumed:

- `packages/core/src/landing-records.ts` (3,511 lines) already implements
  essentially the entire ADR 0027 v1 record contract **including all
  GitHub stages** — operation inputs, HTTPS admission grammar, stage
  result values, event payloads. The only missing contract element is
  `LandingReceiptV1` (encode/decode/digest; field order at ADR 0027
  `:1125-1160`).
- `packages/core/src/landing-state.ts` already declares every remote
  state, operation kind, and HTTP kind. No state-machine edits needed.
- The Packet 3 → 4 boundary is a small set of deliberate hard refusals to
  open: `PACKET3_STATES`/`PACKET3_OPERATION_KINDS`
  (`landing-ledger.ts:76-91`, enforced at `:419` and `:650`), the
  no-HTTP/no-receipt guard (`landing-ledger.ts:1905-1914`), the ≤1
  operation-per-attempt cardinality guard (`landing-ledger.ts:1149`), and
  the two resume refusals (`service.ts:1560-1567`, `:1600-1605`).
  `gate1-schema.ts` already creates `landing_receipts` (`:483-488`) and
  the `one_create_pr_post_per_landing` index (`:466-468`).
- The crash-matrix pattern to extend is
  `tests/integration/landing-crash-recovery.test.ts` (self-spawning
  worker, `CrashPhase` enum, marker-file rendezvous, SIGKILL of the
  process group, reopen-and-assert). Remote phases inject through a
  loopback HTTP transport the same way `DuringCas` proxies `update-ref`.
- Receipt presentation is a four-file lockstep change:
  `packages/core/src/types.ts:843` → `landing-presentation.ts` →
  `packages/api/src/present.ts:1313` → `packages/workspace/src/api.ts`
  exact-key validators → `LandingPanel.tsx`.

Documentation debt (verified): `docs/PLANS.md:489-496` denies Packet 3;
`PLANS.md` has no Packet 3 or Packet 4a record at all; README/ROADMAP/game
plan/DECISIONS/ADR 0036/ARCHITECTURE all still say the gateway doesn't
exist; `THREAT_MODEL.md` and `OPERATIONS.md` have zero gateway rows despite
a closed RCE path and a loopback-credential opt-in living in a package
README; the game plan cites ADRs 0028/0030–0035/0037/0038 that have no
files; ADR 0041 remains honestly Proposed awaiting an independent review
record.

## 4. Objective for this window

> By Sunday night: the docs tell the truth at head; the gateway's interface
> gaps are closed under an accepted ADR; Packet 4b's remote landing
> coordination and receipt exist offline with deterministic evidence and an
> extended crash matrix; the live-evidence profile and Kevin's Monday
> runbook are in review; the Gate 2 benchmark contract and the
> deterministic-retrieval ADR draft exist — with every session leaving
> `pnpm check` green and dependency-ordered PRs.

Gate 1 still closes only on Kevin's credentialed 3/3 Monday run.

## 5. Non-negotiable session rules

Rules 1–8 of the superseded plan carry over verbatim (read them there),
with these amendments:

9. **No session builds on the gateway surface before S1b merges.** The
   owner-case and base-ref gaps are correctness-blocking for the real
   repository; wiring first and patching later would bake the workaround
   into the coordinator.
10. **Every PR files its independent-review record in the same PR** (a
    short reviewer-role section in the PR description naming what was
    checked and what was not). PRs #25–27 lack one; S1b's includes a
    retroactive record for the gateway package.
11. **One branch per PR; a session may ship sequential PRs.** S2
    deliberately ships a mechanical-extraction PR before its feature PR.
12. Docs-only sessions still run the full local gate before handoff —
    `format:check` covers the tree, and stale-claim edits are exactly
    where silent drift starts.

## 6. Session plan

Ordering: S0 → S1b → S2a → S2b → S3 form the spine, strictly ordered.
S4 and S5 are parallel-safe by construction (new files only). S6 closes.

### S0 (Sat morning, small) — truth reconciliation

- **Branch:** `opus/s0-docs-truth`
- **Goal:** every status line in the repo agrees with the tree at head.
- **Exact work list:**
  1. Rewrite `docs/PLANS.md:489-496`; add a Packet 3 acceptance record
     (mirroring the game plan's `:635-660` checkpoint) and a Packet 4a
     record worded precisely as *"gateway package merged (PRs #25–27,
     two security fixes under review), unwired; 4b/4c not started"*.
  2. Update the stale "remain incomplete" sentences: `README.md:46-48`,
     `docs/ROADMAP.md:324-326`, game plan `:17-18`, `:353-355`, `:492`,
     `:590`, `docs/DECISIONS.md:33,35`, ADR 0036 `:6-8`,
     `docs/ARCHITECTURE.md:129-130`. Do not over-correct: Packet 4 as a
     whole remains open.
  3. Add THREAT_MODEL rows for the gateway: workflow/CI-file upload as an
     RCE vector (mitigated by `GITHUB_AUTOMATION_PATH_DENIED`), loopback
     origin as a credential-disclosure vector (mitigated by the
     `allowLoopback` construction opt-in), 422 ambiguity
     (`GITHUB_REF_CREATE_REFUSED` / `GITHUB_PULL_REQUEST_CREATE_REFUSED`
     never claim benign "exists"), and interrupted-mutation ambiguity
     (`GITHUB_OUTCOME_AMBIGUOUS`). Add the matching OPERATIONS paragraph
     (env-only token at call time, no persistence).
  4. Mark `docs/OPUS_WEEKEND_PLAN_2026-08-08.md` superseded by this file
     in its frontmatter; re-date the game plan header; refresh or drop
     the stale `PLANS.md:59` "exact-tree verified" checklist (state what
     was re-verified at this PR's head, honestly).
  5. Add a one-line "reserved ADR numbers" note to `docs/DECISIONS.md`
     covering 0028/0030–0035/0037/0038 so citations stop implying files.
- **Explicitly out:** any runtime or test change; any ADR status change
  (0041's review is its own task, below).
- **Evidence:** full `pnpm check` output; a grep transcript showing no
  remaining "gateway … remain(s) incomplete" claim.

### S1b (Sat midday) — gateway interface reconciliation + ADR 0043

- **Branch:** `opus/s1b-gateway-interface`
- **Goal:** the gateway surface S2 wires against is correct for the real
  repository and its authority decisions live in the decision record.
- **Work:**
  1. **Owner case:** accept mixed-case owner/repository input, validate
     charset, preserve case in values; lowercase only where GitHub is
     documented case-insensitive (URL path segments); compare
     `readActor` logins and reconciliation head labels
     case-insensitively. Add regression tests using `Ayyitskevin`
     literally.
  2. **Base-ref read:** add the ninth operation to `GITHUB_OPERATIONS` +
     a `readBaseReference` method matching core's already-defined
     `github.base_ref.get` (validated by `assertBaseBranch`, GET-only,
     404 → `null`). Extend the record-contract agreement test.
  3. **Reconciliation page:** settle the `per_page=100` vs 1 MiB ceiling
     conflict. Recommended: bounded pagination (pages of 25, at most 4
     pages, each page a separately admitted HTTPS request under the
     existing `requestOrdinal` ceiling), failing closed beyond the
     window. Alternative if the contract change is too wide for this
     window: keep page 1 fail-closed and document
     `GITHUB_RESPONSE_TOO_LARGE` as an operator-recoverable
     reconciliation hold. Contract text and gateway must move in the
     same PR either way.
  4. **Rate limits:** surface `Retry-After` / remaining-quota as bounded
     integers on `GithubGatewayErrorDetails`; never header text.
  5. Fix `merged_at: ""`; decide and document `headOwner` (recommend:
     same-repo heads only, stated in ADR 0043); reject empty-string
     blob content or record why it's accepted.
  6. Close the §3-item-7 test gaps; add one test importing only from
     `src/index.ts` so the export surface is covered; dedupe the two
     ">1 open PR" tests.
  7. **Settle the argument-shape decision: keep value arguments.** The
     coordinator owns durable admission and translates records to
     values; the gateway stays import-free of core. Record it.
  8. **ADR 0043 — GitHub gateway boundary** (Accepted, short): closed
     8→9 operation table, GET/POST-only inexpressibility, automation-path
     denial, loopback opt-in, no-internal-retry posture (retry belongs to
     the coordinator's durable intent), 422-as-refusal codes, case
     handling, same-repo head rule. Include the retroactive
     independent-review record for PRs #25–27. Index it in DECISIONS.md.
- **Explicitly out:** any `packages/core` change beyond the agreement
  test; any wiring.
- **Evidence:** full `pnpm check`; new tests enumerated in the PR.

### S2a (Sat afternoon, mechanical) — landing coordinator extraction

- **Branch:** `opus/s2a-landing-coordinator-extraction`
- **Goal:** behavior-identical move of the landing coordinator out of
  `service.ts` (5,032 lines) before it grows by another thousand:
  module-level helpers `service.ts:351-530` and the coordinator band
  `:1155-1608` into a new `packages/core/src/landing-coordinator.ts`
  behind the existing injectable `LandingGitService` seam.
- **Rule:** no behavior, signature, or test-expectation change; the diff
  should be reviewable as pure motion. If any test needs more than an
  import-path edit, stop and report.
- **Evidence:** full `pnpm check`; `git diff --stat`; a note confirming
  zero test-body changes.

### S2b (Sat evening–Sun) — Packet 4b: remote landing coordination + receipt

- **Branch:** `opus/s2b-remote-landing` (branched from S2a; rebase when it
  merges)
- **Goal:** wire the gateway into the landing coordinator per ADR 0027's
  record contract, through `landed`, offline against deterministic fake
  transports.
- **Work, in dependency order:**
  1. Add `@icarus/github-gateway` as a dependency of `@icarus/core`
     (+ tsconfig project reference). Direction is safe: the gateway
     imports nothing from core.
  2. `LandingReceiptV1` in `landing-records.ts` per ADR 0027 `:1125-1160`
     (the one unimplemented contract element), with canonical
     encode/decode/digest and unit tests mirroring the existing record
     tests.
  3. Open the Packet 3 gates listed in §3 — widen the two allowlists,
     replace the no-HTTP/no-receipt refusal with contract-conformant
     decoding, fix the operation-cardinality guard for multi-operation
     attempts, and widen `resumeLanding` dispatch — keeping every
     refusal that still applies (non-Linux, decision one-shot,
     attempt ceiling 8).
  4. New `#execute*` stages in the (now extracted) coordinator:
     preflight (base-ref read via the S1b operation), object upload
     (blob/tree/commit, intent-before-effect per object batch), remote
     ref (absent-only, durable prior-absence + intent, mirroring the
     local CAS discipline), draft PR (at-most-once POST under
     `one_create_pr_post_per_landing`; a lost response is never
     retried — reconcile via `readPullRequestByHead`), and receipt
     (one transaction: insert receipt, settle operation, append event,
     transition `landed`; retry returns the stored receipt with zero
     network).
  5. Honor the contract's takeover/reconciliation rules exactly:
     subject selection is evidence-derived, `created` vs `reconciled` is
     never caller-chosen, `remoteResidue` mapping as specified
     (contract `:908-935`).
  6. Credential resolution: env-only at call time through the existing
     allowlist (`service.ts:832-861` pre-extraction); never persisted,
     never in the receipt; redaction tests on every new error path.
  7. Extend the crash matrix: new `CrashPhase` values before/during/after
     each POST class and the receipt commit, injected through a loopback
     GitHub transport; reuse `crashAt` unchanged. Duplicate-effect
     assertions on every reopen.
  8. Receipt presentation through the four-file lockstep chain (§3),
     CLI `landing status`/`resume` coverage, and the same bounded
     projection in `LandingPanel.tsx` (read-only; no new browser
     authority).
  9. Docs in the same PR: threat model rows for remote effects, PLANS
     Packet 4b record, OPERATIONS (no live migration; the schema already
     contains `landing_receipts` — verify whether `landing-ledger-v1`
     migration state needs any note at all, and if existing operator
     state would need one, stop and write the question into the PR).
- **Constraints:** file-only `GitController` boundary untouched; no
  browser-held credentials; no live GitHub call anywhere in tests; every
  remote effect intent-logged before I/O and settled after; Linux-only
  mutation refusal preserved.
- **Explicitly out:** live-evidence profile execution (S3), `EVALS.md`
  (S4's append), any live-state migration.
- **Evidence:** crash-matrix results enumerated per phase; full
  `pnpm check`; honest environment-limited list.

#### S2b execution note (added 2026-08-09 while executing)

S2b is shipping in slices rather than one pull request, for a reason worth
recording: several of its steps are *fences* rather than features. The
`PACKET3_STATES` and `PACKET3_OPERATION_KINDS` allowlists, the
no-HTTP/no-receipt refusal, and the operation-cardinality guard exist so that
Packet 3 cannot silently half-implement Packet 4. Opening them in a slice that
does not yet contain the coordinator stages producing those rows would weaken
fail-closed decoding for no gain — a fence should come down in the same change
that brings in the thing it was fencing.

The slices are therefore:

- **S2b-i — receipt record.** `LandingReceiptV1` encode/decode/digest, the one
  ADR 0027 contract element with no implementation. Pure addition, no behavior
  change, no gate opened. Unblocks everything below.
- **S2b-ii — coordinator stages + gates.** The `@icarus/core` dependency edge on
  the gateway, the four `#execute*` remote stages, the Packet 3 gates opened
  alongside them, widened `resumeLanding` dispatch, and the extended
  crash-kill matrix. This is the load-bearing review. See the ledger survey
  below before starting: it is larger than "open the fences".
- **S2b-iii — receipt presentation.** The four-file lockstep projection chain
  (`types.ts` → `landing-presentation.ts` → `api/present.ts` → workspace
  `api.ts` exact-key validators → `LandingPanel.tsx`), CLI coverage, and docs.

#### S2b-ii ledger survey (2026-08-09) — read this before writing code

Surveyed at `landing-ledger.ts` (3,165 lines) while starting S2b-ii. Three
facts make the work smaller than feared, and one makes it larger.

Smaller than feared — **none of these need changes**:

- **The SQL schema is already complete and already a fence.** Every remote
  state, operation kind, and HTTP kind is permitted by the DDL, and
  `landing_http_requests` carries a CHECK enumerating the exact
  operation-kind × method × HTTP-kind matrix, so the database rejects an
  out-of-contract row independently of the code. `landing_receipts` keys on
  `landing_id`, so at most one receipt per landing is structural.
- **The state machine is complete.** `landing-state.ts` already declares every
  remote state, transition, resume target, expected-state map, action-state
  map, and operation→HTTP-kind map. No edits.
- **The record layer is complete** after S2b-i. `LandingHttpRequestV1`,
  the GitHub POST bodies, every stage result value, both
  `landing.github.request.*` event payloads, and now `LandingReceiptV1` all
  decode today; the ledger simply never calls them.
- **`kindAttempt` machinery is already kind-generic** (ceiling 9, contiguity
  re-derived at load and during replay). Reuse `#startOperation` verbatim once
  its `kind` parameter is widened.

Larger than feared — **the fences are not the work.** Widening
`PACKET3_STATES` / `PACKET3_OPERATION_KINDS` is four lines, but thirteen
nearby invariants encode Packet 3's shape and will silently mis-fire or
hard-fail. Each must be handled deliberately:

1. `decodeOperationRow`'s observation-shape check (`:736-762`) implicitly
   means "`landing.reconcile`" and demands exactly two facts
   `[subject_operation, local_ref]` with null `requestId`. A remote reconcile
   observes `actor`/`base_ref`/`head_ref`/`pull_requests` facts with
   **non-null** `requestId`.
2. `validatePacket3OperationSettlement` (`:903-985`) falls through to
   local-ref reconciliation rules; any `github.*` operation is rejected.
3. `validateAggregate`'s per-kind input binding (`:1023-1116`) has the same
   fall-through, and its `else` requires `resumeState !== "approved"`.
   Remote reconciles carry `local_ready`/`objects_ready`/`remote_ready`.
4. `localReconciliationSubject` (`:843-884`) filters `local_ref.create` only
   and is called for **every** `reconciliation_required` load (`:1180`), plus
   `admitResume` and reconciliation settlement. Remote subjects are invisible
   to it.
5. `decodeLandingRow`'s candidate-column required-state set (`:508-520`) omits
   the remote states, so a `landed` row would not be required to carry
   candidate columns — a silent weakening rather than an error.
6. `validateAggregate` active-state matching (`:1152-1166`) hardcodes three
   kind→state pairs; needs the three remote effect states, and
   `github.preflight` maps to **no** action state.
7. Decision-consistency (`:1167-1182`) enumerates the permitted states for an
   approved landing; every remote state and resume state must be added or an
   approved landing that reaches `uploading_objects` fails to load.
8. The event-replay transition arms (`:1497-1568`) cover Packet 3 only and end
   in `invalid("… non-Packet-3 transition")`; every remote arm of
   `DIRECT_TRANSITIONS` needs one.
9. The replay admission-state gate (`:1358-1362`) must admit `local_ready`,
   `objects_ready`, `remote_ready`.
10. `expectedEventCount` (`:1583-1591`) must add
    `httpRequests.length + settled httpRequests`, or every landing with an
    HTTP row reports an omitted/extra event.
11. The attempt-cardinality guard (`:1142-1150`) asserts **at most one
    operation per attempt**. Packet 4 legitimately runs `github.preflight`
    then an effect operation in one attempt. This cannot be relaxed to
    "any number" — it must become an ordered-sequence rule (at most one
    preflight, then at most one effect, attempt status equals the last
    operation's).
12. `admitResume`'s `expectedActiveKind` ternary (`:2885-2903`) and its
    `resumable` set (`:2968-2972`) both enumerate Packet 3 states.
13. `remoteResidue: "none"` is pinned in five settlement sites (`:2758`,
    `:2917`, `:2929`, `:3054/:3079`, `:3103`) and asserted at load in two
    (`:931`, `:953/:963`).

Also note: the ledger admits only **6** of the 8 event types
(`:247-254`, `:806-815`) — the two `landing.github.request.*` types are
absent; `LandingOperationRecordV1.kind` is a 3-kind literal union (`:231`)
with a matching cast at `:763`; and `one_create_pr_post_per_landing` (the
strongest at-most-once guarantee in the schema) has **no** TypeScript
counterpart today.

**Recommended sub-slicing of S2b-ii.** Do the read-only stage first:

- **S2b-ii-a — `github.preflight` only.** Its expected state `local_ready` is
  *already* a permitted Packet 3 state, so this slice widens the operation
  kind but **not** the state set: the mutation states stay fenced and the
  slice is structurally incapable of a remote mutation. It nonetheless builds
  the entire HTTP admission/settlement machinery (`requestOrdinal` per
  `(landing, attempt)` under the `2 * changedPaths + 32` charge, the
  admitted-before-I/O event, settlement, and the status/`validateAggregate`
  threading) that every later stage reuses. Invariants 1, 2, 3, 6, 10, 11, 12
  are in scope here; 4, 5, 7, 8, 9, 13 are not yet reachable.
- **S2b-ii-b — object upload and remote ref** (the first mutations, and the
  remote-reconciliation subject work: invariants 4, 8, 9, 13).
- **S2b-ii-c — draft PR and receipt** (invariants 5, 7, plus a TypeScript
  counterpart for `one_create_pr_post_per_landing`).

The crash-kill matrix extends per slice rather than at the end: each slice
adds its own `CrashPhase` values through the loopback transport.

### S3 (Sun) — Packet 4c: live-evidence profile + Kevin's Monday runbook

Unchanged in intent from the superseded plan's S3 (schema + refusing CLI
scaffold `benchmark:gate1:live` + OPERATIONS runbook; mock evidence cannot
close the gate and the doc must say so), plus two additions learned this
week: the runbook's preflight includes verifying canonical owner-case
behavior against the real repository (S1b's fix, checked live before any
mutation), and the repository-automation assessment step explicitly lists
the workflow-file classes the gateway refuses. Fine-grained token: contents
+ pull-requests on named approved repos only; created by Kevin, never
handed to a session.

### S4 (parallel-safe, any day) — Gate 2 benchmark contract

Unchanged from the superseded plan's S4: new files only
(`fixtures/evals/gate2/**`, a validation script, one end-of-file `EVALS.md`
section) defining retrieval recall/precision, plan-acceptance,
success-count, incorrect-edit, and cost gates with pinned fixture
repositories, mirroring the Gate 1 manifest discipline. G2's dependency is
the Gate 1 *benchmark contract* (satisfied), not Gate 1 closure — this is
legal now.

### S5 (parallel-safe, Sun) — ADR 0044: deterministic retrieval (draft)

The superseded plan's S5, renumbered (0043 is taken by the gateway
boundary): repository map v2, stack detection over pinned Git objects,
bounded `rg` adapter over manifest-approved paths — binary pinning,
argument-array construction, match/byte/time ceilings, span provenance,
fenced-untrusted retrieved text, eval hooks into S4's manifest. Proposed
status; no runtime. Additionally: file the independent review of ADR 0041
(Change Rooms) so it can leave Proposed honestly, or record why not.

### S6 (Sun evening) — integration close + dogfood demo

After S2b merges: rebase-verify, full local gate, then one real end-to-end
dogfood run on a small fixture repository through the production CLI +
browser path — plan → approve → PatchSet → sandbox verify → review →
local landing → **remote landing against the deterministic fake
transport** → receipt — captured as a bounded, redacted receipt-chain
artifact in `docs/`. Update the game plan checkpoint table honestly.
**Stop rule:** if S2b did not merge, S6 is a review-and-fix session for
S2b. No new capability on Sunday night.

## 7. Conflict and sequencing matrix

|  | S0 | S1b | S2a | S2b | S3 | S4 | S5 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| S0 docs | — | disjoint | disjoint | S2b re-touches PLANS/threat model after S0 merges | disjoint | EVALS append after S0 merges | disjoint |
| S1b gateway | | — | disjoint | S2b depends on S1b | disjoint | disjoint | disjoint |
| S2a extraction | | | — | S2b depends on S2a | disjoint | disjoint | disjoint |
| S2b core/api/ui | | | | — | S3 avoids coordinator files | disjoint (new files + EOF append) | disjoint |
| S3 schema/CLI/runbook | | | | | — | disjoint | disjoint |
| S4 fixtures/evals | | | | | | — | S5 references, no shared files |

Merge order: S0 → S1b → S2a → S2b → S3; S4/S5 whenever green. Later
branches rebase onto `main` after each merge; never cross-merge.

## 8. Kevin's checkpoints (human-only, ~15 min each)

1. **Sat midday:** review/merge S0 (fast — it makes every later review
   honest), then S1b. On S1b, confirm ADR 0043 tells the authority story
   the way you want it told, and that the retroactive review record for
   #25–27 reads honestly.
2. **Sat evening:** review/merge S2a (mechanical, fast).
3. **Sun:** review/merge S2b — the load-bearing review of the window.
   Check intent-before-effect ordering on each of the four remote
   stages and the receipt's metadata-only discipline. Dispatch native
   macOS/Windows acceptance at the merged head.
4. **Sun evening:** review S3's runbook; create the fine-grained GitHub
   token yourself; review/accept-or-annotate S4, S5.
5. **Mon:** run the credential-gated live-evidence profile yourself, 3/3,
   per the S3 runbook. That — not any weekend artifact — closes Gate 1.
6. Standing: no session self-merges; approvals and merges stay with you.

## 9. Explicitly not in this window

Unchanged from the superseded plan: VS Code extension work (G3 — after
Gate 1 closes and `@icarus/client` is extracted), Council/Mission-Room
state or participant provider calls (ADR 0037 first), Replit-class
environments (G4), Supabase change packs (G5), semantic/embedding
retrieval (deterministic baseline first), any live-state migration, any
Cursor-parity claim. Also explicitly not: any live GitHub token in any
session, and any "Gate 1 closed" language before Kevin's Monday evidence
exists.

## 10. Exit state

If this window holds: the docs are truthful at head; the gateway's
authority story is in the decision record; the first full
task → verified change → local landing → remote landing → draft-PR →
receipt chain exists offline with crash evidence; and Gate 1 is exactly
one credentialed human acceptance from closing. The next window then
targets G2 runtime (map v2 + bounded search) and the `@icarus/client`
extraction that unblocks the center IDE — the two largest capability gaps
against Cursor, in gate order.
