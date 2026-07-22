# ADR 0021: Explicit native macOS and Windows acceptance

- Status: Proposed
- Date: 2026-07-22
- Related: [ADR 0010](0010-inherited-opencode-workflow-security-hold.md),
  [ADR 0011](0011-kernel-backed-stable-run-leases.md), and
  [ADR 0014](0014-loopback-api-react-workspace.md)

## Context

Icarus claims that the loopback HTTP/UI shell, repository import, committed-tree
context preview, draft persistence, loopback planning, and SQLite operation
admission support Linux, macOS, and Windows. Guarded approval and execution are
separately Linux-only because they require `/usr/bin/flock`, `/proc`, and the
Docker containment contract. Existing Linux tests simulate portable policy
branches, but no real macOS or Windows host run has been recorded.

Running the complete Linux release gate on another operating system would make a
false claim: that gate intentionally includes Linux lease, filesystem, Git, and
Docker-containment behavior. A native lane must exercise only the supported
portable boundary while remaining supply-chain pinned, bounded, and independently
reviewable.

## Decision

Add `.github/workflows/native-acceptance.yml` as a manually dispatched,
read-only workflow. A dispatch operates on the exact `github.sha` selected by the
operator. It has no secret reference, OIDC permission, write permission,
automatic pull-request trigger, push trigger, schedule, or workflow-call entry.
Concurrency is scoped to that exact commit and each job has a 20-minute timeout.

The fixed host matrix is:

| Runner label | Expected host | Expected architecture |
|---|---|---|
| `macos-15` | `darwin` | `arm64` |
| `windows-2025` | `win32` | `x64` |

These explicit OS labels avoid the moving `*-latest` aliases. Hosted images
still receive GitHub's normal weekly image updates, so a successful run is
evidence for its recorded image, action, dependency lock, and candidate commit;
it is not permanent proof about future images.

The workflow uses only these reviewed immutable action commits:

| Action release | Immutable commit |
|---|---|
| `actions/checkout` v7.0.1 | `3d3c42e5aac5ba805825da76410c181273ba90b1` |
| `pnpm/action-setup` v6.0.9 | `0ebf47130e4866e96fce0953f49152a61190b271` |
| `actions/setup-node` v6.4.0 | `48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e` |

The pnpm version remains repository-owned through exact
`packageManager: pnpm@9.15.4`; Node is exact `22.23.0`; dependency installation
uses the committed frozen lockfile. Checkout credentials are not persisted, and
no shared Actions dependency cache is restored or saved.

Each host validates the workflow policy and its own platform/architecture,
bootstraps and executes the checksum-pinned native actionlint binary, validates
every workflow plus actionlint's known-invalid negative fixture, installs locked
dependencies, and runs formatting, lint, type checking, the portable native,
provider, and selected unit boundaries, static security assertions, and the full
package build. The native smoke creates and reopens a real marked SQLite state
root beneath the current user's profile.

The selected unit list covers deterministic context preview, provider HTTP
contracts, policy/state transitions, persisted drafts and portable operation
admission, SQLite state, verification provenance, and workspace presentation and
request lifecycle. The draft suite runs only its explicit Darwin and Win32
admission cases; its mocked Linux kernel-lease case stays in the Linux gate. The
native lane deliberately excludes integration/eval suites, POSIX
symlink/mode tests, kernel leases, Git mutation, Docker checks, approval,
execution, audit-network calls, and the aggregate `pnpm check`. Those remain the
Linux release gate and this workflow cannot replace it.

`scripts/native-acceptance-policy.mjs` fails closed on workflow byte drift,
mutable or changed action refs, host-matrix drift, permission/trigger widening,
secret use, shared-cache enablement, command widening, missing exact-host
identity, Node drift, or pnpm drift. Security tests exercise positive and
adversarial policy cases locally.
Actionlint remains the syntax/schema validator; the repository policy is an
additional exact authority boundary, not a YAML parser substitute.

## Consequences

Native acceptance becomes explicit and repeatable without pretending that
Linux-only authority is portable. A candidate is not natively accepted until
both matrix jobs succeed at that exact commit and the resulting run URL, commit,
runner image versions, and job conclusions are recorded in the release handoff.
This local implementation has not been published or dispatched, so both real
host results remain pending.

The exact workflow digest intentionally makes any change fail the local security
test until the workflow and policy are reviewed together. Action-release or
runner-image upgrades require fresh official provenance, policy/test updates,
and both hosted jobs again. Because the workflow is manual, it controls runner
spend but does not serve as an automatic branch-protection gate.

This decision adds no runtime/package/schema behavior, provider call, repository
mutation, browser authority, approval, product execution, arbitrary command,
product commit/push/deployment, secret, or public endpoint. It does not modify or
bless the inherited OpenCode workflow; ADR 0010 remains an independent release
hold.

## Upstream provenance

- `actions/checkout` v7.0.1 release and commit:
  <https://github.com/actions/checkout/releases/tag/v7.0.1> and
  <https://github.com/actions/checkout/commit/3d3c42e5aac5ba805825da76410c181273ba90b1>
- `pnpm/action-setup` v6.0.9 release and commit:
  <https://github.com/pnpm/action-setup/releases/tag/v6.0.9> and
  <https://github.com/pnpm/action-setup/commit/0ebf47130e4866e96fce0953f49152a61190b271>
- `actions/setup-node` v6.4.0 release and commit:
  <https://github.com/actions/setup-node/releases/tag/v6.4.0> and
  <https://github.com/actions/setup-node/commit/48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e>
- GitHub-hosted runner labels and image-update policy:
  <https://github.com/actions/runner-images#available-images>
