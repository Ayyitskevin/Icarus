# ADR 0027 normative companion: Git landing v1 record contract

- Status: Accepted with ADR 0027
- Date: 2026-07-31
- Normative parent:
  [ADR 0027](0027-git-landing-authority.md)

This companion is part of ADR 0027, not a separate decision. It closes the
canonical records that grant or reconcile landing effects. An implementation
that adds a field, accepts an omitted field, changes a digest input, renumbers
an attempt, or maps a settlement differently does not implement landing policy
version 1.

## Canonical encoding

Every `*_json` value below is the exact UTF-8 output of the repository's
`stableJson` function:

- objects have only the keys shown and serialize with ascending ASCII key
  order;
- arrays retain the order required below;
- no value is `undefined`, non-finite, or outside the JavaScript safe-integer
  range;
- an explicit `null` is not interchangeable with an absent key;
- strings are well-formed Unicode; identity, ref, digest, code, and timestamp
  fields are ASCII;
- persisted JSON has no insignificant whitespace, duplicate member, byte-order
  mark, or trailing LF; and
- each accompanying SHA-256 is the lowercase hex SHA-256 of those exact bytes.

Application decoding requires byte equality with a fresh canonical
serialization. Unknown, omitted, reordered-array, differently normalized, or
extra fields fail with `LANDING_RECORD_INVALID`. SQLite text affinity or a
matching stored digest alone is never sufficient.

The aliases used below are closed:

```text
Uuid       = canonical lowercase RFC 4122 UUID
Sha1       = 40 lowercase hexadecimal bytes
Sha256     = 64 lowercase hexadecimal bytes
SafeCode   = 2..128 bytes matching [A-Z][A-Z0-9_]*
Instant    = YYYY-MM-DDTHH:mm:ss.sssZ
GitInstant = YYYY-MM-DDTHH:mm:ssZ
```

`LandingStateV1` is exactly the state enumeration in ADR 0027's `landings`
table. `LandingResumeStateV1` is exactly its stable-state `resume_state`
enumeration. In-progress action states are never resume values; the durable
subject operation kind identifies the interrupted action.

```ts
type LandingOperationKindV1 =
  | "candidate.prepare"
  | "local_ref.create"
  | "github.preflight"
  | "github.objects.upload"
  | "github.ref.create"
  | "github.pull_request.create"
  | "landing.reconcile";

type LandingHttpKindV1 =
  | "github.actor.get"
  | "github.base_ref.get"
  | "github.head_ref.get"
  | "github.pull_requests.get"
  | "github.blob.post"
  | "github.tree.post"
  | "github.commit.post"
  | "github.ref.post"
  | "github.pull_request.post";
```

Repository-relative paths use the existing protected-path validator and
canonical separator rules. Every path array is strictly byte-sorted,
duplicate-free, and equal to the immutable run snapshot.

## Immutable evidence digests

The landing constructor redecodes and validates the source rows, builds the
following records, and calls `digestJson` on each record. It does not hash a
digest column or the original noncanonical JSON.

`changedPathsSha256`:

```ts
{
  schemaVersion: 1;
  paths: string[];
}
```

`reviewDecisionSha256`:

```ts
{
  schemaVersion: 1;
  id: Uuid;
  runId: Uuid;
  kind: "review";
  digest: Sha256;          // exact accepted diffSha256
  actor: string;           // validated stored actor bytes
  decision: "approve";
  createdAt: Instant;
}
```

The approval row ID must equal `reviewDecisionId`, its run must equal `runId`,
and its digest must equal the current persisted diff digest.

`verificationSha256`:

```ts
{
  schemaVersion: 1;
  runId: Uuid;
  outcome: "passed";
  changedPaths: string[];
  diffSha256: Sha256;
  checkpointSha256: Sha256;
  checks: Array<{
    checkId: string;
    argv: string[];
    exitCode: 0;
    signal: null;
    durationMs: number;    // safe nonnegative integer
    stdoutBytes: number;   // UTF-8 byte length of persisted stdout
    stdoutSha256: Sha256;
    stderrBytes: number;   // UTF-8 byte length of persisted stderr
    stderrSha256: Sha256;
    truncated: boolean;
    outcome: "passed";
  }>;
}
```

Checks appear once in registered project order and each `argv` is byte-equal
to that registration. Changed paths equal the canonical landing path array.
Stdout and stderr are rehashed from the complete local evidence retained by
the kernel, not from a browser projection.

`candidateCredentialAuditSha256`:

```ts
{
  schemaVersion: 1;
  policyVersion: "landing-outgoing-v1";
  outcome: "passed";
  subjects: Array<
    | {
        kind: "changed_blob";
        path: string;
        bytes: number;
        sha256: Sha256;
      }
    | {
        kind: "commit_message" | "pull_request_title" | "pull_request_body_prefix";
        path: null;
        bytes: number;
        sha256: Sha256;
      }
  >;
}
```

Changed blobs appear first in canonical path order, followed by the three text
subjects in the order shown. A deleted path has no blob subject. The record is
created only after the existing credential audit inspects the exact bytes and
returns no finding.

`candidateObjectManifestSha256`:

```ts
{
  schemaVersion: 1;
  baseCommitSha1: Sha1;
  baseTreeSha1: Sha1;
  candidateTreeSha1: Sha1;
  candidateCommitSha1: Sha1;
  candidateCommitPayloadSha256: Sha256;
  entries: Array<{
    path: string;
    op: "modify" | "create" | "delete";
    mode: "100644";
    blobSha1: Sha1 | null;
    contentBytes: number | null;
    contentSha256: Sha256 | null;
  }>;
}
```

A deletion has all three content fields null. Other entries bind the approved
checkpoint bytes. `profileSha256` is `digestJson` of the exact
`GitHubLandingProfileV1` object shown in ADR 0027, including the nested
credential-reference name but never its environment value.

## Landing authority digest and pull-request body

`landingSha256` is `digestJson` of exactly this `LandingDigestV1` record:

```ts
type LandingDigestV1 = {
  schemaVersion: 1;
  policyVersion: 1;
  githubApiVersion: "2026-03-10";
  landingId: Uuid;
  runId: Uuid;
  projectId: Uuid;
  baseCommitSha1: Sha1;
  baseTreeSha1: Sha1;
  planSha256: Sha256;
  diffSha256: Sha256;
  checkpointSha256: Sha256;
  verificationSha256: Sha256;
  reviewDecisionId: Uuid;
  reviewDecisionSha256: Sha256;
  changedPaths: string[];
  changedPathsSha256: Sha256;
  candidateCredentialAuditSha256: Sha256;
  profileVersion: 1;
  profileSha256: Sha256;
  profile: GitHubLandingProfileV1;
  objectFormat: "sha1";
  candidateParentSha1: Sha1;
  candidateTreeSha1: Sha1;
  candidateCommitSha1: Sha1;
  candidateCommitPayloadSha256: Sha256;
  candidateObjectManifestSha256: Sha256;
  commitMessageSha256: Sha256;
  commitAuthor: {
    name: string;
    email: string;
  };
  commitCommitter: {
    name: string;
    email: string;
  };
  commitEpochSeconds: number;
  commitIso8601: GitInstant;
  baseRef: string;
  expectedRemoteBaseSha1: Sha1;
  headRef: string;
  pullRequestTitleSha256: Sha256;
  pullRequestBodyPrefixSha256: Sha256;
  pullRequestMarkerVersion: 1;
  draft: true;
  maintainerCanModify: false;
  directIcarusEffects: [
    "local_ref.create",
    "github.objects.upload",
    "github.ref.create",
    "github.draft_pull_request.create",
  ];
  derivativeEffectDisclosure: {
    version: 1;
    githubEvents: ["create", "pull_request.opened"];
    mayTrigger: ["actions", "webhooks", "bots", "notifications", "deployments"];
    disposition: "inert-repository" | "operator-approved";
    evidenceSha256: Sha256;
  };
};
```

All equalities described by ADR 0027 are validators on this exact shape:
`candidateParentSha1`, `expectedRemoteBaseSha1`, and `baseCommitSha1` are
equal; author and committer objects are byte-equal to each other and to the
profile commit identity; `profileVersion` equals `profile.version`; `baseRef`
is exactly `refs/heads/` plus `profile.baseBranch`; `headRef` is exactly
`refs/heads/icarus/` plus `runId`; the disclosure disposition/evidence equals
the nested profile values; and every array has the literal order above.
`changedPaths` has the canonical path-array rules. No raw credential, final
pull-request body digest, provider response, timestamp other than the fixed
commit instant, or optional member enters this record.

The stored body prefix is the already normalized UTF-8 string whose digest
equals `pullRequestBodyPrefixSha256`. It must not contain the ASCII substring
`<!-- icarus-landing:`. After `landingSha256` exists, the final pull-request
body is the UTF-8 encoding of this exact string expression, where `+` is byte
concatenation and interpolated values are their validated lowercase ASCII
forms:

```text
bodyPrefix
+ "\n\n"
+ "Icarus landing evidence v1\n"
+ "run-id: " + runId + "\n"
+ "candidate-commit-sha1: " + candidateCommitSha1 + "\n"
+ "plan-sha256: " + planSha256 + "\n"
+ "diff-sha256: " + diffSha256 + "\n"
+ "checkpoint-sha256: " + checkpointSha256 + "\n"
+ "object-format: sha1\n"
+ "\n"
+ "<!-- icarus-landing:v1:" + landingId + ":" + landingSha256 + " -->\n"
```

The two LFs after `bodyPrefix` are unconditional, even when the prefix is empty
or already ends in LF; no trimming or escaping occurs. The generated suffix is
ASCII and the complete body must remain within 40 KiB. The service stores
`pullRequestBodySha256` as the SHA-256 of those exact final bytes. Before
recording a landing decision, admitting the create-PR operation, or accepting a
provider projection, it redecodes `LandingDigestV1`, recomputes
`landingSha256`, rerenders the final body from the stored prefix, and requires
the stored final-body digest to match. This makes the displayed/approved body,
the POST body, and reconciliation projection deterministic without placing the
digest of a string containing `landingSha256` back inside `LandingDigestV1`.

## IDs, attempts, and ordinals

Landing, decision, operation, and HTTPS-request IDs are independently generated
canonical UUIDs. They are opaque; no ID is derived from a path, provider
response, timestamp, or credential.

An ordinary explicit create/resume/reconcile command acquires the run lease
and, in one `BEGIN IMMEDIATE` admission transaction:

1. proves there is no `started` landing attempt;
2. requires `landings.attempt_count < 8`;
3. sets `ordinal = attempt_count + 1`;
4. updates `attempt_count` to that ordinal;
5. inserts `landing_attempts(landing_id, ordinal, started, ...)`; and
6. appends `landing.attempt.started`.

When the landing is `reconciliation_required`, its current subject is selected
without caller input. The validator locates the highest-sequence atomically
settled effect/reconciliation operation result with
`outcome: "reconciliation_required"` in the current uninterrupted
reconciliation chain. An effect result names its own operation ID; a
reconciliation result carries forward its input's original non-reconciliation
subject ID. Every such result since the latest real transition into
`reconciliation_required` must name that same settled interrupted subject and
match its request/result digests. Missing, older, caller-selected, or competing
subjects are corruption. A proved retry-stage transition ends the chain; if a
later effect becomes uncertain, that new effect operation becomes the subject
of a new chain.

That same admission transaction closes the two non-stable entry cases:

- an ordinary explicit resume from `failed` validates the exact
  `(state, resume_state)` pair, transitions to that stable resume state, clears
  `resume_state`, increments the landing version, and appends the truthful
  state-change event after the attempt-started event; and
- an ordinary explicit reconcile from `reconciliation_required` validates the
  deterministically selected current subject above and atomically inserts the
  new `landing.reconcile` operation request/input plus operation-started event
  after the attempt-started event. Its observation is initially null.

No ordinary transaction may commit a started zero-operation attempt while the
landing remains `failed` or `reconciliation_required`. Other ordinary
attempt-only admissions begin from an already stable retry-safe state.

An explicit resume/reconcile command that finds one orphaned `started` attempt
uses a different, closed takeover path under the same run lease and one
`BEGIN IMMEDIATE` transaction:

1. strictly decodes the sole started attempt, its zero or one started
   operation, and the operation's complete legal HTTP-request prefix; multiple
   rows, more than one admitted-but-unsettled request, a foreign
   landing/attempt, or any malformed canonical record is corruption;
2. when the started operation is a non-reconciliation effect kind, identifies
   it as the original subject; when it is `landing.reconcile`, strictly
   validates its input and recovers the original non-reconciliation subject
   row from that input whether the interrupted reconciliation observation is
   null or complete;
3. first settles any admitted-but-unsettled HTTP request as `ambiguous` with
   its canonical result and settled event, then atomically settles the old
   started operation, when present, as interrupted, appends its settled event,
   settles the old attempt as interrupted, appends the attempt event, and
   redecodes the now-settled original subject projection;
4. writes a stage-specific landing state and `landing.state.changed` event only
   when the state actually changes; a zero-operation, candidate, or GET-only
   preflight takeover keeps its retry-safe stable state and emits no false
   state-change event;
5. proves the partial unique indexes now contain no started attempt or
   operation;
6. if `attempt_count = 8`, commits that truthful interruption/reconciliation
   state and returns `LANDING_ATTEMPT_LIMIT` without another effect or attempt;
7. otherwise increments `attempt_count`, inserts the next started attempt, and
   appends its started event; and
8. when effect reconciliation is required, inserts the new
   `landing.reconcile` operation with input binding the now-settled original
   subject row in this same transaction, leaving `observation_json` null until
   all of that subject kind's required fresh facts are durable.

A started attempt with no operation is valid only when admission began from
`preparing_candidate` or another already stable retry-safe state; it has no
effect subject, and takeover settles the attempt without changing that state.
A zero-operation attempt paired with `failed` or `reconciliation_required` is
corruption. Candidate preparation and GET-only preflight interruption likewise
return to their persisted retry-safe stage. An interrupted
local-ref/object/ref/PR effect or an interrupted reconciliation enters or
remains `reconciliation_required`.
Crashing during reconciliation never makes the reconciliation operation the
subject: the next takeover reuses its input's original non-reconciliation
subject even when the interrupted observation is still null. There is no
committed gap in which the orphan is cleared but its replacement
reconciliation intent is absent. A later transaction writes the one complete
observation atomically after the fixed local/provider facts below settle;
partial observations are never stored.

The initial candidate command is coordinator attempt 1. A startup scan never
creates an attempt. A command refused before this transaction consumes none.
An admitted attempt consumes its ordinal even if it is interrupted.

Within one attempt, `kindAttempt` is one plus the greatest prior
`kind_attempt` for the same landing and operation kind. It is assigned in the
operation-start transaction and never reused. An operation belongs to exactly
one coordinator attempt. `requestOrdinal` is one plus the greatest prior
request ordinal in that coordinator attempt, regardless of operation or HTTP
kind. Before insertion the store requires:

```text
requestOrdinal <= 2 * changedPaths.length + 32
```

The HTTPS-admission insertion, conservative request charge, and
`landing.github.request.admitted` event are one transaction committed before
network I/O. Redirects and library retries are disabled. The partial unique
index in ADR 0027 makes `github.pull_request.post` at most once per landing,
not once per coordinator attempt.

The DDL's universal `kind_attempt <= 9` ceiling is the exact reachable worst
case. Coordinator attempt 1 contains candidate preparation, leaving at most
seven effect attempts. Each effect attempt can contribute at most one
preflight at its current stable delivery stage, and monotone progress across
the object and remote-ref boundaries can contribute at most two additional
preflights over the landing's entire life: `7 + 2 = 9`. The bound is reachable
when attempts 2 through 7 each refuse after the object preflight and attempt 8
completes the object and ref stages before refusing after the PR preflight.
State/attempt grammar limits every non-preflight kind to at most one occurrence
per coordinator attempt and to at most eight. Candidate preparation begins in
attempt 1 and may repeat only through explicit `failed/preparing_candidate`
resume or interrupted-candidate takeover; every such retry consumes an
effect-capable attempt and can only lower the preflight maximum. The common
schema ceiling of nine therefore does not truncate or wrap any operation kind.

## Operation intent records

Every `landing_operations.request_json` is:

```ts
{
  schemaVersion: 1;
  operationId: Uuid;
  landingId: Uuid;
  coordinatorAttempt: number;
  kindAttempt: number;
  kind: LandingOperationKindV1;
  expectedState:
    | "preparing_candidate"
    | "approved"
    | "local_ready"
    | "objects_ready"
    | "remote_ready"
    | "reconciliation_required";
  expectedVersion: number;       // safe nonnegative landings.version
  input: object;                 // exact kind-specific object below
}
```

The outer IDs, ordinals, and kind must equal the SQL columns. The operation
start and transition into the action state are one transaction.

| Kind | Required pre-state | Exact `input` keys |
| --- | --- | --- |
| `candidate.prepare` | `preparing_candidate` | `profileSha256`, `baseCommitSha1`, `baseTreeSha1`, `planSha256`, `diffSha256`, `checkpointSha256`, `verificationSha256`, `reviewDecisionSha256`, `changedPathsSha256`, `headRef`, `commitMessageSha256`, `commitEpochSeconds`, `commitIso8601`, `pullRequestTitleSha256`, `pullRequestBodyPrefixSha256` |
| `local_ref.create` | `approved` | `landingSha256`, `headRef`, `candidateCommitSha1` |
| `github.preflight` | `local_ready`, `objects_ready`, or `remote_ready`; it completes without changing that stable state | `landingSha256`, `profileSha256`, `baseRef`, `expectedRemoteBaseSha1`, `headRef`, `candidateCommitSha1`, `includePullRequestAbsence` |
| `github.objects.upload` | `local_ready` | `landingSha256`, `candidateObjectManifestSha256`, `changedPathsSha256`, `preflightOperationId`, `preflightResultSha256`, `retrySubjectOperationId`, `retrySubjectRequestSha256` |
| `github.ref.create` | `objects_ready` | `landingSha256`, `baseRef`, `expectedRemoteBaseSha1`, `headRef`, `candidateCommitSha1`, `preflightOperationId`, `preflightResultSha256` |
| `github.pull_request.create` | `remote_ready` | `landingSha256`, `baseRef`, `expectedRemoteBaseSha1`, `headRef`, `candidateCommitSha1`, `pullRequestTitleSha256`, `pullRequestBodySha256`, `draft`, `maintainerCanModify`, `preflightOperationId`, `preflightResultSha256` |
| `landing.reconcile` | `reconciliation_required` | `landingSha256`, `resumeState`, `subjectOperationId`, `subjectRequestSha256`, `subjectResultSha256` |

`includePullRequestAbsence`, `draft`, and `maintainerCanModify` are booleans;
the latter two must be `true` and `false`. `subjectRequestSha256` is the
subject operation request digest. `subjectResultSha256` is the non-null digest
of the subject's canonical settled result after ordinary settlement or atomic
takeover. A reconciliation subject kind is exactly `local_ref.create`,
`github.objects.upload`, `github.ref.create`, or
`github.pull_request.create`; candidate preparation and preflight settle their
old intent and replay directly from their persisted retry-safe stage. No input
key is optional.
`includePullRequestAbsence` is false for object/ref preflight and true only for
draft-PR preflight. Reconciliation owns its fresh provider reads directly and
cannot start a separate preflight while the landing is
`reconciliation_required`.

Every `preflightOperationId` identifies the immediately preceding completed
`github.preflight` operation in the same landing and coordinator attempt, with
no intervening operation. Its result digest equals `preflightResultSha256`,
its expected state equals the effect operation's required pre-state, and its
input binds the same landing/profile/base/head/candidate values. Object upload
and ref creation require `includePullRequestAbsence: false`; pull-request
creation requires `true`. The completed result must prove the expected actor,
the unchanged approved base, the required absent/exact head state, and, when
requested, complete zero-PR absence. A stale, cross-attempt, mismatched, failed,
or incomplete preflight cannot start the effect operation.

For `github.objects.upload`, both retry-subject fields are null exactly when no
prior object-upload operation with an admitted blob/tree/commit POST currently
requires replay. This includes the first kind attempt and later retries after a
failure that occurred entirely before the first mutating POST. Otherwise both
are non-null and bind the most recent prior `github.objects.upload` operation
that admitted a mutating POST and whose completed reconciliation authorized
`retry_stage_proven` at `local_ready`. Its canonical request digest equals
`retrySubjectRequestSha256`; its immutable landing, object-manifest, and
changed-path fields equal the new operation. An intervening pre-effect-only
failure does not replace or clear that effectful retry subject.

The new coordinator attempt, operation ID, kind attempt, fresh preflight IDs,
and request digest are new. Only the immutable effect subjects, canonical
blob/tree/commit bodies, and expected object SHAs are required to be
byte-identical through the retry chain. A missing reconciliation, stale/wrong
effectful subject, incorrectly null/non-null pair, or payload drift refuses
before actor resolution or POST.

The reconciliation result is also closed by subject kind. `local_ref.create`
may advance to `local_ready` when the exact ref is proven or return to
`approved` when fresh absence proves the same CAS safe. Object upload may
advance to `objects_ready` or return to `local_ready` for an exact-body retry.
Remote-ref creation may advance to `remote_ready` or return to `objects_ready`
only when the base is unchanged and the exact head is freshly absent.
Pull-request creation may advance to `landed` when one exact PR is proven. It
may return to `remote_ready` with null `stageValue` only when the subject owns
zero `github.pull_request.post` rows/admission events and fresh reads prove the
unchanged base, exact candidate head, and a complete zero-PR list. This
authorizes the landing's still-unused one POST through a new preflight/effect
operation. Once any PR POST admission exists, reconciliation can never return
to `remote_ready` or authorize another POST. A finding outside those mappings
keeps the landing in `reconciliation_required`.

For `github.pull_request.create`, a `failed` operation result with
`resume_state = remote_ready` is valid only for a legal request-grammar prefix
that ends before `github.pull_request.post` admission. Once any such POST row
or admission event exists, the operation can only (a) complete to `landed`
when the exact completed-boundary selector below is satisfied by the entire
post-read suffix, or (b) settle with result `reconciliation_required`, SQL
status `interrupted`, and landing state `reconciliation_required`. A POST row
settled `failed` always takes the latter path. No post-admission response can
create a failed-state resume or another PR-create opportunity.

The exact input union is:

```ts
type CandidatePrepareInputV1 = {
  profileSha256: Sha256;
  baseCommitSha1: Sha1;
  baseTreeSha1: Sha1;
  planSha256: Sha256;
  diffSha256: Sha256;
  checkpointSha256: Sha256;
  verificationSha256: Sha256;
  reviewDecisionSha256: Sha256;
  changedPathsSha256: Sha256;
  headRef: string;
  commitMessageSha256: Sha256;
  commitEpochSeconds: number;
  commitIso8601: GitInstant;
  pullRequestTitleSha256: Sha256;
  pullRequestBodyPrefixSha256: Sha256;
};

type LocalRefCreateInputV1 = {
  landingSha256: Sha256;
  headRef: string;
  candidateCommitSha1: Sha1;
};

type GitHubPreflightInputV1 = {
  landingSha256: Sha256;
  profileSha256: Sha256;
  baseRef: string;
  expectedRemoteBaseSha1: Sha1;
  headRef: string;
  candidateCommitSha1: Sha1;
  includePullRequestAbsence: boolean;
};

type GitHubObjectsUploadInputV1 = {
  landingSha256: Sha256;
  candidateObjectManifestSha256: Sha256;
  changedPathsSha256: Sha256;
  preflightOperationId: Uuid;
  preflightResultSha256: Sha256;
  retrySubjectOperationId: Uuid | null;
  retrySubjectRequestSha256: Sha256 | null;
};

type GitHubRefCreateInputV1 = {
  landingSha256: Sha256;
  baseRef: string;
  expectedRemoteBaseSha1: Sha1;
  headRef: string;
  candidateCommitSha1: Sha1;
  preflightOperationId: Uuid;
  preflightResultSha256: Sha256;
};

type GitHubPullRequestCreateInputV1 = {
  landingSha256: Sha256;
  baseRef: string;
  expectedRemoteBaseSha1: Sha1;
  headRef: string;
  candidateCommitSha1: Sha1;
  pullRequestTitleSha256: Sha256;
  pullRequestBodySha256: Sha256;
  draft: true;
  maintainerCanModify: false;
  preflightOperationId: Uuid;
  preflightResultSha256: Sha256;
};

type LandingReconcileInputV1 = {
  landingSha256: Sha256;
  resumeState: LandingResumeStateV1;
  subjectOperationId: Uuid;
  subjectRequestSha256: Sha256;
  subjectResultSha256: Sha256;
};
```

The `input` type is selected only by the outer operation kind; a value from
another member of the union is invalid even if its keys overlap.

### Operation observations

`observation_json` is SQL null until all facts required immediately before the
kind's effect are durable. When present, it is:

```ts
{
  schemaVersion: 1;
  operationId: Uuid;
  kind: LandingOperationKindV1;
  phase: "pre_effect" | "reconciliation";
  facts: Array<{
    fact:
      | "subject_operation"
      | "local_ref"
      | "actor"
      | "base_ref"
      | "head_ref"
      | "pull_requests";
    requestId: Uuid | null;
    resultSha256: Sha256;
  }>;
}
```

`operationId` and `kind` are byte-equal to the owning
`landing_operations.id` and closed kind. The phase is `reconciliation`
exactly for `landing.reconcile`; every other operation uses `pre_effect`.

Facts are unique. A normal pre-effect observation uses the fixed order
`local_ref`, `actor`, `base_ref`, `head_ref`, `pull_requests`, omitting facts
that its cardinality does not require. A reconciliation observation always
starts with `subject_operation`, then uses `local_ref`, `actor`, `base_ref`,
`head_ref`, `pull_requests` in that fixed order. Local-ref facts have a null
request ID and hash this exact fact projection:

```ts
{
  schemaVersion: 1;
  state: "absent" | "direct" | "symbolic" | "invalid";
  objectSha1: Sha1 | null;
  symbolicTargetSha256: Sha256 | null;
}
```

Only `absent` has both nullable fields null; only `direct` has `objectSha1`;
only `symbolic` has `symbolicTargetSha256`.

A `subject_operation` fact also has a null request ID. Its `resultSha256` is
the digest of this exact settled-subject projection, not merely the
`landing_operations.result_sha256` field embedded in the projection:

```ts
{
  schemaVersion: 1;
  operationId: Uuid;
  landingId: Uuid;
  coordinatorAttempt: number;
  kind:
    | "local_ref.create"
    | "github.objects.upload"
    | "github.ref.create"
    | "github.pull_request.create";
  kindAttempt: number;
  status: "interrupted";
  requestSha256: Sha256;
  observationSha256: Sha256 | null;
  resultSha256: Sha256;
  errorCode: SafeCode;
}
```

The projection is byte-equal to the currently interrupted subject operation
after the explicit ordinary settlement or takeover transaction. Its non-null
result and error match the SQL row's interrupted-state rule. The projection's
IDs, attempts, kind, request, observation, and result match the same landing's
subject row, and the request/result fields also equal the immutable non-null
values in `LandingReconcileInputV1`. A reconciliation operation is never
itself a subject: if reconciliation is interrupted, the next explicit attempt
validates its input, follows it to the same settled original subject, and
ignores the interrupted reconciliation operation as an authority source.

Provider facts reference a settled HTTPS request from the same
operation/landing/attempt. Cardinality is fixed:

- `candidate.prepare`: no observation;
- `github.objects.upload`: one `actor`;
- `local_ref.create`: one `local_ref`;
- `github.preflight`: `actor`, `base_ref`, `head_ref`, and, when its input flag
  is true, `pull_requests`;
- `github.ref.create`: `actor`, `base_ref`, `head_ref`;
- `github.pull_request.create`: `actor`, `base_ref`, `head_ref`,
  `pull_requests`;
- `landing.reconcile` for `github.objects.upload`: one `subject_operation`;
- `landing.reconcile` for `local_ref.create`: `subject_operation`,
  `local_ref`, where the latter hashes a fresh non-dereferenced read of the
  fixed local head ref;
- `landing.reconcile` for `github.ref.create`: `subject_operation`, `actor`,
  `base_ref`, `head_ref`;
- `landing.reconcile` for `github.pull_request.create`:
  `subject_operation`, `actor`, `base_ref`, `head_ref`, `pull_requests`.

The observation JSON and SHA-256 are updated in one transaction before the
local compare-and-swap or mutating POST.

### Operation results

Every settled operation has one canonical result:

```ts
{
  schemaVersion: 1;
  operationId: Uuid;
  kind: LandingOperationKindV1;
  outcome:
    | "completed"
    | "failed"
    | "interrupted"
    | "reconciliation_required";
  boundary:
    | "candidate_ready"
    | "local_ref_ready"
    | "preflight_exact"
    | "objects_exact"
    | "remote_ref_ready"
    | "draft_pr_exact"
    | "subject_settled"
    | "retry_stage_proven"
    | "operation_failed"
    | "operation_interrupted"
    | "reconciliation_required";
  evidence: Array<{
    requestId: Uuid | null;
    resultSha256: Sha256;
  }>;
  value: object | null;
  errorCode: SafeCode | null;
}
```

The result's `operationId` and `kind` are byte-equal to its owning operation
row. Its result digest and error code are byte-equal to that row and its
settled event; its outcome maps exactly to the row status and event under the
status mapping below.

Evidence starts with every observation fact's `(requestId, resultSha256)` in
observation order, then includes each settled HTTPS result from this operation
that is not already represented, in request-ordinal order. It contains no
other or duplicate entry. Thus local and subject-operation facts have null
request IDs; a local-ref reconciliation carries the subject digest first and
the fresh local-ref digest second. Completed results have null `errorCode`;
every other outcome has a safe code. `value` is exact by kind:

| Kind | Completed boundary and exact `value` |
| --- | --- |
| `candidate.prepare` | `candidate_ready`; `candidateTreeSha1`, `candidateCommitSha1`, `candidateCommitPayloadSha256`, `candidateObjectManifestSha256`, `candidateCredentialAuditSha256`, `diffByteEqual: true` |
| `local_ref.create` | `local_ref_ready`; `headRef`, `candidateCommitSha1`, `localRefOutcome: "created" \| "reconciled"`, `updateRefExitCode: 0 \| null` |
| `github.preflight` | `preflight_exact`; `actor`, `baseSha1`, `headState: "absent" \| "exact"`, `pullRequestCount: 0 \| null` |
| `github.objects.upload` | `objects_exact`; `candidateObjectManifestSha256`, `remoteObjectOutcome: "created_or_exact"` |
| `github.ref.create` | `remote_ref_ready`; `baseSha1`, `headSha1`, `remoteRefOutcome: "created" \| "reconciled"` |
| `github.pull_request.create` | `draft_pr_exact`; the exact `PullRequestProjectionV1` below plus `pullRequestOutcome: "created" \| "reconciled"` |
| `landing.reconcile` | `subject_settled` or `retry_stage_proven`; `subjectOperationId`, `nextState`, `remoteResidue: "none" \| "branch" \| "pull_request"`, and the exact nullable `stageValue` below |

For noncompleted results, the boundary is determined only by outcome:
`failed -> operation_failed`, `interrupted -> operation_interrupted`, and
`reconciliation_required -> reconciliation_required`. No other
kind/outcome/boundary combination is valid.

Those value objects are exactly:

```ts
type CandidateReadyValueV1 = {
  candidateTreeSha1: Sha1;
  candidateCommitSha1: Sha1;
  candidateCommitPayloadSha256: Sha256;
  candidateObjectManifestSha256: Sha256;
  candidateCredentialAuditSha256: Sha256;
  diffByteEqual: true;
};

type LocalRefReadyValueV1 = {
  headRef: string;
  candidateCommitSha1: Sha1;
  localRefOutcome: "created" | "reconciled";
  updateRefExitCode: 0 | null;
};

type PreflightExactValueV1 = {
  actor: string;
  baseSha1: Sha1;
  headState: "absent" | "exact";
  pullRequestCount: 0 | null;
};

type ObjectsExactValueV1 = {
  candidateObjectManifestSha256: Sha256;
  remoteObjectOutcome: "created_or_exact";
};

type RemoteRefReadyValueV1 = {
  baseSha1: Sha1;
  headSha1: Sha1;
  remoteRefOutcome: "created" | "reconciled";
};

type DraftPrExactValueV1 = PullRequestProjectionV1 & {
  pullRequestOutcome: "created" | "reconciled";
};

type ReconcileValueV1 = {
  subjectOperationId: Uuid;
  nextState: LandingStateV1;
  remoteResidue: "none" | "branch" | "pull_request";
  stageValue:
    | LocalRefReadyValueV1
    | ObjectsExactValueV1
    | RemoteRefReadyValueV1
    | DraftPrExactValueV1
    | null;
};
```

`stageValue` is closed by the original subject kind and `nextState`:

- `local_ref.create -> local_ready` carries `LocalRefReadyValueV1` with
  `localRefOutcome: "reconciled"` and `updateRefExitCode: null`;
- `github.objects.upload -> objects_ready` carries `ObjectsExactValueV1`;
- `github.ref.create -> remote_ready` carries `RemoteRefReadyValueV1` with
  `remoteRefOutcome: "reconciled"`;
- `github.pull_request.create -> landed` carries `DraftPrExactValueV1` with
  `pullRequestOutcome: "reconciled"`; and
- a proved retry stage carries null.

No other subject/state/value combination is valid. Each non-null stage value
is derived from and byte-correlated to the complete reconciliation observation
and original subject request/results; it is not caller-provided.

A completed `landing.reconcile` uses boundary `subject_settled` if and only if
`stageValue` is non-null and proves the delivered stage named by `nextState`.
It uses `retry_stage_proven` if and only if `stageValue` is null and the
observation proves the exact retry state named by `nextState`. The two
boundaries and value shapes are never interchangeable.

The `created | reconciled` selector is evidence-derived:

- a completed `local_ref.create` says `created` only when the exact fixed
  `update-ref --no-deref ... <zero-old>` invocation returned exit code 0 and
  the fixed post-read proved the candidate; it records
  `updateRefExitCode: 0`. It says `reconciled` only when that invocation's
  outcome was indeterminate, the durable prior absence/intent exists, and the
  fixed post-read proved the candidate; it records
  `updateRefExitCode: null`. A definitive command failure cannot be relabeled
  reconciled merely because a ref later appears.
- a completed `github.ref.create` or `github.pull_request.create` says
  `created` only when its one mutation row settled `succeeded` with the exact
  projection and the entire fixed post-read suffix proved the stage. It says
  `reconciled` only when that row settled `ambiguous`, prior absence/intent is
  durable, and the suffix proves the exact branch/PR. A mutation row settled
  `failed` cannot produce either completed stage value.
- a non-null stage value from a separate `landing.reconcile` chain always says
  `reconciled`; its settled interrupted subject plus fresh fixed facts are the
  evidence.

No caller chooses the outcome string. Selector tests cover definitive success,
ambiguous command/POST plus exact same-operation suffix, definitive failure,
and separate reconciliation for local ref, remote ref, and PR.

For each of the four delivery stages—local ref, immutable objects, remote ref,
and draft PR—the final landing validator accepts exactly one of:

1. a completed effect operation with the exact direct stage value; or
2. one interrupted original effect subject plus an unbroken sequence of
   settled `landing.reconcile` operations whose inputs bind that same subject
   request/result: zero or more intermediate operations have result outcome
   `reconciliation_required`/SQL status `interrupted` and preserve the subject,
   followed by exactly one completed operation whose result carries the exact
   non-null stage value above.

Every chain link belongs to the same landing, preserves the original subject
identity, follows attempt order without a competing subject, and matches the
state transition/event sequence. A retry-stage result does not itself satisfy
the delivery stage; a later completed effect or reconciled stage must do so.
Each receipt outcome is derived from the terminal exact stage value. A
reconciliation-chain stage value must say `reconciled`; a completed effect
operation retains its own exact `created` or `reconciled` outcome.

`remoteResidue` reports the highest fact-proven reachable mutable GitHub effect
from this landing; unreachable content-addressed objects are deliberately not
represented. Its completed-result mapping is exact:

- local-ref and object-upload result/retry stages use `none`;
- remote-ref exact/reconciled `remote_ready` uses `branch`, while freshly
  absent head retry at `objects_ready` uses `none`;
- PR zero-POST retry at `remote_ready` uses `branch`; and
- exact PR reconciliation at `landed` uses `pull_request`.

For a noncompleted reconciliation result, local-ref/object subjects use
`none`. A ref subject uses `branch` for any freshly proven direct head,
`none` for a freshly proven absent head, and `ambiguous` when head visibility
is unresolved. A PR subject uses `pull_request` when a complete list proves at
least one PR object, otherwise uses `branch` or `none` from the freshly proven
head state only when no PR POST was ever admitted. Once a PR POST was admitted,
a zero or incomplete list, transport uncertainty, or otherwise unresolved
visibility uses `ambiguous`; an incomplete list is never downgraded merely
because a branch is visible. No other subject/state/stageValue/residue
combination is valid.

A noncompleted result has `value` null except that
`reconciliation_required` may use only:

```ts
{
  subjectOperationId: Uuid;
  remoteResidue: "none" | "branch" | "pull_request" | "ambiguous";
}
```

The operation status maps `completed -> completed`, `failed -> failed`, and
`interrupted|reconciliation_required -> interrupted`; the landing state and
resume state distinguish an ordinary interruption from reconciliation. The
pull-request post-admission rule above is part of this mapping: request outcome
`failed` does not permit operation outcome or SQL status `failed` once a
`github.pull_request.post` admission exists, while `succeeded` or `ambiguous`
permits `completed` only through the exact completed-boundary selector. Store
settlement writes result JSON/digest, status/error/finished time, the matching
event, and the next landing state in one transaction.

Every effect or reconciliation settlement that enters or remains
`reconciliation_required` uses result outcome `reconciliation_required`, SQL
status `interrupted`, and the noncompleted value above naming the current
original subject. An effect operation names itself; a reconciliation operation
repeats its input's subject. Ordinary interruption of a candidate/preflight
that returns to a retry-safe stable state uses outcome `interrupted` and does
not create a reconciliation subject.

## HTTPS admission records

### Operation-owned request grammar

HTTP authority is owned by the durable operation intent, not by a gateway
caller. For one operation, its HTTP rows ordered by the coordinator-wide
`requestOrdinal` must be an exact prefix of one grammar below:

| Operation | Exact relative HTTP-kind sequence |
| --- | --- |
| `candidate.prepare` | empty |
| `local_ref.create` | empty |
| `github.preflight`, `includePullRequestAbsence: false` | `actor.get`, `base_ref.get`, `head_ref.get` |
| `github.preflight`, `includePullRequestAbsence: true` | `actor.get`, `base_ref.get`, `head_ref.get`, `pull_requests.get` |
| `github.objects.upload` | `actor.get`, one `blob.post` for each non-deleted manifest path in canonical changed-path order, `tree.post`, `commit.post` |
| `github.ref.create` | `actor.get`, `base_ref.get`, `head_ref.get`, at most one `ref.post`, `head_ref.get`, `base_ref.get` |
| `github.pull_request.create` | `actor.get`, `base_ref.get`, `head_ref.get`, `pull_requests.get`, at most one `pull_request.post`, `base_ref.get`, `head_ref.get`, `pull_requests.get` |
| `landing.reconcile` for `local_ref.create` or `github.objects.upload` | empty |
| `landing.reconcile` for `github.ref.create` | `actor.get`, `base_ref.get`, `head_ref.get` |
| `landing.reconcile` for `github.pull_request.create` | `actor.get`, `base_ref.get`, `head_ref.get`, `pull_requests.get` |

The names in this table omit only the fixed `github.` prefix. “At most one”
means the mutating POST is present in a full effect attempt, but a prefix may
end before it because a pre-effect read refused. Once that POST is admitted,
the operation can complete only after the entire fixed post-read suffix proves
the required result. A process interruption may leave any admitted prefix.
Any such prefix containing a possibly effective POST settles the operation and
landing into reconciliation; it is never completed from the POST response
alone. A definitively failed pre-effect GET may settle the operation without
admitting later grammar members. No row can occur after the complete grammar.

The object-upload blob count and order come from the revalidated immutable
object manifest. Deleted paths contribute no blob POST. Every sequence member
has the one exact subject and, for POST, exact reconstructed body bound below.
Repeated head/base/list reads use that same request subject and are
distinguished by their relative grammar position. All prior required reads
must be settled `succeeded` with the exact expected projection before a
mutating POST is admitted. A succeeded or ambiguous mutating response permits
only its fixed post-read suffix; a response that cannot prove the effect absent
is ambiguous, not a retry grant.

Because one landing operation may be `started`, rows for an operation are
contiguous within the coordinator-wide request sequence. In the atomic
admission transaction, the store:

1. strictly decodes the started operation and every existing request/result;
2. validates the same landing, attempt, operation kind, contiguous global
   ordinals, prior outcomes, preflight binding, and grammar prefix;
3. derives the one next request descriptor from immutable records;
4. requires byte equality with the proposed canonical request; and
5. inserts the row, conservative charge, and admitted event before network
   I/O.

`operation_kind` plus the composite foreign key and DDL check prevent even raw
SQL from attaching a POST to a candidate, local-ref, preflight, or
reconciliation operation. The stricter ordering/cardinality grammar is
validated both on admission and whenever stored landing state is loaded. A
cross-kind, extra, skipped, duplicated, reordered, noncontiguous, or
subject/body-mismatched row is `LANDING_RECORD_INVALID` and stops before
credential resolution, network, local-ref mutation, state transition, or
retry. A completed operation requires its exact complete grammar; a failed,
interrupted, or reconciliation-required result must match one legal prefix and
its outcome rules.

Every `landing_http_requests.request_json` is:

```ts
{
  schemaVersion: 1;
  requestId: Uuid;
  landingId: Uuid;
  operationId: Uuid;
  coordinatorAttempt: number;
  operationKind: LandingOperationKindV1;
  requestOrdinal: number;
  kind: LandingHttpKindV1;
  method: "GET" | "POST";
  profileSha256: Sha256;
  bodySha256: Sha256 | null;
  subject: object;
}
```

The outer fields equal the SQL row and owning operation. The
operation/method/kind mapping is enforced by the ADR 0027 DDL, while the full
grammar above is enforced by strict admission and stored-state validation.
`bodySha256` is null for GET and hashes the exact UTF-8 JSON body for POST.
Subjects have exactly these keys:

| HTTP kind | Exact `subject` keys |
| --- | --- |
| `github.actor.get` | `expectedActor` |
| `github.base_ref.get` | `owner`, `repository`, `baseRef`, `expectedSha1` |
| `github.head_ref.get` | `owner`, `repository`, `headRef`, `expectedSha1` |
| `github.pull_requests.get` | `owner`, `repository`, `headOwner`, `headRef`, `baseBranch`, `state: "all"`, `page: 1`, `perPage: 100` |
| `github.blob.post` | `pathSha256`, `contentBytes`, `contentSha256`, `expectedBlobSha1` |
| `github.tree.post` | `baseTreeSha1`, `entriesSha256`, `expectedTreeSha1` |
| `github.commit.post` | `candidateTreeSha1`, `baseCommitSha1`, `candidateCommitPayloadSha256`, `expectedCommitSha1`, `commitIso8601` |
| `github.ref.post` | `baseRef`, `expectedRemoteBaseSha1`, `headRef`, `candidateCommitSha1` |
| `github.pull_request.post` | `baseRef`, `expectedRemoteBaseSha1`, `headRef`, `candidateCommitSha1`, `pullRequestTitleSha256`, `pullRequestBodySha256`, `draft: true`, `maintainerCanModify: false` |

The scalar types are the aliases in this document. `owner`, `repository`,
`expectedActor`, `headOwner`, `headRef`, `baseBranch`, and `baseRef` are the
exact validated profile/landing strings; none is provider-selected.
`contentBytes` is a safe nonnegative integer; `page` and `perPage` are safe
positive integers.
`pathSha256`, `entriesSha256`, title/body/content digests, and every field
ending in `Sha256` are `Sha256`; every field ending in `Sha1` is `Sha1`.
There are no omitted or null subject members.

`pathSha256` is the raw SHA-256 of the UTF-8 bytes of the validated
repository-relative path. `entriesSha256` is `digestJson` of the exact
`GitHubTreeEntryV1[]` below. Entries are strictly byte-sorted by path,
duplicate-free, and equal to the landing's changed paths. A create/modify has
the expected locally computed blob SHA; a deletion has null SHA. No other null
correlation is valid.

Every POST body is the UTF-8 output of `stableJson` on the one closed wire
value selected by its HTTP kind, with no trailing LF:

```ts
type GitHubTreeEntryV1 = {
  path: string;
  mode: "100644";
  type: "blob";
  sha: Sha1 | null;
};

type GitHubBlobBodyV1 = {
  content: string;
  encoding: "base64";
};

type GitHubTreeBodyV1 = {
  base_tree: Sha1;
  tree: GitHubTreeEntryV1[];
};

type GitHubCommitBodyV1 = {
  message: string;
  tree: Sha1;
  parents: [Sha1];
  author: {
    name: string;
    email: string;
    date: GitInstant;
  };
  committer: {
    name: string;
    email: string;
    date: GitInstant;
  };
};

type GitHubRefBodyV1 = {
  ref: string;
  sha: Sha1;
};

type GitHubPullRequestBodyV1 = {
  title: string;
  head: string;
  base: string;
  body: string;
  draft: true;
  maintainer_can_modify: false;
};
```

The blob `content` is canonical padded RFC 4648 base64 with no whitespace and
decodes to the exact checkpoint bytes whose byte count/SHA-256/blob SHA-1 match
the request subject. The tree body's `base_tree` and `tree` equal the subject's
base tree and entries digest. The commit body is exactly the stored canonical
message, candidate tree, one base parent, identical profile author/committer,
and stored Git instant; it must reproduce the subject's payload and expected
commit identities. The ref body is exactly the fully qualified head ref and
candidate commit. The pull-request body uses the stored approved title, exact
`profile.owner + ":" + headRef.removePrefix("refs/heads/")`, profile base
branch, the deterministic final body defined above, and the two fixed
booleans. Its title/body digests and refs must match the request subject.

`bodySha256` is the raw SHA-256 of this exact serialized body. Before network
I/O and on replay, the gateway reconstructs the wire value from the immutable
landing/profile/object-manifest records, revalidates every correlation above,
reruns `stableJson`, and requires its raw SHA-256 to equal the admitted
`bodySha256`. It never persists or accepts a caller-provided serialized body.

The gateway derives the fixed origin, API version, method, percent-encoded path,
query, headers, and body from this record and the immutable profile. None is
accepted from a caller as an arbitrary string.

### HTTPS results

Every settled HTTP row stores and hashes:

```ts
{
  schemaVersion: 1;
  requestId: Uuid;
  kind: LandingHttpKindV1;
  outcome: "succeeded" | "failed" | "ambiguous";
  httpStatus: number | null;
  projection:
    | ActorProjectionV1
    | RefProjectionV1
    | PullRequestListProjectionV1
    | ObjectProjectionV1
    | PullRequestProjectionV1
    | null;
  errorCode: SafeCode | null;
}
```

The result's `requestId` and `kind` are byte-equal to its owning HTTP request
row. Its outcome, HTTP status, result digest, and error code are byte-equal to
that row and its settled event.

Success has a 2xx status, the projection required by its kind, and null error,
with one closed exception: `github.head_ref.get` uses GitHub's exact 404
not-found response as semantic success with `RefProjectionV1.state =
"absent"`, the requested head ref, null `sha1`, and null error.
Failure has a known status or null transport refusal, null projection, and a
safe host error. An interrupted admitted request settles `ambiguous` with null
status/projection and `GITHUB_OUTCOME_AMBIGUOUS`; it does not infer failure from
an absent response.

```ts
type ActorProjectionV1 = {
  type: "actor";
  login: string;
};

type RefProjectionV1 = {
  type: "ref";
  state: "absent" | "direct";
  ref: string;
  sha1: Sha1 | null;
};

type ObjectProjectionV1 = {
  type: "object";
  objectKind: "blob" | "tree" | "commit" | "ref";
  sha1: Sha1;
};

type PullRequestProjectionV1 = {
  type: "pull_request";
  number: number;
  state: "open";
  draft: true;
  owner: string;
  repository: string;
  headOwner: string;
  headRef: string;
  headSha1: Sha1;
  baseRef: string;
  baseSha1: Sha1;
  titleSha256: Sha256;
  bodySha256: Sha256;
  markerCount: 1;
  maintainerCanModify: false;
};

type PullRequestListProjectionV1 = {
  type: "pull_request_list";
  complete: boolean;
  count: number;
  objects: PullRequestProjectionV1[];
};
```

`count` is a safe nonnegative integer equal to `objects.length`.
Every returned list item must decode into exactly one
`PullRequestProjectionV1`; an unprojectable, duplicate-number, or omitted item
fails the entire request. Objects have unique positive safe-integer numbers and
are sorted by numeric number. `complete` is true if and only if there is no
next-page indication and GitHub returned fewer than 100 items; otherwise it is
false and the record can never prove absence or uniqueness. Ref absence is
accepted only from GitHub's exact documented not-found response for the exact
head-ref GET. A 404 for the base ref, malformed not-found body/headers,
permission ambiguity, or any other not-found request is a failure, not
absence.

## Retry and settlement mapping

| HTTP kind | Ambiguous/failed next authority |
| --- | --- |
| all GET kinds | A later explicit coordinator attempt may admit a fresh GET; the old row remains settled. |
| blob/tree/commit POST | A later explicit attempt creates a fresh operation bound to the prior subject/reconciliation chain above and may repeat only byte-identical immutable effect subjects/bodies; every returned SHA must equal the expected local ID. |
| ref POST | Never update or force. Fresh base/head GETs decide: unchanged base plus absent head permits the same absent-only POST; exact head reconciles; other states hold. |
| pull-request POST | Never POST again after its one admission. Fresh base/head/list GETs may reconcile exactly one matching draft; zero, multiple, drift, or incomplete visibility holds. |

An operation can settle completed only from the boundaries in ADR 0027 and
the evidence rows above. A request or operation digest mismatch, missing prior
absence observation, cross-attempt ID, ordinal gap, extra event, or ambiguous
provider projection cannot authorize a retry.

## Event payloads

The following event types and canonical payloads are the only events that
carry landing effect authority:

Event sequence is per landing. The first event has sequence 1; while holding
the same `BEGIN IMMEDIATE` transaction used for its source mutation, each
append takes the prior maximum plus one. A transaction that appends several
events assigns consecutive numbers in the exact event order specified by this
contract. Omitting an optional event when its source row/state change is
absent, the order is:

- ordinary initial or stable attempt admission: `landing.attempt.started`
  only; this attempt-only transaction commits before its first operation-start
  transaction;
- ordinary failed-state resume: `landing.attempt.started`, then
  `landing.state.changed`;
- ordinary reconciliation admission: `landing.attempt.started`, then
  `landing.operation.started`;
- a later operation start in an active attempt: `landing.operation.started`,
  then `landing.state.changed` when it enters an action state;
- request admission: `landing.github.request.admitted`;
- request/operation settlement: `landing.github.request.settled` when a
  request settles in the transaction, then `landing.operation.settled`, then
  `landing.attempt.settled` when the attempt closes, then
  `landing.state.changed` for a non-self transition;
- approval or rejection: `landing.decision.recorded`, then
  `landing.state.changed`; and
- takeover: the old `landing.github.request.settled` when needed, old
  `landing.operation.settled` when present, old `landing.attempt.settled`,
  `landing.state.changed` when needed, new `landing.attempt.started` when the
  limit permits, then replacement `landing.operation.started` when effect
  reconciliation is required.

A non-takeover source transaction matches exactly one class above; classes
cannot be coalesced. In particular, an ordinary operation-settlement
transaction commits before any later operation-start transaction.
A source transaction that contains only one applicable event emits only that
event; a state-only abandonment emits only `landing.state.changed`.
Stored-state load requires one contiguous sequence `1..N` with no gap,
duplicate, non-integer, or reordered source/event pair.

```ts
landing.attempt.started = {
  schemaVersion: 1, landingId: Uuid, coordinatorAttempt: number
}

landing.attempt.settled = {
  schemaVersion: 1, landingId: Uuid, coordinatorAttempt: number,
  outcome: "completed" | "failed" | "interrupted", errorCode: SafeCode | null
}

landing.operation.started = {
  schemaVersion: 1, landingId: Uuid, operationId: Uuid,
  coordinatorAttempt: number, kind: LandingOperationKindV1, kindAttempt: number,
  requestSha256: Sha256
}

landing.operation.settled = {
  schemaVersion: 1, landingId: Uuid, operationId: Uuid,
  coordinatorAttempt: number, kind: LandingOperationKindV1,
  outcome: "completed" | "failed" | "interrupted" | "reconciliation_required",
  resultSha256: Sha256, errorCode: SafeCode | null
}

landing.github.request.admitted = {
  schemaVersion: 1, landingId: Uuid, operationId: Uuid, requestId: Uuid,
  coordinatorAttempt: number, operationKind: LandingOperationKindV1,
  requestOrdinal: number, kind: LandingHttpKindV1,
  requestSha256: Sha256
}

landing.github.request.settled = {
  schemaVersion: 1, landingId: Uuid, operationId: Uuid, requestId: Uuid,
  coordinatorAttempt: number, operationKind: LandingOperationKindV1,
  requestOrdinal: number, kind: LandingHttpKindV1,
  outcome: "succeeded" | "failed" | "ambiguous",
  resultSha256: Sha256, errorCode: SafeCode | null
}

landing.state.changed = {
  schemaVersion: 1, landingId: Uuid, from: LandingStateV1, to: LandingStateV1,
  version: number, operationId: Uuid | null
}

landing.decision.recorded = {
  schemaVersion: 1, landingId: Uuid, decisionId: Uuid,
  landingSha256: Sha256, decision: "approve" | "reject", actor: string
}
```

Each event's SQL landing ID, sequence, type, and payload are validated
together. Attempt events byte-match the owning attempt's landing ID, ordinal,
status-derived outcome, and exact error code. Operation events
byte-match the owning operation's IDs, attempt and kind ordinals, closed kind,
request/result digests, status-derived outcome, and error code. Request events
byte-match the owning HTTP row's landing/operation/request IDs, attempt,
operation kind, request ordinal, HTTP kind, request/result digests, outcome,
and error code. Decision events byte-match the sole owning decision row and
accepted landing digest. A completed attempt or operation and a succeeded
request have null event error; every other settled event carries the same
non-null `SafeCode` as its source row.

Each `landing.state.changed` event encodes one legal, non-self transition from
ADR 0027's state machine. Starting from `preparing_candidate` at landing
creation, the landing version is 0. For every legal non-self state transition,
`from` equals the prior replayed state, the version increments exactly once,
and the event's `version` equals the prior replayed version plus one and the
durable post-transition version. A transaction that emits no state event,
including a suppressed self transition, cannot change the landing version.
The event's `operationId` is selected exactly as follows: a normal
stable-to-action admission names the newly started effect operation; any
operation-settlement-owned transition names the settling operation, including
stable-preflight failure and a reconciliation result; and interrupted-effect
takeover names the original settling subject operation even though the same
transaction starts a replacement `landing.reconcile`. The replacement never
owns that takeover transition. The ID is null exactly for a transition with no
owning operation under those rules. Replaying all state events in sequence must
end at the current `landings.state` and `landings.version`.

Request admission and its admitted event are atomic. Operation settlement, its
settled event, attempt settlement, and the state transition are atomic whenever
they close the coordinator attempt. Events never contain credentials, raw
provider bodies, repository bytes, diff bytes, task text, or local paths.

## Conformance

Unit/property tests must, for every schema above, accept one canonical fixture
and reject every missing field, extra field, duplicate member, wrong null,
wrong array order, unsafe integer, noncanonical ID/digest/timestamp, digest
mismatch, cross-landing reference, ordinal gap, and settlement mismatch.
Pull-request-list mutation tests additionally reject count/length mismatch,
omitted or unprojectable items, duplicate/nonpositive/unsafe numbers, wrong
sort order, and either incorrect `complete` value. Blob fixtures include an
empty changed blob with `contentBytes: 0`, the canonical empty base64 string,
the Git empty-blob SHA-1, and byte-exact admission/body/replay digests. Crash
tests must reopen the database at every request-admission and settlement
boundary and apply the retry table without duplicate pull requests or widened
ref authority. Text canonicalization fixtures reject empty and whitespace-only
commit messages and pull-request titles, title CR/LF/NUL/control bytes, and a
title whose canonical UTF-8 encoding is 257 bytes. Raw-SQL corruption fixtures
also prove that a succeeded HTTP settlement with a NULL status and both
`(failed, NULL)` and `(reconciliation_required, NULL)` landing pairs are
rejected by the database. They also reject a started or completed attempt with
a non-null error and a failed or interrupted attempt with a null error.
State-machine property tests enumerate every allowed and forbidden
`(state, resume_state)` pair and prove that each allowed pair has one reachable
explicit-resume or reconciliation outcome. Subject-kind tests prove the closed
reconciliation mappings above, including that an admitted create-PR POST can
never transition back to `remote_ready`. Result-shape mutations reject every
unknown or kind/outcome-mismatched boundary literal, `subject_settled` with a
null stage value, and `retry_stage_proven` with a non-null stage value.
Event-correlation mutations alter each ID, attempt/kind/request ordinal,
closed discriminant, digest, outcome, error code, decision field, state
endpoint, version, and operation ID in turn and prove load refusal. State
replay fixtures cover operation-start and stable-preflight-failure transitions
and reject an illegal or self transition and a terminal state/version
mismatch. They also reject a missing, repeated, or jumping event version and
any version change without a state event. Event-order fixtures reject a
non-integer, unsafe, gapped, duplicated, or source-reordered landing event
sequence, swap each adjacent pair in every multi-event transaction class
above, and reject a coalesced pair of ordinary classes. A two-operation
takeover fixture proves the state event names the settling original subject,
not the replacement reconciliation operation.
Request-grammar tests reject every operation/HTTP cross-kind attachment,
skipped, duplicated,
reordered, extra, noncontiguous, wrong-subject, and wrong-body admission at
both the service and raw-store load boundary. They enumerate every legal
prefix, require an exact complete sequence for completion, prove canonical
changed-blob ordering, and show that candidate/local/reconciliation operations
cannot acquire mutation authority. Object-retry tests require fresh
attempt/operation/preflight identities while preserving the most recent prior
effectful subject and its reconciliation grant across intervening
pre-effect-only failures, plus byte-identical immutable effect bodies. They
reject every nullability, ancestry, manifest, subject, body, and expected-SHA
drift. Takeover tests crash with zero or one started operation, during an
effect, and during reconciliation, then prove the old settlement, settled
original-subject projection, new attempt/reconcile intent, state, and events
are atomic; at attempt 8 they prove truthful settlement with no ninth attempt
or effect. Zero-operation, candidate, and GET-only preflight takeover fixtures
prove the exact attempt/operation event sequence contains no self-loop
`landing.state.changed` event. Stage-provenance tests enumerate all four
delivery slots and reject a missing objects stage, interrupted subject without
a completed chain, retry-only chain, competing/cross-landing subject, broken
attempt order, wrong terminal stage value, or receipt outcome not derived from
its completed-operation-versus-reconciliation-chain evidence form.
Admission-crash fixtures kill the process immediately after ordinary
failed-resume and reconcile transactions; they prove failed resume already
consumed its marker into a stable state and reconcile already owns a
subject-bound started operation with null observation. Pull-request crash
properties separately prove that zero POST admissions plus fresh exact
base/head/zero-list evidence permits one return to `remote_ready`, while one
admission—regardless of response or visible list count—can never return there
or admit a second POST. They enumerate pre-POST deterministic refusal as the
only legal `failed`/`remote_ready` pair. After admission they require
`succeeded` plus the exact suffix to select `created`/`landed`, `ambiguous`
plus the exact suffix to select `reconciled`/`landed`, and every other
`succeeded`, `ambiguous`, `failed`, or interrupted case to settle the operation
as interrupted with outcome `reconciliation_required`. Residue-matrix tests
enumerate every
subject/nextState/stageValue/outcome combination and prove exact `none`,
`branch`, `pull_request`, or `ambiguous` projection from the fresh facts,
including admitted-zero and incomplete-list PR visibility. Ordinal fixtures
exercise a reachable preflight `kindAttempt` 9 while `coordinatorAttempt`
remains at most 8 and reject 10. The reaching history uses one object
preflight refusal in each of attempts 2 through 7, then object and ref success
followed by PR pre-effect refusal in attempt 8. Multi-reconciliation fixtures
prove unresolved `reconciliation_required` links may preserve one subject
before exactly one later completed stage proof; a missing, completed too early,
subject-changing, or nonterminal chain cannot satisfy a delivery slot.
