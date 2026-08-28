# Gate 2 deterministic repair cohort B — 2026-08-28

## Question

Can Icarus execute the four remaining manifest-bound repairs compatible with
current host policy through production retrieval, plan approval, PatchSet,
private Git workspace, no-network sandbox verification, local review, and
durable runtime recovery without absorbing the protected schema migration?

This measurement answers deterministic contract integration only. Frozen
responses and operator-selected targets do not establish live-model repair
quality, autonomous target discovery, routing improvement, or Gate 2 completion.

## Contract

- Manifest: `fixtures/evals/gate2/manifest.v1.json`
- Manifest SHA-256:
  `43159d8a174312e7fd720fbb625173601e7c90f6e5983c62c206b69ce99c9558`
- Cohort: `repair-basic-greeting`, `repair-cart-off-by-one`,
  `repair-parser-false`, and `repair-public-path-containment`
- Command: `pnpm benchmark:gate2:repair-b`
- Local report: `.local/gate2-repair-cohort-b-report.json`
- Provider: production Ollama structured adapter over bounded loopback HTTP at
  configured zero token rates
- Sandbox:
  `python:3.12-slim@sha256:c3d81d25b3154142b0b42eb1e61300024426268edeb5b5a26dd7ddf64d9daf28`,
  read-only and without network

The operator supplies exactly each manifest-declared existing changed path.
All four PatchSets are modify-only. Icarus binds the accepted plan digest,
revalidates the exact path and preimage, executes the registered scenario check
before and after mutation in the sandbox, approves only the verified diff, then
closes and reopens the runtime to prove durable completion.

## Result

| Measure | Observed |
| --- | ---: |
| Manifest / cohort cases | 30 / 4 |
| Executed / passed / unexecuted | 4 / 4 / 26 |
| Expected-path recall | 1.0 in 4 / 4 |
| Expected-path precision | 1.0 twice; 0.75 twice; macro 0.875 |
| Digest provenance coverage | 1.0 in 4 / 4 |
| First plans accepted | 4 / 4 |
| Autonomous target discovery measured | no |
| Baseline checks | 4 expected failures reproduced |
| Final registered checks | 4 / 4 passed |
| Production-adapter provider requests | 8 |
| Sandbox check executions | 8 |
| Private-workspace mutations / runtime reopens | 4 / 4 |
| Source files / complete source Git directories unchanged | 4 / 4 |
| External network / remote mutation / live database connections | 0 / 0 / 0 |
| Offline database or migration cases | 0 |

The greeting, cart, and explicit-false cases pass their repository checks after
only the declared source changes. The public-path scenario additionally proves
an in-root read succeeds while both relative traversal and an absolute outside
path are rejected after canonical resolution.

## Adversarial evidence and limits

Six strict-contract groups reject widened effects, forged counts or completion,
changed target authority or plan scope, altered baseline/final checks, extra
changed paths, wrong final bytes, missing durable recovery, dishonest retrieval
metrics, evaluator rebinding, evidence-digest forgery, duplicate JSON members,
input beyond 4 MiB, and excessive nesting. Static security assertions require
the production lifecycle calls, loopback binding, source/Git invariance,
observed-versus-asserted effect labels, modify-only oracles, and absence of
GitHub, deployment, force-push, credential, or migration surfaces.

The zero external-network, remote-mutation, and database figures are closed-
runner design assertions, not packet or syscall telemetry. Exact byte oracles
establish these four scenarios, not general repair correctness. Evidence
digests establish self-consistency, not runner authenticity. This report alone
still records 26 unexecuted cases; combining distinct case identities across
the five partial reports yields 24/30 contract-integration coverage, not a
synthetic full-suite result or threshold pass.

The excluded `repair-schema-status-column` case and a scaffold case name
protected `migrations/` paths. Production correctly refuses them. Resolving the
immutable manifest mismatch requires explicit benchmark versioning, not a
policy bypass. Six manifest cases, live-model quality, autonomous planning, the
full 30-task threshold, and paired routing-cost comparison remain open.
