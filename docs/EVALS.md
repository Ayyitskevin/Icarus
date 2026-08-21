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

The Milestone 1 portion of `pnpm eval` validates that manifest and its immutable
fixture contracts, creates private temporary Git repositories, and exercises
seven M1 outcomes through production runtime/service code. Provider-backed cases
use the production
Ollama adapter over a deterministic loopback HTTP contract; this is not a live
installed model claim. The executable change runs its registered check through
the production no-network Docker sandbox and proves source content and Git
metadata remain unchanged.

The evaluator writes `.local/eval-report.json` with report schema v2, manifest
and fixture digests, per-case evidence, fixed per-case measurements, aggregate
measurements, limitations, and separate passed, failed, and unsupported counts.

H3a crash-tail evidence is a focused runtime integration rather than a new
manifest capability class. It starts the compiled headless CLI against a
deterministic loopback provider, waits until the second provider operation is
durably admitted, sends `SIGKILL`, and reopens the same SQLite state through the
compiled reconciliation command. The test requires exactly one charged
`operation.interrupted`, one `icarus.headless.worker-interruption.v1`
settlement, a checksum-valid committed prefix, byte-identical repeated recovery,
full conservative reservation accounting, no additional provider request,
refused ordinary resume, and an unchanged source Git fingerprint. The pure
grammar also retains already-committed interruption IDs if reconciliation
itself dies before settlement. The dated record is
[`docs/evals/2026-08-21-headless-crash-tail.md`](evals/2026-08-21-headless-crash-tail.md).

## Gate 1 benchmark contract

The populated Gate 1 input contract is committed at
`fixtures/evals/gate1/manifest.v1.json`. It is a separate closed manifest, not a
reinterpretation of the Milestone 1 schema-v2 catalog above. It contains exactly
one TypeScript-library repair, one Python-CLI repair, and one dependency-free
React/Node module repair fixture. The latter checks a JSX-to-module contract and
Node behavior; it is not evidence for a runnable React application. For each
case the manifest pins the repository and commit, exact repair task, model
provider/model version, prompt-revision labels and production planning/edit
system-instruction hashes, complete ordered registered-check IDs, names, and
argv, exact expected changed-path set, and Git object format. Its fixture
contract binds the raw task, source, and approved-repair bytes plus the
deterministic candidate object identities. Unknown fields, omitted/duplicated
members, or digest mismatch fail validation rather than becoming a partial case.

Each repository fixture is a plain content tree, not a trusted Git repository.
Its root `.git` path must be absent, and `.git` path components plus
`.gitattributes` files are forbidden from the pinned inventory. The evaluator
also excludes a root `.git` path while copying and rechecks its absence before
initialization. Fixture Git commands use fixed `/usr/bin/git` with an isolated
home and configuration, disabled system/global attributes and configuration,
disabled hooks and credential helpers, noninteractive prompts/SSH, and denied
network protocols. Hostile `.git` directory, file, symlink, and local clean-filter
fixtures must fail without executing the filter.

`pnpm benchmark:gate1` is the focused evaluator. `pnpm eval` includes that
focused contract in the ordinary evaluation gate. The default Gate 1 evaluator
uses the production Ollama adapter against a deterministic loopback HTTP
contract, runs registered checks in the production no-network sandboxes, and
exercises only the real local deterministic-candidate and absent-only private-ref
foundation. It uses no credential or paid model, permits no external network,
and performs no remote GitHub mutation. The manifest validates closed
draft-pull-request and landing-receipt requirements, while each completed-case
record labels both effects `not_executed_contract_only`; neither label is
evidence that a GitHub landing gateway, remote branch, pull request, or receipt
runtime exists. The manifest's derivative-effect declaration is
`contract-only-unassessed`, not an operator assessment of automation configured
on any real repository.

The evaluator owns the ignored `.local/gate1-benchmark-report.json` path and
removes any stale report before Gate 1 work begins. Report schema v1 is a closed
success/failure union. A success report binds the exact validated input-manifest
digest and contains all three completed cases with their observed task, source,
provider-instruction, check, and candidate identities. A handled failure after
report-output preflight contains only the ordered prefix of fully completed
cases. Its `contractPassed` count and `partial_completed_cases_only` effect
counters cover that prefix, not the active failed case; its failure record binds
the stage, the next case ID when execution failed, a bounded safe error code or
`null`, and only a digest of the error message. `manifestSha256` binds the raw
manifest bytes when they were available and is `null` only when those bytes
could not be read. The failure variant adds an explicit incomplete-effects
limitation. Both variants are strict-parsed and validated before and after the
atomic write, reject unknown or missing fields, and remain explicitly Gate 1
incomplete. Failure to validate or persist a report is itself a command failure,
not evidence.

For every completed case, the recovery exercise reopens the production runtime
and replays a harness-only candidate journal into a new local controller before
the absent-only local-ref step. It does not execute a browser reload or
foreground-server process restart, and it is not durable landing-coordinator or
duplicate-effect reconciliation evidence.

Separately, the browser authority contract says same-tab reload retains the
tab-scoped action session, while a foreground-process restart rotates the public
origin and bearer and requires an operator relaunch before durable work is
recovered. The offline report must never describe that separate contract, or the
bearer itself, as benchmark evidence.

Packet 2's local action and API tests cover exact descriptors and bounded
receipts, all eight protected route mappings, same-ID admitted no-replay,
prepared/admitted restart reconciliation, non-Linux refusal, and exact,
mismatched, and stale in-flight cancellation signals. Its compiled Chrome 149
smoke additionally covers confirmation, stale refusal, receipt recovery,
cancellation, and same-tab reload. Candidate
`701952349e0818cead37672df951ed09c0edd27c` separately passed hosted run
`30760607215` and native run `30760619650`; corrected implementation head
`3683087066efb65255f05b2493fd31051c3ad7c6` passed hosted run `30761189188` and
native run `30761192370`. Those exact-head results close only Packet 2's
eight-action Linux browser-authority slice; they do not constitute the
credential-gated live landing profile or complete Gate 1.

Neither synthetic report variant can complete Gate 1 regardless of its local
outcome. Gate 1 still requires a separate, versioned, human-approved,
credential-gated live-evidence profile. That profile must bind the offline
manifest digest and reuse its exact immutable case, task, registered-check,
source, expected-change, and candidate pins without treating the offline zero-
external-effect boundary as live authority. It must additionally pin the real
provider/model and adapter version, captured pricing and spend/runtime budgets,
and an operator-produced assessment of each real repository's branch/PR-
triggered automation, including its disposition and raw assessment digest. Only
named, separately approved Git object upload, absent-only remote-ref creation,
draft-PR creation, and receipt effects may be authorized. Gate 1 requires that
profile to succeed 3/3 against dedicated or explicitly approved repositories
with exact candidate and live branch/commit/draft-PR/receipt identities, passing
checks, exact changed paths, and unchanged source checkouts. Mock or synthetic
model, GitHub, automation, or receipt evidence is never promoted to that result.

Required Milestone 1 scenario classes:

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

The Milestone 1 catalog has all ten classes. Milestone 1 executes seven outcomes:

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
