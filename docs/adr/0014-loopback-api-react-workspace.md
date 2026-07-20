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

The existing guarded planner and executor remain Linux-specific because their
cooperative run leases use `/usr/bin/flock` and `/proc`; the check adapter also
requires a local Docker daemon. This slice does not claim that guarded planning
or execution is portable, add a daemon, or replace the lease protocol described
by ADR 0011.

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

- repository registration, project creation, and context preview are read-only
  with respect to the imported source checkout;
- a task is persisted as a draft before planning starts;
- planning may use only an explicitly configured loopback Ollama endpoint;
- the browser exposes no plan-approval, edit, check-execution, commit, push, or
  deployment route;
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

There is no background job system, terminal streaming, filesystem picker,
provider registry, arbitrary command endpoint, or alternate persistence model.
Planning requests remain synchronous and durable. The HTTP/UI, import, preview,
and draft-inspection paths use portable Node/browser primitives and no
fleet-specific dependency, but guarded planning and execution are supported
only on Linux and are reported separately. Windows/macOS planning or execution,
a persistent daemon, or a new lease mechanism requires a later ADR and
dedicated acceptance evidence.
