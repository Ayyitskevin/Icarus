# Architecture

## Shape of the first system

Icarus is a pnpm workspace with two packages:

- `@icarus/core`: domain types, state machine, SQLite repositories, context
  assembly, provider ports/adapters, safety policy, Git worktree operations,
  sandbox execution, and the run application service.
- `@icarus/cli`: argument parsing, environment configuration, human approval
  commands, signal cancellation, and text/JSON presentation.

There is no server or browser in Milestone 1. A future API and React workspace
will call the same application service instead of moving policy into HTTP
handlers.

## Dependency direction

```text
CLI -> application service -> domain ports
                              |-- SQLite run store
                              |-- deterministic context assembler
                              |-- Ollama / OpenAI provider adapters
                              |-- private Git cache/worktree adapter
                              `-- Docker sandbox check runner
```

The domain does not import CLI code. Provider-specific JSON ends at the adapter.
Git and process adapters receive constructed argument arrays, never shell text.

## State and feedback

Authoritative control state lives in one SQLite database under `ICARUS_HOME`
(default: the platform-local state directory). The database stores projects,
runs, append-only events, check evidence, provider usage, and checkpoints. It
does not store credentials or environment snapshots.

Operator feedback lives in CLI output and the same durable event/evidence
records. Provider and command output is bounded and redacted before storage.

The registered source repository is read-only from Icarus's perspective and
never owns an Icarus worktree. A copied Git cache and mutable worktree live only
below `ICARUS_HOME/runs/<run-id>/`, whose ownership is proved by generated IDs,
path containment, and the persisted run record.

## Explicit run state machine

```text
                         /-> awaiting_egress_approval --approval--\
preparing --atomic split                                         -> planned
                         \--------------------------- local -----/     |
                                                                       v
                                                              awaiting_approval
                                                                       |
                                                                       v
                                                                    running
                                                                       |
                                                                       v
                                                                   verifying
                                                                       |
                                                                       v
                                                             awaiting_review
                                                               /           \
                                                      completed       rolling_back
                                                          |                 |
                                                          +------->     rolled_back
                                                                          |
                                                                      restoring
                                                                          |
                                                                          +--> verifying

cancellable state -> cancelling -> cancelled
failed --explicit resume--> persisted preparing/planned/running/verifying/recovery state
```

Every transition is validated and written with an event in the same database
transaction. Waiting for a human is not active runtime. Per-run leases prevent
concurrent mutators. Resume re-enters only a persisted safe stage. Exact writes
are replay-safe: a retry may accept baseline or identical approved bytes, but
unexpected bytes are preserved and fail closed.

## Golden-path sequence

1. Registration canonicalizes a clean repository, stores its device/inode, and
   project creation stores a syntactically valid base ref and exact check arrays.
2. `run plan` first persists a `preparing` intent. It then verifies repository
   identity, resolves the base ref to the clean source HEAD, and immediately
   persists that immutable commit before further work.
3. Context assembly is a reserved operation. It reads the committed tree
   through Git object commands, includes bounded root/target-ancestor
   `AGENTS.md`/seed files, records SHA-256 provenance, and labels repository
   text as untrusted.
4. Context persistence atomically lands a non-loopback run at
   `awaiting_egress_approval`; every remote provider call independently checks
   approval of that exact digest before any bytes leave the host.
5. The provider returns a strict JSON plan. Icarus hashes the full run manifest
   and stops at `awaiting_approval`.
6. Icarus revalidates source HEAD before recording approval, then copies a private
   Git cache without hardlinks, creates its detached worktree, and captures the
   approved target preimage.
7. The provider returns one strict path/hash/find/replace edit. Icarus discards
   recognizable credential material before persistence, then validates a
   unique match and atomically applies it.
8. Icarus exports only tracked worktree files to a private snapshot and runs
   exact registered checks in a digest-pinned Docker container with network
   disabled. It verifies the changed-file set and stores a
   binary-capable Git diff and checkpoint, and stops at `awaiting_review`.
9. Review approval rereads the live target, changed-path set, diff, source HEAD,
   and checkpoint binding; it is refused unless those still match passing
   evidence. It then marks the run complete without committing, pushing, or
   deploying. Rejection enters
   `rolling_back`, restores only baseline bytes, verifies a clean private
   worktree, and then marks it `rolled_back`. Restore enters `restoring`, writes
   only checkpoint-approved bytes, and returns through verification.

Before a bounded external operation, SQLite reserves its worst-case runtime,
tokens, and cost and records a started operation. Completion charges actual
reported use within the reservation. On restart, an unfinished operation is
marked interrupted and charged its entire reservation before a new request can
be attempted. This intentionally favors bounded spend over optimistic replay.
Cancellation first persists `cancelling`, then reconciles sandbox state and
restores baseline bytes. A crash resumes that recovery state rather than
leaving reviewable evidence attached to rewritten bytes.

## Provider contract

The provider-neutral port accepts model identity, capability metadata, a typed
structured-generation request, token/output ceilings, a timeout, and an abort
signal. It returns validated plan or edit data plus normalized
token/latency/cost usage.

Milestone 1 adapters:

- Ollama: documented `/api/chat`, non-streaming JSON response. Plain HTTP is
  loopback-only; any LAN/Tailscale/public endpoint is remote and must use HTTPS,
  explicit pricing, and context-egress approval.
- OpenAI: official `POST /v1/responses` with environment bearer token,
  `store: false`, bounded output, and text extracted from response output items.

OpenAI request shape follows the official [Responses API reference](https://developers.openai.com/api/reference/resources/responses/methods/create).
No provider SDK is required for this narrow contract. Tests exercise both
adapters against deterministic HTTP contracts; an OpenAI lifecycle test uses
the production adapter from exact egress approval through review without making
a paid request. Tests do not substitute a fake production adapter.

## Context boundary

Repository files are data, not authority over the host. Context entries retain
path, reason, size, and digest. Root and nested rules can inform the plan, but
cannot expand permissions, commands, network access, budgets, or writable paths.
Semantic retrieval is deferred until deterministic selection has evaluation
evidence.

## Safety boundary

- Remote-context approval gates non-loopback egress, plan approval gates the
  first write/edit call, and human review gates completion.
- Provider output with recognizable credential material fails before plan/edit
  persistence; known credentials and command/error output are redacted.
- A proposal is one exact replacement in an existing tracked UTF-8 text file.
- Protected names include `.git`, `.env*`, credential/key material, Icarus
  metadata, and repository rule files.
- Reads open the final file with `O_NOFOLLOW`, verify descriptor identity and
  bounds, and reject symlinked components, special files, and hardlinks.
- Model-suggested commands are ignored. Only exact registered `argv` executes in
  a no-network sandbox; project code never executes on the host.
- Docker exports tracked files only after secret-shaped path/content screening
  and uses a locally present digest-pinned image, `--pull=never`, non-root
  user, read-only root, all capabilities dropped, no-new-privileges, no host
  sockets/secrets, PID/memory/CPU limits, timeout, cancellation, truncation, and
  redaction. Preflight failure is a hard verification failure.
- Network access for providers is separate from command network permission.
- Git subprocesses are fixed controller operations with system/global config,
  hooks, filters, pagers, prompts, external diffs, and network fetch disabled.

## Four invariants

- **State:** SQLite owns run truth; worktree bytes and Git status prove mutation
  truth.
- **Feedback:** append-only events, check evidence, diff, and CLI status expose
  progress and failures.
- **Deletion coupling:** removing SQLite, a private cache, or a worktree destroys local run
  recovery, so cleanup is never automatic in Milestone 1.
- **Timing:** run/operation intent is persisted before bounded external actions;
  approval pauses are excluded from active budgets; interrupted reservations
  are charged conservatively; cancellation intent precedes rollback writes; and
  only replay-safe stages may resume.
