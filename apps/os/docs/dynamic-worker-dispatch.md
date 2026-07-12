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
  userspace. A `worker.slack.chat.postMessage(x)` call (say, onto a Slack SDK
  getter a project added to its worker) delivers
  `{ path: ["slack", "chat", "postMessage"], args: [x] }`; nothing named
  `slack` exists on either side of the wire. This is what lets a worker getter
  hand back a raw vendor SDK client — but it also means
  intermediate segments are not addressable, describable, or
  protocol-capable. They are strings.

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
real fetch hop (`ItxBinding` in domains/workers/schemas.ts).

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

## Live capabilities over the fetch lane: capability URLs

A live capability is normally reached by RPC (`itx.<name>.method(...)`), which
carries data but never a socket. To give a live capability the fetch lane's
physics — streaming, and crucially WebSocket upgrades — mount it as
**`addressable`** and reach it by **URL** instead of by itx path:

```
fetch("http://<name>.iterate/…", req)   // from project worker code
```

`.iterate` is the internal host suffix (never DNS-routable — the same suffix the
Durable Object name codec uses). The grammar is `<cap>.<projectId>.iterate`, or
the short `<cap>.iterate` (the caller's own project); the request path/query
ride the URL path, the capability name is the host label. DNS lowercases the
host, so mounts resolve case-insensitively (`itx.jonasComputer` ↔
`jonascomputer.<project>.iterate`). The parse + dispatch header live in
`domains/capability-host/capability-url.ts`.

Why a URL and not a method: **the URL changes the transport class from RPC to
fetch-native.** Every hop is a real stub fetch — project egress
(`ProjectDurableObject.fetch`) recognizes an `.iterate` host and dials the
capability host DO (`CAPABILITY_HOST.getByName(...).fetch`), carrying the
resolved capability path in `x-iterate-capability-dispatch` (internal, stripped
at the trust boundary). The capability host DO is a real workerd object
(`serveCapabilityFetch`), so:

- **Plain HTTP** calls the provider's `fetch(request)` — the `Request`/`Response`
  copies serialize over the provider's connection, the same transport as
  `itx.<name>.fetch(req)`, just reached by URL.
- **A WebSocket upgrade terminates AT the capability host DO** (`WebSocketPair`,
  a real 101 established at a real object's fetch) and bridges FRAMES to the
  provider via its `connectSocket({ onMessage, onClose }) → { send, close }`.
  The socket never crosses an RPC hop; only frames (callback invocations) do.
  This is the by-hand frame bridge the old recipe required, now run by the
  platform. The teardown discipline is the same: `close()` is the only
  cross-RPC teardown (a returned value's `[Symbol.dispose]` is dropped by
  capnweb's by-value return serialization), awaited before the per-socket handle
  is disposed; callback stubs stay live for the socket's lifetime because a DO's
  I/O context spans the socket and capnweb keeps the `dup()`'d callbacks alive.

Cross-project access is structurally impossible: the egress hop dials the
capability host under the CALLER's own projectId, and an explicit projectId in
the URL must match it. `addressable` is opt-in on `provideCapability` — an
ordinary live mount is not URL-reachable.

`iterate use-my-computer` is the shipped provider
(packages/iterate/src/use-my-computer.ts): `myComputerProvision(name,
{ exposePort })` mounts `addressable` and lends the local port, so a project
worker's whole homepage — HTTP and its `/ws` upgrade alike — is one forward,
`return fetch(new Request("http://<name>.iterate" + path + search, req))`.
`e2e/vitest/live-capability-fetcher.e2e.test.ts` proves both, end to end.

## The RPC boundary that remains (the deferred specification)

Capability URLs give the fetch lane's physics to a live capability, but they do
NOT make the RPC path carry a socket. Forwarding `itx.wsbackend.fetch(req)`
where the provider returns a socket-carrying `Response` still dies at the first
internal workerd RPC hop:

- Non-upgrade HTTP through a live capability's fetch works — `Request` and
  `Response` serialize over capability dispatch.
- An upgrade response does not: the capnweb fork tunnels the socket across the
  **session** as a stream pair (`websocket-streams.ts`), then materializes a
  real WebSocket at the session endpoint — and the first internal workerd RPC
  hop after that refuses it (the DataCloneError, asserted verbatim).

That boundary is pinned by a passing test, and the socket-over-RPC dream it
guards is a **`test.fails` specification**, both in
`e2e/vitest/live-capability-websocket.e2e.test.ts`. Making the spec pass would
need the fork to stay in stream-pair form until the fetch-lane exit (a capnweb
`makeUpgradeResponse` change) — deliberately not done, because the
capability-URL form above already delivers the user-facing outcome (websockets
to a live capability) by terminating the upgrade at a real DO and bridging
frames. The two mechanisms address the socket differently; the URL form is the
shipped one.

## Rules of thumb

- Serving HTTP from a dynamic worker? Implement the class's `fetch` handler —
  the magic name is a workerd rule, not ours — and reach it via the fetch
  lane. Project ingress and the seeded router already do this for app hosts;
  worker-to-worker HTTP is `env.ITX.fetch` with the dispatch header.
- WebSockets specifically: `fetch` checks the `upgrade` header, returns
  `new Response(null, { status: 101, webSocket })`. The seeded `CounterApp`'s
  `/ws` route (a named export of the one-file seeded `worker.ts`) is the
  reference; `project-ingress.e2e.test.ts` proves the lane end to end.
- Calling methods on a worker (`itx.worker.<getter>.<method>`, provided
  capabilities, probes)? That is the capability tree — RPC dispatch,
  serialized results, `flattenNestedPaths` if the worker wants to interpret
  paths itself. Never expect protocol behavior from it, whatever the method
  is called.
