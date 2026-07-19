# ADR 0004: Provider-neutral port and real HTTP adapters

- Status: Accepted
- Date: 2026-07-19

## Context

Icarus must support local and cloud models without depending on undocumented CLI
internals or shipping adapters that only pretend to work.

## Decision

Define a normalized planning provider port with explicit capabilities and
usage. Implement Ollama `/api/chat` and OpenAI `POST /v1/responses` using native
`fetch`. Read secrets from environment only. Test both production adapters
against deterministic HTTP contracts, and run the production OpenAI adapter
through the complete egress-approval, plan, edit, verification, and review
lifecycle without a paid request. Keep model and pricing inputs explicit.

## Consequences

No provider SDK dependency is needed for the narrow call, and request/response
code is exercised without paid calls. Streaming, tools, provider-side state,
Anthropic, xAI, and GLM wait for later adapters and contract tests.
