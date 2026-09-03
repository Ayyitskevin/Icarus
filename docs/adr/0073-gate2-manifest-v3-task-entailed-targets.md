# ADR 0073: Gate 2 manifest v3 — the task text entails the expected targets

- Status: **Accepted** 2026-09-02 — Kevin's go ("go ahead with manifest v3, then two runs")
- Date: 2026-09-02
- Related: [ADR 0071](0071-gate2-instruction-policy-r10-target-conventions.md) (the policy
  whose revision-10 rules were conditioned on tasks that name what they want),
  the fleet decision brief `2026-09-02_gate2-cart-money-module-decision-brief.md` (option B,
  recommended; filed in `shared/handoffs/`, outside this repository), and the
  [revision-10 record](../evals/2026-09-02-gate2-revision-10.md) (two manifest defects, three
  capability floors)

## Context

Revision 10 was measured on 2026-09-02: routed 17/30, `refactor` 4/5, `scaffold` 0/5. Reading
the six remaining first-plan rejections from the frozen bytes, three are not model misses.
They are cases where the manifest's expected target set is not what the task text, read cold
against the fixture, entails:

| case | task said | manifest expected | what both arms produced |
| --- | --- | --- | --- |
| `refactor-cart-money-module` | "a private helper" | `src/cart.py`, `src/money.py` | `src/cart.py` only, a `_sum_cents` helper inside it |
| `scaffold-parser-cli` | "a command-line entry point around the boolean parser … and tests" | `src/cli.py`, `tests/test_cli.py` | `src/parser_cli.py`, `checks/test_parser_cli.py` — the fixture has `checks/`, never `tests/` |
| `scaffold-lantern-json-output` | title "Lantern JSON output"; "a registered offline check" | `tests/test_json_output.py` | `tests/test_lantern_json_output.py` |

In each, revision 10's own rules — follow the repository's conventions, keep every word of the
task's subject — produce the model's answer, not the manifest's. The benchmark was scoring its
own under-specification as target-discovery failure, and the exact-set first-plan comparison
(`assessGate2FirstPassPlan`) has no way to say "either shape". The decision brief examined
three options and recommended sharpening the task text as a successor manifest; widening the
expected set would make the measurement mean less, and leaving it counts a defect as a miss.

Two hundred and one committed files carry the v2 digest, and three frozen evidence sets pin it
by value. An in-place edit was never on the table.

## Decision

`fixtures/evals/gate2/manifest.v3.json` supersedes v2 through the same lineage mechanism v2
used to supersede v1: it binds v2's exact bytes by digest, preserves 27 cases byte-for-byte,
and replaces three cases with successors whose task text entails the expected target set.

| predecessor | successor | what the new task says |
| --- | --- | --- |
| `refactor-cart-money-module` | `refactor-cart-money-extraction` | extract into "a new `money` module beside" the cart module; `subtotal` stays as the public API |
| `scaffold-parser-cli` | `scaffold-parser-cli-check` | an entry point "named `cli`"; its check goes "beside the existing parser check, following that check's naming" — expected set moves to `checks/test_cli.py`, `src/cli.py` |
| `scaffold-lantern-json-output` | `scaffold-json-output-mode` | title drops the product name; "a registered offline check named for the JSON output mode, under a new `tests` directory" |

The sharpening is in the **task**, which the model is meant to satisfy, never in the policy.
The leak guard scans the policy against v3's stems exactly as it did against v2's; v3 adds no
stem v2 did not already carry, and the revision-10 policy digest
`116168c999834a3b…` is unchanged.

Mechanism, so that a fourth revision is a registration and not a rewrite:

- The contract carries a **lineage registry**: each schema-2 revision names the manifest it
  supersedes (revision, path, digest), its replacements, and its successor cases by exact
  value. A manifest whose `benchmarkRevision` is not registered is refused; nothing about a
  lineage is read from the manifest that claims it. `validateGate2BenchmarkSuccessor` checks
  any registered pair, and `loadGate2BenchmarkContract` walks the whole chain against
  committed bytes — an edited v1 refuses v3.
- The v3 digest is pinned in code (`GATE2_V3_MANIFEST_SHA256`) and asserted against the
  bytes by test and by `security-check.mjs`; a change to the file is a new revision. The
  loader binds this at runtime too: `GATE2_MANIFEST_SHA256_BY_REVISION` is the registered
  digest for each revision, and `loadGate2BenchmarkContract` refuses bytes whose digest is
  not the one registered for the revision they claim — a valid-JSON edit (the first review
  appended one space) cannot produce a run under a digest nothing can resolve.
- `validateGate2BenchmarkSuccessor` takes the predecessor's **raw bytes**, digests and
  strict-parses them itself. The earlier object-plus-digest signature accepted a forged v2
  object handed in beside the real v2 digest; there is now no object to hand in.
- Every manifest, predecessor, and task read in the loader goes through one repository-rooted
  read boundary: a real root, a path inside it, every component lstat-checked on the way down
  (no symlink, directories until the last), an ordinary single-link regular file at the end,
  and only then bytes. The first review reached the lineage through a byte-identical symlink
  to a file outside the repository; the digest authenticated the content while the path said
  nothing about where it came from.
- `GATE2_MANIFEST_PATHS_BY_SHA256` is the only place a digest becomes a path. The figures
  script resolves a frozen set's benchmark from the digest its own result files carry, so
  every earlier set (v2-era r9, r10, reasoning-suppressed) recomputes with no flag and no
  default that silently drifts.
- The runner reads `GATE2_CURRENT_MANIFEST_PATH`. Its mutation-oracle registry gains three
  successor oracles derived from the v2 entries they replace (same approved bytes;
  `scaffold-parser-cli-check` relocates its check file and argv, and
  `scaffold-json-output-mode` takes the check id `json-output-mode` — the inherited id said
  `lantern`, the very title word that had left its check name underdetermined). A
  test pins every v3 mutation case to exactly one oracle whose approved paths equal the
  manifest's expected set — the coupling the runner scores by.

## Consequences

- Figures under v3 are a **new measurement**. They do not extend r10's 17/30 and will not be
  presented as a delta against it: three cases changed identity, and the thing being measured
  for those three changed from "guess the manifest author's target set" to "produce the target
  set the task entails".
- The scaffold class keeps its three capability floors (a fence, a truncation, an empty
  answer). v3 fixes the benchmark's two defects; it does not fix the model. A scaffold 0/5
  under v3 is a model finding; under v2 it was not.
- Published evidence sets remain pinned to v2 by value. The publisher's own v2 path is
  untouched; publishing a v3-era set is a separate change.
- Deterministic cohorts (`GATE2_SCAFFOLD_A_ORACLES`, `GATE2_REFACTOR_ORACLES`) and their
  frozen replay reports are untouched: the successor oracles live beside them, not in them.
- `scaffold-greeting-command` was considered and deferred. It expects `tests/test_greet.py`
  in a fixture that has only `checks/`, from a task that names no path — the same shape as
  the parser-CLI defect — but it has never produced a parseable answer under any revision,
  so its ambiguity has never decided its score. The moment it parses, it will; the next
  manifest revision should carry it. v3 therefore holds two `tests/` expectations against
  seven `checks/`.
- The three successor task texts were read cold by the Opus seat against only what the model
  sees (fixture inventory, retrieved context, revision-10 rules, registered check id); the
  first draft of the JSON-output task named the directory but not the file and was held for
  it — under rule 2 a model keeps "mode", and with no existing check to imitate the `test_`
  prefix had no anchor. The task now names `test_json_output.py`.

## Outcome (2026-09-02, evening)

Two predeclared paired runs on mickey under revision 10 and v3
([record](../evals/2026-09-02-gate2-manifest-v3-two-runs.md)): routed 19/30 at first-plan
acceptance 0.8333 in both, baseline 3/30 in both. `refactor-cart-money-extraction` and
`scaffold-json-output-mode` passed; `scaffold-parser-cli-check` proposed exactly its expected
set and failed its check — the benchmark defect is gone and the case measures the model. The
acceptance threshold is met on this instrument; the success threshold is not. The two runs
agree in every figure, with 59 of 60 candidates byte-identical under the instruction
policy's temperature-0 pin, so they replicate rather than sample. A new measurement, never a delta
against 17/30.

## Verification

    node scripts/gate2-benchmark-contract.mjs
      -> validatedManifests: v1 43159d8a…, v2 0eca6348…, v3 e1411ab9…; validatedCases 30
    node scripts/gate2-frozen-evidence-figures.mjs --set docs/evals/artifacts/gate2-r10-20260902
      -> Benchmark manifest: manifest.v2.json (0eca6348be78), resolved by digest; every figure agrees
    pnpm exec vitest run tests/security/gate2-live-instruction-policy.test.ts
      -> 3 passed against v3's stems; the policy digest did not move
