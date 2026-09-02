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

The schema-v2 catalog portion of `pnpm eval` validates that manifest and its
immutable fixture contracts, creates private temporary Git repositories, and
exercises seven M1 outcomes plus one bounded Gate 2 explanation. Provider-backed
cases use the production
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

The schema-v2 Milestone 1 catalog still reports behavior-preserving module
refactor and read-only security findings as unsupported representative
scenarios. ADR 0036 Gate 2 governs both. The separate Gate 2 security-review
cohort described below now measures the read-only retrieval/provider/result
contract, but it does not retroactively convert the Milestone 1 scenario or
live-model security quality into a pass. Unsupported catalog contracts validate
their fixtures and capability classification but are never converted into
passes.

## Gate 2 deterministic read-only cohorts

`pnpm benchmark:gate2:retrieval` is the first bounded Gate 2 measurement. Its
closed one-case manifest is
`fixtures/evals/gate2/retrieval-manifest.v1.json`; `pnpm eval` runs it after the
Milestone 1 and Gate 1 evaluators. The evaluator copies the pinned unfamiliar-
codebase fixture into a private temporary Git repository, proves the exact tree
and commit identities, and calls the production core's deterministic lexical
retriever over that committed tree. The retriever filters linked, excluded,
binary, invalid-UTF-8, and secret-shaped files; enforces query, tree, scan,
selected-file, and selected-byte ceilings; and emits content digests plus
bounded line-match provenance.

The current closed fixture contains four expected program files plus one
eligible historical distractor that matches the task's `lantern` term. The
retriever selects the four expected files and rejects the distractor, producing
recall `1.0` and falsifiable precision `1.0` while preserving both the source
fixture and temporary committed worktree byte-for-byte. The ignored report is
`.local/gate2-retrieval-report.json`. Its validator derives pass/fail from the
fixed `0.90` recall and `0.60` precision thresholds and refuses nonzero
provider, network, repository-mutation, or registered-command effects.

The focused retrieval-only benchmark remains a foothold, not Gate 2 completion:
it calls no model and produces no explanation. The schema-v2 catalog separately
runs one `explain_codebase` evaluator over the same pinned application.

The 30-task manifest now has its own five-case explanation cohort. The retriever
normalizes test/check vocabulary and follows one deterministic reference hop
from query-matched files; referenced files remain subject to the same eligible
file, byte, secret, and source-commit bounds. This closed the non-circular
retrieval failures exposed by the guardrail and duplicated-module tasks without
injecting manifest expected paths or their cardinality into retrieval.

`pnpm benchmark:gate2:explanation` executes exactly the manifest's five
explanation cases. Each case copies a pinned fixture into a temporary Git
repository, runs the production retriever and production Ollama adapter against
one case-specific frozen loopback response, validates a closed summary/claims
schema plus every selected-path inclusive line range in the host, and binds its
manifest, task, repository, Git tree, evaluator, retrieval, provider, usage,
outcome, and source-invariance evidence. The atomic ignored report is
`.local/gate2-explanation-cohort-report.json`; stale success is removed before
work starts. Its strict validator refuses altered shapes, counts, effects,
oracles, citations, usage, evidence digests, limitations, duplicate JSON keys,
oversized input, and excessive depth.

The frozen cohort reports 5 executed, 5 passed, and 25 unexecuted under one
oracle-independent eight-file budget. Recall and digest provenance are `1.0` in
all five cases; precision is `1.0` once and `0.75` four times (macro `0.80`).
The five production-adapter calls stay on loopback at configured zero rates,
and source plus temporary Git state remain observably unchanged. The report
labels provider/request counts, source invariance, and fixture setup as observed;
zero external-network, remote-mutation, repository-code, and registered-command
effects are design assertions enforced by the closed runner, not instrumented
counters. The dated measurement is
[`docs/evals/2026-08-28-gate2-explanation-cohort.md`](evals/2026-08-28-gate2-explanation-cohort.md).

Citation validation proves that each claim points to selected source lines; it
does not prove semantic entailment. Frozen responses prove contract integration,
not live-model explanation quality.

`pnpm benchmark:gate2:security-review` separately executes the manifest's five
`security_review` cases through the same production retriever and structured
Ollama adapter. The dedicated `reviewCodebaseSecurityV2` seam accepts only a
bounded retrieval receipt and exact task, makes one bounded provider call, and
returns either one or more typed findings or an explicit source-backed
`no_finding` record. The host rejects changed receipts, malformed assessment
cardinality, repeated finding IDs or citations, unsafe IDs/severities,
unselected/out-of-range/empty citation spans, secret-shaped or oversized text,
non-strict JSON, and invalid provider usage. It exposes no command, repository,
approval, or mutation interface.

The security-review report also records 5 executed, 5 passed, and 25 unexecuted
because each partial cohort is independently closed against the 30-case
manifest. Across the explanation and security-review reports, 10 distinct
manifest cases now have deterministic contract-integration evidence and 20 have
not been executed by either cohort. Security retrieval recall and digest
provenance are `1.0` in all five cases; precision is `1.0`, `0.50`, and `0.75`
three times (macro `0.75`), satisfying the manifest's macro `0.60` floor without
hiding the hostile-instruction case's extra context. Three cases bind exact
finding IDs; two bind explicit no-finding evidence. The dated measurement is
[`docs/evals/2026-08-28-gate2-security-review-cohort.md`](evals/2026-08-28-gate2-security-review-cohort.md).

Frozen responses and source locations do not establish live-model security
judgment, semantic entailment, or whole-codebase coverage.

`pnpm benchmark:gate2:refactor` executes the five `refactor` cases through
the production retriever and ordinary `IcarusService` plan, digest-bound
approval, PatchSet, private-workspace check, local review, and runtime-reopen
lifecycle. Frozen loopback responses propose exact byte-pinned scenario
oracles. Each evaluator runs the same registered check before and after the
mutation in the digest-pinned, no-network Docker sandbox; the cart and parser
fixtures reproduce their deliberate baseline failures, and all five final
checks pass. Exact changed paths and final-file digests, provider prompts and
usage, retrieval provenance, source plus complete Git-directory invariance,
and durable completed-run recovery are retained in the ignored atomic report
`.local/gate2-refactor-cohort-report.json`.

The cohort records 5 executed, 5 passed, and 25 unexecuted. Retrieval recall and
digest provenance are `1.0` in every case; precision is `1.0` once and
`0.75` four times (macro `0.80`). All five first plans reach approval, but
the operator supplies the allowed target set and, where a new path sorts first,
an existing non-mutating anchor. The reported `1.0` therefore measures
first-pass host-contract acceptance, not autonomous target discovery or live-
model planning quality. Ten loopback provider requests, ten sandbox checks,
five private-workspace mutations, five registered final checks, and five
runtime reopens are observed. External network, remote mutation, and live-
database connection zeros are closed-design assertions; the schema evaluator
runs twice only against in-memory SQLite. The dated measurement is
[`docs/evals/2026-08-28-gate2-refactor-cohort.md`](evals/2026-08-28-gate2-refactor-cohort.md).

`pnpm benchmark:gate2:repair-a` executes five host-policy-compatible manifest `repair`
cases through that same production mutation lifecycle. The operator selection
is exactly the expected changed-path set: these cases create no path and need no
selection anchor. One existing behavioral check passes before its proof is
strengthened; the other four baselines reproduce their intended failures. All
five final registered checks pass after exact private-workspace repairs, and all
five completed runs survive runtime reopen. Retrieval recall and digest
provenance are `1.0`; precision is `1.0` once and `0.75` four times (macro
`0.80`). Ten loopback requests, ten sandbox checks, five private mutations,
five registered final checks, and five reopens are observed. This cohort has no
database or migration case; its zero external-network, remote-mutation, and
database effects are closed-design assertions. The dated measurement is
[`docs/evals/2026-08-28-gate2-repair-cohort-a.md`](evals/2026-08-28-gate2-repair-cohort-a.md).

`pnpm benchmark:gate2:repair-b` executes four more modify-only repair cases:
the basic greeting, cart subtotal, explicit-false parser, and public-path
containment scenarios. All four intended baseline failures reproduce; the final
registered checks pass after exact private-workspace changes, and every run
survives reopen with source and Git metadata unchanged. Retrieval recall and
provenance are `1.0`; precision is `1.0` twice and `0.75` twice (macro
`0.875`). Eight loopback requests and eight sandbox checks are observed. The
dated measurement is
[`docs/evals/2026-08-28-gate2-repair-cohort-b.md`](evals/2026-08-28-gate2-repair-cohort-b.md).

`pnpm benchmark:gate2:scaffold-a` executes four scaffold cases compatible with
current host policy: Lantern JSON output, integer-cents cart discounts, the
parser CLI, and the greeting command. All four intended baseline failures
reproduce. Seven files are created and one is modified only inside private Git
workspaces; all four registered final checks pass, and every completed run
survives runtime reopen with source files and complete source Git directories
unchanged. Retrieval provenance is `1.0`; recall is `1.0` in three cases and
`0.75` in the greeting case (macro `0.9375`), while precision is `1.0` twice
and `0.75` twice (macro `0.875`). The report retains that expected-context
omission rather than forging a perfect per-case score. Eight loopback requests,
eight sandbox checks, four private mutations, four final checks, and four
reopens are observed. The protected task-priority migration scaffold remains
excluded. The dated measurement is
[`docs/evals/2026-08-28-gate2-scaffold-cohort-a.md`](evals/2026-08-28-gate2-scaffold-cohort-a.md).

`fixtures/evals/gate2/manifest.v2.json` is the immutable, host-policy-compatible
successor to manifest v1. It binds the exact v1 SHA-256
`43159d8a174312e7fd720fbb625173601e7c90f6e5983c62c206b69ce99c9558`,
preserves 28 cases byte-for-byte, and replaces only the two cases whose declared
outputs required protected `migrations/` paths. The replacement tasks retain
offline schema semantics but target only `schema/` snapshots and read-only
`checks/` contracts. They do not create or apply a migration, connect to a live
database, or widen ordinary PatchSet policy. Manifest v2 SHA-256 is
`0eca6348be7848bac44922bcf426defdbd581af8ef790515e28c231b5fbc69c5`.

`pnpm benchmark:gate2:schema-successor` executes exactly those two v2 cases
through production retrieval, plan approval, private PatchSet mutation,
digest-pinned no-network SQLite checks, local review, and durable runtime reopen.
Both intended baselines fail and both final registered checks pass. Recall and
digest provenance are `1.0`; precision is `0.75` for each case. Four loopback
requests, four sandbox checks, four observed in-memory SQLite executions, two
private mutations, two final checks, and two reopens are observed. The report
retains 2 executed, 2 passed, and 28 unexecuted. The dated measurement is
[`docs/evals/2026-08-28-gate2-schema-successor-cohort.md`](evals/2026-08-28-gate2-schema-successor-cohort.md).

Across the explanation, security-review, refactor, repair-A, repair-B, and
scaffold-A reports, 28 distinct manifest-v1 cases have deterministic contract-
integration evidence. Each partial report retains its independent unexecuted
count. The two schema-successor observations are evidence against manifest v2;
those seven source reports cannot be added directly into a synthetic 30/30
result.

`pnpm benchmark:gate2:adopt-v2` is the explicit adoption path. The repository
freezes the seven validated source reports under
`fixtures/evals/gate2/evidence/`, pins each report's raw SHA-256, and invokes
every report's owning strict validator. The adoption module then proves the
exact v1→v2 manifest lineage, requires byte-identical case definitions for all
28 predecessor observations, accepts direct v2 evidence only for the two named
successors, and orders one replay receipt per case by the v2 manifest. Every
case receipt binds the source report, source manifest, repository and task
revision, scenario-evidence digest, complete target-case digest, retrieval
metrics, plan applicability, incorrect-edit count, and its own replay digest.
Missing, duplicated, reordered, replaced, drifted, forged, or unvalidated
evidence fails closed.

The deterministic aggregate contains 30 replay-validated and 30 successful v2
case identities: 28 exact predecessor adoptions plus two direct successor
executions. Macro retrieval recall is `0.9916666666666667`, macro precision is
`0.8083333333333333`, digest provenance is `1.0`, and incorrect edits are zero.
The task-count, successful-task, retrieval, provenance, and incorrect-edit
thresholds are met. First-pass plan acceptance remains incomplete because only
the 20 mutation cases have applicable plan evidence; live-model quality,
autonomous target discovery, and fixed-model routing cost/success comparison
remain unmeasured. The aggregate therefore retains
`allGate2ThresholdsMet: false` and assessment
`deterministic_v2_evidence_adoption_passed_gate2_incomplete`. Its ignored atomic
report is `.local/gate2-v2-evidence-adoption-report.json`; identical immutable
inputs replay byte-identically. The dated measurement is
[`docs/evals/2026-08-28-gate2-v2-evidence-adoption.md`](evals/2026-08-28-gate2-v2-evidence-adoption.md).

## Gate 2 live-model comparison

ADR 0066 added the first explicit live execution of all 30 manifest-v2 cases;
ADR 0067 adds the current target-discovery successor without rewriting that
evidence. Both are separate from deterministic `pnpm eval` and run only through
the focused `benchmark:gate2:live:*` commands. A digest-bound profile pins local
Vulcan's `code` and `code-fast` mappings, exact local Ollama model digests,
positive estimated rates, the fixed baseline, and the model pool. ADR 0067's
separately bound routing policy uses `code-fast` for every baseline case and
`code` for every routed case.

Each model independently selects its bounded retrieved context, first plan,
targets, and answer through a closed candidate contract. The current profile
supplies the complete eligible path inventory, removes unused plan prose, and
binds target-independent revision-8 instructions under SHA-256
`5b299c7c27cd38d3f070d4c673c0234eaf257761d3cc294e49a1fbbbf023270d`;
it supplies no expected target, finding, citation, or evaluator answer. The host
does not repair semantic output. Exact-plan mutation candidates run only in
disposable private copies through registered no-network Docker checks;
read-only outcomes require exact manifest citations and finding IDs. Every case
proves its source copy unchanged and retains structural, plan, evaluator,
usage, provider-completion, and finish evidence. Truncated output is a failed
observation; a request timeout is retained as a failed case with declared-budget
upper-bound accounting, while other transport failures abort the run.

The leak-free run under instruction-policy revision 8 measured fixed `code-fast` at 5/30
with first-plan acceptance `0.2667`, and routed `code` at 16/30 with acceptance `0.7667`.
Superseded as the current measurement 2026-09-01: under revision 9, which binds
`think: false` so `maxTokens` is a content budget rather than a combined
reasoning-plus-content budget, fixed `code-fast` measured 2/30 with acceptance `0.0667`
and routed `code` measured 12/30 with acceptance `0.60`
([evaluation](evals/2026-08-31-gate2-reasoning-suppressed.md), evidence frozen at
`evals/artifacts/gate2-reasoning-suppressed-20260901/`). The two sets were taken under
different budget contracts and are not a controlled comparison; the revision-8 figures
remain valid records of what was measured then.
Superseded as the current measurement 2026-09-02: under revision 10 (ADR 0071 — class
conventions for `refactor` and `repair`, a narrowed check rule, citation minimality, an
output boundary), written under evidence record revision 6 and frozen with the schema-v2
freezer, fixed `code-fast` measured 3/30 with acceptance `0.2` and routed `code` measured
17/30 with acceptance `0.7333` ([evaluation](evals/2026-09-02-gate2-revision-10.md),
evidence frozen at `evals/artifacts/gate2-r10-20260902/`). Policy text, writer, and freezer
all changed, so this is a new measurement rather than a controlled comparison with revision
9; the revision-9 figures remain valid records of what was measured then.
Routed class success under revision 8 was repair 7/10, refactor 4/5, explanation 3/5,
security review 2/5, and scaffold 0/5; under revision 9 it was repair 7/10, refactor 0/5,
explanation 3/5, security review 2/5, and scaffold 0/5; under revision 10 it is repair
7/10, refactor 4/5, explanation 3/5, security review 3/5, and scaffold 0/5. Both revision-8 arms retained macro recall `0.9917`, precision
`0.8083`, provenance `1.0`, and zero incorrect edits. The routed run improved
the success count and lowered median estimated proxy cost per success by
`0.554217121588`, but it still missed the predeclared 24/30 and 0.80 absolute
thresholds. The strict comparison therefore reports
`gate2-routing-comparison-failed`; autonomous target discovery, especially
scaffold, remains open quality work.

Each committed evidence directory contains all 60 case records, preflight, two
results, comparison, and a 64-source-file artifact manifest. Publication
revalidates immutable ADR 0066 v1 and current ADR 0067 v2 against their own
candidate, evidence, instruction, and routing revisions; recomputes every
contract and digest; checks each model against its routing policy; and rejects
unknown secret-shaped spans. The configured rates are a relative local
artifact-size proxy, not billed USD; all actual billed cost fields remain null.
These unkeyed records establish reviewable self-consistency, not runner
authentication, multi-seed generalization, new runtime authority, or Gate 2
completion. The current dated record is
[`docs/evals/2026-09-02-gate2-revision-10.md`](evals/2026-09-02-gate2-revision-10.md);
the revision-8 record
[`docs/evals/2026-08-28-gate2-target-discovery-profile.md`](evals/2026-08-28-gate2-target-discovery-profile.md)
and the revision-9 record
[`docs/evals/2026-08-31-gate2-reasoning-suppressed.md`](evals/2026-08-31-gate2-reasoning-suppressed.md)
are historical, and the historical first comparison remains
[`docs/evals/2026-08-28-gate2-live-model-comparison.md`](evals/2026-08-28-gate2-live-model-comparison.md).

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
for the deterministic selectors, not broad semantic-retrieval quality. The
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

## Gate 2 benchmark contract

The original closed Gate 2 contract is the byte-preserved
`fixtures/evals/gate2/manifest.v1.json`. Its immutable successor is
`fixtures/evals/gate2/manifest.v2.json`; the successor exact-binds v1's digest,
replacement map, 28 unchanged cases, and two reviewed host-policy-compatible
replacement cases. Both manifests pin
30 task documents and seven existing fixture repositories by complete sorted
file inventory, raw-byte SHA-256, and canonical inventory digest. The task mix
is fixed at ten repairs, five refactors, five explanations, five security
reviews, and five scaffolds. Unknown, missing, duplicate, reordered, reclassified,
unpinned, or byte-drifted input fails validation.

`pnpm benchmark:gate2:contract` strict-parses and validates both revisions and
their lineage offline. `pnpm eval` includes the same command. A successful
command reports the latest 30 validated cases, zero executed cases, and
`contract_validated_gate2_execution_not_run`.
It reads no credentials, invokes no provider or repository code, performs no
network or Git operation, mutates no source checkout, and cannot complete Gate 2.

The manifest publishes these quality gates before a full runner exists:

- at least 24 of 30 successful tasks;
- macro retrieval recall at least 0.90 and macro precision at least 0.60;
- manifest-matching digest provenance for every retrieved path;
- first-pass plan acceptance at least 0.80;
- zero changed paths outside each case's exact expected set; and
- for an exact paired baseline/routed comparison, at least 30% lower median
  estimated cost per success without lowering the successful-task count.

A case succeeds only when its exact scenario evaluator reports `passed`, its
class-specific changed-path/citation/finding evidence matches the manifest, and
it has zero incorrect edits. Each case binds a stable
`<case-id>-evaluator` identifier. Every observation must repeat that exact
identifier and carry the digest of its retained evaluator evidence. The digest
is a reference and self-consistency field, not authentication of the runner or
proof that the referenced evidence exists. Six separate partial cohorts
implement five explanation, five security-review, five refactor, five repair-A,
four repair-B, and four scaffold-A evaluator IDs. The four five-case reports
each leave 25 cases unexecuted; repair-B and scaffold-A independently leave 26.
No v1 partial report fabricates the full result's remaining observations. Their
distinct-case union covers 28 cases and leaves 2 unexecuted, but is not a
synthetic full result or threshold pass; the full-suite runner remains
unavailable and incomplete. The separate two-case v2 successor report cannot be
added to that v1 union because revision identity is part of the evidence.

The strict result contract recomputes retrieval, provenance, plan, outcome,
usage, cost, and aggregate values from 30 manifest-bound observations. It
refuses duplicate or extra fields, stale repository/task identities, invented
digests, over-budget usage, inferred billing, and caller-supplied aggregate
tampering. `actualBilledUsd` is always null; cost is an estimate from the
captured per-model price table. One result can pass the published quality
thresholds but still reports that paired comparison is required. The common
execution profile pins one baseline model plus every admitted model's provider,
adapter version, model version, and captured input/output rates. Every case
observation names the model that handled it, baseline observations must all use
the pinned baseline model, and usage cost is recomputed from that selected
model's rates. A routing claim requires baseline and routed records with the
same execution-profile digest, model pool, repository/task revisions, budgets,
and captured prices; the comparison reports both the baseline model and routed
model set and refuses a routing claim unless at least one task used a declared
non-baseline model.

This contract makes the benchmark reviewable; it is not benchmark evidence.
Its strict JSON decoder is byte- and depth-bounded, and its result limitations
state that structural self-consistency does not authenticate runner or evaluator
evidence. The partial explanation, security-review, refactor, and repair-A
runners retain five outcomes each, while repair-B and scaffold-A retain four
each; the schema-successor runner retains two v2 outcomes. A trusted v2 full
runner must retain the exact evidence bytes named by every one of its 30
observations.
Gate 2 remains open until the scenario evaluators and deterministic retrieval
runtime execute the fixed suite and satisfy the accepted ADR 0036 exit gate.
