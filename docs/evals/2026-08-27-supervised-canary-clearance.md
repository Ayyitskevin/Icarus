# Supervised canary secret-scanner clearance

Date: 2026-08-27

## Question

Can Icarus admit non-secret workflow controls and host-resolved secret references
without weakening the full-tree credential audit that runs before persistence,
model egress, private Git copies, or worktrees?

## Assumption under test

The exact scalars `true`, `false`, `read`, and `write` do not contain credential
bytes. A closed GitHub expression that names one value beneath `env`, `github`,
`inputs`, `secrets`, or `vars` is a reference, not the referenced value. The
configuration owner remains responsible for deciding whether a safe scalar is
allowed; the CI and inherited OpenCode workflow policies therefore still reject
checkout with persisted credentials.

## Measurement

The production scanner was compiled at baseline
`2f1b6db101d1cf22e0fa9c42ef719281021d4366` and again with this candidate. It
was exercised against 20 cases: the three tracked workflows, six additional
non-secret control/reference forms, one existing placeholder, and ten synthetic
credential forms covering assignment literals, bearer authorization, AWS,
GitHub and OpenAI token shapes, a private key, a credentialed URL, and JSON.
Only case labels and boolean classifications were emitted; synthetic credential
values were not written to this report.

| Build | Correct | Incorrect | Result |
| --- | ---: | ---: | --- |
| baseline | 11/20 | 9 false positives | hold reproduced |
| candidate | 20/20 | 0 | measurement passed |

The nine baseline false positives were the three tracked workflows plus the
boolean/control/reference cases. The candidate retained detection for all ten
synthetic credential-bearing cases.

## Self-hosting limit discovered

A separate full-tree pass over the candidate found 184 secret-shaped spans in
68 of 408 tracked files. These include the scanner implementation, adversarial
tests, security ADRs, and deliberate redaction fixtures. The production audit
correctly stops at the first finding and has no test- or documentation-path
exception, so Icarus cannot currently be the active-repository canary target
without a separate self-hosting policy decision.

This patch clears the verified workflow-control false positives only. It does
not bypass those remaining findings, weaken the full-tree rule, or claim that
the Icarus repository itself can pass context preparation. The supervised
canary remains held until the operator selects a different active repository or
separately approves a designed self-hosting boundary.

## Executable evidence

The focused security tests read the real tracked workflows, exercise each new
safe form, prove that a credential literal and an inline GitHub expression
literal remain denied, and retain independent CI/OpenCode policy assertions
that reject `persist-credentials: true`:

```text
pnpm build:node
pnpm exec vitest run tests/security/policy-boundaries.test.ts tests/security/ci-workflow-policy.test.ts
```

The complete release gate and production dependency audit remain required before
review. Passing this measurement clears only the scanner defect; it does not
authorize a provider call, source mutation, GitHub effect, deployment, unattended
execution, or the supervised canary itself.
