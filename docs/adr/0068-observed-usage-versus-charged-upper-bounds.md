# ADR 0068: Observed usage and charged upper bounds are different quantities

- Status: **Proposed** — not accepted; opens a contract question this ADR does not settle
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

## The question this ADR does not settle

**27 tests across 6 files assert the current attribution**, including
`store.test.ts`'s "charges worst-case reservations for an operation interrupted
across reopen", which expects `inputTokens: 50, outputTokens: 0`. A further 10
construction sites across 9 files must state the new field before the suite compiles.

Those assertions are not incidental. Each is a place where someone wrote down what
they believed run usage meant. Rewriting them to make this change pass would be
editing the contract to fit the patch, in a repository whose evidence discipline is
the product. They are therefore left failing, deliberately, so the decision is
visible:

1. Was `inputTokens` always intended as "tokens charged as input", making the current
   behavior correct and this ADR wrong?
2. Or as "input tokens the provider reported", making those 27 assertions encodings of
   a defect that should be updated alongside this change?

The author's view is (2) — a field named `inputTokens` that can hold a runtime
reservation cannot support any claim built on it — but this is a change to how spend
is recorded, and the operator decides.

## Consequences if accepted

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
- `pnpm check` — **fails**, by design. See the question above.
