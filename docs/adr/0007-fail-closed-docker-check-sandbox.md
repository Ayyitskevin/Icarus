# ADR 0007: Fail-closed Docker check sandbox

- Status: Accepted
- Date: 2026-07-19

## Context

Git worktrees isolate repository edits, not code execution. A test command runs
newly generated code before human diff review and can otherwise read host
credentials, reach private services, modify shared state, or leave processes.
An executable allowlist or trusted-host warning is consent, not containment.

## Decision

Milestone 1 runs exact operator-owned check profiles only in Docker. The image
must already exist locally and be qualified by manifest digest. Runs use
`--pull=never`, `--network=none`, a non-root user, read-only root filesystem,
all capabilities dropped, no-new-privileges, no host sockets or environment,
read-only tracked-file export, ephemeral `/tmp`, PID/memory/CPU limits, bounded
output, timeout, and explicit descendant cleanup. If runtime, image, seccomp, or
other preflight fails, verification fails; there is no host fallback.

The controller's access to the local Docker daemon is an acknowledged residual
risk and not a hostile multi-user boundary. Repository/model data cannot select
Docker options, mounts, environment, or image.

## Consequences

The first executable fixture must use a preinstalled offline image and checks
that tolerate a read-only workspace. This adds a Docker prerequisite but avoids
shipping a misleading unsafe golden path. Rootless OCI or microVM backends may
supersede this ADR after equivalent adversarial tests. Preview servers and richer
sandbox profiles remain Milestone 4 work.
