# Release readiness

Status: review candidate, not a production release.

This record distinguishes the merged M3 observation work from the additional
release-readiness hardening on `sol/icarus-m3-release-readiness`. It does not
complete M3, resolve ADR 0010, establish native-host acceptance, authorize the
approval-index migration against existing state, or add browser action
authority.

## Candidate identity

| Item | Exact value |
| --- | --- |
| Merged baseline | `03c27640ffd0e8a377f2a17e64dc2be987a52409` |
| PR #4 implementation head | `cb3b97f8fc68b0bf451709b2a023031dc10c1177` |
| PR #4 implementation tree | `7697872bbbc921b76be555c6f6b3c1484bce412c` |
| Baseline tree | `7697872bbbc921b76be555c6f6b3c1484bce412c` |
| Release-hardening implementation | `2dd5172dd531a621e21d97c0c72b2ce9edae01f7` |
| Review branch | `sol/icarus-m3-release-readiness` |

PR #4's implementation head and merged baseline have the same tree. The
hardening commit pins the ordinary CI actions to immutable commits, disables
persisted checkout credentials, pins repository text to LF, and adds
adversarial policy, route, proposal, and exact-bound coverage. It adds no
runtime feature, dependency, schema, migration, persistent-state change, model
command, browser approval/execution, product commit/push, deployment, or merge
authority.

## Declared and observed toolchain

| Tool | Declared | Observed locally |
| --- | --- | --- |
| Node.js | `22.23.x`; workflows use `22.23.0` | `v22.23.1` |
| pnpm | `9.15.4` | `9.15.4` |
| Git | repository tool | `2.43.0` |
| Corepack | repository bootstrap | `0.34.6` |
| actionlint | checksum-pinned by repository policy | `1.7.12` |

`pnpm install --frozen-lockfile` and `pnpm workflow:setup` completed before the
fresh gates.

## Fresh local evidence

Run on Linux from a private dedicated worktree at the hardening implementation
commit and the following documentation-only working tree:

| Command | Result |
| --- | --- |
| `pnpm check` | Passed: format 97 files; lint/typecheck passed (26 informational lint notices, 0 errors); unit/provider 177/177; integration 44/44; eval 5 passed, 0 failed, 5 explicitly unsupported; security 133/133 plus 50/50 static assertions; build 23 modules; all 3 workflows linted and the invalid-workflow self-test rejected |
| `pnpm smoke:workspace` | Passed on `127.0.0.1`: run remained `awaiting_approval`, verification `not_run`, one expected provider request, source unchanged |
| `ICARUS_CHROMIUM_EXECUTABLE=/usr/bin/brave-browser pnpm smoke:workspace:browser` | Passed the 50-project catalog, page/bound, cancellation, and stale-response cases with 0 browser errors, 0 blocked external requests, and unchanged source |
| `pnpm audit --audit-level high` | Passed: no known vulnerabilities |
| `pnpm audit --prod --audit-level high` | Passed: no known vulnerabilities |
| `pnpm exec node scripts/native-acceptance-policy.mjs` | Passed local policy only: digest `aa6d95b7dbba583e0b74f397a096d45642fc65b9c7aa4035478bf1b497213fb7`, 3 immutable actions, 12 exact commands, `macos-15` and `windows-2025` |
| `git diff --check` | Passed |

Independent adversarial review reports 0 blocker, 0 high, and 0 medium
findings. Linux policy-path evidence is not a substitute for execution on real
macOS and Windows runners.

## Hosted evidence

The merged observation slices have exact implementation-head hosted evidence:

| Scope | Exact commit | Hosted run |
| --- | --- | --- |
| PR #1 | `77ab4a3809d1d5d4a9841b63be2c2ca54446df3a` | [29863962867](https://github.com/Ayyitskevin/Icarus/actions/runs/29863962867) |
| PR #2 | `52dc67d266f6dd7451eab2d9082e1fc0a993c6f6` | [29871170889](https://github.com/Ayyitskevin/Icarus/actions/runs/29871170889) |
| PR #3 | `10b4dfed65a473b3da8d886bf0e5ed8c4078cd21` | [29934193961](https://github.com/Ayyitskevin/Icarus/actions/runs/29934193961) |
| PR #4 | `cb3b97f8fc68b0bf451709b2a023031dc10c1177` | [29963114892](https://github.com/Ayyitskevin/Icarus/actions/runs/29963114892) |
| Resulting `main` | `03c27640ffd0e8a377f2a17e64dc2be987a52409` | [29964954585](https://github.com/Ayyitskevin/Icarus/actions/runs/29964954585) |

Exact published-head CI for this review branch remains required. Its URL and
conclusion belong in the draft PR and release report after publication so this
file does not create a self-invalidating follow-up commit.

## Held, skipped, and operator-gated work

- `.github/workflows/native-acceptance.yml` is registered on `main` with
  workflow ID `318514643` and SHA-256
  `aa6d95b7dbba583e0b74f397a096d45642fc65b9c7aa4035478bf1b497213fb7`.
  It has zero hosted runs. No dispatch occurred because explicit native-run
  authorization was not provided; ADR 0022 remains Proposed.
- ADR 0010 remains the release security hold. Neither
  `docs/adr/0010-inherited-opencode-workflow-security-hold.md` nor
  `.github/workflows/opencode.yml` was changed or accepted. The workflow's
  retained SHA-256 is
  `e943363f0407e958a7abac650edc9647d3838ebbf3bd2f4133db45df00a251cf`.
- Building `approval-index-v1` against existing non-test state requires a
  verified backup and explicit operator approval. Only synthetic state was
  exercised here.
- Repository `main` currently has no branch-protection rule or ruleset. That is
  an operator governance decision; this branch does not mutate repository
  settings.
- No native dispatch, live migration, main-branch push, merge, release, or
  deployment was performed. Authorized repository publication for this work is
  limited to a draft review branch and draft PR.

## Release decision

The bounded merged observation slices and this branch's hardening are ready for
exact-head hosted review. Full release remains held until ADR 0010 is resolved,
both explicitly authorized native jobs pass at the chosen exact commit, any
live approval-index rollout receives its separate backup and operator gate, and
the operator chooses the repository merge policy. Full M3 remains open.
