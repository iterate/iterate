# Shared App oRPC Middleware

This folder is for small shared oRPC middleware helpers used by apps that build
their initial context through `defineApp`.

These helpers are intentionally app-oriented. They assume the initial oRPC
context already includes:

- `manifest`
- `req.headers`
- `req.url`

Those fields come from [`packages/shared/src/define-app.ts`](../../define-app.ts).

## Why This Exists

This package is the app-side companion to `defineApp`. It gives app routers a
few shared oRPC middleware helpers without turning app request context into the
same abstraction as the service stack.

The key boundary is intentional:

- initial context holds values supplied by the runtime/app boundary
- execution context holds values derived by middleware during a request

`manifest` stays in initial context because it is stable app identity, not
middleware-derived request state. Middleware may use `manifest`, but it should
not re-home it into execution context just for symmetry.

## Context Model

oRPC has two context phases:

- initial context: the values provided up front by the runtime/app boundary
- execution context: extra values injected by middleware for downstream
  middleware and handlers

The helpers here do not rename initial-context fields like `manifest`. They add
derived execution-context fields on top of the `defineApp` contract.

When these middlewares call `next({ context: ... })`, they are extending the
execution context seen by downstream middleware and handlers. They are not
replacing the initial context or moving fields like `manifest` / `req` out of
their original boundary-owned location.

## Included Helpers

- `requireHeader(...)`
  - requires a request header and injects the parsed value directly into
    `context.headerValues[...]` under the chosen field name
  - keeps validated header aliases namespaced so request-derived values do not
    silently collide with root app context
  - validates presence only; domain-specific parsing or auth should happen in
    more specific middleware
- `withRequestLogger()`
  - derives a request id from `x-request-id` or generates one
  - injects an evlog-backed request logger for downstream use
  - emits start / success / error request lifecycle events with app metadata
  - keeps `manifest` in its original initial-context location
  - reuses the shared service logger shape so app and service logs can be
    correlated

## Non-Goals

- not a full auth/authorization framework
- not the shared middleware layer for the service-style stack
- not a complete logging pipeline for every app yet

## Example

```ts
const procedure = os
  .$context<MyInitialContext>()
  .use(withRequestLogger())
  .use(requireHeader({ header: "x-api-key", as: "apiKey" }))
  .handler(async ({ context }) => {
    context.manifest.slug;
    context.requestId;
    context.logger;
    context.headerValues.apiKey;
  });
```
