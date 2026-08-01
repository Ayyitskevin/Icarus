# ADR 0023: Transactional multi-file patch sets

- Status: Accepted
- Date: 2026-07-25
- Supersedes: ADR 0003 (detached worktree and one-file mutation), mutation
  boundary only. ADR 0003's isolation decisions — clean base commit, approval
  bound to the run manifest, hardlink-free private Git cache, post-approval
  detached worktree, and the prohibition on touching the source checkout — are
  retained unchanged and restated here.

## Context

ADR 0003 limited mutation to one preimage-bound exact replacement in one
operator-selected existing UTF-8 file. That boundary proved isolation,
approval, verification, and recovery, and it remains the reason the evidence
chain is trustworthy. It also makes the product unable to express the work
users actually delegate: a rename that spans call sites, a fix that needs a new
module, a change that removes a dead file.

The single-file assumption is not a parameter. It is a type-level literal
(`SunCeiling.maxFilesChanged: 1`), a ceiling assertion, an edit schema, a write
primitive that can only overwrite an existing file, a verification invariant
(`changedPaths.length === 1`), a checkpoint shaped as one baseline/approved
byte pair, a single-target diff parser, and a browser validator. Widening it is
an architectural change that must preserve every property the narrow boundary
bought.

Two properties are non-negotiable. The operator must still approve an exact,
bounded authority before any byte is written, and any partially applied change
must remain fully reversible from persisted evidence.

## Decision

### Approved change set

The operator selects the candidate set when starting a run: one or more
repository-relative paths, at most `ceiling.maxFilesChanged`, each satisfying
the existing protected-path policy. The first selected path remains the anchor
for the rules chain. This is the existing `--target` selection widened from one
path to a set; it is not a new kind of authority.

Context assembly includes the content of every selected path that exists at the
base commit, each recorded as a `target` entry with its own digest. Selected
paths that do not exist are legal `create` candidates and contribute no bytes.

The plan proposal gains `targets`: the sorted, deduplicated subset of the
operator's selection that the plan actually intends to change. The plan
approval digest binds that subset, so approval authorizes an exact maximum
authority rather than an open-ended agent.

A patch set may change a non-empty subset of the approved plan targets. It may
never introduce a path outside that subset. Changing less than authorized is
normal; exceeding the authorization is a fail-closed error.

The operator selects the candidate set rather than the model discovering it,
because egress approval binds the exact context manifest digest. A model that
chose its own files would need their contents after that approval, which would
either send unapproved bytes to a provider or require a second egress gate
mid-run. Candidate discovery is a retrieval capability and is deferred to the
context-intelligence phase, where the discovered set can be re-assembled into a
new context and approved before egress rather than after it.

Because the context manifest now carries a target set, its audit policy version
advances. A context artifact assembled under the previous version is rejected
with the existing outdated-policy error rather than being misread as tampering,
and its run must be replanned.

### Patch set

A patch set is an ordered list of file edits sharing one revision, applied as a
unit:

- `modify` — an existing tracked UTF-8 text file, bound to its preimage digest,
  carrying an ordered list of exact replacements. Each replacement must occur
  exactly once in the content produced by the preceding replacements. The file
  must end different from its preimage.
- `create` — a path that does not exist in the worktree, carrying complete UTF-8
  content. Parent directories are created only inside the private worktree and
  only through non-symlink components.
- `delete` — an existing tracked UTF-8 text file, bound to its preimage digest.

Rename is expressed as `delete` plus `create` in this revision; a first-class
rename operation is deferred. Binary content, symlinks, hardlinks, executable
modes, and mode changes remain rejected, as does any path denied by the
protected-path policy. Every path in a patch set is validated independently;
membership in an approved target set never bypasses path policy.

### Application

Application is transactional at the API boundary, not at the filesystem layer,
and the distinction is recorded rather than blurred:

1. Every path is validated and every preimage is re-read and digest-checked
   before any byte is written.
2. All replacement content is written to temporaries inside the private run
   root, outside the Git worktree, exactly as ADR 0003 required, so an
   interrupted stage cannot add an unreviewed path to the review surface.
3. Only after every edit is staged does application begin. Edits are applied in
   a deterministic path order.
4. If any application step fails, the already-applied steps are compensated
   from the baselines captured in step 1, and the run fails closed.
5. A process death during step 3 can leave a partially applied worktree. It is
   never presented as a result: the run resumes into drift detection, the
   persisted tree checkpoint restores baseline bytes, and unexpected bytes are
   preserved rather than overwritten.

Creating a file makes it visible to `git status` as untracked. To produce a
diff for created paths the private worktree index records an intent-to-add
entry. The index of an Icarus-private worktree is Icarus's own state; the
source checkout's content, refs, config, index, and worktree metadata remain
untouched. Rollback clears those entries so a rolled-back worktree returns to
clean.

### Tree checkpoint

The single baseline/approved byte pair becomes a tree checkpoint: one row per
affected path recording the operation, the baseline bytes (absent for a
`create`), and the approved bytes (absent for a `delete`). The checkpoint
digest binds the run, base commit, and the ordered per-path operation and
content digests.

Rollback restores every baseline byte and removes every created path. Restore
recreates every approved byte and removes every deleted path. Both verify a
clean private worktree afterwards, and both re-enter verification exactly as
before.

### Verification and review

Verification asserts that the changed-path set equals the patch-set path set
exactly and stays within the ceiling. The diff is the multi-path Git diff over
those paths and is digest-bound as one artifact. Review approval continues to
require that live worktree bytes, the changed-path set, the diff, the source
HEAD, and the checkpoint still match passing evidence; it now performs that
comparison per path.

### Ceilings and policy version

`SunCeiling.maxFilesChanged` becomes a validated integer between 1 and 64. No
field is added to or removed from `SunCeiling`, so project configuration
persisted under schema v1 continues to decode without rewriting. New projects
default to 8. Per-file replacement counts and patch-set byte totals are fixed
host policy constants rather than project data, because they bound host work
rather than express operator intent.

`POLICY_VERSION` advances because the plan approval digest now binds a target
set. A run planned under the previous policy version cannot be approved under
this one; it must be replanned. This is deliberate: an approval must never
survive a change in what it authorizes.

### Storage

Schema version 2 adds patch-set and checkpoint-file persistence. The migration
follows the established pattern: it is refused unless the operator supplies the
exact one-shot approval token after taking a verified backup, and it never runs
automatically against live state. Runs persisted under schema v1 remain
readable as single-file patch sets; their rows are not rewritten.

## Alternatives rejected

- **Whole-file content for `modify`.** Simpler to validate, but it discards the
  exactly-once replacement guarantee, invites silent unrelated rewrites inside
  an approved file, and multiplies token cost on large files.
- **Filesystem-atomic multi-file application.** POSIX offers no multi-path
  atomic rename. Claiming atomicity we cannot implement would be exactly the
  kind of false completion claim this repository refuses; staged application
  plus compensating rollback plus a restorable checkpoint is what is actually
  provable.
- **Approving the patch set instead of the target set.** Approval would then
  arrive after the model had already written content, collapsing the plan gate
  into the edit gate and removing the operator's ability to bound authority
  before generation.
- **Letting the plan name files outside the operator's selection.** Their
  contents are not in the approved context, so the edit call would either
  proceed blind or ship unapproved repository bytes to a provider.
- **A second egress gate between plan approval and execution.** It would make
  model-chosen files possible today, at the cost of an extra human decision on
  every remote run and a second approval state to recover through. The same
  capability arrives with retrieval, where one re-assembled context can be
  approved once.
- **Unbounded target sets.** An approved set with no ceiling is an unbounded
  agent with extra steps.
- **New `SunCeiling` fields for patch limits.** Every persisted project ceiling
  is validated against an exact shape by the store, the API, and the browser.
  Adding a required field would invalidate existing project rows on read for no
  operator-visible benefit.
- **Artifact-store checkpoint content.** Splitting restore across SQLite and the
  artifact store adds a second failure domain to the one operation that must
  work when everything else has failed.
- **First-class rename in this revision.** Rename introduces path-pair identity
  into every evidence surface at the same time as multi-file support. Delete
  plus create is expressible today and reviewable as two ordinary rows.

## Consequences and review trigger

Runs can express real changes, and the eval catalog's multi-file repair class
becomes measurable instead of declared unsupported. The blast radius of a
single approval grows from one file to an operator-approved, ceiling-bounded
set, and every widening step is visible in the plan the operator approves.

Cost: application is no longer a single rename, so partial-application recovery
becomes a first-class path with its own tests rather than an impossibility.
Diff, review, and checkpoint evidence grow with the number of changed files and
remain bounded by the existing per-file and aggregate ceilings.

This ADR does not add an agent loop, tool use, capability grants beyond the
approved target set, commit/push/deployment authority, package installation,
network access, or browser mutation authority. Those remain separate decisions.

Review this record when a bounded agent loop proposes successive patch-set
revisions inside one run, when rename or binary content acquires a real use
case, or when measured repositories justify a ceiling above 64 files.
