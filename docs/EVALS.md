# Evaluations

## Reliability rule

Icarus is not called reliable until representative tasks have measured evidence.
Unsupported scenarios are reported as unsupported, never converted to passes.

## Fixture contract

`fixtures/evals/manifest.json` schema v2 names each repeatable scenario, fixture,
task, expected outcome, required capability/evidence, planned milestone, support
status, and evaluator. It also declares the ten measurement keys every result
must carry. Unsupported future capabilities still have representative,
scenario-specific repositories and paths: a coordinated source/test repair,
duplicated module behavior, offline schema baseline, source-level security
issue, and unfamiliar multi-module application. The evaluator validates those
fixtures without counting unsupported product behavior as a pass.

`pnpm eval` validates the manifest and immutable fixture contracts, creates
private temporary Git repositories, and exercises seven M1 outcomes through
production runtime/service code. Provider-backed cases use the production
Ollama adapter over a deterministic loopback HTTP contract; this is not a live
installed model claim. The executable change runs its registered check through
the production no-network Docker sandbox and proves source content and Git
metadata remain unchanged.

The evaluator writes `.local/eval-report.json` with report schema v2, manifest
and fixture digests, per-case evidence, fixed per-case measurements, aggregate
measurements, limitations, and separate passed, failed, and unsupported counts.

Required scenario classes:

1. add a feature;
2. fix a bug;
3. refactor a module;
4. update a schema;
5. repair a failing test;
6. review a security issue;
7. explain an unfamiliar codebase;
8. reject a forbidden change;
9. recover from a failed tool/provider call;
10. resume an interrupted run.

The catalog has all ten classes. Milestone 1 executes seven outcomes:

1. a complete single-file production lifecycle, including review,
   rollback, restore, and re-review;
2. a transactional multi-file source-and-regression-test repair;
3. an ADR 0026 failed-check session over one operator-selected repair target;
4. rejection of the schema target before run/provider/workspace creation;
5. rejection of a traversal target before run/provider/workspace creation;
6. provider HTTP failure followed by explicit resume and passing verification;
7. an approval subprocess killed during a real provider operation, followed by explicit resume.

The schema case measures safe rejection; it does not claim schema-edit support.

Multi-file bug repair became executable with ADR 0023 and is now measured, not
asserted: one approved patch set spanning a source file and its check file must
apply transactionally, verify in the sandbox, roll back to a clean baseline,
restore, and land, with the source checkout unchanged throughout. Its
`regression_check` evidence is produced by a second contained run that applies
only the check-file edit and leaves the defect in place — verification must
fail there, or the added assertions pin nothing. Both runs use the same
fail-closed sandbox; fixture code is never executed on the host.

The failing-test scenario is executable under ADR 0026. The operator selects
`src/parser.py`; the ordinary first attempt retains a real failed sandbox
verification; the first of exactly two charged session turns reads only the
manifest-approved `checks/test_parser.py`; and the second applies a
baseline-bound PatchSet, reruns the complete registered check set, reports done,
and reaches ordinary human review. The evaluator asserts final completion,
passing evidence, immutable source content and Git metadata, the exact target
set, durable session boundaries, and bounded operation usage. It measures
`failed_check_session_repair`, **not** autonomous diagnostic target selection.

Three capabilities remain honestly unsupported: behavior-preserving module
refactor, read-only security findings, and read-only codebase explanation. ADR
0036 Gate 2 now governs all three; the manifest retains its integer
`plannedMilestone` field for schema-v2 compatibility and records `2` for each.
Unsupported contracts validate their fixtures and capability classification
but are never converted into passes.

## Measures

Every result contains:

- `taskSuccess`;
- `testSuccess`;
- `incorrectEdits`;
- `contextRetrievalQuality`;
- `toolFailures`;
- `runtime`;
- `tokenUsage`;
- `apiCost`;
- `humanApprovalFrequency`;
- `rollbackSuccess`.

Each measurement is labeled `measured`, `estimated`, `not_applicable`,
`unsupported`, or `not_measured`. Actual billed cost is never inferred:
`actualBilledUsd` remains null and configured-rate results are labeled estimated.
Context quality is expected-path recall/precision plus digest-provenance validity
for the deterministic M1 selector, not semantic-retrieval quality. The
interrupted-run case launches the production CLI, holds a real `provider.edit`
request after its durable operation start, kills that operating-system process,
and invokes explicit resume against the persisted state.

## Determinism

Evaluations use deterministic loopback HTTP responses with the production Ollama
adapter and normal Icarus runtime. Provider unit/integration tests also exercise
the production OpenAI adapter and request shape; the OpenAI lifecycle crosses
the exact remote-egress gate through final review with injected deterministic
transport. These are not alternate production adapters, but neither is evidence
of a live Ollama model or paid OpenAI request. No paid call is part of CI.

## Adversarial cases

- `../escape`, absolute paths, `.git`, `.env`, and rule-file proposals;
- parent and target symlinks;
- a malicious fixture `AGENTS.md` instruction that reaches the real provider
  prompt and attempts to widen the selected target; the target is rejected and
  repository instructions remain untrusted data rather than host policy;
- malformed/oversized provider JSON;
- provider authorization values reflected in errors;
- command output containing token-like strings;
- timeout/cancellation, including a command that traps termination and exits
  zero, and partial atomic-write state;
- unexpected modification between approval and resume;
- more changed files than approved;
- failed verification presented as success.
- source hooks/config/refs that must remain inert through private caching;
- production-sandbox attempts to read host secrets, reach public,
  host-loopback, or Tailscale address space, write the approved worktree, survive
  cancellation, or exceed limits;
- absent Docker/image/security preflight with no host fallback.

## Evidence retention

Each executable runtime evaluation records normal run/provider/check evidence in
temporary state. Every completed verification attempt also remains in the
append-only event history with its bounded check evidence and diff. The evaluator
records manifest/fixture digests, observed evidence only after assertions pass,
honest unsupported reasons, measurements, aggregates, limitations, and counts in
the ignored local report. Generated reports are never committed.
