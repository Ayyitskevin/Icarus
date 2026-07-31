# ADR 0040: Chromium-resolved `.localhost` mutation origins

- Status: Accepted — exact-head technical evidence is complete at
  `eb01b6406c12126c60add7ac83800f8eba8ffdc9`; explicit human acceptance of
  the interim operator-controlled browser/resolver/proxy residual risk was
  recorded on 2026-07-31
- Date: 2026-07-31
- Supersedes in part:
  [ADR 0029](0029-browser-approval-authority.md)'s operating-system lookup
  proof, arbitrary-browser portability claim, and corresponding
  origin-acceptance clauses only
- Depends on: [ADR 0022](0022-native-macos-windows-acceptance.md) and
  [ADR 0029](0029-browser-approval-authority.md)
- Follows rejected:
  [ADR 0039](0039-portable-numeric-loopback-origins.md)
- Related:
  [ADR 0036](0036-proof-carrying-software-factory-product-direction.md)

## Context

ADR 0029 chose a fresh 128-bit `<nonce>.localhost` public origin over an HTTP
server bound to exact `127.0.0.1`. It required Node to prove the hostname
through the operating system's resolver before creating a bearer. Exact-head
native run
[30611815405](https://github.com/Ayyitskevin/Icarus/actions/runs/30611815405)
showed that this host-side proof fails on both macOS 15 arm64 and Windows Server
2025 x64 even though a browser may implement the reserved `.localhost` name
itself.

ADR 0039 then tested a DNS-free random numeric address inside `127/8`.
Exact-head native run
[30613980911](https://github.com/Ayyitskevin/Icarus/actions/runs/30613980911)
passed on Windows Server 2025 x64 but failed on macOS 15 arm64 when the selected
address could not bind. That result rejects random numeric `127/8` as the
portable mutation origin.

The product does not need to claim that every installed browser can resolve a
random `.localhost` hostname. Gate 1 can instead support mutation in a tested
Chromium-family browser while retaining an explicit, stable, bearer-free
`127.0.0.1` review mode for Safari and every unverified browser. The server
cannot securely infer browser family from a request, and a browser that cannot
resolve the hostname sends no request at all. This is therefore an operator and
release support contract, not a `User-Agent` authorization rule or an automatic
downgrade.

## Decision

### Fresh public origin, fixed socket bind

An ordinary mutation-capable start asks the operating system for an ephemeral
port while binding the server only to exact IPv4 `127.0.0.1`. Icarus verifies
that the observed server address is exact `127.0.0.1` with an IPv4 family.
Only then does it generate exactly 16 bytes with the operating-system CSPRNG,
canonically encode them as 32 lowercase hexadecimal characters, construct the
workspace session, and create the independent 32-byte bearer.

The socket and public browser origin are deliberately different:

```text
socket bind:   127.0.0.1:<ephemeral-port>
public origin: http://<32-lowercase-hex-origin-nonce>.localhost:<ephemeral-port>/
```

The exact public hostname and port are the only allowed raw `Host` and `Origin`
for that session. The server performs no `dns.lookup`, resolver injection,
hosts-file edit, or other Node/operating-system name-resolution proof. It does
not add Chromium `--host-resolver-rules` or an equivalent resolver override.
Supported Chromium-family browsers must resolve the reserved `.localhost`
hostname through their own built-in behavior.

Each ordinary start independently rotates both the 16-byte origin nonce and the
32-byte bearer. The bearer appears only in the one-time launch fragment and
server memory:

```text
http://<32-lowercase-hex-origin-nonce>.localhost:<port>/#icarus-action-session=<token>
```

ADR 0029's fragment bootstrap, `sessionStorage`, immediate fragment removal,
exact request authentication, no-CORS policy, worker/manifest prohibition,
token non-persistence, restart rotation, and guarded-action fencing remain
unchanged.

### Browser-family support boundary

Mutation support is limited to Chromium-family versions covered by Icarus's
real-browser acceptance. The ordinary start emits the fresh mutation URL for
the operator to open in a supported Chromium-family browser. Browser identity
is not authority: the server neither accepts nor rejects a mutation by
`User-Agent`, and successful requests still require the exact origin, bearer,
headers, and body contract.

Safari, Firefox until separately accepted, embedded webviews, and any
unverified/default browser are outside the mutation support contract. Operators
using them must deliberately start an explicit stable port and use:

```text
http://127.0.0.1:<configured-port>/
```

That explicit-port session creates no bearer, is strictly review-only, and
rejects every non-`GET`/`HEAD` request. Icarus does not claim that an unsupported
browser can load the random `.localhost` URL, detect such a failure, or
automatically convert an already-started mutation session into review-only
mode.

Production does not yet own or attest the browser process. Opening the
fragment-bearing launch URL in an unverified browser, resolver configuration,
or proxy is outside this accepted interim boundary and could expose the
fragment to nonlocal same-origin content. Explicit human acceptance of this
residual risk was recorded on 2026-07-31. A later owned Chromium or desktop
attach/start handshake should replace the operator-enforced browser boundary.

### Interim topology

This decision is an interim Gate 1 browser boundary. It adds no owned desktop
shell, VS Code extension host, Code-OSS fork, custom resolver, daemon, remote
API, or browser-installation manager. The owned VS Code workbench and secure
attach/start handshake remain Gate 3 work. A later accepted desktop topology
may replace this browser support boundary without weakening the request,
authority, recovery, or evidence contracts.

## Required technical acceptance evidence

Before this ADR may be accepted, one exact commit must have all of:

1. the complete Linux `pnpm check` gate;
2. source-preserving API and production-asset browser smokes in a real
   supported Chromium-family binary;
3. static and runtime assertions proving exact `127.0.0.1` IPv4 binding,
   post-bind nonce and bearer creation, 16-byte lowercase-hex origin encoding,
   no wildcard bind, no Node/operating-system lookup, no hosts-file or browser
   resolver injection, no CORS grant, and no bearer persistence, response, or
   log leakage;
4. request negatives for wrong, missing, duplicated, stale, cross-origin, and
   stable-origin credentials and headers, plus restart evidence that an old
   bearer cannot mutate a new session;
5. an explicit-port `127.0.0.1` session proving bearer-free review-only behavior
   and refusal of every non-`GET`/`HEAD` request;
6. a real Chrome run that navigates the exact random `.localhost` public origin,
   mounts the compiled React application, removes the fragment, survives reload,
   and completes protected project registration, context preview, draft
   persistence, planning, and truthful evidence without changing the source
   checkout; and
7. the manually dispatched native acceptance workflow passing that same real
   Chrome composition at the exact commit on both macOS 15 arm64 and Windows
   Server 2025 x64. Plain Node HTTP clients, an injected resolver, a hosts-file
   edit, review-only fallback, or a mocked browser do not satisfy this item.

The acceptance record must name the exact Chrome binary/version selected on
each native host and link the exact-head workflow run. Passing on only one
native host rejects the portability claim rather than narrowing the evidence
silently.

## Technical evidence record

Exact implementation commit
`eb01b6406c12126c60add7ac83800f8eba8ffdc9` satisfies that technical gate:

- Linux CI
  [30618041483](https://github.com/Ayyitskevin/Icarus/actions/runs/30618041483)
  passed the complete deterministic release gate at that exact head.
- Native acceptance
  [30618043377](https://github.com/Ayyitskevin/Icarus/actions/runs/30618043377)
  passed both macOS 15 arm64 and Windows Server 2025 x64 at the same head.
- macOS used
  `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`; Windows used
  `C:\Program Files\Google\Chrome\Application\chrome.exe`. Both reported
  `Chrome/150.0.7871.187` and CDP protocol `1.3`.
- Both browser compositions navigated an independently generated random
  `.localhost` origin without resolver injection, stripped the fragment before
  render, survived reload, completed seven protected POSTs through planning,
  stopped truthfully at `awaiting_approval`, emitted zero browser errors and
  zero external requests, and left the source checkout unchanged.

These results complete the technical evidence. Production still prints the
fragment-bearing URL and does not own or attest the browser, resolver
configuration, or proxy. On 2026-07-31, the human operator explicitly accepted
that residual risk for this interim contract.

Acceptance records the browser/resolver/proxy risk decision only. Gate 1's
remaining runtime slices are incomplete. No live migration, merge, deployment,
or public release was authorized or performed as part of this acceptance.

## Consequences

Icarus retains a 128-bit per-start hostname origin without depending on Node's
inconsistent view of `.localhost` or on non-portable random `127/8` binding.
The cost is an explicit browser-family support boundary: review-only browsing
remains broadly available through a stable numeric origin, while mutation is
supported only where real Chromium acceptance says it works.

ADR 0040 now supersedes only ADR 0029's operating-system lookup proof,
arbitrary-browser portability claim, and corresponding origin-acceptance
clauses. ADR 0029 remains authoritative for bearer handling, HTTP
authentication, guarded-action fencing, action-ledger recovery, shutdown
settlement, and every clause not explicitly superseded here.
