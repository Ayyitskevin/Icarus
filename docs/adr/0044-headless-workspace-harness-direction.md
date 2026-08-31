# ADR 0044: Headless workspace harness direction

- Status: Accepted for the Icarus headless workstream; no Mickey deployment is
  authorized by this record
- Date: 2026-08-16
- Related: [ADR 0026](0026-agent-session-loop-and-tool-registry.md),
  [ADR 0036](0036-proof-carrying-software-factory-product-direction.md), and
  [DeepSeek Harness comparison](../DEEPSEEK_HARNESS_COMPARISON.md)

## Context

Icarus needs to become a first-class headless AI workspace harness for a node
like Mickey: it must run bounded agent work without a browser, preserve durable
evidence, recover after interruption, and support future workers without
turning model output into host authority.

DeepSeek Harness (`dsh`) is a useful reference. Its Cordis runtime composes
plugins through services and events, its profiles define runtime bundles, and
its session subsystem derives model history and replay from an append-only
event stream. Its official headless bundle is nevertheless a one-shot developer
preview, not a drop-in replacement for Icarus's proof-bound local kernel.

Icarus already has the safety properties that must remain authoritative:
plan-digest approvals, exact readable manifests, host-owned closed tools,
private Git worktrees, bounded/no-network checks, crash recovery, and separate
GitHub landing authority. ADR 0026 also explicitly rejects a duplicate
`agent_sessions`/`tool_invocations` source of truth.

## Decision

Icarus remains the outer authority kernel and headless supervisor. We will
selectively implement the useful runtime features in Icarus, in this order:

1. a versioned JSONL trajectory protocol over existing run history;
2. digestable, default-deny headless profiles over the closed tool registry;
3. a bounded one-task worker runner with cancellation, quiescence, and explicit
   non-success settlement;
4. event-derived replay, fork, and resume with new-run lineage;
5. isolated child runs with explicit depth, budgets, tool filters, and write
   sets; and
6. optional out-of-process adapters such as a pinned DeepSeek Harness worker.

The first item is implemented as `icarus.headless.history.v1` and exposed by:
(**superseded 2026-08-31**: ADR 0068 enlarged `RunUsage`, which changed this
export's canonical bytes, so the emitted schema is now
`icarus.headless.history.v2`. The command below is unchanged.)

```text
icarus run history RUN --format jsonl
```

The stream is a presentation over the existing SQLite history snapshot. It
does not add a session table, grant authority, expose the private state root,
or bypass any approval or lease. The current JSON history format remains the
default for compatibility. Its terminal record binds approval/event counts,
the final event sequence, and a SHA-256 over all preceding canonical JSONL
records; malformed run membership or non-monotonic event order fails closed.
The checksum detects drift but is not a signature or authenticity claim.

DeepSeek Harness may be used on Mickey only as an explicitly pinned,
out-of-process experiment or benchmark worker after the adapter has a separate
Icarus grant, sandbox, egress, secret, and compatibility contract. It is not a
production dependency or default supervisor while its developer-preview APIs
and Cordis dependency remain unstable.

## Consequences

Positive:

- headless consumers get a stable, replayable machine stream immediately;
- future profile and worker features have a clear place without creating a
  second authority kernel;
- Icarus can benefit from DeepSeek's composability and event-sourcing ideas
  without importing its entire runtime or supply-chain surface;
- Mickey remains useful as a local evaluation node without changing live
  services.

Costs and constraints:

- Icarus must build streaming, profile, worker, and child-run contracts rather
  than receiving them wholesale from `dsh`;
- the JSONL protocol is not yet a live follow/tail transport;
- no default Mickey worker or daemon exists until the exit gates in the
  comparison note have fresh evidence and an independent review;
- the current Gate 1 remote-mutation work remains separately owned and is not
  absorbed by this workstream.

## Rejected alternatives

### Replace Icarus with DeepSeek Harness now

Rejected because the official headless bundle is one-shot, the project is a
developer preview with compatibility-breaking changes, and its composed runtime
does not inherit Icarus's exact plan/manifest/landing evidence contracts.

### Add a second Icarus session database

Rejected because it duplicates the existing operation/event authority and
conflicts with ADR 0026. The headless stream must remain a projection over the
authoritative rows.

### Build arbitrary runtime plugins first

Rejected because unrestricted plugins would turn extensibility into a new trust
boundary. Profiles and providers must remain host-resolved, versioned, and
default-deny before plugin-like composition is admitted.
