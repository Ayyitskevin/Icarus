# Gate 2 deterministic scaffold cohort A — 2026-08-28

## Question

Can Icarus execute the four manifest-bound scaffold tasks compatible with
current host policy through production retrieval, plan approval, PatchSet,
private Git workspace, no-network sandbox verification, local review, and
durable runtime recovery without absorbing the protected task-priority
migration?

This measurement answers deterministic contract integration only. Frozen
responses, evaluator-created checks, and operator-selected targets do not
establish live-model scaffold quality, autonomous target discovery, general
scaffold correctness, or Gate 2 completion.

## Contract

- Manifest: `fixtures/evals/gate2/manifest.v1.json`
- Manifest SHA-256:
  `43159d8a174312e7fd720fbb625173601e7c90f6e5983c62c206b69ce99c9558`
- Cohort: `scaffold-lantern-json-output`, `scaffold-cart-discount`,
  `scaffold-parser-cli`, and `scaffold-greeting-command`
- Excluded: `scaffold-task-priority`, whose declared output includes protected
  `migrations/001_add_priority.sql`
- Command: `pnpm benchmark:gate2:scaffold-a`
- Local report: `.local/gate2-scaffold-cohort-a-report.json`
- Provider: production Ollama structured adapter over bounded loopback HTTP at
  configured zero token rates
- Sandbox:
  `python:3.12-slim@sha256:c3d81d25b3154142b0b42eb1e61300024426268edeb5b5a26dd7ddf64d9daf28`,
  read-only and without network

The operator supplies each manifest-declared changed path and, when the first
changed path is a create, one existing non-mutating selection anchor required
by the current planner contract. Icarus binds the accepted plan digest,
revalidates every exact create/modify operation and preimage, executes the
registered scenario check before and after private-workspace mutation, locally
approves the verified diff, then closes and reopens the runtime.

## Result

| Measure | Observed |
| --- | ---: |
| Manifest / cohort cases | 30 / 4 |
| Executed / passed / unexecuted | 4 / 4 / 26 |
| Expected-path recall | 1.0 three times; 0.75 once; macro 0.9375 |
| Expected-path precision | 1.0 twice; 0.75 twice; macro 0.875 |
| Digest provenance coverage | 1.0 in 4 / 4 |
| First plans accepted | 4 / 4 |
| Autonomous target discovery measured | no |
| Baseline checks | 4 expected failures reproduced |
| Final registered checks | 4 / 4 passed |
| Created / modified final files | 7 / 1 |
| Production-adapter provider requests | 8 |
| Sandbox check executions | 8 |
| Private-workspace mutations / runtime reopens | 4 / 4 |
| Source files / complete source Git directories unchanged | 4 / 4 |
| External network / remote mutation / live database connections | 0 / 0 / 0 |
| Offline database or migration cases | 0 |

The Lantern, cart, parser, and greeting scenarios reach their exact declared
final paths and bytes, then pass their fixed checks. Those checks are evaluator-
created fixtures where the task requires a new check file; their passing result
proves the frozen scenario, not independent repository-authored coverage. The
greeting retrieval selects three of four expected paths, so its recall remains
`0.75`; the recomputed cohort macro `0.9375` clears the manifest minimum without
relabelling that omission as complete retrieval.

## Adversarial evidence and limits

Eight strict-contract groups reject widened effects, forged counts or
completion, changed target authority, plan scope, operations, baselines, final
checks or bytes, missing durable recovery, dishonest per-case or aggregate
retrieval metrics, evaluator rebinding, evidence-digest forgery, duplicate JSON
members, input beyond 4 MiB, and excessive nesting. Static assertions require
the production lifecycle, loopback binding, source and complete Git-directory
invariance, observed-versus-asserted effect labels, the exact four-case registry,
the protected migration exclusion, and absence of GitHub, deployment,
force-push, or credential surfaces.

The zero external-network, remote-mutation, and database figures are closed-
runner design assertions, not packet or syscall telemetry. Exact byte oracles
establish these four scenarios, not general scaffold correctness. Evidence
digests establish self-consistency, not runner authenticity. This report alone
still records 26 unexecuted cases; combining distinct case identities across
the six partial reports yields 28/30 contract-integration coverage, not a
synthetic full-suite result or threshold pass.

The excluded `scaffold-task-priority` and `repair-schema-status-column` cases
name protected `migrations/` paths. Production correctly refuses them.
Resolving the immutable manifest mismatch requires explicit benchmark
versioning, not a policy bypass. Those two cases, live-model quality, autonomous
planning, the full 30-task threshold, and paired routing-cost comparison remain
open.
