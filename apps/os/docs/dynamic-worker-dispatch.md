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
  that polls itself (meta-refresh for no-JS clients), is marked
  `x-iterate-worker-building` for routers that want to substitute their own
  page, and reads as a retryable close to a WebSocket reconnect loop. RPC
  callers of `workers.get` still get the named `WorkerBuildInProgressError`
  instead.

## The serve-side status surface (stale serving + the overlay)

The fetch lane prefers availability; RPC keeps commit-then-call-sees-new-code.
Once a repo-backed worker has built successfully, its **last-good pointer**
(`worker-last-good/…` in the artifact KV, per worker identity = everything in
the build key except source content) lets budgeted callers — the fetch lane —
answer a cache miss with the previous artifact immediately:

- New commit, build in flight → serve the previous build, dispatch the real
  build in the background (deduped per isolate + the in-flight marker).
- Build failed (recorded per build key, short TTL) → keep serving the
  previous build, with the builder's error attached.
- Nothing ever built → the building page; first-ever build failed → the
  build-failed page (`workerBuildFailedResponse`, marked
  `x-iterate-worker-build-failed`). Both poll their own URL and self-heal.
- Blocking (RPC) callers never see stale code: they wait for the build, and a
  failure is the named `WorkerBuildFailedError` with the builder's message.

What served rides on every fetch-lane response as `x-iterate-worker-serve` —
platform-authored (the runner deletes whatever user code set, then stamps;
stateful hops only strip, the facet's build is the outer DO's concern) and
deliberately public JSON: `{ status: "fresh" | "stale", commitOid?, reason?:
"building" | "build-failed", failure? }`. Project ingress reads it to inject
the **@iterate overlay** into HTML documents (HTMLRewriter, appended before
`</body>`; skipped for non-documents, CSP pages, and anything answering
`x-iterate-overlay`): the floating iterate mark that shows build state, the
failure message when there is one, and — while a rebuild runs — polls the
serve header and reloads when the fresh build lands. See
`worker-serve-overlay.ts`; `worker-stale-serve.e2e.test.ts` proves the loop.

## Live capabilities and WebSockets: the specification, and today's boundary

The behavior we want: a live capability whose `fetch(request)` upgrades —
provided over Cap'n Web from, say, a Node process — backs a project app host
directly, with the app's own fetch just forwarding
(`itx.wsbackend.fetch(req)`). That is written down as a **`test.fails`
specification** in `e2e/vitest/live-capability-websocket.e2e.test.ts`; when
it starts passing, the platform grew the feature and the assertion flips
loudly.

Today it stops one hop short, and the same file pins the boundary with a
passing test:

- Non-upgrade HTTP through a live capability's fetch works — `Request` and
  `Response` serialize over capability dispatch.
- An upgrade response does not: the capnweb fork tunnels the socket across
  the **session** as a stream pair (`websocket-streams.ts`), then
  materializes a real WebSocket at the session endpoint — and the first
  internal workerd RPC hop after that refuses it (the DataCloneError,
  asserted verbatim).

The missing piece is keeping the socket in stream-pair (or callback) form
across internal hops and materializing only at the fetch-lane exit. Until
then, a determined userspace can bridge a socket over capability dispatch
today by hand — frames as paired callback stubs in each direction, since
functions chain through every hop; mind that RPC params are released on
return, so a provider must `dup()` callbacks it keeps — but that pattern is
deliberately not blessed here: the specification above is the intended shape.

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
