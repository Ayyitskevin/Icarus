# ADR 0010: Inherited OpenCode workflow security hold

- Status: Pending operator decision
- Date: 2026-07-19

## Context

The remote repository already contained `.github/workflows/opencode.yml` at
commit `0fb3476787573c1285974c2d53cfa28ec2233fc0`. Merge commit
`dd081a85d7649a155938b90474366ab6ffc01c13` preserved that file byte-for-byte
instead of rewriting or deleting shared remote state.

The repository is public. The inherited workflow accepts issue and pull-request
review comments containing `/oc` or `/opencode`, grants `id-token: write`, passes
the named `OPENCODE_API_KEY` Actions secret, and invokes
`anomalyco/opencode/github@latest`. During the 2026-07-19 audit, repository
metadata reported that named secret configured; its value was never read.

The currently resolved upstream implementation checks for collaborator write
permission, but only after mutable third-party/bootstrap code begins running.
Its composite action also discovers a current release dynamically, can execute a
remote install script, and defaults to sharing sessions for public repositories
unless `share: false` is set. A late upstream check is therefore not a
repository-owned authorization or supply-chain boundary.

## Decision

Do not silently change, disable, delete, or bless this workflow. It is inherited
security-sensitive shared automation and requires Kevin's explicit decision.
Milestone 0 and Milestone 1 release status remain on hold until Kevin either:

1. approves disabling/removing it and rotating or removing the associated
   secret; or
2. approves a hardening design with a repository-owned actor gate before any
   third-party action, `share: false`, reviewed immutable action and installer
   inputs, least-privilege OIDC/permissions, protected-environment approval where
   practical, and post-change secret rotation.

No exploit or secret disclosure is asserted by this record. The hold exists
because the current repository cannot independently prove that mutable remote
code receiving a secret and OIDC capability satisfies Icarus's safety boundary.

## Consequences

Runtime repair and local deterministic verification may continue independently,
but the repository must not claim a completed security or CI foundation. The
threat model and operations guide track this external automation boundary, and
release review must inspect every workflow rather than only runtime source.

Re-runnable provenance checks:

```text
git rev-parse 0fb3476:.github/workflows/opencode.yml HEAD:.github/workflows/opencode.yml
gh repo view Ayyitskevin/Icarus --json visibility,isPrivate,url
gh api repos/Ayyitskevin/Icarus/actions/secrets --jq '.secrets[].name'
```
