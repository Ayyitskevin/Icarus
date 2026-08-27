# ADR 0063: Exactly-once continuation after a read-only session batch

- Status: Accepted — independently reviewed head
  `956eecc87c15798e849b0211ce0582dc47911bc6` merged unchanged through PR #65
  as `a5fa58c2f49224fd27c8afd02da18cb6feace5bb`; effectful/control session
  batches, live-provider evidence, deployment, and live execution authority
  remain closed
- Date: 2026-08-26
- Related: [ADR 0026](0026-agent-session-loop-and-tool-registry.md) (session
  loop), [ADR 0057](0057-headless-evidence-reconstruction.md) (durable
  reconstruction), and [ADR 0058](0058-headless-exactly-once-continuation.md)
  (single-shot continuation)

## Context

ADR 0058 refused every crash tail containing `provider.revise` or a session
tool. That was safe but unnecessarily broad after a whole session batch had
already committed: Icarus durably records each provider/tool operation and
then appends `session.iteration_completed` only after the provider revision
and every emitted tool call have settled. The next process can reconstruct the
completed tool evidence and the spent iteration count without replaying the
provider response.

The boundary must be stronger than a request identifier. SQLite documents that
the transaction commit record is the point at which a transaction is durable
and atomic across process failure ([atomic commit](https://www.sqlite.org/atomiccommit.html),
[write-ahead logging](https://www.sqlite.org/wal.html)). By contrast, provider
request IDs are correlation and troubleshooting metadata, not a portable
idempotency contract ([OpenAI request IDs](https://platform.openai.com/docs/api-reference/backward-compatibility)).
Icarus therefore admits only a locally committed batch and never retries a
provider turn whose outcome is unknown.

Effectful and control tools remain different. Their safe continuation requires
durable request identity plus the process-local anti-replay and doom-loop state
that ADR 0060 currently keeps in memory. A completed iteration marker alone
does not prove enough to restore those invariants.

## Decision

Extend H3b with one deliberately narrow session path:

1. `session.iteration_completed` remains the commit marker and is written only
   after the successful `provider.revise` operation and the emitted tool batch
   have settled. The completion callback is awaitable so crash tests can stop
   at the exact durable boundary; production behavior is unchanged.
2. Reconstruction emits the existing byte-identical
   `icarus.headless.reconstruction.v1` shape when no session boundary exists.
   When one or more strictly monotonic boundaries exist, it emits
   `icarus.headless.reconstruction.v2` with the latest boundary sequence and
   iteration count included in the reconstruction digest. A v1 record is never
   silently widened.
3. `run resume-headless` admits a session tail only when the run is `running`,
   no effect is ambiguous, the number of durably settled `provider.revise`
   operations equals the boundary count, at least that many read-only tool
   operations are durably settled, and every admitted settlement precedes the
   latest boundary.
4. The closed tool set is `session.tool.read.manifest` and
   `session.tool.read.checks`. Any mutation, check execution, reconciliation,
   report, human-input control, recovery, child, or foreign session kind is
   refused before a resume intent is recorded.
5. Once admitted, the existing session loop starts at the persisted iteration
   count and rebuilds its prompt from completed durable tool evidence. It calls
   the provider only for the next unspent turn. The prior provider revision and
   read batch are never re-executed.

Missing, malformed, duplicate, or nonmonotonic boundaries; a provider turn
without a boundary; a boundary without session operations; an operation
settled at or after the boundary; provider/boundary count mismatch; and any
non-`running` session state all fail closed with
`HEADLESS_CONTINUATION_DENIED`. No database migration is required because the
iteration event and operation receipts already exist.

## Consequences

- A process killed immediately after a committed read-only session batch can
  continue exactly once from the next provider turn.
- Single-shot and pre-boundary reconstruction output remains byte-identical
  v1; session-boundary evidence is explicitly versioned v2. The accepted
  ordinary-v1 fixture has a literal golden digest so future drift fails as a
  protocol regression rather than passing a relative equality assertion.
- The resume-intent digest binds the exact completed boundary, so removing or
  moving it changes reconstruction authority.
- Effectful/control session continuation, fork/concurrency, schedules, remote
  children, deployment, and live execution remain future work.
- This partially supersedes ADR 0058's blanket refusal of all session tails;
  every session shape outside this closed subset retains that refusal.

## Alternatives rejected

### Retry the previous provider request with its request ID

Rejected because no supported provider contract makes that ID an idempotency
key. A retry could spend twice or return different tool calls.

### Admit any fully settled session tool

Rejected because a finished receipt proves termination, not restoration of
process-local anti-replay state or exactly-once host effects. Read-only tools
are the only closed subset whose replay authority is unnecessary.

### Add the boundary to reconstruction v1 as an optional field

Rejected because strict evidence consumers are entitled to treat a versioned
shape as closed. The explicit v2 discriminator makes the authority extension
visible and leaves ordinary v1 bytes unchanged.
