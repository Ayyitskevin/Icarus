# Threat model

## Assets

- registered source repositories and their Git metadata;
- provider credentials in the process environment;
- private repository text sent to a chosen provider;
- Icarus project/run history, diffs, and command output;
- loopback workspace requests and allowlisted browser evidence;
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
8. Browser requests cross the loopback HTTP boundary into validation and the
   application service.
9. Allowlisted state/evidence crosses from the API presenter into React, where
   repository, provider, and check-derived strings remain untrusted data.

Repository rules, source, docs, issue text, model output, HTTP errors, command
output, Host/Origin values, URLs, and JSON bodies are untrusted. Fixed host policy
plus the operator's exact project checks/sandbox/ceilings and digest-bound CLI
approval commands are authoritative; the browser is review-only.

## Primary threats and controls

| Threat | Control | Required evidence |
| --- | --- | --- |
| Remote access or DNS rebinding reaches local authority | production bind is fixed to `127.0.0.1`; UI/API are same-origin; Host and Origin must be loopback; no CORS permission is emitted | hostile Host/Origin and absent-CORS integration tests |
| Oversized, malformed, or ambiguous mutation | exact route/method/content-type schemas, unknown-field rejection, and bounded JSON bodies fail before service calls | content-type, body-limit, invalid-contract, malformed-provider-URL, and missing-repository tests with useful errors and unchanged state |
| Raw state leaks context/source blobs, private runtime paths, or credentials | API presenters allowlist fields and omit raw blobs plus private cache/worktree/artifact paths; explicit diff/check output stays bounded and redacted | serialization tests scan responses for private paths, raw source bytes, and credential material |
| Repository/provider text executes in the browser | React renders values as text under a restrictive content-security policy; no raw HTML injection contract exists | presenter allowlist test carrying adversarial strings plus package-wide static no-raw-HTML-sink scan |
| Browser widens execution authority | no approval, edit, check, arbitrary-command, commit, push, or deploy route exists | route inventory/static assertions and negative HTTP tests |
| Filtered context or provider repository map exposes secret/generated data | preview reads committed Git objects, returns metadata only, and shares its path classifier with the real model repository map; every `.env*`, dependency/generated, symlink, binary/invalid-UTF-8, model-hidden/intrinsic-secret, and secret-content entry is omitted or planning fails closed | deterministic filter tests, captured provider request, hidden-blob test, and source fingerprint |
| Prompt injection expands authority | Host policy is outside prompts; model can only return one typed proposal | malicious `AGENTS.md` instruction reaches the real prompt but an expanded target is rejected |
| Path traversal or absolute write | lexical containment plus protected-path policy | traversal tests |
| Symlink escape | reject symlinks in every existing component and target | symlink test |
| State initialization writes inside a Git checkout | lexical and canonical ancestor walks reject any `.git` marker before state-root creation; registration separately rejects repository/state containment in both directions | symlinked nested-state rejection, absent prospective directory, and source fingerprint |
| Source checkout/Git corruption | private no-hardlink cache owns all worktrees | source refs/config/status digest |
| Concurrent planning or Linux mutation, or stale-owner deletion | an atomic SQLite partial unique index admits one started operation per run before portable planning work; Linux approval/execution additionally use a stable single-link lease inode plus kernel `flock`; malformed metadata fails closed; v1-to-v2 upgrade is stop-the-world | Linux/macOS/Windows planning-admission coverage plus live-owner, legacy-owner, malformed, crash-recovery, and forced-replacement tests |
| Arbitrary host execution | project code runs only in fail-closed no-network sandbox | real-container probes deny public, host-loopback, and Tailscale-address-space connections |
| Secret leakage to history | credentials are environment-only; one bounded span scanner supplies detection and constant-marker redaction; reflected provider credentials are discarded; HTTP error bodies are not retained | provider reflection/error tests plus persisted-tree scan |
| Secret leakage to provider or derived copies | the complete tracked tree is audited before artifacts, egress, caches, or worktrees; edit, model-visibility, and intrinsic-secret path rules are distinct | unrelated-secret no-side-effect test plus safe `.npmrc` sandbox test |
| Unbounded spend/runtime | explicit context, output-token, cost, active-time, file, tool, and output ceilings; only a fixed, two-attempt, metered `cancellation.recovery` may exceed ordinary runtime admission to land safely | budget and emergency-recovery tests |
| Provider/context credential exfiltration | exact pre-egress approval, secret/path filtering, reject URL user info and redirects | endpoint/egress tests |
| Interrupted atomic write strands an unreviewed path | temporary file is private and outside the worktree; rename is the only worktree mutation | failed-rename cleanup and changed-path tests |
| TOCTOU path swap | isolated single-operator worktree; `O_NOFOLLOW` descriptor read with identity checks; component checks, atomic write, and final changed-set verification | adversarial test |
| Misleading success | timeout/cancellation cannot pass on exit zero; exact internal state stays visible; absent provider/execution is `unconfigured`; absent checks are `not_run`; history is append-only | timeout-trap, phase mapping, restart-before-plan, populated completed-run HTTP evidence, real-Chromium smoke, history, drift, and measured-eval tests |
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
- The workspace API has no authentication because loopback plus the current OS
  user is its boundary. Another process or browser running as that user can call
  it; it must never be proxied or exposed remotely.
- A configured loopback model service is trusted only as configured; another
  local process may impersonate it.
- GitHub-hosted automation and third-party installers remain outside the local
  runtime boundary. The inherited OpenCode workflow is not approved merely
  because its current upstream implementation contains a late permission check.
- Persistence uses synchronous `better-sqlite3` behind the store boundary; a
  future schema version still needs an explicit migration and recovery drill.
- Redaction is defense in depth, not proof that arbitrary repository content has
  no secrets. Provider choice must match the project's privacy class.
- SQLite operation admission defends cooperating planners by allowing only one
  started operation per run. Linux run leases additionally defend approval and
  execution from cooperating Icarus processes and accidental stale state, not an
  attacker with arbitrary same-user write access to `ICARUS_HOME` during a run.
  POSIX owner/mode checks and Windows current-user-profile containment rely on
  the operating system's local account boundary to prevent that access.
- The HTTP/UI, import, preview, draft-persistence, and loopback-planning paths
  support Linux, macOS, and Windows. Support assumes the platform's ordinary
  local filesystem, user-profile ACL, and SQLite locking semantics. Native
  macOS/Windows acceptance remains to be recorded.
- Guarded approval and execution remain Linux-only through `/usr/bin/flock` and
  `/proc`; execution also depends on a local Docker daemon.

## Security non-goals

No claim of hostile multi-user isolation, microVM isolation, production
deployment safety, remote API authentication/authorization, tenant isolation,
portable guarded approval/execution, account security, telemetry security, or
remote worker security is made by Milestone 1 or the first M3 workspace slice.
