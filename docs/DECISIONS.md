# Decision index

Decision records for the current milestone:

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](adr/0001-typescript-modular-monorepo.md) | TypeScript modular monorepo with headless core and CLI | Accepted |
| [0002](adr/0002-sqlite-event-history.md) | SQLite for local control state and evidence | Accepted |
| [0003](adr/0003-detached-worktree-single-file.md) | Detached worktree and one-file mutation boundary; mutation boundary superseded by ADR 0023 | Partially superseded |
| [0004](adr/0004-provider-http-adapters.md) | Provider-neutral port with real Ollama and OpenAI HTTP adapters | Accepted |
| [0005](adr/0005-deterministic-untrusted-context.md) | Deterministic, provenance-preserving, untrusted context first | Accepted |
| [0006](adr/0006-headless-first-slice.md) | CLI-first slice; partially superseded for the bounded local workspace by ADR 0014 | Partially superseded |
| [0007](adr/0007-fail-closed-docker-check-sandbox.md) | No-network Docker sandbox for pre-review checks | Accepted |
| [0008](adr/0008-dedicated-state-root-and-run-leases.md) | Marker-owned private state root and per-run mutation leases | Accepted |
| [0009](adr/0009-persisted-intent-and-conservative-reservations.md) | Preparing intent and conservative external-operation reservations | Accepted |
| [0010](adr/0010-inherited-opencode-workflow-security-hold.md) | Inherited OpenCode workflow requires an operator security decision; resolved by ADR 0025 | Superseded |
| [0011](adr/0011-kernel-backed-stable-run-leases.md) | Kernel-backed stable run leases without pathname deletion | Accepted |
| [0012](adr/0012-bounded-emergency-cancellation-recovery.md) | Fixed, metered emergency recovery after ordinary ceilings are exhausted | Accepted |
| [0013](adr/0013-pre-egress-full-tree-credential-audit.md) | Bounded full-tree credential audit before derived copies or egress | Accepted |
| [0014](adr/0014-loopback-api-react-workspace.md) | Loopback API and review-only React workspace | Accepted |
| [0015](adr/0015-read-only-repository-status-and-event-cursors.md) | Read-only repository status and event cursors | Accepted |
| [0016](adr/0016-bounded-older-event-navigation.md) | Bounded older event navigation | Accepted |
| [0017](adr/0017-bounded-workspace-run-summaries.md) | Bounded workspace run summaries | Accepted |
| [0018](adr/0018-bounded-verification-attempt-provenance.md) | Bounded verification-attempt provenance | Accepted |
| [0019](adr/0019-bounded-approval-provenance.md) | Bounded approval provenance | Accepted |
| [0020](adr/0020-bounded-persisted-diff-review.md) | Bounded persisted diff and run-status review | Accepted |
| [0021](adr/0021-bounded-project-catalog-and-json-responses.md) | Bounded project catalog and JSON responses | Accepted |
| [0022](adr/0022-native-macos-windows-acceptance.md) | Explicit native macOS and Windows acceptance | Accepted — exact-head macOS and Windows jobs passed at `802b91e6` |
| [0023](adr/0023-transactional-multi-file-patch-sets.md) | Transactional multi-file patch sets, superseding the ADR 0003 mutation boundary | Accepted |
| [0024](adr/0024-bounded-repair-loop.md) | Bounded repair loop with a plan-carried repair grant | Superseded by ADR 0026's failed-verification session loop; plan-bound authority, durable accounting, same-target validation, exhaustion semantics, and human review remain in force |
| [0025](adr/0025-hardened-inherited-opencode-workflow.md) | Hardened inherited OpenCode workflow with a repository-owned actor gate, resolving ADR 0010 | Accepted — third-party review and secret rotation outstanding |
| [0026](adr/0026-agent-session-loop-and-tool-registry.md) | AgentSession loop, host-owned tool registry, and manifest-bound capability grants | Accepted and released through 2b at Gate 0 release head `802b91e6`; browser authority is separate Gate 1 work |
| [0027](adr/0027-git-landing-authority.md) | Separate proof-bound landing ledger, deterministic candidate commit, create-only GitHub branch, and exact draft PR | Accepted — independent P0/P1 authority reviews passed 2026-07-31; Packet 3's durable local path through `local_ready` is implemented and Packet 4a's gateway package is merged but wired to no runtime path, while remote landing coordination, remote receipts, live-state migration, and credential-gated live evidence remain incomplete |
| [0029](adr/0029-browser-approval-authority.md) | Fresh-origin browser mutation session and fenced Linux run actions | Accepted — partially superseded by accepted ADR 0040 for the interim origin contract; Packet 2's closed eight-action dispatcher, receipts, cancellation binding, restart reconciler, API integration, and real-Chrome acceptance are release-accepted at implementation head `3683087`, now preserved in `main` history (hosted run `30761189188`; native run `30761192370`) |
| [0036](adr/0036-proof-carrying-software-factory-product-direction.md) | Proof-carrying software factory product direction and gated competitive roadmap | Accepted product direction — Gate 0 release head `802b91e6`; Gate 1 active with PR #20 foundations, PR #22 browser authority, Packet 3 durable local landing implemented, and Packet 4a's gateway package merged but unwired; Packet 4 remote landing/receipts, credential-gated live evidence, and Gate 1 completion remain open |
| [0039](adr/0039-portable-numeric-loopback-origins.md) | Portable CSPRNG-selected numeric-loopback mutation origins | Rejected — native run `30613980911` passed Windows and failed macOS |
| [0040](adr/0040-chromium-resolved-localhost-origins.md) | Chromium-resolved 128-bit `.localhost` mutation origins over exact `127.0.0.1` | Accepted — exact-head evidence complete at `eb01b6406c12126c60add7ac83800f8eba8ffdc9` (native run `30618043377`); interim operator browser/resolver/proxy risk accepted 2026-07-31; not a Gate 1 release |
| [0041](adr/0041-change-rooms-evidence-projections.md) | Change Rooms are evidence projections, not a chat system, workflow engine, or execution authority | Proposed |
| [0042](adr/0042-change-handoff-packs.md) | Change Handoff Packs are operator-exported redacted evidence capsules, not Change Room replicas or cross-system authority | Accepted — exact published-main CI passed at `133aa38d` in run `30725709403` |
| [0043](adr/0043-github-gateway-boundary.md) | The GitHub gateway's authority is one closed nine-kind operation table with GET/POST-only inexpressibility, automation-path denial, loopback opt-in, coordinator-owned retry, and 422-as-refusal | Accepted — records the merged unwired package (PRs #25–27) and carries their missing independent-review record forward; two contract-level questions (identity case in the pull-request head filter, pinned page size against the response ceiling) remain Open and require an ADR 0027 amendment |
| [0044](adr/0044-headless-workspace-harness-direction.md) | Icarus headless workspace harness: authoritative kernel, event stream, bounded workers, optional pinned external adapters | Accepted for headless workstream; no Mickey deployment |
| [0045](adr/0045-gate1-live-evidence-profile.md) | Credential-gated Gate 1 live-evidence profile bound to offline evidence, repository identity, effects, provider, budgets, and digest approval | Proposed — offline contract only; no live run is authorized |
| [0046](adr/0046-headless-execution-profiles.md) | Strict default-deny headless profiles resolved against host providers, project ceilings, and approved-plan capabilities | Proposed — offline contract only; no worker or Mickey deployment |
| [0047](adr/0047-headless-authority-binding.md) | Bind H1 profiles to the exact persisted run, plan/egress approvals, project ceiling, and plan-approved provider before H2 execution | Proposed — pure offline binding only; no worker, lease, provider call, or deployment |
| [0048](adr/0048-bounded-headless-worker.md) | Approve, bind, execute, quiesce, and settle one headless task under the existing Linux run lease | Proposed — local H2b candidate implemented and independently reviewed; risky-change research, live-provider measurement, and deployment evidence remain open |

| [0050](adr/0050-live-evidence-manifest-money-and-model-binding.md) | The Gate 1 live-evidence profile binds the manifest fields that decide which model runs and whether money may be spent — provider kind, unpaid-adapter declaration, and a spend ceiling bounded by the case's `maxCostUsd` — while `model`, `adapterVersion`, `transport`, `expectedRequests` and `credentials` are deliberately unbound because they describe the offline replay | Proposed — validation only; no live run is authorized and nothing it adds performs I/O |

| [0051](adr/0051-pinned-candidate-commit-timestamp.md) | A landing may pin its candidate commit timestamp through an optional `PrepareLandingInput` field, applying to the commit instant alone; the coordinator's `now` seam is deliberately not used, because it would backdate every durable timestamp the run writes | Proposed — optional input, no default behaviour change |

| [0054](adr/0054-gate1-effect-approval-and-recovery-semantics.md) | Gate 1 uses one digest-bound approval for the exact four named effects, follows manifest-defined recovery, and accepts CLI presentation as equal to browser presentation | Accepted — operator decision 2026-08-23; approval tooling only, no live executor authority |

| [0055](adr/0055-headless-live-evidence-executor.md) | Gate 1 uses a one-shot serial CLI over strictly bound completed runs, a crash-safe exact-resume journal, durable admission-derived effects, and NDJSON terminal receipts | Accepted — operator decision 2026-08-23; implementation candidate passed offline measurement, independent review and live 3/3 still required |

| [0056](adr/0056-vulcan-kind-on-evidence-surfaces.md) | Change Room and Handoff Pack evidence projections recognize every persistable provider kind including `vulcan`, while the Gate 1 live-evidence profile/driver and the headless host catalog deliberately keep their reviewed kind sets | Proposed |
| [0057](adr/0057-headless-evidence-reconstruction.md) | H3b evidence-only reconstruction recomputes the exact H2a binding from persisted inputs and classifies each crash-tail effect `no_effect`/`durably_settled`/`ambiguous` without recording resume intent or executing anything | Proposed — read-only projection only; no continuation, replay, fork, or deployment authority |

Major choices must be added as new ADRs. Do not rewrite an accepted ADR to hide
a changed decision; supersede it and link both records.

ADR 0045's row is deliberately absent from this index: the codex seat's
unmerged headless branch already adds rows for 0044 through 0048, including
0045, and two lanes writing the same row would auto-merge into a duplicate
rather than conflict. Whichever lane merges first owns it.

Reserved but unwritten: ADR numbers 0028, 0030–0035, 0037, and 0038 are cited
as gate dependencies in
[`ICARUS_COLLABORATIVE_IDE_GAME_PLAN.md`](ICARUS_COLLABORATIVE_IDE_GAME_PLAN.md)
and have no files yet. A citation to one of them names future work, never an
accepted decision. ADR 0027 is deliberately two files: the authority decision
and its normative v1 record contract companion.
