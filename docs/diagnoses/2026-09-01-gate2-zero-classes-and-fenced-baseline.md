# Diagnosis: why two Gate 2 classes score zero, and why the baseline scores two

Date: 2026-09-01. Evidence: the frozen revision-9 set at
`docs/evals/artifacts/gate2-reasoning-suppressed-20260901/` (instruction-policy revision 9,
`think: false`). Every count below recomputes from those records; no inference was run for
this diagnosis.

## The routed arm decomposes into four buckets, not one

| routed `code`, 30 cases | count |
| --- | --- |
| passed | 12 |
| parsed, **first-pass plan rejected** on exact target match — no check ever ran | **8** |
| unparseable (1 markdown-fenced, 1 reasoning-in-content, 1 empty, 1 JSON error) | 4 |
| parsed, plan accepted, executed, **failed** (5 read-only, 1 repair check) | 6 |

`refactor` 0/5 and `scaffold` 0/5 are not one failure. Six of the ten are plan rejections;
four are unparseable output. They need different fixes, and one of them is cheap.

## The baseline arm is a format artifact

Fixed `code-fast` (`ornith-1.5:35b`) failed 28 of 30. **27 of those 28 are markdown-fenced
JSON** — the model wraps its answer in a code fence and the strict parser refuses it. The
remaining routed-vs-baseline ratio (12 vs 2, "6×") is therefore mostly *one model fences and
the other does not*, which is the same conclusion ADR 0067's amendment reached from the
target-matching post-hoc and is now counted directly. Whether the fenced answers were
otherwise correct is unmeasured: the harness discards them before scoring, deliberately,
because strict-output compliance is part of the contract. It is still the single largest
unrealised block in the benchmark.

## The eight plan rejections, read against the task text

Each is a target-discovery miss. Grouped by what the model did rather than which class it is:

**Did not create the module the task implied (3).**
- `refactor-name-normalization`: task says *"extract … into one shared module"*; the model
  updated both callers and created no module.
- `scaffold-cart-discount`: task says *"add a … discount helper … and tests"*; the model put
  the helper into the adjacent existing component and its existing test, despite a scaffold
  rule that says a distinct helper gets its own module.
- `refactor-cart-money-module`: task says *"extract subtotal arithmetic into a private
  helper"*; the manifest expects a new module. The model kept the helper in-file. **This
  reading is defensible** — "private helper" does not say "new module" — and this case
  should be reviewed as a possible manifest ambiguity rather than steered toward its answer.

**Edited the implementation when the task's deliverable was the check (2).**
- `repair-name-whitespace`: task says *"prove they remain identical"*; the behaviour is
  already correct and the deliverable is the proof. The model edited the implementation.
- `repair-cart-empty-list`: the fix requires updating the check that covers the repaired
  behaviour. The model changed only the implementation — and the policy's general rule
  *"Do not … rewrite existing checks"* told it to. **The policy steers the model away from
  the expected answer here.**

**Named the new artefact reasonably but not as the repository would (3).**
- `refactor-lantern-config-loader`: `config_loader` where the repository's concise noun is
  `config`.
- `scaffold-task-priority-contract` (both arms): dropped the word *task* from the domain
  subject "task priority".
- `refactor-schema-task-view`: task says *"in the offline schema contract … without changing
  the table"*; the model changed the schema snapshot instead of the contract artefact.

The instruction policy has class rules for `scaffold` and `security_review` only. **`refactor`
and `repair` have none.** Six of the eight misses are in classes with no class guidance, and
the scaffold miss that has guidance ignored it.

## The four unparseable routed outputs

- `scaffold-parser-cli`: a complete, plausible answer inside a code fence.
- `scaffold-greeting-command`: 12,510 characters beginning *"I'll analyze the repository…"*,
  3,082 output tokens, `finishReason: stop`, ending *"Let me write the final JSON."* — and
  no JSON. With `think` suppressed, the model reasoned in the content channel instead and
  ran out of intent before the answer. **`think: false` does not stop reasoning; for this
  prompt it relocated it.** ADR 0070 could not have seen this; it needs recording there.
- `scaffold-lantern-json-output`: 112 output tokens, zero content characters — the open
  anomaly from the evaluation, unchanged.
- `refactor-parser-token-table`: a JSON error the contract reports only as *"must be strict
  JSON"*. The harness's CLI path already classifies non-strict shapes; the benchmark contract
  does not, so the record cannot say what was wrong.

## What this rules in and out

- **Not context starvation, in the narrow sense already recorded**: no query match was
  excluded by a retrieval ceiling in any case.
- **Not capability, for six of the ten zero-class cases**: the model produced parseable,
  structurally valid candidates and lost on target selection — a convention question the
  policy can address without naming any answer.
- **Capability or judgment, for the six executed failures**: five read-only cases whose
  answer the evaluator rejected and one repair whose check failed. Those are out of scope
  for a policy change and are the next diagnosis.

## Proposed change

Instruction-policy revision 10 ([ADR 0071](../adr/0071-gate2-instruction-policy-r10-target-conventions.md)):
class rules for `refactor` and `repair` stated as repository conventions; the general
"do not rewrite checks" rule narrowed to checks unrelated to the task; a naming rule that
keeps every word of the task's domain subject; and an output-boundary rule — the response
is the JSON object alone, first byte `{`, last byte `}`, no fence, no prose, reasoning kept
out of the answer. Leak-freedom is enforced by the existing test that forbids path-shaped
fragments in the instructions.

Its results will be a **new measurement**, not a before-and-after against revision 9, for
the same reason revision 9 was not one against revision 8.
