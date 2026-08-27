# ADR 0064: Explicit Workspace provider selection

- Status: Proposed
- Date: 2026-08-27
- Extends: [ADR 0014](0014-loopback-api-react-workspace.md)
- Related: [ADR 0056](0056-vulcan-kind-on-evidence-surfaces.md)

## Context

The API already accepts and persists loopback `ollama` and `vulcan` draft
providers. An omitted kind defaults to Ollama for compatibility with older
callers. The Workspace form, however, sent only model and base URL, so every UI
draft took that compatibility path and an operator could not create a Vulcan
draft. Inferring kind from a port, path, model alias, or URL would make
configuration convention into hidden authority.

The existing Vulcan gateway is credential-free and loopback-only. This makes
supervised Workspace planning a narrower boundary than the deliberately closed
headless catalog and Gate 1 live-evidence profile described by ADR 0056.

## Decision

The Workspace draft form exposes one closed selector containing exactly
`ollama` and `vulcan`; Ollama is the initial UI choice. Every UI draft request
includes the selected `provider.kind` explicitly. The API's omitted-kind
Ollama default remains only for backward compatibility with non-UI callers.

Provider kind is never derived from URL or model text. Both UI choices reuse
the existing credential-free loopback HTTP(S) predicate, while the API remains
the independent authority that strict-decodes the request and constructs the
provider configuration. The UI changes placeholders only; it does not silently
replace a model or endpoint when the selector changes.

Run evidence renders the persisted kind. If an older or malformed projection
does not report a kind, the UI says `Not reported` rather than inventing an
Ollama value.

This slice persists a draft only. It adds no provider call, provider discovery,
headless provider admission, Gate 1 live-evidence admission, remote endpoint,
credential, repository mutation, landing, deployment, or migration authority.

## Consequences

- Operators can prepare supervised Vulcan drafts through the same Workspace
  flow as Ollama while seeing the exact persisted provider identity.
- Existing API clients that omit kind keep the documented Ollama default.
- Future provider kinds require an explicit UI and authority decision; adding
  an API enum does not silently add a Workspace choice.
- Vulcan aliases remain operator-entered model identifiers. Icarus does not
  fetch or guess the live Vulcan model catalog.

## Verification

- `scripts/smoke-workspace-browser.mjs` uses the compiled app in real Chromium
  to prove the default and exact option set, unsafe/loopback URL matrix,
  explicit request body kind, persisted/displayed kind, zero provider calls,
  and zero external browser requests.
- `tests/integration/local-workspace-api.test.ts` independently covers Vulcan
  persistence, omitted-kind Ollama compatibility, and rejection of remote
  Vulcan and unknown/cloud kinds.
- The measurement record is
  [`docs/evals/2026-08-27-workspace-vulcan-provider-selection.md`](../evals/2026-08-27-workspace-vulcan-provider-selection.md).
