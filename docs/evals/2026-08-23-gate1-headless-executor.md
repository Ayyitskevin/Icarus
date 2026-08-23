# Gate 1 headless executor compiled-process measurement — 2026-08-23

## Scope

This measures ADR 0055's one-shot executor, durable filesystem journal,
effect-ledger replay, recovery boundary, stable process exits, and compiled CLI
presentation. It launches each case in a separate Node process against compiled
core/CLI artifacts. The driver is simulated and the CLI case uses an empty local
runtime, so the campaign performs no provider or GitHub request and does not
count toward Gate 1's live 3/3 evidence.

## Command

```sh
pnpm measure:gate1-executor
```

Observed on 2026-08-23: **20/20 passed**.

| # | Real process case | Expected result |
| --- | --- | --- |
| 1 | Three serial cases | success; exact manifest order |
| 2 | Replay persisted success without credentials | same successful terminal receipt |
| 3 | Missing credential | durable blocked receipt; exit 3 |
| 4 | Resume while credential missing | another durable block; same resume id |
| 5 | Lost mutation response | durable ambiguity block; exit 3 |
| 6 | Later explicit resume | read reconciliation then success |
| 7 | Replay reconciled success | success without another effect |
| 8 | Initial remote ambiguity | durable block |
| 9 | Lost response during resume | block again; no in-process reconciliation |
| 10 | Next explicit resume | reconcile then success |
| 11 | Remote drift | durable case-preflight block |
| 12 | Pre-aborted signal | interrupted receipt; exit 130 |
| 13 | Driver claims completion without effects | invariant failure; exit 1 |
| 14 | Changed manifest on resume | authority mismatch; exit 1 |
| 15 | Changed profile on resume | authority mismatch; exit 1 |
| 16 | Invalid resume id | refusal; exit 1 |
| 17 | Symlink journal | refusal; exit 1 |
| 18 | Owner-only journal control | success |
| 19 | Shared-readable journal | refusal; exit 1 |
| 20 | Compiled CLI with absent completed run | canonical blocked NDJSON; exit 3 |

## Result

The implementation candidate meets the selected crash, resume, ordering,
binding, filesystem, and process-output invariants offline. The result supports
independent code review. It does not validate real repository automation,
credentials, provider output, GitHub state, candidate objects, draft pull
requests, or immutable live receipts; those remain the separately approved
Gate 1 3/3 run.
