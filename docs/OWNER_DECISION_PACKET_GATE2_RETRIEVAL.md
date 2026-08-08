# Owner decision packet: Gate 2 deterministic retrieval boundaries

- Date: 2026-08-08
- Scope: pinned-tree repository mapping and bounded exact search only; no semantic
  retrieval, repository execution, ambient process authority, or network access
- Governing decisions: accepted ADR 0005, ADR 0036 Gate 2, and the G2 build order
  in the collaborative IDE game plan
- Safe work that is already unblocked: benchmark schema and corpus, tracked-tree
  enumeration, byte-stable ranking, binary/size/secret filters, bounded result
  contracts, and typed omission accounting

## Decision 1 — pinned `.gitignore` semantics

**Why a decision is required.** The accepted documents require Git-visible,
deterministic context and say retrieval must respect ignore rules, but they do
not define whether a force-tracked path that also matches `.gitignore` remains
model-visible. They also do not close nested-rule precedence, negation, or which
Git exclusion sources are authoritative. Reading a checkout, `.git/info/exclude`,
`core.excludesFile`, or a user's global ignore file would make the same pinned
commit produce different results on different machines or after a worktree edit.

**Recommended owner choice.** Define a versioned `pinned-ignore-v1` profile:

- candidates are ordinary tracked blobs from the admitted pinned Git tree;
- only `.gitignore` blobs in that same tree participate, with rules applied at
  their pinned directory scope;
- matching is a deterministic, version-pinned implementation of Git's nesting,
  anchoring, directory, last-match, and negation rules;
- an ignored path is omitted even when it was force-added to Git; this is a
  deliberate model-visibility policy, not a claim that Git treats tracked files
  as untracked;
- negation may reverse repository ignore rules only as allowed by the pinned
  profile and can never override host secret, binary, size, capability, or
  worktree-boundary policy; and
- unsupported or ambiguous syntax fails closed for the affected path or subtree
  with a typed omission. It is never interpreted as "not ignored."

Mutable checkout files, `.git/info/exclude`, global excludes, Git configuration,
environment variables, and host locale are never inputs.

**Consequence.** A repository can intentionally recover a path with a pinned
negation, but a force-tracked generated or ignored file remains outside model
context. Recall metrics must count that omission under the named profile.

**Alternative.** Follow Git's tracked-file behavior and expose force-tracked
matches unless another host filter removes them. This may improve recall, but it
makes `.gitignore` only a candidate-discovery rule rather than an additional
model-visibility boundary.

**Blocking scope.** This choice blocks a conformance claim for repository map v2,
ignore omissions, and any search benchmark containing ignored or force-tracked
paths. The corpus format, pinned-tree reader, non-ignore filters, result schema,
and evaluator can proceed without selecting either behavior.

## Decision 2 — real `rg` capability identity

**Why a decision is required.** ADR 0036 requires deterministic `rg`, but an
unqualified `rg` process would inherit executable lookup, version, configuration,
environment, and output-parser behavior from the host. An in-process literal
search avoids that process boundary but does not, by itself, satisfy the accepted
Gate 2 `rg` claim.

**Recommended owner choice.** Approve two separately named capabilities with no
fallback between them:

1. `literal-search-v1` is the in-process, fixed-string baseline and benchmark
   oracle. It receives only manifest-approved bytes and has no process authority.
2. `ripgrep-search-v1` is available only when the operator registers an absolute
   executable plus its exact version and binary SHA-256 digest. The adapter
   verifies that identity, uses `shell: false`, fixed arguments including
   configuration suppression, a fixed minimal environment, manifest-approved
   paths, bounded output/time/match limits, and a versioned parser. It performs
   no `PATH` lookup, configuration discovery, network access, installation, or
   repository-triggered execution. A missing or mismatched binary returns a
   typed unavailable result; it never falls back to another executable or to
   the in-process capability.

Both capabilities canonicalize results with the same byte-order tie-breaker and
record capability/version, limits, input digest, result digest, and omissions.
Model text can select neither executable nor arguments.

**Consequence.** Real-ripgrep evidence is reproducible only for explicitly
supported binary identities and platforms. Shipping another `rg` build requires
a reviewed profile update, not a runtime substitution.

**Alternative.** Make the in-process literal engine the only Gate 2 search
implementation. That is simpler and deterministic, but the product could not
truthfully claim the accepted `rg` slice without amending ADR 0036.

**Blocking scope.** This choice blocks execution and product claims for a real
`rg` adapter. The benchmark corpus, literal baseline, ranker, provenance model,
and bounded search-result contract can proceed independently.

## Decision 3 — secret-omission provenance

**No new owner choice is required for the safe baseline.** The accepted context
boundary already says detected credential bytes never reach model-derived
surfaces. Retrieval must not weaken it merely to explain an omission.

**Recommended application of the accepted boundary.** Host-local evidence may
record the normalized repository-relative path and a coarse typed omission code
needed for operator audit. It must not record secret bytes, the matching token or
line, raw scanner output, environment data, or a content digest of the omitted
secret. Model-visible context receives only bounded aggregate omission counts by
coarse category and an explicit incomplete-context marker; it receives no
per-path secret omission, secret digest, or classifier detail. Host policy
omissions remain untrusted data and grant no additional read authority.

**Consequence.** Operators can audit which admitted path was withheld locally,
while a remote model cannot use omission metadata as a secret inventory or
comparison oracle. Provenance-coverage metrics use the local evidence record,
not the model prompt.

**Blocking scope.** Nothing in the deterministic baseline is blocked if this
conservative split is retained. Any proposal to expose per-path secret
omissions, secret-derived digests, or scanner detail to a model or provider is a
separate trust-boundary decision and must be approved before implementation.

## Owner action requested

1. Accept or replace `pinned-ignore-v1`, especially its force-tracked behavior.
2. Accept the separately registered literal and real-ripgrep capability profiles.
3. Affirm that secret omission detail remains host-local; no action is needed if
   the conservative baseline stands.
