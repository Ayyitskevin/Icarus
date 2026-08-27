# ADR 0043: Bounded GitHub gateway boundary

- Status: Accepted — records the authority boundary of the merged
  `packages/github-gateway` package (PRs #25–27) and the interface
  reconciliation that precedes coordinator wiring. Two contract-level questions
  named below remain **Open** and require an ADR 0027 amendment before Packet 4b
  can rely on either answer.
- Date: 2026-08-09
- Related:
  [ADR 0027](0027-git-landing-authority.md) (Git landing authority) and its
  [v1 record contract](0027-git-landing-v1-record-contract.md),
  [ADR 0036](0036-proof-carrying-software-factory-product-direction.md)
  (product direction),
  [continuation plan](../OPUS_CONTINUATION_PLAN_2026-08-09.md)

## Context

ADR 0027 defines the landing authority, the record contract, and the remote
effects Packet 4 may perform. It does not say how the provider client that
performs those effects is bounded. PRs #25–27 merged that client as
`packages/github-gateway` without a decision record, so its authority choices —
including two security corrections — existed only as code and a package README.
This ADR records them, and records what the package deliberately does *not*
decide.

At this ADR's 2026-08-09 checkpoint, the package was imported by no runtime
module. Nothing in this record alone granted a landing path; the coordinator
that would call this surface was Packet 4b.

Follow-up (2026-08-27): Packet 4b later wired this unchanged operation table
through the bounded coordinator and immutable receipt projection, and Packet 4c
completed the separately approved credential-gated live 3/3 record on
2026-08-23. ADR 0027 is the current authority and lifecycle record. Its
coordinator keeps the head-filter and bounded-page questions fail-closed; the
three dedicated live cases succeeded, but that observation is not a universal
claim about every GitHub repository or future page size. No merge, deletion,
deployment, active-repository canary, live-state migration, or unattended
authority followed.

## Decision

### The authority surface is one reviewable table

`GITHUB_OPERATIONS` is a frozen table of exactly nine kinds: read the
authenticated actor; create a blob, tree, and commit; create an absent
reference; create a draft pull request; read the Icarus reference; read the base
reference; and read pull requests for reconciliation. A caller names a kind. It
never supplies a URL, a path, an HTTP method, or a Git argument.

The HTTP method type admits `GET` and `POST` only. Reference updates, reference
deletion, pull-request merges, branch deletion, and deployment endpoints are
therefore **inexpressible** rather than merely unused: adding one requires
editing the method union and the operation table, which is a reviewable diff in
two named files rather than a new call site.

Adding a capability to this table is an ADR-level change.

### The base reference is readable, never writable

`read_base_reference` is the only operation that may name a reference outside
`refs/heads/icarus/`. It is `GET`-only, and `assertBaseRef` refuses an
Icarus-namespaced value, so the base-read path can never be used to observe or
reach the reference the create path owns. The two reads are separate kinds
because the record contract records them as separate HTTP kinds
(`github.base_ref.get` and `github.head_ref.get`), and because collapsing them
would weaken the namespace restriction to a caller convention.

This operation was absent from the merged package while the record contract
already defined it. The coordinator needs the base branch's commit as the
candidate commit's parent, so without it Packet 4b could not be written against
this surface at all.

### Repository automation is denied before upload

Creating `refs/heads/icarus/<run-id>` fires GitHub's `create` and `push` events,
and opening a same-repository draft pull request fires `pull_request`. In each
case the head branch's own automation definitions execute, with repository
secrets, before a human reviews the draft. Uploading such a file would therefore
convert this gateway's authorized sequence into arbitrary remote code
execution — an effect the operation table declares is not expressible.

The gateway denies six automation directories and ten root-level automation
filenames before any object upload, and refuses non-regular and executable file
modes. `@icarus/core`'s path policy is the authoritative layer; this is an
independent second layer covering the same class, because the two packages
cannot import each other.

This closed a real defect: the merged shape-only path allowlist accepted every
one of those files.

### A loopback origin requires an explicit opt-in

A loopback origin receives the credential in cleartext. It is supported for
offline tests and the deterministic benchmark transport only, and requires an
explicit `allowLoopback` construction flag, so an environment- or
configuration-derived base URL pointing at a local port cannot silently be
handed the token. Production wiring never passes it.

### Retry belongs to the coordinator, not the client

No mutating request is retried inside this package. An interrupted mutating
request is reported as `GITHUB_OUTCOME_AMBIGUOUS`: the host cannot know whether
GitHub applied the effect, and ADR 0027 forbids inferring failure from an absent
response. Only reads degrade to timeout, cancellation, or transport errors.

Retry, reconciliation, and settlement live with the coordinator's durable
intent, where they can be made restart-safe. A client-side retry would produce
duplicate remote effects that no durable record explains.

### A 422 is a refusal, never benign prior existence

GitHub answers 422 for an existing reference, a missing object, an unusable
name, and a ruleset or branch-protection refusal alike; it answers 422 for a
duplicate pull-request head, "no commits between", an invalid base, and
unsupported drafts alike. The gateway reads no upstream bytes, so it cannot
distinguish them and reports `GITHUB_REF_CREATE_REFUSED` and
`GITHUB_PULL_REQUEST_CREATE_REFUSED` without attributing a cause.

Reporting "already exists" would record a branch-protection refusal as benign
idempotency, permanently, in a durable receipt. The coordinator disambiguates
with the reads it already owns.

### Reconciliation prefers the unambiguous record and otherwise fails closed

GitHub permits many pull requests on one head so long as at most one is open, so
requiring "exactly one ever" deadlocks a run permanently after an ordinary
close-and-reopen. The read prefers a single open pull request, then a single
merged one, then a single closed one, and fails closed on genuine ambiguity.
Truncation is decided by the `Link: rel="next"` header rather than by a full
page.

Merge state is derived from a non-empty merge timestamp, consistently in both
the selection and the receipt: the list schema carries no merged boolean, and a
merged pull request's state is `closed` exactly like an abandoned one.

### Throttling is reported as bounded integers

A secondary rate limit is reported as 403, and so is an ordinary authorization
failure. `Retry-After` and `X-RateLimit-Remaining` are parsed into bounded
non-negative integers and carried beside the status, so the coordinator can
distinguish a wait-and-reconcile refusal from a terminal one. An unparsable,
negative, or out-of-range value becomes `null`; header text never reaches an
error detail.

### Arguments are values, not decoded records

The gateway takes validated value arguments (coordinates, references, object
names) rather than consuming a decoded `LandingHttpRequestV1`. The coordinator
owns durable admission and translates its records into values at the call
boundary.

The alternative — passing the decoded record — would require this package to
know the record contract's decoded types, inverting the dependency direction the
landing coordinator needs. The gateway must remain importable *by* core.
Duplicated wire constants are the accepted cost, pinned by
`tests/unit/github-gateway-record-contract.test.ts`, which fails the build if
either side drifts.

### Credentials and upstream bytes never reach evidence

The token is held in a private field, sent only to the pinned origin, and is
absent from serialization, own-key enumeration, error paths, and decoded blob
content. Errors carry a status, an operation, and a digest of the response
bytes. The reconstructed pull-request URL is derived from validated components
and never echoed from the response.

## Open questions requiring an ADR 0027 amendment

Both were found while preparing the coordinator wiring. Neither is a defect in
this package: in each case the gateway faithfully implements the accepted record
contract, and the contract itself is what needs a decision. Neither can be
resolved by a code change here, and the first cannot be resolved without a live
observation, which no agent session is authorized to make.

### 1. Identity case and the pull-request head filter

The record contract requires canonical lowercase GitHub identities: core's
`assertGitHubIdentityPart` rejects any value that differs from its own
lowercasing, for `owner`, `repository`, and `headOwner` alike. The gateway
mirrors this exactly.

Lowercase is safe for URL path segments, which GitHub resolves
case-insensitively. The unverified case is the reconciliation read's `head`
query parameter, which is matched as a *value* against a head label GitHub
builds from the canonical login case. This repository is the failure case: the
remote is `Ayyitskevin/Icarus`, and the contract records `ayyitskevin`.

If GitHub matches that filter case-sensitively, a reconciliation read returns an
empty list where a pull request exists. The consequence is bounded and
fail-closed rather than duplicating an effect: the coordinator would then
attempt creation, GitHub would answer 422, and the gateway reports
`GITHUB_PULL_REQUEST_CREATE_REFUSED`, which is a hold requiring operator
attention — not a second pull request. That is the correct failure direction,
but a landing that cannot reconcile is still a landing that cannot complete.

Resolving it requires one live observation and then, if the filter is
case-sensitive, an ADR 0027 amendment allowing the recorded `headOwner` to carry
the canonical login case while path segments stay lowercase. Packet 4b must not
assume either answer.

### 2. Page size against the response ceiling

ADR 0027 pins `per_page=100` for the reconciliation read, and core's record
contract enforces it as a literal. ADR 0027 separately pins a 1 MiB response
ceiling, which this package implements.

Real pull-request list entries carry full body text and can run to several
kilobytes each, so a busy head can exceed 1 MiB within the pinned page size and
produce `GITHUB_RESPONSE_TOO_LARGE` on a legitimate reconciliation read. That is
a second way to deadlock reconciliation, in the same place PR #27 fixed the
first one.

The gateway cannot change either number unilaterally: both are contract
literals, and lowering the page size would fail the coordinator's record
validation. The fix is an ADR 0027 amendment — a smaller pinned page with
bounded pagination, or a larger ceiling for this one read — decided together
with question 1, since both concern the same request.

## Consequences

The authority story is now written down where a reviewer looks for it, rather
than living in a package README, and the threat model carries matching rows. The
base-reference read unblocks Packet 4b. The two open questions are named as
contract work rather than being silently patched in a package that is not
entitled to decide them.

At this ADR's original checkpoint, `packages/github-gateway` remained wired to
nothing. The dated follow-up above records the later Packet 4b/4c outcome; this
ADR still grants no independent landing, push, merge, deployment, migration,
or live-credential authority. Those remain governed by ADR 0027 and the exact
operator-approved live-evidence profile.

### Retroactive review record for PRs #25–27

Those pull requests merged without an independent review record, which the
repository's release ritual requires. This ADR carries that debt forward
explicitly rather than treating the omission as closed: the package's authority
decisions are recorded above and its boundary is asserted by nine static
release-gate assertion groups and 82 focused tests, but no reviewer other than the author
examined the merged implementation. The Packet 4b review should treat the
gateway's call sites as unreviewed code.
