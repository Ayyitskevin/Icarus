# Gate 2 deterministic repair cohort A — 2026-08-28

## Question

Can Icarus execute five manifest-bound repairs through its production retrieval,
plan approval, PatchSet, private Git workspace, no-network sandbox verification,
local review, and durable runtime lifecycle without widening source, remote,
network, migration, or live-database authority?

This measurement answers deterministic contract integration only. Frozen
responses and operator-selected targets do not establish live-model repair
quality, autonomous target discovery, routing improvement, or Gate 2 completion.

## Contract

- Manifest: `fixtures/evals/gate2/manifest.v1.json`
- Manifest SHA-256:
  `43159d8a174312e7fd720fbb625173601e7c90f6e5983c62c206b69ce99c9558`
- Cohort: the final five `repair` cases in manifest order, from
  `repair-name-whitespace` through `repair-cart-empty-list`
- Command: `pnpm benchmark:gate2:repair-a`
- Local report: `.local/gate2-repair-cohort-a-report.json`
- Provider: production Ollama structured adapter over bounded loopback HTTP at
  configured zero token rates
- Sandbox:
  `python:3.12-slim@sha256:c3d81d25b3154142b0b42eb1e61300024426268edeb5b5a26dd7ddf64d9daf28`,
  read-only and without network

The operator supplies exactly the manifest's changed paths. Icarus exact-parses
the first plan, binds its digest to task/base/context/provider/checks/sandbox/
budgets, applies the frozen PatchSet only after approval, revalidates paths and
preimages, runs the fixed scenario check in a private snapshot, requires exact
changed paths, and locally approves the verified diff. Closing and reopening the
runtime must retain the completed run and verification identity.

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
| Baseline checks | 1 passed; 4 expected failures reproduced |
| Final registered checks | 5 / 5 passed |
| Production-adapter provider requests | 10 |
| Sandbox check executions | 10 |
| Private-workspace mutations / runtime reopens | 5 / 5 |
| Source files / complete source Git directories unchanged | 5 / 5 |
| External network / remote mutation / live database connections | 0 / 0 / 0 |
| Offline database or migration cases | 0 |

The passing baseline is the name-whitespace case: it strengthens the existing
behavioral proof without changing either public implementation. The other four
baselines reproduce the missing-config traceback, absent empty-audience guard,
incorrect greeting bytes, and cart off-by-one behavior before the exact repair.
Every final check passes after only the manifest-declared paths change.

## Adversarial evidence and limits

Six strict-contract groups reject widened effects, forged counts or completion,
changed target authority or plan scope, altered baseline/final checks, extra
changed paths, wrong final bytes, missing durable recovery, dishonest retrieval
metrics, evaluator rebinding, evidence-digest forgery, duplicate JSON members,
input beyond 4 MiB, and excessive nesting. Static security assertions require
the production lifecycle calls, loopback binding, source/Git invariance,
explicit effect bases, and absence of GitHub, deployment, force-push, or model-
credential surfaces.

The zero external-network, remote-mutation, live-database, and offline-database
figures are closed-runner design assertions, not packet or syscall telemetry.
Exact byte oracles establish these five scenarios, not general repair
correctness. Evidence digests establish self-consistency, not runner
authenticity. Each partial cohort independently reports 5 executed and 25
unexecuted; the four current cohorts together cover 20 distinct manifest cases,
not a synthetic full-suite result. The other five repair cases, all five
scaffolds, live-model quality, autonomous planning, the 24/30 threshold, and
paired routing-cost comparison remain open.

The v1 schema repair and scaffold cases name protected `migrations/` paths. The
ordinary production lifecycle correctly refuses those paths; changing that
policy or rewriting the immutable v1 manifest is not part of this measurement.
