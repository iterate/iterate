---
state: todo
priority: medium
size: medium
tags: [os, itx, api-polish, dx]
---

# Make the itx client surface symmetric across runtimes (`withItx` family)

Follow-up API polish surfaced while moving the browser itx hooks to bag-of-props
(`useItx({ projectId })`). The way you _get an itx handle_ is named and shaped
differently per runtime even though it's the same `/api/itx` capnweb session
underneath. We want one mental model: **a `withItx` family, one wrapper per
runtime, same vocabulary**, with only the genuinely environment-forced bits
differing.

## Current state (the asymmetry)

- **Node / e2e / laptop daemon** — `withItx({ baseUrl, token, context? }): RpcStub<ItxHandle>`
  (`apps/os/src/itx/client.ts`). One-shot, **caller-owned** (`using x = withItx(...)`),
  `Authorization: Bearer <token>` header, returns the stub synchronously.
- **Browser, hook** — `useItx({ projectId? }): RpcStub<ItxHandle>`
  (`apps/os/src/itx/use-itx.ts`). Suspends via React `use()`.
- **Browser, non-hook** — `getBrowserItx({ projectId? }): Promise<RpcStub<ItxHandle>>`.
  Same module-level **pool** as `useItx` (one shared socket per context, persists
  across navigation, evict-on-death recovery, no manual dispose), returns a promise.
- **Worker / worker-to-worker** — not a `withItx` at all; itx is reached via loopback
  caps / `resolveItx`. (Probably stays different, but worth naming in the model.)

Concretely the gaps:

1. **Name**: `withItx` vs `getBrowserItx` vs `useItx`.
2. **Vocabulary**: Node's `context` (`"global" | projectId | slug`) vs the browser's
   new `projectId`. Pick ONE. `projectId` is cleaner for the 99% case but loses the
   `"global"` / slug / context-ref generality `context` had — decide whether to keep a
   general `context` escape hatch alongside `projectId`.
3. **Lifecycle/return**: caller-owned stub (Node) vs pooled promise (`getBrowserItx`)
   vs pooled+suspend (`useItx`). These are real and should stay — but should be
   _obviously_ the same family, not three unrelated names.
4. **Auth**: explicit `token` (off-platform) vs implicit cookie (same-origin). Real;
   keep, but document as the one intended difference.

## What we want

One legible story, e.g.:

- `withItx({ baseUrl, token, projectId? })` — Node/off-platform, one-shot, `using`.
- `getBrowserItx({ projectId? })` — browser non-hook, pooled, `Promise`.
- `useItx({ projectId? })` — browser hook, pooled, suspends (thin `use()` over the pool).

…same verb family, same `projectId` field, the per-runtime extras (`baseUrl`/`token`
for Node, none for the cookie-authed browser) being the _only_ divergence. Factor the
shared core (URL build + `wss` upgrade + capnweb `newWebSocketRpcSession` +
handshake/dial timeout) once; the wrappers differ only in transport (ws vs browser
WebSocket, header vs cookie) and lifecycle (caller-owned vs pooled).

## Decisions to make

- **`projectId` vs `context` everywhere.** Reconcile the vocabulary; if both are
  needed, define how they relate (e.g. `projectId` is sugar for `context`).
- **Should the browser non-hook be called `withItx` too?** (runtime-resolved import),
  or keep `getBrowserItx` but make its params/return match the family.
- **Where does the shared core live** so Node (`ws`) and browser (`WebSocket`) can both
  use it without dragging Node-only imports into the bundle (today `client.ts` imports
  `ws`, so it's Node-only by import — mirror that boundary).

## Notes / pointers

- `apps/os/src/itx/client.ts` — `withItx` (Node).
- `apps/os/src/itx/use-itx.ts` — `useItx` / `getBrowserItx` / `reconnectBrowserItx` (pool).
- `apps/os/src/itx/dial.ts` — DIALABLE_LOOPBACKS (related but separate concern).
- Constraint: browsers can't set WS `Authorization` headers → cookie/admin-cookie bridge.
- Keep the itx-callsite-purity rule: the thing handed back is a bare capnweb stub, not a
  wrapper (adapt at dial, not the callsite).

## Also in scope for this polish pass (same theme)

- **Bag-of-props for the itx _kernel_ verbs.** The FE helpers are now props objects
  (`useItx`/`getBrowserItx`/`reconnectBrowserItx`/`useItxResource`/`releaseItxSubscription`).
  The handle/capability verbs are still positional in places — `itx.projects.get(id)`,
  `itx.streams.namespace(ns)`, `itx.streams.subscribe(cb, opts)`, `itx.capability(name)`,
  `itx.streams.append(event)`, `itx.streams.onStateChange(cb)`. This is the cross-runtime
  itx contract (~88 call sites + handle.ts + types), so sweep it deliberately. Likely keep
  `itx.fetch(input, init)` as the `fetch()` Web-API mirror, and weigh the single-value
  verbs (`append`, `onStateChange`) where `{props}` is pedantic.
