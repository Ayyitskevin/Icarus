# Gate 1 approval CLI real-process measurement — 2026-08-23

## Scope

This measures the file-only approval surface introduced by ADR 0054. It does not contact GitHub, a model provider, or a live repository and therefore does not measure the still-unimplemented remote executor. Each case launches the compiled CLI in a separate Node process and asserts that no `ICARUS_HOME` runtime state is created.

## Assumptions checked

- Approval can bind the committed manifest even when a collaborative checkout stores it as mode `0664`; the owner-only draft pins its SHA-256 and a changing read is refused.
- Approval records authorize the four named effects but do not themselves execute an effect or mint session authority.
- Digest/approval tampering, repository retargeting, unsafe authority files, missing inputs, and irrelevant options fail closed.
- CLI presentation is sufficient when it produces and verifies the same canonical digest-bound record.

Research basis: GitHub documents object upload, reference creation, and draft pull-request creation as distinct operations and recommends serial mutative requests. in-toto, SLSA, and Sigstore bind attestations to exact artifact digests. Links and the resulting decision are recorded in [ADR 0054](../adr/0054-gate1-effect-approval-and-recovery-semantics.md).

## Command

```sh
pnpm build:node && node scripts/gate1-live-evidence-approval-measurement.mjs
```

Observed on 2026-08-23: **18/18 passed**.

| # | Real process case | Expected | Observed |
| --- | --- | --- | --- |
| 1 | Valid draft digest | success, no runtime state | pass |
| 2 | Approval against committed collaborative manifest | canonical approved record | pass |
| 3 | Inspect approved profile | `executionAuthority: none` | pass |
| 4 | Verify approved profile | verified | pass |
| 5 | Digest receives already-approved record | refuse unknown approval field | pass |
| 6 | Approval receives changed manifest | refuse digest mismatch | pass |
| 7 | Approval receives added effect | refuse non-closed effect set | pass |
| 8 | Approval receives repository swap | refuse manifest identity mismatch | pass |
| 9 | Approval receives blank actor | refuse actor | pass |
| 10 | Verify receives post-approval budget edit | refuse approval mismatch | pass |
| 11 | Verify receives unapproved draft | refuse missing approval | pass |
| 12 | Digest receives symlink | refuse safe open | pass |
| 13 | Digest receives group-writable authority file | refuse permissions | pass |
| 14 | Approval receives missing manifest | refuse safe open | pass |
| 15 | Inspect receives irrelevant actor option | refuse unknown option | pass |
| 16 | Verify receives changed manifest | refuse digest mismatch | pass |
| 17 | Digest receives input above 2 MiB | refuse size ceiling | pass |
| 18 | Digest receives irrelevant manifest option | refuse unknown option | pass |

## Result

The approval surface behaves as designed across success, tamper, path-safety, argument, and manifest-binding cases. This is evidence for merging the approval surface only. It is not evidence that the remote landing executor, process-restart recovery, repository assessments, credentials, or Gate 1 3/3 live run are complete.
