# Headless Vulcan admission measurement — 2026-08-27

## Question

Can Icarus admit a loopback Vulcan alias to bounded headless proposal generation
without making its per-run cost ceiling aspirational or allowing the proposal to
reach the later apply act?

## Assumptions tested

1. Vulcan's loopback endpoint can route both local and hosted aliases, so
   loopback locality alone is not a cost classification.
2. The gateway's fixed `icarus` seat gives Vulcan an independent fail-closed
   daily budget boundary for hosted requests.
3. Explicit positive input/output rates let the existing Icarus reservation and
   settlement path enforce a conservative per-run dollar ceiling.
4. Initial proposal mode must be paired with a service-level apply refusal.

## Live read-only observations

No generation request was made. Read-only calls to the running loopback Vulcan
service observed:

- `/healthz`: healthy v1 service with 17 configured aliases;
- `/v1/models`: 11 local Ollama routes, 6 hosted routes, and 14 chat aliases;
- `/v1/models/code`: available local Ollama chat route;
- `/v1/models/glm`: configured hosted OpenAI-compatible chat route; and
- `/v1/usage`: durable ledger scope with zero skipped lines and zero write
  failures.

These observations disprove the unsafe assumption that every loopback Vulcan
alias can truthfully use a zero-dollar Icarus ceiling. They establish current
service shape only, not permission to invoke a model.

## TDD red evidence

Before implementation, the resolver case failed with
`INVALID_HEADLESS_PROFILE_HOST` because Vulcan was deliberately excluded. After
the resolver admitted the bounded proposal, the service regression failed
because `applyHeadlessProposal` actually applied the Vulcan-generated patch and
returned `icarus.headless.worker-application.v1`. The final service-level guard
was therefore required by an observed reachable path.

## Compiled production matrix

`pnpm build:node` compiled the production resolver. A separate Node process
then exercised 20 realistic host/profile combinations through the exported
`resolveHeadlessProfileV1` interface:

| Class | Cases | Expected result | Observed |
| --- | ---: | --- | --- |
| Loopback forms | IPv4, localhost, IPv6, 127/8, HTTPS loopback | admit | 5/5 |
| Conservative pricing | higher explicit rates | admit | 1/1 |
| Unsafe URL data | remote host, credentials, query, fragment | refuse | 4/4 |
| Unbounded pricing | missing input/output, zero input/output, negative, non-finite | refuse | 6/6 |
| Widened worker policy | apply mode, child-capable policy | refuse | 2/2 |
| Catalog integrity | unknown kind, duplicate ID | refuse | 2/2 |

Result: **20/20 matched the declared outcome**. Accepted resolutions carried
`icarus.headless.vulcan-admission.v1` with seat `icarus`, proposal-only mutation,
and denied children.

## Focused executable evidence

```text
pnpm exec vitest run tests/unit/headless-profile.test.ts \
  tests/provider/vulcan-chat-completions-gateway.test.ts \
  tests/integration/headless-worker.test.ts \
  tests/security/headless-worker-contract.test.ts --reporter=dot
```

The focused run passed 54/54 tests. The real Vulcan HTTP adapter test converted
21 input and 9 output tokens at the explicit 3/15 USD-per-million rates to
`0.000198` USD. The integration case produced a durable
Vulcan proposal, refused its exact digest-bound apply attempt with
`HEADLESS_APPLY_DENIED`, made no extra provider call, recorded no apply approval,
and left the run at `running` for inspection.

The complete `pnpm check` release gate then exited zero: workflow validation,
formatting, lint, typechecking, 1,226 unit/provider tests, 203 integration
tests, 7 supported offline evaluations, 236 security tests, static security
assertions, and production builds passed. Three future-milestone evaluations
remained explicitly unsupported. Lint reported only the repository's existing
non-failing warning/info backlog outside this change.

## Limits

This is compiled offline and fake-provider evidence plus read-only live service
metadata. It is not live generation quality evidence and does not authorize
`apply-headless`, children, Gate 1, an active repository, GitHub effects,
deployment, migration, or unattended operation on mickey.
