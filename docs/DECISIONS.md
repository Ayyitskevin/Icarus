# Decision index

Decision records for the current milestone:

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](adr/0001-typescript-modular-monorepo.md) | TypeScript modular monorepo with headless core and CLI | Accepted |
| [0002](adr/0002-sqlite-event-history.md) | SQLite for local control state and evidence | Accepted |
| [0003](adr/0003-detached-worktree-single-file.md) | Detached worktree and one-file mutation boundary | Accepted |
| [0004](adr/0004-provider-http-adapters.md) | Provider-neutral port with real Ollama and OpenAI HTTP adapters | Accepted |
| [0005](adr/0005-deterministic-untrusted-context.md) | Deterministic, provenance-preserving, untrusted context first | Accepted |
| [0006](adr/0006-headless-first-slice.md) | CLI-first slice; no premature web/API service | Accepted |
| [0007](adr/0007-fail-closed-docker-check-sandbox.md) | No-network Docker sandbox for pre-review checks | Accepted |
| [0008](adr/0008-dedicated-state-root-and-run-leases.md) | Marker-owned private state root and per-run mutation leases | Accepted |
| [0009](adr/0009-persisted-intent-and-conservative-reservations.md) | Preparing intent and conservative external-operation reservations | Accepted |
| [0010](adr/0010-inherited-opencode-workflow-security-hold.md) | Inherited OpenCode workflow requires an operator security decision | Pending operator decision |

Major choices must be added as new ADRs. Do not rewrite an accepted ADR to hide
a changed decision; supersede it and link both records.
