# Cloudflare RPC / Cap'n Web capabilities for codemode tool calls

## Research scope

Question: can codemode tool calls use Cloudflare Workers RPC / Cap'n Web without flattening results into JSON, and what are the platform constraints?

Primary sources:

- Kenton Varda, "We've added JavaScript-native RPC to Cloudflare Workers" (2024-04-05): https://blog.cloudflare.com/javascript-native-rpc/
- Cloudflare Workers RPC docs: https://developers.cloudflare.com/workers/runtime-apis/rpc/
- Workers RPC lifecycle docs: https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/
- Workers RPC visibility/security docs: https://developers.cloudflare.com/workers/runtime-apis/rpc/visibility/
- Workers RPC reserved methods docs: https://developers.cloudflare.com/workers/runtime-apis/rpc/reserved-methods/
- Workers RPC error handling docs: https://developers.cloudflare.com/workers/runtime-apis/rpc/error-handling/
- Durable Object RPC invocation docs: https://developers.cloudflare.com/durable-objects/best-practices/create-durable-object-stubs-and-send-requests/
- Durable Object lifecycle docs: https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/
- Durable Object error handling docs: https://developers.cloudflare.com/durable-objects/best-practices/error-handling/
- Kenton Varda and Steve Faulkner, "Cap'n Web: a new RPC system for browsers and web servers" (2025-09-22): https://blog.cloudflare.com/capnweb-javascript-rpc-library/
- Dynamic Workers docs, especially bindings and loader API: https://developers.cloudflare.com/dynamic-workers/usage/bindings/ and https://developers.cloudflare.com/dynamic-workers/api-reference/

Local code inspected:

- `apps/os2/src/durable-objects/codemode-session.ts`
- `apps/os2/src/codemode/codemode-session-rpc.ts`
- `packages/shared/src/codemode/executor.ts`
- `packages/shared/src/callable/runtime.ts`
- `packages/shared/src/streams/stream-durable-object.ts`
- `apps/os2/tmp/codemode-rpc-providers-poc/README.md`

## Platform facts

Workers RPC is enabled by compatibility date `2024-04-03` or the `rpc` flag. It exposes public methods on `WorkerEntrypoint` classes through Service Bindings, and public methods on `DurableObject` classes through Durable Object stubs. All calls are asynchronous from the caller side, even if the implementation method is synchronous. RPC return values are custom thenables rather than native `Promise` instances, which is how promise pipelining works.

Workers RPC is broader than JSON:

- Nearly all structured-cloneable value types can be parameters or return values. This includes primitives, plain objects, arrays, `Date`, typed arrays, maps/sets in the structured clone family, and cyclic object graphs where the structured clone algorithm supports them.
- Application-defined class instances with custom prototypes cannot be passed by value. To pass an object by reference, the class must extend `RpcTarget`.
- Functions can cross RPC by reference. The receiver gets a stub; calling it performs an RPC back to the origin.
- `RpcTarget` instances cross by reference. The receiver gets a stub exposing class-level methods/getters.
- `ReadableStream`, `WritableStream`, `Request`, and `Response` can cross RPC. Cloudflare documents automatic streaming with flow control for bodies, and explicitly says only byte-oriented streams are supported.
- RPC stubs themselves can be forwarded, including stubs received from a third Worker.

Platform limits and placement:

- The maximum serialized RPC payload is 32 MiB. Use `ReadableStream` / `Response` for larger values.
- Smart Placement is currently ignored for RPC calls. A Worker called through a Service Binding runs locally on the same machine as the caller.
- A `WorkerEntrypoint` class instance is created for each invocation and is stateless beyond that invocation. Persisted/coordinated state belongs in Durable Objects or another storage product.

Important non-examples:

- A JavaScript `Proxy` object should not be treated as a passable RPC value. The local PoC already found this: pass a small `RpcTarget` or callback, then construct ergonomic proxies locally in the receiver.
- Plain application class instances that do not extend `RpcTarget` cannot cross as rich instances; custom prototypes are rejected by RPC serialization.
- Generic JSON persistence, event logs, queues, and oRPC/HTTP JSON adapters will not preserve live RPC identity. They may persist JSON snapshots, but not streams, stubs, callbacks, or object authority.
- `fetch()` on a Service Binding or Durable Object stub is special: it uses Fetch API semantics, not RPC method semantics. The reserved-method docs call out redirect behavior and list disallowed RPC names such as `dup` and `constructor`.

## Capability and visibility model

Workers RPC is object-capability based. A receiver can call only objects/functions for which it has received a stub. Stubs have no useful global identifier and are not forgeable by guessing a name. This is the same model Cap'n Web describes for authenticated session objects: successful auth can return a session stub, and possession of that stub is the authority to call session methods.

Visibility is intentionally narrow:

- Private class fields are not exposed.
- For `RpcTarget`, `WorkerEntrypoint`, and `DurableObject`, class-declared methods/getters are exposed; arbitrary instance properties are not.
- Plain objects are passed by value and expose their own properties.
- Functions passed by reference can expose their own properties asynchronously, though this is usually not a useful interface.

Implication for codemode: use capability objects as the permission boundary. A codemode script or provider should receive a narrow `RpcTarget` facade like `CodemodeSessionCapabilityTarget`, not a broad `env`, Durable Object namespace, or provider registry descriptor unless broad lookup authority is intended.

## Lifetime and disposal constraints

RPC stubs pin remote resources. Cloudflare's lifecycle docs say that while a client-side stub exists, the corresponding remote `RpcTarget` object cannot be collected, so stubs should be disposed explicitly where practical. Wrangler v4 supports `using`, which lowers to `stub[Symbol.dispose]()` in a `finally` block.

Automatic disposal happens at execution-context boundaries. When an event handler or RPC method invocation completes, stubs created in that context are automatically disposed unless they were transferred elsewhere. If a stub must outlive the current handler, the owner needs an explicit lifetime strategy, commonly returning a handle to another caller or duplicating ownership with `dup()`.

Stub ownership matters:

- Passing a stub over RPC transfers ownership to the recipient.
- Use `stub.dup()` when sending the same stub to multiple places.
- Disposing a compound RPC object also disposes stubs embedded in it.

Durable Object-specific constraints:

- Creating a Durable Object stub does not instantiate the object. Invoking a method on the stub starts the lifecycle.
- DOs can hibernate only when no request/event is still processing and other documented conditions are met. In-progress RPC calls keep work live.
- DO shutdown can happen for deployments, runtime updates, inactivity, and placement decisions. In-flight HTTP/RPC requests may finish only under documented conditions.
- Many DO exceptions break the stub; Cloudflare recommends recreating the `DurableObjectStub` after exceptions.

## Structured examples for codemode values

Values that can cross Workers RPC directly:

```ts
const cyclic: Record<string, unknown> = {};
cyclic.self = cyclic;

return {
  text: "ok",
  createdAt: new Date(),
  bytes: new Uint8Array([1, 2, 3]),
  cyclic,
};
```

```ts
return new Response(
  new ReadableStream({
    type: "bytes",
    pull(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      controller.close();
    },
  }),
);
```

```ts
class ResultHandle extends RpcTarget {
  async readChunk() {
    return new Uint8Array([1, 2, 3]);
  }
}
return new ResultHandle();
```

```ts
return async (input: { id: string }) => {
  return await lookup(input.id);
};
```

Values that should not be expected to cross:

```ts
class PlainResult {
  value = 1;
}
return new PlainResult(); // custom prototype, not RpcTarget
```

```ts
return new Proxy({}, {}); // not a documented RPC-serializable type
```

```ts
return JSON.stringify({ result: streamOrStub }); // loses object identity or fails
```

```ts
await stream.append({
  type: "codemode/result",
  payload: { result: streamOrStub },
}); // local stream persists JSON.stringify(payload)
```

## Local codemode observations

Current os2 codemode already uses the right platform primitive in one key place. `createCloudflareCodemodeScriptExecutor()` passes two narrow `RpcTarget` facades into the Dynamic Worker:

- `CodemodeSessionCapabilityTarget` exposes `callFunction()`.
- `CodemodeLoggerTarget` exposes `log()`.

That matches Cloudflare's Dynamic Workers guidance: loader-owned code gives the sandbox only specific RPC bindings/capabilities, often with `globalOutbound: null`.

There are also two result paths with different preservation properties:

- Live RPC path: `entrypoint.evaluate(...): Promise<{ error?: string; result: unknown }>` in `apps/os2/src/durable-objects/codemode-session.ts`. If no intermediate JSON/persistence step touches `result`, Workers RPC can carry structured-clone values plus supported platform objects such as `Response`, byte `ReadableStream`, functions, stubs, and `RpcTarget` handles.
- Durable event path: stream events are persisted by `StreamDurableObject.append()` using `JSON.stringify(event.payload)`. This is useful for audit/UI state, but it is not a live-object transport. A stream event can record a JSON summary, pointer, or durable object name, but not preserve a live stream/callback/stub.

The older shared executor path in `packages/shared/src/codemode/executor.ts` currently serializes tool calls through strings:

```ts
const resJson = await __dispatchers[providerKey].call(JSON.stringify(path), JSON.stringify(args));
const data = JSON.parse(resJson);
return data.result;
```

and `ToolDispatcher.call()` returns `JSON.stringify({ result })`. That design cannot preserve platform objects. It is acceptable for JSON-only tools, but it is the wrong boundary for "weird" Workers values.

The local POC also records one important workerd finding: passing the literal `CodemodeSession` Durable Object stub from inside the session to another DO/dynamic worker failed with `DataCloneError: Could not serialize object of type "DurableObject"`. The working shape was returning or passing a fresh, narrow `RpcTarget` facade over the session.

## Delivering codemode function results without losing platform objects

Use two channels:

1. Durable event channel for JSON telemetry and replay.
2. Live RPC channel for actual rich result delivery.

The live channel can be shaped as one of these patterns.

### Pattern A: immediate RPC result

For a caller that is itself a Worker, DO, or Dynamic Worker, expose a method like:

```ts
async executeScriptAndWait(input: { code: string }): Promise<{
  eventOffset: number;
  result: unknown;
  error?: unknown;
}> {
  // append JSON "requested" event
  // execute dynamic worker
  // append JSON "completed" summary
  // return the live result over Workers RPC
}
```

This preserves any RPC-supported `result` as long as the implementation does not stringify it, store it in SQLite, pass it through an HTTP JSON API, or validate it with a JSON-only schema. The caller should consume or transfer streams promptly; stream ownership transfers to the recipient.

### Pattern B: result handle

For longer-lived or multi-operation results, return a `RpcTarget` handle:

```ts
class CodemodeResultHandle extends RpcTarget {
  constructor(private readonly result: unknown) {
    super();
  }

  async get() {
    return this.result;
  }

  async asResponse() {
    if (this.result instanceof Response) return this.result;
    return Response.json(this.result);
  }
}
```

The initial codemode event can store only `{ scriptExecutionId, resultHandleId? }` or a JSON summary. The live caller receives `CodemodeResultHandle` over RPC and calls methods on it. This keeps the capability explicit and avoids pretending the durable event log owns live platform objects.

Caveat: a plain in-memory `RpcTarget` returned from a DO has lifetime tied to RPC stub disposal and the DO instance lifecycle. If the handle must survive caller disconnects, store durable state separately and let the handle lazily recreate fresh streams/stubs from durable identifiers.

### Pattern C: stream-first result

If output may exceed the 32 MiB serialized RPC limit or is naturally incremental, return a byte-oriented `ReadableStream`, `Response`, or a handle method that creates one:

```ts
class CodemodeResultHandle extends RpcTarget {
  streamBytes(): ReadableStream<Uint8Array> {
    return makeByteStream();
  }
}
```

Cloudflare documents RPC streaming with flow control, ownership transfer, and byte-stream-only support. If the sender also needs a copy, use `ReadableStream.tee()` or `Response.clone()`, accepting the buffering tradeoff documented by Cloudflare.

### Pattern D: callback/capability result

If the tool result is itself an operation surface, return a function or `RpcTarget`:

```ts
class FileCapability extends RpcTarget {
  async read(path: string) {
    return await readScopedFile(path);
  }
}
return new FileCapability();
```

This is the most object-capability-native shape. It grants exactly the returned methods, and nothing else. It is also better than returning a serializable descriptor when the receiver should not gain ambient authority to resolve arbitrary bindings.

## Constraints for browser/UI delivery

Workers RPC and Cap'n Web are not the same as the app's existing JSON/oRPC browser API. A browser cannot receive a Workers `DurableObjectStub`, Service Binding, or internal `RpcTarget` through ordinary JSON. Browser-facing options are:

- Convert the result to HTTP-native objects (`Response`, body stream, file URL, JSON summary) before crossing to the browser.
- Use Cap'n Web directly over WebSocket/HTTP batch if the browser is meant to participate in an RPC session. Cap'n Web supports structured-clone-ish values and RPC stubs, but the Cloudflare blog describes it as new/experimental, and it is a separate protocol surface from Workers internal RPC.
- Keep rich platform objects server-side and expose narrow follow-up RPC/HTTP operations, for example "download result body", "invoke returned action", or "read next event".

## Recommendation

For codemode tool calls, do not make the canonical tool-result boundary JSON. Let provider calls and script execution return `unknown` over Workers RPC, but enforce that dispatch stays on a live RPC path until the final consumer receives the result.

Keep stream events JSON-only and treat them as projections:

- requested/completed status
- duration
- error summary
- inspectable JSON result summary when the result is JSON-safe
- optional durable identifiers for replayable artifacts

When a result might be a `ReadableStream`, `Response`, callback, Durable Object-derived capability, or other stub, return it immediately over RPC or wrap it in a narrow `RpcTarget` handle. Do not put it through `JSON.stringify`, SQLite event persistence, zod JSON schemas, or the current string-based `ToolDispatcher.call()` path.
