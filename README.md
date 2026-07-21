# Icarus

> Fly high. Know the ceiling. Land safely.

The name comes from the Greek story of Icarus: the product is designed for
ambitious capability with an explicit ceiling and a safe landing path.

Icarus is a local-first, self-hosted, model-agnostic AI software factory. The
current foundation deliberately implements one narrow workflow well: plan one
controlled replacement in an operator-selected tracked text file, obtain human
approval, apply it in a private Git worktree, run operator-registered checks in
a no-network sandbox, present evidence, and retain enough history to review,
resume, roll back, or restore the run.

Icarus is not a chatbot shell, an autonomous production deployer, or a claim
that later roadmap features already exist.

## Current scope

Milestone 0 supplies the product, architecture, security, operations, eval, and
roadmap contracts plus repeatable quality gates. The Milestone 1 slice supplies:

- local repository registration and project metadata;
- deterministic pinned-tree maps and target-applicable `AGENTS.md` context;
- an explicit persisted run state machine;
- Ollama and OpenAI Responses planning adapters;
- explicit cloud-context approval before remote egress;
- a plan-digest approval step before private workspace creation or code mutation;
- an Icarus-private Git cache and detached worktree;
- one bounded exact-match replacement in an existing tracked text file;
- exact operator-registered verification commands in a no-network Docker
  sandbox with no host fallback;
- diff, event, usage, and checkpoint persistence in SQLite;
- run resume, review, rollback, and checkpoint restoration.

Remote preparation reaches its egress gate atomically, successful provider
output containing recognizable credential material is discarded before
persistence, and completion revalidates the live worktree against the reviewed
diff. Before any context artifact, provider request, private Git cache, or
worktree exists, preparation also audits the complete tracked tree within fixed
file and aggregate byte limits and fails closed on credential material.

The first Milestone 3 vertical slice adds a same-origin React workspace and a
loopback-only local API. It can persist a repository/project, preview a
deterministic filtered map of the committed tree, save a task as a draft, ask a
configured loopback Ollama model for a plan, and reopen browser-safe evidence
after restart. The browser is deliberately review-only: it cannot approve a
plan, create a worktree, execute checks, mutate the imported repository, or
claim that unrun work completed.

The second Milestone 3 slice adds project-scoped, nonpersistent repository
observation with independent
availability, worktree, HEAD, branch, and configured-base-relation fields, plus
fixed-size event metadata pages addressed by sequence cursor. It omits dirty
filenames and counts, file content, raw Git output, and event payloads. The
selected run may short-poll only in the visible foreground, with abort, bounded
backoff, request-revision guards, coherent full-run/approval/timeline SQLite
snapshots, an event-cursor freshness guard, and fixed Icarus-generated evidence
anchors. Full browser timelines retain only the 200 most recent metadata rows;
the CLI history contract remains complete. This slice adds no streaming
transport, schema, dependency, or browser authority.

Not yet included: browser approval or execution, arbitrary agent tool use,
model-written shell commands, semantic search, commits or pushes, application
previews, richer file/status, diff, or history navigation, deployment, backend
platform primitives, multi-agent orchestration, and distributed workers.

## Requirements

- Node.js 22.23 or newer in the Node 22 line
- pnpm 9.15 or newer in the pnpm 9 line
- Git 2.40 or newer
- a clean local repository with at least one commit for workspace import

The loopback HTTP/UI, repository import, context preview, draft persistence, and
loopback planning path support Linux, macOS, and Windows and require no homelab,
cloud service, account, telemetry, or global install. Planning is read-only with
respect to the imported checkout and uses an atomic SQLite operation admission
record to reject concurrent provider work. Approval and execution remain
Linux-only: they use the Milestone 1 kernel lease through util-linux `flock` at
`/usr/bin/flock`, and execution additionally requires Docker with seccomp
support and a locally present digest-pinned check image.

## Quick start

```text
pnpm install --frozen-lockfile
pnpm workflow:setup
pnpm check
```

`workflow:setup` is a one-time, checksum-verified bootstrap of the pinned
actionlint release into ignored `.local/` state. The release gate then lints
every GitHub Actions workflow and proves the validator rejects a known-invalid
fixture before running the remaining checks.

Start the local workspace with a dedicated state root:

```text
export ICARUS_HOME="${XDG_STATE_HOME:-$HOME/.local/state}/icarus"
pnpm workspace:start
```

On Windows PowerShell, keep the state beneath the current user profile:

```text
$env:ICARUS_HOME = Join-Path $HOME ".icarus-state"
pnpm workspace:start
```

Open `http://127.0.0.1:8787`. The server binds only to `127.0.0.1`,
validates browser `Host` and `Origin`, and never enables cross-origin
access. Importing and previewing a repository reads its committed Git objects;
it does not copy, edit, check, commit, or push the source. Planning is available
on Linux, macOS, and Windows only when the chosen model is served by loopback
Ollama. Until an endpoint and model are entered, the workspace clearly reports
provider and execution capabilities as `unconfigured`. Saving a configured
draft contacts no provider; the separate plan action does. Approval and
execution continue through the Linux CLI only.

The existing CLI golden path begins with:

```text
node packages/cli/dist/main.js init
node packages/cli/dist/main.js repo add \
  --name fixture \
  --path /absolute/path/to/repository
node packages/cli/dist/main.js project add \
  --name fixture-project \
  --repo fixture \
  --base-ref main \
  --check '{"id":"verify","name":"Verify fixture","argv":["python","checks/verify.py"]}' \
  --sandbox-image 'python:3.12-slim@sha256:c3d81d25b3154142b0b42eb1e61300024426268edeb5b5a26dd7ddf64d9daf28'
```

On POSIX systems, the state root must be a dedicated, current-user-owned `0700`
directory. On Windows, it must be strictly beneath the current user profile and
inherits that profile's ACL; locations outside the profile are rejected. On
every platform, an existing root must be empty or already contain Icarus's exact
marker. Filesystem roots, symlink parents, and any path inside a Git checkout are
rejected before Icarus creates the state root. Project registration separately
rejects repository/state containment in either direction before persisting the
repository or project. Network, shared, and synced directories are unsupported
and must not be used for Icarus state.

Set `ICARUS_CHROMIUM_EXECUTABLE` to an explicit local Chromium binary, then
`pnpm smoke:workspace:browser` builds the production assets and drives the
project → context → draft → browser reload → plan → evidence path in real
headless Chromium.
Focused integration tests also cover restart before planning, useful errors for
malformed provider URLs and missing repositories, and populated HTTP evidence
for an already completed CLI run.

Plan with local Ollama:

```text
node packages/cli/dist/main.js run plan \
  --project fixture-project \
  --task "Replace the greeting and run the registered check" \
  --target src/greeting.txt \
  --provider ollama \
  --model <installed-model>
```

Plan with OpenAI's Responses API:

```text
# Set OPENAI_API_KEY through your shell's secret manager first.
test -n "$OPENAI_API_KEY"
node packages/cli/dist/main.js run plan \
  --project fixture-project \
  --task "Replace the greeting and run the registered check" \
  --target src/greeting.txt \
  --provider openai \
  --model <approved-model> \
  --input-usd-per-million <current-rate> \
  --output-usd-per-million <current-rate>
```

Icarus does not embed model pricing because pricing changes. A remote run with a
cost ceiling requires explicit rates so that the ceiling is enforceable. The
first remote command stops before egress and prints a context digest; continue
only after reviewing it:

```text
node packages/cli/dist/main.js run approve-egress <run-id> \
  --context-sha <displayed-digest> --actor kevin
```

Continue the run with separate operator decisions:

```text
node packages/cli/dist/main.js run approve <run-id> \
  --plan-sha <displayed-digest> --actor kevin
node packages/cli/dist/main.js run status <run-id>
node packages/cli/dist/main.js run review <run-id> \
  --decision approve --diff-sha <displayed-diff-digest> --actor kevin
node packages/cli/dist/main.js run rollback <run-id> \
  --diff-sha <displayed-diff-digest> --actor kevin
node packages/cli/dist/main.js run restore <run-id> \
  --checkpoint-sha <displayed-checkpoint-digest> --actor kevin
```

Use `run list [--project <name>]` to rediscover persisted run IDs and `run
history <run-id>` to inspect the append-only transition and approval record.

Review rejection performs the bounded rollback directly. A later explicit
restore rewrites only the recorded approved bytes and reruns verification.

Provider secrets are read from the process environment and are never stored in
the Icarus database. Credential-prone configuration paths are protected from
model context and edits; safe configuration content may still be included in a
tracked sandbox snapshot. See `docs/OPERATIONS.md` before using a non-fixture
repository.

## Documentation

- [Product requirements](docs/PRD.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Implementation plan](docs/PLANS.md)
- [Decision index](docs/DECISIONS.md)
- [Threat model](docs/THREAT_MODEL.md)
- [Operations](docs/OPERATIONS.md)
- [Evaluation strategy](docs/EVALS.md)
- [Roadmap](docs/ROADMAP.md)
