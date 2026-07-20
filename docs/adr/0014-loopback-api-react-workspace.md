# ADR 0014: Loopback API and review-only React workspace

- Status: Accepted
- Date: 2026-07-20
- Supersedes: [ADR 0006](0006-headless-first-slice.md) only for the bounded local-workspace slice

## Context

The guarded CLI lifecycle now has durable state and adversarial evidence, so a
browser surface can expose real projects, deterministic context metadata,
plans, approval gates, and verification evidence without inventing a second
control plane. A browser also creates Host, Origin, request-size, serialization,
and source-data rendering boundaries that the CLI did not have.

Registration, context preview, draft persistence, and loopback planning create
no private worktree and execute no project code, so this bounded path supports
Linux, macOS, and Windows. SQLite atomically admits one started operation per run
before planning work. Guarded approval and execution remain Linux-specific
because their cooperative run leases use `/usr/bin/flock` and `/proc`; the check
adapter also requires a local Docker daemon. This slice does not add a daemon or
replace the stronger mutating-lifecycle lease protocol described by ADR 0011.

## Decision

Add one Node HTTP package and one React/Vite package. The production HTTP server
binds only to `127.0.0.1`, serves the compiled workspace and JSON API from the
same origin, rejects non-loopback Host and Origin values, accepts only bounded
JSON mutations, emits no CORS permission, and returns allowlisted views rather
than raw domain records.

The API calls the existing application service and SQLite store. It adds no
table and does not change the run state machine. The persisted `preparing`
state is presented as the workspace's `draft` phase while the exact internal
state remains visible. Richer approval and recovery states are never flattened
into success.

The first browser slice is review-only:

- repository registration, project creation, context preview, draft persistence,
  and planning are read-only with respect to the imported source checkout;
- a task is persisted as a draft before planning starts and survives an API
  process restart;
- planning may use only an explicitly configured loopback Ollama endpoint;
- SQLite operation admission rejects concurrent planning before duplicate
  provider work on Linux, macOS, and Windows;
- the browser exposes no plan-approval, edit, check-execution, commit, push, or
  deployment route; guarded approval/execution stay in the Linux CLI;
- missing providers and execution are shown as `unconfigured`, and absent
  checks are shown as `not_run` rather than passed.

Context preview is a separate non-persisted metadata view over the committed
Git tree. It never returns file contents and filters all `.env*` paths,
dependency/generated directories, binary or invalid UTF-8 files, model-hidden
paths, and secret-shaped content. Actual guarded-run context keeps its stricter
full-tree fail-closed audit.

## Consequences

The browser can complete a truthful project → context → draft → plan → evidence
review path against real local state without gaining filesystem-write or shell
authority. Existing completed CLI runs remain inspectable through the same safe
view, including diffs and redacted check output.

Acceptance coverage includes useful malformed-provider-URL and
missing-repository errors without persistence, state-root rejection inside a
Git checkout before any write, populated HTTP evidence for a completed CLI run,
and a production-asset golden path driven through real headless Chromium with a
browser reload before planning.

There is no background job system, terminal streaming, filesystem picker,
provider registry, arbitrary command endpoint, or alternate persistence model.
Planning requests remain synchronous and durable. The HTTP/UI, registration,
preview, draft, and loopback-planning paths support Linux, macOS, and Windows
through portable Node/browser primitives and SQLite operation admission, with
no fleet-specific dependency. Guarded approval and execution are supported only
on Linux and are reported separately; execution retains its Docker boundary. A
persistent daemon, portable guarded approval/execution, or a replacement for
the kernel lease requires a later ADR and dedicated acceptance evidence.
