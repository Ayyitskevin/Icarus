# ADR 0067: Gate 2 target-discovery profile

- Status: Accepted as failed quality-improvement measurement; Gate 2 remains open
- Date: 2026-08-28
- Related: [ADR 0036](0036-proof-carrying-software-factory-product-direction.md),
  [ADR 0066](0066-gate2-live-model-comparison.md)

## Context

ADR 0066 retained an honest failed live measurement: its routed policy passed
9/30 cases, with security review and scaffold both at 0/5. Retrieval recall,
precision, and provenance were already above their gates. The next iteration
therefore needed to improve model-owned target discovery and minimal exact
read-only evidence without supplying expected answers, widening host authority,
or weakening the fixed manifest-v2 thresholds.

The original live evidence also had to remain reproducible. Changing the
candidate, instruction, or routing policy cannot retroactively make the v1
artifact invalid, and a slow provider response cannot silently remove a case
from a 30-case cohort.

## Decision

Add a separately digest-bound `gate2-local-vulcan-target-discovery-r7-20260828`
profile and retain ADR 0066's profile as immutable v1 evidence. The evidence
publisher validates each version against its own candidate-contract revision,
evidence-record revision, instruction-policy digest, and routing-policy digest.

The r7 policy makes four bounded quality changes:

- the model receives the complete repository path inventory beside the task
  and retrieved source bytes, while expected targets, citations, findings, and
  evaluator answers remain absent;
- the first-plan contract contains only mutation targets and registered check
  IDs, removing prose that the host never used to decide authority;
- one versioned instruction policy sets deterministic generation and adds
  repository-general scaffold and security-review guidance about ownership,
  local conventions, source-of-truth preservation, and minimal relationship
  evidence; and
- the routed lane uses `code` for all five task classes, while the paired
  baseline remains fixed `code-fast` for all 30 cases.

Candidate files must still exactly equal the plan's mutation targets. Requested
checks must still be registered, and read-only answers must request neither
mutation nor check authority. Mutations remain confined to disposable private
copies and only registered checks run in the pinned no-network sandbox.

Live requests use the fields supported by pinned Vulcan 1.0.0:
`temperature: 0` and `max_tokens: 8192`. The benchmark deliberately does not
send an unsupported structured-response field. Reassessment may reuse prior raw
output only when the instruction-policy digest matches; otherwise it must make
a fresh generation request.

A request timeout is a retained failed observation, not an omitted case. Its
record carries `request_timeout`, uses the declared input/output/runtime bounds
as conservative accounting upper bounds, and must fail both provider-completion
and scenario status. Other transport errors remain fatal to the benchmark run.

## Outcome

In the leak-free paired r7 run, fixed `code-fast` passed 5/30 and routed `code`
passed 16/30. Routed class successes were repair 7/10, refactor 4/5,
explanation 3/5, security review 2/5, and scaffold 0/5. First-pass plan
acceptance was 0.7667, retrieval recall was 0.9917, precision was 0.8083,
provenance was 1.0, and incorrect edits remained zero. All 60 provider requests
completed without timeout or other transport failure.

The 16/30 routed result improves on ADR 0066's historical 9/30 routed result,
and security review rises from 0/5 to 2/5, while scaffold remains 0/5. The
paired r7 baseline matched ADR 0066's historical 5/30, but the single 3.2
success ratio still must not be presented as evidence of general model
stability.

Gate 2 remains open: routed success is below 24/30 and plan acceptance is below
0.80. This single run proves neither general model quality nor authenticated
runner identity, and its artifact-size rates remain a relative local-compute
proxy rather than billed cost. It grants no active-repository, remote, canary,
merge, deployment, migration, live-database, or unattended authority.

## Verification

- `pnpm benchmark:gate2:live:publish`
- `pnpm exec vitest run tests/security/gate2-live-candidate-contract.test.ts tests/security/gate2-live-instruction-policy.test.ts tests/security/gate2-live-evidence.test.ts`
- `pnpm check`
- [Dated measurement](../evals/2026-08-28-gate2-target-discovery-profile.md)
