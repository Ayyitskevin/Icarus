# ADR 0048: Lease-held bounded headless worker

- Status: Proposed — H2b implementation merged through PR #54,
  settlement-hardened, and
  independently reviewed; risky-change research, live-provider measurement,
  and deployment evidence remain required
- Date: 2026-08-21
- Related: [ADR 0044](0044-headless-workspace-harness-direction.md),
  [ADR 0046](0046-headless-execution-profiles.md), and
  [ADR 0047](0047-headless-authority-binding.md)

## Context

Ordinary plan approval records the approval and immediately executes under one
Linux run lease. H2b cannot safely add a second dispatcher that observes the
new `running` state later: that would create a race between approval, binding,
and the first workspace or provider effect. It also cannot claim that a tighter
H1 budget or tool set is active while the existing service and SQLite operation
admission continue using only the project ceiling.

The smallest coherent headless entry point must therefore join the existing
approval/execution transaction boundary rather than duplicate it.

## Decision

Add `approveHeadlessPlan` as an explicit one-task service and CLI path. Under
the existing per-run lease it:

1. runs the normal source and plan-approval validation;
2. preflights the profile, provider mapping, grants, and already-spent budget
   without granting authority, so malformed configuration remains retryable;
3. persists the normal plan approval and `running` transition;
4. reconstructs ADR 0047 from the current run, project, approvals, readable
   manifest, source profile, and host provider catalog;
5. refuses provider drift, malformed profiles, unavailable capabilities, or a
   profile ceiling already exceeded by cumulative run usage;
6. records `headless.worker.started` before any workspace or provider effect;
7. executes through the existing service, provider, private-worktree, check,
   operation, and cancellation paths; and
8. proves quiescence and records exactly one `headless.worker.settled` event.

The active binding is process-local and exists only while that lease is held.
It supplies a tighter `SunCeiling` to every ordinary operation admission and to
the service's file, context, output, timeout, token, and cost calculations.
SQLite revalidates that the supplied ceiling does not exceed the persisted
project ceiling. Cumulative usage remains the ledger; the profile does not
reset planning or approval spend.

The profile tool list is an additional filter inside the metered ADR 0026
session path. The normal plan capability grant is still independently
required, and a disabled call is refused only after its durable tool operation
has been admitted. The initial fixed patch proposal remains the existing
plan-approved structured-generation step, not a model-callable registry tool.

The CLI command is:

```text
icarus run approve-headless RUN \
  --plan-sha SHA --actor ACTOR \
  --profile-json JSON --provider-catalog-json JSON
```

Both JSON arguments are bounded and contain no credentials. The command emits
the existing checksum-terminated `icarus.headless.history.v1` JSONL trajectory
(**superseded 2026-08-31**: now `icarus.headless.history.v2` per ADR 0068),
including the two worker lifecycle events, and returns:

| Outcome | Exit |
| --- | ---: |
| passing evidence ready for review | 0 |
| failed execution or incomplete settlement | 1 |
| iteration or ordinary-budget exhaustion | 2 |
| human input required | 3 |
| signal cancellation settled | 130 |

`awaiting_review` is successful worker quiescence only when current verification
passes and no later human/exhaustion disposition blocks approval.
Persisted failed or unavailable verification explains exit 1 with the derived
`HEADLESS_VERIFICATION_FAILED` or `HEADLESS_VERIFICATION_UNAVAILABLE` error.
Other failed dispositions still require an explicit persisted error; the
worker refuses an unexplained terminal failure as an incomplete settlement.

## Consequences

- SQLite approvals, operations, events, verification, and run state remain the
  only durable authority. No worker/session table is added.
- A previously exported binding cannot start work. H2a is reconstructed after
  approval while the run lease is held.
- Ordinary interactive approval remains behaviorally unchanged.
- Signal cancellation uses the existing guarded cancellation/recovery path and
  settles only after no operation remains active.
- H2b is one-shot. ADR 0049's H3a slice may close a dead worker's operation and
  event tail but grants no continuation authority; binding reconstruction and
  exactly-once resume remain H3b.
- Child runs, concurrency above one, schedules, daemons, deployment, SearXNG,
  DeepAPI, arbitrary plugins, and external worker adapters remain excluded.

## Alternatives rejected

### Approve normally, then invoke a separate worker command

Rejected because ordinary approval already begins execution. A later command
cannot bind before the first effect and would introduce competing ownership.

### Store headless budgets in a second worker table

Rejected because it duplicates run authority and creates recovery semantics
that ADR 0044 and ADR 0047 explicitly avoid.

### Enforce tighter budgets only in the CLI

Rejected because direct service callers and operation admission could bypass
them. The service selects the ceiling and SQLite checks every ordinary
reservation against it.

### Automatically fall back between providers or research services

Rejected because provider mapping is approval-bound. Research adapters belong
to H5 and require separate egress, credential, budget, and untrusted-output
contracts.
