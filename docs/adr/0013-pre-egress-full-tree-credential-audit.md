# ADR 0013: Pre-egress full-tree credential audit

- Status: Accepted
- Date: 2026-07-19

## Context

Scanning only the files selected for model context is insufficient. A tracked
credential elsewhere in the repository can be copied into an artifact, private
Git cache, worktree, or sandbox snapshot even when it is never selected for a
prompt. Treating every credential-associated filename as intrinsically secret
also rejects safe repositories such as projects with a registry-only `.npmrc`.
Finally, detector and redactor drift can either miss a secret or retain a
secret-derived fingerprint in durable state.

## Decision

Context preparation performs a bounded audit of the complete tracked tree
before creating an artifact, contacting a provider, or creating a cache or
worktree. The audit allows at most 16 MiB per file and 64 MiB in aggregate and
fails closed if it cannot finish within those bounds.

Path policy has three separate questions: whether a path may be edited, whether
its contents may be shown to a model, and whether the path is intrinsically
secret. Credential-prone configuration such as `.npmrc` remains protected from
editing and hidden from model context, but safe content may enter the sandbox
snapshot. Intrinsically secret paths and any detected secret content are
rejected before a derived repository copy exists.

One bounded iterative span scanner supplies both detection and redaction. It
recognizes the supported credential forms without building an input-sized
regular expression. Redaction uses constant markers rather than secret-derived
hashes. Provider HTTP failures expose a generic bounded error and never persist
the response body.

## Alternatives rejected

- Audit selected prompt context only: permits secrets in unselected tracked
  files to enter later derived copies.
- Reject every conventional configuration filename: blocks safe, common
  repositories without improving content-based detection.
- Maintain separate detector and redactor pattern sets: inevitably creates
  mismatched protection.
- Persist a short hash of each secret: gives durable material for offline
  guessing of low-entropy values.

## Consequences and review trigger

Preparation performs one additional bounded traversal and may reject a large or
ambiguous repository before any provider or workspace side effect. This is an
intentional fail-closed M1 limit, not a claim of universal secret detection.
Review the limits and pattern corpus when measured repositories justify a
larger budget or when a mature streaming secret scanner can preserve the same
ordering and durable-data guarantees.
