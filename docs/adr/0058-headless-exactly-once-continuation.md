# ADR 0058: Exactly-once headless crash continuation

- Status: Proposed — the governed continuation path is implemented; it adds no
  fork, child-run, schedule, deployment, or Mickey service authority
- Date: 2026-08-26
- Related: [ADR 0044](0044-headless-workspace-harness-direction.md) (headless
  workstream), [ADR 0047](0047-headless-authority-binding.md) (H2a binding),
  [ADR 0048](0048-bounded-headless-worker.md) (H2b worker),
  [ADR 0049](0049-headless-crash-tail-reconciliation.md) (H3a crash tail), and
  [ADR 0057](0057-headless-evidence-reconstruction.md) (H3b evidence boundary)

## Context

ADR 0049 closes a crashed worker's tail and ADR 0057 proves from durable bytes
what the crash left behind. The remaining H3b question is whether a new worker
may continue the run without duplicating an effect: the process-local H2a
binding is gone, so re-entering execution must first re-establish the exact
persisted authority and prove the crash tail replay-safe.

Two failure shapes define the boundary. A crash with an open effectful
operation leaves an unknowable remote or filesystem outcome; re-driving that
stage could duplicate the effect. And a crash after an effect's durable
finish but before its successor intent — the provider edit finished, the
patch-set intent never persisted — would silently re-execute a settled effect,
because stage re-entry keys on the successor intent, not the operation
receipt. Classification alone cannot see the second gap.

## Decision

Add the governed, lease-held continuation command:

```text
icarus run resume-headless RUN
```

Under the existing per-run kernel lease, the service:

1. inspects the widened worker lifecycle grammar and returns the durable
   settlement unchanged when the worker already settled (ordinary or
   continuation), refuses a run whose latest epoch is still open with
   `HEADLESS_WORKER_RECONCILIATION_REQUIRED`, and refuses a second
   continuation with `HEADLESS_WORKER_CONTINUATION_EXHAUSTED`;
2. recomputes the ADR 0057 reconstruction from current persisted inputs,
   requiring the recorded profile, resolution, and binding digests exactly;
3. admits continuation only when every crash-tail effect is
   `durably_settled` or `no_effect`, every tail kind is one of the closed
   single-shot stage kinds, and each settled `workspace.create`,
   `provider.edit`, or `sandbox.verify` still has its durable successor intent
   (workspace path, patch set, verification evidence), so stage re-entry
   cannot re-execute it;
4. requires the profile's tighter cumulative ceiling to fit current usage,
   records exactly one `headless.worker.resume_requested` intent binding the
   run, the binding digest, the reconstruction digest, and the start sequence;
5. re-establishes the process-local active execution (profile ceiling and
   tool filter) and re-drives only `running`/`verifying` stages through the
   ordinary execution path — quiescent states settle from evidence without
   re-execution; and
6. proves quiescence and appends exactly one terminal settlement with the
   distinct `icarus.headless.worker-continuation.v1` schema, binding the
   resume-intent sequence, the interrupted settlement sequence, and the
   reconstruction digest.

The lifecycle grammar widens deliberately: still exactly one start; at most
one resume request, which must follow an interrupted settlement; at most two
settlements, where a second is lawful only as the continuation settlement or
as the interruption that closes a crashed continuation epoch. A crash during
continuation is closed by the unchanged H3a reconciliation with a second
interruption settlement whose full-tail operation linkage covers both epochs,
and the single continuation allowance is then spent. Interruption settlements
decode their durable operation linkage scoped to events preceding their own
sequence, so earlier epochs remain decodable after later ones exist.

Ordinary `run resume` still refuses every headless lifecycle before recording
resume intent; interactive, non-headless resume is behaviorally unchanged. The
continuation never invokes a stage the evidence cannot account for: settled
effects are never re-executed, and session-turn tails (`provider.revise`,
`session.*`), recovery kinds, foreign kinds, missing successor intents,
binding or provider drift, missing egress approval, and exhausted budgets all
fail closed with `HEADLESS_CONTINUATION_DENIED` before any resume intent is
recorded. Because the two `no_effect` read kinds exist only inside session
turns, no admitted crash tail contains them in this slice; re-driving
no-effect work remains a property of the classification contract, not a
behavior this gate exercises yet.

## Consequences

- A crashed single-shot headless run can be continued exactly once, with the
  whole admission chain — reconstruction equality, classification, stage
  replay safety, budget headroom — durable before the first new effect.
- The resume intent and continuation settlement are digest-bound to the exact
  evidence the gate saw; a forged or drifted continuation fails the lifecycle
  grammar on any later inspection.
- Double resume returns the byte-identical checksum-terminated history and
  appends nothing.
- Crash-during-continuation recovers through the existing H3a command and
  then refuses further continuation; no third settlement is expressible.
- Session-turn exactly-once continuation, fork, child runs, schedules,
  daemons, and deployment remain later work. A run whose crash tail contains
  any session operation is refused by this slice even when every operation is
  settled, because the session's turn-consumption boundary is not yet part of
  the gate.

## Alternatives rejected

### Reuse `resume.requested` and the ordinary worker settlement schema

Rejected because ADR 0057 treats ordinary resume intent inside the lifecycle
as malformed evidence, and ADR 0049 kept `icarus.headless.worker.v1` closed so
strict consumers can rely on its shape. Distinct resume and continuation
schemas keep both contracts stable and make the governed path explicit in the
record.

### Re-execute settled provider or sandbox effects on continuation

Rejected because exactly-once is the point of the slice: a model call or
sandbox run whose outcome is already durable must not be repeated. Where the
durable successor intent is missing, continuation refuses rather than guesses.

### Reuse the persisted provider response instead of refusing the intent gap

Rejected for this slice because provider receipts persist bounded metadata,
not response bytes; there is nothing trustworthy to replay from. If response
persistence ever lands under its own ADR, the successor-intent rule can be
revisited.

### Allow unlimited continuation epochs

Rejected because each continuation re-drives real work under real budgets. One
continuation per crash, closed terminally by a second crash, keeps the
authority story auditable and the grammar bounded at two settlements.
