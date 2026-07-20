# Threat model

## Assets

- registered source repositories and their Git metadata;
- provider credentials in the process environment;
- private repository text sent to a chosen provider;
- Icarus project/run history, diffs, and command output;
- host filesystem, processes, private network, and production systems;
- GitHub Actions credentials, OIDC authority, and repository automation;
- operator trust in approval and verification evidence.

## Trust boundaries

1. Operator CLI input enters the Icarus process.
2. Repository content enters deterministic context and model prompts.
3. Provider responses enter proposal validation.
4. Git and registered check subprocesses cross into the host process boundary.
5. Provider HTTP crosses loopback/private or public network boundaries.
6. Approved bytes cross into an Icarus-owned worktree.
7. Public GitHub comments can enter inherited repository automation before the
   Icarus runtime starts.

Repository rules, source, docs, issue text, model output, HTTP errors, and command
output are untrusted. Fixed host policy plus the operator's exact project
checks/sandbox/ceilings and digest-bound approval commands are authoritative.

## Primary threats and controls

| Threat | Milestone 1 control | Required evidence |
| --- | --- | --- |
| Prompt injection expands authority | Host policy is outside prompts; model can only return one typed proposal | malicious `AGENTS.md` instruction reaches the real prompt but an expanded target is rejected |
| Path traversal or absolute write | lexical containment plus protected-path policy | traversal tests |
| Symlink escape | reject symlinks in every existing component and target | symlink test |
| State initialization writes inside a repository | canonical prospective-path overlap check runs before state-root creation | nested-state rejection plus source fingerprint |
| Source checkout/Git corruption | private no-hardlink cache owns all worktrees | source refs/config/status digest |
| Concurrent cooperative mutators or stale-owner deletion | stable single-link lease inode plus kernel `flock`; malformed metadata fails closed; v1-to-v2 upgrade is stop-the-world | live-owner, legacy-owner, malformed, crash-recovery, and forced-replacement tests |
| Arbitrary host execution | project code runs only in fail-closed no-network sandbox | real-container probes deny public, host-loopback, and Tailscale-address-space connections |
| Secret leakage to history | credentials are environment-only; one bounded span scanner supplies detection and constant-marker redaction; reflected provider credentials are discarded; HTTP error bodies are not retained | provider reflection/error tests plus persisted-tree scan |
| Secret leakage to provider or derived copies | the complete tracked tree is audited before artifacts, egress, caches, or worktrees; edit, model-visibility, and intrinsic-secret path rules are distinct | unrelated-secret no-side-effect test plus safe `.npmrc` sandbox test |
| Unbounded spend/runtime | explicit context, output-token, cost, active-time, file, tool, and output ceilings; only a fixed, two-attempt, metered `cancellation.recovery` may exceed ordinary runtime admission to land safely | budget and emergency-recovery tests |
| Provider/context credential exfiltration | exact pre-egress approval, secret/path filtering, reject URL user info and redirects | endpoint/egress tests |
| Interrupted atomic write strands an unreviewed path | temporary file is private and outside the worktree; rename is the only worktree mutation | failed-rename cleanup and changed-path tests |
| TOCTOU path swap | isolated single-operator worktree; `O_NOFOLLOW` descriptor read with identity checks; component checks, atomic write, and final changed-set verification | adversarial test |
| Misleading success | timeout/cancellation cannot pass on exit zero; state needs check evidence and review; every verification attempt is append-only; unsupported evals are not successes | timeout-trap, history, drift, and measured-eval tests |
| Destructive rollback | rollback touches only the approved path in the owned worktree and retains checkpoint | rollback/restore test |
| SQLite tampering/corruption | local file permissions, foreign keys, WAL, transaction boundaries, backups documented | operations drill |

## Inherited repository automation hold

`.github/workflows/opencode.yml` came from the pre-existing remote root and was
preserved byte-for-byte during history reconciliation. That provenance prevents
silent shared-state deletion; it does not establish safety.

The public comment trigger begins a job before any repository-owned actor gate.
The job grants OIDC write authority, passes the named OpenCode secret, invokes a
mutable third-party action, and does not set `share: false`. The currently
resolved upstream code later checks collaborator permission, but mutable
bootstrap code runs first. Kevin must explicitly decide whether to disable the
workflow or approve a hardened design. Until then, M0/M1 security release status
is held. ADR 0010 records the options without changing the workflow.

## Residual risks

- The controller currently talks to the host's Docker daemon; this is not a
  hostile multi-user boundary. Model/repository data cannot control Docker
  arguments or access its socket inside the container.
- Full-file model output can contain vulnerable code even when path-safe. Human
  review and project tests remain required.
- Loopback services are trusted only as configured; another local process may
  impersonate them.
- GitHub-hosted automation and third-party installers remain outside the local
  runtime boundary. The inherited OpenCode workflow is not approved merely
  because its current upstream implementation contains a late permission check.
- Persistence uses synchronous `better-sqlite3` behind the store boundary; a
  future schema version still needs an explicit migration and recovery drill.
- Redaction is defense in depth, not proof that arbitrary repository content has
  no secrets. Provider choice must match the project's privacy class.
- Run leases defend cooperating Icarus processes and accidental stale state,
  not an attacker with arbitrary same-UID write access to `ICARUS_HOME` during
  a run. The state-root ownership/mode boundary must prevent that access.

## Security non-goals

No claim of hostile multi-user isolation, microVM isolation,
production deployment safety, authentication, authorization, tenant isolation,
or remote worker security is made in Milestone 1.
