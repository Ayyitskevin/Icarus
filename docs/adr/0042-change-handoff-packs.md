# ADR 0042: Change Handoff Packs are redacted evidence capsules, not Change Room replicas or cross-system authority

- Status: Proposed
- Date: 2026-08-01
- Extends: [ADR 0041](0041-change-rooms-evidence-projections.md)
- Related: [ADR 0002](0002-sqlite-event-history.md),
  [ADR 0005](0005-deterministic-untrusted-context.md),
  [ADR 0013](0013-pre-egress-full-tree-credential-audit.md),
  [ADR 0026](0026-agent-session-loop-and-tool-registry.md),
  [ADR 0027](0027-git-landing-authority.md),
  [ADR 0029](0029-browser-approval-authority.md),
  [ADR 0036](0036-proof-carrying-software-factory-product-direction.md)

## Context

ADR 0041 makes a Change Room a deterministic local review projection over an
Icarus run. That projection is intentionally rich enough for an operator to
inspect bounded task, plan, PatchSet, diff, check, approval, checkpoint,
recovery, event, and annotation evidence. Its disclosure boundary is local
Icarus review. It is not an external interchange format.

A future Athena Task Room needs a much narrower record that a guarded change
occurred and reached a particular local lifecycle outcome. Reusing
`icarus.change-room.v1` would turn locally reviewable evidence into an accidental
cross-system disclosure contract. It would expose or invite future exposure of
task text, source paths, diffs, command output, plan rationale, annotations, and
other evidence that Athena does not need. It would also make a valid evidence
document look like authority to approve or execute work.

Icarus therefore needs a standalone, local-first publication artifact. The
operator may preview it, explicitly export it to owner-controlled files, and
verify or inspect those files offline. This milestone ends at that filesystem
boundary. It does not deliver the artifact, contact Athena, or define the final
shared `constellation.event.v1` protocol.

## Decision

### A Handoff Pack is a separate default-deny contract

The exported payload schema is `icarus.change-handoff.v1`. It is owned by
Icarus and assembled directly from validated authoritative Icarus records. The
serializer starts from an empty object and writes only the fields below. It must
not serialize, spread, filter, or reuse a Change Room, a full run record, an
event, an annotation, a provider plan, or any other broader domain object.

The payload may contain only:

1. its schema and version;
2. a deterministic opaque handoff ID and the Icarus run ID;
3. an operator-supplied correlation ID and an optional opaque external task
   reference;
4. opaque project and run identifiers;
5. exact run state and a host-derived phase;
6. provider kind, model, locality, and privacy class;
7. safe lifecycle status metadata: context-egress state, plan-approval state,
   verification outcome, review decision, rollback status, restoration status,
   and host-derived terminal reason;
8. fixed host-templated summary statements that contain no task, code, path,
   command, actor, annotation, provider-plan, or free-form evidence text;
9. bounded counts where they help explain completeness, never the member values
   being counted;
10. artifact references containing only their schema, version, fixed type, and
    SHA-256 digest;
11. one fixed disclosure classification defined by the schema;
12. the exact integrity statement below; and
13. explicit fixed-category omission and bounded uncertainty fields.

The integrity statement is part of every payload and is not configurable:

> Digests prove byte binding and recorded local evidence integrity only. They
> do not establish fresh authorization, semantic correctness, evidence truth,
> disclosure permission, or permission to execute/land code.

Correlation IDs are opaque coordination labels, not identities or authority.
The correlation ID must match
`[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`. The optional external task reference uses
the same alphabet and is at most 256 bytes. Whitespace, controls, slashes,
backslashes, URL syntax, path syntax, and recognizable credential material fail
closed. The optional value has no receiver, URL, or routing semantics. Every
provider model must independently match the correlation ID's safe-token syntax
and 1–128-byte bound. Every other payload string is a closed enum, a validated
opaque identifier, a canonical digest, or fixed host copy. If an otherwise
allowed record cannot be
represented within those bounds, preview and export refuse it rather than
truncate, redact, or guess.

The payload never contains:

- raw task text;
- provider plan summary, steps, risks, rationale, capability grants, prompts,
  or response material;
- repository maps, context manifests, source content, source or changed-path
  names, PatchSet or checkpoint bytes, diff text, or patch bytes;
- registered check commands, `argv`, stdout, stderr, output fragments, or
  sandbox configuration;
- operator annotation text or actors;
- event payloads or payload-bearing history;
- local state, cache, worktree, repository, artifact, or output paths;
- URLs, destinations, credentials, tokens, keys, bearer values, headers, or
  environment values;
- raw research or code artifacts; or
- a command, tool call, approval instruction, retry instruction, delivery
  instruction, or any other executable action.

No clock, timestamp, random nonce, local pathname, or transport destination
participates in the canonical payload. Given the same validated records and
operator inputs, preview and export produce byte-identical payload bytes and the
same deterministic handoff ID.

### Canonical bytes and two distinct digests

The payload is strict canonical JSON with fixed member order, exact keys, no
duplicate members, and exactly one trailing newline. The payload SHA-256 binds
those complete newline-terminated bytes.

Preview also reports a separate request/preview digest. That digest binds a
versioned preview request, the run ID, the validated correlation values, the
payload schema, the complete payload SHA-256, and every authoritative input or
snapshot revision the projection relied on. It is the optimistic-concurrency
token for export. It is not interchangeable with the payload SHA-256 and is not
an approval. A digest-bound input changing between preview and export makes the
expected preview digest stale even if a displayed summary would otherwise look
the same.

### Preview is a pure read

The CLI preview is substantially:

```text
icarus run handoff-preview RUN_ID \
  --correlation-id CORRELATION_ID \
  --external-task-ref OPAQUE_REFERENCE
```

It opens Icarus state through a read-only, non-migrating path and performs zero
network I/O, credential reads, database writes, repository writes, cache or
worktree writes, temporary snapshot writes, and artifact publication. The
reader fingerprints the database family, refuses non-empty WAL evidence,
captures stable main-database bytes in memory, normalizes only that private
buffer for rollback-journal reads, opens it query-only, and re-fingerprints the
source. It never SQLite-opens the source path. This intentionally returns
`RUN_BUSY` until an ordinary writer cleanly closes/checkpoints rather than
risking source-side SQLite writes or omitting committed WAL truth.

Preview emits the exact canonical payload that export would write, the payload
SHA-256, the separate request/preview digest, and a fixed list of every omitted
evidence category. It fails closed on an unknown, corrupt, internally
inconsistent, unsafe, or unrepresentable run. It never repairs state as a side
effect of preview.

V1 preserves the legacy uncharged completion path, but intentionally refuses a
repaired legacy run whose durable ledger cannot prove the current
`report_done`/session-completion relationship. Such a run is unrepresentable,
not guessed into a successful lifecycle outcome; it must be reviewed in the
original Icarus state rather than weakened for export compatibility.

### Export is explicit publication to two fixed local files

The CLI export is substantially:

```text
icarus run handoff-export RUN_ID \
  --correlation-id CORRELATION_ID \
  --external-task-ref OPAQUE_REFERENCE \
  --expected-preview-sha256 PREVIEW_DIGEST \
  --output-dir ./icarus-handoff
```

Export reopens and revalidates the local evidence, regenerates the canonical
payload, and recomputes the request/preview digest before creating a file. Any
input drift, corruption, unsafe value, or digest mismatch refuses publication.
The output directory is operator-selected, but the filenames are fixed:

- `icarus-change-handoff.json`
- `icarus-change-handoff-result.json`

The selected parent directory must be owned by the current user and must not be
group- or other-writable; an existing output directory must be mode `0700`.
Both outputs are owner-only regular files. Export uses descriptor-relative,
no-follow, exclusive creation; refuses symlinks, hardlinks, special files, path
races, and pre-existing destinations; never overwrites; writes the payload
first and the result second; and `fsync`s each completed file, the output
directory, and its parent after directory creation and before reported success.
Failure removes only partial files created by that exact attempt when their
still-open descriptor and current path identify the same inode. It never alters
a destination that existed before the attempt, and may leave a newly created
empty directory rather than risk path-racy removal.

The secure source reader, export writer, and file-only reader are Linux-only in
v1. Platform and descriptor-root/no-follow capability checks fail closed before
source or handoff file access and, for export, before output-directory creation.
macOS and Windows support would require a separate ACL-aware implementation and
matching native evidence; none is claimed by this candidate.

The result file has exactly `exportStatus`, `previewSha256`, `outputSchema`,
and `payloadSha256`. The last member is the SHA-256 of the
complete newline-terminated handoff payload. The result contains no path,
destination, run evidence, delivery state, timestamp, retry state, or receiver
information. Export creates no outbox, delivery ledger, callback record,
lifecycle event, or secondary workflow state.

### Verification and inspection are file-only

The file commands are substantially:

```text
icarus handoff verify --input ./icarus-change-handoff.json
icarus handoff inspect --input ./icarus-change-handoff.json
```

On Linux, they open exactly the supplied file with the same hostile-file
defenses used by other Icarus evidence reads. Other platforms fail closed before
file access. They accept only a bounded owner-controlled regular
file, enforce the byte and nesting ceilings before parsing, reject duplicate
members, require the exact schema and shape, require canonical JSON plus one
trailing newline, and apply the documented SHA-256 semantics. Unknown or extra
fields fail closed.

Beyond the supplied payload and its fixed-name sibling result, neither command
opens the Icarus database, repository, cache, worktree, credential store,
provider, browser server, Git controller, or network.
`inspect` prints only the same allowlisted safe fields and fixed caveats; it
cannot reveal an omitted category. `verify` proves internal shape,
canonicalization, and byte consistency only. Neither command proves who created
the file, whether its evidence is true, whether disclosure was authorized, or
whether any action is permitted.

### Integrity, authenticity, authorization, truth, and execution are distinct

- **Payload integrity** means a SHA-256 value binds the exact canonical payload
  bytes.
- **Recorded local evidence integrity** means an artifact digest binds bytes
  that Icarus recorded locally. It is not a fresh rehash of every underlying
  source.
- **Confidentiality** is not provided by an unkeyed SHA-256 reference. A digest
  does not reveal its preimage directly, but it can confirm a correct guess for
  low-entropy evidence; omission must not be described as proof of secrecy or
  non-inference.
- **Authenticity** would establish who produced or supplied an artifact. This
  milestone defines no signature, remote identity, or receiver authentication.
- **Authorization** is a fresh policy decision at the system performing an
  action. A Handoff Pack carries none.
- **Truth and semantic correctness** require review of the underlying evidence
  and real-world result. A digest cannot establish them.
- **Disclosure permission** is the operator's explicit decision to export this
  narrow artifact. A valid artifact does not authorize onward disclosure.
- **Execution authority** remains in Icarus's existing guarded lifecycle and
  later separately accepted landing/deployment contracts. The pack grants none.

Export is therefore a local disclosure action, not approval of egress, plan,
review, rollback, restoration, Git landing, deployment, or any receiver-side
operation.

### The future Athena seam is one-way and evidence-only

A later, separately accepted Athena integration may import a Handoff Pack into
a `constellation.event.v1` Task Room timeline record. This ADR does not freeze
that protocol's field names or implement the mapping. The conceptual mapping is
limited to:

| Icarus evidence | Future imported timeline meaning |
| --- | --- |
| handoff schema | source evidence schema |
| SHA-256 of the complete handoff payload | imported evidence digest |
| Icarus run ID | opaque source-run reference |
| correlation ID | opaque correlation reference |
| normalized safe lifecycle outcome | evidence-only lifecycle outcome |
| disclosure class | imported disclosure class |

No other Handoff Pack member maps into the future event. In particular, the
handoff ID, project ID, optional external task reference, provider details,
counts, artifact references, summaries, omissions, and uncertainty remain
outside the Athena event mapping. Athena must not copy or request Icarus-local
evidence merely because it has the digest.

The future import direction is Icarus artifact to Athena evidence. No Athena
response, acknowledgment, callback, comment, or state transition becomes
Icarus input. A receiver must not use a valid pack to create an Icarus run,
approve egress or a plan, approve or reject review, approve rollback or
restoration, authorize Git landing or deployment, inspect Icarus-local evidence,
infer code/task/path/check contents, or trigger Minerva or any other system.

### Explicit non-goals for this slice

No Athena client or server; no `constellation.event.v1` runtime type; no HTTP,
webhook, callback, relay, message bus, chat surface, room membership, shared
runtime package, remote actor authentication, service credential, receiver
authorization, delivery state, outbox, queue, retry, background worker, automatic
Task Room creation, API route, browser control, provider call, Git action,
landing flow, deployment, new lifecycle event, or workflow state. There is no
signature or claim of artifact authenticity. There is no automatic export and
no reuse of a Change Room as an external payload.

## Consequences

The external artifact is intentionally less informative than the local Change
Room. An operator who needs task, path, diff, command, check-output, plan, event,
annotation, or checkpoint detail must inspect it inside Icarus. Athena can later
show that a safe lifecycle outcome was imported and bind that statement to an
exact artifact digest, but it cannot reconstruct the change or operate Icarus.

The separate preview digest gives the operator a review-then-publish boundary
without persisting a draft or delivery workflow. Exclusive, no-follow local
publication is more cumbersome than writing an arbitrary path, but it makes
overwrite and pathname-race failures loud and recoverable.

The absence of signatures and transport identity is deliberate and must remain
visible. A future authenticated receiver or shared event protocol needs its own
ADR, threat model, credentials and rotation policy, replay/idempotency model,
operator experience, and evidence. It cannot silently widen this artifact.

Acceptance requires deterministic preview/export equality, preview purity,
strict correlation validation, sensitive-value non-disclosure, stale-preview
refusal, corrupt-run refusal, byte-for-byte canonicalization, hostile-file and
duplicate/malformed/oversized rejection, no-overwrite and partial-cleanup
evidence, result-hash verification, database-independent file verification,
and strict operation-ledger reconciliation. That reconciliation must reject
missing or contradictory starts/terminals/rows, invalid reservations/status or
usage, stale repair-epoch revision credit, non-mutation intent laundering,
out-of-operation repair checkpoints, apply/proposal relabeling, duplicate or
disagreeing row/event discriminators, failed proposals carrying any patch
effect, unbound or wrong-status session verification, a forged passing
apply/reconcile outcome, and a missing atomic successor, while accepting valid
zero-turn exhaustion, zero-effect advisory proposals, failed/cancelled apply
with immediate unavailable evidence, and interrupted apply reconciliation
followed by real checks. Static proof must show that no
API/browser/provider/Git/landing/workflow state was added. The existing Change
Room fixed-card, replay, GET-only, annotation non-authority, and redaction suites
must remain green. Status remains Proposed until fresh local gates, independent
review, merge, and exact published-head hosted CI are recorded; this decision
does not accept ADR 0041 or complete M3 or Gate 1.
