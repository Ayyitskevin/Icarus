# H2b bounded headless worker evaluation — 2026-08-21

## Decision and assumptions

The evaluated slice is ADR 0048 only: one existing Icarus run is approved,
bound, executed, made quiescent, and settled under one Linux lease. It does not
add replay/resume, children, schedules, deployment, SearXNG, or DeepAPI.

Assumptions tested rather than inferred:

- the H2a binding precedes workspace/provider effects;
- profile ceilings tighten the cumulative run ledger and cannot reset spend;
- a profile tool filter is additional to, never a replacement for, plan grants;
- every started worker ends with no active operation and one durable settlement;
- expected incomplete outcomes use nonzero process semantics.

External design research and paid-provider execution are outside this local
H2b slice. The risky-change research and live-measurement gates therefore
remain open and are not represented as completed evidence.

## Local realistic measurements

Command:

```text
pnpm exec vitest run tests/integration/headless-worker.test.ts
```

Observed: **13/13 passed** using real temporary SQLite state roots, real private
filesystem worktrees, deterministic provider gateways, and deterministic check
runners. No paid provider, internet, source-checkout mutation, or deployment was
used. These are realistic deterministic integration measurements, not live
provider or production-traffic measurements under the risky-change workflow.

| Case | Expected boundary | Observed |
| --- | --- | --- |
| passing one-task change | start before workspace; review-ready; exit 0 | pass |
| already-spent tighter tool ceiling | refuse before worker start | pass |
| session tool omitted by profile | meter, refuse, exhaust; exit 2 | pass |
| signal during first edit call | cancellation recovery; quiescent exit 130 | pass |
| provider profile remapped | H2a refusal before workspace/start | pass |
| tool lacks plan capability | H1/H2a refusal | pass |
| profile budget exceeds project | H1 refusal | pass |
| profile carries unknown provider URL | strict grammar refusal | pass |
| plan digest is stale | no approval or worker lifecycle | pass |
| second invocation | no second worker start | pass |
| provider fails after start | durable failed settlement; exit 1 | pass |
| model requests human input | durable incomplete settlement; exit 3 | pass |
| profile context ceiling is one byte | first headless provider call refused | pass |

Additional focused command:

```text
pnpm exec vitest run \
  tests/unit/headless-worker.test.ts \
  tests/integration/headless-worker.test.ts \
  tests/security/headless-worker-contract.test.ts
```

Observed: **3 files, 29/29 passed**. The unit matrix pins settlement and
quiescence classification; security assertions pin lease ownership, ordering,
durable ceiling admission, additive tool filtering, I/O-free worker helpers,
duplicate-settlement refusal, JSONL output, and exit propagation.

## Remaining gates

- Full `pnpm check` passed locally: 999 unit/provider tests, 170 integration
  tests, 181 security tests, 7/7 supported offline evaluation scenarios, the
  workflow negative self-test, formatting, lint, typechecking, and production
  builds all completed successfully. Three Gate 1 live-evidence benchmarks
  remained explicitly not run, as designed by that benchmark contract.
- One non-author round-table review returned PASS with no required fixes on
  2026-08-21. The author's exact full-gate results remain the verification
  source of truth where reviewer test-count prose differed.
- Deep research and a 10-20+ case live-provider measurement suite remain
  required before any shipping decision; neither was run in this local slice.
- No live provider, hosted CI, native non-Linux acceptance, deployment, or
  Mickey service modification is claimed.
