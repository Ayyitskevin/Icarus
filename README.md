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

Not yet included: a web UI, arbitrary agent tool use, model-written shell
commands, semantic search, commits or pushes, previews, deployment, backend
platform primitives, multi-agent orchestration, and distributed workers.

## Requirements

- Node.js 22.23 or newer in the Node 22 line
- pnpm 9.15 or newer in the pnpm 9 line
- Git 2.40 or newer
- util-linux `flock` available at `/usr/bin/flock`
- Docker with seccomp support and a locally present digest-pinned check image
- a repository with at least one commit for an agent run

## Quick start

```text
pnpm install --frozen-lockfile
pnpm check
export ICARUS_HOME="${XDG_STATE_HOME:-$HOME/.local/state}/icarus"
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

The state root must be a dedicated, current-user-owned `0700` directory. An
existing root must be empty or already contain Icarus's exact ownership marker;
broad paths such as `/` and `/tmp`, symlink parents, shared/synced directories,
and any path overlapping a registered repository are rejected.

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
