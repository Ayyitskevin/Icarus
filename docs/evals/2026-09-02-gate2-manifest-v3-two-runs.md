# Gate 2 under manifest v3: two predeclared paired runs (2026-09-02)

## Question

Under the revision-10 instruction policy and manifest v3 (ADR 0073), does the routed arm
still fail the Gate 2 exit thresholds (24/30 successes, 0.80 first-plan acceptance), and do
two runs of the same instrument agree? v3 replaced three cases whose task text did not entail
the manifest's expected target set; this is the first measurement in which those three cases
are the model's to win or lose.

## Method

| item | value |
| --- | --- |
| benchmark manifest | `fixtures/evals/gate2/manifest.v3.json` (`e1411ab9…`), supersedes v2 (`0eca6348…`) |
| instruction policy | revision 10, digest `116168c9…` — unchanged by v3 |
| generation pins (from the policy) | `temperature: 0`, `maxTokens: 8192`, `think: false` |
| evidence record revision | 6 (`requestedThink` recorded; absent thinking is `null`) |
| execution profile | `03399661d250…`, identical for both runs; `code` = `qwen3.8:27b`, `code-fast` = `ornith-1.5:35b` |
| host (run-log and operator provenance, not frozen) | mickey, Node 22.23.2, Docker-backed checks; the sets freeze no host, Node, or Docker marker |
| commit (frozen) | `12f0568` for both runs |
| arms | baseline (`code-fast`) then routed (`code`), 30 cases each, per run |
| runs | two, predeclared before either was launched, run sequentially, each frozen as its own set |
| frozen sets | `docs/evals/artifacts/gate2-r10v3-run1-20260902/`, `…/gate2-r10v3-run2-20260902/` |
| freshness | 60/60 records per set carry `reassessedFromEvidenceSha256: null` (FRESH_CHECK in each run log) |
| wall clock (from the run logs, not frozen) | run 1: baseline 19:20:22–19:22:48 EDT, routed –19:30:11, freeze+verify+figures 19:30:12; run 2: baseline 19:31:27–19:33:46 EDT, routed –19:41:01, freeze+verify+figures 19:41:02 |

Predeclared before launch: two runs; no third run added on the strength of the first two;
figures reported per run and never pooled into a 60-case denominator; nothing here is a delta
against the revision-10 measurement on v2 (17/30), because three cases changed identity.

One operational note, so the wall clock reads honestly: the chain script refused run 2 at
19:30:12 because run 1's frozen set left the tree dirty (an untracked set under
`docs/evals/artifacts/`), a case the single-run script had never met; the dirty check was
narrowed to ignore that one directory and run 2 was relaunched by hand at 19:31:27. That chain
script is untracked, in the operator's home on mickey (`~/gate2-run-v3.sh`); nothing tracked
under `scripts/` or `fixtures/` changed between the runs, and both sets bind commit `12f0568`.

## What this is not

- Not a before-and-after against revision 10 on v2. Three cases are different cases.
- Not evidence about sampling variance. Decoding is pinned at temperature 0 and the two runs
  are a replication, not two samples — see "Two runs" below.
- Not a claim that the scaffold class's capability floors moved, and not a causal claim about
  the successor that passed: the bytes show two separate facts — the new task entails its
  target set (ADR 0073's cold reading), and this run passed it — not that the first caused
  the second.

## Results

Every figure recomputed by `node scripts/gate2-frozen-evidence-figures.mjs --set <dir>` from
the verified bytes; the manifest resolves from the digest each set's result files carry. The
two runs produced the same figures in every cell.

| figure | baseline (`code-fast`), run 1 / run 2 | routed (`code`), run 1 / run 2 | threshold |
| --- | --- | --- | --- |
| successes / 30 | 3 / 3 | **19 / 19** | ≥ 24 — **not met** |
| first-plan acceptance | 0.2 / 0.2 | **0.8333 / 0.8333** | ≥ 0.80 — **met** |
| passed | 3 / 3 | 19 / 19 | |
| plan rejected before any check | 1 / 1 | 3 / 3 | |
| unparseable | 23 / 23 | 2 / 2 | |
| executed and failed | 3 / 3 | 6 / 6 | |
| markdown-fenced among failures | 20 of 27 / same | 1 of 11 / same | |
| macro retrieval recall / precision | 0.9917 / 0.8083 (both arms, both runs) | | ≥ 0.9 / ≥ 0.6 — met |
| digest provenance coverage | 1 / 1 | 1 / 1 | ≥ 1 — met |
| incorrect edits | 0 / 0 | 0 / 0 | ≤ 0 — met |
| median estimated cost per success (proxy) | 0.001029 | 0.0008966835 | |
| pair: success ratio | 6.3333 (both runs) | | ≥ 1 — met |
| pair: cost reduction | 0.128587463557 (both runs) | | ≥ 0.3 — **not met** |
| comparison passed | false (both runs) | | |

Per class, routed, both runs: repair **7/10**, refactor **5/5**, explanation 3/5, security
review 3/5, scaffold **1/5**. Baseline, both runs: 0 / 0 / 2 / 1 / 0.

The three successor cases, routed arm, both runs:

| case | first plan | outcome | what the bytes say |
| --- | --- | --- | --- |
| `refactor-cart-money-extraction` | `["src/cart.py","src/money.py"]`, accepted | **passed** | the case revision 9 and 10 both lost on a "private helper" reading; the task now names the module and the model builds it |
| `scaffold-json-output-mode` | `["src/main.py","tests/test_json_output.py"]`, accepted | **passed** | the first scaffold success under any revision; the task names the check file |
| `scaffold-parser-cli-check` | `["checks/test_cli.py","src/cli.py"]`, accepted | executed and failed (`parser-cli` check failed) | the plan is exactly the expected set — the manifest defect is gone — and the case now measures the implementation, which is what a benchmark case is for |

Baseline (`code-fast`) produced no parseable candidate for any of the three (fenced, fenced,
truncated).

## Two runs: a replication, not two samples

Across the 60 paired records, **59 `rawCandidate` values are byte-identical** between run 1
and run 2, and those 59 carry identical input and output token counts; `latencyMs` differs on
all 60. The one exception is routed `security-schema-migration`: 764 versus 772 bytes and 204
versus 205 output tokens (input 931 in both; estimated cost `0.0008904075` versus
`0.000891192`), with the same four selected context paths, the same three citations, the same
`findingIds: []`, and the same outcome (plan accepted, read-only mismatch, failed) in both
runs. Under this profile's pins (`temperature: 0`, `think: false`) the second run reproduced
the first in 59 of 60 candidates and in every aggregate figure — down to a cost reduction of
`0.128587463557`. Two observations do not prove the provider deterministic or that the pins
caused the agreement; what they do establish is that these two runs are a replication of one
sample, and that their agreement says nothing about how the instrument would vary under
sampling. A future "repeated runs" claim needs either a non-zero temperature declared as
part of the instrument or a different seed per run, and must say which.

## Failure buckets (routed, identical in both runs)

| bucket | cases |
| --- | --- |
| plan rejected before any check (3) | `repair-name-whitespace` (`["src/format_name.py","src/profile.py"]`), `scaffold-cart-discount` (`["checks/test_cart.py","src/cart.py"]`), `scaffold-task-priority-contract` (`["checks/priority_contract.sql","schema/current.sql"]`) |
| unparseable (2) | `repair-public-path-containment` (markdown fence), `scaffold-greeting-command` (contract refusal: `selectedContextPaths must stay inside the host` — recorded shape `null`, derived `other`) |
| executed and failed (6) | checks failed: `repair-lantern-missing-config`, `scaffold-parser-cli-check`; read-only exact-set mismatches: `explain-refactor-duplication`, `explain-schema-contract`, `security-config-trust`, `security-schema-migration` |

Baseline failures are dominated by markdown fences (20 of 27), as under revision 10 on v2.

## Decision items

- **The acceptance threshold is met on this instrument (0.8333 ≥ 0.80); the success threshold is
  not (19 < 24); the pair comparison fails on cost reduction (0.1286 < 0.3), not on the ratio.**
  Gate 2 stays open.
- Of the three routed plan rejections, `scaffold-cart-discount` and
  `scaffold-task-priority-contract` are target-set readings a reviewer should examine the way
  the v3 brief examined cart-money — the plans are defensible readings of their tasks — before
  anyone spends a policy revision on them. `repair-name-whitespace` proposes a second file the
  task does not ask for.
- `scaffold-greeting-command` is now the only scaffold case whose task names no path in a
  `checks/`-only fixture (ADR 0073 deferred it); it also did not parse here.
- The cost-reduction threshold (0.3) passed under revision 7 (0.5542, routed 16/30) and has
  failed on every instrument since reasoning was suppressed: 0.2176 (revision 9), 0.1400
  (revision 10), 0.1286 (v3, both runs) — while the success ratio passes on every instrument
  (3.2 → 6.0 → 5.67 → 6.33). What moved is the within-instrument relation of the two arms'
  output: under revision 7 the routed arm emitted less than its baseline (38,366 versus
  91,780 output tokens over 30 cases); under v3 it emits more (7,547 / 7,548 versus 6,652),
  because the suppressed-reasoning budget shrank the baseline's output far more than the
  routed arm's. Whether 0.3 is the right bar for this pair of models is a question for the
  threshold's owner, not for the next policy revision. (Ratios and reductions from each
  frozen set's `comparison.json`; token totals summed from the records.)

## Verification commands

    node scripts/gate2-freeze-live-evidence.mjs --verify docs/evals/artifacts/gate2-r10v3-run1-20260902
    node scripts/gate2-freeze-live-evidence.mjs --verify docs/evals/artifacts/gate2-r10v3-run2-20260902
    node scripts/gate2-frozen-evidence-figures.mjs --set docs/evals/artifacts/gate2-r10v3-run1-20260902
    node scripts/gate2-frozen-evidence-figures.mjs --set docs/evals/artifacts/gate2-r10v3-run2-20260902

Each figures run reports "Every recomputed figure agrees with the committed result and
comparison files." The 59/60 identity claim: compare `rawCandidate` and
`observation.usage.{inputTokens,outputTokens}` across the two sets' 60 record files.

## Documents this result updates

`docs/ROADMAP.md` (row 2 and a supersede paragraph), `docs/EVALS.md` (a supersede paragraph,
the class-breakdown sentence, the current-record link), `docs/PLANS.md` (a supersede sentence
and the checklist anchor), ADR 0073 (Outcome), `docs/DECISIONS.md` (the 0073 row).
