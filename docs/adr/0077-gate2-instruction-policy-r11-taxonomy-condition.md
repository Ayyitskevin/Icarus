# ADR 0077: Gate 2 instruction policy revision 11 — a finding needs the taxonomy's condition, not an attacker

- Status: **Accepted** 2026-09-03 (lead, under the standing day-2 delegation)
- Date: 2026-09-03
- Related: [ADR 0071](0071-gate2-instruction-policy-r10-target-conventions.md) (revision 10,
  whose text this changes by one clause), [ADR 0076](0076-gate2-manifest-v4-stated-contracts.md)
  (the manifest read that found this), the Opus seat's brief
  `2026-09-03_gate2-v3-eleven-failures-brief-opus.md` (fleet handoffs)

## Context

Under manifest v3 the routed arm returned no finding for `security-config-trust`
(`allowNoFinding: false`, expected `unvalidated-config-shape`). The bytes satisfy the taxonomy
entry as written — `src/main.py` indexes a configuration field with no presence or type check
and passes it into an f-string — and the model's own summary says so, then concludes "no
taxonomy finding applies" because "no external trust boundary is demonstrated". Two phrasings
pull that way: the task's "only concrete trust-boundary risks supported by the repository" and
revision 10's security-review rule, "Report a taxonomy finding only when supplied source bytes
demonstrate its **exploit condition**". "Exploit condition" reads as "a working attack" rather
than "the condition the taxonomy entry states".

The Opus seat's cold read of all seven plan and read-only failures found this the only case
where a rule's wording, not capability, is arguably in play, and recommended the policy edit
over a task successor: it fixes the same ambiguity for every read-only case at once and creates
no new case identity.

## Decision

Instruction policy **revision 11**. One clause changes, in the second security-review rule:

> Report a taxonomy finding only when supplied source bytes demonstrate the condition the
> taxonomy entry states; a demonstrated attacker path is not required. Otherwise return
> source-backed no-finding evidence.

Everything else in the policy is byte-identical to revision 10. Digest
`116168c9…` → `434340b13c43488aa5f2797f9da03e7b19cd76817146571508f591f26f1ac532`. The leak
guard passes against the current manifest's stems with the new clause; the words added
("condition", "taxonomy", "entry", "states", "demonstrated", "attacker", "path", "required")
are no expected path's stem and no finding id.

## Outcome (2026-09-03)

Same run ([record](../evals/2026-09-03-gate2-v4-r11-reference-run.md)): the
`security-config-trust` record returns `unvalidated-config-shape`, with a summary naming the
unvalidated audience field, and still misses on citations (`src/main.py` alone against
`config/app.json` + `src/main.py`). For the history: the revision-7 record also returned that
finding; the revision-9 and revision-10 records (four sets) did not. Whether this clause is why
is the hypothesis it was written on, not a result this unpaired run proves — three instruments
moved at once. One unchanged case,
`repair-cart-empty-list`, fenced its output under the revision-11 prompt after passing under
revision 10; recorded, not attributed. Routed 21/30 at 0.8333; a new measurement.

## Consequences

- A new instrument: figures under revision 11 are a new measurement, never a delta against
  revision 10's 19/30 (under v3). The first run under revision 11 is also the first under
  manifest v4 and the first written by evidence record revision 7 (#107, the writer that now
  records check output), so three instruments move at once; the freezer's schema is unchanged
  (`icarus.gate2-frozen-evidence.v2`). The record says so.
- The task-side phrasing is unchanged by design: `security-config-trust`'s task still asks for
  "only concrete trust-boundary risks supported by the repository" (ADR 0076 declined to
  change it). If the case returns no-finding again under revision 11, that phrasing is the
  next thing to read, and the lever would be a task successor, not another policy clause.
- The change is deliberately narrow. It does not lower the bar for a finding — the bytes must
  still demonstrate the taxonomy entry's condition — it removes a stricter reading the rule
  never intended.
- ADR 0071's authoring rule still holds: this clause holds for every read-only case, not one.
