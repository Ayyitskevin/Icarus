# Gate 2 live-model comparison — 2026-08-28

## Result

Gate 2 remains open. The routed policy beat the fixed baseline on successful
tasks and estimated local-compute proxy cost per success, but both runs missed
the predeclared absolute quality thresholds.

| Measure | Fixed `code-fast` | Routed `code` + security override | Gate |
| --- | ---: | ---: | ---: |
| Successful tasks | 5/30 | 9/30 | at least 24/30 |
| First-pass plan acceptance | 0.4000 | 0.6667 | at least 0.80 |
| Macro retrieval recall | 0.9917 | 0.9917 | at least 0.90 |
| Macro retrieval precision | 0.8083 | 0.8083 | at least 0.60 |
| Digest provenance | 1.0000 | 1.0000 | 1.00 |
| Incorrect edits | 0 | 0 | 0 |
| Median estimated proxy cost/success | 0.002382 | 0.0015007485 | at least 30% lower without success loss |

The routed success ratio is 1.8 and its estimated proxy cost reduction is
0.369962846348. The paired comparison still reports
`gate2-routing-comparison-failed` because neither input result passes its own
absolute quality thresholds.

Class successes were baseline/routed: repair 4/6, refactor 1/2, explanation
0/1, security review 0/0, and scaffold 0/0. Baseline failures comprised 14
structurally invalid candidates, four rejected first plans, seven evaluator
failures, and five passes; two candidates ended at the provider output ceiling.
Routed failures comprised two structurally invalid candidates, eight rejected
first plans, eleven evaluator failures, and nine passes, with no output-ceiling
finish. This points the next slice at autonomous target discovery and smaller,
exact read-only evidence rather than at retrieval recall or weaker thresholds.

## Execution profile and boundary

- Manifest SHA-256:
  `0eca6348be7848bac44922bcf426defdbd581af8ef790515e28c231b5fbc69c5`
- Profile digest:
  `d7dae6a514130a11aee8cbe1e52dbe591440d36df452db4bc75b8f7f1d77e58`
- Routing-policy SHA-256:
  `f4919cde1a36b13850726a7ff72b6a9bbeb64afd1583f0d64dc8804043f0a80d`
- `code`: local `qwen3.8:27b`, Ollama digest
  `22130167c4c20e20c7b71454612966ca8e8171e9b3cc8ab6ce8aa6cbfec79643`
- `code-fast`: local `ornith-1.5:35b`, Ollama digest
  `9f3b89b2521908dd2e6f7a11fa368e62c8f89e1075f22604e4d1a76dd1240fcc`

The run used local Vulcan and local Ollama only. The host preflight bound the
live model catalog, the exact `local-ollama` model mappings, its `ollama`
provider type and credential-free `http://127.0.0.1:11434` base URL, and Ollama
tags before generation.
Models selected context, targets, plans, and answers without manifest-answer
injection. Candidate mutations were accepted only after exact first-plan
target/check matching, applied only to disposable private copies, and evaluated
only through registered checks in the no-network Docker sandbox. Source copies
remained unchanged. No active repository, remote Git state, live database,
deployment, merge, or unattended execution was authorized.

Token totals were 30,560 input / 91,734 output for the baseline and 30,560 input
/ 42,509 output for the routed run. Recorded aggregate latency was 1,749,926 ms
and 1,912,334 ms respectively. The profile rates are an artifact-size-derived
relative local-compute proxy, not actual billing or energy measurement;
`actualBilledUsd` is null for every observation.

## Retained evidence

The committed artifact directory contains 65 files: 60 case records, preflight,
two strict results, the comparison, and their artifact manifest. The manifest
binds 64 source files and was reverified after publication.

- Artifact directory:
  [`artifacts/gate2-local-vulcan-code-routing-20260828`](artifacts/gate2-local-vulcan-code-routing-20260828)
- Artifact-manifest SHA-256:
  `0404f2e61063329ebe32a4f3eeacbae387c55533f7368c54f40e6199970102eb`
- Baseline-result SHA-256:
  `29eac825ad333c204e5197a83a0996620a7575f37e85b687ccf4ff29d5ad9a3a`
- Routed-result SHA-256:
  `a34671a3d715ee19966513d612a9444710d210ae3e5327e7f3b292b11d062adb`
- Comparison SHA-256:
  `08b262a1f42bb23245c7fef4769fab3416afbf4b93a0216e256e49973760f464`
- Preflight SHA-256:
  `0c71c13dad3158ce9084234d87b6134e463ea70a40fa677aac0a8c5cc368255d`

The publisher rejects duplicate JSON members and unknown secret-shaped spans,
requires provider-length finishes to remain failed, and recomputes result and
comparison contracts, per-case evaluator digests, selected models against the
bound routing policy, and the complete artifact file manifest. These unkeyed
digests establish self-consistency and reviewable provenance; they do not
authenticate the runner or turn this one seed/run into general model quality.
