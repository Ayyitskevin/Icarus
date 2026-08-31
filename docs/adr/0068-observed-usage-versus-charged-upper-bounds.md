# ADR 0068: Observed usage and charged upper bounds are different quantities

- Status: **Accepted** — the operator resolved the open question on 2026-08-30 in favour of option (2)
- Date: 2026-08-30
- Related: [ADR 0059](0059-headless-child-lineage.md) (the migration pattern this follows)

## Context

When an operation settles without provider-reported token counts, the store charges
its full reservation. That is correct: an unmeasured operation must not be free, and
the ceiling must still bind.

What it then does with the charge is not correct. `store.ts` writes the entire
reservation into `input_tokens` and records `output_tokens` as `0`:

```
input_tokens  = input_tokens  + (usage unknown ? reservedTokens : finish.inputTokens)
output_tokens = output_tokens + (usage unknown ? 0              : finish.outputTokens)
```

The interrupted-operation path does the same with its reservation. So a run whose
provider hid usage becomes indistinguishable, in the durable record, from a run that
genuinely consumed a great deal of input and produced no output. `RunUsage` reads as
provider-reported when it is a conservative upper bound, and output work is filed as
input work.

This is the same defect class as the Gate 2 zero-yield cases
([diagnosis](../diagnoses/2026-08-30-gate2-zero-yield-thinking-displacement.md)):
evidence that was never observed is recorded in a shape indistinguishable from
evidence that was. For a system whose claim is provable autonomy, an accounting
record that cannot say which numbers it saw is a product defect, not a cosmetic one.

## Decision (proposed)

Add `upper_bound_tokens` to `runs` and `upperBoundTokens` to `RunUsage`.

- Observed counters hold only what a provider actually reported.
- Tokens charged from a reservation — unreported usage, and interrupted operations —
  accumulate in `upperBoundTokens`.
- Both ceiling checks (`store.ts` reservation admission and the headless worker) sum
  all three, so **enforcement is unchanged**. Only the record's honesty changes.
- Existing databases apply `ICARUS_USAGE_BASIS_MIGRATION_SCHEMA` exactly once behind
  an explicit operator migration token, per ADR 0059's pattern. Fresh databases get
  the shape from the core DDL.
- Settlement history written before this distinction carries no such field. Absent
  means "none recorded", which is the truthful reading: those runs charged
  reservations into `inputTokens`, and that history is not retroactively
  reinterpretable.

## The question, and how it was resolved

27 tests across 6 files failed against this change. The operator resolved the question
in favour of option (2): **`inputTokens` means input tokens the provider reported**, and
an assertion expecting a runtime reservation there encoded the defect rather than the
contract.

Examining the failures showed they were **not 27 independent opinions**. Twenty-six
cascaded from a single schema check: `assertExactMembers` in `headless-worker.ts`
required settlement usage to carry exactly six members, so a seventh made every
lifecycle-parsing test fail with one message. That check now accepts
`upperBoundTokens` as an OPTIONAL member — a settlement written before the
distinction carries six, one written after carries seven — because requiring one shape
would make older evidence unreadable and rejecting the newer would make the
distinction unrecordable.

Two failures were genuine and both were updated deliberately:

1. `store.test.ts` — *"charges worst-case reservations for an operation interrupted
   across reopen"* expected `inputTokens: 50`. It now expects `inputTokens: 0,
   upperBoundTokens: 50`. The test's NAME remains accurate: the reservation is still
   charged in full and the ceiling still counts it. Only its attribution changed.
2. `headless-stream.test.ts` — the receipt stream pins a canonical checksum, which moved
   because `RunUsage` gained a member. **This change alters digest-bound receipt
   output.** The pin exists to catch unintended receipt drift; this drift is intended
   and is recorded here so a future reader does not mistake it for tampering.

## Consequences

- `RunUsage` consumers must distinguish the three quantities; the type makes every
  construction site state it rather than defaulting silently.
- Historical runs remain readable but not comparable to post-migration runs on the
  observed/charged split. This ADR does not backfill; it cannot.
- Any future cost or throughput claim derived from `inputTokens` becomes defensible,
  because the number will mean one thing.

## Verification

- `pnpm typecheck:node` — clean.
- `pnpm exec vitest run tests/unit/usage-basis.test.ts` — 2 passed: unreported usage
  charges 500 upper-bound tokens with 0 observed, where it previously wrote 500 into
  `inputTokens`.
- `pnpm check` — 1533 tests pass across 118 files. On this machine it still fails
  `tests/integration/landlock-sandbox.test.ts`, which fails identically on a clean tree
  here and is kernel-dependent; CI on ubuntu-latest is the arbiter.
