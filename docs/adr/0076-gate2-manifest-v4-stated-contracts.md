# ADR 0076: Gate 2 manifest v4 — the task states the contract the check demands

- Status: **Accepted** 2026-09-03 (lead, under the standing day-2 delegation)
- Date: 2026-09-03
- Related: [ADR 0073](0073-gate2-manifest-v3-task-entailed-targets.md) (the lineage mechanism
  and the cold-reading rule this reuses), [ADR 0075](0075-gate2-evidence-record-revision-7-check-output.md)
  (the record gap that hid the lantern defect), [lead diagnosis](../diagnoses/2026-09-03-gate2-v3-lead-lane-four-failures.md),
  the Opus seat's brief `2026-09-03_gate2-v3-eleven-failures-brief-opus.md` (fleet handoffs)

## Context

All eleven routed failures under manifest v3 were read cold against the frozen bytes on
2026-09-03 — the three plan rejections and four read-only mismatches by the Opus seat, the
two check failures and two unparseable candidates by the lead. Ten are model misses against
rules revision 10 already states. One is a benchmark defect, and one deferred case (#105)
still carries the shape v3 fixed elsewhere:

| case | what the bytes show |
| --- | --- |
| `repair-lantern-missing-config` | the registered check demands stderr exactly `Lantern configuration is unavailable.`, exit 1, empty stdout; the task says only "Return a bounded configuration error … instead of exposing a raw filesystem exception"; the string appears nowhere the model sees. The candidate did what the task says and failed the check. |
| `scaffold-greeting-command` | expects `tests/test_greet.py` in a fixture that has only `checks/`, from a task that names no path — the `scaffold-parser-cli` shape v3 fixed; deferred by ADR 0073 because the case had never parsed. |
| `explain-schema-contract` | model miss (one surplus citation), but the task's "repository documentation" has two referents in the retrieved set (`README.md`, `migrations/README.md`) while the expected set holds one. The Opus seat's optional tightening names the artifact. |

## Decision

`fixtures/evals/gate2/manifest.v4.json` supersedes v3 through the lineage registry: binds v3's
digest `e1411ab9…`, keeps 27 cases byte-identical, replaces three.

| predecessor | successor | what the new task says | expected set |
| --- | --- | --- | --- |
| `repair-lantern-missing-config` | `repair-lantern-config-contract` | exit 1, nothing on stdout, exactly the line `Lantern configuration is unavailable.` on stderr; present-config behaviour unchanged | `src/main.py` (unchanged) |
| `scaffold-greeting-command` | `scaffold-greeting-command-check` | a command named `greet` reading the greeting file; its check "beside the existing check as `checks/test_greet.py`" — stated, because `basic`'s only check is `checks/verify.py` and no `test_` exemplar exists to infer from | `checks/test_greet.py`, `src/greet.py` |
| `explain-schema-contract` | `explain-task-schema-contract` | cite "the schema snapshot, the contract query, and the repository's top-level README" | citations unchanged |

The sharpening is in the tasks, never the policy: revision 10's digest `116168c9…` is unchanged
and the leak guard scans v4's stems (no stem v3 lacked — `test_greet` already existed).
Mechanism as ADR 0073: registered lineage entry, pinned digest `GATE2_V4_MANIFEST_SHA256`,
`GATE2_CURRENT_MANIFEST_PATH` → v4, `GATE2_MANIFEST_PATHS_BY_SHA256` and
`GATE2_MANIFEST_SHA256_BY_REVISION` extended, two successor oracles derived from the entries
they replace (`scripts/gate2-v4-successor-oracles.mjs`; the greeting check relocates and its
argv follows), the read-only successor needs none.

Not taken, on the Opus seat's reading: `security-config-trust`'s ambiguity is in the policy's
"exploit condition" wording, not the task; that is instruction-policy revision 11 (its own ADR),
which fixes every read-only case at once and creates no new case identity.
`security-schema-migration`'s expected citation set is defensibly narrow (`migrations/README.md`
is expected context but not an expected citation); no candidate has cited it, so it is noted,
not changed.

## Consequences

- Figures under v4 are a new measurement; three cases changed identity. Never a delta against
  19/30.
- The ten model misses remain the model's; v4 does not touch them.
- With v4, every scaffold expectation follows its fixture's check-directory convention
  (`checks/` everywhere the fixture has one; `tests/` only where it has neither).
