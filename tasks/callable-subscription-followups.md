---
state: open
priority: medium
size: medium
dependsOn: []
---

# Callable subscription followups

This branch moved Events external subscriptions from `callbackUrl` to stored
`Callable` descriptors. The immediate compatibility fixes updated active Agents
subscription producers and the Events processor docs, but OS2 and Agents still
need a cleanup pass after this lands.

## OS2

- Decide which OS2 callable descriptors are intended to be stored or dispatched
  outside the worker that created them.
- Use same-worker `loopback-binding` only for descriptors dispatched in the same
  OS2 worker request/DO context where `ctx.exports` is available.
- For stored descriptors, prefer `createOpenApiProvider({ workerScriptName })`
  or another env/service-binding descriptor so the callable resolves from the
  dispatching worker's `env`, not from whichever worker happens to dispatch it.
- Add focused tests for `codemode.describe` and `CodemodeSession.registerToolProvider`
  with both:
  - a same-worker loopback OpenApiBridge descriptor
  - a stored/cross-worker self descriptor using `workerScriptName`
- If OS2 ever configures Events subscriptions that should dispatch directly into
  OS2 WorkerEntrypoints or Durable Objects, add explicit service/DO bindings to
  the Events worker and document that subscription callables resolve in the
  Events worker capability context, not in OS2's context.

## Agents

- Rename user-facing/internal variables where `callbackUrl` now means "the URL
  used to build a subscription callable"; the persisted Events subscription no
  longer stores `callbackUrl`.
- Review returned API fields such as `installProcessor.callbackUrl` and CLI
  output. They may remain useful as debug display, but should be labelled as the
  websocket target URL rather than the stored subscription payload.
- Add a regression test around `createAgent` or `installProcessor` that asserts
  the appended `subscription-configured` payload contains `callable` and not
  `callbackUrl`.

# Plan (TODO)
