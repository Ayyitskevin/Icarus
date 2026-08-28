# Gate 2 manifest-v2 evidence adoption

Date: 2026-08-28

## Question

Can Icarus reuse deterministic Gate 2 evidence for the 28 case definitions that
manifest v2 preserves exactly, while keeping the two replacement cases direct,
without adding cross-revision headline counts or weakening host policy?

## Contract

`pnpm benchmark:gate2:adopt-v2` reads seven committed source reports from
`fixtures/evals/gate2/evidence/`. The source set is closed: six reports target
manifest v1 and contain 28 disjoint observations; one report targets manifest
v2 and contains exactly the two declared replacements. Each file is pinned by
raw SHA-256 and strict-parsed through its original cohort validator before the
adoption module can inspect an observation.

The module then validates manifest v2 against the exact v1 digest. A v1
observation is adoptable only when the complete predecessor and successor case
records are JSON-identical. Direct v2 evidence is allowed only for the two
declared successor IDs. One receipt per case binds the source report and
manifest, repository/task/scenario identities, full target-case digest,
retrieval metrics, plan applicability, incorrect-edit count, and replay digest.
Receipts are emitted in manifest-v2 order. No provider, repository, Git,
sandbox, credential, network, database, or mutation interface is present in the
adoption runner.

## Result

| Measure | Observed |
| --- | ---: |
| Frozen source reports | 7 |
| Adopted unchanged v1 cases | 28 |
| Direct v2 successor cases | 2 |
| Replay-validated v2 cases | 30 |
| Successful cases | 30 |
| Failed / missing cases | 0 / 0 |
| Macro retrieval recall | 0.9916666666666667 |
| Macro retrieval precision | 0.8083333333333333 |
| Digest provenance coverage | 1.0 |
| Incorrect edits | 0 |
| First-pass plan evidence | 20 accepted / 20 measured / 30 required |
| Live-model quality | not measured |
| Autonomous target discovery | not measured |
| Routed-vs-fixed comparison | not measured |

The task-count, successful-task, retrieval, provenance, and incorrect-edit
thresholds pass. The all-task planning and both routing thresholds remain false,
so `allGate2ThresholdsMet` is false and the assessment is
`deterministic_v2_evidence_adoption_passed_gate2_incomplete`.

The ignored atomic result is
`.local/gate2-v2-evidence-adoption-report.json`. Its `generatedAt` is the latest
validated source-evidence timestamp rather than wall-clock time. Two consecutive
runs over the immutable inputs produced byte-identical output, so the receipt is
replayable rather than merely re-creatable.

## What this proves

- deterministic evidence covers every manifest-v2 case identity under one
  explicit adoption contract;
- all 28 predecessor observations remain applicable because their complete
  case and repository definitions are unchanged;
- the two replacement observations came directly from manifest v2;
- source-report, scenario, target-case, aggregate, and replay tampering fails
  closed;
- the historical partial reports and both manifests remain unchanged.

## What this does not prove

- that an adopted case was newly executed under manifest v2;
- live-model explanation, security-review, planning, or mutation quality;
- autonomous target discovery, because mutation targets were operator-selected;
- first-pass planning quality across the ten read-only tasks;
- a 30% routed-cost improvement at non-inferior success against the fixed model;
- runner authenticity, production authority, live database safety, deployment,
  or unattended operation.

## Reproduce

```text
pnpm benchmark:gate2:adopt-v2
pnpm vitest run tests/security/gate2-v2-evidence-adoption-contract.test.ts
node scripts/security-check.mjs
pnpm check
```
