# ADR 0025: Hardened inherited OpenCode workflow

- Status: Accepted
- Date: 2026-07-26
- Supersedes: [ADR 0010](0010-inherited-opencode-workflow-security-hold.md)
  (inherited OpenCode workflow security hold). ADR 0010's analysis is retained
  and remains accurate; this record resolves the decision it deferred by taking
  its second option.

## Context

ADR 0010 placed a hold on the inherited `.github/workflows/opencode.yml` and
required Kevin's explicit decision between removing it or hardening it. On
2026-07-26 Kevin chose the hardening option. This record is that decision and
its design; ADR 0010 is not rewritten.

The exposure ADR 0010 described was re-verified against live repository
metadata before this change, not restated from the record:

| Fact | Verified value |
| --- | --- |
| Repository visibility | `private: false`, `visibility: "public"` |
| Issues enabled | `has_issues: true` |
| Forking allowed | `allow_forking: true` |
| `opencode.yml` workflow runs, all time | `total_count: 0` — it has never fired |
| Branch protection on `main` | `protected: false` |

The pre-change job condition tested only four substrings of
`github.event.comment.body` and carried no actor predicate. Because
`issue_comment` executes in base-repository context with secret access
regardless of who commented, any authenticated GitHub user could start a job
that minted an OIDC token and passed `OPENCODE_API_KEY` into
`anomalyco/opencode/github@latest` — a mutable ref whose contents live outside
this repository's version control. `actions/checkout@v6` was likewise an
unpinned mutable major tag, which ADR 0010 did not enumerate.

## Decision

Harden the workflow in place, keeping the capability and the file. Five
properties, each corresponding to a requirement ADR 0010 set:

### A repository-owned actor gate before any third-party code

A separate `authorize` job holds `permissions: {}`, receives no secrets, and
uses no third-party actions. It admits only
`author_association` of `OWNER`, `MEMBER`, or `COLLABORATOR`. The privileged
job declares `needs: authorize`, so a skipped gate skips the whole chain.

`CONTRIBUTOR` is deliberately excluded: it means a merged pull request, not
write access, and on a public repository it is reachable by design.
`author_association` is set by GitHub rather than by the commenter, so it is
sound as a gate input where the comment body is not.

This is the boundary that matters. The upstream action's own collaborator check
is not an authorization boundary, because ADR 0010 established that it runs
only after mutable bootstrap code has begun executing.

### Untrusted comment fields never reach a shell

Comment content is used only inside `if:` expressions. Where the actor login
and association are logged, they are passed through `env:` rather than
interpolated into `run:`, so no comment-controlled value can be evaluated as
shell.

### Immutable action references

Both actions are pinned to commit SHAs: `actions/checkout` to the `v6.1.0`
commit `d23441a4`, and `anomalyco/opencode/github` to `77fc88c8`, the commit
that the annotated `latest` tag dereferenced to on 2026-07-26.

**The pinned third-party contents have not been reviewed by this repository.**
ADR 0010 asked for "reviewed immutable action and installer inputs"; this
change delivers the immutable half only. Pinning freezes what executes and
removes the silent-update path, but a supply-chain review of `77fc88c8` — which
lives in a repository outside this one — remains outstanding. Stating otherwise
would be a false claim of completion.

The residual risk this leaves is narrow and worth naming precisely: after this
change, causing that unreviewed code to run requires write access to this
repository. It is no longer reachable by strangers.

### Least-privilege permissions and no shared sessions

Top-level `permissions: {}` denies by default. The privileged job re-grants
only `id-token: write`, `contents: read`, `pull-requests: read`, and
`issues: read` — unchanged from the inherited file, which was already
read-only apart from OIDC. `share: false` is set, because ADR 0010 recorded
that public repositories otherwise default to shared sessions.

### Protected-environment approval

The privileged job declares `environment: opencode`. This is defence in depth
behind the actor gate, and it is inert until the environment carries required
reviewers in repository settings. GitHub auto-creates a referenced environment
without protection rules, so declaring it does not by itself add a gate —
recorded here so the declaration is not mistaken for enforcement.

## Consequences

Two items remain with Kevin and cannot be performed from the repository:

1. **Rotate `OPENCODE_API_KEY`.** ADR 0010 required post-change rotation. The
   secret's value was never read by this work and cannot be, but it was
   reachable under the previous condition by any GitHub user, so it must be
   treated as exposed and rotated.
2. **Add required reviewers to the `opencode` environment**, or accept that the
   actor gate is the sole gate.

ADR 0010's hold on Milestone 0 and Milestone 1 release status **narrows but does
not fully lift**. The authorization and mutability requirements are met; the
third-party review requirement and secret rotation are not yet. A release claim
covering this boundary is therefore still unsupported.

Branch protection is a separate, verified gap: every branch including `main`
reports `protected: false`, so the hosted CI gate is advisory. That is not in
this ADR's scope and is tracked as its own item.

Re-runnable provenance checks:

```text
git ls-remote https://github.com/actions/checkout refs/tags/v6.1.0
git ls-remote https://github.com/anomalyco/opencode refs/tags/latest
node scripts/security-check.mjs   # inheritedWorkflowIsActorGatedAndPinned
```
