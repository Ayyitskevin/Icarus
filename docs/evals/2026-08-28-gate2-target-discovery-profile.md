# Gate 2 target-discovery profile — 2026-08-28

## Result

Gate 2 remains open. The new routed run substantially improved target discovery
and exact read-only evidence, including the two priority classes, but it still
missed both absolute quality gates.

| Measure | Fixed `code-fast` | Routed `code` | Gate |
| --- | ---: | ---: | ---: |
| Successful tasks | 5/30 | 16/30 | at least 24/30 |
| First-pass plan acceptance | 0.2667 | 0.7667 | at least 0.80 |
| Macro retrieval recall | 0.9917 | 0.9917 | at least 0.90 |
| Macro retrieval precision | 0.8083 | 0.8083 | at least 0.60 |
| Digest provenance | 1.0000 | 1.0000 | 1.00 |
| Incorrect edits | 0 | 0 | 0 |
| Median estimated proxy cost/success | 0.002821 | 0.0012575535 | at least 30% lower without success loss |

The paired success ratio is 3.2 and estimated proxy-cost reduction is
0.554217121588. The comparison nevertheless reports
`gate2-routing-comparison-failed` because neither result passes the absolute
24/30 success and 0.80 plan-acceptance thresholds.

| Class | Fixed `code-fast` | Routed `code` |
| --- | ---: | ---: |
| Repair | 1/10 | 7/10 |
| Refactor | 1/5 | 4/5 |
| Explanation | 0/5 | 3/5 |
| Security review | 3/5 | 2/5 |
| Scaffold | 0/5 | 0/5 |

Compared with ADR 0066's prior routed measurement, routed successes rose from
9/30 to 16/30 and security review from 0/5 to 2/5, while scaffold remained 0/5.
That is a historical comparison across versioned profiles, not a paired causal
estimate. The fixed baseline repeated the prior 5/30 result; one repetition is
still insufficient stability evidence.

## Profile and boundary

- Manifest SHA-256:
  `0eca6348be7848bac44922bcf426defdbd581af8ef790515e28c231b5fbc69c5`
- Profile digest:
  `03399661d25002304f160f2e4959fe1a0e2be826bb752671e1234c8e34496169`
- Instruction-policy SHA-256:
  `5b299c7c27cd38d3f070d4c673c0234eaf257761d3cc294e49a1fbbbf023270d`
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
provider usage totaled 23,748 input and 91,780 output tokens with aggregate
latency 1,625,035 ms. Routed usage totaled 23,748 input and 38,366 output tokens
with aggregate latency 1,960,823 ms. All requests completed without provider
failure. The rates are artifact-size-derived relative local compute proxies,
not billed USD; `actualBilledUsd` is null throughout.

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
  `ab9a0364258ed0e021e19bbdfeed56af42ea4dbe000ac9efae648505c9dd1d06`
- Files digest SHA-256:
  `92411a6a6fd1b32789d99ce4428d072fc504e65b4c0579d61c639e056450f118`
- Preflight SHA-256:
  `c5e929dd91e354644850033da661432dcebba7942f212ad9e86686ae4b686e18`
- Baseline-result SHA-256:
  `0785ae445f412878c6752f538e0007eb4e9540fe84f72c0d5a1a13826a90343d`
- Routed-result SHA-256:
  `c6bc756e848b14491cb91654d71f17631e27f6f45d0685053a8f1e58fc7f68e7`
- Comparison SHA-256:
  `9dbec0b3c6ba752f5b55e9334b15737ff60504d8d416787b3ac9de981c83d757`

Publication revalidates both v1 and v2 contracts independently, rejects
duplicate JSON members and unknown secret-shaped spans, recomputes both
results and their comparison, and binds every case's route, instruction
policy, raw candidate, evaluator evidence, provider completion, and timeout
accounting. These unkeyed digests prove internal consistency, not runner
authenticity or repeatability across seeds.
