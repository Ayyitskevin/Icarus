# ADR 0056: Evidence surfaces recognize the vulcan provider kind; execution authority surfaces still do not

- Status: Proposed
- Date: 2026-08-26
- Related: [ADR 0041](0041-change-rooms-evidence-projections.md) (change room
  projections), [ADR 0042](0042-change-handoff-packs.md) (handoff packs),
  [ADR 0045](0045-gate1-live-evidence-profile.md) (live-evidence profile),
  [ADR 0046](0046-headless-execution-profiles.md) (headless host catalog),
  [ADR 0050](0050-live-evidence-manifest-money-and-model-binding.md) (money and
  model binding), [ADR 0053](0053-provider-pin-binds-the-host.md) (provider pin
  binds the host), [ADR 0055](0055-headless-live-evidence-executor.md)
  (live-evidence executor)

## Context

`ProviderKind` gained a fourth value, `vulcan`, with the loopback-only
`VulcanChatCompletionsGateway`: no credential, an operator-attribution seat, and
a fail-closed loopback invariant enforced at gateway construction. The CLI, the
workspace draft contract, and the gateway factory were updated in that change.

The surfaces written before it existed still enumerate the older kinds, and
they fail closed on what they do not recognize. That is the right failure
direction, but it splits the surfaces into two classes that were never
deliberately separated:

1. **Evidence projections.** A Change Room summary, a room's provider plan
   card, and a Change Handoff Pack all project the provider identity the
   authoritative run record already carries. A legitimate completed vulcan run
   — or, on the room index path, any anthropic run, which predates this record
   as the same latent gap — reads as database corruption and fails the whole
   page or the whole export. Recognition there adds no authority: the room is
   read-only, and ADR 0042 already charters the pack to carry provider kind,
   model, locality, and privacy class as bounded metadata.
2. **Execution authority records.** The Gate 1 live-evidence profile and the
   headless host provider catalog decide which providers may *produce* work.
   Widening those admits a new provider into money-bound evidence or
   unattended execution. Nobody has reviewed vulcan for either.

Leaving the first class closed mislabels good evidence as corruption; widening
the second class by enum edit would grant authority nobody approved.

## Decision

### Evidence projections recognize every persistable kind

The Change Room index row assertion (`store.ts`), the workspace
`ChangeRoomProviderKind` contract and room validator, the Handoff Pack source
validation, the handoff payload decoder, and the handoff reader's provider
rebuild now accept exactly the four kinds `ProviderKind` allows the runtime to
persist: `ollama`, `openai`, `anthropic`, `vulcan`. Anything outside that set
still fails closed — as database corruption in the room paths and as
`HANDOFF_SOURCE_INVALID` / `INVALID_HANDOFF` in the pack paths. No payload
shape, disclosure class, or canonical-byte rule changes; a vulcan pack is the
same contract with a fourth value in one already-bounded enum field.

The handoff reader continues to rebuild the persisted provider through
`createProviderConfig` and byte-compare the result, and the plan-approval
digest continues to bind the exact provider the plan was approved against, so
recognition cannot launder a swapped provider into a valid pack.

### Execution authority records keep their reviewed kind sets, on the record

The Gate 1 live-evidence profile still refuses a `vulcan` pin, and the
existing-runs driver still refuses to match one. This is deliberate, and it is
now recorded at both sites: Gate 1 evidence is bound to the three production
adapters whose versions are pinned in
`LIVE_EVIDENCE_PROVIDER_ADAPTER_VERSIONS` and whose spend Icarus accounts
itself under ADR 0050. A vulcan pin could not honour the money binding —
hosted aliases are metered by Vulcan's own budget ledger, so an Icarus-computed
spend ceiling would claim a bound it cannot observe — and ADR 0053's origin
rules have no vulcan arm to mirror. The driver's guard stays so the exclusion
remains load-bearing even if the profile decoder is ever widened first.

The headless host provider catalog also still refuses `vulcan`. That check
predates the gateway by one day, so it was never a decision about vulcan — but
the catalog feeds unattended workers, which makes admission an
execution-authority decision rather than a vocabulary one. The vulcan gateway
is loopback-only and credential-free, the same safety class as the admitted
`ollama` kind, so admission is a plausible follow-up; it needs its own review,
not a side effect of this record.

## Consequences

- A vulcan (or anthropic) run renders in the room index and room detail, and
  previews, exports, verifies, and inspects as a Handoff Pack, instead of
  failing those surfaces closed as corruption.
- The unknown-kind boundary is now tested at its real location: kinds the
  runtime can never persist (`bedrock` in the fixtures) still fail closed on
  every surface that gained a kind.
- The two deliberate exclusions are written down where they execute, with
  tests asserting them, so a future reader cannot mistake them for the same
  gap this record closed.
- Admitting vulcan to Gate 1 live evidence (pinned adapter version, origin
  rule, truthful metering) or to the headless host catalog (unattended-use
  review) remains open follow-up work, each needing its own ADR.

## Verification

- `tests/unit/change-room-index.test.ts` projects anthropic and vulcan rows
  and fails the page closed on an unpersistable kind.
- `tests/unit/workspace-change-room.test.ts` accepts anthropic and vulcan room
  summaries, and rejects an unpersistable kind in both the summary and the
  provider plan card.
- `tests/unit/change-handoff.test.ts` drives a genuinely vulcan-provider run
  to completion, reads it back, builds the preview, and round-trips the strict
  payload decoder; an unpersistable kind in an artifact fails closed.
- `tests/unit/live-evidence-profile.test.ts` and
  `tests/unit/live-evidence-existing-runs-driver.test.ts` pin the Gate 1
  refusal of a vulcan pin at both walls.
- `tests/unit/headless-profile.test.ts` pins the host-catalog refusal.
