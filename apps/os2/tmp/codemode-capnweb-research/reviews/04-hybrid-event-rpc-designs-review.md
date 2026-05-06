# Review: 04 Hybrid Event/RPC Designs

Date: 2026-05-06

## 1. Strongest steel-man

The report is strongest where it refuses the false choice between event sourcing and Workers RPC. Durable stream events should record product facts; live Workers RPC / Cap'n Web values should remain live object references. That separation matches the platform. Cloudflare Workers RPC is JavaScript-native RPC for Workers and Durable Objects, and it can pass structured-clone values plus functions, `RpcTarget` instances, streams, `Request`, `Response`, and RPC stubs: <https://developers.cloudflare.com/workers/runtime-apis/rpc/>. Kenton's Workers RPC post makes the same point in product language: byte streams can cross RPC with flow control, calls can be pipelined, and the security model is object-capability based: <https://blog.cloudflare.com/javascript-native-rpc/>.

The report's best recommendation is therefore directionally right: keep `function-call-requested` and `function-call-completed` as durable telemetry, and do not try to serialize unforgeable authority into those events. The Cap'n Web post explicitly says functions and `RpcTarget` objects are passed by reference, with callbacks and returned session objects becoming stubs: <https://blog.cloudflare.com/capnweb-javascript-rpc-library/>. Cloudflare's RPC visibility docs say the security model only permits invoking objects/functions for which a stub was explicitly received: <https://developers.cloudflare.com/workers/runtime-apis/rpc/visibility/>. That is exactly why a stream event may mention that a capability existed, but should not itself be the authority to invoke it.

The local code also supports the report's broad shape. `packages/shared/src/stream-processors/codemode/contract.ts` already defines the durable pair:

- `events.iterate.com/codemode/function-call-requested`
- `events.iterate.com/codemode/function-call-completed`

and the reducer joins them by `functionCallId`. `apps/os2/src/durable-objects/codemode-session.ts` already passes narrow `RpcTarget` facades (`CodemodeSessionCapabilityTarget`, `CodemodeLoggerTarget`) into a Dynamic Worker instead of handing generated code broad ambient bindings. That lines up with Dynamic Workers custom binding guidance: the loader should pass scoped RPC interfaces into untrusted code, and the dynamic worker should see only the methods it was granted: <https://developers.cloudflare.com/dynamic-workers/usage/bindings/>.

The report is also right to reject durable `Callable` descriptors as a way to preserve Cap'n Web identity. A descriptor can be a re-resolution recipe. It is not "this exact provider object returned from this exact call." The local PoC says the same thing: the working shape is a fresh narrow `RpcTarget` facade; a serializable callable can name ambient authority but cannot carry live object authority.

## 2. Heavy criticism and risks

The proposed `resultRef` is the dangerous center of the design. The report says it is only a correlation handle, not authority, but then proposes `resolveResultRef({ functionCallId, resultRef })`. That can easily become a bearer-token API by accident. If the resolver accepts a client-supplied `capabilityId` / `streamId` and returns the live object, the durable event stream has effectively become an authority index. Cap'n Web's security property is possession of a live stub, not knowledge of an ID. The design must make that impossible, not merely warn against it.

The live registry is hand-waved. Workers RPC lifecycle docs say returned `RpcTarget` objects are pinned while the client-side stub exists and should be explicitly disposed; execution contexts may be extended until stubs are disposed, and `dup()` is needed when ownership has to be retained while passing a stub elsewhere: <https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/>. A session-local registry therefore needs concrete rules for ownership, TTL, disposal, duplicate handles, broken stubs, stream cancellation, and DO restart. "Expire with the execution/session" is not enough. A leaked registry entry can pin memory; an over-eager expiry can break a still-valid caller; a DO restart erases in-memory handles regardless of what the event says.

The report underplays error semantics. Workers RPC propagates standard Error `message` and prototype `name`, but not stack traces or own properties such as `cause`; `AggregateError` is not propagated as such: <https://developers.cloudflare.com/workers/runtime-apis/rpc/error-handling/>. Durable Object errors add `.retryable`, `.overloaded`, and `.remote` signals, and Cloudflare recommends recreating a `DurableObjectStub` after many exceptions because the stub can become broken: <https://developers.cloudflare.com/durable-objects/best-practices/error-handling/>. A live result resolver must define how these failures are surfaced in events and whether a failed live resolution appends a new event. Otherwise the UI sees `resultRef` and no durable explanation for why resolution failed.

The schema still blurs "durable output" and "live value." `outcome.output?: Jsonish` sounds like a durable value, but the current contract uses `z.unknown()` and `StreamDurableObject.append()` persists payloads with `JSON.stringify(event.payload)`. That means Dates become strings, Maps/Sets collapse, cyclic structures throw, streams/stubs/functions disappear or fail, and `undefined` object properties are dropped. Calling it `Jsonish` is stricter than local code, but the report does not require a JSON parser/validator at the append boundary. It should. If the event plane is durable, its schema should be JSON-only by construction.

The report is too optimistic about returning live results through the current codemode path. In shared code, `createProcessorSession().callFunction()` appends a request and waits for a matching completion, then returns `outcome.output`. In OS2, `processorStreamApiFromNamespace().subscribe()` throws because processors receive live events through `afterAppend` RPC, and `CodemodeSession.callFunction()` currently appends and consumes a `function-call-requested` event but does not return the provider's completed output. There is no current live-result lane or resolver. Option 2 is an architecture direction, not a small schema extension.

The browser/API boundary is missing. Workers RPC stubs are internal Worker/DO/Dynamic Worker values. A browser using oRPC/HTTP JSON cannot receive a Cloudflare `RpcTarget` stub, Durable Object stub, or Service Binding stub through normal JSON. Cap'n Web can run over WebSocket/HTTP with its own protocol, but that is a separate browser-facing RPC server surface, not the same thing as Workers service binding RPC. If UI needs to inspect a live stream or capability, the design must say whether OS2 exposes a Cap'n Web session, an HTTP stream endpoint, an artifact URL, or a JSON-only summary.

Workflows are only an adjacent primitive here. Cloudflare Workflows provide durable steps, retries, sleep, event waits, and persisted state: <https://developers.cloudflare.com/workflows/>. Their limits include 1 MiB event payloads, 1 MiB non-stream step results, persisted state limits, step-count limits, and Workflow deployment constraints: <https://developers.cloudflare.com/workflows/reference/limits/>. That supports the report's "durable continuation is a separate plane" idea, but it does not help preserve live RPC stubs across sleeps. If a live `resultRef` must survive minutes/weeks, it must be re-created from durable state and re-authorized, not retained as an in-memory capability.

## 3. Factual corrections against docs/local code

- `output` is not optional in the local successful outcome schema. `CodemodeOutcome` in `packages/shared/src/stream-processors/codemode/contract.ts` is `{ status: "succeeded"; output: z.unknown() }`, not `{ output?: unknown }`. Making `output` optional is a schema change and will affect reducers/tests/renderers.

- The local payloads are not currently JSON-safe despite being persisted as JSON. `GenericEventPayload` accepts any non-array object, codemode outcome values are `z.unknown()`, and `StreamDurableObject.append()` does `JSON.stringify(event.payload)` before inserting JSON into SQLite. The report should distinguish "current permissive runtime type" from "desired durable JSON value."

- The report says the processor appends a request, waits for completion, and returns output. That is true of `packages/shared/src/stream-processors/codemode/implementation.ts`, but not of `apps/os2/src/durable-objects/codemode-session.ts`'s public `callFunction()`, which appends/consumes only `function-call-requested` and returns the appended event. The OS2 Dynamic Worker path uses the shared processor session internally, but the DO's direct RPC method is not the same API.

- The PoC event names are not the current shared contract. `apps/os2/tmp/codemode-rpc-providers-poc/codemode-events.ts` uses `script-execution-succeeded`, `script-execution-failed`, `tool-function-call-requested`, `tool-function-call-succeeded`, and `tool-function-call-failed`, with `executionId` / `callId` language in the working notes. The shared contract uses `script-execution-completed`, `function-call-requested`, `function-call-completed`, `scriptExecutionId`, and `functionCallId`. The report picks the shared contract, but should explicitly mark the PoC names as obsolete or exploratory.

- Workers RPC supports more than JSON, but only documented supported categories. The docs say custom application class instances / custom prototypes cannot pass by value unless they extend `RpcTarget`; streams are supported with flow control, but only byte-oriented streams; stream ownership transfers to the recipient; the 32 MiB serialized RPC limit remains for non-stream values: <https://developers.cloudflare.com/workers/runtime-apis/rpc/>.

- Visibility is narrower than "returned object becomes a stub." For `RpcTarget`, `WorkerEntrypoint`, and `DurableObject`, class methods/getters are exposed; instance properties are private over RPC even without `#`; plain objects are by-value and expose own properties; function own properties are visible asynchronously: <https://developers.cloudflare.com/workers/runtime-apis/rpc/visibility/>. Facade design needs explicit class-level methods, not instance-assigned methods.

- Durable Object RPC is the preferred invocation style for new projects, and public methods on a class extending `DurableObject` are exposed as RPC methods: <https://developers.cloudflare.com/durable-objects/best-practices/create-durable-object-stubs-and-send-requests/>. However, the local PoC's `DataCloneError` for passing the literal `CodemodeSession` DO stub from inside the session should remain a local runtime finding, not a platform rule that no DO stub can ever be forwarded.

- Cap'n Web is JSON-protocol-based but not "plain JSON persistence." The blog describes JSON with preprocessing for supported types and RPC references, export/import tables, connection-local IDs, promise pipelining, and no runtime TypeScript enforcement: <https://blog.cloudflare.com/capnweb-javascript-rpc-library/>. The README also calls out that WebSocket mode is long-lived, HTTP batch references break after the batch, `onRpcBroken()` exists, and malicious clients can send unexpected types: <https://github.com/cloudflare/capnweb>.

- Dynamic Workers custom bindings should be modeled as RPC stubs created by the loader, commonly using `ctx.exports` / `WorkerEntrypoint` and scoped props. Cloudflare says `ctx.props` is authentic because only deploy-authorized configuration can set it, and it can configure an RPC interface for a specific resource: <https://developers.cloudflare.com/workers/runtime-apis/context/>. That is stronger than an event-carried provider descriptor and should be the preferred source of authentic scope when available.

## 4. Event schema critique including resultRef/capability IDs/callbacks/streams

The event schema needs a bright line: every durable event payload must be JSON, and every live value must be returned or invoked on the RPC plane. Today the proposed schema lets `output?: unknown` and `summary?: unknown` carry anything. That is an attractive nuisance. The durable schema should say `JsonValue` / `JSONObject`, validate it, and fail fast or summarize when a result is not JSON-safe.

`resultRef` should not contain a client-replayable authority token. If retained, it should be a receipt:

```ts
type LiveResultReceipt = {
  kind: "capability" | "stream";
  refId: string;
  summary: JsonValue;
  expiresAt: string;
};
```

and the resolver should not trust the receipt as authority. Resolution should require the caller to already hold the exact session/call capability minted for this execution graph, and the server should look up by `(sessionId, scriptExecutionId?, functionCallId, refId)` in an in-memory registry whose entries also record owner, kind, createdAt, expiresAt, disposal state, and permitted operations. Passing only `{ functionCallId, resultRef }` is too weak.

`capabilityId` is the wrong name if the ID itself is not a capability. Call it `refId`, `receiptId`, or `liveResultId`. "Capability ID" teaches future implementers the wrong lesson and will become ambient authority under deadline pressure.

Callbacks should almost never appear as durable IDs. The receiving actor should get the actual callback function/stub over Workers RPC or Cap'n Web. The request event should record only a summary such as `{ "$live": "callback", "label": "onProgress" }`. If callback invocations are product-visible, append first-class invocation/progress events. Do not put `callbackId` in an event and later let unrelated actors call it; that converts a passed reference into an addressable RPC service.

Streams need two distinct cases:

- Live stream: return `ReadableStream<Uint8Array>` or `Response` on the RPC plane, record a JSON receipt and summary in the event. This is ephemeral; if the live reader misses it, it is gone.
- Durable artifact stream: tee/clone/upload to R2 or another artifact store, record an artifact ref, byte count/checksum/media type, and retention policy. This is replayable, but no longer the same live stream.

The current `resultRef: { type: "stream", streamId }` does not say which case it is. That ambiguity will break UI expectations.

`Request` and `Response` should not be casually summarized. Headers may contain cookies, auth, internal routing, or PII. The event schema should require an allowlist for headers, URL redaction rules, and body handling rules. Default summary should be status, method, redacted URL/path, media type, and maybe byte count/checksum if known.

Nested calls need more than `scriptExecutionId` eventually. The report defers `parentFunctionCallId`, but callbacks and provider-to-provider calls are exactly where causal trace matters. It is acceptable to omit it from v1, but then the recommendation should say that nested visualization and cancellation cannot be built from v1 alone.

Finally, result refs should apply consistently to script execution outcomes too, not only function-call outcomes. The current executor can return a live value from user code just as easily as a tool can return one. If the schema only supports function-call `resultRef`, then top-level `return new Response(...)` or `return new RpcTargetFacade()` has no durable live-result receipt.

## 5. Revised recommendation

Adopt the report's Option 2 only after tightening it substantially:

1. Keep the shared `function-call-requested` / `function-call-completed` event pair and discriminated `outcome`.
2. Make durable event payload fields JSON-only by schema, not just by convention.
3. Rename `resultRef` to something like `liveResult` or `liveResultReceipt`, and rename `capabilityId` to `refId` unless the ID is intentionally a bearer capability.
4. Require `summary` and `expiresAt` on every live-result receipt.
5. Resolve live results only through a live session/call-scoped `RpcTarget` that already embodies authorization; never from a bare event ID or bare ref ID.
6. Add the same live-result receipt shape to script execution completions.
7. Treat streams as either ephemeral live RPC streams or durable artifact refs; do not pretend one `streamId` means both.
8. Keep callbacks strictly live. Log callback invocations as events only when they are user-visible.
9. Add a registry/disposal design before adding schema fields: owner, scope, TTL, disposal, broken-stub handling, DO restart behavior, and audit events for failed resolution.
10. Leave `Callable` descriptors for persisted provider configuration and re-resolution recipes, not returned object identity.

The near-term implementation slice should be narrower than the report proposes: keep JSON-only outcomes in the existing contract, add explicit summaries/artifact refs for non-JSON values, and separately spike a live RPC return path from `CodemodeSessionCapabilityTarget.callFunction()` that returns the actual value to a Dynamic Worker caller while appending only JSON telemetry. Do not add `resolveResultRef()` until there is a concrete access policy and lifecycle registry. The platform gives you object-capability security for free only while you keep authority as live stubs; the moment you turn authority into IDs in an event stream, you own the security model yourself.
