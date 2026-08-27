# Headless stream lifecycle-validation evaluation — 2026-08-27

## Decision and scope

This evaluation covers the ADR 0061 receipt-presentation boundary only. The
stream must reject malformed durable worker and child settlement evidence
before presenting it as a trustworthy receipt. The change adds no execution,
approval, provider, repository mutation, deployment, migration, or live-service
authority. Valid histories must retain byte-identical stream output.

Assumptions made explicit:

- the durable worker lifecycle inspector is the normative worker reader;
- child settlement payload construction and projection share one strict
  decoder so their closed grammar cannot drift independently;
- deterministic malformed-history fixtures are the relevant adversarial data
  set; no external or live-provider input is required; and
- histories rejected by the new reader were never valid under ADRs 0048,
  0058–0060, or the closed settlement schemas.

## Test-first reproduction

Before the implementation, a worker settlement using an unknown schema,
unknown outcome, and arbitrary integer exit code projected successfully instead
of throwing `INVALID_HEADLESS_STREAM`. After adding the worker regression but
before wiring the lifecycle inspector, the focused test failed. The equivalent
unknown-schema child regression also failed before the strict child decoder was
wired into receipt projection.

## Thirty-eight-case receipt measurement

Command:

```text
pnpm exec vitest run tests/unit/headless-stream.test.ts \
  tests/unit/headless-children.test.ts --reporter=dot
```

Observed after the review remediation: **2 files passed; 57/57 tests passed.**
The receipt-specific corpus contains one canonical worker control plus
canonical spawned, unspawned-failure, proposal-resting, and
proposal-application child controls, and 33
malformed histories:

- worker schema, outcome, exit pairing, run identity, binding identity, exact
  members, duplicate settlement, settlement-before-start, and missing-start;
- child schema, parent identity, child ID, canonical UUID child-run identity,
  worker-start declaration, outcome, exit pairing, binding digest, error shape,
  exact members, propose-only outcome, contradictory spawned/review-ready
  evidence, spawned failure without an error, missing parent-worker start,
  duplicate child/run identity,
  settlement after a terminal parent epoch, successful-parent settlement with
  missing declared-child evidence, and unsupported child-bearing resume
  evidence both before and after a child settles.

The remaining 19 focused tests exercise adjacent child contracts and existing
stream invariants. All fixtures are deterministic, in-memory projections with
no provider, network, filesystem mutation, or live service.

Valid worker-stream compatibility is pinned against the base implementation at
`ad7833385becb73fd3343206a8dd8abf138ec3b9`: an isolated baseline worktree
produced SHA-256
`2742a4bb83924aaa9e05289ea3225eb5b2c6ccd97383ff854abee2a3da5bc11b`
over the complete canonical stream, and the candidate regression requires that
same digest. The existing repeat comparison separately proves determinism.

## Result and remaining gate

Focused local evidence: **PASS**. Production and test typechecks also pass:

```text
pnpm typecheck:node
pnpm typecheck:tests
```

Fresh full-gate command:

```text
pnpm check
```

Observed: workflow validation, formatting, lint, and all typechecks passed; 85
unit/provider files with 1,224 tests passed; 24 integration files with 202 tests
passed; 7 supported offline evaluations passed, 0 failed, and 3 live-evidence
cases remained explicitly not run; 16 security files with 235 tests passed;
production builds completed.

Independent specification and standards reviews of the exact candidate
snapshot returned PASS with no blocker, high, or medium finding after every
hold was reproduced and closed with a permanent regression. Hosted CI on the
published commit remains required before merge. Icarus remains supervised-use
only; this evaluation does not authorize deployment or live execution.
