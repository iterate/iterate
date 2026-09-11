# Native RPC, fetch upgrades, and the rpc-stub fetch transport

## Decision

Do **not** replace `packages/v4/project-worker/src/fetch/rpc-stub-fetch.ts`
with an ordinary native Workers-RPC method today. Keep the fetch/upgrade leg
and its pager ownership model.

There is one useful distinction behind that conclusion:

- Cap'n Web 0.12.2 already transports an upgrade `Response` across its own RPC
  session, so it is not the remaining blocker.
- The boundary between the edge relay and the context Durable Object is native
  Workers RPC. In inspected workerd revision `c4e03fa1d`, response serialization
  rejects `Response.webSocket` as non-serializable. That
  is precisely the return leg that the transport avoids.

Consequently, changing the relay's `LentRpcStub.fetch()` to return a genuine
`Response` over its native RPC call would preserve the surface types but fail
for a 101 with `DataCloneError`. A socketless response is not evidence that
the substitution is safe.

## What the platform supports

`fetch(Request) -> Response` is a special method on a `WorkerEntrypoint` or a
`DurableObject`; it is Fetch API transport, not an ordinary RPC method. A
call such as `stub.fetch(request)` therefore is the supported way to forward a
real upgrade. Cloudflare documents this distinction in [Workers RPC reserved
methods](https://developers.cloudflare.com/workers/runtime-apis/rpc/reserved-methods/),
and the [workerd reserved-method implementation](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/src/workerd/api/worker-rpc.c%2B%2B#L2095-L2113)
makes the same split.

The native serialization implementation in the workerd revision inspected
(`c4e03fa1d`) says that it will try to serialize `Response.webSocket`, but
that “WebSocket is not serializable” and support may be added in the future.
See [the exact implementation](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/src/workerd/api/http.c%2B%2B#L1351-L1379).
A response carrying a WebSocket also must be a 101, which
[workerd enforces](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/src/workerd/api/http.c%2B%2B#L1057-L1063).

This matches Cloudflare's documented hibernating-DO shape: accept the DO-side
socket from `fetch()` and return `new Response(null, { status: 101, webSocket
})`; the front Worker forwards with `return stub.fetch(request)`. See [Use
WebSockets / hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/#how-hibernation-works).

## What Cap'n Web changes—and does not

The pinned project dependency is `@iterate-com/capnweb@0.12.2`. It supports
an upgrade response over _Cap'n Web_: `Response.webSocket` is represented as a
readable/writable stream pair. The Iterate fork's [wire
specification](https://github.com/iterate/capnweb/blob/f6cd6863d5554a2964c1396bab2274359a45e037/protocol.md#L205-L213)
defines the scope: only a WebSocket on an upgrade `Response` is serializable;
a bare `WebSocket` is not. The stream representation carries application
messages and close information, but not WebSocket control ping/pong frames.

That means the client-capnweb half of the existing design is capable of
receiving the provider's 101. It does **not** change the next hop:

```text
client Cap'n Web session -> edge relay --native Workers RPC--> context DO
                                      ^
                         Response.webSocket cannot cross here
```

`rpc-stub-fetch.ts` takes the socket while it is legally available in the
relay, creates a separate real-fetch upgrade back to the DO, and returns only
a marker over that native RPC call. The DO then connects the browser-facing
pair to the upgrade leg. This is why its own header calls both limitations
delete-day workarounds, and why simply using the current Cap'n Web feature
does not remove the module.

The repository also pins the native limitation with a real 101 provider:
[`ws-fetch-live-101.test.ts`](../packages/v4/project-worker/__workers-tests__/ws-fetch-live-101.test.ts)
records `DataCloneError` on the relay-to-DO RPC return before the fetch-upgrade
lane existed. The focused native-vs-Cap'n-Web coverage is the most relevant
local regression proof, rather than a type-level substitution.

## Hibernation and teardown constraints

The present split is doing more than adapting a value type.

1. A context DO retains only hibernatable pager WebSockets while idle; a
   borrowed native RPC stub is returned at quiescence. Keeping a client
   capability or an outgoing socket in the DO would change that property.
2. Cloudflare states that hibernation is supported only when the DO is the
   WebSocket server. Outgoing WebSockets do not hibernate; they keep a DO
   resident (subject to the documented maximum) and accrue idle duration.
   See [the WebSocket guidance](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
   and [the lifecycle rules](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/).
3. Native RPC capabilities are session-scoped. Workerd completes a server
   session only once no capabilities point between its client and server, and
   cancellation revokes them specifically to avoid relying on eventual GC.
   See [completion](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/src/workerd/api/worker-rpc.c%2B%2B#L2155-L2165)
   and [cancellation](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/src/workerd/api/worker-rpc.c%2B%2B#L2189-L2219).

Those rules justify the existing explicit `ContextLeaseBook` disposal and the
relay's single `onRpcBroken` ownership. Replacing them with a long-lived
native stub or outbound socket would risk pinning the DO, changing eviction
behaviour, and weakening session-end cleanup.

## Inert SDK result ownership (v10 deployed; evidence remains inconclusive)

There is a separate native-RPC lifetime concern for the SDK's two internal,
known-inert stream operations: processor `append` and paged `readEvents`.
This does **not** authorize disposal for arbitrary loaded-worker code or for
results that may deliberately carry a live capability.

The relevant upstream ownership distinction is precise. Disposing a resolved
[`JsRpcStub`](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/src/workerd/api/worker-rpc.c%2B%2B#L746-L754)
clears that stub's client/channel. It is different from disposing the native
call promise: a resolved
[`JsRpcPromise`](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/src/workerd/api/worker-rpc.c%2B%2B#L236-L256)
retains its final result and its disposer invokes the final result's disposer.

An inner RPC page can already have a `Symbol.dispose` marker even after its
inner operation completed. When native RPC serializes that plain object, it
extracts the marker and reports `hasDisposer` ([serializer](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/src/workerd/api/worker-rpc.c%2B%2B#L1674-L1722)).
The caller then retains the outer `callPipeline` until that returned object's
disposer runs ([deserialization](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/src/workerd/api/worker-rpc.c%2B%2B#L149-L180));
the [RPC contract](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/src/workerd/io/worker-interface.capnp#L817-L832)
states that lifetime directly.

Our primary inference is therefore that disposing only an awaited `get()`
stub can leave an outer `readEvents`/`append` result pipeline alive. The
smallest candidate correction is to await each known-inert operation, retain
its payload, and dispose its **call promise** in `finally`, before returning
the retained plain payload; the existing `using` still disposes the root
stub. This is deliberately not a blanket disposer policy.

Deployment nine is negative evidence, not a fix claim: the explicit resolved
stub release removed small-call root leaks but the public 144 MiB catch-up
still retained roots and reset for memory. Deployment ten is no longer pending:
the scoped call-result-ownership change is deployed and has a complete five-case
public resource-suite pass. Repeated v10 failures nevertheless remain unexplained;
there is no allocation proof or fix claim from those passes.

## What the observed reset message establishes

The v10 error `Durable Object reset because its code was updated` does not
uniquely establish an application deployment. Cloudflare documents replacement
after network partitions and software updates, including Workers-system updates;
starting `wrangler tail` or dashboard logs itself requires a software update.
No live tail should be introduced during a controlled comparison.
[Official known issues](https://developers.cloudflare.com/durable-objects/platform/known-issues/#global-uniqueness).

The [lifecycle documentation](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/#shutdown-behavior)
also lists runtime placement decisions as shutdown causes. These are possible
alternatives, not demonstrated explanations for our failures. An unchanged
deployment version rules out only an application-version change, not all
runtime changes.

The inspected open-source workerd revision contains no exact emitter for that
literal. Its actor contract explicitly places some code-update and memory-limit
brokenness outside the actor implementation, in worker-set or process-sandbox
code. [Pinned actor contract](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/src/workerd/io/worker.h#L981-L986).
The local exception decoder preserves remote JSG messages and derives
`durableObjectReset` from the `broken.` prefix; `retryable` comes from the
native disconnected classification. Neither identifies an allocation failure
or the specific update responsible.
[Message decoding](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/src/workerd/jsg/exception.c%2B%2B#L26-L128),
[error flags](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/src/workerd/jsg/util.c%2B%2B#L190-L231).

Closing this diagnosis needs correlated runtime/placement or allocation evidence,
not a retry wrapper or another uncorrelated green sample. The failed operations
and stalled append in the [preview record](preview-proof.md) remain unclassified.

## Safe simplification boundary and exit criteria

The supported simplification is narrow: use native `stub.fetch(request)` only
where the _entire_ provider-to-caller route is already a native fetch channel
and no WebSocket-bearing response must cross a normal Workers-RPC result. It
does not cover a lent client capability behind the edge relay, nor the current
dynamic-provider path.

Delete the fenced transport only after all of the following are demonstrated
against the deployed workerd compatibility date:

1. A native Workers-RPC method can round-trip a 101 `Response.webSocket`
   across the relay-to-DO boundary (not merely a Cap'n Web session).
2. The returned socket can complete the browser-facing upgrade and preserve
   text, binary, close code/reason, and error behaviour.
3. A hibernation test proves the DO releases borrowed RPC stubs at quiescence,
   remains hibernatable with an attached client, and restores its attachment
   after eviction.
4. A session teardown test proves browser close, Cap'n Web break, replacement
   pager, and explicit dispose each recall the correct lease without retaining
   a cross-session capability.

Until (1) becomes true, the fetch-upgrade leg is required behaviour, not
accidental complexity.
