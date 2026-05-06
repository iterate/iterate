# OS2 codemode depth investigation: `ctx.exports`, Workers RPC, subrequests, and loop depth

Date: 2026-05-06

Repo under investigation:

- `/Users/jonastemplestein/src/github.com/cloudflare/workerd`
- `git rev-parse HEAD`: `e4c3d8b4557f6dc5b63315b45a61a4dd8a92a944`

Product code was not modified. This report is the only repo file created.

## Executive summary

Short answer:

- `ctx.exports.SomeCapability({ props })` by itself does **not** start a subrequest and does **not** invoke a Worker. In public workerd source it only creates a specialized `Fetcher` backed by a specialized `IoChannelFactory::SubrequestChannel`.
- Calling an RPC method on that specialized stub, e.g. `await ctx.exports.SomeCapability({ props }).run(...)`, **does** start a workerd subrequest. The dispatch path calls `IoContext::getSubrequest()`, which immediately calls `LimitEnforcer::newSubrequest(...)`.
- The specialized `ctx.exports.Foo({ props })` path appears to be counted as **non-in-house** for workerd's per-request subrequest accounting, because `LoopbackServiceStub::callImpl()` returns `js.alloc<Fetcher>(ioctx.addObject(channelObj))` without passing `isInHouse=true`.
- The unspecialized `ctx.exports.Foo` stub is constructed as in-house, so calls made directly on the unspecialized loopback stub take a different accounting flag.
- Durable Object namespace `get()`/`getByName()` only creates a stub. Fetch/RPC on that stub starts a subrequest through `context.getSubrequest(... {.inHouse = true, ...})`.
- The exact error string `Subrequest depth limit exceeded. This request recursed through Workers too many times...` is **not present** in the public `workerd` checkout or the local `~/src/github.com/cloudflare` repos I searched. The public source exposes the hook where subrequests are counted (`LimitEnforcer::newSubrequest()`), but production enforcement and the specific 1019/loop-depth error text appear to live in Cloudflare internal/downstream code or FL/proxy code not present here.
- Public Cloudflare docs say deployed Workers loop depth is tracked with the `CF-EW-Via` header, initialized to 16-ish remaining invocations and decremented on Worker invocation. Public workerd source does not contain `CF-EW-Via`, `CDN-Loop`, or the exact loop-depth error implementation.

Practical conclusion for OS2 codemode:

- Instantiation of a named `WorkerEntrypoint` loopback with props is cheap with respect to depth.
- Every RPC method call made through that stub is a new subrequest/session in workerd. If the production loop-depth guard counts these internal WorkerInterface invocations the same way as normal Worker-to-Worker calls, a recursive/cyclic MCP/codemode call graph can exhaust the Worker invocation depth. Public source proves the subrequest/session creation, but not the exact deployed `CF-EW-Via` decrement site.

## Search results and source availability caveat

Searched local source:

- `rg "Subrequest depth limit exceeded|recursed through Workers|CF-EW-Via|EW-Via|CDN-Loop|subrequest depth|worker invocation" /Users/jonastemplestein/src/github.com/cloudflare`
- `rg "Subrequest depth limit exceeded|recursed through Workers|CF-EW-Via|EW-Via|CDN-Loop" /Users/jonastemplestein/src/github.com/cloudflare/workerd`

Result:

- No public source match for the exact error string.
- No public source match for `CF-EW-Via`.
- No public source match for `CDN-Loop` loop-subrequest handling.
- Public source match for the generic per-request subrequest enforcement hook: `src/workerd/io/limit-enforcer.h` and `src/workerd/io/io-context.c++`.

GitHub code search results:

- `gh search code '"Subrequest depth limit exceeded"' --owner cloudflare` only found `cloudflare/skills:skills/cloudflare/references/workers/gotchas.md`, not runtime source.
- `gh search code '"CF-EW-Via"' --owner cloudflare` found no Cloudflare-owned public source.
- Broader public search found Cloudflare docs saying `CF-EW-Via` is the loop-detection counter, but not implementation source.

Therefore, where this report says "public source proves", it means the local public `workerd` source. Where it discusses `CF-EW-Via`/1019 loop depth, the exact enforcement implementation is not visible in the checked-out source and should be treated as a source-availability caveat.

## The workerd subrequest accounting hook

The relevant public interface is `LimitEnforcer::newSubrequest(bool isInHouse)`:

- `src/workerd/io/limit-enforcer.h:119-141`
- Lines 135-141 say it is called before starting a new subrequest and throws if the limit has been reached. `isInHouse` is for Cloudflare internal services that should not be subject to the same limits as external subrequests.

The central call site is:

- `src/workerd/io/io-context.c++:955-960`

```c++
kj::Own<WorkerInterface> IoContext::getSubrequest(...) {
  limitEnforcer->newSubrequest(options.inHouse);
  return getSubrequestNoChecks(...);
}
```

All code paths that route through `IoContext::getSubrequest()` increment/check this public workerd subrequest counter. `getSubrequestNoChecks()` deliberately skips that check and only does tracing/metrics/external-memory wrapping:

- `src/workerd/io/io-context.h:761-777`
- `src/workerd/io/io-context.c++:920-952`

For channel-based service bindings/loopbacks:

- `src/workerd/io/io-context.c++:962-988` wraps `getSubrequestChannel(...)` around `getSubrequest(...)`.
- `src/workerd/io/io-context.c++:1006-1018` then calls `channelFactory.startSubrequest(channel, metadata)`.

In the standalone public `workerd server`, `LimitEnforcer::newSubrequest()` is a no-op:

- `src/workerd/server/server.c++:3589-3597`

That is not evidence that production has no limit. It means the open-source local server implementation does not enforce it. Production Cloudflare presumably provides a downstream/internal `LimitEnforcer` implementation.

## `ctx.exports` loopback representation

The public API type for stateless `ctx.exports` entries is `LoopbackServiceStub`:

- `src/workerd/api/export-loopback.h:14-23`

Important details:

- It "points back at a stateless (non-actor) entrypoint of this Worker".
- It can be used as a regular `Fetcher` with empty props.
- It can be invoked as a function to specialize it with props.
- It is represented by numbered subrequest channels.
- Constructor: `LoopbackServiceStub(uint channel) : Fetcher(channel, RequiresHostAndProtocol::YES, /*isInHouse=*/true)`.

So the raw object in `ctx.exports.Foo` is a `Fetcher` with `isInHouse=true`.

The specialized path is:

- `src/workerd/api/export-loopback.c++:11-29`

`LoopbackServiceStub::callImpl()`:

1. Serializes `props` into a `Frankenvalue`.
2. Calls `IoContext::current().getIoChannelFactory().getSubrequestChannel(channel, props, versionRequest)`.
3. Returns `js.alloc<Fetcher>(ioctx.addObject(channelObj))`.

Crucially, this constructor call uses the `Fetcher(IoOwn<SubrequestChannel>, ..., bool isInHouse = false)` overload default:

- `src/workerd/api/http.h:271-278`

So `ctx.exports.Foo({ props })` returns a specialized `Fetcher` whose `isInHouse` field is false unless there is another downstream patch not present in this checkout.

The server-side channel wiring is in `src/workerd/server/server.c++`:

- `4703-4788`: builds `ctx.exports` after handler validation.
- `4727-4734`: loopback stateless entrypoints get subrequest channel numbers after configured bindings and the two special channels.
- `4735-4744`: each named `WorkerEntrypoint` gets a `LoopbackServiceStub` channel.
- `4817-4825`: those same channels are linked back to `workerService.getLoopbackEntrypoint(...)`.

Specialization with props on the server side:

- `src/workerd/server/server.c++:3462-3480`
- If `props` is present, `getSubrequestChannel()` requires that the referenced channel is a loopback `Service` and calls `service.forProps(props)`.
- `EntrypointService::forProps()` returns a new `EntrypointService` with `props`: `src/workerd/server/server.c++:3198-3205`.

## Does `ctx.exports.SomeCapability({ props })` itself count?

No, not in public workerd source.

The instantiation path:

- `LoopbackServiceStub::callImpl()` only builds `Frankenvalue` props and obtains a specialized `SubrequestChannel`.
- `WorkerService::getSubrequestChannel(... props ...)` only returns a `Service` specialized by props.
- No `IoContext::getSubrequest()` call occurs.
- No `LimitEnforcer::newSubrequest()` call occurs.
- No `WorkerEntrypoint::customEvent()` or `WorkerEntrypoint::request()` is dispatched.

Line refs:

- `src/workerd/api/export-loopback.c++:11-29`
- `src/workerd/server/server.c++:3462-3480`
- `src/workerd/server/server.c++:3198-3205`

So this expression alone should not consume per-request subrequest count or Worker invocation depth:

```ts
const stub = ctx.exports.SomeCapability({ props });
```

## Do RPC method calls on that stub count?

Yes for workerd subrequest accounting.

RPC on `Fetcher` is implemented by wildcard method/property access:

- `src/workerd/api/http.h:433-441`
- `src/workerd/api/http.h:506`
- `src/workerd/api/http.c++:2083-2126`

The RPC dispatch path from a `Fetcher`:

- `src/workerd/api/http.c++:2128-2148`

`Fetcher::getClientForOneCall()`:

1. Gets current `IoContext`.
2. Calls `getClient(ioContext, ..., "jsRpcSession")`.
3. Creates a `JsRpcSessionCustomEvent`.
4. Dispatches it via `worker->customEvent(...)`.
5. Returns the top-level RPC capability.

`getClient()` routes to `getClientWithTracing()`:

- `src/workerd/api/http.c++:2411-2453`

For `IoOwn<SubrequestChannel>` (the specialized `ctx.exports.Foo({ props })` case):

- `src/workerd/api/http.c++:2426-2436`
- It calls `ioContext.getSubrequest(... {.inHouse = isInHouse, .wrapMetrics = !isInHouse, ...})`.
- For the specialized loopback `Fetcher`, `isInHouse` is false in this public source, so `LimitEnforcer::newSubrequest(false)` runs.

For raw numeric-channel `Fetcher` (the unspecialized `ctx.exports.Foo` case):

- `src/workerd/api/http.c++:2420-2424`
- It calls `ioContext.getSubrequestChannel(channel, isInHouse, ...)`.
- The raw `LoopbackServiceStub` was constructed with `isInHouse=true`, so this reaches `LimitEnforcer::newSubrequest(true)`.

The generic RPC call machinery:

- `src/workerd/api/worker-rpc.h:10-13` explicitly says `Fetcher` RPC methods start a new session by dispatching a `jsRpcSession` custom event.
- `src/workerd/api/worker-rpc.c++:441-563` builds and sends the RPC call.
- `src/workerd/api/worker-rpc.c++:577-599` awaits the RPC result.
- `src/workerd/io/worker-interface.capnp:800-810` defines `jsRpcSession` and says C++ dispatches it using `WorkerInterface::customEvent()`.

Server-side delivery:

- `src/workerd/io/worker-entrypoint.c++:924-950` handles `WorkerEntrypoint::customEvent()`.
- `src/workerd/api/worker-rpc.c++:2155-2193` handles `JsRpcSessionCustomEvent::run()`.
- `src/workerd/api/worker-rpc.c++:2172-2173` constructs an `EntrypointJsRpcTarget` for the named entrypoint and props.

So this **does** consume a workerd subrequest:

```ts
await ctx.exports.SomeCapability({ props }).someRpcMethod(args);
```

It also dispatches a new Worker custom event to the target entrypoint. Public source does not show whether the deployed `CF-EW-Via` loop counter is decremented for this internal custom-event path.

## Does `fetch()` on a `ctx.exports` stub count?

Yes for workerd subrequest accounting.

`Fetcher::fetch()`:

- `src/workerd/api/http.c++:2077-2080`

It routes through `fetchImpl()`, then eventually obtains the `Fetcher` client and starts the channel request. The relevant accounting is the same `Fetcher::getClientWithTracing()` path:

- `src/workerd/api/http.c++:2417-2453`

For specialized `ctx.exports.Foo({ props })`, it reaches `IoContext::getSubrequest(... inHouse=false ...)`.

For unspecialized `ctx.exports.Foo`, it reaches `IoContext::getSubrequestChannel(... isInHouse=true ...)`.

## How WorkerEntrypoint objects are actually constructed

The JS base class `WorkerEntrypoint` constructor itself just stores `ctx` and `env` on `this`:

- `src/workerd/api/workers-module.h:12-31`
- `src/workerd/api/workers-module.c++:12-23`

It does not do I/O or count subrequests.

The runtime wrapper that creates an invocation context is `newWorkerEntrypoint()`:

- `src/workerd/io/worker-entrypoint.h:31-50`
- `src/workerd/io/worker-entrypoint.c++:990-1010`

For workerd server service-to-service entrypoints:

- `src/workerd/server/server.c++:2223-2232`

`WorkerService::startRequest()` calls `newWorkerEntrypoint(...)` with:

- the target `entrypointName`
- cloned/moved `props`
- a `LimitEnforcer`
- the service's `IoChannelFactory`
- metrics/tracing

This confirms that the actual invocation happens at request/custom-event dispatch time, not at `ctx.exports.Foo({ props })` construction time.

## Durable Object stubs

Creating a Durable Object ID or stub does not start a subrequest.

Source:

- `src/workerd/api/actor.c++:112-124`: `newUniqueId`, `idFromName`, `idFromString` allocate IDs.
- `src/workerd/api/actor.c++:126-188`: `getByName()`, `get()`, and `getImpl()` allocate a `DurableObject` stub backed by an outgoing factory.

The actual subrequest starts when that stub is used for `fetch()` or RPC.

Global DO outgoing path:

- `src/workerd/api/actor.c++:41-71`

`GlobalActorOutgoingFactory::newSingleUseClient()` calls:

```c++
context.getSubrequest(... {.inHouse = true,
  .wrapMetrics = true,
  .operationName = "durable_object_subrequest"})
```

Local DO outgoing path:

- `src/workerd/api/actor.c++:18-39`

Replica actor outgoing path:

- `src/workerd/api/actor.c++:73-89`

All of these call `context.getSubrequest(... inHouse=true ...)`, so they hit `LimitEnforcer::newSubrequest(true)`.

Facet DOs have a separate nesting limit:

- `src/workerd/api/actor-state.c++:961-967`: `MAX_FACET_TREE_DEPTH = 4`
- `src/workerd/api/actor-state.c++:1022-1024`: throws `"Facet nesting depth limit exceeded..."`
- `src/workerd/api/actor-state.c++:984-1002`: facet request dispatch also uses `context.getSubrequest(... inHouse=true, operationName="facet_subrequest")`

This facet limit is unrelated to the `Subrequest depth limit exceeded. This request recursed through Workers too many times...` error string.

## What increments what?

Public workerd source proves these increments/checks:

| Operation                                                          | Calls `LimitEnforcer::newSubrequest()`? | `isInHouse` flag in public source                                               | Dispatches new Worker event?              |
| ------------------------------------------------------------------ | --------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------- |
| `ctx.exports.Foo` property access                                  | No                                      | N/A                                                                             | No                                        |
| `ctx.exports.Foo({ props })`                                       | No                                      | N/A                                                                             | No                                        |
| `ctx.exports.Foo.someRpc()` raw loopback RPC                       | Yes                                     | `true`                                                                          | Yes, `jsRpcSession` custom event          |
| `ctx.exports.Foo({ props }).someRpc()` specialized loopback RPC    | Yes                                     | `false` in public source                                                        | Yes, `jsRpcSession` custom event          |
| `ctx.exports.Foo.fetch(...)` raw loopback fetch                    | Yes                                     | `true`                                                                          | Yes, fetch event/request                  |
| `ctx.exports.Foo({ props }).fetch(...)` specialized loopback fetch | Yes                                     | `false` in public source                                                        | Yes, fetch event/request                  |
| `env.SERVICE.someRpc()` service binding RPC                        | Yes                                     | Depends on binding construction, usually not in-house for user service bindings | Yes, `jsRpcSession` custom event          |
| `env.SERVICE.fetch(...)` service binding fetch                     | Yes                                     | Depends on binding construction, usually not in-house for user service bindings | Yes, fetch event/request                  |
| `env.DO.get(id)`                                                   | No                                      | N/A                                                                             | No                                        |
| `env.DO.get(id).someRpc()`                                         | Yes                                     | `true`                                                                          | Yes, `jsRpcSession` custom event to actor |
| `env.DO.get(id).fetch(...)`                                        | Yes                                     | `true`                                                                          | Yes, fetch event/request to actor         |
| `ctx.exports.ActorClass({ props })`                                | No                                      | N/A                                                                             | No actor request by itself                |
| Facet/actor stub request                                           | Yes                                     | `true`                                                                          | Yes, actor request                        |

Important nuance:

- `newSubrequest(true)` still gets called. The public interface says in-house subrequests "should not be subject to the same limits as external subrequests" (`src/workerd/io/limit-enforcer.h:135-141`), but the public interface does not define exactly how the production enforcer treats it.
- Cache API is a special case: `IoContext::getCacheClient()` explicitly calls `newSubrequest(false)` even though comments say Cache API requests are not counted in metrics/logs like ordinary subrequests (`src/workerd/io/io-context.c++:1033-1039`).

## Headers and counters

Visible in public source:

- `IoChannelFactory::SubrequestMetadata` carries:
  - `cfBlobJson`
  - `parentSpan`
  - `featureFlagsForFl`
  - `startTime`
- Source: `src/workerd/io/io-channels.h:101-117`
- `featureFlagsForFl` is described as serialized JSON for the `ew_compat` control header to FL: `src/workerd/io/io-channels.h:110-113`.
- `IoContext::getSubrequestChannelImpl()` populates `featureFlagsForFl`: `src/workerd/io/io-context.c++:1011-1018`.

Visible tracing/metrics counters:

- `IoContext::getSubrequestNoChecks()` wraps metrics when requested and creates trace spans: `src/workerd/io/io-context.c++:920-952`.
- `Fetcher::getClientWithTracing()` uses operation names like `"jsRpcSession"`: `src/workerd/api/http.c++:2417-2436`.
- DO requests use operation name `"durable_object_subrequest"`: `src/workerd/api/actor.c++:36-38`, `68-70`, `86-88`.
- Facets use operation name `"facet_subrequest"`: `src/workerd/api/actor-state.c++:1000-1002`.
- JS RPC event info is tracked through `JsRpcEventInfo`: `src/workerd/io/trace.h:354-365`, and `WorkerTracer::setJsRpcInfo()` updates the RPC method name at `src/workerd/io/tracer.c++:531-548`.

Not visible in public source:

- `CF-EW-Via`
- `CDN-Loop`
- The exact 1019 loop-limit counter decrement
- The exact error string `Subrequest depth limit exceeded. This request recursed through Workers too many times...`

Public docs, not source, say:

- `CF-EW-Via` is the Workers loop-detection header.
- Its value is an integer number of remaining Worker invocations.
- Each Worker invocation decrements it.
- When the count reaches zero, Cloudflare returns 1019.

Source caveat: I could not locate the code that mutates this header in the public workerd repo. Given the `neededByFl` comments in `compatibility-date.capnp`, the docs' description of `CF-EW-Via`, and absence from workerd, this logic appears to live in Cloudflare's FL/proxy/internal runtime, not in public workerd.

## Best answer to the original question

For `ctx.exports.SomeCapability({ props })`:

- Instantiation: **No**, not a subrequest and not a Worker invocation in public source.
- RPC method call: **Yes**, it starts a workerd subrequest and a `jsRpcSession` Worker custom event.
- Fetch call: **Yes**, it starts a workerd subrequest and target fetch event/request.

For deployed Cloudflare's `CF-EW-Via` loop-depth error:

- Public source proves the RPC/fetch invocation is represented as a subrequest/WorkerInterface dispatch.
- Public source does **not** prove exactly where `CF-EW-Via` is decremented or where the `Subrequest depth limit exceeded...` string is thrown.
- Based on the docs and source shape, the safest operational assumption is: every actual RPC/fetch call through a Worker/service/loopback stub can consume one Worker invocation-depth unit, while stub creation does not.

## OS2 implication

If OS2 codemode/MCP uses a chain like:

```ts
const capability = ctx.exports.SomeCapability({ props });
await capability.someRpcMethod(...);
```

the chain should not worry about the first line. It should worry about each awaited RPC/fetch across a `Fetcher`/service/DO stub boundary.

If a tool-provider or MCP bridge recursively calls back through `ctx.exports` on every tool operation, it can create one `jsRpcSession` subrequest per hop. In public source, those are real subrequests. If the production loop guard is applied to the same WorkerInterface dispatches, this pattern can hit the 16-hop loop limit even without external HTTP `fetch()` calls.

The one public-source surprise is that `ctx.exports.Foo({ props })` specialized loopbacks appear to lose the raw loopback stub's `isInHouse=true` accounting flag. If OS2 sees subrequest-count symptoms but not `CF-EW-Via` symptoms, this is a plausible reason: specialized loopback RPC is accounted as `newSubrequest(false)` in the public code path.
