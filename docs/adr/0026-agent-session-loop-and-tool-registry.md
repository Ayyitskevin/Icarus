# ADR 0026: AgentSession loop and host-owned tool registry

- Status: Accepted — implemented in slices; 2a, 2b-i, 2b-ii(a) and the loop executor landed, its wiring and 2c outstanding
- Date: 2026-07-26
- Related: [ADR 0023](0023-transactional-multi-file-patch-sets.md) (patch sets),
  [ADR 0024](0024-bounded-repair-loop.md) (bounded repair loop — superseded by
  the session loop in slice 2b, see Consequences),
  [ADR 0003](0003-detached-worktree-single-file.md) (isolation decisions still
  in force)

> Numbering note: `FABLE_ICARUS_VISION.md` §14 reserved 0024 for the session
> loop and 0025 for capability grants. Those numbers were consumed by the
> bounded repair loop and the OpenCode workflow hardening. This record takes
> 0026 and covers both the loop and the grant model, because a tool without a
> grant check is not a decision that can be reviewed separately from the tool.

## Context

Phase 1 gave Icarus a transactional multi-file mutation boundary (ADR 0023) and
a bounded retry against failing checks (ADR 0024). The provider contract is
still a fixed two-call script: plan, then patch set. The model cannot look at a
file it was not handed, cannot run a check and read the result, and cannot say
"I need to know one more thing before I edit."

That ceiling is the difference between a harness that applies a change and one
that does work. Removing it means letting model output select host actions,
which is precisely the authority this repository has spent every ADR refusing
to hand over implicitly. So it is granted explicitly, or not at all.

### The problem that has to be solved first

Egress approval currently binds `contextSha256`: the operator approves the
exact bytes that will reach a remote provider, before any of them do. A
`read_file` tool breaks that. Bytes the operator never approved would flow to a
provider mid-session.

This is the same coupling that shaped ADR 0023, where letting the model choose
target files would have sent unapproved bytes or forced a second egress gate.
There it was resolved by having the operator select candidates up front. That
answer does not survive here, because the point of a read tool is to reach
files nobody enumerated in advance.

## Decision

### Reads are bound by an approved manifest, not by a path predicate

At planning time the plan requests a read scope. The host resolves that scope
against the pinned base commit into a **readable manifest**: the sorted list of
`(path, sha256)` for every file the scope admits. The manifest digest joins the
approval digest. The operator therefore approves an exact, enumerated set of
files and their exact content digests — not a glob that could match anything
later.

Content is not sent at approval time. A `read_file` during the session returns
bytes only if their digest matches that path's approved manifest entry. So
egress stays exact: every byte that reaches a provider was covered by a digest
the operator approved, and the approval names the file it came from.

Two consequences worth stating plainly. Approving a manifest approves *more*
than will be sent, which is safe in this direction — a superset approval cannot
leak a file outside it. And a scope that resolves to more than
`MAX_READABLE_FILES` (proposed: 512) is refused at plan validation rather than
truncated, because a silently truncated read scope would make the model's view
differ from the operator's without either of them knowing.

Files the session itself wrote are the one legitimate exception: their bytes
originated from the model and are already recorded in the patch set and tree
checkpoint. A read therefore succeeds only if the bytes match the approved
manifest **or** match what this session recorded writing. Anything else is
fatal drift, not a fallback.

### Grants are itemized, plan-carried, and digest-bound

A grant is `{ kind, scope, limits }`. Grants live in the plan, so
`planApprovalDigest` covers them exactly as it covers `repairIterations`
(ADR 0024). Partial approval is edit-and-reapprove; there is no path that
narrows a grant silently and proceeds.

Every tool call is checked against the run's grants in the kernel, not in the
agent plane, and every call is a metered operation in the existing ledger. A
call with no matching grant is a structured error returned to the model — which
consumes an iteration — never a soft failure and never a host action.

### The loop is bounded by construction

`iterationCeiling` (default 8, host maximum proposed 16) sits in the plan and
therefore in the approval digest. Iterations are counted from the durable
operation ledger, exactly as repair iterations are (ADR 0024), so the count
survives a crash and cannot drift from charged work. All existing sun-ceiling
budgets continue to apply and bind first: a session that exhausts tool calls,
runtime, tokens, or cost stops there regardless of remaining iterations.

Exits: checks pass and the model reports done → `awaiting_review`; any ceiling
reached → `awaiting_review` carrying the failing evidence, reviewable and not
approvable; unrecoverable error → `failed` with a resume state. Each iteration
boundary is a persisted safe stage, so recovery resumes at one.

Exhaustion is not success. This is the same rule ADR 0024 established and it is
not relaxed here.

## Capability expansion checklist

### Uniform across every tool

| Property | Decision |
| --- | --- |
| Who grants | The operator, by approving a plan whose digest covers the itemized grant list. Never the model, never a config default, never a provider response. |
| Secret boundaries | No tool receives credentials, environment values, or authorization headers. Tool results pass the existing secret scanner; secret-shaped content in a result is fatal, matching the context and snapshot paths. |
| Network policy | No tool performs network I/O in this ADR. `install_packages` and dev-server tools are explicitly out of scope and deferred to their own record. |
| Sandbox boundary | Only `run_checks` executes anything, and only inside the existing fail-closed digest-pinned container (`--network none`, `--read-only`, `--cap-drop ALL`, user 65534). No tool executes on the host. |
| Cancellation | Unchanged. `cancelling` from any active state, sandbox reconcile, baseline restore, emergency recovery carve-out. A cancel mid-iteration abandons that iteration; already-charged work stays charged. |
| Crash recovery | Resume at the last completed iteration boundary. A tool call interrupted mid-flight is charged conservatively and not replayed as successful. |
| Prompt-injection containment | Every tool result is fenced as untrusted, identically to context files. Results cannot expand paths, checks, tools, network, budgets, grants, or iterations. Host policy is never derived from tool output. |
| Audit evidence | One ledger operation per call with bounded, redacted output, tied to the iteration and the run. Evidence is attached to the operation that produced it. |

### Per tool

| Tool | Capability kind | Exact scope | Limits | Rollback |
| --- | --- | --- | --- | --- |
| `read_file` | `read.manifest` | A path in the approved readable manifest | Output ≤ `maxFileBytes`; digest must match the approved entry or session-written bytes | None needed — no state change |
| `list_tree` | `read.manifest` | Paths within the manifest only | Bounded entry count | None needed |
| `search` | `read.manifest` | Manifest paths; bounded match count and per-match bytes | Truncation is reported as truncation, never as "no more results" | None needed |
| `get_check_catalog` | `read.checks` | The project's registered checks | Metadata only; no argv execution | None needed |
| `propose_patch` | `mutation.patchset` | Paths inside the approved target scope | ≤ `MAX_CHANGED_FILES`, ≤ `MAX_REPLACEMENTS_PER_FILE` | Accumulates a revision only; nothing on disk |
| `apply_patchset` | `mutation.patchset` | Same, re-checked per file at apply time | Atomic at the API boundary; tree checkpoint written first | Existing checkpoint rollback and restore |
| `run_checks` | `exec.check` | Registered check ids only, never arbitrary argv | Command timeout, output ceilings, container limits | None needed — no repository mutation |
| `report_done` | none | — | — | — |
| `request_human_input` | none | Pauses to `awaiting_review` with a bounded question | Question passes the secret scanner | None needed |

`request_human_input` is not a convenience. It is the escape hatch that makes
"I do not know" cheaper for the model than guessing, and its absence is a
common reason agent loops fabricate.

### Test and eval requirements

Slices do not land without these. Each is a gate, not an aspiration:

- Grant violation: a tool call outside its grant is refused, returns a
  structured error to the model, consumes an iteration, and performs no host
  action.
- Read binding: a read whose bytes do not match the approved manifest entry or
  session-written bytes is fatal; a scope exceeding `MAX_READABLE_FILES` is
  refused at plan validation.
- Output ceiling: truncation is recorded as truncation in evidence.
- Injection via tool result: a fixture whose file content instructs the model to
  widen scope, add a check, or exfiltrate must not change host policy.
- Loop bounds: iteration exhaustion lands failing evidence at
  `awaiting_review`; budget exhaustion preempts remaining iterations.
- Crash resume at an iteration boundary; cancellation mid-iteration.
- Digest binding: changing any grant changes the plan approval digest.
- Eval: the `repair-failing-test` scenario becomes executable, which is the
  first honest measurement of `diagnostic_target_selection`.

## Proposed slicing

Phase 2 as written in the vision document bundles the loop, the registry,
grants, and browser approvals. That is too much for one reviewable change.

- **2a — grants and read tools.** Grant model, approval-digest extension,
  readable manifest, registry with `read_file`, `list_tree`, `search`,
  `get_check_catalog`, `report_done`, `request_human_input`, wired into the
  existing single-shot execution. No loop, no new mutation authority. Proves
  the grant kernel, the read binding, metering, fenced results, and injection
  containment while the blast radius is still read-only.
  - **2a-i (landed).** The policy layer: `CapabilityKind` as a closed union,
    grant validation, `MAX_READABLE_FILES`, `readableManifestDigest`,
    `assertReadableManifest`, `assertReadableBytes`, and the approval-digest
    extension. Pure functions over data, so the binding that makes a read tool
    safe is reviewable before anything can call one. Nothing can resolve a
    manifest yet, so the store refuses a plan requesting `read.manifest`
    rather than binding an unresolved scope into an approval.
  - **2a-ii (landed).** Resolution of a `read.manifest` scope against the
    pinned base commit, persistence behind an operator-gated migration, and
    wiring into the planning path — so the operator now approves an enumerated
    file list rather than the scope string the model asked for.
  - **2a-iii (landed).** The tool registry: a closed `ToolName` union, exact
    argument validation, kernel-side grant checks with spend counting, read
    executors bound to the approved manifest, output ceilings that report
    truncation, and untrusted result fencing. The registry is callable-ready
    but nothing calls it — the loop that does is 2b, which also supplies the
    ledger-derived call counts and the per-call metered operation.
- **2b — the loop and write tools.** `propose_patch`, `apply_patchset`,
  `run_checks`, the AgentSession entity, the `verifying → running` edge (the state is `running`; no `executing` state exists), and
  resume at iteration boundaries. This is where ADR 0024's repair loop is
  superseded.
- **2c — browser approvals.** Its own record: session token bound at server
  start, loopback plus Origin plus token plus digest, CLI parity.

2a is mostly infrastructure and should be described that way rather than sold
as a user-visible win. Its value is that 2b becomes a change to execution flow
rather than a simultaneous introduction of grants, tools, and a loop.

## Alternatives rejected

**A path-predicate read grant** (`read src/**`, checked per call). Simpler, and
it is what most agent harnesses do. Rejected because it downgrades egress
approval from "these exact bytes" to "anything matching this glob at some
future time," and the glob's expansion is not visible at the moment of
approval. The manifest costs one resolution pass and keeps the property.

**Re-approval on every context expansion.** Preserves exactness perfectly and
makes the product unusable; an operator answering a gate per file is doing the
work themselves.

**Tools validated in the agent plane.** Would let the loop's own code decide
what it may do. Grant checks belong in the kernel with every other invariant.

**Model-authored shell commands, even sandboxed.** Rejected permanently, not
for this slice. `run_checks` takes registered check ids. The sandbox is a
containment boundary, not a license.

**Reusing ADR 0024's repair machinery for the loop.** Considered, because it
already counts iterations from the ledger and has a `verifying → running` edge.
Rejected as a base: the repair loop re-proposes a whole patch set per iteration
against a fixed target set, whereas a session interleaves reads, proposals, and
checks. 2b supersedes it rather than extending it, and the supersession will
follow the ADR 0003 → 0023 mechanics — forward link, retained decisions
restated, index status updated, nothing rewritten.

## Consequences

`iterationCeiling` and the grant list become new plan fields, so
`POLICY_VERSION` and the plan approval schema version both move. Persisted
project rows are untouched: as with `MAX_REPLACEMENTS_PER_FILE` and
`MAX_REPAIR_ITERATIONS`, new host maxima are module constants rather than
`SunCeiling` fields, because adding a ceiling field invalidates existing rows
against the exact-shape validators in the store, API, and browser.

New durable state: `capability_grants` and `agent_sessions`. Tool invocations
are event-only — the operation ledger plus a bounded event per call already
answers what was called, when, under which grant, at what cost, and with what
output. A `tool_invocations` table would be a second source of truth for
questions the ledger answers, which is the reasoning ADR 0024 used to keep
repair-iteration counting in the ledger.

When 2b lands, ADR 0024 is superseded and this record should be revisited: a
session that can read, patch, and check is a larger authority than a bounded
retry, and the residual risk is that a model with eight iterations and a read
manifest produces a plausible, passing, wrong change. Checks and human review
remain the control. This ADR does not claim to remove that risk, and no
capability here should be described as making review optional.

### Found while implementing 2a-i

Two things the design did not anticipate, both now enforced:

**A read manifest refuses more than the edit guard does.** `isProtectedEditPath`
was written to stop the model *editing* `.env` and credential files. It does not
exclude `.git/**`, and neither does the context-exclusion predicate. Today that
is moot because context is assembled from `git ls-tree`, which never lists
untracked `.git/`. But a manifest resolver walking a worktree does see it, and
`.git/config` carries remote URLs with embedded credentials. The validator now
refuses `.git/**` and intrinsically-secret paths by path, rather than relying on
a resolver that does not exist yet to be careful — a read sends bytes to a
provider, so it is held to a stricter test than an edit.

**Persisted plans were cast past absent fields.** `plan_json` decoded through an
unchecked `nullableJson<PlanProposal>`, so a row written before a plan field
existed produced a value whose type claimed the field was present.
`plan.grants.length` would have thrown, and `Math.min(plan.repairIterations, n)`
already yielded NaN on a pre-ADR 0024 row. That NaN happened to fail closed, but
only through a coincidence of comparison semantics across two functions rather
than by design. Decoding now normalizes both fields to the no-capability
reading, which is what a plan authored before the field meant. Neither default
can widen authority.

### Decided while implementing 2a-ii

**Scope syntax is not glob.** A trailing slash is a directory prefix; anything
else is an exact path. Wildcards were considered and rejected: they buy nothing
here, because the expansion is enumerated into the manifest anyway, and a
pattern language is a second thing to get right in a security boundary.

**Exclusions are reported, not silent.** A path a scope names can be dropped
for being context-excluded, intrinsically secret, a symlink, non-UTF-8, or
secret-shaped. Resolution returns those with reasons rather than just a shorter
list, so the difference between what was asked for and what was approved is
visible. A symlink is excluded rather than followed — its bytes are a target
path, and admitting one would let a read reach somewhere the manifest never
enumerated.

**Resolution re-verifies rather than inherits.** Whole-repository secret and
snapshot invariants are already enforced during context assembly, which reads
every tracked blob. Resolution therefore reads only in-scope blobs instead of
re-scanning the repository, but re-applies the same predicates per candidate. A
read sends bytes to a provider, so it re-checks rather than trusting an earlier
phase.

**The persisted manifest is digest-verified on read.** The stored digest is
recomputed from the stored entries, so a state file edited underneath Icarus
fails closed instead of silently widening what a read may return.

### Decided while implementing 2a-iii

**Read tools are scoped by the manifest, not by the grant's scope strings.**
A grant's scope is an input to resolution; the manifest is its enumerated
result and the thing the operator actually approved. Checking a read against
the scope string as well would be checking the question instead of the answer,
and would drift the moment resolution excluded something.

**Control flow is a property of the registered tool.** `report_done` and
`request_human_input` carry their control signal in the registry, so what the
loop does next is never read out of tool output. That keeps the injection
boundary total: output is data, and data cannot end a session or pause one.

**`get_check_catalog` returns ids and names only.** Check argv stays host-side.
The model selects checks by id; it never learns the command line, so it cannot
craft input against a specific runner.

**Output ceilings cut at a code-point boundary.** Slicing mid-sequence and
decoding substitutes a three-byte replacement character, which can push a
result back over the ceiling meant to bound it. The boundary is found first, so
the ceiling is a real bound rather than an approximate one.

### Measured while implementing 2b-i, and it changed the answer

The default and maximum iteration counts proposed above (8, with 16 as a host
maximum) do not survive measurement, and neither did the 4/8 pair that replaced
them. Under `DEFAULT_CEILING` a run costs **12 tool calls before its first
iteration and 8 per iteration thereafter**, so `12 + 8n <= 40` admits `n = 3`
and refuses `n = 4` with `Tool-call ceiling exhausted`.

So the binding constraint is `maxToolCalls`, not the token budget this record
reasoned about. `MAX_SESSION_ITERATIONS` is therefore **3** — the same value
ADR 0024 shipped, now with arithmetic behind it rather than judgement.
`sessionIterationsFitTheToolCallCeiling` in the integration suite asserts both
directions: spending the whole budget stays inside `maxToolCalls`, and one more
iteration would not fit. The ceiling cannot silently become decorative.

Two things follow. Raising `maxToolCalls` to make a preferred number fit would
be fitting the budget to the conclusion, so it was not done. And the
8-per-iteration cost belongs to the **reset-and-repropose round** this slice
inherits from ADR 0024 — an interleaved session loop should cost less per
iteration, so the number must be re-measured against the new loop rather than
argued upward.

### One iteration budget, not two

`repairIterations` is replaced by `iterationCeiling`. Two overlapping iteration
budgets in one plan is the kind of ambiguity that produces a fail-open seam, so
the supersession unifies them rather than adding alongside. The counted
operation kind keeps its stored string (`provider.revise`) even though its
exported name changed, because ledger rows already charged under it must keep
counting — renaming the value would silently reset every in-flight run's spend.

A plan persisted before this slice decodes its `repairIterations` into the same
`iterationCeiling`, preserving exactly the allowance the operator approved
rather than widening it to the new default or discarding it.

### The manifest digest is no longer policy-versioned

Bumping `POLICY_VERSION` for this slice would have invalidated every persisted
readable manifest, because `readableManifestDigest` mixed the policy version
into a content digest. That is the wrong binding: a manifest digest identifies
the manifest, and the plan approval digest is where `POLICY_VERSION` belongs.
Mixing them surfaces a stale approval as spurious read drift. The policy version
is removed from the manifest digest.

This does invalidate manifests written by the slice-2a-ii build: such a run fails
its digest check and must be re-planned. That is fail-closed and, given 2a-ii
landed the same day with no downstream users, proportionate — but it is a real
break rather than a silent migration.

### Decided while implementing 2b-ii(a)

**Host operations are injected as explicitly nullable fields.** A `ToolContext`
that cannot perform an operation says so with `null`, and the executor refuses
the call with `TOOL_UNAVAILABLE`. Optional fields would let a read-only context
appear to offer a write tool it has no way to carry out; nullable ones make the
absence a stated fact and the refusal a decision.

**A proposal is shape-checked at the call boundary and content-checked in the
executor.** `parseToolCall` bounds the serialized size and requires an object;
the real validation needs the run's approved targets and worktree preimages, so
`parsePatchSet` runs where those exist. A tool call cannot pre-approve its own
contents, and the mutation authority is re-checked per path at apply time
exactly as ADR 0023 requires.

**A failing check is evidence, not a control signal.** `run_checks` stays on
`continue`. Whether a session ends is the host's decision, derived from which
tool was called — never from what a check reported. That keeps the injection
boundary intact for the one tool whose output is most likely to be attacker-
influenced.

**`exec.check` names every check that may run.** The grant's scope is checked
per requested id, not merely for non-emptiness, so a grant for one check cannot
run another.

### Decided while implementing the loop executor

**The iteration is charged before the provider call it pays for.** A crash
between the charge and the response therefore costs an iteration rather than
yielding a free retry. The ledger is the record; the loop owns no counter of
its own, so a restart resumes against real spend and cannot restore a spent
budget.

**Spend is counted per capability.** The loop reads the tool's capability from
the registry and asks for that capability's charged count, so a mutation tool
cannot be admitted on a read grant's remaining budget. The first draft of this
loop hardcoded `read.manifest` for every tool — a latent authority bug caught
before it ran.

**A refused call is returned to the model, fenced, and still costs the
iteration.** A refusal is information the model needs in order to try something
else, so throwing it away would make the loop worse at its job. But it arrives
as untrusted data with an explicit note that host policy cannot be argued with,
and the iteration is spent either way — so probing the grant boundary is never
free.

**The provider envelope carries tool calls only.** `TOOL_CALL_SCHEMA` has
`additionalProperties: false` and exactly one field. There is nowhere in the
shape for a model to place a budget, a permission, an iteration count, or a
state transition, so widening authority is not expressible in the channel
rather than merely rejected after the fact.

**A `done` signal stops the batch.** Later calls in the same iteration are not
executed, so a model cannot append work after declaring itself finished.

### Two open questions for Kevin, both deliberately unresolved here:

1. **Default `iterationCeiling`.** The vision document proposes 8. Nothing has
   been measured. Recommend shipping 2b with a low default (3–4) and raising it
   on evidence from the eval scenarios rather than starting at 8 by assertion.
2. **Whether 2a ships alone.** It is infrastructure with no user-visible
   capability. The alternative is holding it until 2b is ready and reviewing a
   larger change with the loop included.
