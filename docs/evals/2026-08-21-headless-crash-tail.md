# H3a headless crash-tail evaluation — 2026-08-21

## Decision and boundary

The evaluated slice is ADR 0049 only. It closes a dead worker's event tail and
conservatively reconciles its open operation. It does not reconstruct a binding,
resume a stage, infer whether a remote request completed, or authorize a new
effect. Those are H3b concerns.

The deterministic test below is sufficient for local implementation evidence:
it changes no provider request parameters, customer data, pricing, or deployment
default. It is not sufficient to ship the new public interruption schema. The
risky-change external research and 10–20+ live-measurement gates therefore
remain open for operator and consumer fitness. The local evidence is an actual
process death over the production CLI, SQLite store, lease, service, JSONL
exporter, and loopback provider adapter.

## Focused evidence

Command:

```text
pnpm exec vitest run \
  tests/unit/headless-worker.test.ts \
  tests/integration/headless-worker-crash-recovery.test.ts \
  tests/security/headless-worker-contract.test.ts
```

Observed after the final decoder and durable-linkage regressions were added: **3 files, 25/25
passed**.

The integration case:

1. creates and plans a real temporary run through the compiled CLI;
2. starts `approve-headless` as a child process;
3. waits until the second loopback provider request is accepted, after
   `operation.started` is committed;
4. sends `SIGKILL` and observes signal termination with no worker stdout;
5. invokes `run reconcile-headless` in a fresh process;
6. verifies one `operation.interrupted`, one interruption settlement, exit `1`,
   and the canonical H0 content digest;
7. invokes reconciliation again and requires byte-identical JSONL;
8. invokes ordinary resume and requires
   `HEADLESS_BINDING_RECONSTRUCTION_REQUIRED` before another provider request;
   and
9. compares the complete source Git fingerprint before and after recovery.

The unit grammar additionally rejects duplicate starts and refuses interrupted
settlement while any operation remains active. It derives the complete unique
interrupted-operation set from the durable post-start tail, so a retry after a
second crash cannot drop an already-committed interruption. The integration
case also proves that the full reserved tokens, runtime, and cost move from
reservation to conservative usage. Static security assertions pin lease
ownership, interrupt-before-settle ordering, absence of execution/provider
calls in reconciliation, and the resume guard before resume intent or stage
dispatch.

## Full local gate

`pnpm check` completed the workflow negative self-test, formatting, lint,
typechecking, unit/provider, integration, evaluation, security, and production
build stages. Observed counts were 1,005 unit/provider tests, 172 integration
tests, 183 security tests, and 7/7 supported offline evaluation cases. Three
Gate 1 live-evidence cases remained explicitly not run by that contract.

## Open evidence

- One non-author round-table review is still required.
- External research and 10–20+ realistic live measurements remain required
  before shipping the public interruption schema.
- H3b binding reconstruction and exactly-once effect reconciliation remain
  unimplemented.
- No live provider, hosted CI, deployment, or Mickey service modification is
  claimed.
