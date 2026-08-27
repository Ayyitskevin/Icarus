# Headless reconstruction v1 golden contract

Date: 2026-08-27

## Scope

This follow-up locks the accepted ordinary
`icarus.headless.reconstruction.v1` fixture to one literal reconstruction
digest. It changes no runtime source, persistence, schema, dependency,
provider call, session admission, continuation authority, or deployment
behavior. Session-boundary evidence remains the explicit v2 protocol.

## Accepted fixture

The existing exported reconstruction projection receives the deterministic
reconciled crash fixture used by the unit suite. Its ordinary-v1 digest is:

```text
5e3d38c1fa35428354e7a2ed8537efc1b3fc686abd98c2c89e8c4f6fa59101e0
```

The literal detects any future change to the fixture's complete v1 payload or
stable-JSON canonicalization. Relative equality across two calls remains useful
for determinism, but no longer suffices to claim byte stability.

## Red/green evidence

With the expected digest deliberately set to 64 zeroes, the focused test loaded
one case and failed at the digest assertion: it received the accepted digest
above. Restoring the accepted literal made the complete reconstruction test
file pass 12 of 12 cases. The earlier fresh-worktree attempt that loaded zero
tests because package outputs were absent is not counted as red evidence; the
Node packages were built and the assertion-level failure was rerun.

## Boundaries retained

- Effectful/control session continuation remains denied.
- Live-provider measurement, deployment, and Icarus live execution remain on
  hold.
- The pre-existing development-only `nanoid@3.3.16` audit advisory is not
  changed or waived by this test-only contract.
