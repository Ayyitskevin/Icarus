# Gate 2 under manifest v3: the four routed failures that were not plan rejections (2026-09-03)

Read from the frozen bytes of `docs/evals/artifacts/gate2-r10v3-run1-20260902` (run 2 is
byte-identical for all four). Two of the four could not be read from the bytes alone: the
record freezes a check's exit code and the SHA-256 of its stdout and stderr, not the text, so
the failure reason was recovered by replaying the frozen candidate files against the fixture
in the pinned `python:3.12-slim` image on flow (`docker run --rm --network none`, tree
materialised from `candidate.answer.files`). That gap is a finding in its own right (below).

| case | bucket | verdict | evidence | lever |
| --- | --- | --- | --- | --- |
| `repair-lantern-missing-config` | executed and failed | **benchmark defect** — hidden oracle string | the check (`gate2-repair-cohort-a-contract.mjs:172`) demands stderr exactly `Lantern configuration is unavailable.\n`, exit 1, empty stdout; the task says only "Return a bounded configuration error … instead of exposing a raw filesystem exception"; the string appears nowhere the model sees (task, fixture `unfamiliar`, retrieved `config/app.json`, `README.md`, `src/greeting.py`, `src/main.py`). The candidate returned exit 1 with `Lantern configuration is missing: config/app.json` on stderr — the task as written, satisfied. Replay: `AssertionError` on the stderr equality. | manifest v4 successor whose task states the contract (exact message, exit 1, empty stdout); the check stays |
| `scaffold-parser-cli-check` | executed and failed | **model miss** | the model's own `checks/test_cli.py` runs `python src/cli.py true` (a script path, so `from src.parser import …` fails) and asserts exit 0; its `src/cli.py` delegates to the fixture's deliberately broken `parse_enabled` (`bool(value)` — the `failing` README says the false case fails) with no validation, so `true`, `false`, and `maybe` all exit 0 under `-m`. Replay: `AssertionError` at `test_cli.py:8`. The plan was exactly the expected set; the case measures the implementation, as ADR 0073 intended. | none for the benchmark; capability |
| `repair-public-path-containment` | unparseable | **model miss** — output boundary | markdown fence around otherwise well-formed JSON (`candidateError: … (markdown_fenced)`), 1 of 30 under revision 10's boundary rule; 902 bytes, `finishReason: stop` | none; the fenced rate under r10 is 1/30 routed, 20/30 baseline |
| `scaffold-greeting-command` | unparseable (contract refusal) | **model miss**, with one harness note | refused for `selectedContextPaths` containing `README.md`, which the receipt did not carry (retrieved: `AGENTS.md`, `checks/verify.py`, `src/greeting.txt`); the policy says "Select only retrieved paths you relied on". The plan was wrong regardless: it mutated `src/greeting.txt` to `Hello, Icarus!` "so the registered greeting-command check passes" — rewriting the source of truth the task says to keep, instead of adding the command. Harness note: retrieval dropped `README.md`, which the manifest lists as expected context (the arm's one recall miss, 119/120); the file is not load-bearing here — the one-line rule the task cites is in `AGENTS.md`, which was retrieved. | none for the benchmark; the retrieval miss is a retrieval-quality item, not a policy one; the "rewrite the data to pass the check" shape is worth a security-review eye |

## The evidence gap

`evaluatorEvidence.checks[]` carries `argv, checkId, exitCode, outcome, signal, stderrSha256,
stdoutSha256, truncated`. The sandbox already returns the text, bounded by the ceiling's
`maxCommandOutputBytes`, and the runner digests it and drops it
(`scripts/gate2-live-benchmark.mjs:665-667`). So "why did the check fail" is a claim with no
recorded field, and diagnosing two of thirty cases today needed a replay rig. Under the
campaign's rule — no claim without a recorded field; absence is `null`, never 0 — the check's
stdout and stderr belong in the record. That is evidence record revision 7, proposed
separately; its digests stay so revision-6 readers keep verifying.

## What this changes for the count

Of the eleven routed failures under v3, my four split 1 benchmark defect / 3 model misses.
The three plan rejections and four read-only mismatches are the Opus seat's reading (#104).
Nothing here is a delta claim: a v4 that fixes the lantern task changes that case's identity.
