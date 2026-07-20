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
CLI -> application service -> injected collaborators
                              |-- concrete SQLite run store
                              |-- concrete artifact and Git controllers
                              |-- deterministic context assembler
                              |-- Ollama / OpenAI provider port and adapters
                              `-- Docker check-runner port and adapter
```

The domain does not import CLI code. Provider-specific JSON ends at the adapter.
Git and process adapters receive constructed argument arrays, never shell text.
The current service injects concrete `IcarusStore`, `ArtifactStore`, and
`GitController` instances. That is a testable composition boundary, not a claim
that interchangeable storage, artifact, or Git ports already exist. Extract an
interface only when a second implementation or isolated contract test requires
one.

## State and feedback

Authoritative control state lives in one SQLite database under `ICARUS_HOME`
(default: the platform-local state directory). The database stores projects,
runs, append-only events, check evidence, provider usage, and checkpoints. It
does not store credentials or environment snapshots.

The run row retains the latest verification for efficient status reads. Every
verification attempt also appends its complete bounded evidence and diff to the
event stream, so restore/reverify does not erase the earlier attempt from
history.

Operator feedback lives in CLI output and the same durable event/evidence
records. Provider and command output is bounded and redacted before storage.

Before `repo add` creates or opens the state root, the CLI resolves the existing
repository and the prospective state path through their nearest existing
ancestors. It rejects either path containing the other. The registered source
repository is then read-only from Icarus's perspective and
never owns an Icarus worktree. A copied Git cache and mutable worktree live only
below `ICARUS_HOME/runs/<run-id>/`, whose ownership is proved by generated IDs,
path containment, and the persisted run record.
Before any artifact, provider request, cache, or worktree is created,
preparation audits the complete tracked tree directly through bounded Git object
reads. A file larger than 16 MiB, more than 64 MiB of tracked content, an
intrinsically secret path, or recognizable credential content fails closed.


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
transaction. Waiting for a human is not active runtime. Stable per-run files use
kernel `flock(2)` on a retained descriptor, with descriptor/path inode checks;
process death releases exclusion without pathname cleanup. These leases prevent
concurrent cooperative current-version mutators inside the private state-root
boundary; online mixed-version upgrades and arbitrary same-UID state tampering
are outside that guarantee. Resume re-enters only a persisted safe stage. Exact writes
are replay-safe: a retry may accept baseline or identical approved bytes, but
unexpected bytes are preserved and fail closed.

## Golden-path sequence

1. Registration first rejects lexical or canonical repository/state overlap
   without creating the requested state root. It then canonicalizes a clean
   repository, stores its device/inode, and project creation stores a
   syntactically valid base ref and exact check arrays.
2. `run plan` first persists a `preparing` intent. It then verifies repository
   identity, resolves the base ref to the clean source HEAD, and immediately
   persists that immutable commit before further work.
3. Context assembly is a reserved operation. It first audits the complete
   committed tree within fixed credential-scan bounds, before landing any
   derived copy. It then reads through Git object commands, includes bounded
   root/target-ancestor `AGENTS.md`/seed files, records SHA-256 provenance, and
   labels repository text as untrusted.
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
   unique match and atomically applies it. The pre-rename temporary is created
   in the Icarus-private run directory outside the Git worktree, so a process
   death cannot strand an extra changed path inside the review surface.
8. Icarus exports only tracked worktree files to a private snapshot and runs
   exact registered checks in a digest-pinned Docker container with network
   disabled. A timeout or cancellation cannot pass even when the child traps the
   signal and exits zero. Icarus verifies the changed-file set, stores a
   binary-capable Git diff and checkpoint, appends the full bounded verification
   attempt to history, and stops at `awaiting_review`.
9. Review approval rereads the live target, changed-path set, diff, source HEAD,
   and checkpoint binding; it is refused unless those still match passing
   evidence. It then marks the run complete without committing, pushing, or
   deploying. Rejection enters
   `rolling_back`, restores only baseline bytes, verifies a clean private
   worktree, and then marks it `rolled_back`. Restore enters `restoring`, writes
   only checkpoint-approved bytes, and returns through verification.

Before a bounded external operation, SQLite reserves its worst-case runtime,
tokens, and cost and records a started operation. Completion charges observed
wall-clock runtime within the reservation; token and cost fields use validated
provider-reported usage when available. On restart, an unfinished operation is
marked interrupted and charged its entire reservation before a new request can
be attempted. This intentionally favors bounded spend over optimistic replay.
Cancellation first persists `cancelling`. Runs with a worktree reconcile sandbox
state before restoring baseline bytes; pre-workspace runs skip reconciliation.
A crash resumes that recovery state rather than leaving reviewable evidence
attached to rewritten bytes.
One dedicated `cancellation.recovery` operation kind can land a run even after its
ordinary ceiling is exhausted. It is allowed only in `cancelling`, reserves a
fixed 120 seconds, has at most two persisted attempts, and remains charged and
visible in usage. No other productive operation receives that exception.


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
a paid request. Known credentials are supplied to transport-error sanitization,
so a thrown HTTP transport error cannot copy a bearer value into durable state
or CLI output. Non-success HTTP bodies are not retained in surfaced errors.
Tests do not substitute a fake production adapter.

## Context boundary

Repository files are data, not authority over the host. Context entries retain
path, reason, size, and digest. Root and nested rules can inform the plan, but
cannot expand permissions, commands, network access, budgets, or writable paths.
Semantic retrieval is deferred until deterministic selection has evaluation
evidence.
Path classification answers three separate questions: whether a file can be
edited, whether its bytes can be shown to a model, and whether its pathname is
intrinsically secret. For example, a safe `.npmrc` is protected and omitted
from model context but may be exported to the no-network sandbox; detected
credential bytes never reach any of those derived surfaces.


## Safety boundary

- Remote-context approval gates non-loopback egress, plan approval gates the
  first write/edit call, and human review gates completion.
- Provider output with recognizable credential material fails before plan/edit
  persistence; known credentials, including credentials reflected by thrown
  transport errors, and command/error output are redacted.
- A proposal is one exact replacement in an existing tracked UTF-8 text file.
- Protected edit names include `.git`, non-template `.env*`, credential/key
  configuration; safe `.env.{example,sample,template}` files remain eligible,
  Icarus metadata, and repository rule files. Model visibility and intrinsic
  secret-path policy are evaluated separately.
- Reads open the final file with `O_NOFOLLOW`, verify descriptor identity and
  bounds, and reject symlinked components, special files, and hardlinks.
- Model-suggested commands are ignored. Only exact registered `argv` executes in
  a no-network sandbox; project code never executes on the host.
- Docker exports tracked files only after secret-shaped path/content screening
  and uses a locally present digest-pinned image, `--pull=never`, non-root
  user, read-only root, all capabilities dropped, no-new-privileges, no host
  sockets/secrets, PID/memory/CPU limits, timeout, cancellation, truncation, and
  redaction. Timeout, cancellation, or preflight failure is a hard verification
  failure regardless of the child process's eventual exit code.
- Network access for providers is separate from command network permission.
- Git subprocesses are fixed controller operations with system/global config,
  hooks, filters, pagers, prompts, external diffs, and network fetch disabled.

## Four invariants

- **State:** SQLite owns run truth; worktree bytes and Git status prove mutation
  truth.
- **Feedback:** append-only events retain every complete bounded verification
  attempt and diff; latest check evidence and CLI status expose current progress
  without erasing earlier failures.
- **Deletion coupling:** removing SQLite, a private cache, or a worktree destroys local run
  recovery, so cleanup is never automatic in Milestone 1.
- **Timing:** run/operation intent is persisted before bounded external actions;
  approval pauses are excluded from active budgets; interrupted reservations
  are charged conservatively; cancellation intent precedes rollback writes; a
  fixed, two-attempt emergency recovery is the only ordinary-ceiling carve-out;
  and only replay-safe stages may resume.
