# ADR 0029: Browser approval authority

- Status: Accepted — ADR 0040 technical evidence is complete; origin
  portability remains held pending ADR 0040 human residual-risk acceptance
- Date: 2026-07-31
- Depends on: [ADR 0014](0014-loopback-api-react-workspace.md),
  [ADR 0022](0022-native-macos-windows-acceptance.md),
  [ADR 0023](0023-transactional-multi-file-patch-sets.md), and
  [ADR 0026](0026-agent-session-loop-and-tool-registry.md)
- Extends: ADR 0014's loopback workspace and supersedes only its
  review-only-browser restriction
- Related: [ADR 0019](0019-bounded-approval-provenance.md),
  [ADR 0027](0027-git-landing-authority.md),
  [ADR 0036](0036-proof-carrying-software-factory-product-direction.md), and
  rejected [ADR 0039](0039-portable-numeric-loopback-origins.md)
- Proposed partial supersession:
  candidate [ADR 0040](0040-chromium-resolved-localhost-origins.md) would
  replace only this record's operating-system lookup proof, arbitrary-browser
  portability claim, and corresponding origin-acceptance clauses upon
  acceptance

ADR 0039's random numeric `127/8` alternative was rejected after exact-head
native run
[30613980911](https://github.com/Ayyitskevin/Icarus/actions/runs/30613980911)
passed on Windows Server 2025 x64 and failed on macOS 15 arm64. ADR 0040's
technical exact-head gate later passed at `eb01b64` in Linux CI
[30618041483](https://github.com/Ayyitskevin/Icarus/actions/runs/30618041483)
and native real-Chrome run
[30618043377](https://github.com/Ayyitskevin/Icarus/actions/runs/30618043377).
ADR 0040 is still not accepted because its operator-controlled
browser/resolver/proxy residual risk requires explicit human acceptance. Until
that acceptance occurs, this record remains the authority contract and its
portable mutation claim remains held rather than released.

## Context

The workspace already presents real run state, approval digests, bounded
evidence, and a same-origin React application. It deliberately cannot approve
or execute a run. Operators must copy a digest into a CLI command, even though
the browser and CLI compose the same application service.

Adding a button is a security-boundary change. Loopback is not authentication:
another local process can send HTTP requests, a hostile website can attempt
cross-site requests, and the current server permits a missing `Origin`.
Repository and provider text rendered by the application are untrusted. A
browser-supplied actor, action kind, target, or digest cannot become authority.

The browser must also preserve the runtime's existing recovery semantics.
Closing a tab or losing an HTTP response cannot silently cancel work or cause an
automatic duplicate approval. Restarting the foreground server cannot erase,
replay, or reinterpret an operation already admitted in SQLite.

## Decision

### Authority stays in the kernel

The browser gains a narrow action transport, not a second state machine.
Handlers validate transport and exact request shape, then call the same core
authority used by the CLI. The core adds one
`executeFencedBrowserAction` entry point; the API never performs an
authority-bearing precheck and then calls a separately leased public method.
Store approval gates, Linux run leases, durable operation admission,
current-source/worktree revalidation, sun ceilings, check containment,
cancellation recovery, and state transitions remain authoritative.

The browser cannot construct a free-form command. The host publishes a closed
set of action descriptors derived from the current persisted run:

```text
egress.approve
plan.approve
review.approve
review.reject
rollback.approve
restore.approve
run.resume
run.cancel
```

ADR 0027 may later register `landing.approve` through the same transport only
after its separate landing digest, ledger, and recovery contract exist. No
route accepts an arbitrary tool, command, URL, provider, path, branch, Git
argument, deployment, migration, or future action string.

### Mutation session and fixed action actor

Every production workspace session that permits any protected `POST` creates
independent 32-byte bearer and 16-byte origin-nonce values with the operating-
system CSPRNG and uses the fresh random origin defined below. This mutation
session protects portable project, draft,
context-preview, and planning requests on Linux, macOS, and Windows. A
configured stable/plain-origin review-only start is strictly `GET`-only and
creates and emits no bearer. Guarded run actions are additionally disabled
unless all of these are true:

1. the host is Linux, which is the only platform with the accepted guarded
   approval/execution lease;
2. the foreground server receives one fixed operator actor at startup;
3. that actor passes the same byte, control-character, and
   secret-shaped-content validation as a CLI approval actor.

The token is encoded as canonical unpadded base64url. It lives only in server
memory and is never written to SQLite, an artifact, a URL query, a cookie, a
Git object, an event, an error, or an Icarus log. The server emits it only in
the operator launch URL fragment:

```text
http://<32-lowercase-hex-origin-nonce>.localhost:<port>/#icarus-action-session=<token>
```

Fragments are not sent in HTTP requests. The application reads the fragment
once, validates its shape, stores it in that tab's `sessionStorage`, and
immediately removes the fragment with `history.replaceState`. It never uses
`localStorage`, IndexedDB, a service worker, a cookie, application state that is
rendered, or a URL parameter. Reloading the same tab retains the token.
`sessionStorage` is a same-origin browser convenience, not a tab-isolation
security claim: some browsers may clone it into a duplicated or opener-created
tab, and any holder of the bearer has the same local authority.

Every mutation-capable server start rotates both origin and token. An old tab has
no mutation authority and may be disconnected from the new random origin; it
shows fixed read-only/relaunch copy rather than silently adopting the new
session. Restarted work is recovered from durable run state through the newly
emitted launch URL; the token itself is intentionally not a durable session.
Icarus never prints a separate token field or returns the token from an API
response.

The comparison requires the exact `Authorization: Bearer <token>` scheme,
canonical token length/encoding, and a constant-time byte comparison. Missing,
duplicated, malformed, or incorrect authorization receives the same bounded
response. The token is never copied into error details.

A mutation-capable production start on every supported OS binds only to
`127.0.0.1`, uses an
operating-system-selected ephemeral port, and creates an independent 128-bit
random lowercase hexadecimal origin label:

```text
http://<32-lowercase-hex-origin-nonce>.localhost:<port>/
```

The exact random hostname is part of the allowed `Host` and `Origin`; the
server never binds a non-loopback interface. A host that cannot resolve the
reserved `.localhost` suffix to loopback fails closed to review-only operation.
Before it creates a bearer, the server resolves the exact random hostname with
all-address lookup: the result must be nonempty, contain the bound
`127.0.0.1`, and contain no address other than exact `127.0.0.1` or `::1`.
Lookup failure, an empty set, IPv6-only resolution, another `127/8` address,
or any non-loopback answer selects a plain `127.0.0.1` review-only origin and
creates no bearer.
An explicitly configured stable port or a plain `127.0.0.1`/`localhost` origin
is also review-only. The per-start hostname, rather than port selection alone,
prevents a service worker registered on an older origin from supplying
attacker-controlled startup code that reads the new fragment. The CSP adds
`worker-src 'none'; manifest-src 'none'`; the workspace registers no service
worker, shared worker, or background sync. Stable-origin browser mutation
authority requires a future superseding design.

Candidate ADR 0040 retains the 16-byte `.localhost` origin nonce and exact
`127.0.0.1` socket bind but removes this Node/operating-system lookup proof. It
would support mutation only in real-accepted Chromium-family browsers using
their built-in reserved-name handling, with no resolver injection. Safari and
other unverified browsers would use an operator-selected explicit-port,
bearer-free review-only session; the server cannot infer browser support or
automatically downgrade a navigation that never reaches it.

### Protected HTTP requests

All state-changing workspace routes, all provider-starting routes, and the
action endpoint require:

- the existing exact loopback `Host` policy;
- a present `Origin` whose scheme, host, and port exactly match the bound
  workspace origin;
- no CORS grant;
- the exact bearer token;
- `Content-Type: application/json`;
- the existing 64 KiB request limit;
- a route-specific exact-key schema that also rejects duplicate JSON members;
  and
- a custom `X-Icarus-Action` header whose one value matches the parsed action
  discriminator, or `workspace.mutate` for an existing non-gate mutation.

This protection covers project creation, draft creation, planning, and every
gate action. Read-only `GET` routes remain usable without a token. Context
preview remains a non-persisting operation, but its existing `POST` route also
requires the protected transport so the rule stays method-total. No authority
route accepts a missing `Origin`, even though read-only navigation may.

The combination of an unreadable fragment token, strict same-origin validation,
a non-simple custom header, no CORS response, and the existing CSP is the local
CSRF boundary. It does not claim protection from arbitrary code already running
as the same OS user or from a malicious browser extension.

The server counts `Host`, `Origin`, `Authorization`, `Content-Type`, and
`X-Icarus-Action` occurrences from `rawHeaders`; a missing required header or
any duplicate is rejected rather than relying on Node's merged header view.
Bearer and Origin validation happens before body bytes are read or parsed.
Bearer material in a query, cookie, or body grants nothing. `OPTIONS` returns
no CORS permission, and an action endpoint with any query parameter is invalid.
All missing, malformed, duplicate, stale-server, and incorrect bearers receive
the same bounded `401 ACTION_SESSION_REQUIRED`. A stale action or busy run is a
bounded `409`; malformed schema, media type, and body-size failures retain
their bounded non-authority responses.

### Host-derived action descriptor

For each currently available action the presenter returns an allowlisted
descriptor:

```text
{
  version: 1,
  kind: <closed discriminator>,
  runId: <run UUID>,
  expectedState: <exact persisted state>,
  eventRevision: <current append-only sequence>,
  subjectDigest: <gate/checkpoint/diff digest or null>,
  activeActionId: <in-flight action UUID for coordinated cancellation or null>,
  activeActionDigest: <in-flight descriptor sha256 or null>,
  actionDigest: sha256(canonical descriptor),
  label: <host-controlled copy>
}
```

`actionDigest` covers exactly the descriptor version, kind, run ID, expected
state, event revision, subject digest, active action ID, and active action
digest. Its bytes are the UTF-8 encoding of this exact JSON tuple with JSON
`null` for absent values:

```text
[1,kind,runId,expectedState,eventRevision,subjectDigest,activeActionId,activeActionDigest]
```

No whitespace or alternate key order exists. The display label, bearer, and
actor are excluded. Repository/provider copy is never digest input. An
in-flight cancellation binds the exact active action ID and descriptor digest.
Review approval and rejection therefore have different action digests even
though both refer to the same diff.

The action form displays the exact state, event revision, subject digest,
action kind, and consequence before enabling a deliberate operator button. The
browser returns those exact values. It cannot supply an actor; the server uses
the validated startup actor. It cannot replace the descriptor label or add a
field.

The one action endpoint is:

```text
POST /api/runs/:runId/actions
```

Its body is a discriminated union with exact keys:

```text
{
  actionId: <UUID>,
  version: 1,
  kind: <closed discriminator>,
  runId: <run UUID>,
  expectedState: <state>,
  eventRevision: <safe positive integer>,
  subjectDigest: <lowercase sha256 or null>,
  activeActionId: <UUID or null>,
  activeActionDigest: <lowercase sha256 or null>,
  actionDigest: <lowercase sha256>
}
```

The path `runId`, body `runId`, and descriptor `runId` must be identical. The
`X-Icarus-Action` header must equal `kind`. The server reconstructs the
descriptor from authoritative state and rejects any mismatch before provider,
filesystem, Git, sandbox, or recovery effects.

For every ordinary action,
`IcarusService.executeFencedBrowserAction` acquires the Linux run lease exactly
once, transactionally reconstructs and compares state, event revision, subject
digest, active-action binding, and action digest, admits the durable browser
request, and dispatches to private unleased primitives shared by the existing
CLI entry points. No event, operation admission, usage charge, provider call,
or filesystem effect may precede that comparison and admission. The existing
store gate then independently rechecks state and the action's subject digest in
the final approval transaction. The public CLI methods acquire the lease and
call the same primitives; they do not call the browser wrapper. A stale browser
view fails closed as `STALE_ACTION` and returns no attacker-controlled detail.

The subject digest mapping is fixed:

| Action | State | Subject |
| --- | --- | --- |
| `egress.approve` | `awaiting_egress_approval` | context digest |
| `plan.approve` | `awaiting_approval` | plan digest |
| `review.approve` | `awaiting_review` with a complete browser-rehashed diff | current diff digest |
| `review.reject` | `awaiting_review` | current diff digest |
| `rollback.approve` | `completed` | current diff digest |
| `restore.approve` | `rolled_back` | checkpoint digest |
| `run.resume` | `failed` with a resumable state, or a started/interrupted `preparing`, `planned`, `running`, `verifying`, `rolling_back`, `restoring`, or `cancelling` operation proven orphaned by browser-action reconciliation with no current coordinator owner | null |
| `run.cancel` | `preparing`, `planned`, `awaiting_egress_approval`, `awaiting_approval`, `running`, `verifying`, `awaiting_review`, or `failed` | null |

An unavailable prerequisite means the descriptor is absent. The UI never
guesses action availability from a product phase. Review approval remains
absent unless current recorded verification is passing and no session blocker
exists. It is also absent when the persisted diff is outside the 256 KiB
browser bound or has only `recorded_only` provenance; a digest without the
complete reviewed bytes is not review. The service still performs live
revalidation at use time.

The browser deliberately exposes `review.reject`, rather than the CLI's
additional `rollback` spelling, while a run is `awaiting_review`.
`rollback.approve` is reserved for undoing a previously accepted `completed`
run. This narrows browser authority without changing CLI compatibility.

`run.resume` preflights the exact state, revision, and recovery evidence before
appending `resume.requested` or marking a started operation interrupted.
`run.cancel` performs the same preflight before interrupting operations or
writing cancellation intent. This deliberately tightens the current CLI
ordering, where those writes begin before all browser-specific stale checks.
The browser's `resume.requested`, cancellation request, and signal-cancellation
events record the fixed startup actor through one shared byte/control/secret
validated actor type. As in ADR 0019, this is bounded operator attribution, not
an authenticated account claim.

### Capability and consequence display

Plan approval is disabled until the selected-run response and UI expose the
complete bounded authority being approved:

- plan digest, exact targets, and registered check IDs;
- every capability grant's kind, sorted scope, and `maxCalls`;
- `iterationCeiling`;
- the resolved readable manifest's digest plus every approved path/digest pair
  (or an explicit absent manifest), not merely the provider-authored scope;
- context digest and base commit;
- every registered check's ID, name, and exact argv;
- the exact configured digest-pinned sandbox image reference already bound by
  `planApprovalDigest`, plus every sandbox limit;
- provider kind, model, canonical capabilities, locality, configured endpoint,
  and configured input/output rates;
- project file, byte, operation, token, cost, runtime, and timeout ceilings;
- the fact that execution is Linux-only and checks require the sandbox; and
- the effect of approval: private cache/worktree creation, provider edit work,
  registered checks, and eventual review—not commit, push, merge, or deploy.

Repository, provider, check, plan, and error text renders only as text. It never
becomes an action kind, header, URL, accessible action name, or confirmation
copy that can obscure the host-controlled consequence.

### Durable request idempotency

The action transport has an additive `browser_action_requests` ledger in the
same SQLite database. It stores no bearer or credential:

```sql
CREATE TABLE IF NOT EXISTS browser_action_requests (
  action_id TEXT NOT NULL PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  kind TEXT NOT NULL CHECK (kind IN (
    'egress.approve', 'plan.approve', 'review.approve', 'review.reject',
    'rollback.approve', 'restore.approve', 'run.resume', 'run.cancel'
  )),
  expected_state TEXT NOT NULL,
  expected_event_revision INTEGER NOT NULL CHECK (
    typeof(expected_event_revision) = 'integer' AND
    expected_event_revision BETWEEN 1 AND 9007199254740991
  ),
  subject_digest TEXT CHECK (
    subject_digest IS NULL OR (
      length(subject_digest) = 64 AND
      subject_digest NOT GLOB '*[^0-9a-f]*'
    )
  ),
  action_digest TEXT NOT NULL CHECK (
    length(action_digest) = 64 AND
    action_digest NOT GLOB '*[^0-9a-f]*'
  ),
  parent_action_id TEXT,
  parent_action_digest TEXT CHECK (
    parent_action_digest IS NULL OR (
      length(parent_action_digest) = 64 AND
      parent_action_digest NOT GLOB '*[^0-9a-f]*'
    )
  ),
  actor TEXT NOT NULL CHECK (
    length(CAST(actor AS BLOB)) BETWEEN 1 AND 200 AND
    instr(actor, char(0)) = 0 AND instr(actor, char(10)) = 0 AND
    instr(actor, char(13)) = 0
  ),
  status TEXT NOT NULL CHECK (status IN ('prepared', 'admitted', 'settled')),
  outcome TEXT CHECK (outcome IS NULL OR outcome IN (
    'succeeded', 'refused', 'failed', 'cancelled',
    'reconciliation_required'
  )),
  admission_event_sequence INTEGER CHECK (
    admission_event_sequence IS NULL OR (
      typeof(admission_event_sequence) = 'integer' AND
      admission_event_sequence BETWEEN 1 AND 9007199254740991
    )
  ),
  domain_event_sequence INTEGER CHECK (
    domain_event_sequence IS NULL OR (
      typeof(domain_event_sequence) = 'integer' AND
      domain_event_sequence BETWEEN 1 AND 9007199254740991
    )
  ),
  domain_operation_id TEXT REFERENCES operations(id),
  error_code TEXT CHECK (
    error_code IS NULL OR (
      length(error_code) BETWEEN 2 AND 128 AND
      error_code NOT GLOB '*[^A-Z0-9_]*'
    )
  ),
  created_at TEXT NOT NULL CHECK (length(CAST(created_at AS BLOB)) BETWEEN 20 AND 35),
  updated_at TEXT NOT NULL CHECK (length(CAST(updated_at AS BLOB)) BETWEEN 20 AND 35),
  UNIQUE(action_id, action_digest, run_id),
  FOREIGN KEY (run_id, admission_event_sequence)
    REFERENCES run_events(run_id, sequence),
  FOREIGN KEY (run_id, domain_event_sequence)
    REFERENCES run_events(run_id, sequence),
  FOREIGN KEY (parent_action_id, parent_action_digest, run_id)
    REFERENCES browser_action_requests(action_id, action_digest, run_id),
  CHECK (
    length(action_id) = 36 AND
    substr(action_id, 9, 1) = '-' AND substr(action_id, 14, 1) = '-' AND
    substr(action_id, 19, 1) = '-' AND substr(action_id, 24, 1) = '-' AND
    substr(action_id, 15, 1) IN ('1','2','3','4','5','6','7','8') AND
    substr(action_id, 20, 1) IN ('8','9','a','b') AND
    length(replace(action_id, '-', '')) = 32 AND
    replace(action_id, '-', '') NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (
    (kind = 'egress.approve' AND expected_state = 'awaiting_egress_approval' AND subject_digest IS NOT NULL AND parent_action_id IS NULL AND parent_action_digest IS NULL) OR
    (kind = 'plan.approve' AND expected_state = 'awaiting_approval' AND subject_digest IS NOT NULL AND parent_action_id IS NULL AND parent_action_digest IS NULL) OR
    (kind IN ('review.approve', 'review.reject') AND expected_state = 'awaiting_review' AND subject_digest IS NOT NULL AND parent_action_id IS NULL AND parent_action_digest IS NULL) OR
    (kind = 'rollback.approve' AND expected_state = 'completed' AND subject_digest IS NOT NULL AND parent_action_id IS NULL AND parent_action_digest IS NULL) OR
    (kind = 'restore.approve' AND expected_state = 'rolled_back' AND subject_digest IS NOT NULL AND parent_action_id IS NULL AND parent_action_digest IS NULL) OR
    (kind = 'run.resume' AND expected_state IN ('preparing', 'planned', 'running', 'verifying', 'rolling_back', 'restoring', 'cancelling', 'failed') AND subject_digest IS NULL AND parent_action_id IS NULL AND parent_action_digest IS NULL) OR
    (kind = 'run.cancel' AND expected_state IN ('preparing', 'planned', 'awaiting_egress_approval', 'awaiting_approval', 'running', 'verifying', 'awaiting_review', 'failed') AND subject_digest IS NULL AND ((parent_action_id IS NULL AND parent_action_digest IS NULL) OR (parent_action_id IS NOT NULL AND parent_action_digest IS NOT NULL)))
  ),
  CHECK (
    (status = 'prepared' AND outcome IS NULL AND admission_event_sequence IS NULL AND domain_event_sequence IS NULL AND domain_operation_id IS NULL AND error_code IS NULL) OR
    (status = 'admitted' AND outcome IS NULL AND admission_event_sequence IS NOT NULL AND error_code IS NULL) OR
    (status = 'settled' AND outcome IS NOT NULL)
  ),
  CHECK (
    status <> 'settled' OR
    (outcome = 'refused' AND admission_event_sequence IS NULL AND domain_event_sequence IS NULL AND domain_operation_id IS NULL AND error_code IS NOT NULL) OR
    (outcome IN ('succeeded', 'cancelled') AND admission_event_sequence IS NOT NULL AND domain_event_sequence IS NOT NULL AND error_code IS NULL) OR
    (outcome IN ('failed', 'reconciliation_required') AND admission_event_sequence IS NOT NULL AND error_code IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS browser_action_requests_active_non_cancel
ON browser_action_requests(run_id)
WHERE status IN ('prepared', 'admitted') AND kind <> 'run.cancel';

CREATE UNIQUE INDEX IF NOT EXISTS browser_action_requests_active_cancel
ON browser_action_requests(run_id)
WHERE status IN ('prepared', 'admitted') AND kind = 'run.cancel';
```

An in-flight cancellation row names the exact active non-cancellation action as
its parent and snapshots that parent's exact descriptor digest; an ordinary
state-based cancellation has a null parent pair. Both rows must name the same
run through the composite foreign key.

Store validation supplements—not replaces—the attested DDL. Before every
insert/update it requires canonical timestamps, the shared control/secret-safe
actor validator, a canonical UUID for every action and operation ID, and these
cross-record truths:

| Record relation | Required truth |
| --- | --- |
| parent action | at cancel admission it is the same-run, `admitted`, non-cancel action whose stored action digest matches the parent digest |
| admission event | same run and action ID, exact type `browser.action.admitted` |
| domain event | same run, payload names this action ID, and type is allowed by the action-boundary table below |
| domain operation | same run, detail names this action ID, and kind is allowed by the action-boundary table below |
| prepared refusal | has no admission or domain anchor |
| admitted crash | may have the admission event but no domain anchor yet |
| successful/cancelled settlement | has the exact terminal domain event |
| failed settlement | has a safe error code; a domain anchor is optional only when failure preceded the first domain effect |
| reconciliation settlement | has a safe error code and only anchors proven from durable records |

Exact table, foreign-key, check, and index SQL plus these validators are
normalized and inspected/tested before a writable database handle opens; a
partial or lookalike schema fails closed.

`actionId` is a canonical lowercase RFC 4122 UUID generated for one deliberate
click. Its immutable identity tuple is every body field; the original actor is
immutable attribution stored alongside it, not client authority and not a
reason to reinvoke an admitted effect. `activeActionId` and
`activeActionDigest` map to the parent pair. The server first inserts that exact
tuple as `prepared`. After acquiring the Linux run lease it rechecks the
descriptor and atomically changes the row to `admitted`
with a bounded `browser.action.admitted` event before any provider, filesystem,
Git, sandbox, recovery, or approval effect. The service propagates the action
ID into the first domain transition/operation anchor. Settlement records the
resulting domain event sequence or operation ID and bounded outcome; it never
stores a serialized HTTP response.

The ledger is transport intent and correlation, not grant authority. The
action digest and existing domain gates still decide what may happen.

- the same action ID and byte-identical request tuple returns the recorded
  settled outcome plus a fresh allowlisted run view;
- the same action ID with any different field is `ACTION_ID_CONFLICT`;
- a `prepared` request may repeat admission because it proves no domain action
  was admitted;
- an `admitted` request is never blindly reinvoked. The handler reconciles its
  exact domain event/operation anchor. A complete matching boundary settles it;
  an incomplete or ambiguous boundary becomes `reconciliation_required`.
  Reconciliation then publishes only the freshly authorized action derived
  from current persisted state: the original gate action may be retried when
  the run still occupies that exact gate, while `run.resume` appears only in
  its enumerated resumable states; and
- a terminal refusal settles with its safe error code so retries cannot turn a
  rejected stale request into a new action.

Approval/transition settlement should update the request row in the same SQLite
transaction whenever the domain boundary is transaction-local. Long-running
service completion cannot be one database transaction; its admitted action ID,
domain operation ledger, and final boundary provide the restart proof. No
external effect is retried merely because the HTTP receipt is absent.

The domain-boundary table is normative. Every named event or operation carries
`browserActionId`; a terminal event used as settlement also carries it:

| Kind | First permitted domain anchor | Successful terminal boundary | Failed/cancelled boundary | Restart rule after admission |
| --- | --- | --- | --- | --- |
| `egress.approve` | `egress.validate` operation or `egress.approved` event | `plan.created` and `awaiting_approval` | matching failed `egress.validate` operation, `run.failed`, or `cancellation.completed` | settle only a matching terminal; otherwise reconciliation required |
| `plan.approve` | `approval.validate` operation or `plan.approved` event | `verification.completed`, `session.completed`, `session.awaiting_human`, or `session.exhausted`, with `awaiting_review` | matching failed `approval.validate` operation, `run.failed`, or `cancellation.completed` | same |
| `review.approve` | `review.validate` operation or `review.accepted` event | `review.accepted` and `completed` | matching failed `review.validate` operation, `run.failed`, or `cancellation.completed` | same |
| `review.reject` | `review.rejected` event or `checkpoint.rollback` operation | `rollback.completed` and `rolled_back` | `run.failed` | same |
| `rollback.approve` | `rollback.approved` event or `checkpoint.rollback` operation | `rollback.completed` and `rolled_back` | `run.failed` | same |
| `restore.approve` | `restore.approved` event or `checkpoint.restore` operation | `verification.completed`, `session.completed`, `session.awaiting_human`, or `session.exhausted`, with `awaiting_review` | `run.failed` | same |
| `run.resume` | `resume.requested`, `run.resumed`, or the resumed stage's first operation | an action-bound stable gate/terminal state: `awaiting_egress_approval`, `awaiting_approval`, `awaiting_review`, `rolled_back`, or `cancelled` | `run.failed`, or `cancellation.completed` only when the resumed stage was `preparing`, `planned`, `running`, or `verifying` | settle only when the action-linked event chain proves the stable state; otherwise reconciliation required |
| `run.cancel` | `cancellation.requested` event | `cancellation.requested` and `cancelling`; later recovery is observed through run state | refusal before request or later `run.failed` is run recovery evidence, not a reason to repeat the action | settle at the matching request event; never signal again automatically |

On every server start, before guarded descriptors are published,
`reconcileBrowserActionRequests` examines active rows under each available
Linux run lease and performs no provider, filesystem, Git, sandbox, or network
effect. A row whose lease is held by another live process remains active and is
presented as busy. Otherwise:

- an orphaned `prepared` row settles `refused/ACTION_NOT_ADMITTED` because it
  has no admission event and therefore no domain effect;
- an `admitted` row with one exact successful, failed, or cancelled terminal
  boundary settles to that observed outcome;
- an `admitted` row without a complete unambiguous terminal boundary settles
  `reconciliation_required/ACTION_RECOVERY_REQUIRED`; and
- only after those rows no longer occupy a partial unique index may a fresh
  descriptor, including `run.resume`, be published.

The selected-run view exposes one bounded `browserActionRecovery` receipt for
the newest active or reconciliation-required request: action ID, kind, status,
outcome, safe error code, and update time only. It exposes no actor, request
digest, subject, provider/repository copy, or domain payload. A read-only
`GET /api/runs/:runId/actions/:actionId` returns the same bounded receipt so a
client that knows its pending ID can poll after an HTTP timeout. Neither read
path admits, settles, or retries work.

Existing portable project/draft/planning mutations remain protected by the
bearer and exact schemas. Their current unique/store gates stay authoritative;
they do not masquerade as digest approvals. A future automatic retry for those
routes requires its own idempotency key before it may ship.

Existing state databases require the separate exact one-shot migration token
`browser-action-ledger-v1` after all Icarus processes stop and a verified backup
of SQLite, WAL/SHM, artifacts, runs, and locks is taken. The CLI is the only
migration lane. Workspace startup cannot approve a migration. New databases
create the table and both indexes normally; existing rows are never rewritten.
Read-only preflight proves the old schema is complete and the new table and
indexes are either all absent or exactly correct before any WAL or database
write. Wrong, missing, combined, or reused migration authorization and every
partial/lookalike schema fail before write. Restoring the verified complete
backup is the schema rollback.

Gate 1 migration order is exact:
`browser-action-ledger-v1` precedes ADR 0027's `landing-ledger-v1`. One
migration invocation is a CLI-only maintenance process that applies and
verifies one schema, then exits before normal runtime startup. Its read-only
preflight classifies both known Gate 1 schema families as wholly absent, exact,
or partial/malformed. While applying this browser schema, a wholly absent
landing schema is tolerated but never created; a partial or malformed landing
object still fails closed. Supplying the landing token while this browser
schema is absent returns `MIGRATION_ORDER_REQUIRED` before WAL or database
write. The next explicit invocation may apply the landing schema only after
this table and both indexes verify exact. No delimiter, list, or second
environment value can combine the two tokens.

### Disconnect, cancellation, and restart behavior

An HTTP transport disconnect is not a cancellation request. Once an action
passes transport validation, the server does not bind its service signal to the
socket. The deliberate `run.cancel` action is the only browser request that
asks the kernel to cancel a run.

The server owns one process-local action coordinator keyed by run ID. After
transport and descriptor validation and before invoking the service, it records
the active action digest and an `AbortController`. This map is concurrency
coordination only: it grants no action, survives no restart, and is never
presented as durable evidence. A second non-cancellation action for that run
receives `RUN_BUSY`.

An authenticated `run.cancel` for an action currently owned by that coordinator
validates the active run, action ID, active descriptor digest, and coordinator
generation against a coherent store snapshot and signals its controller
instead of waiting forever behind the same run lease. This is the sole
lease-acquisition carve-out: the already-running fenced action owns the lease
and lands cancellation through its durable `cancelling` and recovery path with
the fixed startup actor instead of the current generic `operator-signal` label.
The coordinator never exposes in-flight cancellation for rollback, restore, or
cancellation recovery. When no browser action is active, cancellation follows
the ordinary freshly fenced state/revision descriptor and service path. Socket
close never signals this controller.

The in-flight carve-out has its own exact admission sequence. In one SQLite
transaction, without acquiring the parent-held run lease, the store inserts and
admits the cancel row plus `browser.action.admitted` only after proving the
parent row is `admitted`, non-cancel, same-run, and matches the bound parent
action digest. The coordinator generation is checked immediately before the
transaction and again after it commits. A failed pre-transaction check records
only a prepared refusal; a failed post-commit check settles the admitted row as
`failed/COORDINATOR_CHANGED` with its admission event. Neither case signals a
controller. Otherwise the coordinator abort reason carries the cancel action ID
and fixed actor. The parent service, while still holding the lease, atomically
writes the action-linked
`cancellation.requested` event and settles the cancel row; later cancellation
recovery determines the parent action's terminal outcome. A process death after
the signal but before that event makes the admitted cancel row
`reconciliation_required` at startup. Recovery never automatically sends the
signal again.

The browser may poll the same action ID after a timeout or disconnect, but it
never automatically submits a new ID or repeats an `admitted` effect. It marks
unknown outcomes honestly and reconciles the durable request/domain records.
An interrupted provider/tool/check/recovery operation retains the existing
conservative charge and explicit `run.resume` path. A server-process death
rotates the bearer but does not alter the request, operation, or recovery
ledgers.

An operator confirmation snapshots one exact descriptor. Polling may invalidate
and close that confirmation, but the client never substitutes a newer
revision, digest, active-action binding, or action ID into an already opened
confirmation.

Graceful shutdown first stops new action admission, then drains coordinator
promises before closing SQLite. A bounded second signal or hard process death
may interrupt the process and relies on the durable request/operation recovery
contract; it never closes the runtime underneath a still-admitted promise and
then reports success.

### Portable and CLI behavior

macOS and Windows keep the complete review workspace plus protected
registration, context, draft, and planning support from ADR 0022. They do not
receive approval, execution, rollback, restore, resume, or cancellation
buttons. The API returns an explicit unsupported capability before any guarded
effect instead of attempting to emulate the Linux lease.

CLI commands remain available and preserve their current actor, digest, signal,
and maintenance behavior. The browser does not become a schema-migration,
state-root, secret, or recovery-maintenance surface.

## Acceptance evidence required

Implementation is not accepted until all of the following pass on one exact
tree:

1. unit tests for token generation/encoding, constant-time dummy validation for
   malformed values, shared fixed-actor validation, exact JSON-tuple
   action-descriptor canonicalization, and every state/digest/action mapping;
2. API tests covering missing/wrong/duplicated token, absent/cross-origin/null
   `Origin`, hostile `Host`, every duplicated security header, header/body
   mismatch, wrong content type, duplicate/unknown JSON fields,
   query/cookie/body token attempts, oversized body, stale
   state/revision/digest, unavailable action, and unsupported platform with zero
   service effects;
3. integration tests proving each existing action reaches only the matching
   service method, uses the fixed actor, and preserves the CLI's refusal,
   approval, operation, event, usage, worktree, and source-checkout invariants;
4. coordinator tests proving same-run exclusion, authenticated in-flight
   cancellation bound to the exact coordinator generation and active descriptor
   with the fixed actor, no cancellation from a stale or unrelated run/action
   identity, no recovery-action cancellation, and no in-memory state treated as
   recovery evidence;
5. disconnect tests proving the admitted action continues, no automatic retry
   occurs, and the UI reconciles its durable result;
6. process-kill/restart tests at a durable operation boundary proving a new
   token is required and existing resume/recovery behavior remains truthful;
7. browser tests proving fragment removal, session-scoped storage without an
   absolute tab-isolation claim, read-only fallback, capability/ceiling
   display, complete readable-manifest and check-command display,
   keyboard-visible deliberate controls, stale-action refusal, and
   repository/provider strings rendered only as text;
8. origin tests proving every mutation-capable start has a new random
   `.localhost` hostname and ephemeral port, stable/plain origins reject every
   protected POST, failed/empty/IPv6-only/alternate-loopback/non-loopback
   resolution downgrades to a bearer-free review-only origin, the workspace
   has no service-worker registration, and CSP forbids workers; candidate ADR
   0040 would replace the resolver cases with exact-bind/no-lookup assertions
   and real Chrome native composition upon acceptance;
9. ledger tests proving same ID/same identity tuple reconciliation, same
   ID/different tuple conflict, the separate non-cancel/cancel uniqueness
   rules, exact DDL and validator truth table, parent/run/domain-anchor
   integrity, prepared retry, admitted no-blind-replay, transaction-local
   settlement, startup settlement of orphaned prepared/admitted rows, busy-live
   lease preservation, bounded recovery receipts, and descriptor publication
   only after reconciliation;
10. in-flight-cancel crash tests covering both coordinator-generation checks,
    atomic parent-bound admission, abort-reason action/actor propagation,
    request-event settlement inside the parent lease, death before that event,
    and proof that restart never resends the signal;
11. migration tests covering new, absent, exact-token, wrong-token,
    combined-token, both-Gate-1-schemas-missing, landing-token wrong-order,
    one-schema-per-process exit, partial-table or malformed-index in either
    known schema family, pre-WAL refusal, unchanged-old-row, and
    verified-backup restoration cases;
12. static tests proving no token persistence/logging, no actor request field,
    no raw-HTML sink, no arbitrary action/command/URL route, and no authority
    on native non-Linux lanes; and
13. the full local release gate, source fingerprint, exact-head Linux CI, and
    unchanged native read-only acceptance.

## Consequences

The browser becomes a useful local operator surface without becoming an
independent authority plane. Manual digest transcription disappears, while the
digest, revision, actor, consequence, and kernel gate remain explicit.

The server launch URL is emitted once to the invoking operator's terminal and
is a bearer capability for one foreground process and one OS-user trust
boundary. It is not copied to structured logs or durable state. Operators must
not reverse-proxy it, expose it to LAN or Tailscale, paste it into shared logs,
or treat it as multi-user authentication. Remote access, accounts, teams, and
hostile same-user isolation require a later identity/authentication decision.

Mutation-capable sessions cannot use a configured stable origin. Operators who
need a bookmarkable review URL retain the current read-only mode and launch a
fresh random-origin session only when they intend to mutate state.

This ADR adds no Git landing, push, pull request, deployment, migration,
provider credential entry, browser shell, model-authored command, background
daemon, WebSocket, service worker, or remote API authority.
