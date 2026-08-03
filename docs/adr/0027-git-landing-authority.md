# ADR 0027: Git landing authority

- Status: Accepted
- Date: 2026-07-31
- Depends on: [ADR 0003](0003-detached-worktree-single-file.md) (private,
  hardlink-free Git cache and source-checkout isolation),
  [ADR 0023](0023-transactional-multi-file-patch-sets.md) (tree checkpoints
  and exact reviewed diffs), [ADR 0026](0026-agent-session-loop-and-tool-registry.md)
  (host-owned authority), and
  [ADR 0036](0036-proof-carrying-software-factory-product-direction.md)
  (Verified Change Gate)
- Related: [ADR 0029](0029-browser-approval-authority.md) (narrow browser
  action transport)
- Normative record contract:
  [Git landing v1 record contract](0027-git-landing-v1-record-contract.md)
- Implementation checkpoint (2026-08-02): Packet 3 implements and tests the
  durable local path through `local_ready`, including bounded attempts,
  digest-bound decision, deterministic candidate construction, absent-only
  private-ref creation/reconciliation, shared presentation, and explicit crash
  recovery. The GitHub gateway, remote receipts, credential-gated live evidence,
  and any existing/live database migration remain Packet 4 or operator-gated
  work; this checkpoint does not complete Gate 1.

- Supersedes: only the unaccepted landing-state proposal in
  [`FABLE_ICARUS_VISION.md`](../FABLE_ICARUS_VISION.md), specifically its
  proposed `completed -> landing -> landed` run transitions, ordinary
  credentialed Git push, diff-only landing approval, and automated landed-
  branch rollback wording. The Fable document's historical audit and all
  unrelated roadmap material remain point-in-time context; no accepted ADR is
  superseded.

## Context

An Icarus run can end in `completed` with an exact base commit, approved plan,
tree checkpoint, passing verification, reviewed Git diff, and private Git
cache. It still has no governed way to turn that evidence into a branch and a
draft pull request.

Landing is not another run phase. `completed` is the immutable proof boundary
that review accepted. A remote branch or pull request can be created later,
fail independently, be changed by a human, or require reconciliation after a
lost response. Rewriting the run to `landing` would make settled review truth
depend on mutable provider state. It would also make a completed run active
again after the store has deliberately released the project's active-run slot.

The existing run operation ledger is also the wrong recovery boundary.
Execution operations consume the run's provider, token, cost, and runtime
ceilings. A completed run may have legitimately consumed those ceilings before
landing starts, while a GitHub request can have succeeded even when Icarus did
not receive its response. Remote delivery needs its own durable intent,
reconciliation, and receipt.

The original Fable sketch left four unsafe ambiguities:

1. a reviewed-diff digest did not bind the repository, base branch, candidate
   commit, pull-request text, or authorized effects;
2. an ordinary credentialed `git push` would have widened the current
   credential-free, network-disabled Git controller into a general remote
   command surface;
3. a retry could not distinguish a branch or pull request created by the
   interrupted attempt from one that predated Icarus; and
4. “rollback” could be read as authority to delete a remote branch or close a
   pull request, neither of which is reversible or granted here.

GitHub v1 therefore uses its official, narrow REST surfaces:
[Git Database](https://docs.github.com/en/rest/git),
[blobs](https://docs.github.com/en/rest/git/blobs),
[trees](https://docs.github.com/en/rest/git/trees),
[commits](https://docs.github.com/en/rest/git/commits),
[references](https://docs.github.com/en/rest/git/refs), and
[pull requests](https://docs.github.com/en/rest/pulls/pulls).
The REST Git Database uploads immutable, initially unreachable objects.
`POST .../git/refs` then creates one absent-only branch reference atomically.
There is no ordinary Git push in this design.

## Decision

### Landing is a separate, one-per-run lifecycle

A `LandingRecord` belongs to one immutable completed run, but the run remains
`completed` throughout landing and after success. Landing has its own state,
events, decisions, operations, and receipt in the same SQLite database.

Version 1 permits at most one landing record per run. `rejected` and
`abandoned` records are terminal; a later materially different attempt requires
a new run. This makes every landing ID, approval, remote marker, and recovery
decision unambiguous.

The landing state machine is closed:

```text
preparing_candidate -> awaiting_approval | abandoned | failed
awaiting_approval   -> approved | rejected | abandoned
approved            -> creating_local_ref | failed
creating_local_ref  -> local_ready | reconciliation_required | failed
local_ready         -> uploading_objects | failed
uploading_objects   -> objects_ready | reconciliation_required | failed
objects_ready       -> creating_remote_ref | reconciliation_required | failed
creating_remote_ref -> remote_ready | reconciliation_required | failed
remote_ready        -> opening_draft_pr | reconciliation_required | failed
opening_draft_pr    -> landed | reconciliation_required | failed
failed              -> abandoned when resume_state = preparing_candidate and
                       no approval or post-candidate effect intent exists;
                       otherwise its persisted resume_state, by explicit
                       resume only
reconciliation_required
                    -> a proven stage result or the exact retry stage,
                       by explicit reconciliation only
```

`landed`, `rejected`, and `abandoned` are terminal. A deterministic refusal
before the current operation can have an effect—or after a result that
definitively proves the current operation had none and the kind's retry policy
still permits another attempt—may enter `failed` with its stable pre-state in
`resume_state`; prior proven stage effects remain intact. Pull-request creation
is stricter: `opening_draft_pr -> failed` is legal only before any
`github.pull_request.post` request is admitted. Once that POST is admitted,
the operation either reaches `landed` through the exact completed-boundary
proof or enters `reconciliation_required`; a definitively failed HTTP response
cannot produce the completed proof. It never enters retryable `failed` or
returns to `remote_ready` through failed-state resume. Any uncertain local-ref,
GitHub-object, remote-ref, or pull-request outcome enters
`reconciliation_required`; it never becomes a guessed success or a blind
retry.

`resume_state` is always a retry-safe stable pre-state, never an in-progress
action state. A `failed` landing may pair it with exactly
`preparing_candidate`, `approved`, `local_ready`, `objects_ready`, or
`remote_ready`; deterministic failure persisted before an uncertain effect is
the only way to create that pair. A `reconciliation_required` landing may pair
it with exactly `approved`, `local_ready`, `objects_ready`, or `remote_ready`.
The authoritative latest reconciliation-establishing result identifies one
current settled interrupted subject operation and kind; neither a caller nor
an older interrupted operation may choose the subject.
Explicit failed-state resume consumes the marker and returns to that stable
state. Explicit reconciliation may consume it only after proving either the
stage result or that retrying the exact subject is safe. In particular, a
create-PR request that reached admission can reconcile to `landed` when one
exact PR is proven, but it can never consume `remote_ready` to authorize a
second create-PR POST; all other observations remain
`reconciliation_required`.

No startup path automatically resumes a landing. A new process presents the
durable state and requires an explicit `landing resume` action. An HTTP
disconnect is not cancellation. A process signal can interrupt local work or
an HTTPS exchange, but it never authorizes a compensating remote mutation.

### Eligibility binds immutable completed-run evidence

Creating a landing first acquires the existing kernel-backed lease for the run
and, inside SQLite transactions, requires all of the following:

- the run is `completed`;
- it has one approved review decision for the current diff;
- its latest recorded verification is passing and binds the same diff and
  checkpoint digests;
- its plan, checkpoint, patch-set paths, and persisted diff are present and
  internally consistent;
- the private cache still has the recorded identity and contains the exact
  40-hex base commit;
- no run operation is active or interrupted; and
- no landing already exists for the run.

The landing copies these facts into its own immutable snapshot:

```text
runId
projectId
baseCommitSha1
baseTreeSha1
planSha256
diffSha256
checkpointSha256
verificationSha256
reviewDecisionId
reviewDecisionSha256
changedPaths = <canonical sorted path array>
changedPathsSha256
```

The service recalculates every SHA-256 digest from the persisted bytes rather
than trusting a digest column alone. It reconstructs the candidate from the
tree checkpoint, not from the mutable source checkout and not from whatever
bytes happen to be in the private worktree. It then regenerates the canonical
Git diff from the candidate index and requires byte equality with the diff the
operator reviewed. Candidate preparation later adds the outgoing-byte
credential-audit digest before the landing can become approvable.

The source checkout is never a landing input. It may have advanced after the
run completed; landing neither resets it nor reads unreviewed content from it.
Source content, refs, configuration, index, and linked-worktree metadata must
have an identical before/after fingerprint in acceptance tests.

### Rollback interlocks with landing under the same run lease

Run rollback and every landing mutation use the same kernel-backed run lease.
The final SQLite transaction independently rechecks both domains.

- A landing with no approval and no effect intent beyond candidate preparation
  may be atomically marked `abandoned` by an approved run rollback.
- A `rejected` or already `abandoned` landing does not block run rollback.
- Once a landing approval is recorded, or any local-ref/provider effect intent
  has begun, run rollback fails with a stable landing-conflict code.
- Landing creation fails once rollback has begun or the run is no longer
  `completed`.

This interlock prevents a restored worktree from invalidating evidence while an
approved landing coordinator is acting on that evidence. It does not imply
remote rollback. Icarus v1 never deletes a local or remote branch, closes a pull
request, force-pushes, or rewrites a remote ref automatically.

### The GitHub landing profile is operator-authored and project-bound

GitHub v1 has one current landing profile per project:

```ts
interface GitHubLandingProfileV1 {
  readonly version: 1;
  readonly provider: "github";
  readonly owner: string;
  readonly repository: string;
  readonly baseBranch: string;
  readonly branchNamespace: "icarus/";
  readonly credentialRef: {
    readonly kind: "environment";
    readonly name: string;
  };
  readonly expectedActor: string;
  readonly commitIdentity: {
    readonly name: string;
    readonly email: string;
  };
  readonly derivativeEffects: {
    readonly version: 1;
    readonly disposition: "inert-repository" | "operator-approved";
    readonly evidenceSha256: string;
  };
}
```

Only an operator CLI maintenance command may create or replace a profile.
Provider output, plans, tools, browser request bodies, repository files, and
room participants cannot author or widen it. Profile writes are Linux-only in
v1. A landing snapshots the exact canonical profile JSON and SHA-256 digest;
later profile edits cannot reinterpret an existing landing.

The host validates bounded UTF-8 and canonical GitHub owner, repository,
branch, actor, commit-name, and email forms. It validates
`refs/heads/<baseBranch>` as one branch ref and forbids control characters,
URL syntax, credentials, query/fragment bytes, dot-segment ambiguity, and
secret-shaped values. Owner, repository, and expected actor are canonicalized
to lowercase ASCII; the base branch remains case-sensitive. Commit identity is
printable ASCII in v1 and excludes `<`, `>`, CR, LF, NUL, and ambiguous
leading/trailing whitespace so the local and GitHub commit encodings cannot
diverge. The credential-reference name must match the dedicated Icarus
GitHub-token environment-name policy and an operator startup allowlist.
`derivativeEffects.evidenceSha256` is a lowercase SHA-256 of the operator's
repository-automation assessment. `inert-repository` attests that the dedicated
target has no workflow, webhook, bot, notification, or deployment rule driven
by branch creation or draft-PR opening; `operator-approved` records explicit
human acceptance of those configured consequences. Icarus does not infer
either disposition from incomplete API visibility.

Neither an API origin nor a clone URL appears in the profile. Production code
hard-codes:

```text
https://api.github.com
https://github.com
```

The second origin is used only to reconstruct a receipt URL. No profile,
request, redirect, provider response, Git config, or environment variable may
replace either origin.

### Candidate construction is deterministic and file-only

Candidate preparation is local and may occur before landing approval because
it creates only content-addressed, unreachable objects inside the
Icarus-private cache. It grants no ref, network, credential, source-checkout,
merge, or deployment effect.

GitHub v1 accepts only Git's SHA-1 object format. Before the first candidate
intent, the private cache must report exactly `sha1` from
`git rev-parse --show-object-format`; every base, tree, blob, commit, and
provider object ID must be lowercase 40-hex. A SHA-256 repository, an
unrecognized format, or a mixed/ambiguous response fails closed with
`UNSUPPORTED_GIT_OBJECT_FORMAT` before credential resolution or network.
Git SHA-1 is provider object identity, not approval security: all Icarus
authority and evidence digests remain SHA-256.

Landing initiation persists, before any Git object write:

- the completed-run evidence and profile snapshot;
- the exact fully qualified head ref
  `refs/heads/icarus/<run-uuid>`;
- a bounded exact commit message;
- a fixed whole-second UTC author/committer timestamp;
- a bounded exact draft-pull-request title and body prefix;
- SHA-256 digests of those text fields; and
- the candidate-preparation operation intent.

Version 1 fixes these UTF-8 byte limits:

```text
commit message              4 KiB
pull-request title          256 bytes
pull-request body prefix    32 KiB
```

The commit message and body prefix may contain LF but not NUL or other control
bytes. The title canonicalizer requires well-formed Unicode, normalizes to
NFC, rejects CR, LF, NUL, and every other control byte, then requires both
`title.trim().length > 0` under the pinned ECMAScript runtime and a UTF-8 byte
length from 1 through 256 inclusive. It preserves the accepted bytes and never
trims them. Normalization is explicit and happens before digesting, so an
accepted byte string is never silently trimmed or rewritten.

Commit identity comes only from the snapshotted profile. Author and committer
are identical in v1. Names, email, timestamp, and message are normalized before
the intent is stored; retries reuse the stored bytes and instant rather than
the wall clock.

Commit encoding is exact in v1. The commit-message canonicalizer first requires
well-formed Unicode, normalizes it to NFC, maps CRLF and bare CR to LF, rejects
every remaining control byte except LF, and appends one LF only when the result
does not already end in LF. Before that append, the normalized message must
satisfy `message.trim().length > 0` under the pinned ECMAScript runtime. It does
not otherwise trim spaces or collapse existing terminal LFs. The resulting
UTF-8 bytes are what the UI displays, SQLite stores, SHA-256 digests, local Git
hashes, and the GitHub JSON `message` field carries.

`commitEpochSeconds` is a safe integer from `0` through `253402300799`
inclusive. Its local Git form is unsigned base-10 with no leading zero except
the value `0`, followed by the fixed timezone `+0000`. Its GitHub form is the
same instant formatted as exactly `YYYY-MM-DDTHH:mm:ssZ` in UTC, with a
four-digit year and no fractional seconds. The exact ISO-8601 string is stored
with the epoch and their round-trip equality is validated before candidate
construction or network.

The unsigned commit payload is these UTF-8/ASCII bytes in this exact order,
with one LF after every header and one empty separator line:

```text
tree {candidateTreeSha1}\n
parent {baseCommitSha1}\n
author {commitName} <{commitEmail}> {commitEpochSeconds} +0000\n
committer {commitName} <{commitEmail}> {commitEpochSeconds} +0000\n
\n
{canonical commit-message bytes}
```

Braces mark metavariables and are not emitted; the angle brackets immediately
surrounding `commitEmail` are literal Git syntax. Name and email are the
already validated printable-ASCII profile bytes, with no escaping or further
normalization. The stored
`candidateCommitPayloadSha256` hashes this payload. `candidateCommitSha1` is
the SHA-1 of `commit <decimal-payload-byte-length>\0` followed by the payload,
and `git hash-object -t commit -w --stdin` must return that same value.

The GitHub create-commit body carries no signature or optional fields and is
exactly the structured value:

```json
{
  "message": "<canonical commit-message string>",
  "tree": "<candidateTreeSha1>",
  "parents": ["<baseCommitSha1>"],
  "author": {
    "name": "<commitName>",
    "email": "<commitEmail>",
    "date": "<YYYY-MM-DDTHH:mm:ssZ>"
  },
  "committer": {
    "name": "<commitName>",
    "email": "<commitEmail>",
    "date": "<YYYY-MM-DDTHH:mm:ssZ>"
  }
}
```

The gateway requires GitHub's returned commit SHA to equal the locally
calculated `candidateCommitSha1`. Gate 1 acceptance includes a credential-gated
real-GitHub vector proving this equality; a mocked transport is not sufficient
evidence for the encoding contract.

The local candidate builder remains credential-free and network-disabled. It
receives a private-cache handle plus the immutable candidate intent; it cannot
receive a URL, credential, remote name, refspec, or arbitrary Git arguments. It
uses only fixed plumbing:

1. set a controller-owned temporary `GIT_INDEX_FILE` outside the worktree;
2. `read-tree` the exact base commit;
3. decode each checkpoint's approved bytes, hash them with
   `hash-object --no-filters -t blob -w --stdin`, and place normal-file mode
   `100644` entries with `update-index --index-info`;
4. remove checkpoint deletions from that temporary index;
5. generate the same sorted-path, binary, no-ext-diff, no-textconv, no-renames
   cached diff and require byte equality with the reviewed persisted diff;
6. `write-tree` and require the resulting tree contains exactly the base tree
   plus the approved create/modify/delete operations; and
7. build the canonical unsigned commit bytes with exactly one parent, the base
   commit, then store them using
   `hash-object -t commit -w --stdin`.

The builder disables system/global config, hooks, filters, attributes that
would transform content, credential helpers, prompts, pagers, signing, replace
objects, alternates outside the private cache, SSH, and network protocols. It
does not run `git add`, `git commit`, `git checkout`, `git switch`, or
`git push`. The temporary index is removed after success or interruption.
Unreachable objects left by a crash are harmless; replaying the persisted
intent must produce the same blob, tree, and commit IDs.

The outgoing changed blobs, commit message, pull-request title, and
pull-request body prefix pass the existing secret/credential audit policy
before the landing digest is calculated. A finding is a fail-closed error in
v1; landing approval is not a secret waiver. The body-prefix validator also
rejects the reserved ASCII substring `<!-- icarus-landing:` so operator text
cannot manufacture a second authority marker.

### The landing digest authorizes the exact delivery

After candidate construction and audit, one canonical
`landingSha256 = digestJson(LandingDigestV1)` binds the exact record defined by
the [normative v1 companion](0027-git-landing-v1-record-contract.md). Its
closed keys and types represent:

```text
policyVersion = 1
githubApiVersion = "2026-03-10"
landingId, runId, projectId
baseCommitSha1, baseTreeSha1
planSha256, diffSha256, checkpointSha256
verificationSha256, reviewDecisionId, reviewDecisionSha256
changedPaths, changedPathsSha256
candidateCredentialAuditSha256
profileVersion, profileSha256, complete profile snapshot
objectFormat = "sha1"
candidateParentSha1, candidateTreeSha1, candidateCommitSha1
candidateCommitPayloadSha256
candidateObjectManifestSha256
commitMessageSha256
commit author name/email, committer name/email, UTC epoch and exact ISO-8601
instant
baseRef = refs/heads/<profile.baseBranch>
expectedRemoteBaseSha1 = baseCommitSha1
headRef = refs/heads/icarus/<run-uuid>
pullRequestTitleSha256
pullRequestBodyPrefixSha256
pullRequestMarkerVersion = 1
draft = true
maintainerCanModify = false
directIcarusEffects = [
  "local_ref.create",
  "github.objects.upload",
  "github.ref.create",
  "github.draft_pull_request.create"
]
derivativeEffectDisclosure = {
  version = 1,
  githubEvents = ["create", "pull_request.opened"],
  mayTrigger = [
    "actions", "webhooks", "bots", "notifications", "deployments"
  ],
  disposition = profile.derivativeEffects.disposition,
  evidenceSha256 = profile.derivativeEffects.evidenceSha256
}
```

The companion's exact record, rather than this explanatory field projection,
is authoritative. Arrays and object keys use the repository's canonical JSON
rules. There are no optional effect fields, implicit defaults,
provider-selected strings, or diff-only compatibility path.

`directIcarusEffects` is exhaustive for post-approval delivery mutations
authorized by this landing decision. Fixed authenticated actor, ref, and
pull-request-list reads are supporting observations and do not mutate
repository state. Pre-approval private-cache object construction and local
SQLite evidence writes are not delivery effects authorized by the decision.
GitHub branch creation emits a repository `create` event, and opening a draft
pull request emits a `pull_request` event. Repository-configured Actions,
webhooks, bots, notifications, or downstream deployment systems may react.
The approval surface displays that fixed warning plus the bound disposition
and evidence digest before accepting `landingSha256`. Icarus neither claims
to suppress those derivative effects nor gains authority to invoke their
endpoints directly.

The final pull-request body is derived without a circular digest. The
normative companion fixes the exact UTF-8 concatenation, unconditional LFs,
40-KiB ceiling, and host-generated evidence lines; structurally it is:

```text
<exact approved body prefix>

<host-generated bounded evidence block>

<!-- icarus-landing:v1:<landing-id>:<landing-sha256> -->
```

The landing digest binds the body prefix digest, every exact evidence-block
input, and marker version. After the landing digest exists, the service
derives and stores the final-body SHA-256 for the exact HTTPS request. It
recomputes the authority record, final renderer, and stored body digest before
recording the landing decision and again before the create-PR effect. The UI
and CLI display the complete derived body before approval.

Landing approval is a separate typed `LandingDecision`, not a plan-carried
capability grant and not an added kind in the run `approvals` table. The
operator approves or rejects the exact landing digest. Approval also consents
to sending the bound changed blobs and pull-request metadata to the bound
GitHub repository. The decision transaction rechecks the landing state,
version, digest, immutable run evidence, and absence of another decision.
Repeating an identical decision is idempotent; a different actor, digest, or
decision conflicts.

### The local branch is one absent-only private-cache ref

After approval, Icarus creates only:

```text
refs/heads/icarus/<run-uuid>
```

inside the run's private bare cache. It never creates or changes a source-
checkout ref, symbolic ref, tag, note, remote-tracking ref, default branch,
index, or worktree.

The coordinator first observes the exact named local ref without dereferencing
it. It runs fixed `git symbolic-ref --quiet --no-recurse <ref>` and rejects any
symbolic ref, including a dangling one; it then uses the fixed exact-ref read
to distinguish one direct object ID from absence. Unexpected exit status,
malformed output, a non-commit target, duplicate observation, or any ref/path
anomaly fails closed. If the named direct ref is absent, it persists that
observation and a `local_ref.create` operation intent before invoking:

```text
git update-ref --no-deref refs/heads/icarus/<run-uuid> <candidate-commit> 0000000000000000000000000000000000000000
```

`--no-deref` and the zero old object ID are both mandatory: the compare-and-
swap creates only the named ref and cannot follow a symbolic ref to another
target. An existing different or symbolic ref is a permanent conflict. An
existing exact direct ref is also a conflict on a first attempt; Icarus may
reconcile it only when this landing's durable operation proves both a prior
absence observation and an interrupted create intent. After the command,
Icarus repeats the non-dereferencing symbolic-ref check plus exact direct-ref
read and records the exact result.

### GitHub publication is a narrow HTTPS gateway, never Git push

The existing `GitController` remains credential-free, local-only, and unable to
execute arbitrary arguments. Landing adds two narrower boundaries:

- a private candidate builder that can perform only the fixed local plumbing
  above; and
- a GitHub v1 gateway that can perform only fixed HTTPS requests for actor
  verification, exact ref observation, immutable Git Database object creation,
  absent-only reference creation, pull-request observation, and exact draft-
  pull-request creation.

Production gateway methods accept validated value objects, not URLs, route
fragments, Git arguments, headers, or serialized HTTP bodies. The gateway
constructs every method, path, query, header, and JSON body itself. It sets a
fixed `X-GitHub-Api-Version: 2026-03-10` and
`Accept: application/vnd.github+json`, rejects redirects, applies bounded
connect/request timeouts and response sizes, and disables automatic mutation
retries. Tests may inject a transport behind this interface; production origin
selection is not injectable from user or repository state. Changing the API
version changes the landing policy version and invalidates old unapproved
landing digests rather than silently changing their wire semantics. An already
approved older landing must keep its bound gateway version or stop in
`reconciliation_required`; it may not resume through newer wire semantics.

There is no named Git remote, credential helper, askpass program, `gh`
subprocess, SSH command, pack protocol, refspec, force option, deletion option,
tag upload, merge, deployment, or default-branch mutation. “Publish” in this
ADR means the exact REST Git Database and reference operations below, not
ordinary `git push`. This is the provider-specific refinement of ADR 0036's
product-level “allowlisted push” wording; it preserves that product outcome
while narrowing the implementation authority.

### Credentials are projected only into exact HTTPS requests

The database stores only the allowlisted environment-variable name from the
profile. It never stores the credential value. Immediately before one bounded
GitHub attempt, the coordinator:

1. proves Linux support, landing approval, current state, operation ceiling,
   and exact profile/landing digests;
2. resolves that one allowlisted environment value into process memory;
3. creates a gateway-scoped `Authorization: Bearer ...` header for
   `https://api.github.com` only;
4. calls `GET /user` and requires the canonical returned login to equal the
   profile's `expectedActor`; and
5. drops the scoped credential when the attempt completes or fails.

A resumed attempt resolves a fresh value and verifies the actor again. The
credential is never placed in SQLite, an artifact, event, receipt, URL,
redirect, argv, child-process environment, Git config, exception detail,
request/response log, telemetry field, browser response, or test snapshot.
Authorization and other sensitive response headers are never retained.
Provider error bodies are decoded through strict, bounded schemas and reduced
to host-defined safe error codes.

A missing credential fails before an HTTPS request. A wrong actor performs no
mutating request. Least-privilege GitHub contents and pull-request permissions
are an operator deployment requirement; possessing a broader token never
widens the gateway's code-level method set.

### Immutable Git objects are uploaded and verified before any remote ref

The gateway first verifies that the exact remote base ref resolves to
`baseCommitSha1` and that the exact head ref is absent. A pre-existing head is
a conflict even if it points at the candidate; it is never adopted without
this landing's recorded prior-absence proof.

The object-upload intent lists the exact candidate object IDs and SHA-256
digests but no credential or raw provider response. The gateway then uses only:

1. `POST /repos/{owner}/{repository}/git/blobs` for each approved non-deleted
   path, with exact base64 content and `encoding: "base64"`;
2. `POST /repos/{owner}/{repository}/git/trees`, with the exact remote base
   tree plus sorted changed-path entries (`100644`/`blob` and the uploaded SHA,
   or null SHA for a deletion); and
3. `POST /repos/{owner}/{repository}/git/commits`, with the exact message,
   candidate tree, single base parent, author, committer, and timestamp.

Every response must have the strict expected shape. Every returned blob, tree,
and commit SHA must equal the locally calculated SHA-1. A mismatch fails before
remote-ref creation. Repeating an immutable-object POST after an interrupted
attempt uses a new coordinator/operation intent bound to the prior subject and
its reconciliation result. It may repeat only the same immutable
landing/object-manifest subjects and byte-identical wire bodies; content
addressing must produce the same SHA, and no ref becomes reachable as a side
effect.

Immediately before remote-ref creation, the gateway re-verifies the expected
actor, exact base ref SHA, and absent head ref. The coordinator durably records
those observations and the `github.ref.create` intent, then sends exactly:

```http
POST /repos/{owner}/{repository}/git/refs

{
  "ref": "refs/heads/icarus/<run-uuid>",
  "sha": "<candidate-commit-sha1>"
}
```

GitHub's create-reference operation is the atomic absent-only boundary. Icarus
never calls update-reference and never supplies `force`. After the POST it
queries both the exact head ref and the current base ref. It records
`remote_ready` only when the head is the candidate commit and the base still
equals the approved base commit.

GitHub's create-reference request cannot conditionally compare the base SHA.
The base can therefore advance after Icarus's preflight and before GitHub
creates the ref. If the post-POST reads observe that race, the landing enters
`reconciliation_required`: an exact created branch is preserved and reported
as remote residue; an absent branch proves no ref effect but still cannot be
created against the drifted base. The same rule applies if the response is
lost. Icarus never claims that the preflight prevented the race, and it never
rebases, merges, deletes, or rebuilds the reviewed candidate silently.

### Draft pull-request creation is exact and marker-bound

Before creating a pull request, the gateway again requires:

- the expected authenticated actor;
- the base ref still at the approved base commit;
- the head ref at the exact candidate commit; and
- no pull request in any state for the exact repository, owner-qualified head,
  and base branch.

The absence observation and `github.pull_request.create` intent are persisted
before the POST. The request body is exactly:

```text
title                 = approved title bytes
head                  = <owner>:icarus/<run-uuid>
base                  = profile.baseBranch
body                  = derived body with exact v1 marker
draft                 = true
maintainer_can_modify = false
```

No issue number, alternate repository, fork, labels, reviewers, assignees,
milestone, merge mode, auto-merge, ready-for-review transition, or update
operation is accepted.

Success requires a subsequent exact pull-request read proving one open draft
pull request with:

- the expected repository owner and name;
- the exact head ref and candidate SHA;
- the exact base ref and approved base SHA;
- the exact title, final-body SHA-256, and one exact landing marker;
- `draft: true`; and
- `maintainer_can_modify: false`.

The gateway also re-reads the current base ref after the create-PR POST and
requires it still to equal the approved base commit before recording `landed`.
GitHub accepts only a base branch name when creating a pull request; it does
not conditionally compare the approved base SHA. A base move racing the POST
can therefore leave an exact or drifted draft pull request. Icarus preserves
and reports that remote residue as `reconciliation_required`; it does not
claim that its preflight prevented creation, and it never updates or closes
the pull request automatically.

The pull-request number is a bounded positive integer. The receipt URL is
reconstructed as
`https://github.com/<owner>/<repository>/pull/<number>` rather than trusted
from provider-supplied HTML or API URLs.

Reconciliation queries all pull-request states by exact owner-qualified head
and base using fixed `state=all`, `head`, `base`, `per_page=100`, and first-page
parameters. A next-page indication or a full 100-item response is a bounded
ambiguity and fails closed rather than treating a truncated result as absence.
It accepts exactly one object only when the landing has a durable prior-absence
observation and create intent and every identity above matches. Version 1
admits at most one create-PR POST per landing. If no
`landing.github.request.admitted` event exists for that POST, the coordinator
may repeat the current preflight and admit the one request. Once that event
exists, a lost or ambiguous response is never retried: zero visible objects is
not proof that GitHub did not or will not create the first request. Zero,
multiple, closed/non-draft, mismatched-marker, or otherwise drifted results
remain `reconciliation_required`; Icarus does not send another create-PR
request and does not edit or close a provider object.

### Durable schema and effect intents

All landing state lives in the existing `icarus.sqlite3`; there is no second
database or provider response cache. The v1 additive schema is exactly:

```sql
CREATE TABLE landing_profiles (
  project_id TEXT PRIMARY KEY REFERENCES projects(id),
  profile_version INTEGER NOT NULL CHECK(profile_version = 1),
  provider TEXT NOT NULL CHECK(provider = 'github'),
  owner TEXT NOT NULL,
  repository TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  branch_namespace TEXT NOT NULL CHECK(branch_namespace = 'icarus/'),
  credential_env TEXT NOT NULL,
  expected_actor TEXT NOT NULL,
  commit_name TEXT NOT NULL,
  commit_email TEXT NOT NULL,
  derivative_effects_disposition TEXT NOT NULL CHECK(
    derivative_effects_disposition IN ('inert-repository', 'operator-approved')
  ),
  derivative_effects_evidence_sha256 TEXT NOT NULL,
  profile_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE landings (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE REFERENCES runs(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  policy_version INTEGER NOT NULL CHECK(policy_version = 1),
  state TEXT NOT NULL CHECK(state IN (
    'preparing_candidate',
    'awaiting_approval',
    'approved',
    'creating_local_ref',
    'local_ready',
    'uploading_objects',
    'objects_ready',
    'creating_remote_ref',
    'remote_ready',
    'opening_draft_pr',
    'landed',
    'reconciliation_required',
    'rejected',
    'abandoned',
    'failed'
  )),
  resume_state TEXT CHECK(resume_state IS NULL OR resume_state IN (
    'preparing_candidate',
    'approved',
    'local_ready',
    'objects_ready',
    'remote_ready'
  )),
  profile_json TEXT NOT NULL,
  profile_sha256 TEXT NOT NULL,
  base_commit_sha1 TEXT NOT NULL,
  base_tree_sha1 TEXT NOT NULL,
  plan_sha256 TEXT NOT NULL,
  diff_sha256 TEXT NOT NULL,
  checkpoint_sha256 TEXT NOT NULL,
  verification_sha256 TEXT NOT NULL,
  review_decision_id TEXT NOT NULL REFERENCES approvals(id),
  review_decision_sha256 TEXT NOT NULL,
  changed_paths_json TEXT NOT NULL,
  changed_paths_sha256 TEXT NOT NULL,
  credential_audit_sha256 TEXT,
  head_ref TEXT NOT NULL,
  commit_message TEXT NOT NULL,
  commit_message_sha256 TEXT NOT NULL,
  commit_epoch_seconds INTEGER NOT NULL,
  commit_iso8601 TEXT NOT NULL,
  pull_request_title TEXT NOT NULL,
  pull_request_title_sha256 TEXT NOT NULL,
  pull_request_body_prefix TEXT NOT NULL,
  pull_request_body_prefix_sha256 TEXT NOT NULL,
  pull_request_body_sha256 TEXT,
  candidate_tree_sha1 TEXT,
  candidate_commit_sha1 TEXT,
  candidate_commit_payload_sha256 TEXT,
  landing_sha256 TEXT,
  error_code TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(
    typeof(attempt_count) = 'integer' AND attempt_count BETWEEN 0 AND 8
  ),
  version INTEGER NOT NULL DEFAULT 0 CHECK(
    typeof(version) = 'integer' AND
    version BETWEEN 0 AND 9007199254740991
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(
    (state NOT IN ('failed', 'reconciliation_required') AND
      resume_state IS NULL) OR
    (state = 'failed' AND resume_state IS NOT NULL AND resume_state IN (
      'preparing_candidate', 'approved', 'local_ready',
      'objects_ready', 'remote_ready'
    )) OR
    (state = 'reconciliation_required' AND resume_state IS NOT NULL AND
      resume_state IN (
      'approved', 'local_ready', 'objects_ready', 'remote_ready'
    ))
  )
);

CREATE INDEX landings_by_project_updated
ON landings(project_id, updated_at DESC, id DESC);

CREATE TABLE landing_decisions (
  id TEXT PRIMARY KEY,
  landing_id TEXT NOT NULL UNIQUE REFERENCES landings(id),
  landing_sha256 TEXT NOT NULL,
  actor TEXT NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('approve', 'reject')),
  created_at TEXT NOT NULL
);

CREATE TABLE landing_attempts (
  landing_id TEXT NOT NULL REFERENCES landings(id),
  ordinal INTEGER NOT NULL CHECK(
    typeof(ordinal) = 'integer' AND ordinal BETWEEN 1 AND 8
  ),
  status TEXT NOT NULL CHECK(status IN (
    'started', 'completed', 'failed', 'interrupted'
  )),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error_code TEXT,
  PRIMARY KEY(landing_id, ordinal),
  CHECK(
    (status = 'started' AND finished_at IS NULL AND error_code IS NULL) OR
    (status = 'completed' AND finished_at IS NOT NULL AND
      error_code IS NULL) OR
    (status IN ('failed', 'interrupted') AND finished_at IS NOT NULL AND
      error_code IS NOT NULL)
  )
);

CREATE UNIQUE INDEX one_started_landing_attempt
ON landing_attempts(landing_id)
WHERE status = 'started';

CREATE TABLE landing_operations (
  id TEXT PRIMARY KEY,
  landing_id TEXT NOT NULL REFERENCES landings(id),
  coordinator_attempt INTEGER NOT NULL CHECK(
    typeof(coordinator_attempt) = 'integer' AND
    coordinator_attempt BETWEEN 1 AND 8
  ),
  kind TEXT NOT NULL CHECK(kind IN (
    'candidate.prepare',
    'local_ref.create',
    'github.preflight',
    'github.objects.upload',
    'github.ref.create',
    'github.pull_request.create',
    'landing.reconcile'
  )),
  kind_attempt INTEGER NOT NULL CHECK(
    typeof(kind_attempt) = 'integer' AND kind_attempt BETWEEN 1 AND 9
  ),
  status TEXT NOT NULL CHECK(status IN (
    'started',
    'completed',
    'failed',
    'interrupted'
  )),
  request_sha256 TEXT NOT NULL,
  request_json TEXT NOT NULL,
  observation_sha256 TEXT,
  observation_json TEXT,
  result_sha256 TEXT,
  result_json TEXT,
  error_code TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE(landing_id, kind, kind_attempt),
  UNIQUE(id, landing_id, coordinator_attempt),
  UNIQUE(id, landing_id, coordinator_attempt, kind),
  FOREIGN KEY(landing_id, coordinator_attempt)
    REFERENCES landing_attempts(landing_id, ordinal),
  CHECK(
    (status = 'started' AND finished_at IS NULL) OR
    (status IN ('completed', 'failed', 'interrupted') AND finished_at IS NOT NULL)
  ),
  CHECK(
    (observation_sha256 IS NULL AND observation_json IS NULL) OR
    (observation_sha256 IS NOT NULL AND observation_json IS NOT NULL)
  ),
  CHECK(
    (status = 'started' AND result_sha256 IS NULL AND result_json IS NULL AND
      error_code IS NULL) OR
    (status = 'completed' AND result_sha256 IS NOT NULL AND
      result_json IS NOT NULL AND error_code IS NULL) OR
    (status IN ('failed', 'interrupted') AND result_sha256 IS NOT NULL AND
      result_json IS NOT NULL AND error_code IS NOT NULL)
  )
);

CREATE INDEX landing_operations_by_landing
ON landing_operations(landing_id, coordinator_attempt, kind_attempt, started_at);

CREATE UNIQUE INDEX one_started_landing_operation
ON landing_operations(landing_id)
WHERE status = 'started';

CREATE TABLE landing_http_requests (
  id TEXT PRIMARY KEY,
  landing_id TEXT NOT NULL REFERENCES landings(id),
  operation_id TEXT NOT NULL,
  coordinator_attempt INTEGER NOT NULL CHECK(
    typeof(coordinator_attempt) = 'integer' AND
    coordinator_attempt BETWEEN 1 AND 8
  ),
  operation_kind TEXT NOT NULL CHECK(operation_kind IN (
    'candidate.prepare',
    'local_ref.create',
    'github.preflight',
    'github.objects.upload',
    'github.ref.create',
    'github.pull_request.create',
    'landing.reconcile'
  )),
  request_ordinal INTEGER NOT NULL CHECK(
    typeof(request_ordinal) = 'integer' AND request_ordinal >= 1
  ),
  kind TEXT NOT NULL CHECK(kind IN (
    'github.actor.get',
    'github.base_ref.get',
    'github.head_ref.get',
    'github.pull_requests.get',
    'github.blob.post',
    'github.tree.post',
    'github.commit.post',
    'github.ref.post',
    'github.pull_request.post'
  )),
  method TEXT NOT NULL CHECK(method IN ('GET', 'POST')),
  request_sha256 TEXT NOT NULL,
  request_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('admitted', 'settled')),
  outcome TEXT CHECK(outcome IS NULL OR outcome IN (
    'succeeded', 'failed', 'ambiguous'
  )),
  http_status INTEGER CHECK(
    http_status IS NULL OR (
      typeof(http_status) = 'integer' AND http_status BETWEEN 100 AND 599
    )
  ),
  result_sha256 TEXT,
  result_json TEXT,
  error_code TEXT,
  admitted_at TEXT NOT NULL,
  settled_at TEXT,
  UNIQUE(landing_id, coordinator_attempt, request_ordinal),
  UNIQUE(id, landing_id, coordinator_attempt),
  FOREIGN KEY(operation_id, landing_id, coordinator_attempt, operation_kind)
    REFERENCES landing_operations(id, landing_id, coordinator_attempt, kind),
  CHECK(
    (operation_kind = 'github.preflight' AND method = 'GET' AND kind IN (
      'github.actor.get', 'github.base_ref.get', 'github.head_ref.get',
      'github.pull_requests.get'
    )) OR
    (operation_kind = 'github.objects.upload' AND (
      (method = 'GET' AND kind = 'github.actor.get') OR
      (method = 'POST' AND kind IN (
        'github.blob.post', 'github.tree.post', 'github.commit.post'
      ))
    )) OR
    (operation_kind = 'github.ref.create' AND (
      (method = 'GET' AND kind IN (
        'github.actor.get', 'github.base_ref.get', 'github.head_ref.get'
      )) OR
      (method = 'POST' AND kind = 'github.ref.post')
    )) OR
    (operation_kind = 'github.pull_request.create' AND (
      (method = 'GET' AND kind IN (
        'github.actor.get', 'github.base_ref.get', 'github.head_ref.get',
        'github.pull_requests.get'
      )) OR
      (method = 'POST' AND kind = 'github.pull_request.post')
    )) OR
    (operation_kind = 'landing.reconcile' AND method = 'GET' AND kind IN (
      'github.actor.get', 'github.base_ref.get', 'github.head_ref.get',
      'github.pull_requests.get'
    ))
  ),
  CHECK(
    (status = 'admitted' AND outcome IS NULL AND http_status IS NULL AND
      result_sha256 IS NULL AND result_json IS NULL AND error_code IS NULL AND
      settled_at IS NULL) OR
    (status = 'settled' AND outcome IS NOT NULL AND
      result_sha256 IS NOT NULL AND result_json IS NOT NULL AND
      settled_at IS NOT NULL)
  ),
  CHECK(
    outcome IS NULL OR
    (outcome = 'succeeded' AND http_status IS NOT NULL AND (
      http_status BETWEEN 200 AND 299 OR
      (kind = 'github.head_ref.get' AND http_status = 404)
    ) AND error_code IS NULL) OR
    (outcome = 'failed' AND error_code IS NOT NULL) OR
    (outcome = 'ambiguous' AND http_status IS NULL AND error_code IS NOT NULL)
  )
);

CREATE INDEX landing_http_requests_by_operation
ON landing_http_requests(operation_id, request_ordinal);

CREATE UNIQUE INDEX one_create_pr_post_per_landing
ON landing_http_requests(landing_id)
WHERE kind = 'github.pull_request.post';

CREATE TABLE landing_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  landing_id TEXT NOT NULL REFERENCES landings(id),
  sequence INTEGER NOT NULL CHECK(
    typeof(sequence) = 'integer' AND
    sequence BETWEEN 1 AND 9007199254740991
  ),
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(landing_id, sequence)
);

CREATE TABLE landing_receipts (
  landing_id TEXT PRIMARY KEY REFERENCES landings(id),
  receipt_json TEXT NOT NULL,
  receipt_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

The [normative v1 record contract](0027-git-landing-v1-record-contract.md)
defines every canonical evidence digest, coordinator/kind/request ordinal,
operation request/observation/result, HTTPS admission/result, event payload,
operation-owned request grammar, retry permission, and settlement mapping. It
completes the schema above and is part of this decision.

Exact application validators further require canonical UUIDs, lowercase
40-hex SHA-1, lowercase SHA-256, bounded canonical JSON, state-specific null
and non-null fields, and byte equality between every stored text and digest.
For example, `awaiting_approval` requires the audit, candidate tree, candidate
commit, final pull-request-body digest, and landing digest; no earlier state
may pretend those values exist. `landed` requires one approved decision,
one closed completed-operation-or-reconciliation-chain evidence form for each
of the local-ref, immutable-object, remote-ref, and draft-PR stages, and one
receipt. Completed-operation evidence is a completed effect operation with its
exact stage result.
Reconciled evidence is the interrupted original subject plus an unbroken
settled reconciliation chain whose zero or more unresolved links preserve the
subject and whose one terminal completed result proves the same stage.
The receipt's four outcome fields are derived from those exact forms; an
interrupted original operation is never rewritten as completed.

Every operation and request record must byte-match that companion's strict,
kind-specific, versioned schema. It stores IDs, object digests, refs, exact
attempt/request counters, HTTP method/path identifiers, bounded status codes,
and absence/exact/conflict observations. It never stores credentials,
Authorization headers, raw request bodies that already live in the landing,
raw provider responses, arbitrary provider messages, local paths, repository
bytes, diffs, task text, or environment snapshots.

An operation row with `status = 'started'` is the durable intent. The row and
the transition into its action state commit before any Git write or mutating
HTTPS request. Where absence is a precondition, the exact observation is
written to `observation_json` and an event in a committed SQLite transaction
before the compare-and-swap or POST. The final state transition, bounded
result, event, and operation settlement commit atomically when they are local
to SQLite.

At most one started operation exists per landing. The same run lease prevents
a second process, a run rollback, and a landing coordinator from racing even
before the SQLite index is consulted. The project continues to bound changed
paths and each file; the exact outgoing blob-byte sum must be no greater than
`maxFilesChanged * maxFileBytes`. Additional fixed v1 landing ceilings are:

```text
GitHub response body                    1 MiB
one HTTPS request                       30 seconds
one landing coordinator attempt        10 minutes active runtime
HTTPS requests in one attempt           2 * changedPathCount + 32
explicit attempts over one landing      8
```

Counters are conservative and persist before each request. Redirects and
automatic retries do not receive a hidden allowance. Reaching a ceiling does
not erase intent or manufacture a receipt. The request count is the number of
bounded `landing.github.request.admitted` events, each committed before its
HTTPS request; interrupted runtime is charged from the durable operation
timestamps.

### Receipt is immutable metadata, not provider authority

After exact pull-request verification, one SQLite transaction inserts the
receipt, settles the operation, appends the event, and transitions the landing
to `landed`. The canonical receipt contains only:

```text
version
landingId, runId, projectId
provider = github
owner, repository
baseRef, baseCommitSha1
headRef, candidateTreeSha1, candidateCommitSha1
pullRequestNumber, reconstructedPullRequestUrl
draft = true
landingSha256, profileSha256
planSha256, diffSha256, checkpointSha256, verificationSha256
reviewDecisionSha256
changedPathsSha256
localRefOutcome = created | reconciled
remoteObjectOutcome = created_or_exact
remoteRefOutcome = created | reconciled
pullRequestOutcome = created | reconciled
completedAt
```

The receipt and its SHA-256 digest are immutable. It excludes credential values
and references, local cache/worktree/source paths, commit or pull-request text,
task text, diff/checkpoint bytes, raw provider output, response headers, and
environment data. The pull-request body already carries the fixed evidence
projection and marker; Icarus does not issue a later update merely to add the
receipt's provider-assigned number.

The receipt proves what Icarus verified at settlement. It does not claim that a
human cannot later change, close, merge, or delete GitHub state. A later live-
status feature may report drift without rewriting the receipt.

### Linux is the only mutation platform in v1

macOS and Windows may decode and display landing profiles, landing state,
events, decisions, and receipts. Every profile write, landing creation,
landing decision, landing resume, local-ref write, credential resolution, and
GitHub request is Linux-only.

Unsupported-platform refusal occurs before opening a writable SQLite handle,
admitting an operation, resolving an environment credential, invoking Git, or
making a network request. There is no best-effort file lock or native fallback.

### Migration is additive, exact, and operator-gated

New databases create the landing schema normally. An existing database with
the `runs` table but no landing objects requires exactly:

```text
ICARUS_APPROVE_SCHEMA_MIGRATION=landing-ledger-v1
```

The CLI is the only migration lane. The API/workspace startup path never
supplies migration approval. One token approves only this migration and cannot
be combined with another schema token in the same invocation.

Gate 1 migration order is exact: ADR 0029's
`browser-action-ledger-v1` precedes `landing-ledger-v1`. One migration
invocation is a CLI-only maintenance process that applies and verifies one
schema, then exits before normal runtime startup. Its read-only preflight
classifies both known Gate 1 schema families as wholly absent, exact, or
partial/malformed. If both are absent, a landing-token invocation returns
`MIGRATION_ORDER_REQUIRED` without a WAL or database write. A browser-token
invocation may tolerate the wholly absent landing family but cannot create it;
after that process exits, a second invocation with the landing token may apply
only this ADR's objects. A partial or malformed object in either known family
always fails closed. No delimiter, list, or second environment value can
combine the two tokens.

Before a writable SQLite handle opens, a read-only preflight inspects:

- exact table names, ordered columns, declared types, nullability, defaults,
  primary keys, foreign keys, uniqueness, and check constraints;
- the exact named indexes, column order, sort direction, collation, uniqueness,
  and partial predicate; and
- absence of any unknown partial landing object.

The implementation does not SQLite-open the source database for this
inspection. It fingerprints owned regular main/WAL/SHM files, copies main and
WAL (not transient SHM) into a private `0700` snapshot with `0600` files,
inspects that copy, and then proves the source family still has the same
identity, bytes, and membership. SQLite reconstructs SHM only inside the
snapshot. An unexpected journal/sibling or detected race fails closed, and the
snapshot is removed in `finally` after handled completion or error. An
uncatchable process termination can leave only mode-restricted temporary
residue, never a source-family mutation.

No landing object means `missing`. Every object exactly matching this ADR means
`valid`. A partial table set, extra/missing/reordered column, malformed
constraint, or misdefined index is database corruption and fails closed even
when the token is present.

After all Icarus processes stop, the operator must take and verify a timestamped
backup of the SQLite database plus WAL/SHM siblings and the artifacts, runs,
and locks directories. With the exact token, the store creates all tables and
indexes in one immediate additive transaction. It does not rewrite an existing
row, reinterpret a run, update a project, or perform Git/network work. A
refusal leaves the database byte state untouched.

Schema rollback is full restoration of the verified backup. Database restore
is never remote rollback: once any GitHub effect may have occurred, restoration
must be followed by explicit provider reconciliation for the affected project.
Icarus never deletes a branch or closes a pull request to make restored local
state look consistent.

## Crash and reconciliation matrix

The implementation must inject and prove every boundary below:

| Crash or ambiguous boundary | Required recovery |
| --- | --- |
| Before the landing row transaction | No landing exists and no effect occurred. |
| After landing/candidate intent, before a local object write | Explicit resume rebuilds from the same checkpoint, text, identity, and timestamp. |
| During local blob/tree/commit construction | Remove the temporary index; tolerate unreachable objects; replay must produce identical IDs. |
| Candidate commit written, before candidate settlement | Recompute the same tree/commit, revalidate the exact diff, and settle once. |
| While `awaiting_approval` | No ref, credential, or network action; wait for one exact decision. |
| Approval committed, before coordinator execution | Run remains `completed`; explicit landing resume begins the approved effects once. |
| Local direct-ref absence observed, before `update-ref --no-deref` | Persisted intent permits the same named-ref, zero-old compare-and-swap. Any symbolic ref, including a dangling one, conflicts. |
| During/after `update-ref --no-deref`, before settlement | A still-absent named direct ref permits CAS retry; an exact direct ref plus this landing's prior absence/intent reconciles; symbolic or different refs conflict. |
| Credential missing | No HTTPS request; stable retriable failure without secret-derived persistence. |
| Actor or remote-base mismatch observed before a mutation | No mutating HTTPS request; fail closed with bounded metadata. |
| A head ref exists before Icarus records absence | Conflict even when it equals the candidate; never adopt it. |
| During immutable blob/tree/commit upload | A fresh operation may verify or recreate only objects byte-identical to the prior subject's immutable manifest/wire bodies and must bind that subject plus its reconciliation result; every returned SHA must equal local identity. |
| Objects uploaded, base moves before remote-ref preflight | Preserve unreachable objects; create no remote ref. |
| Base moves after remote-ref preflight but before/during ref POST | Re-read the base and head after the POST. An absent head proves no ref effect but holds for the drifted base; an exact created head is preserved as residue; a different head conflicts. Every case is `reconciliation_required`, never `remote_ready`. |
| Remote-ref absence and intent persisted, before/during ref POST with the base unchanged | Query the exact base and head. Only unchanged base plus absent head permits another create-reference POST; unchanged base plus exact head reconciles; different head or base drift holds. |
| Ref POST response lost | Never call update-reference or force. Query exact ref and apply the same absent/exact/different rule. |
| Remote ref created, base moves before PR preflight | Preserve the remote branch, create no PR, and require human/new-run disposition. |
| Base moves after PR preflight but before/during create-PR POST | Re-read the base and query all pull-request states. Preserve any created PR as residue and require reconciliation; never claim the preflight prevented creation. |
| PR absence and intent persisted, but no create-PR request-admission event exists | Re-read current base/head/PR absence, then admit the landing's one create-PR POST. |
| Create-PR request admitted, before/during POST or with an ambiguous response | Query the current base and all states for exact owner-qualified head/base. Unchanged base plus one exact object reconciles. Zero, multiple, drift, or bounded query ambiguity holds in `reconciliation_required`; never send a second create-PR POST. |
| PR created, response or local receipt lost | Accept only one open draft with exact repository, refs, SHAs, title/body marker, and prior absence/intent. |
| PR is closed, made ready, edited, duplicated, or otherwise drifted before settlement | Do not update or close it; remain `reconciliation_required`. |
| Receipt transaction committed, HTTP response lost | Return the immutable stored receipt on retry; perform no network request. |
| Process death with a started operation | Startup does not act. Explicit resume marks the old attempt interrupted and runs its stage-specific reconciliation. |
| HTTP client disconnect | The admitted coordinator continues; the browser polls durable state and never invents a new effect ID. |
| Concurrent landing and run rollback | The shared run lease plus final SQLite recheck lets exactly one admission win. |
| State backup restored after a possible remote effect | No automated remote deletion; require explicit GitHub reconciliation before another landing for that project. |

An exact remote object is not sufficient reconciliation evidence by itself.
Mutable effects require this landing's durable prior-absence observation and
effect intent. That distinction is what prevents adopting a human-created
branch or pull request after a crash.

## Acceptance evidence required

Implementation is not accepted until all of the following pass on one exact
tree:

1. **Profile and type tests:** strict exact-key decoding, canonicalization,
   owner/repository/base-ref validation, fixed `icarus/` namespace, expected-
   actor normalization, commit-identity validation, environment-reference
   allowlist, hard-coded origins, profile snapshot immutability, and rejection
   of URLs, credentials, extra keys, alternate providers, or arbitrary refs.
2. **Digest tests:** mutation of every landing-digest field, effect, candidate
   identity, profile byte, PR title/body prefix, marker version, timestamp, or
   run verification/review evidence digest changes the result; no token value
   enters canonical input; the final marker/body is deterministic and
   non-circular.
3. **Eligibility/store tests:** only an internally consistent `completed` run
   can create one landing; decisions are one-shot and digest-bound; state
   transitions are closed; one started operation is enforced across two store
   connections; terminal receipts are immutable; malformed stored JSON,
   digests, states, or cross-project identities fail closed. Every canonical
   digest and request/observation/result/event fixture in the normative record
   contract rejects each missing field, extra field, wrong null, reordered
   array, ordinal gap, cross-attempt reference, operation/HTTP cross-kind,
   request-grammar deviation, or settlement mismatch.
4. **Rollback/concurrency tests:** two Linux processes cannot admit effects for
   one landing; landing versus rollback has one winner; preapproval abandonment
   is atomic; any approval/effect intent blocks rollback; a completed run stays
   completed and does not consume the project's active-run slot.
5. **Candidate tests:** modify/create/delete, sorted paths, empty and newline-
   sensitive text, NFC/CRLF/terminal-LF message vectors, epoch boundary and
   exact UTC-format vectors, exact commit-header byte grammar and payload
   digest, deterministic timestamp/identity/message, exact parent, exact tree,
   exact byte-for-byte reviewed diff, 100644-only changed modes, SHA-1-only
   acceptance, unsupported-object-format refusal, interrupted temporary-index
   cleanup, identical IDs on replay, and a credential-gated real-GitHub
   returned-SHA equality vector.
6. **Isolation tests:** hostile system/global/local Git config, hooks, filters,
   attributes, replace objects, alternates, credential helpers, SSH settings,
   and pagers cannot affect the candidate; cache/worktree identity tampering
   fails; source HEAD/status/all refs/config/index/linked-worktree fingerprint
   is unchanged.
7. **Local-ref tests:** exact fixed ref, mandatory `--no-deref`, zero-old
   compare-and-swap, absent success, direct existing exact first-attempt
   conflict, direct existing different conflict, direct and dangling symbolic-
   ref refusal without target mutation, interrupted exact direct-ref
   reconciliation with prior-absence proof, and static proof that no other
   local ref or checkout primitive is reachable.
8. **Gateway contract tests:** an injected fake transport observes only the
   allowlisted HTTPS methods and GitHub paths, fixed headers/API version,
   redirect refusal, strict request/response schemas, bounded bodies/timeouts,
   and no arbitrary origin, URL, route, header, Git command, force, delete,
   update-ref, tag, merge, direct deployment endpoint, or automatic mutation
   retry. Raw-store and admission matrices prove every operation owns exactly
   the companion's request grammar: candidate/local operations admit no HTTP;
   preflight and reconciliation admit no mutation; object/ref/PR operations
   cannot cross-attach a POST; every legal prefix, full sequence, canonical
   blob order, preflight correlation, post-read suffix, and at-most-once PR
   boundary is enforced.
   Approval presentation binds and displays the fixed GitHub create/PR event
   warning, derivative-effect disposition, and assessment digest.
9. **Credential tests:** missing/wrong/rotated token and expected-actor
   mismatch; token absence from database, artifacts, events, receipts, URLs,
   argv, child environments, Git config, exceptions, logs, snapshots, and
   browser/API responses; hostile provider errors and redirect locations
   cannot reflect it.
10. **Git Database tests:** exact base/head preflight and post-create reads,
    injected base movement immediately before and after create-ref, truthful
    branch residue, one blob per nondeleted changed path, sorted tree entries
    and deletion nulls, server blob/tree/
    commit SHA equality, commit parent/identity/date/message equality,
    content-addressed replay through fresh operation/preflight IDs bound to the
    prior subject/reconciliation chain and byte-identical effect bodies, base
    drift, existing-head conflict, exact create-reference JSON, post-create ref
    verification, and proof that ordinary Git push is absent.
11. **Pull-request tests:** exact owner-qualified head/base, post-create base
    re-read, injected base movement immediately before and after create-PR,
    truthful PR residue, draft and maintainer flags, title/final-body equality,
    one marker, pre-existing PR
    refusal, unadmitted-zero one-time send, admitted-zero no-retry, exact-one
    reconciliation, multiple-object hold, closed/ready/edited drift, base
    advancement, reconstructed allowlisted URL, an at-most-one create-PR POST
    invariant, and no PR update/close/merge path.
12. **Crash tests:** a real child process is killed at every row in the crash
    matrix, the database is reopened, and explicit resume reaches only the
    proved state without duplicate refs or pull requests. Atomic takeover
    settles the old attempt/operation, binds the settled original-subject
    projection, and creates the replacement attempt/reconciliation intent
    without a gap; an exhausted eighth attempt settles truthfully without a
    ninth effect.
13. **Migration tests:** new database creation; existing database refusal with
    no token, wrong token, or another migration's token; both Gate 1 schemas
    missing; landing-token wrong-order; browser-first then landing in separate
    processes; exact-token success; combined-token refusal; read-only refusal
    before WAL/write; partial/malformed table and index rejection in either
    known family; one immediate transaction; no existing-row rewrite; verified
    backup restore; and API startup never authorizing migration.
14. **Platform tests:** Linux exercises the complete path; macOS and Windows
    can read bounded state/receipts but every mutation refuses before store,
    credential, Git, or network effects.
15. **End-to-end Gate 1 evidence:** the zero-external-effect offline input
    manifest pins one TypeScript-library repair, one Python-CLI repair, and one
    dependency-free React/Node module repair. The third fixture checks a
    JSX-to-module contract plus Node behavior; it is not runnable React
    application evidence. The manifest binds immutable repository/commit, task,
    prompt-revision and production system-instruction, registered-check, source,
    expected-path, and candidate identities. Its schema-v1 result is a closed
    success/failure union: success
    binds all three observations, while failure retains only an ordered
    completed-case prefix, `partial_completed_cases_only` counters, and bounded
    stage/case/safe-code-or-null/message-digest identity. A failure result's
    manifest digest is `null` only when raw manifest bytes were unavailable.

    Repository fixtures are untrusted plain trees: root `.git` must be absent,
    and pinned inventory paths reject `.git` components and `.gitattributes`.
    Copying excludes and rechecks root `.git`; fixture Git uses fixed
    `/usr/bin/git`, isolated home/configuration, disabled system/global config
    and attributes, hooks, credentials, prompts, SSH, and network protocols.
    Hostile directory/file/symlink `.git` fixtures and a malicious local clean
    filter must refuse before fixture Git effects.

    A separate versioned, human-approved, credential-gated live-evidence
    profile binds that offline manifest digest and its exact immutable case pins,
    then separately pins the real provider/model and adapter, captured pricing
    and spend/runtime budgets, and the operator's repository-automation
    assessment disposition and raw digest. It authorizes only named, separately
    approved object-upload, absent-only remote-ref, draft-PR, and receipt effects.
    Under that profile all three exact repairs complete task-to-reviewed-
    candidate-to-draft-PR with passing registered checks, exactly expected
    changed paths, exact branch/commit/PR/receipt identities, and unchanged
    source checkouts. Each live target is a dedicated inert repository under the
    fixed assessment checklist or carries a separate recorded human approval
    for its workflows, webhooks, bots, notifications, and possible deployments.
16. **Release evidence:** focused suites, full local checks, dependency audits,
    evaluator, exact-tree diff review, hosted exact-head Linux CI, and the
    repository's native read-only acceptance all pass or are reported honestly
    as outstanding. No success claim may rely on a mocked GitHub response
    alone; credential-gated real-repository evidence is required before Gate 1
    is called complete.

## Alternatives rejected

- **Add `landing` and `landed` to `RunState`.** This makes immutable review
  evidence depend on mutable delivery state, reoccupies the active-run slot,
  and cannot model independent remote retries or receipts truthfully.
- **Reuse run approvals and operations.** A diff-only approval does not bind
  delivery, and exhausted agent ceilings cannot safely double as a provider
  reconciliation budget.
- **Use ordinary `git push`, `gh`, libgit2 push, or an askpass helper.** Each
  creates a wider credentialed command/protocol surface than the four exact
  GitHub mutations required. GitHub v1 instead uses the REST Git Database and
  absent-only create-reference API.
- **Use GitHub's contents API per file.** Multi-file publication would expose
  a sequence of reachable intermediate commits and would not preserve the
  locally reviewed candidate commit identity.
- **Upload a pack and then update a ref.** It restores push-protocol complexity
  and still requires a safe ref boundary. Content-addressed REST uploads plus
  create-reference make the authority and crash points explicit.
- **Approve only the reviewed diff.** The same diff could be committed with a
  different parent or identity, sent to another repository, placed on another
  ref, or described by different PR text.
- **Adopt an existing exact branch or PR.** Equality without a durable
  prior-absence observation cannot distinguish Icarus's interrupted effect
  from pre-existing human/provider state.
- **Force, update, rebase, or delete on conflict.** Those are new irreversible
  authorities, not recovery mechanisms.
- **Automatically delete the branch or close the PR on run rollback.** Remote
  deletion is not rollback of local evidence and is intentionally absent.
- **Automatically resume at startup or on HTTP retry.** External success can
  outlive a lost response; only stage-specific reconciliation may choose the
  next action.
- **Claim provider neutrality in v1.** Core landing evidence is structured for
  later adapters, but the accepted remote behavior here is explicitly GitHub.
  Another forge requires its own provider ADR and conformance evidence.

## Consequences and review trigger

Icarus gains a narrow, proof-carrying exit from a completed run to one private
local branch, one GitHub branch, and one open draft pull request. The reviewed
run remains immutable. Every reachable remote object is covered by a separate
operator decision, a persisted intent, an exact provider identity, and an
immutable local receipt.

The cost is a real delivery state machine and explicit reconciliation UX.
Unreachable GitHub objects may remain after a failed attempt, and a branch or
draft pull request may remain when later base drift prevents completion. That
is honest residue, not an excuse for hidden deletion authority.

This ADR adds no direct Icarus endpoint for merge, force-push, remote-ref
update/deletion, pull-request update/close/ready, deployment, CI mutation,
issue mutation, repository settings change, secret storage, arbitrary Git/HTTP
commands, or collaborative-agent landing. Its authorized ref and draft-PR
creates can still trigger repository-configured automation; that disclosed,
digest-bound derivative risk is part of the human landing decision.

Review this decision before supporting another forge, Git SHA-256 repositories,
fork pull requests, stacked branches, updating an existing branch, PR repair,
merge/deploy, automated remote cleanup, multi-user credentials, or background
workers. Each changes an authority, identity, or recovery boundary rather than
merely adding a UI control.
