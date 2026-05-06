# Review: 02 Workflow Engine Trajectory

Date: 2026-05-06

## 1. Strongest steel-man

The report's strongest claim is the three-plane separation:

- The stream event log is canonical product truth.
- Cloudflare Workflows are durable continuation machinery.
- Cap'n Web / Workers RPC handles are live authority and must not be persisted.

That is the right architecture boundary. Cloudflare's Workflows overview says Workflows are for durable multi-step execution, retries, pauses for external events, and state lasting "minutes, hours, or even weeks" without managing infrastructure: <https://developers.cloudflare.com/workflows/>. The limits page supports the long-wait argument: `step.sleep` can be up to 365 days, waiting instances do not count toward active concurrency, and paid step count can be configured up to 25,000: <https://developers.cloudflare.com/workflows/reference/limits/>. The Events docs also say `WorkflowEvent.payload` is effectively immutable and durable state should come from `step.do` returns: <https://developers.cloudflare.com/workflows/build/events-and-parameters/>.

The report is also right that Durable Objects are not a weeks-long in-memory continuation primitive. The Durable Object lifecycle docs say objects hibernate/evict/restart, constructors rerun, and in-flight HTTP/RPC requests can be interrupted during shutdown if they touch storage: <https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/>. Durable Objects are excellent identity, coordination, storage, and RPC endpoints; they are not stable JS stack preservation.

The Cap'n Web stance is also well grounded. Workers RPC is JavaScript-native RPC for Workers and Durable Objects, accepts/returns serializable types, and exposes `RpcTarget` for class instances: <https://developers.cloudflare.com/workers/runtime-apis/rpc/>. Its lifecycle docs make returned stubs an execution-context resource that must be disposed or duplicated intentionally, not durable database values: <https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/>. Kenton's Cap'n Web post explicitly frames the design as object-capability RPC where possessing an unforgeable reference is authority, with promise pipelining as a latency feature: <https://blog.cloudflare.com/capnweb-javascript-rpc-library/>. The Workers RPC launch post applies the same model to Workers service bindings and Durable Objects: <https://blog.cloudflare.com/javascript-native-rpc/>.

Applied to the current codemode implementation, the report correctly identifies the pressure point: `CodemodeSession` launches a Dynamic Worker and passes narrow `RpcTarget` facades, while `waitForFunctionCallResult()` currently expects `subscribe()` to work even though `processorStreamApiFromNamespace().subscribe()` throws. This makes the current implementation a short-lived RPC execution path, not a durable workflow engine. The report's "stream is truth, runner is continuation, RPC is live capability" model is the right corrective.

## 2. Heavy criticism and risks

The report still understates the hardest migration: Cloudflare Workflows do not serialize arbitrary JavaScript stack frames. They persist named step returns. The Workflows rules emphasize idempotent API/binding calls, granular steps, no reliance on mutable state outside steps, deterministic step names, awaited steps, and careful handling of `Promise.race()` / `Promise.any()`: <https://developers.cloudflare.com/workflows/build/rules-of-workflows/>. That is not a drop-in replacement for the current codemode shape:

```ts
const result = await __userScript(ctx);
```

If user code can call arbitrary `await ctx.foo()` inside an arbitrary async function, Cloudflare will not resume "inside" that function after isolate recycling unless codemode compiles the code into a Workflow-shaped state machine or forces authors into `async run(ctx, step)` with stable step names. The report says this in passing, but it is the central feasibility gate. Without it, "Workflow-backed runner" is marketing language around a one-shot executor.

The event-to-Workflow bridge is also underspecified. The report says `deliverEvent()` is an optimization for Workflow `sendEvent`, not source of truth. That is a good slogan, but not enough. Cloudflare says `sendEvent` can be called before the Workflow reaches the matching `waitForEvent`, and the event will be buffered for that instance: <https://developers.cloudflare.com/workflows/build/events-and-parameters/>. That means codemode needs an explicit reconciliation protocol:

- append provider completion to stream;
- deliver to Workflow instance;
- record delivery attempt/result with an idempotency key;
- let resumed runners scan missed stream offsets if delivery failed;
- make duplicate `sendEvent` harmless or detectably rejected.

Otherwise stream truth and Workflow buffered events will diverge silently. If the event is appended but `sendEvent` fails, the Workflow remains parked. If `sendEvent` succeeds but the append is later rolled back or never observed by UI, the Workflow may continue without canonical trace. The report needs to make this a first-class invariant, not a footnote.

The proposed handle ledger risks false confidence. A `CapabilityHandleMinted` event records that authority was intended, not that any future authority is still safe to re-create. Workers RPC stubs are live resources with lifecycle/disposal semantics; the RPC lifecycle docs say stubs created in an event context are disposed when the event handler is done unless ownership is extended deliberately: <https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/>. A persisted `handleId` cannot prove that a provider is still installed, that its permissions are unchanged, that the user is still authorized, or that the provider's implementation has the same behavior. Re-minting must re-run authorization and version checks. If the ledger is only correlation, say that loudly and do not design cancellation/security around it.

Dynamic Workflows are promising but operationally immature for this use case. The Dynamic Workflows docs say they route a Workflow through Worker Loader and that normal Workflow behavior still applies: <https://developers.cloudflare.com/dynamic-workers/usage/dynamic-workflows/>. The report should treat this as a research spike, not a near-term base. Crucially, Workflows limits state that Workflows cannot be deployed to Workers for Platforms namespaces: <https://developers.cloudflare.com/workflows/reference/limits/>. Since codemode already depends on Dynamic Workers / Worker Loader semantics, the deployment topology must be proven before architecture commitment. The report gestures at "newer surface" but does not call out this platform-fit risk sharply enough.

Security is too thin. The current executor loads user code with `globalOutbound: null` and passes only narrow facades. A Workflow or Dynamic Workflow path must preserve that least-authority shape. A generated Workflow class has access to its `env` bindings. If codemode gives it a Workflow binding, stream binding, R2 binding, or provider broker, the least-authority story depends entirely on which facades are exposed and whether generated code can reach ambient network, storage, or administrative bindings. The report should require a binding allowlist and a no-ambient-authority test before any Dynamic Workflow execution of generated/user code.

Cost and scale are not addressed. One Workflow per script execution plus one or more steps per tool call may be acceptable, but the report needs a budget model. Limits include creation rates, concurrency, step counts, persisted instance state, 1 MiB event payloads, and 30-day paid retention of completed instance state: <https://developers.cloudflare.com/workflows/reference/limits/>. The Workflows rules also recommend step timeouts of 30 minutes or less, and large step results must be stored externally with references: <https://developers.cloudflare.com/workflows/build/rules-of-workflows/>. Codemode traces and tool outputs can be large; "use artifact refs" is correct but incomplete without a threshold, storage location, retention policy, and UI fetch path.

Cancellation is currently too optimistic. Workflow `terminate`, stream `script-execution-cancellation-requested`, local `AbortSignal`, RPC stub disposal, and provider-level cancellation are different mechanisms. The current code passes `signal` into the script executor interface but the generated Dynamic Worker context does not expose a working abort signal to user code. Workflows can be paused/resumed/terminated, but provider calls already in flight through RPC or an external API may still complete and append results. The report needs a race policy: late completions after cancellation must be ignored, attached as late facts, or converted into compensating events.

## 3. Factual corrections against docs

- "A Workflow instance can run forever" is too loose. The docs say Workflows provide durable execution without traditional timeouts and per-step wall-clock duration can be unlimited, but the same limits table imposes step-count limits, state limits, creation-rate limits, payload limits, and 365-day maximum sleep: <https://developers.cloudflare.com/workflows/reference/limits/>. Say "can remain active/waiting for very long periods within Workflow limits," not "forever."

- Workflow event type strings cannot reuse codemode event type URLs. `waitForEvent` requires a `type` of up to 100 characters and only letters, digits, `-`, and `_`; dots are not supported, and codemode event types include dots and slashes (`events.iterate.com/...`): <https://developers.cloudflare.com/workflows/build/events-and-parameters/>. Any bridge must map stream event types to Workflow-safe event names such as `function_call_completed`.

- The report says `WorkflowEvent.payload` is effectively immutable, which is correct, but its examples mix `params` and `payload`. Current docs use `create({ id, params })` to trigger and expose the data as `event.payload` in `run()`: <https://developers.cloudflare.com/workflows/build/events-and-parameters/>. The recommendation should standardize on "create params become `WorkflowEvent.payload`."

- `createBatch` has an idempotency property that plain `create` does not share in the same way. The Rules page says `createBatch` skips existing instance IDs within retention, while instance IDs must be unique per Workflow: <https://developers.cloudflare.com/workflows/build/rules-of-workflows/>. If codemode sets Workflow instance ID to `scriptExecutionId`, retry behavior must be explicitly tested for `create()` conflict handling. Do not assume all Workflow creation is idempotent just because the ID is stable.

- "Non-serializable resources should be created outside steps but not reused across steps" needs nuance. The Rules page says side effects outside `step.do` may repeat, but non-serializable resources like DB connections may be created outside steps; Hyperdrive is the special case where connections should be created inside each `step.do`: <https://developers.cloudflare.com/workflows/build/rules-of-workflows/>. For codemode, the safer formulation is: live resources may be constructed outside step state, but all durable decisions and side effects need idempotent step boundaries.

- Workflows are not available everywhere Cloudflare Workers run. The Workflows limits page explicitly says Workflows do not support Workers for Platforms namespaces: <https://developers.cloudflare.com/workflows/reference/limits/>. This is material for a Worker Loader / Dynamic Worker based codemode system.

- Durable Object RPC methods do accept/return serializable types, and new projects should prefer RPC over `fetch()` for DO invocation: <https://developers.cloudflare.com/durable-objects/best-practices/create-durable-object-stubs-and-send-requests/>. The report's DO/RPC direction is correct, but "pass literal DO stub failed with `DataCloneError`" should not be overgeneralized into "DO stubs are never passable"; the precise rule is to design explicit serializable/RpcTarget surfaces and verify what the runtime accepts.

## 4. Implications for codemode as workflow engine

Codemode should not try to make today's script body durable. Today's shape is:

- append `script-execution-requested`;
- run a generated Dynamic Worker module;
- pass `RpcTarget` facades for session and logger;
- let arbitrary user code call a proxy path;
- append `function-call-requested`;
- wait for `function-call-completed`;
- append `script-execution-completed`.

That is a capability-oriented short execution engine. It is not a workflow engine until function calls, waits, retries, cancellation, and replay all have durable state transitions independent of the live RPC stack.

The first implication: codemode needs two user-code targets, not one.

- Short script target: `async (ctx) => result`, current Dynamic Worker executor, no durable waits. If it tries to wait across turn boundaries, fail explicitly with a user-visible event.
- Workflow target: `async (ctx, step) => result` or generated state machine, with stable step naming and explicit `step.do`, `step.sleep`, and `step.waitForEvent` boundaries.

The second implication: provider calls must become durable protocol messages. A tool call cannot be "an RPC call that happens to append events." It must be:

- durable request event;
- optional accepted/claimed event;
- provider execution with idempotency key;
- durable completion/failure/cancellation event;
- Workflow-safe delivery event to resume a waiting runner.

The third implication: `CodemodeSession` should remain the capability broker and trace writer, but not the continuation owner for long-running executions. It can mint fresh live facades for each active step from stream state, provider descriptors, and authorization context. It should not try to preserve an in-memory `ctx` proxy, an open subscription, or a returned `RpcTarget` across Workflow sleeps.

The fourth implication: Workflow-backed codemode must have an artifact policy before launch. Inline code, model/tool outputs, logs, provider docs, and generated plans can exceed 1 MiB quickly. The stream should store summaries and refs; R2 or equivalent should store large payloads; Workflow state should store only resumable cursors and refs.

The fifth implication: adopting Workflows adds a second operational system, not just a helper. Operators will need correlation between stream event IDs, Workflow instance IDs, run IDs, provider call IDs, and artifact refs. The report's proposed event schemas are directionally good, but the minimal set should start with `script-execution-accepted`, `function-call-requested`, `function-call-completed`, `workflow-event-delivery-attempted`, and terminal facts. The handle ledger should wait until scope enforcement exists.

## 5. Revised recommendation

Adopt the three-plane model, but narrow the near-term commitment:

1. Keep the current Dynamic Worker executor as the only supported runtime for short codemode scripts.
2. Add explicit durable pending-call state and remove dependence on `subscribe()` for correctness.
3. Add `script-execution-accepted` / terminal failure facts and idempotent provider-call lifecycle events.
4. Add a Workflow runner only for a new Workflow-shaped script target, not arbitrary existing `async (ctx) => ...` code.
5. Before using Dynamic Workflows for user/tenant-authored code, prove deployment compatibility with this repo's Worker Loader topology and the Workflows "no Workers for Platforms" constraint.
6. Treat all Workflow instance state/logs as disposable operational state; mirror every product-visible fact into the stream or an artifact ref.
7. Do not implement `CapabilityHandleMinted` until there is actual scope/permission enforcement. Until then, store capability correlation in `script-execution-accepted` metadata and provider-call events.

The revised architecture should say: codemode is event-sourced first, capability-scoped second, and Workflow-backed only for code that is explicitly authored or compiled into Cloudflare's durable step model. That is less magical than "codemode as workflow engine," but it is the version that matches Cloudflare's documented semantics and can survive retries, hibernation, redeploys, and late provider completions.
