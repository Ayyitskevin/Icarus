# ADR 0039: Portable numeric-loopback mutation origins

- Status: Candidate — implementation and native acceptance pending
- Date: 2026-07-31
- Proposes to supersede in part upon acceptance:
  [ADR 0029](0029-browser-approval-authority.md)'s `.localhost` origin,
  operating-system lookup proof, fixed mutation binding, and corresponding
  origin-acceptance clauses only
- Depends on: [ADR 0022](0022-native-macos-windows-acceptance.md) and
  [ADR 0029](0029-browser-approval-authority.md)
- Related:
  [ADR 0036](0036-proof-carrying-software-factory-product-direction.md)

## Context

ADR 0029 selected a fresh 128-bit `<nonce>.localhost` hostname over a server
bound to `127.0.0.1`. Before emitting a bearer, Node used the operating
system's all-address lookup and required the exact hostname to resolve only to
`127.0.0.1` or `::1`, including the bound IPv4 address.

That design passed Linux and a real Chromium smoke, but exact-head native run
[30611815405](https://github.com/Ayyitskevin/Icarus/actions/runs/30611815405)
failed its real workspace composition on both macOS 15 arm64 and Windows Server
2025 x64. Each host failed the lookup proof, deliberately created a
bearer-free review-only session, and therefore could not execute the portable
mutation flow promised by ADR 0029. Treating lookup failure as success,
synthesizing an answer only inside Node, or injecting a test-only resolver
would not control an arbitrary browser's resolver and would hide the product
defect.

Each browser start must independently select a new origin candidate so a
service worker or other active content from an older origin is overwhelmingly
unlikely to read a new launch fragment. The finite collision risk is explicit
below. The mutation server must remain unreachable off-device, and the
independent bearer plus exact request checks must remain in force.

## Decision

An ordinary mutation-capable start selects three independent bytes with the
operating system CSPRNG, rejecting `0` and `255` for each byte, and constructs
one canonical numeric host:

```text
127.<1..254>.<1..254>.<1..254>
```

Icarus binds the HTTP server to that exact address and asks the operating
system for an ephemeral port. It verifies that `server.address().address`
equals the selected host before it constructs the workspace session or creates
the independent 32-byte bearer. The launch origin is therefore:

```text
http://127.<1..254>.<1..254>.<1..254>:<ephemeral-port>/
```

The entire `127/8` block is IPv4 loopback. A numeric address removes DNS,
search suffixes, name-service configuration, and DNS rebinding from this
origin path. Rejecting edge octets also avoids alternate numeric spellings and
platform-specific network or broadcast treatment. The allowed raw `Host` and
`Origin` values remain the one exact bound origin.

If a platform returns `EADDRNOTAVAIL` or `EINVAL` for the fresh numeric
loopback binding, Icarus creates no bearer and performs one bounded fallback
bind to `127.0.0.1` with an ephemeral port in review-only mode. Any other bind
error remains loud. An explicit `ICARUS_PORT` remains an exact
`127.0.0.1:<port>` review-only start and never falls back to another configured
port.

ADR 0029's remaining controls are unchanged:

- a separate 32-byte canonical base64url bearer appears only in the launch
  fragment and server memory;
- the synchronous client bootstrap moves it only to `sessionStorage` and
  strips the fragment before render;
- every POST is authenticated before routing, body parsing, or service work
  and requires exact raw Host, Origin, authorization, content type, and action
  header cardinality;
- GETs are tokenless, no CORS permission is emitted, CSP disables workers and
  manifests, and stable/fallback sessions are GET-only; and
- guarded approval, execution, and landing authority remain absent until their
  accepted ledgers, recovery, and shutdown-settlement contracts are
  implemented.

## Security trade-off

The host contributes `log2(254^3)`, approximately 23.97 bits, rather than ADR
0029's 128-bit hostname label. The ephemeral port expands the practical origin
space, but this decision does not claim that a kernel chooses ports randomly.
An exact reuse of both a former host and former port could expose a new
fragment to hostile active content retained at that old origin.

This is a deliberate portability trade-off, not an equivalence claim. The
independent 256-bit bearer still protects requests when no stale same-origin
content can read it. A future owned desktop shell should replace this browser
compatibility boundary with a non-reusable application origin or an
equivalently strong platform mechanism. Until then, every Icarus start must
draw a new host candidate, request an ephemeral port, forbid workers, and test
the selection algorithm, observed restart behavior, old-bearer refusal, and
token nonleakage. Neither the finite random host nor the kernel-selected port
is claimed never to repeat.

## Required acceptance evidence

This decision remains a candidate until one exact commit has all of:

1. the complete Linux `pnpm check` gate;
2. source-preserving workspace and real Chromium browser smokes;
3. security assertions proving exact numeric-loopback bind, no wildcard bind,
   post-bind bearer creation, stable/fallback review-only behavior, exact
   request checks, and no bearer persistence or response leakage;
4. deterministic entropy tests proving distinct host and bearer inputs produce
   distinct sessions, plus restart evidence that an old bearer cannot mutate
   the newly started session;
5. the existing manually dispatched native acceptance workflow passing its
   real bind, fetch, project registration, context preview, draft, plan,
   persistence, and source-unchanged composition on both macOS 15 arm64 and
   Windows Server 2025 x64 at that exact commit.

If either native host cannot bind and use a random numeric address from
`127/8`, portable mutation remains held. Tests must not inject a resolver or
accept review-only as a substitute. The next design must own the browser or
desktop resolver boundary explicitly.

## Consequences

The portable composition no longer depends on inconsistent wildcard
`.localhost` support. Startup output now reports the exact selected numeric
loopback binding. Existing API and client request shapes do not change.

Until this candidate is accepted, ADR 0029 remains authoritative. Upon
acceptance, ADR 0029 remains authoritative for browser bearer handling,
request authentication, guarded-action fencing, action-ledger recovery, and
all other clauses not explicitly superseded here.
