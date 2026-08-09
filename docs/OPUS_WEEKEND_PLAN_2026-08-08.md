---
document: OPUS_WEEKEND_PLAN
repository: Ayyitskevin/Icarus
window: 2026-08-08 (Fri evening) through 2026-08-10 (Sun)
base_commit: 1d8292b1c3d90814a0cb3b6336a8102e8f7d4b97
status: SUPERSEDED
superseded_by: docs/OPUS_CONTINUATION_PLAN_2026-08-09.md
governing_direction: docs/adr/0036, docs/ICARUS_COLLABORATIVE_IDE_GAME_PLAN.md
---

# Icarus weekend execution plan (Opus)

This plan turns the current gate state into a dependency-ordered set of Opus
work sessions for one weekend. It records intent and sequencing only. It grants
no authority: no session may use it to justify live credentials, live-state
migration, force-push, merge, deployment, production access, or any external
effect beyond pushing commits to its own working branch and opening a draft
pull request. Human approval gates named in the ADRs remain human.

## 1. Where Icarus stands (verified at base commit)

- Gate 0 is released at `802b91e6` with Linux, macOS, and Windows evidence.
- Gate 1 (Verified Change Gate) is partially complete:
  - Packet 1 (authority contracts + Gate 1 benchmark contract) — done.
  - Packet 2 (eight guarded browser lifecycle actions, Chromium boundary) —
    done, release-accepted at `3683087`.
  - Packet 3 (durable, no-network local landing through `local_ready`,
    private `refs/heads/icarus/<run-id>`) — done, merged in PR #23.
  - Packet 4 (bounded GitHub gateway, remote landing + draft PR, metadata-only
    receipt, credential-gated live-evidence profile) — **not started. This is
    the Gate 1 critical path and the weekend's spine.**
- After Gate 1: G2 context quality, G3 VS Code center IDE, C1 Council,
  G4 Replit-class environments, G5 Supabase change packs, per the game plan.

The strategic consequence: Packet 4 is the first moment Icarus produces a
Cursor-comparable artifact — a reviewable draft PR — except carrying a full
proof chain (context digest → plan approval → PatchSet → sandbox verification
→ landing receipt) that no competing tool emits. Finishing it converts three
weeks of kernel work into the first demoable product outcome.

## 2. Fable assessment update

Scored on ADR 0036's axes against the requested end state (Cursor-challenger
IDE with Replit/Supabase/Buzz-class capabilities). Baseline was 5.0/10 at Gate
0 candidate time.

| Area | Weight | ADR 0036 | Now | Movement |
| --- | ---: | ---: | ---: | --- |
| Trust, safety, and evidence | 20% | 8.0 | 8.5 | browser authority + durable landing extended the moat |
| Autonomous coding capability | 20% | 5.5 | 5.5 | unchanged; no retrieval, fixed context recipe |
| IDE/workbench experience | 15% | 2.5 | 3.0 | guarded actions + landing panel; still no editor |
| Runnable app/platform capability | 15% | 1.5 | 1.5 | unchanged |
| Architecture and maintainability | 10% | 6.0 | 6.0 | landing modules well-factored; `store.ts`/`service.ts` growth is a watch item |
| Tests, evals, and release discipline | 10% | 7.5 | 8.0 | Gate 1 benchmark contract + crash-recovery matrices |
| Extensibility and ecosystem | 5% | 2.0 | 2.0 | unchanged |
| Product/document coherence | 5% | 4.5 | 5.0 | game plan coheres the direction |
| **Weighted** | | **5.0** | **≈5.2** | |

Honest reading: the moat is deep and getting deeper; the castle is still
small. Recent progress concentrated in trust and landing plumbing that users
cannot yet see. The weekend should convert kernel capability into
product-visible capability, in gate order, without inventing new authority.

## 3. Weekend objective

> By Sunday night: Packet 4's GitHub gateway and remote-landing runtime exist
> offline with deterministic evidence, the live-evidence profile is specified
> and ready for Kevin's credentialed 3/3 run on Monday, and Gate 2's benchmark
> contract plus the deterministic-retrieval ADR draft are in review — with
> every session leaving `pnpm check`-green, dependency-ordered PRs.

## 4. Non-negotiable session rules

Every Opus session, every branch:

1. Read `AGENTS.md`, ADR 0027 + its v1 record contract, and the Packet 4
   section of `docs/ICARUS_COLLABORATIVE_IDE_GAME_PLAN.md` before writing code.
2. One session, one branch, one draft PR. Never push to `main` or another
   session's branch. Rebase onto current `main` before starting.
3. `pnpm check` must pass locally before handoff; list any
   environment-limited subchecks (root-user chmod tests, sandbox image pulls)
   explicitly and honestly — never report a skipped check as passing.
4. No new runtime dependencies without recording the justification in the PR;
   provider HTTP stays injectable; external processes stay `shell: false`
   argument arrays.
5. Credentials: environment-only, never persisted, never logged, redaction
   tests required on any path that could observe one. No session uses a real
   GitHub token this weekend — deterministic fake transports only.
6. Authority expressible in code is authority that must be bounded in code:
   the GitHub gateway must be structurally unable to express force-push,
   merge, branch deletion, non-allowlisted hosts, or arbitrary Git arguments.
7. Docs move with behavior: threat model rows, OPERATIONS, PLANS status, and
   README scope lines update in the same PR as the runtime they describe.
8. On any ambiguity about authority boundaries: stop, write the question into
   the PR description, and move to the next non-conflicting task. Do not
   widen scope to stay busy.

## 5. Session plan

Sessions are sized for one focused Opus run each. S1→S2→S3 are the spine and
strictly ordered. S4 and S5 are parallel-safe by construction (new files
only). S6 is the integration close.

### S1 (Fri evening) — Packet 4a: bounded GitHub gateway package

- **Branch:** `opus/p4-github-gateway`
- **Goal:** a new, dependency-light `packages/github-gateway` implementing the
  minimal GitHub REST surface Packet 4 names: blob/tree/commit object upload,
  absent-only reference creation, draft-PR creation, and read-back for
  reconciliation. Injectable transport; `api.github.com` origin allowlist;
  token read from env at call time only; typed errors; bounded response
  parsing; retry policy with idempotency keys where GitHub semantics allow.
- **Working set:** the new package, its unit/contract tests, root tsconfig
  project references, `pnpm-workspace.yaml`. Nothing in `core`, `api`,
  `workspace`.
- **Tests:** deterministic fake-transport contract tests covering success,
  each failure class, non-idempotent-retry refusal, ref-already-exists
  refusal (absent-only), credential redaction in every error path, and a
  static assertion that no forbidden endpoint (merge, force update, delete)
  is expressible.
- **Explicitly out:** service wiring, CLI/API surface, live HTTP, docs beyond
  the package README stub.
- **Evidence:** `pnpm check` output in PR; new tests enumerated.

### S2 (Sat) — Packet 4b: remote landing coordination + receipt

- **Branch:** `opus/p4-remote-landing` (branched from S1's head; rebase when
  S1 merges)
- **Goal:** wire the gateway into the existing landing coordinator per ADR
  0027's record contract: durable intent-before-effect for object upload, ref
  creation, and draft-PR creation; terminal reconciliation on reopen;
  metadata/digest-only receipt persisted beside the Packet 3 local-landing
  record; explicit resume; Linux-only mutation refusal preserved.
- **Working set:** `landing-*` core modules, `store.ts` (receipt rows),
  `service.ts` (coordinator), CLI `landing` subcommands, `api/present.ts` +
  `LandingPanel.tsx` receipt projection, integration + real-child-process
  crash tests (extend the Packet 3 kill-matrix pattern), threat model +
  OPERATIONS + PLANS + README updates.
- **Constraints:** the file-only `GitController` boundary is not weakened; no
  browser-held credentials; remote effects require the digest-bound landing
  decision that Packet 3 already records; every remote effect is
  intent-logged before I/O and settled after.
- **Explicitly out:** live GitHub calls, live-evidence profile execution,
  `EVALS.md` (reserved for S4), any migration of existing operator state
  without the documented backup + explicit approval ritual.
- **Evidence:** crash-kill matrix results, full `pnpm check`, honest
  environment-limited list.

### S3 (Sat evening) — Packet 4c: live-evidence profile spec + operator runbook

- **Branch:** `opus/p4-live-profile-spec`
- **Goal:** the versioned, human-approved, credential-gated live-evidence
  profile as a validated schema + CLI scaffolding (`benchmark:gate1:live`
  refusing to run without an explicit operator-approval artifact), plus the
  OPERATIONS runbook Kevin follows Monday: fine-grained token scopes
  (contents + pull-requests on named approved repos only), the
  repository-automation assessment step, pinned provider/model/pricing entry,
  and the 3/3 acceptance recording procedure. Mock evidence cannot close the
  gate and the doc must say so.
- **Working set:** `gate1-schema.ts` (profile schema), CLI, `docs/OPERATIONS.md`,
  `docs/PLANS.md` Packet 4 checklist. No gateway or coordinator changes.
- **Evidence:** schema validation tests; a dry-run refusal transcript.

### S4 (Sat, parallel-safe) — Gate 2 benchmark contract

- **Branch:** `opus/g2-benchmark-contract`
- **Goal:** G2 item 1: versioned benchmark and metric definitions for context
  quality — retrieval recall/precision, plan-acceptance, success-count,
  incorrect-edit, and cost gates — as a closed manifest schema plus pinned
  fixture repositories, mirroring the Gate 1 manifest discipline.
- **Working set:** **new files only**: `fixtures/evals/gate2/**`, a new
  `docs/EVALS.md` section appended at end-of-file (single-hunk append keeps
  S2 conflict-free), a validation script.
- **Explicitly out:** any retrieval runtime, `context.ts`, `tools.ts`.
- **Evidence:** manifest validator passing over the pinned fixtures.

### S5 (Sun morning, parallel-safe) — ADR draft: deterministic retrieval

- **Branch:** `opus/adr-deterministic-retrieval`
- **Goal:** draft the ADR (next free number — 0043 at authoring time) for
  repository map v2, stack detection over pinned Git objects, and the bounded
  `rg` adapter over manifest-approved paths: exact binary pinning/discovery,
  argument-array construction, match/byte/time ceilings, provenance of every
  retrieved span, injection posture (retrieved text is untrusted, fenced),
  and eval hooks into the S4 manifest. Proposed status; no runtime.
- **Working set:** new ADR file, one DECISIONS.md index row, threat-model
  "proposed" rows.
- **Evidence:** doc-only; `pnpm check` still green.

### S6 (Sun afternoon) — integration close + dogfood demo

- **Branch:** `opus/weekend-close`
- **Goal:** after S1–S3 merge: rebase-verify the combined tree, run the full
  local gate, execute one real end-to-end dogfood run on a small fixture
  repository through the production CLI + browser path (plan → approve →
  PatchSet → sandbox verify → review → local landing → remote landing against
  the deterministic fake transport), and capture the receipt chain as the
  demo artifact in `docs/` (bounded, redacted). Update the game-plan
  checkpoint table honestly: what merged, what evidence exists, what remains
  for Gate 1 (live 3/3 only).
- **Stop rule:** if S2 did not merge, S6 becomes a review-and-fix session for
  S2. Do not start new capability on Sunday afternoon.

## 6. Conflict and sequencing matrix

| | S1 | S2 | S3 | S4 | S5 |
| --- | --- | --- | --- | --- | --- |
| S1 new package | — | S2 depends on S1 | disjoint | disjoint | disjoint |
| S2 core/api/ui/docs | | — | disjoint (S3 avoids coordinator) | disjoint if S4 stays new-files + EOF append | disjoint |
| S3 schema/CLI/runbook | | | — | disjoint | disjoint |
| S4 fixtures/evals | | | | — | S5 references, no shared files |

Merge order: S1 → S2 → S3; S4 and S5 merge whenever green. Every later
branch rebases onto `main` after each merge rather than cross-merging.

## 7. Kevin's checkpoints (human-only, ~15 min each)

1. **Sat morning:** review/merge S1. Confirm the forbidden-endpoint static
   assertion reads the way you want your authority story told.
2. **Sat evening:** review/merge S2 — this is the weekend's load-bearing
   review; check intent-before-effect ordering and the receipt's
   metadata-only discipline. Dispatch native macOS/Windows acceptance at the
   merged head.
3. **Sun:** review S3's runbook; create the fine-grained GitHub token (do not
   hand it to any agent session); review/accept-or-annotate the S5 ADR.
4. **Mon:** run the credential-gated live-evidence profile yourself, 3/3, per
   the S3 runbook. That — not any weekend artifact — is what closes Gate 1.
5. Standing: no session self-merges; approvals and merges stay with you.

## 8. Explicitly not this weekend

VS Code extension work (G3 — starts only after Gate 1 closes and the shared
client contract is extracted), Council/Mission Room state or any participant
provider calls (needs ADR 0037 accepted first), Replit-class environments and
previews (G4), Supabase change packs (G5), semantic/embedding retrieval
(measured deterministic baseline first, per G2 ordering), any live-state
migration, and any marketing claim of Cursor parity — the honest claim after
this weekend is a *differentiated verified-change path*, per the game plan's
scorecard rules.

## 9. Monday exit state

If the weekend holds: Gate 1 is one credentialed human acceptance away from
closing; Gate 2 has a benchmark contract and an ADR in review, making context
quality — the largest capability gap versus Cursor — the immediate next
runtime target; and the first full task→draft-PR proof chain exists as a
recorded demo. The following weekend's plan should then target G2 runtime
(map v2 + bounded search) and the `@icarus/client` extraction that unblocks
the VS Code center IDE.
