---
state: open
priority: medium
size: medium
dependsOn: []
---

# Callable subscription followups

This branch moves Events external subscriptions from `callbackUrl` to stored
`Callable` descriptors without changing `apps/agents` or `apps/os`. Those apps
still need a coordinated follow-up once their owners are ready to adopt the new
subscription payload shape.

## OS

- Decide which OS callable descriptors are intended to be stored or dispatched
  outside the worker that created them.
- Use same-worker `loopback-binding` only for descriptors dispatched in the same
  OS worker request/DO context where `ctx.exports` is available.
- For stored descriptors, prefer `createOpenApiProvider({ workerScriptName })`
  or another env/service-binding descriptor so the callable resolves from the
  dispatching worker's `env`, not from whichever worker happens to dispatch it.
- Add focused tests for `codemode.describe` and `CodemodeSession.registerToolProvider`
  with both:
  - a same-worker loopback OpenApiBridge descriptor
  - a stored/cross-worker self descriptor using `workerScriptName`
- If OS ever configures Events subscriptions that should dispatch directly into
  OS WorkerEntrypoints or Durable Objects, add explicit service/DO bindings to
  the Events worker and document that subscription callables resolve in the
  Events worker capability context, not in OS's context.

## Agents

- Update active subscription producers to append `callable` instead of
  `callbackUrl`:
  - `apps/agents/src/orpc/routers/create-agent.ts`
  - `apps/agents/src/orpc/routers/install-processor.ts`
  - `apps/agents/src/durable-objects/child-stream-auto-subscriber.ts`
  - `apps/agents/scripts/router.ts`
- Add a small helper near the websocket URL builders that converts `ws:` /
  `wss:` target URLs to fetch callables with `http:` / `https:` URLs. Events
  opens websocket upgrades through `connectCallableWebSocket()`, so the stored
  callable should be fetch-shaped.
- Update Agents e2e setup that appends `subscription-configured` events to use
  `callable`.
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
