# ADR 0054: Gate 1 approvals authorize named effects and are surface-neutral

- Status: Accepted — operator decision 2026-08-23; this record authorizes the approval surface, not a live run
- Date: 2026-08-23
- Related: [ADR 0027](0027-git-landing-authority.md), [ADR 0029](0029-browser-approval-authority.md), [ADR 0045](0045-gate1-live-evidence-profile.md), [ADR 0052](0052-manifest-bound-by-its-bytes.md)

## Context

Gate 1 had three ambiguities that prevented a live-evidence executor from being sized safely:

1. whether `separate_approval_for_each_external_mutation` meant one approval for every HTTP request or approval of the four named effect capabilities;
2. whether recovery behavior was an implementation choice or the behavior pinned by the benchmark manifest; and
3. whether the approval had to be presented in a browser.

GitHub exposes object upload, reference creation, and draft-pull-request creation as distinct operations. Git objects are content-addressed and may be uploaded repeatedly; reference and pull-request creation require durable intent and reconciliation rather than blind repeated POSTs. The existing landing coordinator already models those distinctions. in-toto, SLSA, and Sigstore likewise bind authorization or attestation to exact digests rather than to a particular presentation surface.

## Decision

### Approval granularity

One digest-bound profile approval authorizes exactly these named capabilities, in order:

- `github.objects.upload`
- `github.ref.create.absent_only`
- `github.pull_request.create.draft`
- `github.landing.receipt`

Approval is not repeated for every HTTP request inside a capability. The effect ledger and durable landing intent still enforce ordering, budgets, absent-only reference creation, one draft-PR creation per landing, and reconciliation after ambiguous outcomes. Merge, deployment, ref update/deletion, force push, and source-checkout mutation remain inexpressible.

### Recovery authority

Recovery follows the manifest contract. Durable landing candidate and intent state survives a fresh process launch. Ephemeral browser origin/session authority does not survive a server restart and must rotate. A persisted approval record is evidence of the named effect authority; it is not a bearer token and does not mint a browser session.

### Presentation surface

The approval contract is surface-neutral. A CLI that displays the exact digest, binds the exact manifest bytes, records the actor and UTC instant, and produces the same approved record is an equal approval surface. A browser is not required.

The file-only CLI verbs are:

- `icarus live-evidence digest --input PROFILE_DRAFT`
- `icarus live-evidence approve --input PROFILE_DRAFT --manifest MANIFEST --actor ACTOR`
- `icarus live-evidence inspect --input APPROVED_PROFILE --manifest MANIFEST`
- `icarus live-evidence verify --input APPROVED_PROFILE --manifest MANIFEST`

They execute before runtime construction. They do not open SQLite, read credential values, contact a provider or GitHub, or execute an authorized effect. `inspect` and `verify` report `executionAuthority: "none"`.

## Consequences

- The approved profile becomes an operator-authored artifact instead of hand-edited JSON.
- The approval remains invalid after any pinned field changes.
- The CLI requires regular, singly linked, operator-owned profile files that are not group- or world-writable. Manifest bytes may come from a collaborative checkout because the owner-only profile pins their SHA-256 and the reader detects concurrent changes.
- The remote case executor, real repository assessments, credentials, live calls, and 3/3 evidence remain unimplemented and unauthorized by this ADR.
- No schema migration or descriptor-version change is introduced.

## Evidence

- GitHub REST documentation: [Git blobs](https://docs.github.com/en/rest/git/blobs), [Git trees](https://docs.github.com/en/rest/git/trees), [Git references](https://docs.github.com/en/rest/git/refs), and [pull requests](https://docs.github.com/en/rest/pulls/pulls).
- GitHub recommends serial mutative requests: [REST API best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api).
- Digest-bound supply-chain metadata: [in-toto specification](https://github.com/in-toto/docs/blob/master/in-toto-spec.md), [SLSA source requirements](https://slsa.dev/spec/v1.0/requirements), and [Sigstore blob verification](https://docs.sigstore.dev/cosign/verifying/verify_blob/).
- Real-process measurement: [Gate 1 approval CLI measurement](../evals/2026-08-23-gate1-approval-cli.md).
