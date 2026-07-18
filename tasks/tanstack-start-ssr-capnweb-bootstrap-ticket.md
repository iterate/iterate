---
state: todo
priority: medium
size: medium
dependsOn: []
---

# Mint Cap'n Web authentication tickets during TanStack Start SSR

## Context

The browser Cap'n Web client should authenticate in-band and receive an
application-specific `RpcTarget`. A one-time bootstrap ticket is a cleaner
credential than asking a WebSocket handler to treat its ambient cookie header
as authority, but minting that ticket with a separate client-side HTTP POST adds
an avoidable round trip during initial page load.

TanStack Start is already rendering an authenticated document request on the
server. That request can exchange the HTTP-only application session cookie for
a one-time Cap'n Web bootstrap ticket and serialize the ticket into the
request's SSR payload. Hydration can immediately open `/api` and call
`publicApi.authenticate({ type: "ticket", ticket })` without another HTTP
request.

This applies both to `apps/os` and to project userspace applications. It is a
credential-delivery optimization, not the userspace Cap'n Web/LiveState runtime
itself, so it should follow that runtime rather than block its design.

## Proposed flow

1. TanStack Start receives an authenticated document request.
2. Server-only request code mints a short-lived, single-use ticket bound to the
   auth application, browser session, expected origin, and intended `/api`
   audience.
3. The SSR result includes the ticket in the hydration data for this response
   only. It must never enter a reusable loader cache, CDN cache, persisted
   client cache, URL, log, or error report.
4. The hydrated client opens the Cap'n Web WebSocket and calls
   `authenticate({ type: "ticket", ticket })`.
5. Successful redemption atomically consumes the ticket and returns the
   application-defined authenticated session capability.
6. Reconnects obtain a fresh ticket. They may use a same-origin server function
   or POST because no new document SSR request necessarily occurs.

## Security invariants

- Ticket minting is server-only. TanStack Start loaders are isomorphic by
  default, so use a server-only function/request boundary rather than putting
  cookie or signing logic directly in an ordinary loader.
- Tickets are cryptographically random opaque values or equivalently strong
  one-time grants, expire quickly, and are consumed atomically.
- Bind each ticket to the auth application, session, exact origin, and API
  audience. Consider binding it to a connection challenge if replay across two
  simultaneously opened sockets matters.
- The HTML/SSR response carrying a ticket is private and non-cacheable. No
  static generation, shared response cache, prefetch cache, or stale loader
  reuse may replay it to another request.
- Never put a ticket in a query string, redirect fragment, analytics event,
  trace attribute, or structured error.
- A ticket is JavaScript-visible by design. Treat XSS prevention and CSP as
  part of the boundary, and keep the long-lived session cookie HTTP-only.
- Failed, expired, replayed, wrong-origin, and wrong-audience redemption are
  explicit authentication outcomes rather than generic transport failures.

## Acceptance criteria

- [ ] An authenticated TanStack Start document render mints exactly one
      bootstrap ticket using server-only request code.
- [ ] Hydration can authenticate the first `/api` Cap'n Web connection without
      an additional HTTP request.
- [ ] Ticket redemption returns the same application-specific session
      capability shape used by non-SSR clients.
- [ ] A second redemption of the same ticket fails deterministically.
- [ ] Expired, wrong-origin, wrong-application, and wrong-audience tickets fail
      deterministically.
- [ ] SSR responses containing tickets are proven private/non-cacheable and the
      ticket is absent from URLs, logs, traces, errors, and persisted client
      caches.
- [ ] Reconnection after the initial hydrated ticket has been consumed obtains
      a fresh ticket through a documented same-origin path.
- [ ] The design is proven in one userspace application before considering
      migration of `apps/os` from `from-server-cookie`.

## Non-goals

- Do not make this task responsible for the generic userspace Cap'n Web server,
  application session targets, React client runtime, or LiveState extraction.
- Do not serialize an RPC stub into SSR output; only the narrowly scoped,
  one-time credential crosses the server/client boundary.
- Do not remove the existing exact-Origin cookie bootstrap until the ticket
  flow is production-proven and reconnect behavior has an equally reliable
  replacement.
