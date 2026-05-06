# Review: RPC platform capabilities report

Reviewed report: `apps/os2/tmp/codemode-capnweb-research/01-rpc-platform-capabilities.md`

First-party sources checked:

- Cloudflare Workers RPC overview: https://developers.cloudflare.com/workers/runtime-apis/rpc/
- Workers RPC lifecycle: https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/
- Workers RPC visibility/security: https://developers.cloudflare.com/workers/runtime-apis/rpc/visibility/
- Workers RPC reserved methods: https://developers.cloudflare.com/workers/runtime-apis/rpc/reserved-methods/
- Workers RPC error handling: https://developers.cloudflare.com/workers/runtime-apis/rpc/error-handling/
- Workers compatibility flags, especially `rpc_params_dup_stubs`: https://developers.cloudflare.com/workers/configuration/compatibility-flags/
- Durable Object RPC invocation: https://developers.cloudflare.com/durable-objects/best-practices/create-durable-object-stubs-and-send-requests/
- Durable Object lifecycle: https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/
- Durable Object error handling: https://developers.cloudflare.com/durable-objects/best-practices/error-handling/
- Workers placement docs: https://developers.cloudflare.com/workers/configuration/placement/
- Dynamic Workers bindings: https://developers.cloudflare.com/dynamic-workers/usage/bindings/
- Dynamic Workers API reference: https://developers.cloudflare.com/dynamic-workers/api-reference/
- Kenton Varda, JavaScript-native Workers RPC blog: https://blog.cloudflare.com/javascript-native-rpc/
- Kenton Varda and Steve Faulkner, Cap'n Web blog: https://blog.cloudflare.com/capnweb-javascript-rpc-library/
- Cloudflare Cap'n Web README: https://github.com/cloudflare/capnweb

## 1. Strongest steel-man of the report's best design ideas

The report's best idea is the hard split between durable JSON events and live RPC values. That split is exactly the right shape for codemode. Cloudflare Workers RPC can carry values that are not representable in an event log: functions by reference, `RpcTarget` instances by reference, stubs, `Request`, `Response`, and byte-oriented streams. The local stream durable object persists event payloads with `JSON.stringify`, so the event stream can be an audit/replay/UI channel, but it cannot honestly be the transport for a live stream, callback, stub, or capability. Treating those as two separate planes prevents a category error.

The second strong idea is capability facades. Dynamic Workers are specifically designed around passing constrained bindings to untrusted code, and Cloudflare's Dynamic Workers docs frame custom bindings as arbitrary Workers RPC interfaces granted to the sandbox. The current `CodemodeSessionCapabilityTarget` and `CodemodeLoggerTarget` shape is directionally correct: give generated code a tiny object surface, not `env`, not a namespace, not a registry, and not a generic "call anything" descriptor unless that broad authority is intentional.

The third strong idea is avoiding remote JavaScript `Proxy` as a platform value. The ergonomic proxy should be local sugar in the receiving isolate. The object crossing the RPC boundary should be a concrete `RpcTarget`, function, stream, `Response`, or structured-clone value. That makes the design line up with the platform instead of relying on undocumented serialization behavior.

The fourth strong idea is using result handles for non-trivial results. An immediate `executeScriptAndWait()` return is fine for a one-shot Worker-to-Worker/DO caller, but a `CodemodeResultHandle extends RpcTarget` is the more honest abstraction when the result is a capability, a stream factory, or a multi-step operation surface. It also gives us a place to put explicit disposal, runtime validation, summaries, and durable rehydration rules.

## 2. Heavy criticism and risks

The report is too optimistic about "Workers RPC / Cap'n Web" as one undifferentiated thing. Workers built-in RPC and the pure TypeScript `capnweb` library are intentionally compatible, but not identical. The Cap'n Web README says the feature sets are not exactly the same: pure Cap'n Web does not support all Workers RPC types, while Workers RPC supports aliases/cycles and currently lacks some Cap'n Web promise-pipelining features such as putting `RpcPromise` values in params and `.map()`. A codemode architecture doc must say which runtime path is being used: built-in Workers RPC between Workers/DOs/Dynamic Workers, or Cap'n Web over HTTP/WebSocket to browsers and non-Workers clients.

The report underplays compatibility-date semantics. The local Dynamic Worker code uses `compatibilityDate: "2025-06-01"`. As of Cloudflare's compatibility flag docs, `rpc_params_dup_stubs` became the default on `2026-01-20`; before that, Workers RPC transferred ownership for stubs embedded in params. That difference matters exactly for callback/capability forwarding. If codemode forwards stubs through a session, dynamic worker, stateless worker, and DO, old ownership semantics can dispose the thing the eventual recipient thought it had carefully kept. The report should not give generic stub ownership guidance without pinning it to the worker compatibility date and flag set.

The report does not take browser delivery seriously enough. Workers RPC over service bindings and Durable Object stubs is same-account Worker/DO machinery. It does not make a browser UI able to receive a live `RpcTarget` from an existing oRPC/HTTP JSON route. If the product wants the web app to call live result handles, that is a separate Cap'n Web HTTP batch or WebSocket API with authentication, session lifetime, CORS/WebSocket implications, and runtime input validation. Otherwise, the UI gets JSON summaries and durable pointers only.

The report says "capability objects as the permission boundary", but does not fully price that risk. A stub is authority. A callback returned by user code is authority. A `ResultHandle` that can stream bytes or call tools later is authority. Once generated code can retain, return, or forward those handles, the design needs clear revocation, disposal, quota, rate limiting, and "who may call this after the script execution ends?" semantics. Object-capability security removes ambient authority; it does not remove the need to design capability lifetime.

The event schema implications are too soft. If event payloads are JSON, then `payload.result: unknown` is a trap. `JSON.stringify(new Response(...))` can become a misleading empty object; `JSON.stringify(RpcTarget)` will not preserve authority; cycles throw; functions vanish in objects. The schema should make impossible states impossible: JSON result snapshots should be validated as JSON-compatible, and live results should be represented by explicit descriptors, not by stuffing `unknown` into persisted events.

The proposed result handle can accidentally promise persistence it does not provide. A plain in-memory `RpcTarget` returned from a DO is tied to stub lifetime and the DO instance lifecycle. Durable Objects can hibernate or be evicted; exceptions can break stubs; callers may disconnect at execution-context boundaries. If a handle must survive reconnects, it needs durable backing and a method that recreates a fresh live stream/capability from durable state. Otherwise call it an ephemeral live handle and keep it out of durable event semantics.

The report leans on RPC-supported rich values but does not demand enough runtime validation. Cap'n Web's own blog says TypeScript gives compile-time ergonomics, not runtime checks. Generated or malicious code can pass bad shapes to capability methods. Every public `RpcTarget` method that crosses a trust boundary needs Zod or equivalent validation for inputs and explicit output contracts where the event log consumes the result.

The placement discussion is not stable enough for architectural dependence. The report says Smart Placement is ignored for RPC calls and that a service-binding callee runs locally on the same machine as the caller. Current placement docs say placement does not affect RPC methods or named entrypoints, but the same page also recommends service bindings with type-safe RPC to a placed backend and says the backend method runs near the database. That inconsistency means the design should not rely on "same machine as caller" as a hard platform guarantee without direct Cloudflare confirmation.

## 3. Factual corrections against first-party docs

RPC availability: correct, but incomplete. Workers RPC is available with compatibility date `2024-04-03` or the `rpc` flag, per the Workers RPC docs and compatibility flags page. The report should additionally call out `rpc_params_dup_stubs`, default as of `2026-01-20`, because codemode's local Dynamic Worker compatibility date is currently older than that.

Stub ownership: the report's "passing a stub over RPC transfers ownership to the recipient" is no longer generally correct for current compatibility dates. Cloudflare's compatibility flags page says `rpc_params_dup_stubs` changes stubs embedded in RPC params to be duplicated instead of transferred, matching Cap'n Web behavior. The old transfer model still matters for workers pinned before `2026-01-20` or using `rpc_params_transfer_stubs`.

Workers RPC vs Cap'n Web supported values: the report's structured-clone discussion is accurate for Workers RPC, but should not be applied wholesale to pure Cap'n Web. The Cap'n Web README says, as of its writing, Cap'n Web does not support `Map`, `Set`, `ArrayBuffer`, typed arrays other than `Uint8Array`, `RegExp`, or cyclic values, while Workers RPC supports more of the structured clone family and aliases/cycles. If browser-facing Cap'n Web is in scope, this matters.

Streams: correct for Workers RPC that only byte-oriented streams are supported. But pure Cap'n Web's README describes stream support more broadly, including arbitrarily typed chunks. The architecture should choose the stricter common denominator when a value may cross both systems, or explicitly branch by transport.

Promise pipelining: correct in spirit, but the report should be precise. Kenton's Workers RPC blog says RPC promises are thenables and proxies that support speculative calls on the eventual result. The Cap'n Web README adds features that Workers RPC does not fully match, including passing `RpcPromise` values in parameters and `.map()`. Do not design codemode around Cap'n Web-only pipelining features unless that path uses the Cap'n Web library rather than built-in Workers RPC.

Durable Object RPC: correct that public methods on classes extending `DurableObject` are exposed through `DurableObjectStub`, and creating a stub does not instantiate the object. Add the DO error-handling correction: many exceptions leave a `DurableObjectStub` broken, so callers should recreate the stub after exceptions; `.retryable` and `.overloaded` need different retry behavior.

Reserved methods: correct that `fetch()` has Fetch API semantics on `WorkerEntrypoint` and `DurableObject`, not ordinary RPC semantics. Also note that `connect()` is reserved on `WorkerEntrypoint`, and `alarm`, `webSocketMessage`, `webSocketClose`, and `webSocketError` are disallowed only on `WorkerEntrypoint`/`DurableObject`, not `RpcTarget`, per the reserved methods docs.

Visibility: mostly correct. Cloudflare's visibility docs say private class fields are not exposed, class/prototype methods and getters are exposed, instance properties are not exposed for `RpcTarget`/`WorkerEntrypoint`/`DurableObject`, and plain objects pass own properties by value. The report should add the TypeScript caveat from Cap'n Web docs: TypeScript `private` is erased and is not a security boundary; JavaScript `#private` is.

Dynamic Workers bindings: correct that custom bindings are arbitrary RPC interfaces passed through `env`. The API reference also says `env` can contain structured clonable types and service bindings, including loopback bindings from `ctx.exports`; `globalOutbound: null` blocks both `fetch()` and `connect()`. The current report's praise for narrow loader-owned bindings is strongly supported by first-party docs.

Placement: needs correction or at least a footnote. The statement "Service Binding runs locally on the same machine as the caller" is not a safe factual claim against the current placement docs. The docs simultaneously state placement does not affect RPC methods/named entrypoints and provide an RPC service-binding example where the backend runs near the database. Mark this as unresolved platform behavior, not a premise.

## 4. Implications for codemode event schemas and live RPC values

Codemode events should be JSON contracts, not `unknown` bags. A persisted event can contain `scriptExecutionId`, `functionCallId`, provider path, JSON input snapshot, JSON result snapshot, error summary, log text, timing, and a live-result descriptor. It must not claim to contain the live value.

Use an explicit result representation:

```ts
type CodemodePersistedResult =
  | { kind: "json"; value: JsonValue }
  | { kind: "text"; value: string }
  | { kind: "omitted"; reason: "non-json" | "too-large" | "sensitive" }
  | { kind: "live-rpc"; handleId: string; summary?: JsonValue };
```

The `handleId` above must not be treated as a reified RPC stub. It is either an ephemeral correlation ID for the live RPC response returned in the same call, or it names durable backing from which a future call can create a fresh handle. If there is no durable backing, the event should say `lifetime: "ephemeral"` or omit a handle ID entirely and only record a summary.

Live RPC return values should flow only through live RPC methods. For internal callers, that can be a Workers RPC method such as `executeScriptAndWait()` returning `{ eventOffset, result }` or `{ eventOffset, handle }`. For browsers, it must be a Cap'n Web endpoint if live handles are required. Existing JSON adapters, event logs, queues, and oRPC routes should be treated as snapshot-only.

Provider function-call events should separate the provider's live return from the audit event. Today the dynamic worker path calls `CodemodeSessionCapabilityTarget.callFunction()`, which appends and consumes `function-call-requested` and returns an event. That is not a rich result transport unless the processor's return path bypasses event JSON. If the tool result can be a `Response`, stream, function, or `RpcTarget`, the processor must return it over RPC and append only a JSON summary event.

Every event append path should reject non-JSON payloads before SQLite persistence. Relying on `JSON.stringify` at insert time produces lossy and misleading behavior. A `Response` can look like `{}`; functions disappear from objects; custom classes lose prototypes; cyclic graphs throw. The schema boundary should fail early with a clear "live value cannot be persisted" error or replace it with an explicit `omitted` descriptor.

Callback/capability values need lifetime metadata. A live handle should define whether it is one-shot, scoped to the current script execution, scoped to a browser session, or durably recreatable. It should also define disposal behavior. Cloudflare's lifecycle docs are explicit that stubs pin remote objects until disposal or execution-context cleanup.

Compatibility settings become part of the schema/runtime contract. If callbacks or stubs appear in params, codemode should require compatibility date `2026-01-20` or the `rpc_params_dup_stubs` flag on every relevant worker/dynamic worker, or else duplicate stubs deliberately and test old transfer behavior. The current `compatibilityDate: "2025-06-01"` dynamic worker setting is a concrete risk.

## 5. Revised recommendation

Adopt the report's two-channel architecture, but narrow the claim:

1. Use Workers built-in RPC for live rich values between os2 Workers, Durable Objects, and Dynamic Workers. Do not route live values through persisted events, queues, oRPC JSON, or HTTP JSON.
2. Keep the codemode event stream as JSON-only telemetry/replay. Add explicit event payload shapes for JSON snapshots and omitted/live result descriptors.
3. Introduce a small `CodemodeLiveResultHandle extends RpcTarget` only where there is an actual live RPC caller. Methods should be intentionally narrow, for example `getJsonSummary()`, `asResponse()`, `streamBytes()`, or domain-specific methods. Do not expose a generic unwrap-anything API to untrusted code.
4. For browser live interactivity, design a separate Cap'n Web WebSocket or HTTP batch endpoint with in-band authentication returning a session capability. Do not assume the existing app router can receive Workers RPC stubs.
5. Move all cross-boundary capability methods behind runtime validators. TypeScript interfaces are documentation and compile-time help; they are not a security boundary.
6. Update or explicitly flag Dynamic Worker compatibility for stub forwarding. Prefer `compatibilityDate >= "2026-01-20"` or `compatibilityFlags: ["nodejs_compat", "rpc_params_dup_stubs"]` if the surrounding worker dates cannot move yet.
7. Prove the edge cases with platform tests before changing product semantics: JSON event rejection for live values, `Response` return over RPC, byte stream return over RPC, function callback return, `RpcTarget` handle disposal, custom class rejection, proxy non-transport, and stub forwarding under the chosen compatibility date.

Net: the report has the right architectural instinct, but it needs less "RPC can carry weird things" enthusiasm and more transport specificity. The durable event log should become stricter, not more magical. Live RPC should be an explicit capability path with documented lifetime, compatibility-date assumptions, and a separate browser story if the UI needs to participate.
