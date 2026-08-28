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
and creates no second session store. The end marker records approval/event
counts, the final event sequence, and a SHA-256 over every preceding canonical
JSONL record so truncation or byte-level drift is detectable. This is a
self-checking checksum, not a signature or proof of authenticity; the SQLite
history remains authoritative.

### H1 — declarative headless profiles

The offline H1 contract is implemented as strict `HeadlessProfileV1` plus
host-owned resolution. A source profile names only a provider profile ID, an
explicit sorted subset of the closed tool registry, tightening budgets, JSONL
output, and a one-task/no-schedule worker policy with child runs denied by
default. ADR 0059 adds only bounded operator-declared children, and ADR 0060
makes proposal-only mutation the default. Empty tools means deny all.
Resolution rebuilds provider configuration from the host catalog,
refuses tools without matching approved-plan capabilities, refuses budgets
above the project or plan, and emits a mapping-sensitive digest. It creates no
gateway, worker, grant, run, schedule, or I/O; H2 remains required for execution.

### H2 — bounded worker runner

H2a implements the non-executable authority bridge under proposed ADR 0047.
`icarus.headless.execution-binding.v1` recomputes the complete plan approval
digest from the persisted run/project/readable-manifest records, requires the
exact plan approval (and exact context-egress approval for a remote provider),
resolves H1 against that plan, and refuses a resolved provider different from
the plan-approved run provider. The record binds run, project, base, context,
plan, approval provenance, profile, and resolution identities. Its digest is
not an approval, lease, grant, or execution receipt and cannot be replayed as
authority after the state changes.

The local H2b candidate under proposed ADR 0048 adds the actual one-task runner
modeled on the useful part of `dsh --profile headless`. It reconstructs H2a
after ordinary approval but before the first effect while holding the existing
Icarus service lease, applies tighter cumulative ceilings and the profile's
additional session-tool filter, records machine-readable start/settlement
events, proves quiescence, emits H0 JSONL, and returns non-success exits for
exhaustion, human input, cancellation, failure, or incomplete settlement.
Independent H2b review passed locally. Risky-change research, live-provider
measurement, H3 crash-derived continuation, and deployment remain open.

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
