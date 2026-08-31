# ADR 0069: A file the budget excluded is evidence, not a non-event

- Status: **Proposed**
- Date: 2026-08-31
- Related: [ADR 0068](0068-observed-usage-versus-charged-upper-bounds.md) (same defect
  class, different boundary), [ADR 0067](0067-gate2-target-discovery-profile.md) (the
  retrieval profile this constrains)

## Context

`retrieveReadOnlyContextV1` scans the committed tree, scores every file that matches the
operator's query, ranks them, and then fills a budget: `maxFiles` entries and
`maxTotalBytes` of content. Candidates that do not fit are dropped by `select()` returning
`false`, and the caller continues.

The result recorded `entries`, `totalBytes`, `scannedFiles`, and `scannedBytes`. None of
those distinguishes a file that was never relevant from a file that matched, ranked, and
lost to a ceiling. Files skipped before scoring — non-text, secret-shaped, policy-excluded —
were likewise folded into `scannedFiles` with no indication that anything was excluded at
all.

So a Gate 2 explanation or security-review artifact says the retrieval looked at the
repository and returned these files, and a reader cannot tell whether the repository held
nothing contrary or whether the contrary evidence ranked below the cap.

**That difference is the whole basis of a `no_finding` result.** A security review reporting
no findings is trusted precisely because the retrieval is supposed to have looked. A human
approves a change on that trust. This is the same defect class as
[ADR 0068](0068-observed-usage-versus-charged-upper-bounds.md): evidence that existed was
discarded at a boundary, and the surviving record looked like absence rather than loss.
Here the stakes are higher, because the record is what a person reads before deciding.

## Decision

The result records what it did not return.

- **`omittedMatches`** lists every file that matched at least one query term and was
  excluded by a ceiling, in rank order, each with its path, its size, and the reason —
  `file_ceiling` or `byte_ceiling`. The path is named so a reader can go and look at it.
- **`matchedFiles`** states how many files matched at all, so `entries.length` can be read
  against it rather than in isolation.
- **`excludedFiles`** counts what never became a candidate, split into `byPolicy`,
  `nonText`, and `secretShaped`. These are **counts, not paths**: naming a secret-shaped
  file would disclose a path that failed the secret screen, and the reason a reader needs
  ("something was withheld here, and why") does not require the name.
- An empty `omittedMatches` means nothing was omitted. That is a claim the caller can now
  make, and could not before.

The schema becomes `icarus.context-retrieval.v2`. The result's shape changed, so its
version changes with it — the rule ADR 0068 applied to the H0 and receipt-stream wires.

## Consequences

- The retrieval digest moves. Nothing pins a specific retrieval digest: the manifest at
  `fixtures/evals/gate2/retrieval-manifest.v1.json` supplies inputs, and
  `tests/unit/context-retrieval.test.ts` asserts the digest's shape rather than its value.
- **Frozen Gate 2 evidence is unaffected.** The seven v1 cohort reports under
  `fixtures/evals/gate2/evidence/` embed `retrievalDigestSha256` values, but the adoption
  module validates those reports by their own raw digests rather than re-deriving retrieval
  through this contract. They remain byte-for-byte what they were.
- A result recorded under v1 carries no omission evidence, and that absence means **"not
  recorded"** — never "nothing was omitted". No v1 report is retroactively reinterpretable,
  and this ADR does not backfill; it cannot.
- The artifact integrity checks in `codebase-explanation.ts` and
  `codebase-security-review.ts` now compare against the exported constant instead of a
  hardcoded literal, so the schema string and its validators cannot drift apart again.

## What this does not claim

Recording an omission does not make the selection better. A file that lost to a ceiling is
still absent from the context the model saw, and this ADR does not widen any budget, change
any ranking, or make an excluded file eligible. It only stops the record from implying a
completeness the retrieval never had.

## Verification

- `pnpm exec vitest run tests/unit/context-retrieval.test.ts` — 10 passed, covering a
  file-ceiling omission, a byte-ceiling omission, the pre-score exclusion counts, and the
  empty case where every match fit.
- Mutation probe: deleting the `omittedMatches.push(...)` line fails
  *"records a matched file the file ceiling excluded, with its reason"* and
  *"distinguishes a byte-ceiling exclusion from a file-ceiling one"*, and nothing else.

## Amendment (2026-08-31): the evidence did not reach the reader

The first implementation of this ADR did not achieve what the ADR claims. An
independent audit by the codex seat found four defects in it, all real.

**The omission evidence stopped at the artifact boundary.** `omittedMatches` lived only
on the in-memory retrieval result. Both artifact writers emit `retrievalDigestSha256`
and nothing else, so a human reading a persisted `no_finding` still could not tell
"nothing contrary matched" from "contrary files were excluded by a ceiling" — the exact
distinction the Context section says the whole result rests on.

The Consequences section above even *records* that the artifacts embed only a digest,
and offers it as reassurance that frozen evidence is unaffected. That observation was
correct and its reading was backwards: the same fact is why the fix never reached the
person the fix exists for. Both artifacts now carry a `retrievalCoverage` member —
matched count, selected count, both omission lists, and the exclusion counts — and both
move to `icarus.codebase-explanation.v2` and `icarus.codebase-security-review.v2`,
because a digest over an enlarged artifact is a different artifact.

**A relabelled receipt validated.** The artifact seams checked the schema string and the
old counters, then recomputed a digest over whatever members happened to be present.
Absent members serialize away, so a receipt carrying the new label without the new
evidence recomputed its digest and passed. `retrievalOmissionEvidenceProblem` is now
exported from the retrieval module and called by both writers; it requires the members,
validates every omission path, size, and reason, and refuses a path that is both
selected and omitted, or omitted twice.

**The reference hop lost files and mislabelled others.** Its `maxFiles` break returned
without recording anything, so a file the hop had already discovered vanished with no
trace of having been found. In the other direction, a file reached only by the hop —
which never matched the query — was filed under `omittedMatches`, making the record
assert an observation the retrieval never made. Omissions now carry their source:
`omittedMatches` holds query matches only, `omittedReferences` holds the hop's.

**An omission was classified by whichever traversal reached it first.** `omit()` took the
call site's source and the de-duplication set froze it, so a query match first encountered
while following a reference hop was recorded permanently as reference-only. The coverage
could then say every query match was selected while the only withheld file was incidental
context — a false statement built from true parts. Classification now follows what the file
IS (`matchedTerms` non-empty), not how it was reached, and the shared validator requires
the counts to reconcile exactly against the receipt's own entries rather than merely being
individually plausible.

**Structurally ineligible entries were invisible.** Symlink blobs and submodule gitlinks
were skipped before any counter, so `excludedFiles` could read zero while the tree held
entries the retrieval cannot read. They are counted as `unsupportedEntry`.

The retrieval schema moves to `icarus.context-retrieval.v3`. v2 was not merely smaller
than v3 — it was wrong, because it labelled reference-hop files as query matches and
silently dropped others. A v2 receipt's omission list cannot be read as a v3 one.

## Method note

This ADR shipped claiming to close a defect it did not close, and the review that caught
it completed after the merge. The pattern is worth recording: the author had every fact
needed to see the gap, wrote one of them down, and drew the comfortable conclusion from
it. An independent reader with the same file open drew the other one.
