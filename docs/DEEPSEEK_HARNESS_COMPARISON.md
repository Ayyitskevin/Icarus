# DeepSeek Harness and Icarus headless direction

Date: 2026-08-16

This note records the product and architecture decision behind the headless
Icarus workstream. The comparison uses DeepSeek's official repository and
documentation, not community reimplementations.

## Decision

Do not replace Icarus with DeepSeek Harness (`dsh`) on Mickey at this stage.

Use Icarus as the authority kernel and headless supervisor. Borrow DeepSeek's
best ideas behind Icarus's existing grants, worktree, sandbox, approval, and
evidence boundaries. Keep `dsh` available as an optional, pinned,
out-of-process worker or benchmark lane only after an explicit adapter and
containment contract exists.

This is a deliberate hybrid decision, not a rejection of DeepSeek's design:
`dsh` is a strong source of composability and agent-runtime ideas, while Icarus
already owns the more important local safety and proof obligations for a
Mickey-like workspace.

## What DeepSeek actually ships

The official DeepSeek Harness repository describes `dsh` as a developer-preview
agent harness built on Cordis, with a plugin-based composition model. Its
headless bundle is a one-shot runner: it accepts one task, creates a fresh
persisted agent, waits for the agent to become idle, flushes the session, emits
the final assistant text, and exits. It does not provide a long-running headless
server or an interactive follow-up loop.

The important architectural pieces are:

- Cordis services, providers, consumers, typed events, and reversible effects;
- profiles and patch layers that compose a named runtime from bundles;
- an append-only session event stream from which model history, replay, fork,
  resume, and telemetry are derived;
- scoped tool registries and agent lifecycles;
- optional subagents, schedules, Code Mode, MCP, and terminal stacks.

The current repository is explicitly a developer preview with compatibility-
breaking iteration. Cordis is also an actively changing framework rather than a
stable dependency contract. Those facts matter more for a Mickey installation
than the feature count.

## Fit against Icarus

| Concern | DeepSeek Harness | Icarus | Direction |
| --- | --- | --- | --- |
| Headless entry point | Strong one-shot bundle | CLI-first run lifecycle | Add a versioned machine stream first; add a bounded worker runner later |
| Session truth | Append-only session events | SQLite run events plus operation/approval rows | Keep Icarus rows authoritative; do not add a duplicate session database |
| Extensibility | Plugin/bundle composition | Closed host-owned tool registry | Add declarative, versioned profiles only over an allowlisted registry |
| Model/tool loop | General agent loop and streaming | Bounded provider turns and metered host calls | Normalize streaming and provider events without widening grants |
| Subagents | Mature capability family and child sessions | Council/Crew is future roadmap work | Borrow lineage/depth/budget/write-set contracts after single-run proof |
| Host authority | Depends on composed runtime plugins and policy | Exact manifest, plan digest, grants, private worktree, no-network checks | Preserve Icarus as the outer authority boundary |
| Remote effects | Broad ecosystem integrations are possible | GitHub landing is a separate closed, proof-bound ledger | Keep every external effect behind Icarus's existing approval and receipt path |
| Maturity | Developer preview; APIs may break | Released safety kernel with strict local contracts | Do not make `dsh` a production dependency yet |

## Features to port, in order

### H0 — trajectory protocol (implemented in this slice)

`icarus run history RUN --format jsonl` emits
`icarus.headless.history.v1`. The stream contains the public run view,
approval records, ordered event records, and an explicit end marker. It is a
presentation over the existing authoritative snapshot; it grants no authority
and creates no second session store.

### H1 — declarative headless profiles

Add versioned profiles for provider selection, tool IDs, budgets, output mode,
and worker policy. Profiles must be resolved by the host, digestable, and
default-deny. A profile can select capabilities but cannot create a grant or
escape the approved plan.

### H2 — bounded worker runner

Add a one-task runner modeled on the useful part of `dsh --profile headless`:
machine-readable lifecycle events, cancellation, quiescence, and a non-success
exit for budget exhaustion or incomplete settlement. It must run through the
existing Icarus service/lease path and preserve approval gates.

### H3 — replay, fork, and resume

Make event-derived reconstruction a first-class API. Forking must create a new
run lineage and never mutate the source run. Resume must verify the persisted
plan, manifest, provider configuration, and workspace identity before doing
work.

### H4 — isolated workers and subagents

Only after H2/H3 evidence exists, add child runs with explicit parent lineage,
depth, tool filters, write sets, time/token/cost ceilings, cancellation, and
settlement. Child output is evidence or a proposal until the host admits a
PatchSet; it is never direct authority.

### H5 — optional external worker adapter

If DeepSeek Harness continues to be useful, run a pinned `dsh` process as an
adapter behind an Icarus-owned sandbox and egress policy. It must not receive
Icarus credentials, the private state root, or an unbounded source checkout.
Compatibility and security evaluation must pass before Mickey uses it outside a
benchmark lane.

## Mickey operating posture

Mickey is a good development and evaluation node for this work: it has the
local Ollama service, approximately 124 GiB of RAM, and the workspace needed to
run bounded local agents. That does not make a developer-preview runtime a safe
production authority. The first deployment target is a local, foreground,
operator-visible Icarus process with bounded resources and durable evidence.

No live service, `/opt/mise`, shared database, provider credential, or Mickey
daemon is changed by this workstream.

## Exit gates for “best in class”

The headless harness should not be judged by feature count. It is ready for a
Mickey default only when fresh evidence demonstrates:

1. start, cancel, crash recovery, resume, and fork preserve lineage and do not
   duplicate effects;
2. provider interchange cannot bypass the same host-owned tool/grant checks;
3. no unknown tool, path, secret, or egress can cross the boundary;
4. resource ceilings produce explicit non-success outcomes;
5. every model-visible input, tool result, approval, and settlement can be
   reconstructed from durable evidence;
6. repeated fixed-seed tasks show a quality/latency/cost improvement over the
   current bounded loop; and
7. an independent seat reviews the implementation before it is merged or
   installed as a default Mickey harness.

## Primary sources

- [DeepSeek Harness repository](https://github.com/deepseek-ai/deepseek-harness)
- [DeepSeek Harness architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)
- [DeepSeek Harness headless bundle](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/bundle/headless)
- [DeepSeek Harness session subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/session.md)
- [DeepSeek Harness official overview](https://deepseek.com/harness/)
- [Cordis repository](https://github.com/cordiverse/cordis)
