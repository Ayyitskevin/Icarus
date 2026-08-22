# ADR 0052: The live-evidence manifest is bound by its bytes, not by a digest the caller supplies alongside it

- Status: Proposed — validation only; no live run is authorized by this ADR, and
  nothing it adds performs network I/O, reads a credential value, or contacts a
  provider or GitHub
- Date: 2026-08-22
- Related: [ADR 0045](0045-gate1-live-evidence-profile.md) (the profile record and
  its three binding properties), [ADR 0050](0050-live-evidence-manifest-money-and-model-binding.md)
  (the money and model pins this restores the meaning of),
  [ADR 0027](0027-git-landing-authority.md), [ADR 0043](0043-github-gateway-boundary.md)
- Numbering: main holds 0045, 0050, 0051; the codex seat holds unpushed 0044 and
  0046–0049 on `codex/headless-recovery-h3a`. 0052 is the first free number if
  those land as numbered.

## Context

ADR 0045 property 1 states that the profile binds the offline manifest digest and
that "changing the manifest invalidates the profile." ADR 0050 then bound the
manifest fields that decide which model runs and whether money may be spent.

Neither was true, because neither was reachable.

`assertLiveEvidenceProfileMatchesManifest(profile, manifest, manifestDigest)`
received the parsed manifest as an **object** and its digest as a **string**, as
two independent parameters, and its first check was:

```ts
if (profile.offlineManifestDigest !== digest(manifestDigest, "manifestDigest")) {
```

That compares the caller's claim to the caller's other claim. Nothing computed a
digest over `manifest`. `digestJson` was imported by the module but used only for
the approval digest. So a caller could hand over an edited manifest together with
the reviewed manifest's digest string, and every comparison after that line —
repository identity, provider kind, unpaid-means-unpaid, the spend ceiling — was
evaluated against the edited manifest while the digest gate reported the reviewed
one.

Demonstrated against the committed manifest. The control refuses, which is what
makes the result meaningful:

```text
refused   CONTROL: paid anthropic @ $500 vs the REVIEWED manifest
            -> profile pins provider anthropic, but offline manifest case
               typescript-library-repair pins ollama
sha256(reviewed bytes) = 692bbfe17ba1b998...
sha256(edited bytes)   = 3b78aefc89f91238...
ADMITTED  EDITED manifest (anthropic/paid/$500, owner=attacker)
          + the REVIEWED digest string
```

Three independent reproductions: an adversarial sweep, a reviewer tasked with
refuting it, and a hand-written probe.

Nothing calls the function yet — only the barrel export and the tests — which is
why this is an ADR and not an incident. It is also why it had to be fixed now:
the Gate 1 case executor is the next slice, and an executor built against this
signature would inherit a binding that authenticates nothing.

This is the fifth instance on this surface of one defect class. ADR 0050 named
it: the fields that are easy to compare get bound, and the field that decides the
blast radius does not. Here the unbound thing was not a field at all — it was the
correspondence between two parameters.

## Decision

`assertLiveEvidenceProfileMatchesManifest` takes the manifest as
`manifestBytes: Uint8Array` and nothing else. It computes `sha256(manifestBytes)`
itself, compares that to `profile.offlineManifestDigest`, and then parses the
manifest **from those same bytes**. `authorizeLiveEvidenceRun` takes the bytes
and passes them through.

The mismatch is not detected. It is unrepresentable: with one parameter there is
no pair to disagree.

Decoding is fail-closed in three further ways, each because a permissive reading
would validate something other than what was hashed:

- A value that is not a `Uint8Array` is refused at runtime rather than trusted
  from the annotation — the same reason ADR 0045 property 4 freezes the
  authorization instead of marking it `readonly`. This also means the previous
  call shape fails loudly rather than coercing.
- Invalid UTF-8 is refused rather than replaced. A replacement character would
  change the text being validated away from the bytes that were hashed.
- Bytes that hash correctly but are not a strict-JSON object are refused after
  the digest check, so a correctly pinned non-manifest cannot proceed.

`scripts/gate1-benchmark.mjs:1024-1033` has always done exactly this — read the
bytes, digest the bytes, parse the same bytes. The authority function is what had
drifted from the practice already in the repository.

## Consequences

- ADR 0045 property 1 and ADR 0050's money and model pins become true statements
  about the code rather than intentions. They were unreachable behind a gate that
  did not gate.
- A profile approved against one manifest cannot be replayed against another, in
  either direction, and a single flipped byte invalidates the binding.
- The executor receives bytes. A caller that needs the parsed manifest for its own
  work must parse the same bytes it authorized.
- The function still returns `void`. Returning the validated manifest would let
  the executor act only on what was authenticated, which is a real improvement —
  but no executor exists yet, and designing its interface before it exists is the
  speculative generality this repository declines elsewhere. Recorded here as the
  first question the executor slice should answer.
- Left where it is: `validateGate1BenchmarkReport(value, manifest, expectedManifestSha256)`
  in `scripts/gate1-benchmark-result-contract.mjs` has the same parameter shape.
  Its single caller derives both arguments from one `manifestBytes` variable in
  the same scope, so the correspondence holds by construction, and it is a script
  validator rather than an authority gate. It is a candidate for the same
  treatment, not part of this remediation.

## Verification

`tests/security/live-evidence-manifest-binding.test.ts` runs against the real
committed manifest rather than a synthetic fixture, because the defect was about
the relationship between reviewed bytes and acted-upon values and a synthetic
fixture can be made to agree with itself. It asserts the reviewed bytes still
admit a correctly approved profile, that a paid remote profile is refused against
those bytes (the positive control that proves the money binding is reachable at
all), that an edited manifest cannot borrow the reviewed digest, that a profile
approved against edited bytes cannot be replayed against the reviewed ones, that
one flipped byte invalidates the binding, that a parsed object is refused where
bytes are required, and that non-JSON, invalid-UTF-8, and scalar bytes are each
refused for their own reason.

Making the digest gate vacuous fails three of those nine, so they bind behaviour
rather than restate it.

## Alternatives rejected

- **Keep the pair and document that callers must pass corresponding values.** The
  correspondence is exactly what no caller can be trusted to establish, and
  documentation is not a gate. This is the alternative the code already
  implemented by accident.
- **Compute `digestJson` over the parsed manifest and compare that.** Canonical
  JSON is not what the operator reviewed or what the benchmark pins; the digest
  would stop matching `sha256(manifestBytes)` everywhere else, and two digest
  definitions for one artifact is the drift ADR 0045 rejected for the automation
  assessment.
- **Accept a `{bytes, digest}` object.** The pair returns wearing a different
  hat, and a caller can still populate it inconsistently.
- **Validate in the executor instead.** Authority checks belong at the boundary
  that grants authority. A public authorization function establishes its own
  prerequisites rather than assuming a caller established them — the reasoning
  ADR 0045 already applied to manifest well-formedness.
