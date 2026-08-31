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
