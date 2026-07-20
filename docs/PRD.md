# Product requirements

## Product statement

Icarus is a private, local-first software factory for one operator. It turns a
task into an auditable sequence of context, plan, approval, isolated change,
verification, review, and landing or rollback. Ambitious capability is bounded
by an explicit "sun ceiling" and human decisions.

## First user

Kevin operates multiple Git repositories, Linux hosts, local model servers, and
cloud APIs. Mickey is the intended future control plane; Flow and Highwind are
future workers; Zenbook is an operator client. Milestone 1 is local-only and has
no dependency on Mise, Athena, KleeOS, Chronos, Odysseus, or any production
system.

## Milestone 1 job to be done

Given a clean local Git repository and one selected tracked text file, Kevin can
ask a configured model to plan one exact replacement. Before Icarus creates a
private workspace, requests edit bytes, or mutates code, he can inspect and
digest-approve the plan. Icarus applies the later edit proposal in a private
detached worktree, runs only checks Kevin registered
inside a no-network sandbox, records evidence, and leaves the source checkout
untouched. Kevin can approve the result, reject it, resume an interrupted stage,
roll it back, or restore the recorded checkpoint.

## Functional requirements

1. Before creating or opening the requested state root, reject lexical or
   canonical containment between it and the repository. Then register the
   canonical local Git repository and create an Icarus project.
2. Persist project checks, sandbox limits, and run ceilings. Milestone 1 path,
   network, shell, and approval policy is fixed host policy, not project data.
3. Start a run with a task, existing tracked target, provider, model, and bounded
   ceiling; pin a clean committed base tree.
4. Map the pinned Git tree and, before a context artifact, provider egress,
   private cache, or worktree exists, audit the complete tracked tree within
   fixed file/aggregate bounds. Ignored and uncommitted files never enter context.
5. Load only root/target-ancestor rules with byte limits and provenance.
6. For non-loopback providers, stop before context egress and bind approval to
   the exact context manifest digest.
7. Generate and persist a concise plan whose digest includes base, context,
   target, provider/model, checks, sandbox, ceilings, and policy version.
8. Stop in `awaiting_approval`; no private cache, worktree, edit call, or code
   mutation may precede matching plan approval. Durable database/context
   artifacts are required before this gate.
9. Revalidate the source identity, clean HEAD, and base ref, then atomically
   record the approving actor, timestamp, and exact digest.
10. Copy the pinned repository into an Icarus-private Git cache without hardlinks
    and create a detached worktree from that cache.
11. Ask the approved provider for one typed exact replacement against the target
    path and preimage hash.
12. Reject absolute paths, traversal, symlink/hardlink targets, protected paths,
    binaries, non-unique matches, creates/deletes/mode changes, stale hashes, and
    proposals over the configured byte ceiling.
13. Apply the replacement atomically from a private temporary outside the Git
    worktree, so an interrupted pre-rename write cannot add an unreviewed path.
14. Run only exact project checks inside a digest-pinned, no-network, read-only
    Docker sandbox with no capabilities, no host secrets, a timeout,
    cancellation, resource limits, and bounded/redacted output. A timed-out or
    cancelled command cannot pass merely by trapping the signal and exiting
    zero. Never fall back to host execution.
15. Verify the changed-file set equals the approved target and stays under the
    file ceiling.
16. Persist diff, check evidence, provider usage, state transitions, and a
    restorable checkpoint. Retain every bounded verification attempt and its
    diff in append-only history even when the latest run snapshot is replaced.
17. Stop in `awaiting_review`; failed checks remain reviewable but cannot be
    accepted. Completion requires a second human decision, passing checks, and
    a fresh match between live worktree bytes/path set/diff and the reviewed
    evidence.
18. Support status/history, explicit retry after a recoverable interruption,
    rollback, checkpoint restoration, and persisted cancellation recovery.
19. Support one real local adapter (Ollama HTTP) and one real cloud adapter
    (OpenAI Responses HTTP) without persisting credentials.

## Sun ceiling

Every run records maximum active runtime, provider output tokens, total tokens,
estimated cost, context bytes, changed-file count, file bytes, diff bytes, tool
calls, provider/check timeouts, and persisted/raw process-output bytes. Network
class, container-only execution, and required plan/review approvals are fixed
Milestone 1 host policy. Unknown remote pricing is a hard stop.
The ordinary active-runtime ceiling remains binding for productive work. One
fixed `cancellation.recovery` operation kind may charge at most two 120-second
attempts above ordinary runtime admission solely to land a run safely; the
additional tool calls and runtime remain visible.


## Non-functional requirements

- Single-operator and single-tenant.
- Source checkout content, refs, config, index, and worktree metadata remain
  unchanged; private caches own Icarus worktrees.
- Durable, queryable SQLite state with foreign keys and WAL mode.
- Crash-safe exact replacement and explicit resume from persisted safe stages.
  An interrupted external operation is charged its full conservative
  reservation before a fresh retry; resume may therefore stop at a ceiling.
- Deterministic tests do not call paid or installed models.
- Secrets are environment-only, and recognizable credential material in
  successful provider output is discarded before proposal persistence.
- Before any context artifact, egress, cache, or worktree, a bounded complete
  tracked-tree audit rejects intrinsically secret paths, content findings, files
  over 16 MiB, or aggregate content over 64 MiB.
- Known credentials and detected spans are redacted with constant markers.
  Non-success provider HTTP response bodies are not surfaced or persisted, and
  transport errors are sanitized before crossing the provider adapter boundary.
- Linux is the supported Milestone 1 platform.

## Explicit non-goals

Public signup, billing, teams, browser-held provider keys, Kubernetes, semantic
retrieval, arbitrary commands, creates/deletes, binary patches, commits, pushes,
deployments, previews, database migrations, customer data, production access,
backend-as-a-service primitives, and distributed execution.

## Preserved future contracts

Later milestones retain these product requirements without implying that they
exist in Milestone 1:

- Context intelligence will add project skills, language/framework detection,
  `rg`-based search, syntax/LSP signals, semantic retrieval, project memory,
  file-and-line provenance, and measured context-budget fixtures.
- The local workspace will expose repository status, sessions, live events,
  task state, file tree, diffs, checks, terminal evidence, previews, approvals,
  checkpoints, prompt history, and token/cost telemetry without placing provider
  keys in a browser.
- Application-factory templates may add an application starter, API layer,
  database, authentication, storage, realtime events, jobs, vector search,
  environment references, local preview, and deployment configuration only as
  demanded by real projects.
- Distributed execution treats Mickey, Flow, Highwind, and Zenbook as separate
  networked nodes with explicit job envelopes, heartbeats, retries,
  cancellation, idempotency, and resource limits. No shared-machine assumption
  is permitted.
- Future local services default to understandable Docker Compose-style
  orchestration. Kubernetes remains out of scope until evidence justifies it.

## Success measures

- A fixture golden path completes in the sandbox with the source checkout and
  source Git metadata unchanged.
- A traversal or symlink proposal is rejected before write.
- Repository/state overlap is rejected before the requested state root is
  created.
- A timed-out check is failed even if it handles termination and exits zero.
- A failing provider call leaves a resumable run with an audit event.
- Multiple verification attempts remain independently inspectable in history.
- Rollback restores the baseline bytes; restore recreates the approved bytes.
- Formatting, lint, type checking, unit/integration tests, security checks, and
  fixture validation all pass in CI.
- The evaluation report states unsupported scenarios rather than counting them
  as successes.
