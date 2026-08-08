# Owner decision packet: Gate 1 Packet 4 interface closure

- Date: 2026-08-08
- Scope: fake-transport GitHub landing only; no live request, credential, push, or pull request
- Governing decisions: accepted ADR 0027 and its normative v1 record companion
- Unblocked implementation: fixed fake gateway, exact HTTP result records, request/material digest binding, operation-scoped credential proof, bounded response projection

## Decision 1 — exact immutable receipt record

**Why a decision is required.** ADR 0027 lists receipt member names informally and says the first member is `version`. Its normative companion closes operation, request, result, projection, and event records but never closes a `LandingReceiptV1` type, exact timestamp grammar, or whether the first member is `version: 1` or `schemaVersion: 1`. Inventing the durable receipt would violate the companion's rule that adding or renaming a field is a policy change.

**Recommended owner choice.** Amend the normative companion with one exact `LandingReceiptV1` TypeScript record using the parent ADR's member names, `version: 1`, `completedAt: Instant`, and no optional members. State that `receipt_sha256` is the SHA-256 of its canonical bytes and that every outcome is derived from the four terminal stage proofs.

**Alternatives.** Use `schemaVersion: 1` for consistency with other records, or version the receipt separately. Either alternative needs an explicit companion amendment before runtime settlement or migration work.

**Implementation fence.** Packet 4 may prove the complete fake provider exchange and reconciliation inputs, but it must not persist a terminal receipt or claim `landed` until this record is closed.

## Decision 2 — repository identity behind a head-ref 404

**Current accepted v1 rule.** The companion treats GitHub's exact documented head-ref 404 as semantic absence. The fake gateway now accepts only the exact fixed JSON shape, after the same pinned credential has passed actor verification and an exact same-operation base-ref read. Base-ref 404, malformed bodies, wrong actors, and repository/ref drift fail closed.

**Residual ambiguity.** A later head 404 can still mean a repository became invisible, was deleted, or was replaced between the base and head reads. Owner/repository names do not bind immutable GitHub repository identity.

**Recommended owner choice.** Preserve accepted v1 behavior for deterministic fake tests, disclose the residual time-of-check/time-of-use risk, and require a policy-v2 decision before live credentials. V2 should bind the provider repository ID (and, if required, installation/owner identity) in the profile and verify it on every relevant response.

**Alternative.** Amend v1 before any remote runtime work so a head 404 is never absence. This is safer but changes the accepted retry/reconciliation grammar and its conformance fixtures.

## Decision 3 — rate-limit headers and retry scheduling

**Why a decision is required.** The exact v1 HTTP result has status, projection, and safe error code but no response-header or retry-schedule fields. GitHub can signal rate limiting with 429 and, in some cases, 403 plus headers. Persisting or trusting `Retry-After`/`X-RateLimit-*` would add authority outside the closed record.

**Recommended owner choice.** Keep v1 status-only and conservative: 429 becomes `GITHUB_RATE_LIMITED`; 403 remains `GITHUB_PERMISSION_DENIED`; neither schedules or performs an automatic retry. A later explicit coordinator attempt is the only retry authority. Treat response rate headers as bounded but non-authoritative input.

**Alternative.** Add a v2 canonical rate-limit observation and an explicit operator-visible retry grant. It must define trusted clock semantics, header multiplicity/parsing, maximum delay, restart behavior, and digest/event correlation before automation.

## Closed without an owner decision

- Provider owner, repository, and login values normalize to canonical lowercase; branch/ref bytes remain case-sensitive. One mismatching or unprojectable pull request fails the whole list.
- The gateway accepts only a durable admitted request ID. A registered claimer must atomically claim the row under its owning operation lease; registered readers then supply its landing digest, immutable material, and credential reference. Origin, route, query, headers, timeout, redirect policy, and canonical POST body are rebuilt internally.
- An operation-scoped gateway resolves the credential once, proves its actor first, never digests or persists the value, retains it for mandatory post-read reconciliation after ambiguous mutation, and requires explicit close after durable operation settlement.
- Rate-limit headers, caller URLs, caller headers, serialized bodies, redirects, automatic retries, live transports, and ambient environment reads are outside this slice.
