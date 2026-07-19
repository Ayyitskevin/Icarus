# Operations

## Supported operating mode

Milestone 1 runs on one Linux host as one OS user. It operates only on local
repositories explicitly registered by absolute path. It does not install a
daemon, expose a port, or touch production systems.

Default state layout:

```text
ICARUS_HOME/
  .icarus-state-v1
  icarus.sqlite3{-wal,-shm}
  controller-home/
  artifacts/<run-id>/context.json
  locks/<run-id>.lock
  runs/<run-id>/{git-cache.git,worktree}/
  snapshots/<run-id>/                 # temporary, removed after checks
```

The state root must be dedicated, current-user-owned, mode `0700`, and reached
without a symlink parent. A pre-existing root must be empty or contain the exact
Icarus marker. Broad directories such as `/` and `/tmp` are refused; Icarus
never chmods an unowned/general-purpose root. Do not place state inside a
registered repository or place a repository inside state. Avoid network,
shared, or synced filesystems for SQLite and private worktrees.

## Preflight

1. Confirm the repository is a non-bare, clean Git worktree with at least one
   commit. The configured base ref must resolve to the source HEAD when a run is
   prepared and again before plan approval.
2. Register only offline verification commands that can run against a read-only
   tracked-file export with temporary writes confined to `/tmp`.
3. Choose a provider whose privacy class permits the selected repository.
4. Set credentials only in the process environment or a user-owned secret
   manager; never pass them as CLI arguments.
5. For any non-loopback provider, configure HTTPS and both current token rates.
6. Pull and inspect the exact sandbox image outside a run and configure its
   manifest digest. Icarus uses `--pull=never` and rejects image-declared
   volumes or a daemon without confirmed seccomp.
7. Back up `icarus.sqlite3` and its WAL/SHM companions before upgrading.

## Provider configuration

- Ollama defaults to `http://127.0.0.1:11434`. Plain HTTP is loopback-only.
  LAN, Tailscale, and public endpoints are remote: they require HTTPS, explicit
  pricing, and exact context-egress approval.
- OpenAI defaults to `https://api.openai.com/v1`, reads `OPENAI_API_KEY`, and
  sends `POST /responses` with `store: false`, no tools, and no redirects.
  Remote OpenAI credentials are restricted to `api.openai.com:443`.
- Model identifiers are explicit. Icarus never silently substitutes a model.

## Runbook

- `run list [--project <name>]` rediscovers persisted runs without exposing
  private worktree, cache, context-content, or credential fields.
- `run status <run-id>` shows public state, context provenance, plan, usage,
  diff, and latest verification; private cache/worktree paths are intentionally
  omitted from CLI output.
- `run history <run-id>` shows append-only events and approval records.
- `run approve-egress <run-id> --context-sha <sha> --actor <actor>` binds exact
  remote context release.
- `run approve <run-id> --plan-sha <sha> --actor <actor>` revalidates the source
  and binds the complete plan manifest before workspace creation.
- `run resume <run-id>` is explicit. A started operation without a result is
  first marked interrupted and charged its full runtime/token/cost reservation;
  a fresh retry may then run only if ceilings still permit it.
- `run cancel <run-id> --actor <actor>` first persists a recoverable
  `cancelling` state, reconciles any managed container, restores known baseline
  bytes, and only then records `cancelled`. Resume completes an interrupted
  cancellation.
- `run rollback <run-id> --diff-sha <sha> --actor <actor>` restores baseline
  bytes in the owned worktree and preserves the checkpoint.
- `run restore <run-id> --checkpoint-sha <sha> --actor <actor>` restores exact
  approved bytes, reruns checks, and returns to review.
- `run review <run-id> --decision reject --diff-sha <sha> --actor <actor>`
  performs the same bounded rollback. Review approval uses the same diff digest
  and is refused unless verification passed and the live source/worktree,
  changed-path set, diff, and checkpoint still match the reviewed evidence.

Per-run lock files reject concurrent mutating CLI processes. Icarus never
automatically deletes artifacts, caches, or worktrees. Missing or drifted private
state is preserved for investigation; Milestone 1 has no reconstruction or
cleanup command.

## Backup and recovery

Stop active Icarus CLI processes. Copy `icarus.sqlite3` together with any
`-wal`/`-shm` companions, plus `artifacts/` and `runs/`, to a private backup.
Icarus does not yet provide an integrity-check or restore command. If the
external `sqlite3` utility is available, run `PRAGMA integrity_check` against a
copy; do not imply that an empty journal or successful copy proves integrity.

If a process stops:

1. Run `run status` and `run history`; inspect the last state and operation.
2. Confirm the registered source checkout remains clean and at the pinned HEAD.
3. Use `run resume`; never edit SQLite state manually.
4. If worktree bytes differ from both baseline and approved bytes, stop and
   preserve the tree. Recovery fails closed on unexpected bytes.

## Observability

Events record transition, actor where applicable, bounded/redacted detail, and
timestamps. Operation events expose reservations, interruption, and final
outcome. Verification evidence records exact argv, exit status/signal, duration,
timeout message, truncation, and redacted stdout/stderr. Empty output is never
proof; exit status, containment, changed-path, diff, and checkpoint assertions
are required.

## Upgrade policy

Milestone 1 has schema version 1 and no automated migration against live state.
Back up before upgrades. A schema change needs an ADR, migration tests, and
explicit operator approval before existing state is opened by new code.
