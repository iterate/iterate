# Codemode, Events, Workers RPC, and Workflows

Date: 2026-05-06

## Inputs

First-pass reports:

- [01-rpc-platform-capabilities.md](./01-rpc-platform-capabilities.md)
- [02-workflow-engine-trajectory.md](./02-workflow-engine-trajectory.md)
- [03-processors-as-tool-providers.md](./03-processors-as-tool-providers.md)
- [04-hybrid-event-rpc-designs.md](./04-hybrid-event-rpc-designs.md)

Adversarial reviews:

- [reviews/01-rpc-platform-capabilities-review.md](./reviews/01-rpc-platform-capabilities-review.md)
- [reviews/02-workflow-engine-trajectory-review.md](./reviews/02-workflow-engine-trajectory-review.md)
- [reviews/03-processors-as-tool-providers-review.md](./reviews/03-processors-as-tool-providers-review.md)
- [reviews/04-hybrid-event-rpc-designs-review.md](./reviews/04-hybrid-event-rpc-designs-review.md)

Primary platform sources:

- Workers RPC: https://developers.cloudflare.com/workers/runtime-apis/rpc/
- Workers RPC lifecycle: https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/
- Workers RPC visibility: https://developers.cloudflare.com/workers/runtime-apis/rpc/visibility/
- Workers RPC error handling: https://developers.cloudflare.com/workers/runtime-apis/rpc/error-handling/
- Workers compatibility flags: https://developers.cloudflare.com/workers/configuration/compatibility-flags/
- Durable Object RPC: https://developers.cloudflare.com/durable-objects/best-practices/create-durable-object-stubs-and-send-requests/
- Durable Object lifecycle: https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/
- Durable Object error handling: https://developers.cloudflare.com/durable-objects/best-practices/error-handling/
- Dynamic Workers bindings: https://developers.cloudflare.com/dynamic-workers/usage/bindings/
- Dynamic Workers API: https://developers.cloudflare.com/dynamic-workers/api-reference/
- Workflows: https://developers.cloudflare.com/workflows/
- Workflows rules: https://developers.cloudflare.com/workflows/build/rules-of-workflows/
- Workflows events/parameters: https://developers.cloudflare.com/workflows/build/events-and-parameters/
- Workflows limits: https://developers.cloudflare.com/workflows/reference/limits/
- Dynamic Workflows: https://developers.cloudflare.com/dynamic-workers/usage/dynamic-workflows/
- Kenton Varda, JavaScript-native Workers RPC: https://blog.cloudflare.com/javascript-native-rpc/
- Kenton Varda / Cloudflare, Cap'n Web: https://blog.cloudflare.com/capnweb-javascript-rpc-library/
- Cap'n Web README: https://github.com/cloudflare/capnweb

## Revised conclusion

The first-pass consensus was right at the architectural level:

- **events for durable product facts;**
- **Workers RPC / Cap'n Web for live authority and rich values;**
- **Workflows for durable continuation.**

The adversarial reviews tighten that into a stricter rule:

> The event stream must become more honest and JSON-only, not more magical.
> Live handles should stay as live stubs. If an event mentions one, it should
> contain only a receipt/summary, never authority.

This matters because Cloudflare RPC can carry `ReadableStream`, `Response`,
functions, `RpcTarget` objects, and stubs. The event log cannot. In local code,
stream events are persisted through JSON. A live `Response` or callback in an
event payload is either lossy, misleading, or rejected too late.

## Three planes

### 1. Event plane

Durable facts and UI/replay state.

Contains:

- script/function request/completion facts;
- IDs, offsets, parent IDs;
- JSON-safe input/output summaries;
- JSON-safe errors;
- artifact references;
- receipts that say a live value existed.

Does not contain:

- `RpcTarget`;
- functions/callbacks;
- `ReadableStream`;
- `Response`/`Request` bodies;
- Durable Object or Service Binding stubs;
- JavaScript `Proxy` objects;
- custom class instances;
- authority-bearing IDs.

### 2. RPC capability plane

Live execution graph.

Carries:

- narrow `RpcTarget` facades;
- callbacks;
- byte streams / `Response` values;
- sandbox/provider handles;
- direct rich return values to Worker/DO/Dynamic Worker callers.

This is where `await ctx.getSandbox(...)` can return a real sandbox handle.
The handle should not be persisted. If the event log records it, it records a
JSON receipt and summary only.

### 3. Workflow plane

Durable continuation substrate.

Use this for sleeps, external events, retries, approvals, and multi-day agent
plans. It should mirror important product facts into the event stream because
Workflow state/log retention is limited and operational, not the canonical
codemode audit log.

Do not pretend today's arbitrary `async (ctx) => { ... }` script body is a
durable workflow. Cloudflare Workflows persist named step results; they do not
serialize arbitrary JavaScript stack frames.

## Minimal event core

Keep the current event names:

- `events.iterate.com/codemode/tool-provider-registered`
- `events.iterate.com/codemode/script-execution-requested`
- `events.iterate.com/codemode/script-execution-completed`
- `events.iterate.com/codemode/function-call-requested`
- `events.iterate.com/codemode/function-call-completed`
- `events.iterate.com/codemode/log-emitted`

Keep `*-completed` with discriminated `outcome` for now. Do not split
`succeeded`/`failed` until a consumer needs separate event names.

But tighten the durable value shape. Conceptually:

```ts
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type DurableValue =
  | { kind: "json"; value: JsonValue }
  | { kind: "text"; value: string }
  | { kind: "artifact"; ref: ArtifactRef; summary?: JsonValue }
  | { kind: "omitted"; reason: "non-json" | "too-large" | "sensitive"; summary?: JsonValue }
  | { kind: "live"; receipt: LiveResultReceipt };

type LiveResultReceipt = {
  kind: "capability" | "stream" | "response" | "callback";
  refId: string;
  summary: JsonValue;
  expiresAt: string;
  lifetime: "call" | "script-execution" | "session";
};
```

Do not call this a `capabilityId` unless the ID itself is intentionally a
bearer capability. Prefer `refId`, `receiptId`, or `liveResultId`.

`LiveResultReceipt` is not authority. It is a receipt saying "a live value
existed at this call boundary." Resolving it, if supported at all, requires
already holding a live session/call-scoped capability.

## Function-call schema direction

Near-term schema direction:

```ts
type FunctionCallRequestedPayload = {
  functionCallId: string;
  scriptExecutionId?: string;
  parentFunctionCallId?: string;
  path: string[];
  input: DurableValue;
};

type FunctionCallCompletedPayload = {
  functionCallId: string;
  scriptExecutionId?: string;
  path: string[];
  durationMs?: number;
  outcome:
    | {
        status: "succeeded";
        output: DurableValue;
      }
    | {
        status: "failed";
        error: SerializedError;
      };
};
```

This is stricter than current code, where successful `output` is `unknown`.
That is intentional as a design direction. The current permissive `unknown`
shape is not honest if the payload is persisted as JSON.

Apply the same output discipline to script completion:

```ts
type ScriptExecutionCompletedPayload = {
  scriptExecutionId: string;
  durationMs?: number;
  outcome:
    | {
        status: "succeeded";
        output: DurableValue;
      }
    | {
        status: "failed";
        error: SerializedError;
      };
};
```

## Live result resolution

Do not add a general `resolveResultRef()` until the access model is designed.
It is too easy to accidentally turn event data into authority.

If live result resolution is added later, the resolver should be a live
`RpcTarget` already scoped to this session/execution/call:

```ts
type LiveCallResultResolver = {
  getJsonSummary(input: { functionCallId: string; refId: string }): Promise<JsonValue>;
  streamBytes(input: {
    functionCallId: string;
    refId: string;
  }): Promise<ReadableStream<Uint8Array>>;
  dispose(input: { functionCallId: string; refId: string }): Promise<void>;
};
```

The server-side registry would need, at minimum:

- owner session;
- script execution ID;
- function call ID;
- ref ID;
- kind;
- created time;
- expiry;
- disposal state;
- permitted operations;
- broken-stub behavior;
- what happens on Durable Object restart.

Until that exists, return the live value directly to the current RPC caller and
record only a durable summary in events.

## The awaited call path

The old elegance can survive:

```ts
const sandbox = await ctx.getSandbox({ name: "build" });
const output = await sandbox.exec({ cmd: "pnpm test" });
```

The broker/session implementation should do:

1. append `function-call-requested` with JSON-safe input summary;
2. dispatch provider over Workers RPC / Callable / event-only adapter;
3. receive the actual live result;
4. append `function-call-completed` with `DurableValue`;
5. return the actual live result to the awaiting caller if the caller is on the
   live RPC plane.

For a JSON-returning function, `DurableValue` can contain the same value. For a
stream or sandbox handle, `DurableValue` contains a summary/receipt while the
actual value flows through RPC.

## Browser boundary

Workers RPC between Workers/DOs/Dynamic Workers does not make a browser able to
receive a Cloudflare internal stub through the existing oRPC/HTTP JSON route.

Browser choices:

1. JSON/event UI only: show durable summaries and logs.
2. HTTP-native affordances: download artifact, stream a `Response` body via a
   normal endpoint, open an SSE/WebSocket feed.
3. A separate authenticated Cap'n Web endpoint if the browser should hold live
   object capabilities.

Do not imply that a durable `LiveResultReceipt` can be resolved by the browser
unless one of those surfaces exists.

## Tool providers and stream processors

The refined thesis:

> Any stream processor can be made available as a codemode tool provider through
> an explicit broker-owned provider adapter.

Not:

> Every processor runner automatically becomes a tool provider.

Why:

- Processor contracts are frontend-safe metadata and reducers.
- Processor implementations expose `afterAppend`.
- A tool provider needs a call surface, routing, authorization, lifecycle
  event appends, cancellation, timeout, and result conversion.

Use explicit adapters:

```ts
type StreamProcessorProviderAdapter = {
  contractSlug: string;
  describe(): ToolProviderDocumentation;
  call(input: {
    path: string[];
    input: unknown;
    broker: ToolBrokerCapability;
    signal: AbortSignal;
  }): Promise<unknown>;
};
```

The broker owns:

- longest-prefix routing;
- duplicate route policy;
- path authorization;
- max call depth;
- timeout/budget;
- parent/child call correlation;
- event append before/after dispatch;
- error normalization;
- conversion from live result to durable summary.

Provider A calling Provider B should call through the same broker capability.
Direct Provider B stub handoff is an optimization inside one live call graph,
not the canonical durable model.

## Callable remains useful but limited

`Callable` is a durable invocation descriptor, not live identity.

Good:

- stored provider descriptors;
- service/DO/fetch/loopback dispatch recipes;
- MCP/OpenAPI/HTTP adapters;
- re-resolving a provider from deployment context.

Bad:

- preserving a returned stream/callback/sandbox handle;
- encoding a live unforgeable stub into an event;
- treating event data as authority.

If a live target and a callable fallback are both available for a provider, the
broker needs an explicit equivalence policy. A warm live target may have session
state; a callable re-resolution path may not be behaviorally identical.

## Workflow trajectory

Do not make "workflow-backed codemode" a hidden mode for arbitrary current
scripts. Add a separate workflow-shaped authoring/execution target:

```ts
async function run(ctx, step) {
  const sandbox = await step.do("get sandbox", () => ctx.getSandbox({ name: "build" }));
  await step.do("run tests", () => sandbox.exec({ cmd: "pnpm test" }));
  await step.waitForEvent("approval_received");
}
```

Or compile generated agent workflow code into a state machine with stable step
names.

Important Cloudflare constraints:

- Workflow event type names are limited; codemode event URLs cannot be used
  directly as `waitForEvent` types.
- Workflow payloads/results have size limits; large values need artifact refs.
- Workflow state/log retention is limited; stream remains canonical.
- Workflows do not support every deployment topology; Worker Loader / Dynamic
  Workflow fit must be proven.
- Live RPC handles do not survive workflow sleeps. Re-mint from descriptors and
  re-authorize inside each step.

Add workflow lifecycle events only when the runner can actually do the thing:

```ts
type ScriptExecutionAccepted = {
  scriptExecutionId: string;
  runId: string;
  runner: {
    kind: "dynamic-worker" | "cloudflare-workflow" | "dynamic-workflow";
    workflowInstanceId?: string;
  };
  acceptedFromOffset: number;
};

type ScriptExecutionSuspended = {
  scriptExecutionId: string;
  runId: string;
  reason: "sleep" | "wait-for-event" | "waiting-for-function-call" | "paused";
  resumeAfter?: string;
  waitingFor?: Array<{ type: string; correlationId?: string; timeoutAt?: string }>;
};

type ScriptExecutionResumed = {
  scriptExecutionId: string;
  runId: string;
  trigger:
    | { type: "event"; eventOffset: number; eventType: string }
    | { type: "timer"; scheduledFor: string }
    | { type: "manual"; principalId?: string }
    | { type: "retry"; attempt: number };
};
```

For now, the more urgent bug is durable pending-call state. The current
short-lived executor path should not rely on a non-existent processor-local
subscription to wait for future completion.

## Platform requirements before implementation

Before leaning on live stubs/callbacks:

- Set or prove compatible dates/flags. Stub param ownership changed with
  `rpc_params_dup_stubs`, defaulting on `2026-01-20`; current Dynamic Worker
  code uses an older compatibility date.
- Validate every RPC method input at trust boundaries. TypeScript is not a
  runtime security boundary.
- Prove byte stream return over Workers RPC.
- Prove `Response` return over Workers RPC.
- Prove callback/function return and invocation.
- Prove `RpcTarget` facade return and explicit disposal.
- Prove custom class rejection or conversion.
- Prove JSON event append rejects/summarizes non-JSON values before persistence.
- Prove browser story separately if browser live handles are required.

## Minimal next slice

Design-only ordering:

1. Keep current event names and IDs.
2. Make durable event values explicitly JSON-only in the design.
3. Introduce `DurableValue` / `LiveResultReceipt` vocabulary.
4. Keep live returns on the Workers RPC path; do not add a resolver API yet.
5. Build the broker/provider-adapter concept before saying processors are
   providers.
6. Add `parentFunctionCallId` only when nested call trace/cancellation is in
   scope.
7. Treat Workflows as a separate script target or compiler output, not as
   magic durability for arbitrary async JS.

## Final answer to the worry

The event-sourced refactor did not kill the elegant thing. It exposed a missing
boundary.

The elegant model is not "tool calls are events." It is:

- tool calls produce durable events;
- live callers still await rich RPC returns;
- durable events record JSON facts about those rich returns;
- workflows resume from facts and descriptors, not from live JS objects.

That is the minimal model that can support:

1. future workflow engine foundations;
2. stream processors as tool providers through adapters;
3. easy event traceability;
4. Cloudflare-native streams, stubs, callbacks, and sandbox handles.
