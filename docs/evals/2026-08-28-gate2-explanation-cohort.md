# Gate 2 deterministic explanation cohort — 2026-08-28

## Question

Can Icarus execute the five explanation cases already pinned in the 30-task
Gate 2 manifest through its production read-only retrieval and structured-output
adapter, retain exact evidence, and preserve a zero-mutation boundary?

This measurement answers contract integration only. Frozen loopback responses
cannot establish live-model semantic quality, routing improvement, or the Gate 2
exit gate.

## Contract

- Manifest: `fixtures/evals/gate2/manifest.v1.json`
- Manifest SHA-256:
  `43159d8a174312e7fd720fbb625173601e7c90f6e5983c62c206b69ce99c9558`
- Cohort: the five cases whose class is `explanation`, in manifest order
- Command: `pnpm benchmark:gate2:explanation`
- Retained local report: `.local/gate2-explanation-cohort-report.json`
- Provider path: production Ollama structured adapter to a bounded loopback
  fixture server, with zero configured token rates

Before the final measurement, the first executable sweep exposed two genuine
retrieval failures: verification vocabulary selected a README instead of the
registered check, and high-scoring refactor documentation displaced a source
module. The retriever correction normalizes test/check terms, gives exact path
matches stronger weight, and follows one deterministic source-reference hop
from query-matched files. The evaluator never supplies expected paths as input.

## Result

| Measure | Observed |
| --- | ---: |
| Manifest cases | 30 |
| Explanation cohort cases | 5 |
| Executed / passed | 5 / 5 |
| Unexecuted | 25 |
| Exact-context recall | 1.0 in 5 / 5 |
| Exact-context precision | 1.0 in 5 / 5 |
| Digest provenance coverage | 1.0 in 5 / 5 |
| Production-adapter provider calls | 5 |
| Provider-reported input / output tokens | 576 / 360 |
| Estimated / actual billed cost | $0 / not available |
| Source checkout unchanged | 5 / 5 |
| Temporary Git workspace unchanged after retrieval/explanation | 5 / 5 |
| External network / remote mutation / source mutation | 0 / 0 / 0 |
| Repository-code / registered-Icarus-command execution | 0 / 0 |

The five scenario evaluators verify Lantern configuration flow, fixture
guardrails, the offline task schema contract, duplicated name normalization,
and the explicit false-token parser failure. Each response must equal its frozen
oracle and cover every manifest-required citation path with a host-validated,
non-empty, in-range source span.

## Adversarial evidence

Focused contract tests reject widened effects or completion claims; changed
counts, shapes, limitations, evaluator IDs, source digests, citations, response
text, token usage, or evidence digests; evaluator rebinding in the manifest;
duplicate JSON object members; inputs above 4 MiB; and nesting beyond the strict
decoder limit. Existing core tests retain secret, binary, linked, excluded,
scan-budget, selected-byte, and no-truncation boundaries. The full repository
gate remains required before shipment.

## Limitations and next decision

- A citation proves a source location, not that prose is entailed by it.
- Evidence digests prove self-consistency, not runner authenticity.
- Temporary Git initialization is local evaluator setup, not repository task
  execution or source mutation.
- The contract-only validator still reports 30 validated and 0 executed because
  it deliberately performs no evaluation; this separate cohort reports 5 and 25.
- Gate 2 still needs live-model explanation measurement, the other 25 scenario
  executions, first-pass plan acceptance, and an exact baseline/routed model
  comparison before any release claim.
