# Gate 2 deterministic schema-successor cohort — 2026-08-28

## Question

Can Icarus version the two manifest-v1 tasks that require protected migration
paths into immutable, host-policy-compatible manifest-v2 cases and execute both
through the production private lifecycle without weakening policy or touching a
live database?

This measurement answers deterministic contract integration only. It does not
establish live-model schema quality, autonomous target discovery, migration
safety, full-suite quality, routing improvement, or Gate 2 completion.

## Contract

- Predecessor: `fixtures/evals/gate2/manifest.v1.json`
- Predecessor SHA-256:
  `43159d8a174312e7fd720fbb625173601e7c90f6e5983c62c206b69ce99c9558`
- Successor: `fixtures/evals/gate2/manifest.v2.json`
- Successor SHA-256:
  `0eca6348be7848bac44922bcf426defdbd581af8ef790515e28c231b5fbc69c5`
- Cohort: `repair-schema-status-snapshot` and
  `scaffold-task-priority-contract`
- Command: `pnpm benchmark:gate2:schema-successor`
- Local report: `.local/gate2-schema-successor-cohort-report.json`
- Provider: production Ollama structured adapter over bounded loopback HTTP at
  configured zero token rates
- Sandbox:
  `python:3.12-slim@sha256:c3d81d25b3154142b0b42eb1e61300024426268edeb5b5a26dd7ddf64d9daf28`,
  read-only and without network

Manifest v2 preserves 28 v1 cases byte-for-byte. Its ordered replacement map
changes only the two case identities and exact task/outcome records whose v1
outputs required `migrations/`. The successors retain offline schema semantics
using `schema/current.sql` and read-only SQL contracts under `checks/`. Every
declared changed path passes the production PatchSet target policy.

## Result

| Measure | Observed |
| --- | ---: |
| Manifest / cohort cases | 30 / 2 |
| Executed / passed / unexecuted | 2 / 2 / 28 |
| Expected-path recall | 1.0 in 2 / 2 |
| Expected-path precision | 0.75 in 2 / 2; macro 0.75 |
| Digest provenance coverage | 1.0 in 2 / 2 |
| First plans accepted | 2 / 2 |
| Autonomous target discovery measured | no |
| Baseline checks | 2 expected failures reproduced |
| Final registered checks | 2 / 2 passed |
| Production-adapter provider requests | 4 |
| Sandbox check executions | 4 |
| Observed in-memory SQLite executions | 4 |
| Private-workspace mutations / runtime reopens | 2 / 2 |
| Source files / complete source Git directories unchanged | 2 / 2 |
| External network / remote mutation / live database connections | 0 / 0 / 0 |

The repair modifies the offline schema snapshot and its existing status query.
The scaffold creates a separate priority query and modifies the same disposable
snapshot. Both fixed checks fail against the baseline and pass only after the
exact declared final bytes are present. No migration file is created or applied.

## Adversarial evidence and limits

The manifest contract rejects predecessor-digest drift, reordered or changed
replacement lineage, drift in any of the 28 preserved cases, replacement-scope
or task-byte drift, and protected successor paths. Focused tests also pass every
v2 mutation target through Icarus's production `assertAllowedTarget` policy.
The cohort result contract rejects widened effects, false completion, forged
counts, changed plans, checks, final bytes, durability, retrieval metrics,
evaluator identity, evidence digests, duplicate JSON members, oversized input,
and excessive nesting.

Provider requests, sandbox checks, private mutations, source invariance,
in-memory SQLite checks, and runtime reopens are observed. Zero external network,
remote mutation, and live-database connections are closed-runner design
assertions, not packet or syscall telemetry. The SQLite work occurs only inside
disposable no-network checks and does not authorize a live migration.

This report contains only 2/30 manifest-v2 outcomes. The six earlier partial
cohorts jointly identify 28 manifest-v1 cases, but revision identity is part of
the evidence: 28 v1 outcomes plus 2 v2 outcomes are not a full v2 run. A trusted
orchestrator must execute or explicitly adopt all 30 v2 identities under one
closed result before any full-suite threshold claim.
