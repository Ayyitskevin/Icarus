# Threat model

## Assets

- registered source repositories and their Git metadata;
- provider credentials in the process environment;
- private repository text sent to a chosen provider;
- Icarus project/run history, diffs, and command output;
- host filesystem, processes, private network, and production systems;
- operator trust in approval and verification evidence.

## Trust boundaries

1. Operator CLI input enters the Icarus process.
2. Repository content enters deterministic context and model prompts.
3. Provider responses enter proposal validation.
4. Git and registered check subprocesses cross into the host process boundary.
5. Provider HTTP crosses loopback/private or public network boundaries.
6. Approved bytes cross into an Icarus-owned worktree.

Repository rules, source, docs, issue text, model output, HTTP errors, and command
output are untrusted. Fixed host policy plus the operator's exact project
checks/sandbox/ceilings and digest-bound approval commands are authoritative.

## Primary threats and controls

| Threat | Milestone 1 control | Required evidence |
| --- | --- | --- |
| Prompt injection expands authority | Host policy is outside prompts; model can only return one typed proposal | malicious-instruction fixture |
| Path traversal or absolute write | lexical containment plus protected-path policy | traversal tests |
| Symlink escape | reject symlinks in every existing component and target | symlink test |
| Source checkout/Git corruption | private no-hardlink cache owns all worktrees | source refs/config/status digest |
| Arbitrary host execution | project code runs only in fail-closed no-network sandbox | sandbox adversarial tests |
| Secret leakage to history | credentials are environment-only; reflected credentials and recognizable provider-output secrets are discarded before proposal persistence; error/check output is redacted | provider reflection tests and persisted-tree scan |
| Secret leakage to provider or checks | context and tracked check snapshots reject secret-shaped paths/content; remote egress is separately approved | protected-file and snapshot tests |
| Unbounded spend/runtime | explicit context, output-token, cost, active-time, file, tool, and output ceilings | budget tests |
| Provider/context credential exfiltration | exact pre-egress approval, secret/path filtering, reject URL user info and redirects | endpoint/egress tests |
| TOCTOU path swap | isolated single-operator worktree; `O_NOFOLLOW` descriptor read with identity checks; component checks, atomic write, and final changed-set verification | adversarial test |
| Misleading success | state needs check evidence and review decision; acceptance recomputes live bytes/paths/diff; unsupported evals are not successes | drift integration and measured eval tests |
| Destructive rollback | rollback touches only the approved path in the owned worktree and retains checkpoint | rollback/restore test |
| SQLite tampering/corruption | local file permissions, foreign keys, WAL, transaction boundaries, backups documented | operations drill |

## Residual risks

- The controller currently talks to the host's Docker daemon; this is not a
  hostile multi-user boundary. Model/repository data cannot control Docker
  arguments or access its socket inside the container.
- Full-file model output can contain vulnerable code even when path-safe. Human
  review and project tests remain required.
- Loopback services are trusted only as configured; another local process may
  impersonate them.
- Persistence uses synchronous `better-sqlite3` behind the store boundary; a
  future schema version still needs an explicit migration and recovery drill.
- Redaction is defense in depth, not proof that arbitrary repository content has
  no secrets. Provider choice must match the project's privacy class.

## Security non-goals

No claim of hostile multi-user isolation, microVM isolation,
production deployment safety, authentication, authorization, tenant isolation,
or remote worker security is made in Milestone 1.
