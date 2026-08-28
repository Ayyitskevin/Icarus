# Gate 2 target-discovery profile — 2026-08-28

## Result

Gate 2 remains open. The new routed run substantially improved target discovery
and exact read-only evidence, including the two priority classes, but it still
missed both absolute quality gates.

| Measure | Fixed `code-fast` | Routed `code` | Gate |
| --- | ---: | ---: | ---: |
| Successful tasks | 2/30 | 17/30 | at least 24/30 |
| First-pass plan acceptance | 0.2333 | 0.7000 | at least 0.80 |
| Macro retrieval recall | 0.9917 | 0.9917 | at least 0.90 |
| Macro retrieval precision | 0.8083 | 0.8083 | at least 0.60 |
| Digest provenance | 1.0000 | 1.0000 | 1.00 |
| Incorrect edits | 0 | 0 | 0 |
| Median estimated proxy cost/success | 0.005260 | 0.00131796 | at least 30% lower without success loss |

The paired success ratio is 8.5 and estimated proxy-cost reduction is
0.749437262357. The comparison nevertheless reports
`gate2-routing-comparison-failed` because neither result passes the absolute
24/30 success and 0.80 plan-acceptance thresholds.

| Class | Fixed `code-fast` | Routed `code` |
| --- | ---: | ---: |
| Repair | 1/10 | 6/10 |
| Refactor | 1/5 | 2/5 |
| Explanation | 0/5 | 4/5 |
| Security review | 0/5 | 3/5 |
| Scaffold | 0/5 | 2/5 |

Compared with ADR 0066's prior routed measurement, routed successes rose from
9/30 to 17/30, security review from 0/5 to 3/5, and scaffold from 0/5 to 2/5.
That is a historical comparison across versioned profiles, not a paired causal
estimate. The fixed baseline regressed from the prior 5/30 to 2/30, which is a
material stability limitation.

## Profile and boundary

- Manifest SHA-256:
  `0eca6348be7848bac44922bcf426defdbd581af8ef790515e28c231b5fbc69c5`
- Profile digest:
  `03399661d25002304f160f2e4959fe1a0e2be826bb752671e1234c8e34496169`
- Instruction-policy SHA-256:
  `d4993a35669f17c3dc26e873b8afb8a5699bb792fbbab6f9d52838275986d39b`
- Routing-policy SHA-256:
  `01c96e8eedc4376cae8aab5fb1c354e9fe84f8fa18ae1a77ed93875724ccd54a`
- `code`: local `qwen3.8:27b`, Ollama digest
  `22130167c4c20e20c7b71454612966ca8e8171e9b3cc8ab6ce8aa6cbfec79643`
- `code-fast`: local `ornith-1.5:35b`, Ollama digest
  `9f3b89b2521908dd2e6f7a11fa368e62c8f89e1075f22604e4d1a76dd1240fcc`

The model received the frozen task, complete repository path inventory,
deterministically retrieved source bytes, and registered check IDs. It did not
receive expected target, citation, finding, or evaluator-answer data. The host
still exact-validated candidate paths and check authority before applying
candidate bytes only in disposable private copies. Registered checks ran only
in the pinned no-network Docker sandbox, and every source copy remained
unchanged.

The run used local Vulcan and local Ollama only. Request generation was
deterministic (`temperature: 0`) with an 8192-token output ceiling. Baseline
provider usage totaled 24,273 input and 95,510 output tokens with aggregate
latency 1,690,132 ms. Routed usage totaled 73,509 input and 46,102 output tokens
with aggregate latency 2,193,613 ms. The routed totals include one 300-second
timeout recorded as a failed observation using the declared 50,000-input and
8192-output token bounds. The rates are artifact-size-derived relative local
compute proxies, not billed USD; `actualBilledUsd` is null throughout.

No active repository, remote Git state, network destination outside numeric
loopback, live database, canary, merge, deployment, migration, or unattended
execution was authorized.

## Retained evidence

The committed artifact contains 65 files: 60 case records, preflight, two
strict results, comparison, and artifact manifest. The manifest binds the 64
source evidence files and both policy digests.

- Artifact directory:
  [`artifacts/gate2-local-vulcan-target-discovery-r7-20260828`](artifacts/gate2-local-vulcan-target-discovery-r7-20260828)
- Artifact-manifest SHA-256:
  `2bba8e40812c77459804d2bc2e24f45c8e7588f4945a1bf7ad74ab082b1c772c`
- Files digest SHA-256:
  `c519542cb0896014c2ac3ff42a70cdf9e68e76a9b010dec409628a655018ddfb`
- Preflight SHA-256:
  `c7cdf6193021ae5598c68128b2e2f89dfa9252c5c542237a62569839aea5a01c`
- Baseline-result SHA-256:
  `da49e4c49ac113ffefe62741e31ef71969502fc6873e1b318a959a986517839f`
- Routed-result SHA-256:
  `7c922f8b0d151e843b983d2cf22bfd002061a528ea48121c71a2b10dbc17a4fb`
- Comparison SHA-256:
  `3053655e25dd511db0495b2b37c6ef67e1f098cd19366f855627f91a8bd19ee4`

Publication revalidates both v1 and v2 contracts independently, rejects
duplicate JSON members and unknown secret-shaped spans, recomputes both
results and their comparison, and binds every case's route, instruction
policy, raw candidate, evaluator evidence, provider completion, and timeout
accounting. These unkeyed digests prove internal consistency, not runner
authenticity or repeatability across seeds.
