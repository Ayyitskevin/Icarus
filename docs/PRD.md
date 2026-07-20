# Product requirements

## Product statement

Icarus is a private, local-first software factory for one operator. It turns a
task into an auditable sequence of context, plan, approval, isolated change,
verification, review, and landing or rollback. Ambitious capability is bounded
by an explicit "sun ceiling" and human decisions.

## First user

Kevin operates multiple Git repositories, local hosts, and explicitly configured
local or cloud model endpoints. Milestone 1 and the first M3 workspace slice run
on one operator-controlled machine. They do not depend on Mickey, Flow,
Highwind, Zenbook, Mise, Athena, KleeOS, Chronos, Odysseus, or any production,
homelab, account, or telemetry service. Fleet control and workers remain future
distributed-execution concerns.

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

1. Before creating or opening the requested state root, reject any lexical or
   canonical path inside a Git checkout and reject containment between state
   and the repository. Then register the canonical local Git repository and
   create an Icarus project.
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

## First M3 local-workspace slice

The first browser path is intentionally narrower than the guarded CLI lifecycle:

1. A Node API persists repository/project records in the existing SQLite state
   root and serves a React workspace from the same fixed `127.0.0.1` origin.
   Host and Origin values are loopback-only, mutation bodies are bounded JSON,
   and the server grants no CORS access.
2. Import records an existing local Git repository but does not modify its
   content, refs, config, index, or worktree metadata.
3. Context preview is deterministic metadata over one committed tree and target.
   It returns paths, reasons, sizes, digests, counts, and warnings, never file
   contents. All `.env*` paths, dependency/generated directories, binary or
   invalid UTF-8 data, model-hidden paths, and secret-shaped content are omitted.
4. Submitting a task first persists a `preparing` draft without context, provider
   work, cache creation, worktree creation, or source mutation. Planning is a
   separate request and accepts only an explicitly configured loopback Ollama
   endpoint. Registration, context preview, draft persistence, and loopback
   planning support Linux, macOS, and Windows. An atomic SQLite started-operation
   admission prevents concurrent planning work for the same run on every
   platform.
5. The workspace presents the exact internal state and derives only these product
   phases: `draft`, `planned`, `awaiting_approval`, `running`, `completed`,
   `failed`, and `cancelled`. The mapping never turns an approval, recovery, or
   failed state into success.
6. Allowlisted responses expose the plan, any edit action that actually exists,
   involved/changed files, verification, checks, bounded/redacted output,
   warnings, approvals, usage, failures, and timestamps without
   returning raw context/source blobs or private cache/worktree paths. Explicit
   diff/check output remains bounded and redacted. An absent check is `not_run`;
   missing provider/execution capability is `unconfigured`.
7. The browser has no approval, edit, check-execution, arbitrary-shell, commit,
   push, deployment, account, telemetry, cloud-control, or fleet-control route.
   Guarded approval and execution remain Linux CLI-only under the kernel lease;
   execution also remains inside the Docker sandbox boundary.

## Second M3 read-only observation slice

ADR 0015 implements this bounded observation contract:

1. Observe one persisted project's repository without changing or persisting
   repository, project, run, or event state. Present independent availability,
   worktree, HEAD, branch, and configured-base-relation fields.
2. Missing repositories, identity mismatches, unresolved refs, and observation
   errors remain explicit in their relevant fields and never masquerade as a
   clean worktree. Detached HEAD is represented as `branch: null` while worktree
   cleanliness remains independently truthful. Omit dirty filenames and counts,
   file content, repository/private runtime paths, and raw Git output.
3. Expose one read-only event metadata endpoint for the selected run. Return a
   sequence-ordered page strictly after the supplied cursor under one fixed
   service-owned maximum. Each item contains only sequence, type, a
   host-controlled label, timestamp, and a fixed host-generated evidence-section
   identifier; event payloads never cross the API.
4. Build each full run response—run, approvals, and the 200 most recent timeline
   metadata rows—from one coherent SQLite read snapshot and include the
   append-only event sequence high-water mark in that response as its event
   cursor and total. Event metadata pages remain separate requests; complete
   payload-bearing history remains a CLI-only contract. If the retained suffix
   cannot establish an action's earlier prerequisite, present `unknown` with CLI
   guidance rather than inventing a status.
5. Short-poll only the selected run while the document is visible. Keep one
   current request, pause while hidden, abort on selection change or unmount,
   apply bounded failure backoff with success reset, and reject late responses
   through a selection/request revision guard. Accept a full run response only
   when its event cursor is at least the newest event revision already observed.
6. Link live updates only to a closed set of fixed, Icarus-generated evidence
   anchors. Never derive fragment identifiers or navigation targets from
   repository, provider, event, or check text.
7. Add no Server-Sent Events, WebSocket, filesystem watcher, schema migration,
   runtime dependency, background daemon, approval, mutation, execution,
   arbitrary-command, commit, push, or deployment authority. The guarded CLI
   lifecycle and ADR 0010 hold remain unchanged.

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
- The HTTP/UI shell, repository import, context preview, draft persistence, and
  loopback planning support Linux, macOS, and Windows. Planning is read-only
  with respect to the imported checkout, and SQLite atomically admits one
  started operation per run before provider work.
- Approval and execution are supported only on Linux because they inherit the
  kernel lease through `/usr/bin/flock` and `/proc`; execution also inherits
  the Docker sandbox requirements.

## Explicit non-goals

Public signup, billing, teams, browser-held provider keys, Kubernetes, semantic
retrieval, arbitrary commands, creates/deletes, binary patches, commits, pushes,
deployments, application previews, remote API exposure, database migrations,
customer data, production access, backend-as-a-service primitives, distributed
execution, accounts, and telemetry.

## Preserved future contracts

Later milestones retain these product requirements without implying that they
exist in Milestone 1:

- Context intelligence will add project skills, language/framework detection,
  `rg`-based search, syntax/LSP signals, semantic retrieval, project memory,
  file-and-line provenance, and measured context-budget fixtures.
- The first local-workspace slice exposes persisted projects, context metadata,
  task drafts, loopback planning, run state, and allowlisted evidence. The
  accepted second-slice design adds only the bounded observation contract above.
  Later M3 slices may add sessions, richer file/status, diff, and history
  navigation, application previews, approvals, checkpoints, prompt history, and
  token/cost telemetry without placing provider keys in a browser.
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
- A state root inside any Git checkout, or overlapping a repository in either
  direction, is rejected before the requested state root is created.
- A timed-out check is failed even if it handles termination and exits zero.
- A failing provider call leaves a resumable run with an audit event.
- Multiple verification attempts remain independently inspectable in history.
- Rollback restores the baseline bytes; restore recreates the approved bytes.
- Formatting, lint, type checking, unit/integration tests, security checks, and
  fixture validation all pass in CI.
- The evaluation report states unsupported scenarios rather than counting them
  as successes.
- The workspace API rejects non-loopback Host/Origin requests, oversized or
  malformed mutations, and remote planning endpoints without mutating state.
  Malformed provider URLs and missing repositories return useful
  `INVALID_PROVIDER_URL` and `INVALID_REPOSITORY` errors without persistence.
- Context preview is deterministic for one commit and target, returns metadata
  rather than source contents, and omits every prohibited path/content class.
- A task draft survives process restart before planning, and unavailable
  providers/execution or absent checks are never presented as completion or pass.
- Project import, context preview, draft, and planning leave the source checkout
  content and Git metadata unchanged.
- A production-asset smoke drives the golden path in real Chromium through a
  draft reload, planning, and truthful evidence.
- The HTTP presenter exposes populated, bounded plan, action, file, verification,
  check-output, approval, usage, and timestamp evidence for a completed CLI run
  without exposing private runtime paths.

The second M3 implementation has fresh local evidence for its independent status
fields, nonpersistence and source isolation, fixed event bounds and cursors,
payload omission, transaction-scoped full-run reads, the cross-request
event-revision guard, foreground polling lifecycle, bounded backoff,
stale-response guard, fixed evidence anchors, and unchanged browser authority.
Exact-head hosted CI remains required before published acceptance. No separate
cross-process WAL contention stress was added; coherence currently relies on the
explicit better-sqlite3 read transaction plus bounded/corrupt-payload tests.
