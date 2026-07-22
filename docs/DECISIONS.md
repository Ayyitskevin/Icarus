# Decision index

Decision records for the current milestone:

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](adr/0001-typescript-modular-monorepo.md) | TypeScript modular monorepo with headless core and CLI | Accepted |
| [0002](adr/0002-sqlite-event-history.md) | SQLite for local control state and evidence | Accepted |
| [0003](adr/0003-detached-worktree-single-file.md) | Detached worktree and one-file mutation boundary | Accepted |
| [0004](adr/0004-provider-http-adapters.md) | Provider-neutral port with real Ollama and OpenAI HTTP adapters | Accepted |
| [0005](adr/0005-deterministic-untrusted-context.md) | Deterministic, provenance-preserving, untrusted context first | Accepted |
| [0006](adr/0006-headless-first-slice.md) | CLI-first slice; partially superseded for the bounded local workspace by ADR 0014 | Partially superseded |
| [0007](adr/0007-fail-closed-docker-check-sandbox.md) | No-network Docker sandbox for pre-review checks | Accepted |
| [0008](adr/0008-dedicated-state-root-and-run-leases.md) | Marker-owned private state root and per-run mutation leases | Accepted |
| [0009](adr/0009-persisted-intent-and-conservative-reservations.md) | Preparing intent and conservative external-operation reservations | Accepted |
| [0010](adr/0010-inherited-opencode-workflow-security-hold.md) | Inherited OpenCode workflow requires an operator security decision | Pending operator decision |
| [0011](adr/0011-kernel-backed-stable-run-leases.md) | Kernel-backed stable run leases without pathname deletion | Accepted |
| [0012](adr/0012-bounded-emergency-cancellation-recovery.md) | Fixed, metered emergency recovery after ordinary ceilings are exhausted | Accepted |
| [0013](adr/0013-pre-egress-full-tree-credential-audit.md) | Bounded full-tree credential audit before derived copies or egress | Accepted |
| [0014](adr/0014-loopback-api-react-workspace.md) | Loopback API and review-only React workspace | Accepted |
| [0015](adr/0015-read-only-repository-status-and-event-cursors.md) | Read-only repository status and event cursors | Accepted |
| [0016](adr/0016-bounded-older-event-navigation.md) | Bounded older event navigation | Accepted |
| [0017](adr/0017-bounded-workspace-run-summaries.md) | Bounded workspace run summaries | Accepted |
| [0018](adr/0018-bounded-verification-attempt-provenance.md) | Bounded verification-attempt provenance | Accepted |
| [0019](adr/0019-bounded-approval-provenance.md) | Bounded approval provenance | Proposed |
| [0020](adr/0020-bounded-persisted-diff-review.md) | Bounded persisted diff and run-status review | Proposed |
| [0021](adr/0021-bounded-project-catalog-and-json-responses.md) | Bounded project catalog and JSON responses | Proposed |

Major choices must be added as new ADRs. Do not rewrite an accepted ADR to hide
a changed decision; supersede it and link both records.
