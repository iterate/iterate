# Dynamic worker dispatch: the capability tree vs the fetch lane

Dynamic workers are reachable through two channels with different physics.
Confusing them produces the platform's most opaque failure (`DataCloneError:
Could not serialize object of type "WebSocket"`), so this doc states the model
once, precisely.

## The ground truth: what workerd considers real

workerd has exactly two kinds of real objects: **WorkerEntrypoint classes**
and **DurableObject classes** (facets are DO-hosted instances of the latter).
Real objects are reached through real stubs — service bindings, `ctx.exports`
loopback entrypoints, Worker Loader entrypoint stubs, DO namespace stubs,
facet stubs — and on those stubs, `fetch` is a distinguished name: calling it
is an HTTP dispatch, not a method call. Because a real object is always top of
the stack, the platform can terminate protocol concerns there — this is the
**only** place workerd will establish a WebSocket, and only when the request
carried upgrade headers into that distinguished `fetch` handler.

Everything a stub does other than `fetch` is Workers RPC: arguments and
results are **serialized** (JSON-ish data, `Request`/`Response` copies,
streams, live stubs). `Request`s and `Response`s are generally serializable —
bodies stream fine over RPC — which is why plain data-shaped HTTP works as a
capability method call. The one value workerd's serializer refuses is a live
socket: a `Response` carrying `webSocket` throws.

One deliberate nuance: our capnweb fork (iterate/capnweb,
`websocket-streams.ts`) CAN tunnel a WebSocket across a **capnweb session** —
the sender wraps the socket as a readable/writable stream pair, capnweb's
stream support carries the pair, and the receiving end reconstitutes a
working socket (a real `WebSocketPair` on workerd, a `TunneledWebSocket`
elsewhere). That is how a socket can reach an external capnweb peer such as a
Node process holding a live capability. It does not change the rule for the
worker mesh itself: between workerd isolates the hops are workerd RPC, and a
materialized socket still cannot cross them — bridging a tunneled socket
through internal hops means carrying it AS the stream pair and
re-materializing at the last fetch-lane hop.

## The capability tree is an overlay, not more real objects

The itx surface — dotted paths, `provideCapability`, `workers.get(ref)` — is
a dispatch convention **on top of** RPC. Its "nodes" are not workerd objects:

- **Member replay** (the default): the platform walks the dotted path
  property-by-property on the target and applies the final segment as a
  method. The intermediate values are whatever the walk finds — plain
  objects, getters, stubs.
- **`flattenNestedPaths`**: the dotted path is never walked at all. The whole
  call arrives at the target as ONE
  `invokeCapability({ path, args })` invocation, and the path segments are
  **pure data** that the worker's own `invokeCapability` method interprets in
  userspace. `worker.slack.chat.postMessage(x)` delivers
  `{ path: ["slack", "chat", "postMessage"], args: [x] }`; nothing named
  `slack` exists on either side of the wire. This is what lets the seeded
  template hand back the raw Slack SDK — but it also means intermediate
  segments are not addressable, describable, or protocol-capable. They are
  strings.

Either way, the transport is RPC method calls. Therefore **no name in the
capability tree is protocol-special — `fetch` included**. A capability method
named `fetch` receives a serialized `Request` copy and returns a serialized
`Response` copy. That is fine for JSON and HTML; it can never perform an
upgrade. Capability dispatch refuses upgrade requests with a teaching error
rather than failing deep with the DataCloneError
(`DynamicWorkerRunner.invokeCapability`).

## The fetch lane

Consequence of the ground truth: an HTTP surface that needs protocol
semantics must be the class's own `fetch` handler on a real dynamic worker —
a stateless `WorkerEntrypoint` or a stateful `DurableObject` — and every hop
from the edge to that handler must be a real stub fetch. That composition is
the fetch lane:

```
client
  → OS worker fetch (ingress; resolves host → project + app slug)
  → DynamicWorkerRunner.fetch
      stateless: Worker Loader entrypoint stub .fetch ───────────┐
      stateful:  WORKER DO stub .fetch                           │
                   → StatefulWorkerDurableObject.fetch           │
                   → facet stub .fetch ──────────────────────────┤
                                                                 ▼
                                              the worker class's own fetch()
```

The root project worker sits in the middle of that chain for app hosts: it is
itself a stateless dynamic worker whose `fetch` routes on the trusted
`x-iterate-app` header and re-dispatches to the selected app via
`env.ITX.fetch` — the loopback ItxEntrypoint's fetch handler, i.e. one more
real fetch hop (`ItxBinding` in types.ts).

Two mechanics fall out of "real fetch has no argument channel besides the
request":

- **The dispatch header.** `x-iterate-worker-dispatch` carries the target ref
  (JSON `{ ref, buildBudgetMs? }`, same shape `workers.get` takes) — the role
  `invokeCapability`'s `ref` argument plays on the RPC side. It is internal:
  ingress strips it at the trust boundary, and every receiver strips it
  before the request reaches worker code. Authority is the dispatching
  binding's own scope, exactly like `project.workers.get(ref)`.
- **The building page.** Named errors do not survive fetch hops the way they
  survive RPC, so a budget-expired cold build answers a single shared
  response from whichever hop hit it (`workerBuildingResponse()`): a 503
  that auto-refreshes in browsers, is marked `x-iterate-worker-building` for
  routers that want to substitute their own page, and reads as a retryable
  close to a WebSocket reconnect loop. RPC callers of `workers.get` still
  get the named `WorkerBuildInProgressError` instead.

## Live capabilities can serve WebSockets — as callback pairs, not sockets

A live capability provided over Cap'n Web (say, a Node process holding an
open `/api` session) can back a WebSocket app host end to end. This is proven
by `e2e/vitest/live-capability-websocket.e2e.test.ts`: the vitest runner
provides a plain `fetch(request)` handler that upgrades, and a browser-side
socket connecting to `livews--<slug>.<base>` reaches it.

The composition rule, empirically pinned by that test:

- **The direct form does not cross the mesh.** If the capability's fetch
  returns a `Response` carrying the socket, the capnweb fork happily tunnels
  it across the session (stream pair) — and then the materialized socket dies
  at the first internal workerd RPC hop with the DataCloneError. The test
  asserts this exact failure so the boundary is visible when it moves.
- **Callback stubs cross everywhere.** Functions are the one value RPC chains
  natively through every hop — capnweb session, capability-host Durable
  Object, loopback entrypoint, loader isolate. So a socket crosses the mesh
  as two callback pairs facing each other (`send`/`close` in each direction),
  and each end materializes its own real socket: the app isolate mints the
  `WebSocketPair` that completes the eyeball's upgrade (the fetch lane
  carries it from there), and the provider side adapts the author's fetch
  handler with an in-memory socket-pair shim. Ownership footnote: RPC params
  are released when the call returns, so the provider must `dup()` the
  callbacks it keeps for the socket's lifetime.

The bridge is ~60 lines of userspace on each side (see the e2e's
`BRIDGE_APP_SOURCE` and `websocketFetchCapability`); no platform machinery is
involved beyond what this document already describes.

## Rules of thumb

- Serving HTTP from a dynamic worker? Implement the class's `fetch` handler —
  the magic name is a workerd rule, not ours — and reach it via the fetch
  lane. Project ingress and the seeded router already do this for app hosts;
  worker-to-worker HTTP is `env.ITX.fetch` with the dispatch header.
- WebSockets specifically: `fetch` checks the `upgrade` header, returns
  `new Response(null, { status: 101, webSocket })`. The seeded
  `apps/websocket` app is the reference; `project-ingress.e2e.test.ts` proves
  the lane end to end.
- Calling methods on a worker (`itx.worker.slack.chat.postMessage`, provided
  capabilities, probes)? That is the capability tree — RPC dispatch,
  serialized results, `flattenNestedPaths` if the worker wants to interpret
  paths itself. Never expect protocol behavior from it, whatever the method
  is called.
