# Gate 2 paired run under instruction-policy revision 10 — 2026-09-02

> **SKELETON. The run this record describes has not happened.** Every figure below is
> `TBD` and names the exact command that will produce it. Nothing here may be cited until
> the run exists, its evidence is frozen, and the placeholders are replaced from the
> frozen bytes. The figures quoted from earlier runs are recomputed, not recalled — see
> Verification.

## Question

Instruction-policy revision 10 ([ADR 0071](../adr/0071-gate2-instruction-policy-r10-target-conventions.md))
adds class rules for `refactor` and `repair`, narrows the general "do not rewrite checks"
rule, keeps every word of a task's domain subject in a new name, requires the answer to be
the JSON object alone, and asks read-only classes for minimal citations. The
[2026-09-01 diagnosis](../diagnoses/2026-09-01-gate2-zero-classes-and-fenced-baseline.md)
found that under revision 9 the failures decompose rather than being one failure: six of
the ten `refactor` + `scaffold` losses were first-plan target selection with parseable
output, and 27 of the baseline arm's 28 failures were a markdown code fence.

**Under a policy that states the output boundary and the two missing classes' conventions,
what does Gate 2 measure?**

Not "does revision 10 improve on revision 9" — see *What this is not*.

## Method

| | |
| --- | --- |
| host | mickey (the only host this run may execute on) |
| gateway | Vulcan `c6223a6`, loopback |
| routed model | `code` → `qwen3.8:27b`, profile pin `qwen3.8-27.3b-q4km-22130167c4c2` |
| baseline model | `code-fast` → `ornith-1.5:35b`, profile pin `ornith-1.5-35.5b-q4km-9f3b89b25219` |
| generation | `think: false`, `temperature: 0`, `maxTokens: 8192` |
| budgets | `maxInputTokens: 50000`, `maxOutputTokens: 8192`, `maxRuntimeSeconds: 300` |
| execution profile | `gate2-local-vulcan-target-discovery-r7-20260828`, digest `03399661…` |
| benchmark manifest | `fixtures/evals/gate2/manifest.v2.json`, `0eca6348…` |
| instruction policy | revision 10, digest **TBD — read `instructionPolicySha256` from the frozen manifest; it is not stable until [#83](https://github.com/Ayyitskevin/Icarus/pull/83) lands** |
| evidence record revision | 6 |
| frozen set | `docs/evals/artifacts/gate2-r10-<date>/`, freezer schema `icarus.gate2-frozen-evidence.v2` |

Both arms run the same 30 cases: `repair` 10, `refactor` 5, `explanation` 5,
`security_review` 5, `scaffold` 5.

**A run is fresh only if every record carries `reassessedFromEvidenceSha256: null`.**
Raising the evidence record revision makes an invocation over older records take the
reassessment path, which re-scores stored candidates and calls no provider; that path
reported success in six seconds during earlier work. Check this before reading any number
below as a measurement.

## What this is not

**These figures are a new measurement, not a before-and-after against the revision-9
2/30 and 12/30.** Three things changed at once between that set and this one, and no
paired arm isolates any of them:

1. **The policy text changed** — revision 9 → 10, a different digest, new class rules and
   an output boundary.
2. **The evidence record revision changed** — 5 → 6. Revision 5 omitted `requestedThink`
   and wrote an absent provider `thinking` member as `reasoningChars: 0`; revision 6
   requires the member and records that absence as `null`, and adds
   `selectedQueryMatches` so a record's retrieval coverage reconciles against its own
   omissions. A zero in this set and a zero in the 2026-09-01 set mean opposite things.
3. **The freezer changed** — schema v2, a record contract derived from the bytes, and
   refusals for strays, symlinks and hard links.

A change in score against revision 9 may reflect any of the three, or the instrument
improving, and must not be read as capability moving. This is the same rule ADR 0070
applied to revision 9 against revision 8.

## Results

All cells `TBD`. Produce every one of them with a single command against the frozen set:

```
node scripts/gate2-frozen-evidence-figures.mjs --set docs/evals/artifacts/gate2-r10-<date>
```

That command refuses to print a figure until `verifyFrozenEvidence` reports no problem, and
it cross-checks every recomputed figure against the committed result and comparison files;
if it prints a **Disagreements** section, the numbers below are not writable yet.

| | baseline `code-fast` | routed `code` |
| --- | --- | --- |
| success / 30 | TBD | TBD |
| first-plan acceptance | TBD | TBD |
| repair (of 10) | TBD | TBD |
| refactor (of 5) | TBD | TBD |
| explanation (of 5) | TBD | TBD |
| security_review (of 5) | TBD | TBD |
| scaffold (of 5) | TBD | TBD |
| macro retrieval recall | TBD | TBD |
| macro retrieval precision | TBD | TBD |
| digest provenance coverage | TBD | TBD |
| incorrect edits | TBD | TBD |
| median estimated cost per success | TBD | TBD |

Exit thresholds, from `fixtures/evals/gate2/manifest.v2.json`: **24/30 success** and
**0.80 first-plan acceptance**, plus recall ≥ 0.9, precision ≥ 0.6, provenance = 1,
incorrect edits per success ≤ 0. Pair thresholds: routed/baseline success ratio ≥ 1 and
cost reduction ≥ 0.3.

| | |
| --- | --- |
| thresholds passed (baseline / routed) | TBD / TBD |
| comparison `passed` | TBD |
| comparison `assessment` | TBD |
| every record `reassessedFromEvidenceSha256: null` | TBD |
| `finishReason: "stop"` count | TBD / 60 |
| `usageBasis: "provider_reported"` count | TBD / 60 |

## Failure buckets

The three the diagnosis used, disjoint and summing to 30 per arm. The same command prints
them; do not re-derive them by hand.

| bucket | baseline | routed |
| --- | --- | --- |
| passed | TBD | TBD |
| plan rejected before any check (exact-set mismatch, no check ran) | TBD | TBD |
| unparseable | TBD | TBD |
| executed and failed | TBD | TBD |
| markdown-fenced failures | TBD | TBD |

The output-boundary rule is aimed squarely at the fenced bucket, so record the fenced count
for both arms whatever it is. Two shape columns must be reported separately and not merged:

| arm | shape named in the recorded error | shape derived from `rawCandidate` |
| --- | --- | --- |
| baseline | TBD | TBD |
| routed | TBD | TBD |

Revision-6 records are written by a runner whose strict parser names the shape
(`truncated` / `markdown_fenced` / `leading_prose` / `empty` / `other`), so unlike the
2026-09-01 set the *recorded* column should carry shapes rather than `null`. If it still
reads `null`, say so — that is a finding about the runner, not a formatting detail.

## Decision items

- **`refactor-cart-money-module` is a known manifest ambiguity, not a model miss.** The
  task says *"private helper"*; the manifest expects `{src/cart.py, src/money.py}`. Under
  revision 9 both arms independently produced an in-file underscore helper and were
  rejected at the exact-set plan match before any check ran. Revision 10's refactor rules
  are conditioned on a task that *names* a module, and this one does not, so **this case is
  expected to fail again**; if it passes, that is worth investigating rather than
  celebrating. Brief and recommendation (option B: a successor `manifest.v3.json`, never an
  in-place edit of v2): `~/ai-workspace/shared/handoffs/2026-09-02_gate2-cart-money-module-decision-brief.md`.
  Until it is resolved, subtract this case before reading the routed plan-rejection count
  as target-discovery evidence.
- **`scaffold-lantern-json-output`** returned 0 content characters in 112 provider-reported
  output tokens under revision 9, clean stop, zero reasoning. Record whether it recurs.
- **Reasoning-enabled arm.** ADR 0070 names the paired `think: true` arm as the next
  measurement after this one. This run does not answer whether reasoning improves answers.

## Verification

A reader re-runs these, in this order, and needs nothing else:

```
# 1. the frozen set is true of its bytes: manifest digests, closed directory,
#    regular non-linked files only, record contract re-derived from the records
node scripts/gate2-freeze-live-evidence.mjs --verify docs/evals/artifacts/gate2-r10-<date>

# 2. every figure in this record, recomputed from the 60 case records
node scripts/gate2-frozen-evidence-figures.mjs --set docs/evals/artifacts/gate2-r10-<date>
node scripts/gate2-frozen-evidence-figures.mjs --set docs/evals/artifacts/gate2-r10-<date> --json

# 3. the publication boundary: this set alongside the earlier cohorts, with the
#    secret-shape screen
npx vitest run tests/security/gate2-live-evidence.test.ts

# 4. the whole gate
pnpm check
```

To record, from the frozen bytes rather than from the run's console:

- commit, `capturedAt`, `instructionPolicyRevision` and `instructionPolicySha256`,
  `executionProfileDigestSha256`, `evidenceRecordRevision`, and the derived
  `recordContract` — all from `docs/evals/artifacts/gate2-r10-<date>/manifest.json`.
- the file count (**TBD**; earlier sets are 64 source files plus the manifest).
- Node version, Vulcan commit, and the two model digests as the preflight recorded them.

The revision-9 figures this record refers to — baseline 2/30 at first-plan
`0.066666666667` with classes `repair 1, refactor 0, explanation 0, security_review 1,
scaffold 0`, and routed 12/30 at `0.6` with `repair 7, refactor 0, explanation 3,
security_review 2, scaffold 0` — were recomputed for this draft with
`node scripts/gate2-frozen-evidence-figures.mjs --set docs/evals/artifacts/gate2-reasoning-suppressed-20260901`,
which reported `verified: true` and no disagreement with that set's committed results. No
figure in this record was taken from prose.

## Documents this result must update

Quoted from `ff454e6`. Each entry gives what changes if the thresholds are met and if they
are not. **In both outcomes the revision-9 paragraphs stay** — they remain valid records of
what was measured then, and the supersede sentence is added beside them, exactly as
revision 9 was added beside revision 8.

### `docs/ROADMAP.md`

**Line 20**, the Gate 2 status row:

> `| 2 | Context and agent quality — **target discovery improved; quality gate open** | … the routed run still missed the predeclared 24/30 success and 0.80 first-plan thresholds, so Gate 2 remains open |`

- *Thresholds not met:* keep the row title, append the revision-10 figures as the current
  measurement, keep "Gate 2 remains open".
- *Thresholds met:* the row title and the closing clause both change; a threshold pass is a
  gate decision, not a documentation edit, and needs ADR 0036's exit criteria checked
  against the pair thresholds (ratio ≥ 1, cost reduction ≥ 0.3) as well as the per-arm ones.

**Lines 96-113**, the current-measurement paragraph, which opens:

> `Superseded as the current measurement 2026-09-01: ADR 0070 bound `think: false` into instruction-policy revision 9…`

and closes:

> `Gate 2 remains open for stable success of at least 24/30 and plan acceptance of at least 0.80.`

- *Either outcome:* a new "Superseded as the current measurement 2026-09-02" paragraph is
  added after it, naming revision 10, the new digest, the evidence record revision 6, and
  the three-way instrument change under *What this is not*.
- *Not met:* the closing sentence stands unchanged.
- *Met:* the closing sentence must be rewritten, and the "new baseline, NOT a
  before-and-after" caveat must be carried forward — a pass measured under a changed
  instrument is still not a before-and-after.

### `docs/EVALS.md`

**Lines 428-435**, the current-measurement paragraph:

> `Superseded as the current measurement 2026-09-01: under revision 9, which binds `think: false` … fixed `code-fast` measured 2/30 with acceptance `0.0667` and routed `code` measured 12/30 with acceptance `0.60` … The two sets were taken under different budget contracts and are not a controlled comparison; the revision-8 figures remain valid records of what was measured then.`

- *Either outcome:* a parallel revision-10 sentence with the new figures, evidence path, and
  the reason it is not a controlled comparison.

**Line 436**, the class-success sentence:

> `Routed class success was repair 7/10, refactor 4/5, explanation 3/5, security review 2/5, and scaffold 0/5.`

- *Either outcome:* this sentence describes the **revision-8** run (7+4+3+2+0 = 16, matching
  16/30), yet it now sits immediately after the revision-9 paragraph, whose routed classes
  are 7/0/3/2/0 = 12. Adding a third measurement above it makes the ambiguity worse. Label
  each class breakdown with the revision it belongs to when this record lands. This is a
  pre-existing readability defect, recomputed here, not something the run causes.

### `docs/PLANS.md`

**Line 26**, the current-measurement sentence:

> `Superseded as the current measurement 2026-09-01: instruction-policy revision 9 binds `think: false` … fixed `code-fast` measured 2/30 and routed `code` measured 12/30 with first-plan acceptance 0.60, both thresholds still failing, with evidence frozen at `evals/artifacts/gate2-reasoning-suppressed-20260901/`.`

- *Either outcome:* a parallel revision-10 sentence, with the frozen path.

**Lines 16-18**, the historical framing:

> `result from the historical 9/30 to 16/30, including security review 2/5 and scaffold 0/5; its paired baseline repeated 5/30, and the routed result still missed the 24/30 success and 0.80 first-plan thresholds. Gate 2 remains open for broader quality and stability improvement.`

- *Not met:* unchanged.
- *Met:* the closing sentence changes and the whole paragraph needs a pass, since it still
  frames 16/30 as the current routed result.

**Lines 115-117**, the open checklist item:

> `- [ ] Raise stable routed quality from 16/30 to at least 24/30 and first-plan acceptance from 0.7667 to at least 0.80 across predeclared repeated runs, without losing retrieval/provenance gates, introducing incorrect edits,`

- *Either outcome:* the "from 16/30" and "from 0.7667" anchors are two measurements stale —
  they name revision 8 while revision 9 is the current measurement. Re-anchor them to the
  revision-10 figures when this record lands.
- *Met:* the item can only be ticked if "across predeclared repeated runs" is satisfied,
  which one paired run does not do on its own.
