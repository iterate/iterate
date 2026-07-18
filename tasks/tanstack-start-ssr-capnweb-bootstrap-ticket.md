---
state: todo
priority: medium
size: medium
dependsOn: []
---

# Mint Cap'n Web authentication tickets during TanStack Start SSR

## Context

Today a browser explicitly authenticates its Cap'n Web socket from the
exact-origin HTTP-only cookie. Replace that bootstrap credential with a
short-lived, one-time ticket minted while TanStack Start renders the already
authenticated document. Hydration can then open `/api` and call
`authenticate({ type: "ticket", ticket })` without an extra HTTP request. The
same mechanism should work for `apps/os` and project userspace apps.

## Proposed flow

1. Server-only request code mints a ticket bound to the auth app, browser
   session, exact origin, and `/api` audience.
2. The private, non-cacheable SSR payload carries it to hydration.
3. `authenticate({ type: "ticket", ticket })` atomically consumes it and
   returns the same app-defined session capability as other bootstrap methods.
4. Reconnects obtain a fresh ticket through a documented same-origin path.

## Security invariants

- Mint only behind a TanStack server-only request boundary; ordinary loaders
  are isomorphic.
- Tickets are cryptographically strong, short-lived, single-use grants bound
  to the app, session, exact origin, and audience.
- The SSR response is private and non-cacheable. Tickets never enter URLs,
  reusable loader/prefetch caches, logs, traces, analytics, errors, or
  persisted client state.
- A ticket is JavaScript-visible by design. Treat XSS prevention and CSP as
  part of the boundary, and keep the long-lived session cookie HTTP-only.
- Failed, expired, replayed, wrong-origin, and wrong-audience redemption are
  explicit authentication outcomes rather than generic transport failures.

## Acceptance criteria

- [ ] One server-only ticket lets hydration authenticate `/api` with no extra
      HTTP request and returns the ordinary app-session capability.
- [ ] Replay, expiry, wrong app/origin/audience, and revoked sessions fail
      deterministically.
- [ ] Tests prove atomic consumption and absence from caches, URLs, and
      telemetry.
- [ ] Reconnection has a documented fresh-ticket path.
- [ ] Prove one userspace app before migrating `apps/os` from
      `from-server-cookie`.

## Non-goals

- The userspace Cap'n Web/LiveState runtime and React client APIs.
- Serializing an RPC stub into SSR output.
- Removing exact-origin cookie bootstrap before ticket reconnects are
  production-proven.
