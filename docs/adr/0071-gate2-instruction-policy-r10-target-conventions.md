# ADR 0071: Gate 2 instruction policy revision 10 — target conventions and an output boundary

- Status: **Proposed** — built under the day-2 delegation; lands after independent review
- Date: 2026-09-01
- Related: [ADR 0067](0067-gate2-target-discovery-profile.md) (the leak-free policy pattern
  this follows), [ADR 0070](0070-gate2-rerun-with-reasoning-suppressed.md) (the honest budget
  it runs under), [diagnosis](../diagnoses/2026-09-01-gate2-zero-classes-and-fenced-baseline.md)

## Context

Under revision 9 the routed arm scores 12/30 against an exit threshold of 24/30, and two whole
classes — `refactor` and `scaffold` — score 0/5 in both arms. The diagnosis read all ten of
those cases from the frozen evidence and found they are not one failure:

- **Six** produced parseable, structurally valid candidates and lost on **first-pass target
  selection**: they did not create a module the task implied, edited the implementation when
  the task's deliverable was the check, or named a new artefact reasonably but not as the
  repository would. No check ever ran.
- **Four** were unparseable: a code fence, reasoning written into the content channel until
  the model stopped without an answer, an empty response, and one JSON error.

The instruction policy carried class rules for `scaffold` and `security_review` only.
**`refactor` and `repair` had none.** And one general rule — *"do not … rewrite existing
checks"* — steered the model away from a repair whose proof requires updating the covering
check.

Separately, **27 of the baseline arm's 28 failures are a code fence** around the answer. The
strict-output contract discards those before scoring, on purpose, but the policy said only
"strict JSON" and never stated where the response begins and ends.

## Decision

Instruction-policy revision 10, digest-bound like every revision before it:

1. **Class rules for `refactor`** — an extraction that names a shared module creates it as a
   new file named for the extracted behaviour and lists every caller it replaces as a target;
   moving a responsibility out of an entry point creates a module named with the repository's
   concise noun for it; a projection introduced into an offline contract lives in the contract
   artefact, not the schema snapshot.
2. **Class rules for `repair`** — when the task asks to prove a property the implementation
   already satisfies, the deliverable is the check; when the repair is a behaviour change, the
   check covering that behaviour is part of the target set.
3. **The general check rule narrowed** to checks *unrelated to the task*, with the covering
   check explicitly part of the change when the task's proof depends on it.
4. **Naming**: preserve every word of the task's domain subject, so a two-word subject keeps
   both.
5. **Output boundary**, on every class: the response is the JSON object alone — first
   character `{`, last `}`, no fence, no surrounding prose, no reasoning inside it.
6. **Citation minimality**, on read-only classes: remove every citation the conclusion would
   survive without. Citations are scored by exact set equality, and four of the five
   executed read-only failures returned the correct verdict with one or two surplus
   citations — files the model had read, not files that proved anything. `README.md` is
   expected in one of those cases and surplus in another, so the convention is minimality,
   not a blanket exclusion of documentation.

Every rule is a **convention**, never an answer. For the prose and the identifiers the
model sees, two mechanisms hold that line, and this section claims exactly what they
enforce; for paraphrase and one-case steering, an authoring rule holds it, stated below:

- The security test forbids twelve path-shaped fragments (`src/`, `tests/`, `.py`, …) in
  the assembled instructions of all five classes.
- The same test derives the stem of every expected changed, cited, and context path from
  `fixtures/evals/gate2/manifest.v2.json`, splits each stem on its separators, and refuses
  any policy prose in which those words appear consecutively — however they are separated,
  so `test_json_output`, `test-json-output`, and "test json output" are the same name. The
  prose it scans is every instruction string the policy holds: the common, kind, and class
  rules and the finding-taxonomy definitions. Nothing is cut out of prose and no word is
  exempt; a finding ID written into a rule is scanned as the words it contains. The only
  unscanned text is what the builder owns structurally — the class/kind line, the JSON
  template's keys, and the taxonomy IDs as identifiers — and the test asserts the assembled
  instructions contain nothing beyond those pieces. The two templates are canonical
  constants in the module, and the policy's template strings must equal their
  serialisation byte for byte — no parser sits between them, so no duplicate member,
  whitespace, hidden code point, changed literal, or foreign key can reach the model
  through "Required shape"; the constants themselves match the skeleton, carry only
  placeholder values from a closed set (`path`, `id`, `text`, `complete bytes`, and the two
  answer kinds), are printable ASCII as decoded objects, and satisfy the live candidate
  contract under placeholder authority, so the shape cannot drift from what the scorer
  accepts and cannot carry an answer — a template is a shape, never an answer. Their
  string values are also scanned like identifiers against the stems of the cases whose
  answer kind receives that template. Nine review plants shaped this — a summary value, a
  nested key, `schemaVersion: 2`, an empty mutation file list, mutation authority in the
  read-only template, a duplicate member, a zero-width space inside "money", a line feed
  hidden as a JSON escape, and an expected finding ID in `findingIds` — and all are
  regression tests now.
- Expected **finding IDs** are answers too. Every prose string a read-only class sees —
  the common and read-only rules, the read-only class rules, and every taxonomy
  definition (each against every expected ID except the one it defines) — and the
  read-only template's values are scanned against the read-only cases' expected finding
  IDs as token sequences. The taxonomy line lists every ID for every case and is the
  contract; a rule or a definition naming another case's finding is steering, and is
  refused. The snapshot takes its canonical templates as a parameter so the test proves
  the template validator runs on the snapshot path, not only when called directly.

Revision 10's text was revised during review — "verify" to "confirm", "files" to "paths",
"file list", and "file set" — before any run carried it, so the number names two texts in
the history of this branch and one on `main`. The digest a run records is what binds it;
the number is a label for the conventions, not for the bytes.

Neither mechanism catches a rule that names an answer by paraphrase. That line is held by
authorship, under one rule a future author has to meet: **a class rule must hold for more
than one case, or be recorded here as steering.** Today's record: `repair` rule 1
(prove-or-confirm with a correct implementation) and `refactor` rule 2 (an entry-point move)
each cover exactly one manifest case; `refactor` rule 3 (projection into an offline
contract) maps one-to-one onto `refactor-schema-task-view` but is task-conditioned — the
task says not to change the table, and the repair case that asks to change the snapshot
expects the opposite set. None of the three names a stem. A revision that adds cases should
re-examine them.

## What this does not claim

- It does not make revision 10 comparable to revision 9 as a before-and-after, for the same
  reason revision 9 was not comparable to 8: the instrument changed. Its results are a new
  measurement under a stated policy.
- It does not address the six executed-but-failed routed cases (five read-only judgments
  and one failed repair check). Those are capability or evaluator questions and are the next
  diagnosis, not this one.
- It does not steer `refactor-cart-money-module`, where the task says *"private helper"* and
  the manifest expects a new module. That reading is defensible and the case is flagged for
  manifest review rather than bent toward its answer, which would be a leak.

## Consequences

- The policy SHA moves; every record from a revision-10 run carries it, and published
  revision-8 and revision-9 sets stay pinned by value to the digests that produced them.
- If the output-boundary rule lands, the baseline arm's score becomes a measurement of the
  baseline model rather than of its fencing habit. That may change the routed-vs-baseline
  ratio substantially and should be read as the instrument improving.
- `think: false` remains. The reasoning-in-content case is recorded in ADR 0070 as a
  limitation of suppression; the output-boundary rule is the only mitigation this revision
  attempts.

## Verification

- `tests/security/gate2-live-instruction-policy.test.ts`: the new class rules attach to their
  classes and not others, the boundary rule attaches to every class, the assembled
  instructions of all five classes contain no path-shaped fragment, and the stem and
  identifier scans above hold.
- The measurement itself: a fresh paired run on mickey under the revision-6 evidence writer,
  frozen into `docs/evals/artifacts/` with a per-file manifest, reviewed before its numbers
  are cited anywhere.
