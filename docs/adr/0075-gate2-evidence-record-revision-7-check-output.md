# ADR 0075: Gate 2 evidence record revision 7 — a check's output is a recorded field

- Status: **Accepted** 2026-09-03 (lead, under the standing day-2 delegation)
- Date: 2026-09-03
- Related: [ADR 0068](0068-gate2-evidence-loss-is-one-defect-class.md) (evidence loss is one
  defect class), [ADR 0070](0070-gate2-rerun-with-reasoning-suppressed.md) (revision 6, the
  closed shape this extends), [diagnosis](../diagnoses/2026-09-03-gate2-v3-lead-lane-four-failures.md)

## Context

Under manifest v3 two routed cases failed their registered check. The revision-6 record
carries, per check, `argv, checkId, exitCode, signal, stdoutSha256, stderrSha256, truncated,
outcome` — the digests of the output and not the output. The sandbox returns the text,
bounded by the ceiling's `maxCommandOutputBytes`; the runner digested it and dropped it
(`summarizeChecks`). So "why did this check fail" was a claim with no recorded field, and
reading two of thirty cases meant materialising the frozen candidate files and replaying the
check in the pinned image. One of those two turned out to be a benchmark defect (an exact
stderr string the task never states); nobody could have seen that from the record.

## Decision

Evidence record **revision 7**: each check entry additionally carries `stdout` and `stderr`
as text, exactly as the sandbox returned them. The digests stay. Three record rules, each
independently violable and each with a one-rule violator in the shape test:

- `check-entries-carry-output-text` — every check the evaluator ran carries both streams as
  strings (revision 6's digest-only entry is exactly what this refuses);
- `check-output-is-digest-bound` — `stdoutSha256 === sha256(stdout)` and likewise for
  stderr, so text and digest cannot drift apart;
- `check-output-within-ceiling` — each stream is at most `DEFAULT_CEILING.maxCommandOutputBytes`
  (256 KiB), the bound the sandbox applies; a record over it was not written by this runner
  under this ceiling.

The freezer's revision map gains `7 → null` (absent thinking stays `null`, as in 6). The
frozen-set `recordContract` keys are unchanged: adding a key would fail every existing
frozen set's manifest re-derivation, and the revision number already carries the meaning.

## Consequences

- Records grow by the checks' output; a passing check is a few bytes, a failing one a
  traceback. The freezer's secret screen covers the new text like any other record string.
- Revision-6 sets are unaffected: the freezer still verifies them under their own contract,
  and the figures script reads no check text.
- The first revision-7 set is the next predeclared run (issue #106 decides its varying
  factor). Its record can say why a check failed without a replay rig.
- What this does not do: it does not evaluate output — the outcome is still the sandbox's
  exit code. It records.
