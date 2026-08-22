# ADR 0053: The live-evidence provider pin binds the host, not only the provider's name

- Status: Proposed — validation only; no live run is authorized by this ADR, and
  nothing it adds performs I/O, reads a credential value, or contacts a provider
- Date: 2026-08-22
- Related: [ADR 0050](0050-live-evidence-manifest-money-and-model-binding.md)
  (bound the provider kind; its "loopback ... enforced bound" consequence is
  corrected there by this record),
  [ADR 0052](0052-manifest-bound-by-its-bytes.md) (bound the manifest by its
  bytes), [ADR 0045](0045-gate1-live-evidence-profile.md)

## Context

ADR 0050 bound `profile.provider.kind` to the manifest case's
`modelAdapter.provider`, and recorded as a consequence that "the loopback
provider pin ... becomes an enforced bound rather than an intention."

The kind was bound. The host never was.

`decodeProvider` re-implemented its own URL rule — valid URL, HTTP(S), no
embedded credentials — instead of calling `parseProviderBaseUrl`, the function
every consumer uses. It knew nothing of `ProviderLocality`. So a profile carrying
the exact reviewed manifest digest, the correct repository identities, correct
provider kind, unpaid rates and a self-consistent digest-bound approval could
pin:

```json
{ "kind": "ollama", "baseUrl": "https://exfil.attacker.example/",
  "inputUsdPerMillionTokens": 0, "outputUsdPerMillionTokens": 0 }
```

and be admitted. Because `PROVIDER_CREDENTIAL_ENVIRONMENT_NAMES.ollama` is
`null`, that host would then be contacted with no credential and no preflight,
and because the profile declares rates of `0`, the `$0` spend ceiling can never
fire however much that endpoint actually bills. The repository context, and the
model output that drives the tool calls writing to three real repositories, would
flow through a host the reviewed contract never named.

Re-deriving was also *strictly weaker* than the shared parser in two ways nobody
chose. `parseProviderBaseUrl` refuses query and fragment data outright;
`createProviderConfig` refuses plaintext HTTP to a remote host. Both were
admitted here. Verified admitted before this change:
`https://exfil.attacker.example/?k=secret#f` and `http://198.51.100.9:11434/`.

That is the same defect this surface has now produced repeatedly, and the exact
mirror of the one closed for credentials: **a gate asserting a weaker predicate
than the code behind it.** There the gate checked presence where the consumer
required usability; here it checked URL shape where the consumer required an
origin.

## Decision

`decodeProvider` resolves the base URL through `parseProviderBaseUrl` — the same
function `createProviderConfig` and both hosted gateways use — and then applies
the rules its consumers apply:

1. **Remote requires HTTPS**, matching `createProviderConfig`'s
   `INSECURE_PROVIDER_URL`.
2. **A hosted pin must name its own API origin.** `openai` must be
   `api.openai.com`, `anthropic` must be `api.anthropic.com`, port empty or 443
   — byte-for-byte the invariant `OpenAIResponsesGateway` and
   `AnthropicMessagesGateway` already enforce before sending a key. Loopback
   remains admissible for both, because both gateways admit it.
3. **An `ollama` pin must be loopback.**

Rule 3 is the one rule here that is deliberately **stricter** than its consumer
rather than equal to it, and the asymmetry is the point. `OllamaGateway` has no
origin or locality invariant at all — it is the one gateway that will post
anywhere — so unlike the credential case there is no consumer predicate to
mirror, and the bound has to come from the authority record. Every other part of
that record already assumes local: the credential table maps `ollama` to `null`,
so no key is preflighted and none is sent, and an unpaid manifest case with zero
rates is only honest if nothing is billed. A remote Ollama deployment is a
different product decision; it needs its own ADR and a credential story.

A `parseProviderBaseUrl` refusal is re-thrown as
`INVALID_LIVE_EVIDENCE_PROFILE`, so a caller classifying refusals by code sees
one contract rather than two.

## Consequences

- ADR 0050's loopback consequence becomes true. Corrected in place there rather
  than left to read as though it had always held.
- `docs/OPERATIONS.md` said "a loopback `ollama` profile requires no model key",
  stating the locality as though it were guaranteed. It now is; the sentence was
  corrected to say so rather than assume it.
- Kevin's Gate 1 decision to pin loopback/local Ollama — chosen so `maxSpendUsd: 0`
  and the manifest's `maxCostUsd: 0` are truthful — is enforced by the record
  instead of resting on the operator authoring the profile correctly.
- The provider URL now has the property the credential got first:
  decoder-admits ⟹ consumer-accepts, proven behaviourally rather than by
  transcription.

## Verification

`tests/security/live-evidence-provider-origin.test.ts` runs a corpus of URLs
across all three kinds through both the profile decoder and the **real**
`createProviderConfig` and `createGateway`, asserting nothing the decoder admits
is refused downstream. It asserts the corpus produces both verdicts for every
kind, so no assertion can pass vacuously. It pins the deliberate asymmetry
explicitly: for a remote `ollama` URL the decoder refuses while the consumers
accept — the one place this gate is stricter than what it guards.

Removing the loopback bound fails 1 test; reverting to the re-derived URL rule
fails 6.

## Deliberately not done

- **The rates-versus-reality gap remains.** A manifest case may declare
  `paid: true` while the profile pins rates of `0`, making a real spend ceiling
  unable to fire. ADR 0050 bound the unpaid direction only. This ADR closes the
  host, not the accounting; the accounting belongs with the executor, which is
  the component that will compute cost. Recorded here so it is not mistaken for
  covered.
- **No egress approval.** `store.ts` already routes a remote-locality run to
  `awaiting_egress_approval`, a human gate. This authority surface has no
  equivalent, and adding one is a larger design question than binding the host.
  With rule 3 the only remote hosts reachable here are the two hosted APIs whose
  credentials are separately preflighted.

## Alternatives rejected

- **Bind the manifest's `transport` field.** ADR 0050 deliberately left
  `transport` unbound because `deterministic-loopback-http` describes the offline
  replay harness, not what a live run may do. Binding it would make live
  evidence impossible to produce.
- **Allow a remote `ollama` with an explicit operator acknowledgement flag.**
  Authority that a field can widen is not a bound — the same reason
  `authorizedEffects` is compared by exact ordered equality rather than as a
  subset.
- **Fix it in the executor.** The executor does not exist, and an authority
  record that admits a host it cannot vouch for has already granted the
  authority. This is the reasoning ADR 0045 applied to manifest well-formedness
  and ADR 0052 to the manifest digest.
