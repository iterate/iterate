# Hybrid Event/RPC Designs for Codemode

## Scope

This report proposes a minimal hybrid design for codemode function calls where:

- the durable event stream remains the source of traceability;
- live Workers RPC / Cap'n Web values can still move between running actors;
- persisted events do not pretend to serialize unforgeable capabilities, stubs, or streams.

The local target is the current OS2 codemode stream processor shape in
`packages/shared/src/stream-processors/codemode/contract.ts`, plus the RPC
provider PoC in `apps/os2/tmp/codemode-rpc-providers-poc`.

## Source Grounding

Cloudflare's Workers RPC model is intentionally JavaScript-native: services and
Durable Objects expose methods directly, without a separate router/schema layer.
It supports structured clone values, functions by reference, `RpcTarget` objects
by reference, promise pipelining, byte streams with flow control, and object
capability security. Kenton Varda's Workers RPC post is the best grounding for
the model: a returned object becomes a stub, and a caller cannot invent a
reference it was never given. The Cloudflare docs add the important runtime
details: `RpcTarget` instances are replaced by stubs, byte-oriented streams can
cross RPC with ownership transfer, and stubs can be forwarded through an
introducer worker to a third worker.

Cap'n Web generalizes this into a browser/server protocol. Its README says the
system passes plain JSON-like values by value, while functions and `RpcTarget`
instances become stubs. It also documents that stubs are JavaScript proxies,
can be forwarded again, and have disposal/lifetime concerns. The Dynamic
Workers binding docs sharpen the security point: a stub has no global
identifier, cannot be forged, and is obtained only by being explicitly
received.

Implication for codemode: event payloads should record facts about calls, not
carry live authority. Capability-bearing values must stay in RPC memory and be
represented in events only by explicit summaries or ephemeral correlation IDs.

Sources:

- Cloudflare Workers RPC blog: https://blog.cloudflare.com/javascript-native-rpc/
- Cloudflare Workers RPC docs: https://developers.cloudflare.com/workers/runtime-apis/rpc/
- Cap'n Web blog: https://blog.cloudflare.com/capnweb-javascript-rpc-library/
- Cap'n Web README: https://github.com/cloudflare/capnweb
- Dynamic Workers bindings: https://developers.cloudflare.com/dynamic-workers/usage/bindings/

## Local Grounding

The current shared codemode processor contract already uses the cleanest event
pair:

- `events.iterate.com/codemode/function-call-requested`
- `events.iterate.com/codemode/function-call-completed`

The requested payload has:

```ts
{
  functionCallId: string;
  scriptExecutionId?: string;
  path: string[];
  input: unknown;
}
```

The completed payload has:

```ts
{
  functionCallId: string;
  scriptExecutionId?: string;
  path: string[];
  durationMs?: number;
  outcome:
    | { status: "succeeded"; output: unknown }
    | { status: "failed"; error: unknown };
}
```

That shape is implemented in
`packages/shared/src/stream-processors/codemode/contract.ts` and consumed in
`packages/shared/src/stream-processors/codemode/implementation.ts`. The
processor appends a request event, waits for a matching completed event by
`functionCallId`, then returns `outcome.output` or throws the serialized error.

The OS2 Durable Object currently exposes a narrow live capability to dynamic
worker code using `RpcTarget`:

```ts
class CodemodeSessionCapabilityTarget extends RpcTarget {
  async callFunction(input: CallFunctionInput) { ... }
}
```

The PoC records the key design constraint: passing the literal
`CodemodeSession` Durable Object stub from inside the session failed with a
`DataCloneError`, while returning a fresh narrow `RpcTarget` facade worked. The
PoC also shows `ReadableStream<Uint8Array>` working as an RPC return value for
event streaming.

## Terms

- **Function Call ID**: correlation ID for one requested/completed function
  call. It should be globally unique enough within a stream and must be present
  on both events.
- **Script Execution ID**: parent execution correlation ID. It should be on all
  events emitted directly because of a script execution. Provider-to-provider
  nested calls should inherit it unless intentionally detached.
- **Live Result**: a value that cannot or should not be persisted in the event
  payload, such as an `RpcTarget`, callback function, `RpcStub`, `ReadableStream`,
  `Request`, or `Response`.
- **Result Ref**: a JSON event summary that points to a live result only within
  a short-lived RPC/session scope. It is a correlation handle, not authority.
- **Capability ID**: an optional opaque ID in a session-local registry. It
  names a live capability only to the Codemode Session that minted it. It is not
  forgeable authority by itself and should require the caller to already hold a
  live session capability.

## Minimal Schema Building Blocks

### Function Call Requested

```ts
type FunctionCallRequestedPayload = {
  functionCallId: string;
  scriptExecutionId?: string;
  path: string[];
  input: Jsonish;
};
```

Use `input`, not `payload`, because the stream envelope already has
`payload`. Use one full `path` array until provider dispatch needs a separate
indexed `providerPath` and `functionPath`.

### Function Call Completed

```ts
type FunctionCallCompletedPayload = {
  functionCallId: string;
  scriptExecutionId?: string;
  path: string[];
  durationMs?: number;
  outcome: FunctionCallOutcome;
};

type FunctionCallOutcome =
  | {
      status: "succeeded";
      output?: Jsonish;
      resultRef?: LiveResultRef;
    }
  | {
      status: "failed";
      error: SerializedError;
    };
```

`output` is the durable summary. `resultRef` is optional and only meaningful to
a live reader that already has a session capability. If both are present,
`output` should be a human/debuggable summary of the live result, not a second
source of truth.

### Live Result Ref

```ts
type LiveResultRef =
  | {
      type: "capability";
      capabilityId: string;
      summary?: Jsonish;
    }
  | {
      type: "stream";
      streamId: string;
      mediaType?: string;
      summary?: Jsonish;
    };
```

Keep this deliberately small. A `capabilityId` or `streamId` must be scoped to
the Codemode Session and should expire with the execution/session or explicit
disposal. It should not encode binding names, Durable Object names, URLs, or
callable descriptors unless the design intentionally wants durable re-resolution.

### Optional Live RPC Surface

```ts
type CodemodeSessionCapability = {
  callFunction(input: {
    functionCallId?: string;
    scriptExecutionId?: string;
    path: string[];
    input: unknown;
  }): Promise<unknown>;

  resolveResultRef?(input: { functionCallId: string; resultRef: LiveResultRef }): Promise<unknown>;

  readResultStream?(input: {
    functionCallId: string;
    resultRef: Extract<LiveResultRef, { type: "stream" }>;
  }): Promise<ReadableStream<Uint8Array>>;
};
```

This keeps live values behind the same object-capability boundary as the
original call. The event log records that a live value existed; the live
capability decides whether a caller may resolve it.

## Design Option 1: Durable Summary Only

Persist only request/completed events. Function implementations must return a
JSON-safe summary or serialize their result before completion.

Schema:

```ts
type FunctionCallCompletedPayload = {
  functionCallId: string;
  scriptExecutionId?: string;
  path: string[];
  durationMs?: number;
  outcome: { status: "succeeded"; output: Jsonish } | { status: "failed"; error: SerializedError };
};
```

Evaluation:

- Traceability: excellent. Every visible input and outcome is durable.
- Live RPC values: unsupported. Stubs, functions, streams, `Request`, and
  `Response` must be summarized, consumed, uploaded elsewhere, or rejected.
- Replayability: best. A replay reader does not need a live session.
- Implementation cost: lowest. This is closest to the current shared contract.
- Failure mode: callers may accidentally destroy useful live semantics by
  stringifying complex values.

Use when codemode's result channel is primarily audit/debug output and tool
functions are value-returning commands.

## Design Option 2: Durable Completion With Optional Live Result Ref

Persist request/completed events, but allow a succeeded outcome to include a
durable summary plus a session-local `resultRef`.

Schema:

```ts
type FunctionCallCompletedPayload = {
  functionCallId: string;
  scriptExecutionId?: string;
  path: string[];
  durationMs?: number;
  outcome:
    | {
        status: "succeeded";
        output?: Jsonish;
        resultRef?: LiveResultRef;
      }
    | { status: "failed"; error: SerializedError };
};
```

Live behavior:

- If a function returns a plain JSON-ish value, record it as `output`.
- If it returns a `ReadableStream`, record
  `{ resultRef: { type: "stream", streamId, mediaType, summary } }` and keep
  the actual stream behind session RPC while it is still readable.
- If it returns a function, `RpcTarget`, or stub, record
  `{ resultRef: { type: "capability", capabilityId, summary } }` and keep the
  live reference in a session-local registry.
- If the live ref expires, historical readers still see the completed event and
  summary, but `resolveResultRef` fails explicitly.

Evaluation:

- Traceability: strong. The call lifecycle and summary are durable.
- Live RPC values: supported without pretending they are durable.
- Replayability: good for audit, not for live continuation.
- Implementation cost: moderate. Needs a session-local live result registry,
  expiry/disposal, and explicit resolver methods.
- Security: good if refs are treated as correlation handles that require an
  existing session capability. Bad if `capabilityId` becomes globally resolvable
  authority.

Use when most calls are JSON-returning but some need live streams/callbacks or
provider handles.

## Design Option 3: Event Trace Plus Live Result Channel

Persist request/completed events with small summaries, and separately expose a
live per-call channel/capability for values that are naturally streaming or
interactive.

Schema:

```ts
type FunctionCallCompletedPayload = {
  functionCallId: string;
  scriptExecutionId?: string;
  path: string[];
  durationMs?: number;
  outcome:
    | {
        status: "succeeded";
        output?: Jsonish;
        live?: {
          channelId: string;
          kinds: Array<"value" | "stream" | "capability" | "callback">;
          summary?: Jsonish;
        };
      }
    | { status: "failed"; error: SerializedError };
};
```

RPC surface:

```ts
type LiveResultChannel = RpcTarget & {
  getValue(): Promise<unknown>;
  stream(): Promise<ReadableStream<Uint8Array>>;
  call(input: unknown): Promise<unknown>;
};
```

Evaluation:

- Traceability: strong for call lifecycle, weaker for detailed live interaction
  unless the channel itself appends additional events.
- Live RPC values: strongest. A channel can model a stream, callback surface,
  or object with methods.
- Replayability: audit-only unless every channel interaction also emits events.
- Implementation cost: highest. It creates a second lifecycle with channel
  creation, disposal, cancellation, broken-stub handling, and possibly
  backpressure.
- Security: good if the channel is itself a passed `RpcTarget`; risky if
  `channelId` is used as ambient authority.

Use when codemode intentionally needs long-lived interactive objects, not just
single call results.

## Design Option 4: Durable Callable Descriptor as Result

Persist a JSON `Callable` descriptor in the completed event and let future
readers re-resolve it through their own context.

Schema:

```ts
type FunctionCallCompletedPayload = {
  functionCallId: string;
  scriptExecutionId?: string;
  path: string[];
  outcome:
    | {
        status: "succeeded";
        output?: Jsonish;
        callable?: Callable;
      }
    | { status: "failed"; error: SerializedError };
};
```

Evaluation:

- Traceability: strong because the descriptor is durable JSON.
- Live RPC values: not actually preserved. The descriptor names a future way to
  invoke something using the resolver's ambient bindings.
- Replayability: possible if the same bindings and policy still exist.
- Implementation cost: moderate because `packages/shared/src/callable` already
  has the descriptor/runtime split.
- Security: the riskiest option. A `Callable` is untrusted JSON that selects
  from live authority supplied later by `ctx.env`, `ctx.exports`, or `fetch`.

Use for durable integrations/configuration, not for preserving Cap'n Web
object-capability identity. This is the wrong primitive for "this exact provider
instance returned this exact callback".

## Completed Event vs Succeeded/Failed Events

Recommendation: keep one `function-call-completed` event with a discriminated
`outcome`.

Reasons:

- The local shared contract already uses this shape for both script execution
  and function calls.
- Consumers can wait for one terminal event type by `functionCallId`.
- Adding live refs does not duplicate schema branches across succeeded/failed
  event types.
- Event feeds still render status cleanly from `outcome.status`.

Separate `function-call-succeeded` and `function-call-failed` events are useful
when stream consumers subscribe by event type and do not want to parse payloads.
The cost is more event names, more reducer branches, and more migration churn.
For codemode, terminal status is a field of the function call, not a separate
domain fact.

## ID Decisions

Use both IDs:

- `functionCallId` is required on requested/completed and is the primary join
  key for awaitability.
- `scriptExecutionId` is optional but should be inherited whenever a function
  call originates from a script execution, including provider-to-provider nested
  calls.

Do not scope `functionCallId` only under `scriptExecutionId`. The stream may
contain provider-originated calls, retries, or future detached operations where
there is no script execution. A globally unique-ish call ID keeps subscriptions
and reducers simple.

Add `parentFunctionCallId` only when nested call visualization needs it. Do not
add it speculatively to the minimal v1 schema.

## Input and Outcome Shape

Use:

- `input` on request events;
- `outcome.status` on completed events;
- `outcome.output` for durable successful summaries;
- `outcome.error` for durable failed summaries;
- `durationMs` as optional telemetry.

Avoid:

- `payload` inside the event payload, because it collides mentally with the
  stream envelope's `payload`;
- top-level `result` plus optional top-level `error`, because it permits
  ambiguous `{ result, error }` success/failure states;
- storing raw thrown objects without at least `{ message, name?, stack? }`
  normalization.

## Result Refs and Capability IDs

`resultRef` should mean "a live result existed at completion time". It should
not mean "any future reader can resolve this".

Rules:

- `resultRef` is optional and only valid when `outcome.status === "succeeded"`.
- `resultRef.summary` is durable and safe to render.
- `capabilityId` / `streamId` are scoped to the Codemode Session live runtime.
- Resolving a ref requires holding a live `CodemodeSessionCapability`.
- Expiry is normal; the durable event remains valid after the live value is
  gone.
- A resolver should verify `functionCallId` plus `resultRef`, not accept a bare
  ID.

This preserves Cap'n Web's object-capability semantics. The ID is a lookup key
inside an already-authorized object, not a substitute for a stub.

## Callbacks

Callbacks should be live RPC values, not durable event payloads.

Recommended representation:

- If a function call accepts a callback as part of live RPC, the receiving
  provider gets the actual callback/stub over RPC.
- The request event records a summary such as:

```ts
{
  input: {
    query: "hello",
    onProgress: { "$live": "callback", summary: "progress callback" }
  }
}
```

- If callback invocations are user-visible, each invocation should append its
  own normal event, e.g. `log-emitted`, `function-call-requested`, or a future
  specific progress event.

Do not store callback IDs in a durable event and later let unrelated actors call
them. That converts an unforgeable passed reference into ambient authority.

## ReadableStream and Stub Results

For `ReadableStream` results:

- If the stream is the actual user-facing result, return it over live RPC and
  record a `resultRef` of type `stream`.
- Include a durable summary: media type, expected format, byte count if known,
  first N metadata fields, or storage pointer if the stream was persisted
  elsewhere.
- Remember Workers RPC transfers stream ownership. If the producer also needs
  to inspect or persist it, it must explicitly tee/clone and accept buffering
  tradeoffs.

For `RpcTarget`, function, or `RpcStub` results:

- Return the live value over RPC when the immediate caller needs it.
- Record `resultRef: { type: "capability", capabilityId, summary }` only for
  traceability and live-session lookup.
- Prefer returning a narrow facade over forwarding broad service/DO stubs.
- Dispose/expire entries when the execution ends, the session closes, or the
  caller explicitly disposes.

For `Request` / `Response` results:

- Treat them like compound stream values.
- Durable summary can include method, URL path redacted as needed, status,
  headers allowlist, body media type, and `resultRef` for body streaming.
- Do not persist full headers or bodies by default.

## Recommendation

Adopt Option 2: durable request/completed events with optional live
`resultRef`.

Minimal recommended payloads:

```ts
type FunctionCallRequestedPayload = {
  functionCallId: string;
  scriptExecutionId?: string;
  path: string[];
  input: unknown;
};

type FunctionCallCompletedPayload = {
  functionCallId: string;
  scriptExecutionId?: string;
  path: string[];
  durationMs?: number;
  outcome:
    | {
        status: "succeeded";
        output?: unknown;
        resultRef?: LiveResultRef;
      }
    | {
        status: "failed";
        error: unknown;
      };
};

type LiveResultRef =
  | {
      type: "capability";
      capabilityId: string;
      summary?: unknown;
    }
  | {
      type: "stream";
      streamId: string;
      mediaType?: string;
      summary?: unknown;
    };
```

Why this is the clean minimal hybrid:

- It keeps the current local `function-call-requested` /
  `function-call-completed` model.
- It preserves event traceability even after live values expire.
- It does not introduce separate succeeded/failed event types.
- It supports Cap'n Web values by reference without serializing authority into
  the event stream.
- It lets the UI and MCP callers continue to follow the stream by
  `functionCallId` and `scriptExecutionId`.
- It leaves durable `Callable` descriptors for configuration/integration cases,
  not for object-capability identity.

The first implementation slice should still accept plain JSON outcomes exactly
as the current contract does. Add `resultRef` only when a concrete call returns
one of the live classes: `ReadableStream`, `Response`, `Request`, function,
`RpcTarget`, or an incoming stub.
