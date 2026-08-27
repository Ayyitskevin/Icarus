# Headless read-only session continuation evaluation — 2026-08-26

## Decision and scope

This evaluation covers ADR 0063's single authority extension: after a crash at
a committed provider-plus-read-only session boundary, a reconciled worker may
invoke the next unspent provider turn exactly once. It does not authorize
effectful/control session continuation, fork/concurrency, schedules, remote
children, deployment, a live provider, or live Icarus execution.

Assumptions made explicit:

- the event store and operation ledger are the durable authority; a provider
  request ID is correlation metadata, not an idempotency key;
- `session.iteration_completed` is authoritative only after the complete
  emitted operation batch settles;
- only `session.tool.read.manifest` and `session.tool.read.checks` are admitted;
- a session-boundary reconstruction is a new v2 record, while every ordinary
  reconstruction remains byte-identical v1; and
- no database migration or dependency change is required.

## Primary-source research

- [SQLite atomic commit](https://www.sqlite.org/atomiccommit.html) describes
  the commit record as the atomic point after which a transaction survives a
  process or operating-system crash.
- [SQLite write-ahead logging](https://www.sqlite.org/wal.html) describes the
  WAL commit record that makes the transaction durable while preserving reader
  isolation.
- [OpenAI request IDs](https://platform.openai.com/docs/api-reference/backward-compatibility)
  are documented for request correlation and support. The documentation does
  not grant replay or idempotency authority, so Icarus never retries the prior
  provider turn on that basis.

These sources support the durability choice; ADR 0063 is the normative Icarus
contract.

## Test-first reproduction

The first real CLI fixture killed the worker with `SIGSTOP`/`SIGKILL` after a
durable iteration boundary and then attempted `run resume-headless`. Before the
new gate, the command exited `1` instead of advancing to the next turn. After
the implementation it exits `3` on the deliberately queued human-input result,
records exactly two provider revisions and two boundaries total, and observes
four provider requests total: plan, initial edit, first session turn, next
session turn. The completed first session turn is not replayed.

## Sixteen-case local measurement

Command:

```text
pnpm vitest run tests/unit/session-loop.test.ts \
  tests/unit/headless-reconstruction.test.ts \
  tests/unit/headless-continuation.test.ts \
  tests/integration/headless-continuation.test.ts \
  --reporter=dot \
  -t "continues after one fully settled read-only session turn without replaying it|refuses a completed session turn that used an effectful tool|resumes a reconciled crash exactly once, then returns byte-identical evidence|refuses continuation when the crash tail is ambiguous|closes a crashed continuation once and refuses a second resume|binds the latest monotonic session-iteration boundary into reconstruction|reconstructs the exact binding and classifies a reconciled crash tail|returns byte-identical canonical output for the same durable bytes|admits a clean single-shot crash tail with durable successor intent|refuses any ambiguous crash-tail effect|refuses a settled effect whose durable successor intent is missing|admits only a fully settled read-only session batch at its durable boundary|continues to refuse foreign crash-tail kinds|refuses states that are neither re-drivable nor settle-only|resumes against iterations already spent in the ledger|awaits the durable iteration boundary before advancing or returning"
```

Observed: **4 files passed; 16/16 selected cases passed; 39 unrelated cases
skipped by the explicit filter; duration 9.54 seconds.** The two new
integration cases use compiled CLI subprocesses, temporary real SQLite state
roots and Git worktrees, a deterministic loopback provider, real check
sandboxing, and process-level `SIGSTOP`/`SIGKILL`. No paid provider, external
network effect, source-checkout mutation, deployment, or live service was used.

| # | Case | Required result | Observed |
| ---: | --- | --- | --- |
| 1 | committed read-only batch crash | resume invokes only the next provider turn | pass |
| 2 | committed `run_checks` batch crash | deny before intent; provider count unchanged | pass |
| 3 | existing single-shot clean crash | exactly-once resume and byte-identical retry | pass |
| 4 | ambiguous crash tail | deny before intent or effect | pass |
| 5 | crash during continuation | reconcile once; refuse second resume | pass |
| 6 | monotonic session boundary | emit v2 and bind boundary into digest | pass |
| 7 | reconstructed authority | exact binding and effect classification | pass |
| 8 | ordinary reconstruction | byte-identical canonical v1 | pass |
| 9 | clean single-shot replay gate | retain admission with successor intent | pass |
| 10 | ambiguous effect in pure gate | fail closed | pass |
| 11 | missing durable successor | fail closed | pass |
| 12 | read-only batch gate matrix | admit only settled/pre-boundary reads; deny absent/provider-only/late/effectful cases | pass |
| 13 | foreign operation kind | fail closed | pass |
| 14 | session run state | admit `running`; deny non-re-drivable states | pass |
| 15 | persisted iteration spend | start at the next unspent iteration | pass |
| 16 | asynchronous boundary write | loop cannot advance or return before commit hook resolves | pass |

## Result and remaining gate

Local evidence: **PASS**. The candidate advances only after an exact,
digest-bound completed batch, and both effectful session work and unknown
provider outcomes remain closed. Fresh `pnpm check` completed with exit 0:
85 unit/provider files with 1,188 tests passed; 24 integration files with 202
tests passed; 16 security files with 234 tests passed; seven offline
evaluations passed, zero failed, and three live-evidence cases remained
explicitly not run; workflow lint, formatting, lint, typechecking, evaluation,
security checks, and production builds completed.

`pnpm audit --audit-level=high` still reports the pre-existing
development-only `nanoid` 3.3.16 advisory through Vitest/Vite/PostCSS (one
high, one moderate). This change does not modify `package.json` or
`pnpm-lock.yaml`; dependency remediation remains separate debt.

One non-author exact-head review, hosted exact-head CI, and Kevin's merge
decision remain required. Live-provider measurement was not run, so the
existing live-execution HOLD remains binding.
