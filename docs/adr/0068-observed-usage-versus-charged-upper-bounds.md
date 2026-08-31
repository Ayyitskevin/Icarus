# ADR 0068: Observed usage and charged upper bounds are different quantities

- Status: **Accepted** — the operator resolved the open question on 2026-08-30 in favour of option (2)
- Date: 2026-08-30
- Related: [ADR 0059](0059-headless-isolated-child-runs.md) (the migration pattern this follows)

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

## Decision

Add `upper_bound_tokens` to `runs` and `upperBoundTokens` to `RunUsage`.

- Observed counters hold only what a provider actually reported, **per counter**.
  `ProviderUsage` lets input and output be independently null, and adapters decode
  them independently, so a provider may state one and hide the other. The stated
  half is still stated: it is recorded as observed. Treating a partial report as no
  report would discard evidence at the same boundary this ADR exists to protect.
- Tokens charged from a reservation that nobody reported — fully unreported usage,
  the unstated remainder of a partial report, and interrupted operations —
  accumulate in `upperBoundTokens`.
- **Refusing a response does not erase what the provider reported.** When usage
  breaches a reservation the response is refused, but the counters the store can
  accept keep their reported values; only a token report that is itself outside the
  reservation cannot be recorded as observed, and it survives as a claim in the
  settlement detail (`claimedInputTokens`, `claimedOutputTokens`, `claimedCostUsd`)
  rather than being replaced by the reservation. A call whose cost alone breached
  would otherwise be recorded as though it had reported no tokens at all.
- The reported total is checked against the reservation whether or not it is
  complete. A provider reporting 600 input tokens against a 500-token reservation
  is refused even if it hides the output count.
- Both ceiling checks (`store.ts` reservation admission and the headless worker) sum
  all three, so **enforcement is unchanged**. Only the record's honesty changes.
- Existing databases apply `ICARUS_USAGE_BASIS_MIGRATION_SCHEMA` exactly once behind
  the operator migration token `ICARUS_APPROVE_SCHEMA_MIGRATION=usage-basis-v1`, per
  ADR 0059's pattern. Fresh databases get the shape from the core DDL.
- **The canonical `runs` DDL declares `upper_bound_tokens` last.** SQLite's
  `ALTER TABLE ADD COLUMN` appends, and the constructor's exact-schema check compares
  stored DDL text, so a column declared mid-table could never be reached by its own
  migration: the database would refuse to open, migrate on approval, and then fail
  the very check the migration exists to satisfy. A state root predating both ADR
  0059 and this one migrates in that order, which is the order the canonical DDL
  records.
- The read-only change-handoff reader projects `0` when the column is absent rather
  than failing to prepare its query. That path must never migrate, and zero is the
  honest answer for a column the database never had.
- Settlement history written before this distinction carries no such field. Absent
  means "none recorded", which is the truthful reading: those runs charged
  reservations into `inputTokens`, and that history is not retroactively
  reinterpretable.

## The question, and how it was resolved

27 tests across 6 files failed against this change. The operator resolved the question
in favour of option (2): **`inputTokens` means input tokens the provider reported**, and
an assertion expecting a runtime reservation there encoded the defect rather than the
contract.

Examining the failures showed they were **not 27 independent opinions**. Twenty-three
cascaded from a single schema check: `assertExactMembers` in `headless-worker.ts`
required settlement usage to carry exactly six members, so a seventh made every
lifecycle-parsing test fail with one message. That check now accepts
`upperBoundTokens` as an OPTIONAL member — a settlement written before the
distinction carries six, one written after carries seven — because requiring one shape
would make older evidence unreadable and rejecting the newer would make the
distinction unrecordable.

Four failures were genuine and each was updated deliberately:

1. `store.test.ts` — *"charges worst-case reservations for an operation interrupted
   across reopen"* expected `inputTokens: 50`. It now expects `inputTokens: 0,
   upperBoundTokens: 50`. The test's NAME remains accurate: the reservation is still
   charged in full and the ceiling still counts it. Only its attribution changed.
2. `headless-worker-crash-recovery.test.ts` — the crash-tail settlement moves its
   charge the same way, for the same reason.
3. `lifecycle-restart.test.ts` — so does the cancellation path.
4. `headless-stream.test.ts` — the receipt stream pins a canonical checksum, which moved
   because `RunUsage` gained a member. **This change alters digest-bound receipt
   output.** The pin exists to catch unintended receipt drift; this drift is intended
   and is recorded here so a future reader does not mistake it for tampering.

An earlier revision of this ADR said 26 cascades and two genuine failures, which is
both 28 and wrong. The count is 23 and 4. It was corrected after an independent audit
by the codex seat; the provenance of a decision record has to survive being checked.

## Consequences

- `RunUsage` consumers must distinguish the three quantities; the type makes every
  construction site state it rather than defaulting silently.
- **The H0 trajectory export moves to `icarus.headless.history.v2`.** `publicRun`
  copies `run.usage` into every H0 run line, so enlarging `RunUsage` changes that
  export's canonical bytes and its terminal checksum. Leaving the version string at
  v1 while the bytes moved would be an unstated change of exactly the kind this ADR
  closes, so the wire version moves with the wire.
- **The receipt stream moves to `icarus.headless.stream.v2`** for the same reason:
  its `result` line carries the enlarged `RunUsage` as a required member, and ADR
  0061 declares no additive-member tolerance. Its pinned canonical checksum moves
  with it.
- The browser workspace shows the charged-but-unreported envelope beside the observed
  counters. Without it an interrupted or unreported run reads as zero measured tokens
  on the one surface an operator actually looks at, while its full envelope was
  charged.
- Historical runs remain readable but not comparable to post-migration runs on the
  observed/charged split. This ADR does not backfill; it cannot.
- Any future cost or throughput claim derived from `inputTokens` becomes defensible,
  because the number will mean one thing.

## Verification

Evidence recorded below on 2026-08-31, under Node 22.23.2. An earlier revision of this
section reported "1533 tests pass across 118 files" from a unit-only run, and attributed
the local `tests/integration/landlock-sandbox.test.ts` failure to a kernel-dependent
sandbox. Both claims were wrong. The landlock failures were a Node version drift: this
host's default `node` is v24.16.0 while the repository pins `>=22.23.0 <23`, and
`better-sqlite3` compiled for NODE_MODULE_VERSION 127 cannot load under 137. Under the
pinned runtime the local gate runs end to end.
