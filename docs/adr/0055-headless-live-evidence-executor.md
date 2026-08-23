# ADR 0055: Gate 1 uses a one-shot, exact-resume live-evidence executor

- Status: Accepted — operator decision 2026-08-23; credential-gated live 3/3 recorded 2026-08-23 under explicit operator review override
- Date: 2026-08-23
- Related: [ADR 0027](0027-git-landing-authority.md), [ADR 0045](0045-gate1-live-evidence-profile.md), [ADR 0054](0054-gate1-effect-approval-and-recovery-semantics.md)

## Context

Gate 1 needs one headless invocation to land three reviewed cases without
turning Icarus into an always-on orchestration service. The normal Icarus run
lifecycle already owns provider calls, sandboxed checks, review, and candidate
construction. A live-evidence executor should compose that evidence rather than
duplicate it or introduce a second worker system.

External mutations also create a crash boundary. A process can die after a
GitHub request is durably admitted but before its response arrives. Retrying in
the same process or inferring effects from a started operation would risk a
duplicate ref or pull request. Conversely, an executor that keeps its only
checkpoint in memory cannot truthfully return an exact resume id.

## Decision

### Process and scheduling model

The executor is a one-shot Linux CLI. One invocation owns one resume id and one
kernel lease, processes the three cases sequentially in manifest order, emits
NDJSON on stdout, and exits. There is no daemon, queue, submission API, listener,
runtime plugin, or hook in the authority path.

`execute` creates the resume id and journal. `resume` requires that exact id and
the same approved profile and manifest bytes. Cases never run in parallel.

### Completed-run binding

Execution takes a schema-v1 run map containing one distinct completed Icarus run
id for every case, in manifest order. The existing-runs driver revalidates the
run's task, source revision, provider/model/adapter and prices, selected paths,
registered checks, passing untruncated evidence, expected changed paths, clean
source checkout, landing profile, and deterministic candidate identities.

Provider adapters are fixed implementations rather than a per-run runtime
selection, and `RunRecord` does not carry an adapter-version column. The driver
therefore accepts only the version label compiled for the provider and requires
the run to have been created after the profile approval. A persisted run from
before that adapter approval cannot be relabeled and reused.

The run map grants no capability. The approved profile remains the only source
of effect authority, and the landing ledger remains the source of durable remote
truth.

### Journal and recovery

The journal is canonical owner-only JSON under the Icarus state root. Creation
uses an fsynced fixed temporary file, absent-only hard-link publication, and
directory fsync so either crash window can be reconciled. Updates are
append-only in completed-case and terminal-receipt history and use fsynced
atomic replacement. Symlinks, extra links, unsafe permissions, non-canonical
bytes, authority mismatch, and changed-while-read files are refused.

Every loop reconstructs the effect ledger from completed cases plus current
durable landing evidence. A GitHub effect is counted only from the corresponding
durable HTTP POST admission row; a merely started operation is not an effect.
Prospective effects are authorized before the driver advances.

A mutation failure is re-observed as a fresh ambiguity boundary even when the
current process began with `resume`. It writes a blocked receipt and exits. Only
a later explicit `resume` invocation receives read-based reconciliation
authority. The executor never waits for approval, polls, or blindly repeats a
mutation.

### Output contract

stdout is canonical NDJSON ending in one terminal receipt. stderr carries
diagnostics. Exit codes are `0` succeeded, `3` blocked/refused, `130`
interrupted, `1` failed/invariant error, and `2` invalid file-only CLI input.
Replaying an already-successful resume id revalidates the complete persisted
effect ledger before returning the same terminal receipt. That read-only replay
does not require credentials because it cannot advance the driver or perform an
effect.

## Consequences

- Agents can invoke a bounded, non-resident Icarus execution path and receive a
  machine-readable terminal result and exact resume id.
- The executor composes normal reviewed Icarus runs; it does not become another
  provider runner or accept arbitrary runtime extensions.
- The first live attempt used operator-produced repository-automation
  assessments, usable credentials, separate human approval, and three
  disposable private repositories. The operator explicitly waived the
  otherwise-required independent review for this slice.
- The credential-gated live record closes Gate 1's 3/3 evidence requirement.
  It does not authorize merge of the three draft pull requests, deployment, or
  unattended execution against an active repository.

## Evidence

- [20-process offline executor fault campaign](../evals/2026-08-23-gate1-headless-executor.md)
- [ADR 0054 approval CLI measurement](../evals/2026-08-23-gate1-approval-cli.md)
- [Credential-gated live 3/3 record](../evals/2026-08-23-gate1-live-3of3.md)
