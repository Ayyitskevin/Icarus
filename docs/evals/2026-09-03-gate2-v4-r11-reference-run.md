# Gate 2 under manifest v4 and policy revision 11: the reference run (2026-09-03)

## Question

With every v3 failure read cold — one benchmark defect fixed in the manifest (v4, plus the
deferred greeting case and one leak-free task tightening), one rule ambiguity fixed in the
policy (revision 11), the rest recorded as model misses — where does the routed arm stand
against the Gate 2 exit thresholds (24/30 successes, 0.80 first-plan acceptance), read from a
single temperature-0 run, predeclared on the strength of the v3 pair's agreement (every
aggregate figure, 59 of 60 candidates) — an observation about that pair, not a determinism
claim?

## Method

| item | value |
| --- | --- |
| benchmark manifest | `fixtures/evals/gate2/manifest.v4.json` (`da1f9e0b…`), supersedes v3 (`e1411ab9…`) |
| instruction policy | revision 11, digest `434340b1…` — one clause changed from revision 10 |
| generation pins (from the policy) | `temperature: 0`, `maxTokens: 8192`, `think: false` |
| evidence record revision | 7 — check stdout and stderr recorded as text beside their digests (ADR 0075) |
| execution profile | `03399661d250…` (`live-profile.v2.json`); `code` = `qwen3.8:27b`, `code-fast` = `ornith-1.5:35b`; the profile pins no temperature |
| host (run-log and operator provenance, not frozen) | mickey, Node 22.23.2, Docker-backed checks |
| commit (frozen) | `66bedf5` |
| runs | one, predeclared in the day-3 handoff before launch. Basis: the prior v3 pair agreed in every aggregate figure with 59/60 candidates byte-identical, which its record says proves neither determinism nor cause; one run is therefore the reference instrument by predeclaration, not by proof. Variance is ADR 0074's instrument, not this one |
| frozen set | `docs/evals/artifacts/gate2-r11v4-run1-20260903/` (64 files, verified) |
| freshness | 60/60 records carry `reassessedFromEvidenceSha256: null` (FRESH_CHECK in the run log) |
| wall clock (run log, not frozen) | baseline 13:34:02–13:36:26 EDT, routed –13:43:05, freeze + verify + figures 13:43:06 |

## What this is not

- Not a delta against 19/30: three instruments moved at once — three case identities (v4),
  one policy clause (revision 11), and the evidence writer (record revision 7); the freezer's
  schema is unchanged. No per-case difference is attributed to any of them.
- Not a variance estimate: one run at temperature 0.
- Not a claim that the ten v3 model misses moved for any reason but the model.

## Results

Every figure recomputed by `node scripts/gate2-frozen-evidence-figures.mjs --set <dir>` from
the verified bytes; the manifest resolves from the digest the set's result files carry.

| figure | baseline (`code-fast`) | routed (`code`) | threshold |
| --- | --- | --- | --- |
| successes / 30 | 3 | **21** | ≥ 24 — **not met** |
| first-plan acceptance | 0.2667 | **0.8333** | ≥ 0.80 — met |
| passed | 3 | 21 | |
| plan rejected before any check | 1 | 3 | |
| unparseable | 21 | 2 | |
| executed and failed | 5 | 4 | |
| markdown-fenced among failures | 19 of 27 | 2 of 9 | |
| macro retrieval recall / precision | 0.9917 / 0.8083 (both arms) | | ≥ 0.9 / ≥ 0.6 — met |
| digest provenance coverage | 1 | 1 | ≥ 1 — met |
| incorrect edits | 0 | 0 | ≤ 0 — met |
| median estimated cost per success (proxy) | 0.001029 | 0.0008966835 | |
| pair: success ratio | 7.0 | | ≥ 1 — met |
| pair: cost reduction | 0.128587463557 | | ≥ 0.3 — **not met** |
| comparison passed | false | | |

Per class, routed: repair **7/10**, refactor **5/5**, explanation **4/5**, security review
3/5, scaffold **2/5**. Baseline: 0 / 0 / 2 / 1 / 0.

The medians per success are the same values the v3 runs produced, to every printed digit, so
the pair's cost reduction is unchanged at `0.128587463557`: the routed successes' median cost
did not move while the count did.

### The three v4 successors, routed arm

| case | first plan | outcome |
| --- | --- | --- |
| `repair-lantern-config-contract` | `["src/main.py"]`, accepted | **passed** — the check whose exact stderr string the v3 task never stated |
| `scaffold-greeting-command-check` | `["checks/test_greet.py","src/greet.py"]`, accepted | **passed** — the case that had never parsed under any revision |
| `explain-task-schema-contract` | read-only; cited exactly `checks/schema_contract.sql`, `README.md`, `schema/current.sql` | **passed** |

### The security-review cases, and what revision 11 did

`security-config-trust` — the case revision 11 was written for — returns the finding in this
record: `findingIds: ["unvalidated-config-shape"]`, with the summary "reads `config/app.json`
and passes the audience value directly to `greeting` without validating that it is a string".
Across the seven committed sets (six prior and this one) the case's routed record returned the finding under
instruction-policy revision 8 (the target-discovery record,
`gate2-local-vulcan-target-discovery-r7-20260828` — the `r7` in that name is not the policy
revision), returned no finding in the 2026-08-28 code-routing set, under revision 9, and under
revision 10 (three sets), and returns it here; it has never matched its citation set. Here it fails on
`["src/main.py"]` against expected `["config/app.json","src/main.py"]` — one path short, the
file the finding is about. Whether the revision-11 clause is why this record carries the
finding is the hypothesis revision 11 was written on; one unpaired run under three changed
instruments does not establish it.

`security-schema-migration` fails as the Opus seat's brief said it might: the candidate now
cites `migrations/README.md` (plus `checks/schema_contract.sql`) beside the two expected paths,
on a task that asks about "unsafe migration assumptions" in a fixture whose expected context
lists `migrations/README.md`. The brief called the expected citation set "defensibly narrow"
and this reading "not wrong"; it is now recorded behaviour, not a hypothetical (decision item).

`explain-refactor-duplication` cites one surplus path (`README.md`), as under v3.

### The 27 cases whose identity did not change

Against the v3 run-1 routed records: 19 of 27 candidates are byte-identical despite the changed
system prompt; one outcome flipped — `repair-cart-empty-list`, **passed under v3, unparseable
here** (a markdown fence around otherwise well-formed JSON, `finishReason: stop`). The routed
arm's fenced count is 2 of 30 (`repair-public-path-containment` again, plus this one). Nothing
here attributes the flip to the clause; a changed prompt is a changed input for every case.

## Failure buckets (routed, 9)

| bucket | cases |
| --- | --- |
| plan rejected before any check (3) | `repair-name-whitespace` (`["src/format_name.py","src/profile.py"]`), `scaffold-cart-discount` (`["checks/test_cart.py","src/cart.py"]`), `scaffold-task-priority-contract` (`["checks/priority_contract.sql","schema/current.sql"]`) — the same three plans as under v3, byte for byte |
| unparseable (2) | `repair-public-path-containment` (fence), `repair-cart-empty-list` (fence; passed under v3) |
| executed and failed (4) | `scaffold-parser-cli-check` (its own check fails, `AssertionError` — now readable from the record's `checks[].stderr` without a replay); read-only mismatches: `explain-refactor-duplication` (surplus `README.md`), `security-config-trust` (finding right, one citation short), `security-schema-migration` (two surplus citations, one of them the file the task's subject names) |

Every check entry in both arms (16 of 16) carries its stdout and stderr as text; the digests
beside them verify.

## Decision items

- **21/30 at 0.8333.** The acceptance threshold holds; the success threshold is three short;
  the pair fails on cost reduction only. Gate 2 stays open.
- **`security-schema-migration`'s expected citation set** should be decided, not left: either
  the task says "the schema snapshot and the repository's stated boundary" (a successor), or
  the expected set admits `migrations/README.md`. The v3 brief flagged it; the v4 run made it
  real. Manifest v5 candidate.
- **The three plan rejections** are byte-identical to v3's and were read cold as model misses
  (#104); nothing in this run changes that reading.
- **Fenced output** is now 2/30 routed; `repair-cart-empty-list` passed under the revision-10
  prompt and fenced under the revision-11 prompt. It is one case; it is worth watching before
  it is worth a rule.
- **Cost reduction 0.3** remains an owner question (threshold, not policy).

## Verification commands

    node scripts/gate2-freeze-live-evidence.mjs --verify docs/evals/artifacts/gate2-r11v4-run1-20260903
    node scripts/gate2-frozen-evidence-figures.mjs --set docs/evals/artifacts/gate2-r11v4-run1-20260903

The figures run reports "Every recomputed figure agrees with the committed result and
comparison files." The 19-of-27 identity and the one flip: compare `rawCandidate` and the
bucket of each shared case id between this set's `routed/` and
`docs/evals/artifacts/gate2-r10v3-run1-20260902/routed/`.

## Documents this result updates

`docs/ROADMAP.md` (row 2 and a supersede paragraph), `docs/EVALS.md` (a supersede paragraph,
the class-breakdown sentence, the current-record link), `docs/PLANS.md` (a supersede sentence
and the checklist anchor), ADR 0076 and ADR 0077 (Outcome), `docs/DECISIONS.md` (the 0076 and
0077 rows; the 0074 row becomes the proposed ADR). This PR also adds
`docs/adr/0074-gate2-repeated-runs-declare-the-varying-factor.md` (Proposed; the Codex seat's
draft, integrated by the lead), read for this PR by the Opus seat, which did not author it.
