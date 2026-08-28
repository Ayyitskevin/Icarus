# Headless profile validation normalization

## Bug

Two in-memory host inputs escaped the H1 contract: an own
`worker.mutation: undefined` changed the canonical profile digest relative to
the absent default, and malformed `approvedPlan.targets` reached child
resolution as a raw `TypeError` instead of `INVALID_HEADLESS_PROFILE_HOST`.

## Root cause

`decodeWorker` distinguished presence from value while decoding the optional
mutation member, then used presence again when constructing canonical output.
That retained an own undefined property in the object passed to digesting. The
canonical output now omits the member when its decoded value is undefined at
`packages/core/src/headless-profile.ts:309`.

Host-plan preflight validated the iteration ceiling and grants but not the
`targets` collection later consumed by child subset checks. It now requires a
string array before resolution continues at
`packages/core/src/headless-profile.ts:415`.

## Feedback loops

The minimized public-seam reproducers are:

```text
pnpm exec vitest run tests/unit/headless-profile.test.ts
pnpm exec vitest run tests/security/headless-profile-contract.test.ts
```

Before the fixes, the first command reported different profile digests for
absent and own-undefined mutation input. The second reported `UNKNOWN` from the
test's error classifier because a raw exception escaped.

## Fix

Canonical worker decoding spreads `mutation` only for a defined decoded value.
Approved-plan validation rejects a non-array or non-string target collection
with the module's coded host error before any authority comparison. ADR 0046,
the roadmap, and the harness comparison now point to the later child, mutation,
and Vulcan extensions without changing the selection-not-authority boundary.

## Regression tests

- `tests/unit/headless-profile.test.ts` proves absent and own-undefined mutation
  inputs decode and digest identically.
- `tests/security/headless-profile-contract.test.ts` proves malformed host-plan
  targets fail with `INVALID_HEADLESS_PROFILE_HOST` through the exported
  resolver.
