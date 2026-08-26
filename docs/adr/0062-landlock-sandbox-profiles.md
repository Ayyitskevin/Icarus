# ADR 0062: Landlock sandbox profiles beneath the grant pipeline

- Status: Proposed — the profile mapping, CLI re-execution, and enforcement
  evidence are implemented; scheduling, network scoping, and recording the
  sandbox selection in durable run evidence remain future work
- Date: 2026-08-26
- Related: [ADR 0007](0007-fail-closed-docker-check-sandbox.md) (the
  daemon-side check sandbox, an independent layer),
  [ADR 0044](0044-headless-workspace-harness-direction.md) (headless
  workstream),
  [ADR 0046](0046-headless-execution-profiles.md) (profile grammar),
  [ADR 0048](0048-bounded-headless-worker.md) (the worker this backstops),
  [ADR 0059](0059-headless-isolated-child-runs.md) (child runs inherit the
  parent's confinement because Landlock domains survive exec and fork)

## Context

Icarus's authority model is proof-carrying: digest-bound grants refuse
policy violations. Two harness families (deepseek-harness and
xai-org/grok-build) pair such a policy layer with a second,
kernel-enforced sandbox so that a policy violation becomes impossible
rather than refused. Icarus runs on Linux-native hosts, where Landlock
(mainline since 5.13, unprivileged, one-way, inherited across exec and
fork) provides exactly that property without a daemon, a container, or
new authority.

Three constraints shape the design:

1. Landlock restriction is one-way and process-wide. It can only be
   applied before the process starts doing anything else, so the CLI —
   not the service — must own application, and everything after
   application (planning replay, tool actions, checks, settlement) runs
   inside the domain. The ruleset must therefore admit every byte the
   worker itself legitimately writes (event store, WAL sidecars, run
   worktree, snapshots, locks, lease files, SQLite schema-inspection
   scratch) while excluding everything else.
2. The grant pipeline's semantics must not change. The sandbox is a
   backstop beneath it: no new grant kind, no binding-digest change, no
   durable-schema change in v1.
3. Unsupported hosts must degrade honestly: a documented no-op with a
   warning event, never a silent fallback and never a hard failure,
   because CI and operators run kernels with and without Landlock.

## Decision

Three named profiles map to Landlock filesystem rulesets, applied by
re-executing the CLI under a small compiled helper before the runtime
exists. `run approve-headless` and `run resume-headless` accept
`--sandbox-profile workspace|read-only|strict|off`, defaulting to
`workspace` (overridable via `ICARUS_SANDBOX_PROFILE`). Reconciliation
and reconstruction commands execute no tool actions and stay
unsandboxed.

- `workspace` (default): read-write beneath the Icarus state root;
  read-only beneath `/`. A run can never write outside Icarus state —
  not the operator's home, not the registered source checkout, not
  other projects.
- `read-only`: the same write confinement, but the read surface shrinks
  to an explicit allowlist (system paths, the state root, the
  interpreter, the Icarus installation tree, the registered source
  checkout). Nothing else is even readable.
- `strict`: additionally confines file-content writes to the current
  run's scratch, the event store and its WAL sidecars, snapshots,
  artifacts, locks, and scratch tmp; the state root itself gets a
  `meta` access class — directory-entry lifecycle (create/remove
  regular files and directories) without file-content writes — so the
  SQLite WAL lifecycle works while no file contents outside the
  explicit writable set can change. Other runs' trees become
  content-immutable.

The helper (`packages/core/native/landlock-sandbox.c`) is ~250 lines of
C with no dependencies beyond libc and kernel UAPI headers (with
fallback definitions). It is compiled fresh with the host C compiler on
every sandboxed run — there is no cached binary to tamper with — then
it probes the kernel ABI, builds the ruleset (masking requested rights
to what the ABI supports and masking directory-only rights off
non-directory paths, both enforced by the kernel), sets `no_new_privs`,
restricts itself, and execs the CLI. Landlock domains survive execve,
so the re-executed process is the sandboxed worker; an env marker
(`ICARUS_LANDLOCK_APPLIED` carrying the canonical spec digest) makes
application exactly-once. Stdio, exit codes, and process-group signals
pass through unchanged. The re-executed process gets
`TMPDIR=<state-root>/tmp` because the store's exact-schema startup
check snapshots the database into `os.tmpdir()`.

Support detection is layered: platform must be Linux, the kernel
release must be at least 5.13, and the helper probe must report an ABI.
Any failure emits exactly one canonical stderr record
(`icarus.landlock-notice.v1`, `status: "unavailable"`) and the command
proceeds unsandboxed — the documented no-op. Enforcement itself is
silent: on supported hosts the history stream and stderr stay
byte-identical to an unsandboxed run.

The pure mapping (profile + host context → sorted, subsumption-pruned,
digest-bound rule list) lives in `packages/core/src/landlock.ts` with
support detection and argv construction; process orchestration stays in
the CLI composition root.

## Consequences

- Grant semantics are untouched: profiles add no grants, change no
  digests, and appear in no durable record in v1. Recording the applied
  spec digest in the worker-start payload is deliberate follow-up work,
  because it changes the H2b start-payload grammar.
- The default profile confines every headless run on a supported host
  with zero operator action; `off` is the explicit escape hatch.
- Crash-fidelity integration tests that kill the worker by pid set
  `ICARUS_SANDBOX_PROFILE=off`: the re-execution wrapper would orphan
  the real worker grandchild under SIGKILL. This is a test-harness
  property, not a production gap — operators send signals to the
  process group, which includes the wrapper.
- v1 enforces filesystem confinement only. Network access is not
  scoped (Landlock network support is a separate ABI and Icarus's
  egress approval already binds exact context bytes); the Docker check
  sandbox is daemon-side and unaffected; unix-socket connects (the
  Docker socket) are not Landlock-mediated, verified empirically.
- `strict` residuals, accepted and documented: the `meta` class on the
  state root permits creating and deleting (not writing) files beneath
  it, so a compromised run could delete another run's files but never
  alter or read their contents without a covering rule; and the event
  store must pre-exist with placeholder WAL sidecars because rules can
  only reference existing paths.
- Tests skip (never fail) where the kernel, platform, or a C compiler
  is unavailable; CI on Ubuntu exercises the real enforcement path,
  including a full headless run settling review-ready under `strict`.

## Alternatives rejected

### An npm Landlock binding or native N-API addon

Rejected because the repository's only native dependency is a prebuilt
better-sqlite3 and it has no addon toolchain; a hand-rolled syscall
path of ~250 audited lines compiled on demand carries less supply-chain
surface than any binding found on npm. The repository does not perform
native syscalls elsewhere, so this dependency choice is called out in
the pull request for explicit review.

### Seccomp-bpf instead of Landlock

Rejected because seccomp filters syscalls, not paths; expressing "write
only beneath this directory" is impossible at the syscall layer without
a ptrace supervisor, which is strictly more machinery and strictly
weaker ergonomics. Landlock is the path-based LSM designed for exactly
this use.

### Applying the ruleset per tool action

Rejected because Landlock restriction is one-way: once applied it can
only tighten, never lift, so "sandbox only the model's tool call" would
permanently confine settlement and evidence writes that follow it. A
single up-front application whose ruleset admits the worker's own
scratch is the only sound granularity in-process.

### bwrap / unshare namespaces

Rejected because it requires setuid helpers or user namespaces
(frequently disabled), changes mount semantics the worker must then be
re-validated against, and adds an external runtime dependency; Landlock
needs no privileges and no namespace support.

### Denying `/tmp` without redirecting scratch

Rejected empirically: the store's exact-schema startup check snapshots
the SQLite family into `os.tmpdir()`, so confining a run without a
writable `TMPDIR` fails closed at store open. The re-executed process
receives `TMPDIR` beneath the state root instead of broadening the
ruleset to host `/tmp`.
