# Threat model

## Assets

- registered source repositories and their Git metadata;
- provider credentials in the process environment;
- private repository text sent to a chosen provider;
- Icarus project/run history, diffs, and command output;
- loopback workspace requests and allowlisted browser evidence;
- point-in-time repository observations and cursor-paged event metadata;
- host filesystem, processes, private network, and production systems;
- GitHub Actions credentials, OIDC authority, and repository automation;
- the committed Gate 1 benchmark manifest, its raw-byte fixture pins, and the
  generated closed schema-v1 success/failure report;
- operator trust in approval and verification evidence.

## Trust boundaries

1. Operator CLI input enters the Icarus process.
2. Repository content enters deterministic context and model prompts.
3. Provider responses enter proposal validation.
4. Git and registered check subprocesses cross into the host process boundary.
5. Provider HTTP crosses loopback/private or public network boundaries.
6. Approved bytes cross into an Icarus-owned worktree.
7. Public GitHub comments can enter inherited repository automation before the
   Icarus runtime starts.
8. Browser requests cross the loopback HTTP boundary into validation and the
   application service.
9. Allowlisted state/evidence crosses from the API presenter into React, where
   repository, provider, and check-derived strings remain untrusted data.
10. In the second M3 slice, sanitized Git observations and event metadata cross
    the same presenter boundary without their raw command output or event
    payloads.
11. In the third M3 slice, an explicit older-event cursor crosses that same
    boundary while the pinned response remains metadata-only and constant-size.
12. The committed Gate 1 benchmark manifest crosses into the focused evaluator;
    its task, prompt, check, source, candidate, and expected-result records are
    inputs to strict contract validation, not action authority.
13. The generated Gate 1 report crosses back through strict JSON parsing and the
    closed result validator before and after atomic persistence. Success carries
    all three observations; failure carries only a completed-case prefix and
    partial counters, never inferred evidence for the active failed case.

Repository rules, source, docs, issue text, model output, HTTP errors, command
output, Host/Origin/authorization values, URLs, and JSON bodies are untrusted.
Fixed host policy plus the operator's exact project
checks/sandbox/ceilings and digest-bound CLI approval commands are
authoritative. Accepted ADR 0040 gives real-accepted Chromium-family browsers an
authenticated mutation transport. Its implementation and exact-head native
evidence passed at `eb01b6406c12126c60add7ac83800f8eba8ffdc9`, and explicit
human acceptance of the interim operator-controlled browser/resolver/proxy
residual risk was recorded on 2026-07-31. Packet 2 adds a closed Linux-only
guarded lifecycle action surface, exact receipts, and fail-closed restart
reconciliation. Candidate `701952349e0818cead37672df951ed09c0edd27c` passed
hosted run `30760607215` and both native jobs in run `30760619650`; after merge
and a timing-only portable-smoke harness correction, Packet 2 implementation
head `3683087066efb65255f05b2493fd31051c3ad7c6` was published on `main` and
passed hosted run `30761189188` plus both native jobs in run `30761192370`.
Gate 1 remains incomplete, and this
Packet 2 acceptance grants no commit, Git-ref, GitHub landing, live-provider,
merge, deployment, or migration authority.

## Primary threats and controls

| Threat | Control | Required evidence |
| --- | --- | --- |
| Remote access, stale origin code, CSRF, or DNS rebinding reaches local mutation authority | accepted interim mutation starts bind exact IPv4 `127.0.0.1`, verify that socket, then CSPRNG-select an independent 16-byte `.localhost` public-origin nonce and 32-byte fragment bearer; there is no Node/OS lookup, hosts-file edit, or browser resolver injection; every non-GET/HEAD request requires exact raw Host/Origin/authorization/content-type/action-header cardinality before body/service work; explicit-port origins are bearer-free and GET-only; mutation support is limited to real-accepted Chromium-family browsers, while Safari and unverified browsers must deliberately use review-only mode; CSP disables workers and no CORS permission is emitted | hostile/duplicated/missing Host, Origin, authorization, content-type, and action-header tests across non-read methods; exact-bind, nonce, no-lookup/no-injection, restart rotation, preflight refusal, and stable-port non-read refusal; real-browser fragment/storage/leakage evidence; exact-head real Chrome composition on macOS and Windows |
| Oversized, malformed, duplicate-key, or ambiguous mutation | exact route/method/content-type schemas, unknown-field rejection, bounded JSON bodies, a nesting ceiling, and escaped-alias duplicate-member rejection fail before service calls | content-type, body-limit, strict-JSON duplicate/depth, invalid-contract, malformed-provider-URL, and missing-repository tests with useful errors and unchanged state |
| A process signal closes an authenticated guarded action after its effect but before the browser observes the result | first-signal shutdown closes admission and drains registered handlers; the immutable action ID/descriptor is prepared, admitted, and settled around one Linux run lease; startup first marks started operations interrupted, refuses prepared intent, and reconciles admitted work only from durable boundaries, with ambiguity terminally marked `reconciliation_required` instead of replayed | local ledger, service, handler shutdown, API receipt recovery, and real-browser tests cover same-ID admitted no-replay, disconnect, and prepared/admitted settlement; candidate and corrected implementation-head hosted/native acceptance passed in runs `30760607215`, `30760619650`, `30761189188`, and `30761192370` |
| A Gate 1 schema refusal creates or changes source WAL/SHM state, or a main-file-only read misses committed WAL schema | never SQLite-open the source family; validate and fingerprint owned regular main/WAL/SHM files, copy only main+WAL into a private `0700`/`0600` snapshot, rebuild SHM there, inspect exact schema, re-fingerprint the source before and after, reject unknown journal/sibling files or races, and remove the snapshot in `finally` after handled completion/error; uncatchable termination may leave only mode-restricted temporary residue | clean WAL-header inspection and wrong-order refusal create no source sidecars; a child leaves committed schema corruption only in WAL and inspection rejects it while main/WAL/SHM hashes remain exact; static checks keep preflight before writable open |
| Raw state leaks context/source blobs, private runtime paths, or credentials | API presenters allowlist fields and omit raw blobs plus private cache/worktree/artifact paths; explicit diff/check output stays bounded and redacted | serialization tests scan responses for private paths, raw source bytes, and credential material |
| Repository/provider text executes in the browser | React renders values as text under a restrictive content-security policy; no raw HTML injection contract exists | presenter allowlist test carrying adversarial strings plus package-wide static no-raw-HTML-sink scan |
| Browser widens execution authority | expose only eight server-derived lifecycle descriptors; revalidate exact state, event revision, subject digest, and current repository/worktree evidence under one Linux lease; reuse existing provider/private-worktree/sandbox paths; provide no arbitrary command, commit, push, Git-ref, pull-request, merge, deployment, or source-checkout mutation authority | local closed kind/state matrices, stale descriptor and platform refusal, route inventory, source/ref invariance, and compiled Chrome confirmation/consequence tests passed 2026-08-02; Packet 2 exact-head hosted/native acceptance passed at candidate `701952349e0818cead37672df951ed09c0edd27c` and corrected implementation head `3683087066efb65255f05b2493fd31051c3ad7c6`; Gate 1 completion remains open |
| A forged, stale, duplicated, or unrelated cancellation aborts another action | parent-bound cancellation is the sole lease carve-out and must match the admitted same-run parent action ID, descriptor digest, kind, current coordinator generation, and process-local execution context before exactly one structured abort signal; settled or ambiguous cancellation evidence is never re-emitted | service tests cover wrong ID, wrong digest, stale generation, stale structured signal, exact one-signal propagation, and eventual settlement of parent and cancellation receipts |
| A malformed or altered Gate 1 benchmark widens repository, task, prompt, check, path, model, Git, or result authority, or synthetic output is presented as a live 3/3 landing result | the committed `fixtures/evals/gate1/manifest.v1.json` is a closed, exactly three-case TypeScript-library/Python-CLI/dependency-free-React-Node-module offline contract with raw-byte SHA-256 pins for task/source/approved-repair files, prompt-revision labels and exact production planning/edit system-instruction hashes, exact ordered check vectors, and exact source/candidate Git identities; the focused evaluator uses deterministic loopback production-Ollama transport, production no-network sandboxes, and only the real local candidate plus absent-only private-ref foundation; its schema-v1 result is a closed success/failure union: only success contains all three observations, while failure contains an ordered completed-case prefix, `partial_completed_cases_only` counters, stage/applicable-next-case/safe-code-or-null/message-digest identity, and an incomplete-effects limitation; failure `manifestSha256` is `null` only when raw manifest bytes were unavailable; no credential, paid model, external network, remote mutation, live migration, force-push, merge, or deployment is available; completed-case draft-PR/receipt effects are labeled contract-only and not executed; the derivative-effect declaration is `contract-only-unassessed`, not evidence about real repository automation; runtime reopen plus harness-journal replay is not browser/server restart or durable landing-coordinator evidence | manifest and result missing/extra/duplicate/wrong-type mutations plus single-byte fixture-pin mutations fail closed; exact three-stack cardinality, registered-check vectors, expected-path equality, success/failure topology, completed-prefix ordering, partial counters, failure identity, immutable limitations, and rejection of a promoted `gate1_complete` assessment; loopback/no-network, pre/post fixture snapshots, stale-result removal, atomic report validation/persistence, and source/ref-invariance tests; existing browser-session tests separately distinguish same-tab reload from process-restart origin/bearer rotation; a versioned human-approved credential-gated live-evidence profile must bind the offline manifest digest and immutable case pins, pin real provider/model/pricing/budgets, bind an operator-produced repository-automation assessment/disposition/raw digest, authorize only named separately approved remote effects, and produce real 3/3 identities before Gate 1 can be claimed |
| Hostile Gate 1 fixture Git metadata executes a clean filter or imports ambient Git authority before source invariance is established | fixture roots must be plain trees with root `.git` absent; manifest inventory paths reject every `.git` component and `.gitattributes` basename, while actual trees must match that exact inventory; copying explicitly excludes root `.git` and rechecks absence; fixture commands use fixed `/usr/bin/git`, fixed `PATH`, isolated home/configuration, disabled system/global configuration and attributes, disabled hooks and credential helpers, noninteractive prompts/SSH, and denied network protocols | subprocess regressions inject root `.git` as a directory, file, and symlink and inject a malicious local clean filter; all refuse before fixture Git effects and the filter marker remains absent |
| Filtered context or provider repository map exposes secret/generated data | preview reads committed Git objects, returns metadata only, and shares its path classifier with the real model repository map; every `.env*`, dependency/generated, symlink, binary/invalid-UTF-8, model-hidden/intrinsic-secret, and secret-content entry is omitted or planning fails closed | deterministic filter tests, captured provider request, hidden-blob test, and source fingerprint |
| Prompt injection expands authority | Host policy is outside prompts; the model can return only strict plans/patch sets or calls from the closed registry, and every call is independently grant-checked against approved scope | malicious repository/tool evidence reaches the real prompt but cannot expand targets, reads, checks, network, budgets, or state transitions |
| Path traversal or absolute write | lexical containment plus protected-path policy | traversal tests |
| A patch set changes a path the operator did not approve | the plan approval digest binds the approved target set; every patch-set path must be in that set, must pass protected-path policy independently, and verification requires the changed-path set to equal the patch-set paths exactly | patch-set path-gate tests, plan-digest binding test, and verification set-equality tests |
| A session loop runs unbounded, consumes settlement/recovery headroom, or lacks authority | only a failed first verification may enter; explicit plan grants and `iterationCeiling` are bound by the approval digest; the host maximum is two; admitted `provider.revise` and tool work is charged before effects, while session entry and every later admission retain one ordinary slot plus `commandTimeoutMs` for `session.reconcile`; local/remote/resumed worst cases consume 30/31/32 of 40 ordinary operations | grant-digest, zero-iteration single-shot, local/remote/resume accounting, tight slot/runtime margin, true interrupted-ledger reconciliation, refusal, budget-exhaustion, and non-approvable landing tests |
| A session read or check diagnostic widens context egress | read scopes resolve to an approved base-commit path/digest manifest; `read_file` accepts only matching base bytes or current session-written bytes, while list/search enumerate base-manifest paths only; every remote repeat call rechecks exact context egress approval; remote verification and `run_checks` reuse project only host-owned check ID/outcome/exit/truncation metadata plus an output-omitted marker, while full stdout/stderr remains local; resume reconstructs that projection from the atomically adjacent verification event rather than a legacy tool transcript | manifest drift, session create/read, list/search exclusion, remote repeat-egress, and grant-scope tests plus initial/live/compacted/resumed check-output canaries and loopback/raw-SQLite retention |
| A revision widens what the run may change or leaves partial bytes | plan parsing bounds mutation grants by the plan's narrowed target ceiling, and session entry canonically revalidates persisted grants before iteration admission, provider I/O, reconciliation, or any worktree restore; `propose_patch` is advisory and persists no authority; `apply_patchset` carries its own bounded PatchSet and independently revalidates the approved grant, paths, preimages, secrets, and ceilings, then restores the immutable baseline, persists exact intent before writes, and uses guarded atomic file operations. Interrupted materialization resumes from persisted intent with `unavailable`, non-approvable verification | narrowed-plan grant unit tests; mutually consistent legacy broad-grant resume with zero provider/reconcile/session effects and byte-exact unchanged files; independent-apply validation, no-proposal-authority, intent-before-write, compensation, crash-reconcile, and source-fingerprint tests |
| Model copy or exhausted turns are presented as success | `run_checks` records only a complete approved check set; `report_done` revalidates the current checkpoint/diff/passing evidence; human input and exhaustion persist blockers in `awaiting_review` that approval refuses | report-before-check, stale-evidence, human-input, exhaustion, and review-refusal tests |
| Tool results or errors leak credentials or become authority | every result/error is bounded, secret-scanned, and fenced as untrusted before persistence/provider reuse; registered tool control flow, never returned content, determines host state | result/error secret fixtures, output ceilings, injection fixtures, and fixed-control assertions |
| Session persistence becomes a second mutable authority | approved `plan_json` plus approval digest is the sole grant source; existing operations and bounded boundary/terminal events are the sole session source; no `capability_grants`, `agent_sessions`, or `tool_invocations` tables are introduced | schema-stability, digest binding, operation/event reconstruction, and interrupted-operation charging tests |
| A crash or forged tool label splits an effectful operation from the evidence or state it claims | effectful `apply_patchset`/`run_checks` and session-control finishes commit atomically with verification/session-terminal evidence, while advisory/read tools settle only their operation; apply/proposal classification must agree with the exact active operation's intent/checkpoint events and redundant row/event tool discriminator; `review.validate`, rollback, and restore finish with the corresponding state transition | transaction-failure injection proves neither half can persist alone; relabel, duplicate-key, row/event disagreement, missing-successor, and non-mutation intent-laundering regressions fail closed; resume observes started work or one complete settled boundary |
| A partially applied multi-file change is presented as a result | every path is validated and every replacement staged outside the worktree before the first visible change; a failure part-way through compensates the applied paths and fails closed; a crash resumes into drift detection with the persisted tree checkpoint as the recovery path | multi-file apply tests asserting no write on any unsafe path, staging location, idempotent replay, and byte-exact reversal |
| A created or deleted path is confused with empty content | tree checkpoints record an absent side as null rather than empty bytes, and the checkpoint digest distinguishes the two | tree-checkpoint digest tests |
| Patch-set storage migrates live operator state without consent | the ADR 0023 tables are additive and created only after a read-only shape inspection that fails closed, gated by its own exact one-shot approval token distinct from the approval-index token | migration-gate assertions and refusal tests |
| Symlink escape | reject symlinks in every existing component and target | symlink test |
| State initialization writes inside a Git checkout | lexical and canonical ancestor walks reject any `.git` marker before state-root creation; registration separately rejects repository/state containment in both directions | symlinked nested-state rejection, absent prospective directory, and source fingerprint |
| Source checkout/Git corruption | private no-hardlink cache owns all worktrees | source refs/config/status digest |
| Concurrent planning or Linux mutation, or stale-owner deletion | an atomic SQLite partial unique index admits one started operation per run before portable planning work; Linux approval/execution additionally use a stable single-link lease inode plus kernel `flock`; malformed metadata fails closed; v1-to-v2 upgrade is stop-the-world | Linux/macOS/Windows planning-admission coverage plus live-owner, legacy-owner, malformed, crash-recovery, and forced-replacement tests |
| Arbitrary host execution | project code runs only in fail-closed no-network sandbox | real-container probes deny public, host-loopback, and Tailscale-address-space connections |
| Secret leakage to history | credentials are environment-only; one bounded span scanner supplies detection and constant-marker redaction; reflected provider credentials are discarded; HTTP error bodies are not retained | provider reflection/error tests plus persisted-tree scan |
| Secret leakage to provider or derived copies | the complete tracked tree is audited before artifacts, egress, caches, or worktrees; edit, model-visibility, and intrinsic-secret path rules are distinct | unrelated-secret no-side-effect test plus safe `.npmrc` sandbox test |
| Unbounded spend/runtime or rejected approvals exhaust the run budget | explicit context, output-token, cost, active-time, file, tool, and output ceilings; side-effect-free approval preflight rejects invalid actor/digest/gate inputs before metered validation; only a fixed, two-attempt, metered `cancellation.recovery` may exceed ordinary runtime admission to land safely | budget and emergency-recovery tests plus stale egress/plan/review, malformed egress, and failed-verification review history/worktree/provider invariance |
| Workflow-validator bootstrap drifts, is tampered with, or silently stops checking workflows | exact release URL plus pinned archive and executable SHA-256; bounded download/extraction/version checks; real-directory ignored cache; no silent binary fallback; every workflow plus a known-invalid negative self-test | `workflow:setup` idempotence, missing-tool failure, `workflow:lint`, static security assertions, and hosted exact-head CI |
| Provider/context credential exfiltration | exact pre-egress approval, secret/path filtering, reject URL user info and redirects | endpoint/egress tests |
| Interrupted atomic write strands an unreviewed path | temporary file is private and outside the worktree; rename is the only worktree mutation | failed-rename cleanup and changed-path tests |
| TOCTOU path swap | isolated single-operator worktree; `O_NOFOLLOW` descriptor read with identity checks; component checks, atomic write, and final changed-set verification | adversarial test |
| Misleading success | timeout/cancellation cannot pass on exit zero; exact internal state stays visible; absent provider/execution is `unconfigured`; absent checks are `not_run`; history is append-only | timeout-trap, phase mapping, restart-before-plan, populated completed-run HTTP evidence, real-Chromium smoke, history, drift, and measured-eval tests |
| Destructive rollback | rollback touches only the approved path in the owned worktree and retains checkpoint | rollback/restore test |
| SQLite tampering/corruption | local file permissions, foreign keys, WAL, transaction boundaries, backups documented | operations drill |

## Second M3 observation threats

| Threat | Current control | Evidence and limits |
| --- | --- | --- |
| Repository observation mutates the source or leaks dirty paths/content | project-scoped fixed read-only Git argv; file-only transport; lazy fetch, prompts, and optional index locks disabled; traditional hooks redirected; configured hook commands and effective clean/smudge/process filters or alternate-ref commands rejected; `post-checkout` disabled at command scope; allowlist only independent availability/worktree/HEAD/branch/base-relation fields; persist nothing | source fingerprints cover content status, refs, config, index, and linked worktree metadata; clean/staged/unstaged/untracked and helper-command marker tests prove omission and no invocation. Config-hook rejection is version-independent and covers a tampered private cache; the execution host is Git 2.43, so a real Git 2.55 configured-hook run is not claimed. Same-user config TOCTOU remains a non-goal. |
| A missing repository, identity mismatch, unresolved ref, or Git failure appears clean | availability, worktree, HEAD, branch, and base relation are independent; unresolved and error states remain explicit; detached HEAD is `branch: null` without changing cleanliness | focused endpoint tests cover clean, dirty, divergent, detached, unresolved, unpeelable, missing, replaced-identity, invalid-HEAD, and spawn-failure cases. |
| Event history leaks private paths, diffs, check output, or other raw payload data | fixed-size sequence-cursor pages expose only sequence, type, host-controlled label, timestamp, and fixed `evidenceSection`; the browser presenter selects no `payload_json` | corrupt/private payload fixtures pass through selected-run and workspace endpoints without decode or disclosure; the CLI full-history path still detects the corrupt payload. |
| A full run response combines different database moments, scans or materializes unbounded approval history, or an older response overwrites newer event knowledge | the run, newest 12 validated approvals, approval coverage, and 200-row metadata tail share one SQLite read transaction; a per-run ordering index plus `LIMIT 13` avoids a history-sized scan and caps returned rows; direct storage/byte `CASE` preflight bounds materialization; the event high-water mark and client guard prevent revision rollback | 0/1/12/13 boundaries, all enums, same-time ordering, query-plan proof, corrupt/BLOB/oversized field matrix, endpoint shape, static allowlist assertions, and monotonic client tests pass. Building the additive index on existing state remains backup/operator gated; a separate concurrent-process WAL stress test is not recorded. |
| A truncated browser tail rewrites older action truth | an incomplete tail starts with explicit unknown action state; only self-establishing retained transitions make it known; ambiguous cancellation remains unknown with CLI guidance | presenter regression places materialization before the 200-row tail and cancellation at its end, then proves the browser does not guess. CLI history remains complete. |
| Polling continues while hidden, overlaps, storms after failure, or overwrites a new selection | selected-run-only foreground short polling; one current request; visibility pause; abort on selection change/unmount; bounded failure backoff reset only by success; selection/request guards | pure delay/cursor tests cover the 2/4/8/15-second sequence, cap, rollback rejection, and snapshot threshold; real-browser acceptance covers visibility, injected failure/recovery, a held non-overlapping request, cancellation on unmount, preserved newer selection, and a newly appended event causing an event-page read, subsequent coherent full-run read, and rendered update without reselection. |
| Untrusted event or repository text becomes an injected navigation target | a closed host-generated evidence-anchor map; untrusted strings render only as text | hostile anchor inputs fall back to `run-activity`; presenter tests verify fixed targets; the static security gate forbids raw-HTML sinks. |

The slice adds no Server-Sent Events, WebSocket, watcher, schema migration,
runtime dependency, background daemon, or browser action route. Existing
loopback and guarded CLI boundaries remain authoritative, and ADR 0025's
third-party review and secret-rotation release holds remain open.

## Third M3 older-activity threats

| Threat | Current control | Evidence and limits |
| --- | --- | --- |
| Browsing older events drains history or creates unbounded server/client work | direct reverse exclusive cursor pinned to a revision; index-backed descending `LIMIT 65`; one retained 64-row page and four-page cursor window; no count or forward drain from sequence zero | query-plan and more-than-200-event tests prove fixed page boundaries, page replacement, bounded depth, and CLI guidance beyond the window |
| Historical browsing leaks private payload paths, diffs, or check output | select only sequence/run ID/type/timestamp and reuse the fixed host-label/evidence-section presenter; never select or decode `payload_json` | corrupt and private payload fixtures succeed without payload bytes in store, API, or browser output; complete payload history remains CLI-only |
| A late or mismatched historical response overwrites another run or advances live freshness | exact run/before/snapshot validation plus request generation; historical and live cursors are separate; opening history aborts/pauses live polling and close resumes from the unchanged live cursor | pure client and real-browser tests cover held responses, no overlap, hidden/close/selection/unmount abort, preserved newer selection, and live pause/resume |
| Corrupt metadata creates an oversized response, gap, or injected navigation target | canonical safe-integer query contract; bounded event type/timestamp; contiguous sequence validation; fixed host label/anchor fallback; React text rendering and CSP | malformed/duplicate/unknown query tests, database-corruption regressions, presenter tests, and static no-raw-HTML/route assertions |
| A historical page is mistaken for the current evidence snapshot | pin and display the page revision; preserve the coherent recent timeline separately; describe any fixed anchor as current evidence rather than historical payload detail | UI copy and browser navigation tests distinguish the pinned metadata page from current evidence |

ADR 0016 adds no write, event append, Git/source read, filename/content/diff/check
disclosure, schema/dependency, stream, daemon, or browser action route. ADR
0025's residual release holds remain independent.

## Fourth M3 workspace-run summary threats

| Threat | Required control | Required evidence and limits |
| --- | --- | --- |
| Workspace bootstrap grows with all run history or decodes private full-run fields | replace all-run hydration with a direct fixed-field rowid query, descending `LIMIT 13`, 12 retained summaries, and lazy selected-run detail | more-than-200-run and query-plan tests prove fixed row visits, response size, no N+1 full presentation, and omission of corrupt/private heavy columns |
| New insertions shift older pages or a forged cursor creates unbounded work | pin membership to a safe `MAX(rowid)`; require canonical `before` and `snapshot`, validate their relation/existence, and seek the intrinsic rowid B-tree | empty, gap, boundary, unsafe-integer, malformed/duplicate/unknown query, concurrent-insert, and reopen tests |
| A rowid cursor is mistaken for a durable run identity or survives unsupported database rewriting | expose rowid only as top-level ephemeral session metadata; no per-run rowid, bookmark claim, deletion, replacement, or `VACUUM` route; fail closed when cursor anchors disappear | UI copy and response-shape tests; external direct database mutation and maintenance remain out of scope and require opening a new session |
| A late page overwrites a newer page or selected run | one current request, abort on hidden/new-page/refresh/selection/unmount, exact generation/cursor validation, and summary state independent from selected full-run state | pure client and real-browser held-request, contention, delayed-success, selection, and failure/retry tests |
| A partial page is presented as complete workspace or project history | no total count; fixed loaded-row label; project list says it contains matches only from the loaded workspace page; four-page cap with CLI guidance | presenter/client/browser copy and navigation tests |

ADR 0017 adds no schema/dependency, write, event append, database-maintenance
route, Git/source read, provider/context/plan/edit/diff/check/output/error/usage/
approval/event disclosure, stream, daemon, or browser action route. Project and
repository enumeration remained unpaginated at that stage; ADR 0021 now bounds
it, while ADR 0019 independently bounds the ordinary selected-run approval
response. ADR 0025's residual release holds remain independent.

## Implemented fifth M3 verification-attempt threats

| Threat | Required control | Required evidence and limits |
| --- | --- | --- |
| Optional attempt reads materialize unrelated private run/checkpoint fields or raw event JSON | select only safe run ID/state fields; checkpoint query selects only run ID/digest/time; SQL returns only payload storage class, byte length, counts, and allowlisted scalars; existing event routes stay payload-free | poisoned private run/checkpoint columns still succeed; SQL-shape/query-trace assertions forbid `SELECT *`, private checkpoint columns, and raw payload return; sentinels stay absent from API, DOM, logs, and errors |
| SQLite accepts a payload the CLI rejects, or selected JSON work is not byte-bounded | require TEXT storage and direct-column `octet_length(payload_json)` before JSON work: 8 MiB completions, 16 KiB lifecycle transitions, 1 KiB checkpoint saves; strict `json_valid(..., 1)`, exactly-once selected keys, and scalar types | BLOB/number, RFC-8259, JSON5, duplicate-selected-key, wrong-type, and exact/over-bound tests; unrelated corrupt payloads remain unread |
| The UI invents an attempt identity, timeout, supersession, or rollback relation from adjacency | derive only non-overlapping `verifying` intervals from explicit validated state transitions; mark starts outside coverage; retain unknown timeout/reason; describe only a later observed anchor, never formal supersession | boundary-straddling, crash resume, timeout-collapse, cancellation, failure, restore, and rollback non-correlation tests |
| A sparse type query makes one optional read proportional to complete history | identify types only inside the exact contiguous suffix of up to 200 sequences and use the per-run sequence index; retain eight with no history count | more-than-200-event, 0/1/8/9-attempt, response-size, and query-plan tests; no full-history scan |
| Event and checkpoint data come from different moments or reverse causality | exact-current client snapshot in one transaction; safe checkpoint columns in the same snapshot; an observed save sequence precedes every completed attempt that cites its digest | concurrent append before the transaction conflicts; append after yields a coherent pinned response; missing, duplicate, mismatched, post-completion, and save-order checkpoint regressions fail |
| “Checkpoint provenance” is mistaken for fresh byte integrity | never select baseline/approved Base64; completed attempts may report only recorded digest agreement; incomplete/cancelled intervals report only run-checkpoint availability; an unobserved save event is not called older, missing, or corrupt | private-byte sentinels and poisoned excluded-column tests; no rehash or restore call |
| Truncated summaries are presented as complete current history | independent `earlierEventsExcluded` and `attemptAnchorsTruncatedWithinCoverage`; no complete-invocation claim; fixed-limit copy and CLI guidance | empty, coverage-only, attempt-only, boundary-unknown, and dual-truncation presenter/browser tests |
| A stale or late auxiliary response loops, replaces another run, or escapes cancellation | fresh current seed per explicit action; conflicts require operator run refresh; automatic live reconciliation only marks stale; parent-only aggregate cancellation plus request-local ordering; exact bounds, enums, and relational validation | live-versus-manual refresh, attempt-Close/history independence, abort-before-history-open, hidden/selection/Back/unmount, stale retry, focus fallback, and cancellation-ignoring real-browser races |
| The view widens browser authority | GET-only route and text-only inline region; no approval, rerun, restore, command, Git, or mutation path | method negatives, zero SQLite logical writes/events, unchanged source/Git fingerprints, and static route/raw-HTML/workflow assertions |

ADR 0018's controls are implemented, locally evidenced, independently reviewed,
and exact-head hosted-CI verified. ADR 0025's residual release holds remain
independent.

## Implemented seventh M3 persisted-diff review threats

| Threat | Required control | Required evidence and limits |
| --- | --- | --- |
| A corrupt or mismatched persisted diff is presented as reviewable | require paired diff/verification presence, project ceiling, one exact changed target, canonical digest, displayed-byte rehash, one ordered target-bound patch, and internally consistent hunk bodies; fail with fixed copy | unit and API corruption matrices cover missing partners, wrong decoded header/target, malformed ordering or hunk counts, wrong digest/path, sanitized errors, and byte-identical read-side state |
| A large diff amplifies the response/DOM or a partial preview is mistaken for complete approval evidence | return complete text only through a fixed 262,144-byte browser cap; above it return metadata and `recorded_only` provenance with no substring | exact-bound response remains complete, one-byte-over/private-tail coverage is metadata-only, and static assertions forbid partial-string operations; this bounds response/rendering, not the existing full-run SQLite hydration |
| Persisted evidence is mistaken for current source or worktree status | display exact persisted run state and verification outcome; explicitly state there is no fresh repository read and that rehash agreement proves only displayed recorded bytes | presenter/API copy assertions and completed real-browser truth-copy/digest evidence; guarded CLI review continues to revalidate live state |
| Patch text executes or creates attacker-sized per-line UI | render one complete React `<pre>` text node inside a labelled, keyboard-focusable bounded scroll region; no line-derived elements, HTML sink, path link, or action control | HTML-like patch survives API serialization as text; static no-sink/no-control assertions pass; cached Chromium 1228 proved inert rendering, Tab focus, PageDown scrolling, fixed-anchor navigation, zero external requests/browser errors, and unchanged durable/source state |
| The review surface widens authority or timing | reuse the existing coherent selected-run response; add no route, query, Git/source read, request, poller, write, or action | unchanged SQLite and repository fingerprints plus static no-read-authority and fixed-anchor assertions |

ADR 0020 is Accepted after its combined local, independent-review, merge, and
exact-head hosted gates passed. ADR 0025's residual release holds remain
independent.

## Implemented eighth M3 project-catalog and transport threats

| Threat | Required control | Required evidence and limits |
| --- | --- | --- |
| Workspace bootstrap or paging hydrates an unbounded catalog or performs N+1 work | return one newest-first pinned page; use one intrinsic-project-rowid `LIMIT 13` range query joined through repository primary key; creation uses exact indexed lookups | empty and more-than-200-project tests, rowid gaps, insertion-stable snapshots, exact query-plan assertions, collection loaders forced to throw, and at most 12 presented rows |
| Malformed or oversized persisted project configuration consumes host memory or crosses a private field | preflight SQLite storage class and byte length before strict JSON parsing on both joined pages and indexed direct hydrators; validate exact keys, scalar bounds, and policy; enforce the same checks/sandbox/ceiling caps on supported writes; reconstruct an explicit presenter | TEXT/BLOB, invalid/extra JSON, malformed policy, oversized field/config, direct name/ID/create-run lookup, and excluded-private-column tests; checks at most 1 MiB and sandbox/ceiling at most 16 KiB |
| Stale or repeated navigation accumulates the catalog or silently replaces the project under review | replace rather than append pages; retain at most four positions; require exact snapshot/cursor identity; abort superseded and lifecycle requests; keep last success for explicit retry; while a run is open, resolve only its owning project | client tests plus a 50-project Chromium fixture cover four-page depth, stale responses, failure/retry, contention, hidden/selection cancellation, and off-page run ownership across page navigation and workspace refresh; no total-count claim |
| A large aggregate or trusted error response sends success headers, partial JSON, or rejected private bytes before failure | completely serialize with the trailing newline and enforce one 8 MiB UTF-8 ceiling before `writeHead`; cap trusted error messages at 4 KiB; retain fixed `RESPONSE_TOO_LARGE` and pre-serialized internal-error fallback copy | exact-bound and one-byte-over unit tests plus oversized selected-run and 9 MiB trusted-error integration tests prove no success headers, no private sentinel, no recursive failure, no partial JSON, and continued server health |
| Keyboard users cannot bypass the long sidebar or distinguish the active project/run | first-focus skip link targets a focusable main landmark; global visible link focus; selected project/run buttons expose pressed/current state; diff overflow remains a labelled keyboard region | real Chromium Tab/Enter skip-link acceptance plus catalog ownership and persisted-diff PageDown coverage; static accessibility assertions |
| The catalog widens browser authority or reads the source checkout | keep the route GET-only and the view text-only; add no Git/source, provider, approval, execution, command, commit, push, deployment, or release path | method/static guards, zero logical SQLite writes, unchanged action routes, and explicit ADR scope |

ADR 0021 is Accepted after its fresh local, independent-review, merge, and exact
published-head gates passed. ADR 0025's residual release holds remain
independent.

## Change Room threats (implemented under proposed ADR 0041)

| Threat | Required control | Required evidence and limits |
| --- | --- | --- |
| A room projection leaks private paths, checkpoint bytes, event payloads, raw provider prompts, or source blobs | derive cards in one read transaction from the run row, approvals, the bounded 200-event tail, safe checkpoint columns only (run ID, digest, timestamp), project configuration, and annotations; reuse only the disclosure classes the existing full-run presenter already crosses | presenter allowlist and serialization scans keep checkpoint bytes, private cache/worktree/artifact paths, event payloads, raw prompts, and source blobs out of room, index, and change-context responses |
| Corrupt or unprojectable provider/verification JSON breaks or skews the room index | project those columns in SQL only behind `typeof`/`octet_length` preflight (16 KiB provider, 4 MiB verification) and strict `json_valid(..., 1)`; an invalid or unprojectable value fails the page closed as database corruption | the index never guesses an unknown model or outcome; the failure is an explicit closed page, not a partial or fabricated summary |
| An annotation becomes authority or mutates the event stream | `run_annotations` is append-only with no update or delete path anywhere; annotations never append lifecycle events, advance event cursors, change run state, satisfy gates, or feed digests, approvals, verification, or execution; all three API routes are GET-only and perform no durable writes | by design contract the run row, event stream, and approvals are byte-identical after annotating; browser display is read-only inside the room projection and no browser annotation route exists |
| Secret-shaped annotation content persists | validate before any write: run existence, a closed card enum, the approval-actor rules (bounded length, no CR/LF/NUL), a 1 KiB non-blank body without NUL, and fail-closed `SECRET_INPUT_DETECTED` rejection of recognizable credential material in actor or body | rejected input leaves no durable row; the 32-per-run cap (`ANNOTATION_LIMIT_REACHED`) keeps room responses bounded |
| Room, index, or packet responses grow without bound | exactly eleven fixed cards with bounded bodies and references; at most 32 annotations of 1 KiB each; the 200-event metadata tail; twelve retained index rows per page; at most eight change-context components | response shapes are fixed-size by construction; no route enumerates unbounded history, payloads, or free-text search results |
| A change-context answer invents facts or hides doubt | a pure host function builds the packet over the room projection: host-controlled templates interpolating only bounded facts, per-statement receipts (evidence-card IDs, event sequences, digests), explicit omission and uncertainty lists, and no LLM, provider, network, or external tool | every statement is traceable to recorded evidence; truncated timelines and absent free-text reasons are stated as uncertainty; a completed run's `what_changed` states nothing was committed, pushed, merged, or deployed |
| Room digests are mistaken for fresh authorization or current integrity | the integrity block declares `digestSemantics: "byte_binding_only"`; the checkpoint card notes its digest is a recorded byte binding, not a fresh rehash; the provider plan is labeled an untrusted proposal | the projection never claims fresh authorization, semantic correctness, or rehashed bytes; rollback completion sequences mark observed completion events, not causal links |
| The slice widens browser authority | all three routes are GET-only observation reads; mutation verbs are refused by the ADR 0029 action-session boundary (401 without it, 404 behind it); unknown runs receive 404; invalid query contracts receive 422; no approval, mutation, annotation-authoring, execution, command, commit, push, or deployment route is added | route inventory assertions cover the new routes; the ADR 0029 mutation session and its fenced origins are untouched, and no change-room route participates in them |

ADR 0041 adds no schema beyond `run_annotations`, dependency, write route,
stream, watcher, daemon, or browser action route. ADR 0025's residual
third-party-review and secret-rotation holds remain independent.

## Change Handoff Pack threats (accepted ADR 0042)

| Threat | Required control | Required evidence and limits |
| --- | --- | --- |
| A Handoff Pack leaks the richer local Change Room or raw run evidence | construct a dedicated safe-facts snapshot and explicit `icarus.change-handoff.v1` serializer from an empty object; never import, spread, serialize, filter, or echo a Change Room/full run/event/annotation/plan/PatchSet/verification/provider response | seed and assert persistence of distinct task, target/source/context/artifact paths, plan step/risk/rationale/grant, PatchSet path and before/after bytes plus their Base64 encodings, diff, command/argv/stdout/stderr, sandbox, annotation/actor, event, worktree/cache, URL, credential/header, research, code, and error canaries; assert none occur in canonical bytes, result, inspection, summaries, omissions, uncertainty, or a canary-bearing failure; static checks forbid Change Room reuse and non-allowlisted payload keys |
| A nominally allowed identifier or model carries a path, URL, shell fragment, header, or credential | correlation ID is 1–128 bytes under `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`; optional external reference uses the same alphabet for 1–256 bytes; model crosses only under the same 1–128-byte safe-token rule; secret-shaped content fails closed | exact-bound and one-byte-over tests cover whitespace, controls, slashes, schemes, header/shell forms, Unicode, and recognizable credentials with zero output writes |
| Corrupt, contradictory, incomplete, or concurrently journaled local records produce a plausible safe outcome | fingerprint the owned SQLite family; reject unknown companions and non-empty WAL evidence; capture stable bounded main-database bytes into memory; normalize only the private image; query it read-only/query-only; re-fingerprint the source; strictly decode intent and transition payloads and replay every state-bearing event in order; reconcile every operation start/terminal/row by ID, kind, grammar, status, reservation, result presence, and aggregate usage; bind open repair epochs, succeeded revision credit, mutation-owned replacement intent, mutation/reconcile-owned new checkpoints, current checkpoint/verification/review, failure/resume, cancellation origin, and atomic successors; require every session verification to reverse-bind to its immediate permitted operation terminal; allow apply, failed/cancelled apply, and reconciliation to produce only unavailable evidence while only a succeeded check operation can produce current passing evidence; require every proposal terminal to have zero patch effects and classify apply only when duplicate-free row/event tool values agree with exact intent/checkpoint effects inside that operation; never SQLite-open or write a temporary copy of the source | corruption matrices cover provider, approval, intent, transition aliases and origin/destination, zero-turn exhaustion, active/failed/interrupted revision boundaries, current-epoch supersession, out-of-operation replacement/checkpoint laundering, failed-proposal effect laundering, unbound or wrong-status verification, forged apply/reconcile pass outcomes, apply/proposal relabeling, duplicate discriminators, row/event disagreement, missing successors, operation reservations/status/usage, stale resume, duplicate review, verification, checkpoint, event high-water, recovery, digest, count, state/phase, terminal relations, WAL-busy refusal, and unchanged database/source fingerprints |
| Preview secretly mutates state, reads credentials, contacts a provider/network, or writes a repository/cache/worktree | dispatch through a dedicated read-only path before writable runtime/service/provider/Git/artifact construction; emit bytes and digests only | before/after tests fingerprint the complete SQLite family/state directory, fixture checkout including `.git`, cache, worktree, and context artifact while counting global fetch calls; static import/runtime assertions separately forbid provider and network primitives; repeated preview is byte-identical and every observed fingerprint and call count remains unchanged |
| Export publishes evidence different from what the operator previewed | a separate request/preview SHA-256 binds versioned inputs, safe source revision/binding, schema, and newline-inclusive payload digest; export reopens/revalidates/recomputes before any create and compares the exact expected value | unchanged inputs produce byte-identical preview/export; every digest-bound lifecycle mutation makes the preview stale and creates no output; payload SHA and preview SHA cannot be substituted |
| Output paths overwrite, follow, alias, race, or leave misleading partial success | fixed filenames only; require a current-user-owned parent that is not group/other-writable; owner-only descriptor-relative `O_NOFOLLOW`/`O_EXCL` regular single-link files; payload then result; file, output-directory, and parent-directory-entry `fsync`; identity rechecks; no overwrite; caught-error cleanup only for this invocation's matching partial file | dynamic tests cover symlinked ancestors/finals, hardlinks, special files, unsafe modes, a writable parent, both pre-existing names, partial second-file failure, and preservation of every pre-existing destination; implementation/static assertions require owner/mode checks, descriptor/path identity rechecks, and file/output/parent sync |
| A platform without the required descriptor-root and no-follow primitives silently falls back to weaker reads or export | make the secure source reader, export writer, and handoff-file reader Linux-only; preflight platform and capabilities before source/file access and before export directory creation; fail with `HANDOFF_EXPORT_UNSUPPORTED`; never substitute path-only publication | exact Linux security coverage; macOS and Windows fail closed before protected file access or output creation and require a separate ACL-aware implementation plus matching native evidence before support is claimed |
| A hostile handoff file exploits parsing or causes inspection to echo unknown material | file-only bounded reader checks ownership/mode/type/link/identity/growth, fatal UTF-8/BOM/NUL, byte/depth/member ceilings and duplicates before exact-shape decode; canonical re-encoding must equal the original one-LF bytes; inspection has its own allowlist | dynamic tests cover symlinked ancestors/finals, hardlinks, special/unsafe-mode files, duplicate and escaped-duplicate members, malformed/deep/oversized/noncanonical framing, invalid digest/enum/count, unknown keys, and private canaries; implementation/static assertions require bounded reads plus growth and descriptor/path identity rechecks |
| A digest is mistaken for confidentiality, authenticity, truth, disclosure approval, or execution authority | every payload carries the exact integrity disclaimer and uncertainty that unkeyed digest references are not confidentiality controls and may confirm a correct low-entropy guess; file verification separately reports internal consistency, authenticity, authorization, truth, disclosure permission, and execution authority; no signature, identity, authentication, or action grant exists | copy/contract tests require the disclaimer and distinguish byte binding, confidentiality limits, recorded-evidence integrity, authenticity, authorization, truth, disclosure permission, and execution/landing |
| File-only verification unexpectedly opens or creates Icarus state | dispatch `handoff verify` and `handoff inspect` before state-root resolution, migration, runtime, service, environment credential, or database setup; lazily construct schema checks so core module evaluation opens no SQLite database | run both successfully with a nonexistent or inaccessible `ICARUS_HOME`, preload a constructor-denying `better-sqlite3` proxy, and assert state remains absent/unchanged; static ordering and lazy-schema assertions cover CLI dispatch |
| The future Athena seam becomes a delivery/control plane | documentation permits only schema, full payload digest, run ID, correlation ID, safe lifecycle outcome, and disclosure class in a later imported event; this slice has no `constellation.event.v1` runtime type, Athena/Minerva client, API/browser route, identity/credential, outbox, callback, retry, worker, or receiver | static import/route/schema/state inventories stay unchanged; no network is attempted; receiver non-authority tests/copy forbid run creation, approvals, evidence access/inference, landing/deployment, or downstream triggers |
| The new artifact weakens Change Room or guarded lifecycle guarantees | keep the handoff modules/commands separate and add no lifecycle event/table/action; preserve the eleven-card room, deterministic replay, GET-only routes, redaction, five model-free questions, append-only annotation non-authority, and no represented commit/push/merge/deploy | all existing Change Room unit/integration/browser/static suites remain green in addition to focused handoff tests; no existing assertion is removed or weakened |

The Handoff Pack adds local files only after explicit export. It adds no database
schema, durable delivery state, API/browser/provider/Git/landing/deployment path,
or receiver. Owner-only output protects against accidental disclosure, not a
hostile same-user process. A copied valid file still has no proven author and no
authority. Future authentication or Athena import requires a separate accepted
decision and threat model.

## GitHub gateway threats (Packet 4a package; S2b-ii-a wires the read-only preflight)

`packages/github-gateway` is now imported by `@icarus/core`'s landing
coordinator, which drives exactly its read-only surface: the `github.preflight`
stage at `local_ready` performs the actor, base-ref, and head-ref-absence GETs.
No mutating operation is reachable — the mutation kinds stay fenced at the
ledger — and no pull-request list read occurs yet, so ADR 0043's two open
contract questions are not relied upon. Coordinator-side controls for this
wiring: every request is admitted to the durable ledger with its bounded charge
and event before any network I/O and settled with its canonical result after; a
process interruption leaves takeover to settle an open admission as
`GITHUB_OUTCOME_AMBIGUOUS` rather than inferring failure; and the token resolves
env-only at call time through the profile's allowlisted name, never persisted.
These rows describe the package's own boundary; the coordinator's
intent-before-effect and reconciliation obligations remain under ADR 0027.

| Threat | Required control | Required evidence and limits |
| --- | --- | --- |
| An uploaded object executes in the repository before a human reviews the draft PR | deny repository-automation paths before any object upload: six automation roots and ten root-level automation filenames are refused with `GITHUB_AUTOMATION_PATH_DENIED`; executable and non-regular file modes are refused | creating the head ref or opening a same-repo draft PR fires repository automation with repository secrets, so a shape-only path allowlist is a remote code-execution path; tests assert refusal for GitHub Actions, CircleCI, GitLab, Jenkins, and Azure Pipelines definitions and non-regression for ordinary source paths that merely contain the word |
| The credential leaves the process to a non-GitHub or local listener | pin the origin to `api.github.com` at parse time and again at dispatch; refuse scheme-relative and opaque-status escapes; `redirect: "manual"` so no redirect is followed; a loopback origin requires an explicit `allowLoopback` construction opt-in because it would receive the token in cleartext | origin matrices assert no host was contacted on refusal; production wiring never passes the opt-in; the token is read from the environment at call time, never persisted, and is absent from serialization, own-keys enumeration, error paths, and decoded blob content |
| A refused mutation is recorded as benign idempotency | GitHub returns 422 for existing-ref, missing-object, unusable-name, and ruleset/branch-protection refusal alike, and the gateway reads no upstream bytes, so it reports `GITHUB_REF_CREATE_REFUSED` and `GITHUB_PULL_REQUEST_CREATE_REFUSED` rather than claiming "already exists" | a protection refusal recorded as benign existence would persist forever; tests assert the refusal codes and the absence of any `GITHUB_REF_EXISTS` classification |
| An interrupted mutation is settled as a known outcome | an interrupted mutating request raises `GITHUB_OUTCOME_AMBIGUOUS`; only reads degrade to timeout, cancellation, or transport errors; no mutating request is retried inside the package, because ADR 0027 places retry with the coordinator's durable intent and reconciliation | the coordinator, not the gateway, decides what an ambiguous effect means; tests separate the mutating and read classifications at the same interruption point |
| Reconciliation reads deadlock or silently truncate | a paged list is accepted only when `Link: rel="next"` is absent; a single open, single merged, or single closed pull request is selected in that order and anything else fails closed | a run-id-pinned head that cannot reconcile can never land, so an ordinary close-and-reopen must resolve rather than jam; the response ceiling interaction with page size is an open interface item recorded in the continuation plan |
| Forbidden authority becomes expressible later | the HTTP method union admits `GET` and `POST` only and the operation table is a frozen closed enumeration, so force update, reference deletion, merge, and deployment endpoints are inexpressible rather than unused | static release-gate assertions scan for method literals and forbidden endpoint shapes; treat them as a smoke alarm rather than a proof, since they match source text |

Upstream bytes do not reach errors, and receipts carry digests, latency, and a
bounded status token only. Rate-limit responses currently collapse to a bare
HTTP error; surfacing bounded retry integers is an open interface item. No
independent review record was filed with PRs #25–27.

## Inherited repository automation, hardened



`.github/workflows/opencode.yml` came from the pre-existing remote root and was
preserved byte-for-byte during history reconciliation. That provenance prevents
silent shared-state deletion; it does not establish safety.

Before 2026-07-26 the public comment trigger began a job with no
repository-owned actor gate: the condition tested only four substrings of the
comment body, so on a public repository with issues enabled — verified
`visibility: "public"`, `has_issues: true` — any authenticated GitHub user could
start a job that minted an OIDC token and passed the named OpenCode secret into
a mutable third-party action. The workflow never fired (`total_count: 0` runs,
all time), so there is no evidence it was exercised, but the exposure was
standing and left no in-repository audit trail.

ADR 0025 resolves the ADR 0010 hold by hardening rather than removal. A
repository-owned `authorize` job now gates on `author_association` of `OWNER`,
`MEMBER`, or `COLLABORATOR` — never `CONTRIBUTOR`, which means a merged pull
request rather than write access — holds no permissions and no secrets, and uses
no third-party code. The privileged job declares `needs: authorize`. Both
actions are pinned to commit SHAs, `share: false` is set, and top-level
`permissions: {}` denies by default. Untrusted comment fields reach a shell only
through `env:`, never through `${{ }}` inside `run:`.
`inheritedWorkflowIsActorGatedAndPinned` in `scripts/security-check.mjs` fails
the gate if any of that regresses.

Two requirements ADR 0010 set are **not** met, so the release hold narrows
rather than lifts: the pinned third-party commit has not been reviewed by this
repository, and `OPENCODE_API_KEY` must be rotated because it was reachable
under the previous condition. Pinning removes the silent-update path; it is not
a review. Causing that unreviewed code to run now requires write access.

| Threat | Boundary | Fails how |
| --- | --- | --- |
| Any internet user triggers privileged automation by commenting | Repository-owned `authorize` job evaluated before any third-party step | Non-collaborator comment skips the gate job, so `needs: authorize` skips the privileged job |
| Mutable third-party action changes what executes with no commit here | Commit-SHA pins on every `uses:` | `inheritedWorkflowIsActorGatedAndPinned` rejects any non-40-hex ref or `@latest` |
| Comment body evaluated as shell in the runner | Untrusted fields passed only via `env:` | Assertion rejects `${{ github.event.comment… }}` inside `run:` |
| Session contents of a public repository shared upstream | `share: false` | Assertion requires the input to be present |
| Pinned third-party code exfiltrates the injected secret | **Unmitigated** — pin is not review | Requires write access to reach; secret rotation and a supply-chain review remain outstanding under ADR 0025 |

## Residual risks

- The controller currently talks to the host's Docker daemon; this is not a
  hostile multi-user boundary. Model/repository data cannot control Docker
  arguments or access its socket inside the container.
- Full-file model output can contain vulnerable code even when path-safe. Human
  review and project tests remain required.
- The accepted interim workspace POST bearer blocks ambient websites, stale
  origins, and accidental stable-origin mutation; it does not isolate hostile
  code already running as the same OS user or trusted browser origin. A
  same-user process that steals the one-time launch URL can act until server
  restart. The workspace must never be proxied or exposed remotely.
  Chromium-family support is a tested product boundary, not authentication by
  browser identity.
- Production currently prints the mutation launch URL rather than owning the
  browser process. Opening that fragment-bearing URL in an unverified browser,
  resolver configuration, or proxy is outside the accepted interim boundary
  and could expose the fragment to nonlocal same-origin content. Until an owned
  Chromium/desktop launch handshake replaces this operator contract, use only a
  real-accepted Chromium-family browser for mutation and use explicit-port
  review-only mode everywhere else.
- A configured loopback model service is trusted only as configured; another
  local process may impersonate it.
- GitHub-hosted automation and third-party installers remain outside the local
  runtime boundary. The inherited OpenCode workflow's upstream late permission
  check is still not the boundary; the repository-owned gate added in ADR 0025
  is. The pinned upstream commit remains unreviewed by this repository.
- No branch is protected — `main` reports `protected: false` — so the hosted CI
  gate is advisory rather than enforced. Tracked separately from ADR 0025.
- Persistence uses synchronous `better-sqlite3` behind the store boundary; a
  future schema version still needs an explicit migration and recovery drill.
- Redaction is defense in depth, not proof that arbitrary repository content has
  no secrets. Provider choice must match the project's privacy class.
- SQLite operation admission defends cooperating planners by allowing only one
  started operation per run. Linux run leases additionally defend approval and
  execution from cooperating Icarus processes and accidental stale state, not an
  attacker with arbitrary same-user write access to `ICARUS_HOME` during a run.
  POSIX owner/mode checks and Windows current-user-profile containment rely on
  the operating system's local account boundary to prevent that access.
- The HTTP server and explicit-port review UI support Linux, macOS, and Windows.
  Mutation-capable import, preview, draft persistence, and
  loopback-planning additionally require a supported Chromium-family browser.
  ADR 0040's exact-head real-Chrome macOS/Windows technical evidence passed at
  `eb01b6406c12126c60add7ac83800f8eba8ffdc9` in native run `30618043377`, and
  explicit human acceptance of the interim operator-controlled
  browser/resolver/proxy residual risk was recorded on 2026-07-31. Gate 1's
  remaining runtime slices are incomplete. No live migration, merge,
  deployment, or public release was authorized or performed as part of this
  acceptance. The server cannot detect or downgrade a browser that fails before
  resolving the random `.localhost` hostname.
- Guarded approval and execution remain Linux-only through `/usr/bin/flock` and
  `/proc`; execution also depends on a local Docker daemon.
- Repository status is an unlocked, point-in-time observation, not proof
  that state remains unchanged. Every later guarded action must revalidate source
  identity, HEAD/base relation, and cleanliness at its own authority boundary.
- Effective Git config is checked before helper-capable commands, but a hostile
  same-user process can change config between the preflight and command. No OS
  no-exec boundary or hostile multi-user isolation is claimed.
- Change Room annotations are operator-entered free text within fixed bounds.
  They are validated and credential-screened before write, but the room presents
  them as untrusted text, never as authority over the run.

## Security non-goals

No claim of hostile multi-user isolation, microVM isolation, production
deployment safety, remote API authentication/authorization, tenant isolation,
portable guarded approval/execution, account security, telemetry security, or
remote worker security is made by Milestone 1 or the first M3 workspace slice.
The second M3 observation slice does not change those non-goals.
