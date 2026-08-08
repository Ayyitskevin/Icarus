# @icarus/github-gateway

A bounded client for the exact GitHub effects Packet 4 authorizes. It performs
one validated call at a time and owns no durability, approval, or state
transition: the landing coordinator in `@icarus/core` owns intent, settlement,
and recovery.

This package imports nothing from `@icarus/core`, so `core` can depend on it
without a cycle.

## Authorized operations

`GITHUB_OPERATIONS` is the whole authority surface — one reviewable constant:

| Kind | Method | Endpoint |
| --- | --- | --- |
| `read_actor` | GET | `user` |
| `create_blob` | POST | `repos/{owner}/{repo}/git/blobs` |
| `create_tree` | POST | `repos/{owner}/{repo}/git/trees` |
| `create_commit` | POST | `repos/{owner}/{repo}/git/commits` |
| `create_absent_ref` | POST | `repos/{owner}/{repo}/git/refs` |
| `create_draft_pull_request` | POST | `repos/{owner}/{repo}/pulls` |
| `read_reference` | GET | `repos/{owner}/{repo}/git/ref/{ref}` |
| `read_pull_requests` | GET | `repos/{owner}/{repo}/pulls?head=…&base=…` |

## What cannot be expressed

These are absent from the type surface, not merely unused. Adding one means
editing the operation table under its own ADR.

- **Reference update, force update, or deletion.** Only `GET` and `POST` appear
  in this package; updating a reference needs `PATCH`, deleting it needs
  `DELETE`. Reference creation uses `POST /git/refs`, which GitHub refuses when
  the reference already exists, so nothing here can overwrite or fast-forward.
- **Merge, deployment, workflow dispatch, release publication.**
- **A non-draft pull request.** `draft: true` is a literal, never a parameter.
- **A caller-supplied URL, path, HTTP method, or Git argument.** Callers name an
  operation kind and typed parameters; paths are built from the fixed table.
- **A reference outside `refs/heads/icarus/<run-id>`**, matching the private
  local namespace Packet 3 already writes.
- **Sending the credential anywhere but `api.github.com`** over HTTPS, or a
  loopback origin for offline tests. The base URL must be the origin root, and a
  built URL that left the pinned origin is never dispatched. Redirects are never
  followed.
- **Uploading continuous-integration configuration.** Creating the reference
  fires GitHub's `create` and `push` events, and a same-repository pull request
  fires `pull_request`; in each case the head branch's own automation would run
  with repository secrets before a human reviewed the draft. `.github/**` and the
  other CI roots and files are refused with `GITHUB_AUTOMATION_PATH_DENIED`.
  `@icarus/core`'s path policy is the authoritative layer; this is an
  independent second one, because the two packages cannot import each other.

`read_actor` is the one endpoint outside a repository path. ADR 0027 requires
the credential's login to be verified against the landing profile's expected
actor before any other call in a sequence, so a swapped or wrong-account token
cannot silently act as another identity.

## Agreement with the record contract

The wire format is fixed by the accepted ADR 0027 record contract, implemented
in `@icarus/core`'s `landing-records.ts`: `X-GitHub-Api-Version: 2026-03-10`,
lowercase-only owner and repository identities, and UTF-8 byte ceilings of 4 KiB
for a commit message, 256 B for a pull request title, and 40 KiB for a body.

This package cannot import those constants without inverting the dependency
direction the landing coordinator needs, so it duplicates them and
`tests/unit/github-gateway-record-contract.test.ts` asserts the two sides agree.
Editing either alone fails the build.

## Ambiguity discipline

The host must never infer failure from an absent response. An interruption —
timeout, cancellation, or transport error — after a *mutating* request is
dispatched raises `GITHUB_OUTCOME_AMBIGUOUS`, because whether GitHub applied the
effect is unknown. Interrupted reads raise ordinary `GITHUB_TIMEOUT`,
`GITHUB_CANCELLED`, or `GITHUB_TRANSPORT_ERROR`.

A refused reference creation reports `GITHUB_REF_CREATE_REFUSED`, not "already
exists". GitHub returns 422 for an existing reference, a missing object, an
unusable name, and a ruleset or branch-protection refusal alike; reading no
upstream bytes means the gateway cannot tell them apart, and recording a
protection refusal as benign idempotency would be a false claim. The coordinator
disambiguates with the reference read it already owns.

Reconciliation reads pin ADR 0027's exact parameters (`state=all`, `page=1`,
`per_page=100`, plus the exact owner-qualified head and base). A full page or
more than one match raises `GITHUB_RECONCILIATION_AMBIGUOUS` rather than being
read as "no pull request exists".

There is no automatic retry of a mutating request. ADR 0027 places retry with
the coordinator's durable intent and reconciliation, where it can be made
idempotent; a gateway-internal retry could duplicate a remote effect.

A reconciliation receipt verifies the head and base of the pull request it
returns rather than restating the caller's arguments, and reports `isMerged`
derived from the merge timestamp — a merged pull request's `state` is `closed`,
identical to an abandoned one.

## Evidence discipline

No upstream response byte reaches an error or a receipt. Failures carry the
status, the operation kind, and `responseSha256` — the digest of the exact
response bytes — so evidence correlates without carrying foreign content. The
pull request URL in a receipt is reconstructed from validated components rather
than echoed from the response.

Digests bind bytes. They establish no authenticity, authorization, or authority
to land code.

## Testing

Contract tests drive a real loopback HTTP server (`tests/support/provider-http.ts`),
the same pattern the provider adapters use. No test contacts GitHub, and the
package holds no credential of its own.

- `tests/unit/github-gateway-authority.test.ts` — authority boundary and validation
- `tests/provider/github-gateway.test.ts` — HTTP contract against a loopback server
