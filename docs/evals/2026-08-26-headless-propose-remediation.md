# Headless propose/apply remediation evaluation — 2026-08-26

## Decision and scope

This evaluation covers the remediation of the post-merge ADR 0060 findings:
exact proposal identity, proposal/application crash closure, already-spent
invocation envelopes, exhaustion reasons, and `apply` evidence streaming. It
does not authorize live Icarus execution, deployment, scheduling, or an
external provider call.

Assumptions made explicit:

- existing proposals created with the ambiguous digest gain no authority;
  they fail closed and must be proposed again;
- no database migration is needed because the durable checkpoint bytes remain
  the source from which the corrected digest is recomputed;
- the generic Change Handoff reader remains closed to headless lifecycle
  events, while H0 history and the ADR 0061 stream are the supported headless
  evidence surfaces; and
- no tool, plan, child, repository, or deployment grant is widened.

## Primary-source research

- [RFC 8785 — JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785.html)
  supports using one invariant canonical representation before hashing. The
  remediation uses a versioned canonical object and sorts file paths before
  digesting their operation and byte identities.
- [OWASP Transaction Authorization Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Transaction_Authorization_Cheat_Sheet.html)
  recommends binding authorization to significant transaction data, enforcing
  it server-side, and making authorization unique per operation. The apply
  grant now binds path, operation, baseline bytes, and approved bytes, and the
  store independently rechecks that identity before persisting authority.
- [OWASP Business Logic Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Business_Logic_Security_Cheat_Sheet.html)
  recommends explicit state machines, invariant enforcement, and atomic
  check-and-act transitions. The application grammar now admits only the two
  specified first-settlement shapes and closes a second epoch only when its
  single durable intent matches.

These sources support the design principles; the repository's ADRs remain the
normative product contract.

## Test-first reproductions

Before implementation, focused regressions reproduced all three high-risk
failures:

- delete and empty-file proposal digests were equal;
- an apply intent after an interrupted proposal was rejected; and
- an application settlement linked to an interrupted first settlement was
  rejected.

The already-spent approve/apply envelope tests also first failed with
`HEADLESS_PROFILE_ALREADY_EXHAUSTED`; approval validation had already appended
events on the approve path.

## Sixteen-case local measurement

Command:

```text
pnpm vitest run tests/unit/headless-propose.test.ts \
  tests/integration/headless-worker.test.ts \
  tests/unit/change-handoff.test.ts \
  tests/integration/headless-propose.test.ts \
  -t "the patch-set digest|parses a complete proposal|an admitted interrupted proposal|a crashed application epoch|already-spent|proposes only in propose mode|store refuses a direct apply|reconciliation closes a crashed application|interrupted proposal can persist|clamps session turns|doom-loop guard|accepts valid session dispositions|closed evidence enum|proposes by default"
```

Observed: **4 files passed; 16/16 selected cases passed; 83 unrelated cases
skipped by the explicit filter.** The integration cases use temporary real
SQLite state roots and filesystem worktrees; the full CLI case uses a compiled
process and loopback deterministic provider. No paid provider, network effect,
source checkout mutation, or deployment was used.

| # | Case | Required result | Observed |
| ---: | --- | --- | --- |
| 1 | materialization digest compatibility | deterministic over durable checkpoint files | pass |
| 2 | delete vs empty, changed operation, changed baseline | every authority identity differs | pass |
| 3 | proposal → apply → application lifecycle | one intent, linked terminal settlement | pass |
| 4 | interrupted proposal → apply | admitted only as the specified recovery path | pass |
| 5 | crash after apply intent | open epoch then terminal interruption | pass |
| 6 | already-spent approval cost clamp | exit-class error before event or approval | pass |
| 7 | already-spent apply cost clamp | no apply grant or event | pass |
| 8 | propose mode exact-digest application | wrong digest denied; exact digest applies once | pass |
| 9 | direct store call with forged digest | durable checkpoint recheck denies authority | pass |
| 10 | reconciliation after application crash | second interruption closes and spends allowance | pass |
| 11 | recovered interrupted proposal application | application settlement persists | pass |
| 12 | zero-turn invocation clamp | `iteration_ceiling`, exit 2 | pass |
| 13 | repeated effectful tool call | `doom_loop`, exit 2 | pass |
| 14 | valid exhaustion variants in offline reader | iteration, recovery-margin, and doom-loop accepted | pass |
| 15 | unknown exhaustion reason | reader fails closed | pass |
| 16 | compiled CLI propose/apply/stream | exact apply grant and terminal receipt emitted | pass |

## Result and remaining gate

Local remediation evidence: **PASS**. The corrected digest and lifecycle
invariants are enforced in both the service path and the transactional store;
the already-spent invocation envelope refuses before authority; and the
headless stream carries the exact `apply` grant.

Fresh full-gate command:

```text
pnpm check
```

Observed: exit 0; 85 unit/provider files with 1,185 tests passed; 24
integration files with 200 tests passed; 16 security files with 234 tests
passed; 7 supported offline evaluations passed, 0 failed, and 3 live-evidence
cases remained explicitly not run; workflow lint, formatting, lint,
typechecking, evaluation, security checks, and production builds completed.

`pnpm audit --audit-level=high` still reports the pre-existing development-only
`nanoid` 3.3.16 advisory through Vitest/Vite/PostCSS (1 high, 1 moderate). This
change does not modify `package.json` or `pnpm-lock.yaml`; dependency remediation
remains separate debt.

Live-provider measurement was not run. Icarus's recorded live-execution HOLD
therefore remains binding, and one non-author exact-head review plus Kevin's
final merge sign-off are still required.
