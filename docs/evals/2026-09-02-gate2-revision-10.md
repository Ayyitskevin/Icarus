# Gate 2 paired run under instruction-policy revision 10 — 2026-09-02

> Every figure here is recomputed from the committed bytes under
> `docs/evals/artifacts/gate2-r10-20260902/` by
> `node scripts/gate2-frozen-evidence-figures.mjs --set docs/evals/artifacts/gate2-r10-20260902`,
> which first verifies the set's manifest against those bytes and refuses to compute
> anything otherwise. Nothing below is cited from a log, a terminal, or memory.

## Question

Revision 9 (ADR 0070, `think: false`) measured routed `code` at 12/30 with first-plan
acceptance 0.60, and the diagnosis of its eighteen routed failures
(`docs/diagnoses/2026-09-01-gate2-zero-classes-and-fenced-baseline.md`) found that the two
classes scoring 0/5 had **no class rules at all** and that six of their ten misses were
target selection on structurally valid answers — a policy gap, not a capability floor.
Revision 10 (ADR 0071) adds conventions for `refactor` and `repair`, narrows the check
rule, adds citation minimality and an output boundary, and states its leak boundary
mechanically. What does the same benchmark measure under it?

## Method

| item | value (from the frozen preflight and manifest) |
| --- | --- |
| host | mickey, Vulcan `:8140` (`vulcanConfigSha256 e364f80be55b…`), Ollama loopback |
| commit | `96d88ee` (main at launch; policy, writer, and freezer all on main) |
| instruction policy | revision 10, digest `116168c999834a3b7717ae6c344255c349e6a7ae8591c6bd9fbc5f2d4229d252` |
| evidence record | revision 6 — `requestedThink` recorded; an absent provider `thinking` member is `null` |
| generation | `temperature 0`, `maxTokens 8192`, `think: false` (digest-bound in the policy) |
| routing policy | `01c96e8eedc4…` — routed arm `code`, baseline arm `code-fast`, no overrides |
| models | `code` = `qwen3.8:27b` (`22130167c4c2…`), `code-fast` = `ornith-1.5:35b` (`9f3b89b25219…`) |
| execution profile | `03399661d250…` |
| benchmark manifest | `fixtures/evals/gate2/manifest.v2.json` (`0eca6348be78…`), 30 cases, 5 classes |
| freezer | schema `icarus.gate2-frozen-evidence.v2`, 64 files, manifest hashed after formatting, `recordContract` derived from the records |
| record contract | revision 6 · `requestedThink` present in every record · absent thinking encoded as `null` · written 2026-09-02 · `everyRecordReasoningChars: null` (every record reports `null`) |
| wall clock | baseline arm 17:21:47–17:24:24 EDT; routed arm –17:31:37; freeze and verify 17:31:38 |

## What this is not

It is **not a before-and-after against revision 9's 12/30**, for a stronger reason than
revision 9 had against revision 8: three instruments changed at once — the policy text
(revision 10), the evidence writer (revision 6 records `requestedThink` and encodes an
absent thinking member as `null` instead of `0`), and the freezer (schema v2, contract
re-derived from bytes). Both runs used the same manifest, models, budget, and `think:
false`, so the numbers sit in the same table below; they are two measurements under two
stated instruments, not a controlled delta.

It is not a measurement of autonomous target discovery beyond what the policy's
conventions frame, and it is not two runs: stability "across predeclared repeated runs"
(ADR 0036) is unmeasured here.

## Results

Recomputed from the 60 case records; the retrieval, cost, and comparison rows are read
from the frozen result files the manifest covers.

| figure | baseline (`code-fast`) | routed (`code`) |
| --- | --- | --- |
| success / 30 | **3** | **17** |
| first-plan acceptance | 0.2 | 0.7333 |
| repair (of 10) | 0 | 7 |
| refactor (of 5) | 0 | **4** |
| explanation (of 5) | 2 | 3 |
| security_review (of 5) | 1 | 3 |
| scaffold (of 5) | 0 | **0** |
| macro retrieval recall | 0.9917 | 0.9917 |
| macro retrieval precision | 0.8083 | 0.8083 |
| digest provenance coverage | 1 | 1 |
| incorrect edits | 0 | 0 |
| median estimated cost per success (USD) | 0.001029 | 0.000884916 |
| thresholds passed (recorded) | false | false |

| pair | value | required |
| --- | --- | --- |
| routed success ratio | 5.6667 | ≥ 1 |
| routed cost reduction | 0.1400 | ≥ 0.3 |
| comparison `passed` | false (`gate2-routing-comparison-failed`) | — |
| every record `reassessedFromEvidenceSha256` | `null` (60 of 60; no provider call was reused) | — |
| `finishReason: "stop"` | 60 of 60 | — |
| `usageBasis: "provider_reported"` | 60 of 60 | — |
| `reasoningChars` | `null` in 60 of 60 — the provider surfaced no thinking member under `think: false`; revision 6 records that as absence | — |

For the same table under revision 9 (`docs/evals/artifacts/gate2-reasoning-suppressed-20260901`,
same command): baseline 2/30 at 0.0667, routed 12/30 at 0.60, routed classes 7/0/3/2/0.

## Failure buckets

The diagnosis's three buckets, from the records (a passed case is `observation.scenarioStatus`
`passed`; unparseable is `candidate: null`; the rest split on `firstPassPlanAccepted`):

| bucket | baseline | routed |
| --- | --- | --- |
| passed | 3 | 17 |
| plan rejected before any check (exact target-set mismatch) | 2 | 6 |
| unparseable | 22 | 2 |
| executed and failed | 3 | 5 |
| markdown-fenced among failures | 20 | 1 |

Unparseable, by the shape the record itself names:

| arm | recorded shape |
| --- | --- |
| baseline | `markdown_fenced` ×20, `other` ×1, and one record with no shape: `security-schema-migration` parsed as JSON and was refused by the candidate contract (`selectedContextPaths must contain 1..8 entries`) — a contract refusal, not a parse failure |
| routed | `markdown_fenced` ×1 (`repair-public-path-containment`), `truncated` ×1 (`scaffold-greeting-command`, 450 characters, `finishReason: stop`) |

The routed arm's thirteen failures: 6 plan rejections, 2 unparseable, 5 executed-and-failed.
The two classes that were 0/5 under revision 9 split: **refactor** measured 4/5 and
**scaffold** stayed at 0/5, with one truncated answer and four cases whose failures are the
next diagnosis, not this record's claim. The refactor figure is not a capability claim:
three of the four passing cases (`refactor-name-normalization`, `refactor-lantern-config-loader`,
`refactor-schema-task-view`) are covered by rules ADR 0071 records as holding for exactly one
case, and the fourth (`refactor-parser-token-table`) passed with no new rule firing — which is
the re-examination ADR 0071's authoring rule calls for when cases are added, not evidence
that the conventions generalise.

## Decision items

- `refactor-cart-money-module`: the brief in
  `~/ai-workspace/shared/handoffs/2026-09-02_gate2-cart-money-module-decision-brief.md`
  recommends **B**, a successor `manifest.v3.json` whose task text entails the new module,
  batched with the next manifest change (201 committed files carry the current manifest
  digest, so no in-place edit). Kevin's call.
- `scaffold` at 0/5 in both arms under both revisions is the next diagnosis: read the five
  records' plans against `expectedChangedPaths` before proposing any rule.
- The pair comparison fails on **cost reduction** (0.14 against 0.3), not on the success
  ratio; whether that threshold is the right shape for a loopback provider whose cost is an
  estimate is an ADR 0036 question.

## Verification

```sh
# 1. the frozen set is true of its bytes: manifest digests, closed directory, regular
#    non-linked files only, record contract re-derived from the records
node scripts/gate2-freeze-live-evidence.mjs --verify docs/evals/artifacts/gate2-r10-20260902

# 2. every figure in this record, recomputed from the 60 case records
node scripts/gate2-frozen-evidence-figures.mjs --set docs/evals/artifacts/gate2-r10-20260902
node scripts/gate2-frozen-evidence-figures.mjs --set docs/evals/artifacts/gate2-r10-20260902 --json

# 3. the same command over the revision-9 set, for the side-by-side table
node scripts/gate2-frozen-evidence-figures.mjs --set docs/evals/artifacts/gate2-reasoning-suppressed-20260901
```

The freeze ran on mickey immediately after the routed arm (`.local/gate2-run.log`:
`FREEZE_EXIT=0`, `VERIFY_EXIT=0`, `FRESH_CHECK records=60 reassessed=0`), and the set was
verified again on flow before this record was written. Review before merge: the Codex seat
checks every figure against the bytes, and the Opus seat checks the record against its
skeleton and the three documents below; their verdicts are on PR #101.

## Documents this result updates

Thresholds were not met, so per the skeleton's plan: `docs/ROADMAP.md` keeps the Gate 2
row title and its "remains open" clause and gains a 2026-09-02 supersede paragraph;
`docs/EVALS.md` gains a parallel revision-10 sentence and its class-breakdown sentences are
labelled by revision; `docs/PLANS.md` gains a parallel sentence and re-anchors the open
checklist item to these figures. The revision-9 and revision-8 paragraphs stay as records of
what was measured then.
