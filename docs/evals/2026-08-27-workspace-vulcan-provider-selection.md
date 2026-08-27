# Workspace Vulcan provider selection measurement — 2026-08-27

## Question and boundary

Can an operator create a persisted Vulcan draft from the compiled Workspace
without URL inference, remote-provider access, or a live provider call?

Assumptions checked before implementation:

- the API's persistable Workspace kinds are exactly `ollama | vulcan`;
- omitted kind remains an Ollama compatibility default for older callers;
- Vulcan construction remains credential-free and loopback-only;
- this measurement creates a disposable draft but does not plan or execute it.

## TDD observation

Before production code changed, this command built the app and failed in real
Chromium at `Could not set form field Provider kind`, proving the new
acceptance case reached the missing public UI seam:

```text
ICARUS_CHROMIUM_EXECUTABLE=/home/kevin-lee/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome pnpm smoke:workspace:browser
```

## Real-interface matrix

The final compiled-Chromium case exercised 14 observations through rendered
form controls and the actual local API transport:

| # | Input or observation | Expected and observed result |
| ---: | --- | --- |
| 1 | Initial provider kind and first draft POST | both `ollama` |
| 2 | Provider option values | exactly `ollama`, `vulcan` |
| 3 | Select `vulcan` | selected explicitly |
| 4 | `not-a-url` | create disabled |
| 5 | `https://example.com/v1/` | create disabled |
| 6 | `http://192.168.1.10:8140/v1/` | create disabled |
| 7 | loopback URL with user info | create disabled |
| 8 | loopback URL with query | create disabled |
| 9 | loopback URL with fragment | create disabled |
| 10 | loopback FTP URL | create disabled |
| 11 | `http://localhost:8140/v1/` | create enabled |
| 12 | `http://127.0.0.1:8140/v1/` | create enabled |
| 13 | `http://[::1]:8140/v1/` | create enabled |
| 14 | Submit IPv4 loopback Vulcan draft | POST body, durable run, and rendered evidence all report `vulcan`; provider-call count does not increase |

Rejected inputs produced no `/api/runs` POST. The successful draft produced no
Vulcan generation request, no external browser request, and no browser error.

## Local service observation

Read-only loopback probes observed Vulcan `/healthz` healthy and `/v1/models`
returning its configured alias catalog before implementation. These calls
establish local availability only; they are not Icarus verification evidence
and no chat-completions request was made.

## Result and limits

The full `pnpm check` gate exited 0: 1,224 unit/provider tests, 202 integration
tests, 7 passed and 3 honestly unsupported offline evaluations, 235 security
tests, static security assertions, and the production build. The compiled
Chrome `149.0.7827.55` smoke also exited 0. This supports the supervised
draft-selection claim only. It does not admit Vulcan to headless execution or
Gate 1 live evidence, prove live generation quality, authorize a deployment,
or change any money/metering boundary.
