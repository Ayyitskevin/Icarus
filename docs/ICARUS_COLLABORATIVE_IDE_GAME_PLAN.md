# Icarus collaborative IDE game plan

- Status: Product and execution plan; Gate 0 released, Gate 1 active
- Date: 2026-07-30
- Planning horizon: 12–18 months, reviewed at every exit gate
- Governing direction:
  [ADR 0036](adr/0036-proof-carrying-software-factory-product-direction.md)
- Current release state: exact `main`
  `802b91e6f6c9b392f56c9ee3660be818a0f74a62`; Gate 0 merged and released with
  successful exact-head Linux, macOS, and Windows evidence

This plan turns the product direction in ADR 0036 into a dependency-ordered
build program. It incorporates the requested Buzz-style experience where
agents work with one another before and during implementation, while retaining
Icarus's authority, isolation, evidence, and recovery guarantees.

This document records product direction and implementation order. Active user
instruction and the current handoff—not this file—supply task authority. The
plan does not silently authorize production deployment, live schema changes,
customer-data access, force-push, merge, public release, or any other
irreversible external effect.

## Outcome

Icarus should not win by becoming a thinner Cursor clone or a general-purpose
chat service. It should become the best place to turn an engineering intent
into a trustworthy change:

> One operator briefs a room of bounded agents. The agents investigate,
> disagree, propose a task graph, and—with explicit authority—execute in
> isolated workspaces. Icarus integrates only verified changes and preserves
> the decisions, evidence, and recovery path beside the code.

The product category is a **collaborative, proof-carrying IDE**.

The target experience has three persistent surfaces:

```text
┌──────────────────────────┬──────────────────────────────────┬──────────────────────────┐
│ Agent mission room       │ IDE / VS Code workbench          │ Authority and evidence   │
│                          │                                  │                          │
│ People and agent roster  │ Editor, symbols, search          │ Approved plan and grants │
│ Brief and constraints    │ Diffs and diagnostics            │ Budgets and write sets   │
│ Independent proposals    │ Terminal and registered checks   │ Checks and checkpoints   │
│ Debate and dissent       │ Child-worktree status            │ Landing and PR receipt   │
│ Decisions and task graph │ Preview when separately granted  │ Recovery and audit trail │
└──────────────────────────┴──────────────────────────────────┴──────────────────────────┘
```

The center is VS Code first. Icarus should use the editor, LSP, debugger,
terminal, source-control, remote-workspace, and extension ecosystem that
already exist. A Code-OSS fork or custom Monaco shell is a later adoption
decision, not a prerequisite.

## Competitive baseline

### Cursor

Cursor's current advantage is continuity, not one isolated feature. Its agent
surface spans the editor, terminal, worktrees, cloud environments, pull
requests, plugins, review, mobile access, and background execution. Recent
releases add parallel worktrees, durable side conversations and transcript
search, cloud handoff, PR review, an agent inbox, and model routing.

Icarus should:

- match the task-to-draft-PR loop, contextual code navigation, worktree
  parallelism, IDE review, background continuity, and governed extensions;
- integrate VS Code, GitHub, devcontainers, MCP, and provider APIs instead of
  rebuilding them;
- differentiate through exact grants, deterministic write isolation,
  provider-neutral local/self-hosted operation, proof-carrying pull requests,
  and recovery after every admitted effect; and
- defer a proprietary completion model, editor fork, native mobile editor,
  global hosted VM fleet, and broad marketplace until usage proves they are
  necessary.

Official current references:

- [Cursor product](https://cursor.com/en-US/product)
- [Cursor changelog](https://cursor.com/en-US/changelog)
- [parallel agents and worktrees](https://cursor.com/changelog/04-24-26)
- [cloud-agent handoff](https://cursor.com/changelog/cloud-in-agents-window)
- [self-hosted cloud agents](https://cursor.com/blog/self-hosted-cloud-agents)
- [local instant grep](https://cursor.com/blog/fast-regex-search)
- [plugin marketplace](https://cursor.com/blog/marketplace)
- [VS Code extension API](https://code.visualstudio.com/api)

### Buzz

Block's open-source Buzz provides the useful interaction model behind this
plan: humans and agents share rooms; agents have distinct identities and
memberships; conversations, workflow steps, reviews, and Git events share an
auditable event stream; and a feature branch can become the room in which
patches, CI, review, and the merge decision remain together.

Buzz is also explicit that it is unfinished. Its README marks workflow approval
gates as still being wired up. Icarus should borrow the room, identity,
branch-as-record, and agent-to-agent interaction ideas—not inherit ambient
shell authority, adopt Nostr as a new platform dependency, or claim unfinished
Buzz vision as shipped behavior.

Official current references:

- [Buzz README and feature-status table](https://github.com/block/buzz/blob/main/README.md)
- [Buzz agent vision](https://github.com/block/buzz/blob/main/VISION_AGENT.md)
- [Buzz project and branch-room vision](https://github.com/block/buzz/blob/main/VISION_PROJECTS.md)
- [Buzz support and agent-identity boundary](https://block.github.io/buzz/support.html)

## Product strategy

### Match

- editor-native task submission, plan review, diff review, diagnostics, checks,
  recovery, and draft-PR landing;
- deterministic local code search, symbols, explicit file/folder/branch
  context, project rules, and retrieval provenance;
- parallel investigations and isolated implementation attempts;
- durable background runs with reconnect, resume, artifacts, and
  notifications;
- GitHub issue, branch, pull-request, CI, and review-comment loops; and
- MCP, skills, hooks, and plugins behind declared capabilities.

### Differentiate

- a mission room where agents are visible participants rather than hidden
  subroutines;
- independent proposals before debate, so one early answer does not anchor the
  room;
- a human-readable task graph and explicit dissent record before execution;
- per-agent identity, channel membership, role, context projection, tools,
  budgets, and write-set authority;
- isolated child runs whose outputs are PatchSets plus evidence, never shared
  ambient filesystem mutation;
- deterministic integration that refuses intersecting write sets or stale
  bases;
- proof-carrying pull requests linking task, plan, grants, participants,
  decisions, changes, checks, checkpoints, and landing receipt; and
- a genuinely local or operator-owned control plane with provider choice and
  visible routing rationale.

### Integrate

- VS Code and its Chat Participant and Language Model Tool APIs;
- GitHub pull requests, checks, branch protection, and review state;
- devcontainers, Docker-compatible environments, and existing terminals;
- MCP and ACP as transport adapters behind Icarus policy;
- Playwright and preview providers; and
- Supabase local development and isolated branches.

### Defer

- a VS Code or Code-OSS fork;
- free-running swarms with shared shell/filesystem access;
- Nostr, a social relay, voice rooms, direct messages, or a general chat
  platform;
- multi-user tenancy, SSO/SCIM, and organization administration;
- a proprietary foundation model or completion model;
- production merge/deploy/migration autonomy; and
- any claim of parity based on feature count rather than fixed-task evidence.

## Non-negotiable collaboration invariants

1. A message is evidence or a proposal, never authority.
2. An agent cannot grant itself or another agent new paths, tools, egress,
   credentials, budget, landing, merge, deployment, or migration authority.
3. Human and agent identities are distinct. An agent cannot impersonate the
   operator or satisfy a human approval gate.
4. Each participant receives an explicit, digest-bound context projection.
   Hidden provider context and another agent's private scratch state do not
   silently leak into the room.
5. Agent-visible output is a bounded proposal, concern, question, or evidence
   reference—not hidden reasoning or provider scratch state. When one agent's
   output becomes another remote provider's input, Icarus treats that as a new,
   digest-bound and sanitized egress projection.
6. Brainstorming is bounded by participant, round, time, token, cost, and
   message ceilings.
7. Write-capable child work runs in a private, branch-pinned worktree with a
   declared write set. Intersecting write sets stop admission or are sequenced.
8. A child returns a transactional PatchSet, checks, usage, and evidence. It
   never mutates the parent worktree or source checkout.
9. The host, not a model, schedules turns, admits tasks, checks dependencies,
   detects write races, and applies integration policy.
10. Integration revalidates base identity, grants, changed paths, checks, and
   task dependencies. Chat consensus cannot override a failed proof.
11. Landing, merge, preview, migration, deployment, and public effects remain
    separate capabilities with separate approvals.
12. Every accepted decision and effect is durable and restart-safe. Silence or
    a missing event never implies success.
13. The operator can pause, remove a participant, reject a proposal, reduce
    authority, or close the room at any durable boundary.

## Mission-room lifecycle

The collaboration lifecycle is separate from `RunState` and from the future
Git landing state. A room may discuss several child runs, and a completed run
must not be rewritten merely because later landing or discussion occurs.

```text
created
  → briefing
  → investigating
  → deliberating
  → proposal_ready
  → awaiting_operator_approval
  → executing
  → integrating
  → verifying
  → awaiting_review
  → landed
  → closed
```

Failure and control states are explicit:

```text
paused | blocked | integration_conflict | verification_failed | cancelled
```

The first collaboration release should use a simple protocol:

1. Icarus records the brief, targets, constraints, participant roster, and room
   ceilings.
2. Two or three agents investigate independently against the same pinned
   repository identity.
3. Each posts a typed proposal with assumptions, evidence references, risks,
   task nodes, and candidate write sets.
4. A reviewer compares proposals and identifies agreement, disagreement, and
   missing evidence.
5. A synthesizer proposes one dependency graph. The host validates it; the
   operator approves or revises it.
6. Icarus admits ready nodes only when grants, input-tree identity, declared
   write sets, and resource ceilings still hold. An independent node starts
   from the approved root. A dependent node starts from an immutable tree
   materialized from that root plus the ordered, accepted PatchSets of all
   declared ancestors.
7. Child runs execute in isolated worktrees. Agents may post status, questions,
   evidence, and proposed dependency changes, but cannot mutate the graph
   directly.
8. The host integrates successful PatchSets in deterministic order, reruns the
   required checks over the combined tree, and presents one evidence bundle.
9. A separate landing decision creates the branch, commit, and draft pull
   request.
10. The branch room becomes the searchable record of why the change exists.

Initial council mode is read-only. Initial crew mode supports at most three
agents and two concurrent child runs. Limits increase only after fixed evals
show a quality benefit without write races or authority widening.

## Durable domain model

The smallest useful model is local and SQLite-backed:

| Entity | Purpose |
| --- | --- |
| `MissionRoom` | project, pinned base, lifecycle, ceilings, current proposal and task-graph digests |
| `AgentIdentity` | stable host-issued human/agent identity, display role, provider/model/config digest, and no credential value |
| `RoomMembership` | room visibility and participation state; membership alone grants no tools, paths, egress, or mutation |
| `RoomEvent` | append-only message, proposal, dissent, decision, status, task, evidence, or control event |
| `TaskNode` | typed goal, dependencies, expected evidence, candidate paths, current owner and state |
| `TaskClaim` | durable admission of one participant to one task under an exact authority snapshot |
| `WriteSet` | normalized exact paths or approved path prefixes used for deterministic collision checks |
| `Decision` | operator or host decision, alternatives, rationale, evidence references, and digest |
| `ChildRunRef` | immutable link from a task claim to an existing Icarus run and PatchSet |
| `IntegrationRecord` | ordered PatchSets, pinned bases, conflict result, combined-tree identity, and check evidence |
| `BranchRoomRef` | link to the future landing record and draft pull request |

`RoomEvent` should reuse the existing append-only/event and bounded-presentation
patterns, but room state must have its own tables and projections. A separate
bounded room-operation ledger reserves participant provider calls before I/O
and settles them atomically with evidence. Do not put unbounded chat payloads
into the existing run-event response or overload the run state machine.

## Dependency-ordered roadmap

Calendar estimates assume one focused primary engineer plus agent assistance.
Exit evidence, not dates, controls progression.

| Earliest runtime start | Gate | Outcome | Effort | Dependency |
| --- | --- | --- | ---: | --- |
| Completed 2026-07-31 | G0 | Released ADR 0026 at exact `main` `802b91e6...` with Linux and native evidence | complete | historical gate |
| Now | G1 | Verified Change Gate: browser authority, deterministic candidate commit, isolated create-only branch, draft PR, reconciliation receipt | 8–12 weeks | G0 complete; ADRs 0029 and 0027 accepted |
| After G1 | G2 | Context quality: local search, repository map, symbols, rules, typed read-only outcomes, fixed evals | 6–8 weeks | G1 benchmark contract |
| After G2 | G3 | Thin VS Code workbench with the IDE in the center | 6–8 weeks | G1 API, G2 context, topology decision |
| After G3 | C1 | Read-only agent Council in the mission-room pane | 4–6 weeks | G2 retrieval, G3 shared client, ADR 0037 |
| After C1 | C2 | Write-capable Crew with isolated child runs and deterministic integration | 8–12 weeks | C1 evidence, ADR 0033, ADR 0038 |
| After C2 | C3 | Branch rooms containing decisions, patches, CI, review, and landing receipts | 4–6 weeks | C2, G1 landing |
| After G3 | G4 | Replit-class declared environments and bounded previews | 8–10 weeks | G3, ADR 0028, ADR 0031 |
| After G4 | G5 | Supabase change packs on isolated local/preview environments | 8–10 weeks | G4, ADR 0032 |
| After proven G1–G5 and C2 | G6 | Durable background/fleet workers, governed extensions, automation, teams, signed exports | ongoing | ADR 0034, ADR 0035, proven earlier gates |

The table gives runtime admission order and per-gate effort, not permission to
skip an exit. Documentation, fixtures, and interface design for a later gate may
overlap when their files and authority do not intersect; runtime effects remain
blocked on every stated dependency.

The credible claim is not “full Cursor parity in 90 days.” The 90-day win is a
differentiated verified-change path. The six-month win is a strong IDE plus a
read-only multi-agent council. The nine-month win is bounded collaborative
execution. Broad category competition is a 12–24 month program.

## Exit gates

### G0 — release truth (passed at `802b91e6...`)

The existing ADR 0036 gate is now satisfied. Gate 1 runtime changes must
continue to build only on an identified and reviewed base. Recorded outcome:

- one committed candidate tree;
- focused and full local checks;
- dependency and security gates;
- exact-head hosted CI;
- native acceptance recorded honestly; and
- final role-neutral security and architecture/release evidence.

### G1 — Verified Change Gate

ADR 0029 browser approval authority and ADR 0027 Git landing authority are
accepted. Complete these slices:

1. server-start browser action session, fixed actor, same-origin/CSRF boundary,
   digest/revision-bound action request, and negative security matrix;
2. browser parity for existing egress, plan, review, recovery, resume, and
   cancellation controls, including grants and ceilings;
3. a separate durable landing ledger bound to an immutable completed run;
4. deterministic candidate commit and absent-only private
   `refs/heads/icarus/<run-id>` reference;
5. provider-specific, bounded GitHub REST object upload, absent-only reference
   creation, and draft-PR gateway without weakening the existing file-only
   `GitController`;
6. redacted metadata/digest-only evidence receipt; and
7. a pinned three-repository benchmark.

Success remains three of three TypeScript-library, Python-CLI, and React/Node
repair tasks with passing registered checks, exact expected changed paths,
reviewable draft pull requests, matching evidence receipts, restart recovery,
and unchanged source checkouts.

### G2 — context and agent quality

Build in this order:

1. versioned benchmark and metric definitions;
2. deterministic repository map v2 and stack detection over pinned Git objects;
3. bounded `rg` adapter over manifest-approved paths;
4. symbol/LSP adapters with no repository-triggered plugin execution;
5. retrieval budgets, rules for every target/retrieved file, and visible
   provenance;
6. typed read-only explanation and security-review outcomes plus
   behavior-preserving refactor evidence; and
7. planner/coder/reviewer routing only after the fixed baseline exists.

Keep ADR 0036's recall, precision, plan-acceptance, success-count, incorrect-edit,
and cost gates.

### G3 — center IDE

Choose the smallest topology first: on macOS and Windows, use VS Code
Remote/Dev Containers/WSL so the extension host and Icarus guarded execution
remain together on Linux. Do not silently turn the loopback API into an
internet-facing service.

Implement:

1. `@icarus/client` with versioned contracts, token handling, typed errors,
   action idempotency, and event cursors;
2. `packages/vscode` lifecycle and secure attach/start handshake;
3. repository/selection context and task submission;
4. native plan, grants, activity, diff, check, recovery, and landing surfaces;
5. the mission-room view container beside the editor; and
6. a 30-task TypeScript/Python/full-stack dogfood manifest.

### C1 — read-only Council

Accept ADR 0037 before adding a room table or making the first participant
provider call. It defines agent identity and membership, per-participant egress
grants, exact transcript/context projection digests, provider-operation intent
and reconciliation, cancellation and replay, bounded/redacted payloads,
retention, and an additive migration with backup and rollback.

Then implement the collaboration contract:

- at most three host-owned agent identities;
- independent proposals followed by one comparison and one synthesis;
- bounded messages, rounds, time, tokens, and cost;
- read-only tools and context projections;
- no child mutation, shell, egress widening, or landing authority;
- durable proposal, dissent, decision, and provenance events; and
- operator approval required to turn a proposal into an ordinary Icarus run.

Exit gate: use a versioned 30-task benchmark across three fixed seeds. Predeclare
one primary outcome per task class, the actionable-defect denominator and
severity rubric, and success non-inferiority for every class. Council must
produce at least three additional primary-outcome successes or at least 25%
fewer actionable review defects at non-inferior success than the same-model
single-agent baseline. Report intervals rather than calling the smoke suite
statistical proof. Require no security-task regression, zero unapproved access,
100% replay/recovery under injected interruption, median cost per success at
most 1.75× baseline, and median latency at most 2× baseline.

### C2 — executable Crew

Draft and accept ADR 0033 concurrency/branch-pinned base authority and ADR 0038
local child-run/task-envelope boundary. ADR 0034 retains its existing Athena
task-envelope and standing-policy boundary for Gate 6. Then implement:

- typed task graph and host-deterministic scheduler;
- normalized write-set declaration and intersection refusal;
- isolated branch-pinned child worktrees with a persisted immutable input-tree
  digest for every node;
- root-base execution only for independent nodes, and explicit materialization
  of root plus ordered accepted ancestor PatchSets for dependent nodes;
- per-child grant, context, tool, token, cost, and time ceilings;
- PatchSet-plus-evidence return;
- deterministic integration ordering and stale-base refusal;
- combined-tree verification;
- restart-safe task claims, ancestry, integration-tree identity, and
  stale-lineage refusal; and
- operator review before landing.

Exit gate: use 30 fixed multi-module tasks across three fixed seeds with
predeclared primary outcomes and the same defect rubric as C1. At least 24 of 30
tasks must succeed per seed with passing combined checks, and no task class may
regress in success. Crew must add at least three primary-outcome successes or
reduce actionable review defects by at least 25% at non-inferior success versus
the strongest single-agent baseline. Report intervals and include adversarial
write-collision, egress, stale-lineage, cancellation, and restart fixtures.
There must be zero write races, authority widenings, duplicate external
effects, or source-checkout mutations; median cost per success remains below 3×
baseline and median latency below 2.5×.

If Crew fails the quality gate, keep Council as an optional planning/review
mode and do not market raw agent count as progress.

### C3 — branch room

Attach one room to one landing branch and draft pull request. Show:

- the accepted brief and task graph;
- participant identities and exact authority;
- proposals, dissent, and operator decisions;
- child PatchSets and integration order;
- checks, CI, review comments, and repairs;
- candidate commit, receipt, and pull-request identity; and
- close/archive state.

The room is a record and control surface, not an alternate Git forge. GitHub
remains source-collaboration truth; Icarus preserves the proof and rationale.

## Repository implementation map

| Area | Current location | Planned change |
| --- | --- | --- |
| Domain policy and digests | `packages/core/src/types.ts`, `policy.ts`, `digests.ts` | typed landing, room, participant, task, write-set, and integration authority |
| Durable state | `packages/core/src/store.ts`, `state-machine.ts` | separate landing and collaboration ledgers; append-only room events |
| Orchestration | `packages/core/src/service.ts`, `session-loop.ts` | landing coordinator first; later room scheduler and child-run integration |
| Git isolation | `packages/core/src/git.ts` | keep file-only controller; add narrow candidate-commit operations |
| Provider landing | new provider-specific package | bounded object-upload/create-ref/draft-PR gateway, receipt, idempotent reconciliation |
| Browser boundary | `packages/api/src/server.ts`, `contracts.ts`, `present.ts` | authenticated mutation session, action routes, bounded projections |
| Browser UI | `packages/workspace/src/api.ts`, `App.tsx` | authority/evidence panel first; mission-room pane after shared client |
| Shared client | new `packages/client` | versioned contracts for browser and VS Code |
| IDE | new `packages/vscode` | task, room, editor context, diff/check/recovery/landing surfaces |
| Context | `packages/core/src/context.ts`, `tools.ts` | map v2, bounded exact search, symbols, per-source budgets and provenance |
| Evaluation | `fixtures/evals`, `scripts/eval-fixtures.mjs` | Gate 1, Gate 2, Council, Crew, IDE, preview, and change-pack manifests |
| Documentation | ADRs 0027–0038, threat model, operations, PRD | one accepted authority/recovery contract before each external-effect class |

ADR 0037 will define Mission Rooms, agent identities, membership, transcript
projections, room operations, and bounded deliberation. It must not absorb ADR
0033 concurrency, ADR 0038 local child-run envelopes, or ADR 0034's retained
Athena delegation boundary.

## First executable packets

### Packet 0 — close Gate 0 (completed 2026-07-31)

Working set at authoring/candidate time: the existing ADR 0026 candidate only.

1. [x] Recompute the exact diff fingerprint and rerun the focused/full local
   gates.
2. [x] Produce the final role-neutral security and architecture/release
   artifacts.
3. [x] Commit one coherent Gate 0 candidate only after the tree and evidence
   agree.
4. [x] Publish only under the repository's human/publication gate.
5. [x] Run exact-head hosted CI and native acceptance; record any skipped
   platform honestly.

The historical candidate-time rule was not to mix Gate 1 runtime code into the
held Gate 0 tree. [PR #18](https://github.com/Ayyitskevin/Icarus/pull/18)
merged that candidate as `d4bbcd4aab713bee23237099286e6d9b9f74283b`; the
native-fixture correction followed as exact `main`
`802b91e6f6c9b392f56c9ee3660be818a0f74a62`. Linux
[run 30602942008](https://github.com/Ayyitskevin/Icarus/actions/runs/30602942008)
and both macOS and Windows jobs in native
[run 30602949132](https://github.com/Ayyitskevin/Icarus/actions/runs/30602949132)
succeeded there. Gate 0 is merged and released without Gate 1 runtime code;
Packet 1 is now the forward work.

### Packet 1 — authority contracts and benchmark

Working set:

- `docs/adr/0029-browser-approval-authority.md`;
- `docs/adr/0027-git-landing-authority.md`;
- `docs/THREAT_MODEL.md`;
- `docs/ARCHITECTURE.md`;
- `docs/OPERATIONS.md`;
- `docs/EVALS.md`; and
- a versioned Gate 1 benchmark manifest.

Define exact session-token lifecycle, fixed actor, request schema, action
idempotency, landing profile, landing digest, intent-before-effect stages,
credential references, branch/ref restrictions, provider reconciliation,
receipt projection, crash points, migration/recovery contract, and negative
test matrix before runtime implementation.

Checkpoint: ADRs 0029 and 0027 plus the latter's normative v1 record companion
are accepted after independent P0/P1 reviews. The versioned Gate 1 benchmark
manifest is still outstanding, so Packet 1 is not complete.

### Packet 2 — browser authority without Git effects

Working set:

- `packages/api`;
- `packages/workspace`;
- shared service entry points only where parity requires them; and
- focused API/browser security and integration tests.

Success means every browser mutation is authenticated, same-origin,
digest/revision-bound, strict-schema, fixed-actor, restart-aware, and routed
through the existing service boundary. Git behavior remains unchanged.

Checkpoint: the portable origin/session transport, strict-JSON boundary, and
truthful client capability state are implemented locally and cold-reviewed.
The durable action request ledger, guarded routes, restart reconciliation, and
graceful shutdown settlement are not implemented; therefore Packet 2 remains
partial.

### Packet 3 — durable local landing

Working set:

- new landing domain/store/service modules;
- narrow private-cache Git methods;
- CLI/browser presentation; and
- unit, integration, security, and crash-recovery tests.

Success means a reviewed, passing run can prepare an exact candidate commit,
receive a digest-bound landing decision, and create one local private branch
without touching the source checkout or any network.

### Packet 4 — GitHub draft-PR landing

Add the allowlisted provider gateway, metadata-only receipt, remote
reconciliation, and three-repository benchmark. No force-push, merge, branch
deletion, direct deployment endpoint, arbitrary URL, arbitrary Git arguments,
or browser-held credentials. The landing decision must disclose and bind
repository-configured automation triggered by branch and draft-PR events.

### Packet 5 — context, IDE, then Council

Only after Gate 1:

1. implement the Gate 2 benchmark and deterministic retrieval;
2. extract the shared client and ship the center IDE;
3. accept ADR 0037 before adding Council state, migrations, or participant
   provider calls;
4. add read-only Council state and UX; and
5. prove collaboration lift before ADR 0033/0038 executable Crew work.

## Scorecard

The baseline remains ADR 0036's 5.0/10 against the requested end state.
“10/10” is a release standard, not a promise that every competitor feature has
been copied.

| Area | 10/10 evidence |
| --- | --- |
| Trust and authority | zero known bypasses across fixed adversarial suites; every external effect separately authorized and recoverable |
| Coding quality | fixed repair/refactor/explanation/security/scaffold suites meet published success and incorrect-edit thresholds |
| IDE | task-to-verified-draft-PR works across three stacks and supported host topologies without manual repository edits in at least 80% of the final benchmark |
| Collaboration | Council and Crew meet predeclared, repeated quality-lift and non-inferiority gates over strong single-agent baselines without races or authority widening |
| Context | published retrieval recall/precision, provenance, freshness, and cost meet Gate 2 |
| Environments | reproducible declared previews meet cold/warm, cleanup, egress, and recovery targets |
| Backend | isolated Supabase change packs prove migration, RLS, Auth, Storage, Realtime, function, rollback, and restore behavior |
| Reliability | crash/cancel/restart injection at every admitted effect reconciles without duplicate or ambiguous mutation |
| Extensibility | plugins/MCP/ACP are versioned, capability-declared, revocable, and evidenced per run |
| Product coherence | one task/room/evidence/landing model works consistently in browser, VS Code, CLI, and worker surfaces |

Competitive claims require a recurring pinned head-to-head with the current
Cursor release over identical public repositories, task revisions, model
versions where selectable, and observable success, elapsed time, manual
interventions, review defects, cost, and recovery behavior. Until Icarus wins
that comparison, describe the verified-change path as differentiated rather
than superior.

Leading product measures:

- verified accepted changes per operator-week;
- median task-to-trustworthy-plan, draft PR, and running preview;
- first-pass plan acceptance and check-pass rates;
- incorrect edits and review defects per accepted change;
- recovery success after injected crashes/cancellation;
- retrieval recall, precision, and context provenance coverage;
- Council/Crew quality lift, duplicate-work ratio, and cost/latency multiplier;
- provider tokens and cost per accepted change;
- percent completed without manual repository edits; and
- zero unapproved reads, writes, egress, credentials, pushes, migrations,
  deployments, or identity impersonations.

## Review cadence and stop rules

At every gate:

1. pin the candidate tree and benchmark revisions;
2. compare against the previous Icarus version and the strongest affordable
   single-agent baseline;
3. run authority, security, crash, restart, and source-immutability checks;
4. record cost, latency, failures, and skipped evidence;
5. ship only when the exit contract passes; and
6. revise this plan when product evidence invalidates an assumption.

Stop or narrow a track when:

- collaboration adds cost or latency without measurable quality lift;
- a feature requires weakening authority, source isolation, or recovery;
- a custom editor surface duplicates a mature VS Code capability without
  adoption evidence;
- semantic retrieval underperforms fresh exact/symbol search;
- a provider integration cannot prove identity, idempotency, redaction, and
  rollback/reconciliation; or
- a benchmark can pass without exercising the user outcome it claims to
  measure.

The north star is not the number of agents in the room. It is the number of
correct, accepted, recoverable changes an operator can ship with confidence.
