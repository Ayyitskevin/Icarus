# Gate 2 deterministic refactor cohort — 2026-08-28

## Question

Can Icarus execute the five manifest-bound refactors through its production
retrieval, plan approval, PatchSet, private Git workspace, no-network sandbox
verification, local review, and durable runtime lifecycle without widening
source, remote, network, or live-database authority?

This measurement answers deterministic contract integration only. Frozen
responses and operator-selected targets do not establish live-model refactor
quality, autonomous target discovery, routing improvement, or Gate 2 completion.

## Contract

- Manifest: `fixtures/evals/gate2/manifest.v1.json`
- Manifest SHA-256:
  `43159d8a174312e7fd720fbb625173601e7c90f6e5983c62c206b69ce99c9558`
- Cohort: all five `refactor` cases, in manifest order
- Command: `pnpm benchmark:gate2:refactor`
- Local report: `.local/gate2-refactor-cohort-report.json`
- Provider: production Ollama structured adapter over bounded loopback HTTP at
  configured zero token rates
- Sandbox:
  `python:3.12-slim@sha256:c3d81d25b3154142b0b42eb1e61300024426268edeb5b5a26dd7ddf64d9daf28`,
  read-only and without network

The operator supplies the allowed targets. Icarus exact-parses the first plan,
binds its digest to task/base/context/provider/checks/sandbox/budgets, applies
the frozen PatchSet only after approval, validates paths and preimages again,
runs the fixed scenario check in a private snapshot, requires exact changed
paths, and locally approves the verified diff. The runtime is then closed and
reopened; the completed run and verification identity must survive.

## Result

| Measure | Observed |
| --- | ---: |
| Manifest / cohort cases | 30 / 5 |
| Executed / passed / unexecuted | 5 / 5 / 25 |
| Expected-path recall | 1.0 in 5 / 5 |
| Expected-path precision | 1.0 once; 0.75 four times; macro 0.80 |
| Digest provenance coverage | 1.0 in 5 / 5 |
| First plans accepted | 5 / 5 |
| Autonomous target discovery measured | no |
| Baseline checks | 3 passed; 2 deliberate failures reproduced |
| Final registered checks | 5 / 5 passed |
| Production-adapter provider requests | 10 |
| Sandbox check executions | 10 |
| Private-workspace mutations / runtime reopens | 5 / 5 |
| Source files / complete source Git directories unchanged | 5 / 5 |
| External network / remote mutation / live database connections | 0 / 0 / 0 |
| In-memory SQLite checks | 2 |

The Lantern create path sorts before either changed existing path. Icarus
requires the first normalized selection target to exist, so the operator
selection includes `config/app.json` as an existing non-mutating anchor. The
approved plan narrows mutation to exactly `src/config.py` and `src/main.py`.
This is faithful host-contract evidence, not autonomous file discovery.

The cart and parser fixtures intentionally fail before mutation and pass after
their exact refactors. Name normalization and Lantern preserve their passing
behavior. The schema case changes only its offline contract query, executes
against in-memory SQLite, and proves the `tasks` table definition is unchanged.

## Adversarial evidence and limits

Six strict-contract groups reject widened effects, forged counts or completion,
changed target authority or plan scope, altered baseline/final checks, extra
changed paths, wrong final bytes, missing durable recovery, dishonest retrieval
metrics, evaluator rebinding, evidence-digest forgery, duplicate JSON members,
input beyond 4 MiB, and excessive nesting. Static security assertions require
the production lifecycle calls, loopback binding, source/Git invariance,
explicit effect bases, and absence of GitHub, deployment, force-push, or model-
credential surfaces.

The zero external-network, remote-mutation, and live-database figures are
closed-runner design assertions, not packet or syscall telemetry. Exact byte
oracles establish these five scenarios, not general refactor correctness.
Evidence digests establish self-consistency, not runner authenticity. Each
partial cohort independently reports 5 executed and 25 unexecuted; explanation,
security-review, and refactor evidence together cover 15 distinct cases, not a
synthetic full-suite result. Repair/scaffold execution, live-model quality,
autonomous planning, the 24/30 threshold, and paired routing-cost comparison
remain open.
