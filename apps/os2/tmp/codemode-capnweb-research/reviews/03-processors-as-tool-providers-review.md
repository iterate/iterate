# Review: Processors As Tool Providers

## 1. Strongest Steel-Man

The report is strongest where it refuses to collapse durable workflow state and live RPC authority into one abstraction. That is the right axis. Cloudflare Workers RPC and Cap'n Web are capability systems: a received stub grants the ability to call exactly that object/function, and Dynamic Workers make the sandboxing implication explicit: stubs have no global identifier and cannot be forged (https://developers.cloudflare.com/dynamic-workers/usage/bindings/). That maps cleanly to codemode: user code and provider code should receive a narrow session or broker capability, not broad namespace bindings.

The hybrid broker recommendation also fits first-party RPC docs better than an event-only design. Workers RPC intentionally supports JavaScript-like cross-worker calls, pass-by-reference functions/classes, bidirectional callbacks, promise pipelining, and forwarding stubs between Workers (https://developers.cloudflare.com/workers/runtime-apis/rpc/). Durable Object RPC is now the preferred method-call shape for compatibility date `2024-04-03` or later (https://developers.cloudflare.com/durable-objects/best-practices/create-durable-object-stubs-and-send-requests/). For provider-to-provider calls that need an answer now, forcing every hop through append/subscription would discard the main platform advantage.

The local code also supports the report's central split. Processor contracts are frontend-safe event/state declarations only: `slug`, `version`, `description`, `stateSchema`, `events`, `processorDeps`, `consumes`, `emits`, and optional pure `reduce` ([types.ts](/Users/jonastemplestein/.superset/worktrees/iterate/raspy-produce/packages/shared/src/stream-processors/types.ts:243)). Implementations get `onStart` and `afterAppend` as side-effect hooks ([stream-processor.ts](/Users/jonastemplestein/.superset/worktrees/iterate/raspy-produce/packages/shared/src/stream-processors/stream-processor.ts:424)). That is already the right shape for "metadata/importability in the contract, authority/execution in a runtime adapter."

The report's narrow facade guidance is especially sound. OS2's `CodemodeSession` passes a `CodemodeSessionCapabilityTarget extends RpcTarget` into the Dynamic Worker, not the full Durable Object stub ([codemode-session.ts](/Users/jonastemplestein/.superset/worktrees/iterate/raspy-produce/apps/os2/src/durable-objects/codemode-session.ts:378)). The PoC shows the same pattern across Durable Objects and Dynamic Workers, and records that passing the literal `CodemodeSession` DO stub from inside the session failed with `DataCloneError` while a fresh narrow `RpcTarget` facade worked ([README.md](/Users/jonastemplestein/.superset/worktrees/iterate/raspy-produce/apps/os2/tmp/codemode-rpc-providers-poc/README.md:72)). That is not incidental; it is the design center.

## 2. Heavy Criticism And Risks

The phrase "any stream processor can be a tool provider" is too broad. Today a processor is not an addressable runtime service. A runner hosts one processor bound to one stream path and exposes protected runner methods, not a public provider surface ([with-stream-processor-runner.ts](/Users/jonastemplestein/.superset/worktrees/iterate/raspy-produce/packages/shared/src/durable-object-utils/mixins/with-stream-processor-runner.ts:121)). To make "any processor" true, the system needs a separate provider adapter contract: how provider metadata is declared, how an instance is addressed, how calls are routed, how state is observed, and who appends lifecycle events. The report names this but underweights it.

Design C is the dangerous part. Adding `callToolFunction()` to every processor runner creates a second imperative side-effect lane next to `afterAppend`. That can quietly violate the event-sourced story unless the broker owns lifecycle append before and after every call. Worse, if direct RPC calls mutate processor-local warm state without a corresponding event, replay and UI projections will lie. The report says "reportable lifecycle must stay in events," but that needs to be a hard invariant, not a con.

The broker recommendation centralizes the hard problems but does not price them. A production broker must own route registration conflict handling, authorization, max call depth, cancellation, timeouts, budgets, error normalization, idempotency, parent/child call correlation, and reentrancy. Without that, "providers should call through the broker" becomes a recursion engine. The current codemode contract has no `parentFunctionCallId` field ([contract.ts](/Users/jonastemplestein/.superset/worktrees/iterate/raspy-produce/packages/shared/src/stream-processors/codemode/contract.ts:106)), and current `CodemodeSession.callFunction()` just appends and consumes a request event; it does not route to a provider or append completion ([codemode-session.ts](/Users/jonastemplestein/.superset/worktrees/iterate/raspy-produce/apps/os2/src/durable-objects/codemode-session.ts:226)).

Event-only responders are not just "slower"; they are currently structurally fragile. The shared codemode implementation waits by `read()` then `subscribe()` after appending a request ([implementation.ts](/Users/jonastemplestein/.superset/worktrees/iterate/raspy-produce/packages/shared/src/stream-processors/codemode/implementation.ts:207)), but OS2's processor stream API explicitly throws for `subscribe()` ([codemode-session.ts](/Users/jonastemplestein/.superset/worktrees/iterate/raspy-produce/apps/os2/src/durable-objects/codemode-session.ts:320)). That means the event-only path is not an available production fallback in OS2 today; it is a different runtime feature.

The report also underplays RPC lifecycle risk. Cloudflare's lifecycle docs say returned `RpcTarget` stubs retain memory in the callee until disposed, with automatic disposal in some but not all cases (https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/). The Workers RPC overview further says forwarded stub proxying only lasts until execution contexts end (https://developers.cloudflare.com/workers/runtime-apis/rpc/). A live provider registry cache holding `RpcTarget`s can easily pin objects or expose stale capabilities unless the owner scopes them to a single call graph and disposes/duplicates deliberately.

The recommendation says "live target first, fallback to JSON callable." That is ergonomically appealing but can create semantic split-brain. A live target may carry exact instance authority and in-memory session state. A JSON `Callable` only names a resolver path whose authority comes from the supplied `CallableContext`; local code explicitly documents that `Callable` is JSON, not authority ([types.ts](/Users/jonastemplestein/.superset/worktrees/iterate/raspy-produce/packages/shared/src/callable/types.ts:20)). If live and durable routes can both exist for the same provider ID, the broker needs a declared equivalence model or callers will see different behavior depending on cache warmth.

## 3. Factual Corrections Against Docs And Local Code

The report's line "stub lifetime is execution-context scoped unless explicitly duplicated/disposed" is directionally right but compresses two cases. First, ordinary returned stubs should be explicitly disposed for performance because a client stub can keep the server object alive (https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/). Second, forwarded stubs are more restricted: Cloudflare says forwarding/proxying a stub to another Worker currently lasts only until the Workers' execution contexts end and cannot be persisted for later use (https://developers.cloudflare.com/workers/runtime-apis/rpc/). The report should distinguish "resource lifetime" from "forwarded proxy persistence."

The report implies `ctx.props` can carry trusted "deployment-time or loopback-provided" data. More precise: `ctx.exports` creates loopback service bindings for top-level exports, and loopback service bindings can be parameterized with `props`; Cloudflare says this is permitted because the caller is the same trusted Worker, and useful when passing the resulting binding to another Worker or Dynamic Worker (https://developers.cloudflare.com/workers/runtime-apis/context/). Dynamic Worker `env` can include structured clonable values and service bindings, including loopback bindings from `ctx.exports` (https://developers.cloudflare.com/dynamic-workers/api-reference/).

The report's Dynamic Worker `get()` wording should be stricter. Cloudflare says `load()` creates a fresh Worker and `get()` uses an ID for cached isolates, but there is no guarantee later requests with the same ID hit the same isolate, and code for the same ID must remain identical (https://developers.cloudflare.com/dynamic-workers/api-reference/). Therefore provider designs must not depend on `get()` preserving provider warm state across calls. Warm state is an optimization, not correctness.

"Current `ToolProviderDocumentation` has `path`, `docs`, optional `instructions`, and optional `typeDefinitions`" is correct against local code ([contract.ts](/Users/jonastemplestein/.superset/worktrees/iterate/raspy-produce/packages/shared/src/stream-processors/codemode/contract.ts:13)). But the suggested event schema omits `scriptExecutionId` from `FunctionCallCompleted`, while the current contract includes optional `scriptExecutionId` on both requested and completed events ([contract.ts](/Users/jonastemplestein/.superset/worktrees/iterate/raspy-produce/packages/shared/src/stream-processors/codemode/contract.ts:116)). Dropping it should be an explicit migration decision, not framed as "matches closely."

The report proposes `parentFunctionCallId`, but no current local codemode event supports it. Current call correlation is only `functionCallId` plus optional `scriptExecutionId` ([contract.ts](/Users/jonastemplestein/.superset/worktrees/iterate/raspy-produce/packages/shared/src/stream-processors/codemode/contract.ts:109)). The implementation's generated fallback IDs are source offset plus local sequence, and waiters match by `functionCallId` only ([implementation.ts](/Users/jonastemplestein/.superset/worktrees/iterate/raspy-produce/packages/shared/src/stream-processors/codemode/implementation.ts:132)). Nested call trees require a schema change.

The local Callable task note conflicts with the report's `describeToolProvider()` method proposal. The task note says a tool provider is a product-level record composed of one `Callable`, and describes provider metadata through a reserved provider-relative path `["__describe"]`, not through a distinct provider RPC interface ([tool-providers.md](/Users/jonastemplestein/.superset/worktrees/iterate/raspy-produce/packages/shared/src/callable/tasks/tool-providers.md:13)). The report can still recommend a richer internal RPC adapter, but it should call out that it is changing or superseding this planned callable shape.

Workers RPC visibility rules matter for any `RpcTarget` facade. Cloudflare exposes methods/properties declared on the class, but not arbitrary instance properties; plain objects are by-value (https://developers.cloudflare.com/workers/runtime-apis/rpc/visibility/). This supports the report's "narrow facade" point, but it also means provider authors must implement explicit class methods/getters and cannot expect instance-assigned methods to be callable over RPC.

The Callable descriptor schema intentionally denies many RPC method names, including `fetch`, `constructor`, `dup`, and `then` ([descriptor-types.ts](/Users/jonastemplestein/.superset/worktrees/iterate/raspy-produce/packages/shared/src/callable/descriptor-types.ts:79)). That aligns with Cloudflare's reserved/disallowed RPC method names (https://developers.cloudflare.com/workers/runtime-apis/rpc/reserved-methods/). Any provider API that relies on arbitrary dotted method names over Workers RPC conflicts with local callable constraints; dotted tool paths should stay payload data, not RPC method names.

## 4. Implications For "Any Processor Can Be Provider"

"Any processor can be provider" should mean "any processor can publish provider metadata and be adapted behind a broker," not "every processor runner automatically becomes an RPC provider." The former preserves the processor model. The latter mutates the runner abstraction into a service framework and makes `afterAppend` only one of multiple execution lanes.

The safe eligibility rule is:

1. A processor contract may declare stable, frontend-safe provider metadata.
2. A runtime deployment may register that processor instance as a provider route for a stream/session.
3. The broker is the only default caller-facing capability.
4. Provider execution must append request/completion events through the broker unless explicitly marked as event-only async work.
5. Live `RpcTarget` handoff is call-graph-local and non-durable; JSON `Callable` descriptors are durable references but not authority.

This makes "any processor" mostly a product and registry statement. A Slack transcript processor, JSONata transformer, MCP client bridge, or codemode processor can all advertise tools, but each still needs an adapter that maps `callFunction({ path, input, context })` onto either a live facade, a Callable dispatch, or an event-only responder. The processor contract alone cannot do that because it contains no live binding, no Durable Object identity, no `CallableContext`, and no permission policy.

It also means the provider surface should probably be separate from `ProcessorImplementation`. Adding optional provider methods directly to every implementation type would make pure processors import backend-only concepts and would blur frontend import safety. A better shape is a small runtime-side wrapper:

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

That adapter can close over the processor instance, warm clients created in `onStart`, or a `Callable`, without changing the public processor contract. It also gives the broker one place to enforce lifecycle append, depth limits, and authorization.

## 5. Revised Recommendation

Accept the report's hybrid broker direction, but narrow the claim and stage it more aggressively.

First slice: build a `ToolBrokerCapability` owned by `CodemodeSession`. It should be the only capability passed to Dynamic Workers and provider executions. It should append `function-call-requested`, route by longest path prefix, dispatch one registered provider adapter, append `function-call-completed`, and return/throw the live result. Add `parentFunctionCallId` only if the UI or trace model is ready to consume it; otherwise keep call tree work out of the first slice.

Do not expose every stream processor runner as RPC yet. Start with explicit provider adapters registered by deployment or by a durable provider registration event. Keep current `ToolProviderDocumentation` as model-visible metadata, but decide whether `["__describe"]` remains the canonical Callable-backed describe path or whether internal provider adapters use a separate `describe()` method.

Make event-only providers a later feature unless OS2 gets a real `subscribe()` path for processor-local waiting. The current OS2 codemode stream API throws for `subscribe()`, so event-only completion is not a dependable fallback today.

Treat live targets as ephemeral call-graph capabilities only. Never persist them, never place them in stream state, and avoid long-lived live route caches unless there is an explicit disposal policy. Durable provider records should persist only JSON metadata and JSON `Callable` descriptors; the authority grant remains the broker's scoped `CallableContext`.

The revised thesis should be:

> Any stream processor can be made available as a codemode tool provider through an explicit broker-owned provider adapter. The event stream remains the durable lifecycle and audit surface. Workers RPC / Cap'n Web carries scoped, non-durable execution authority for currently-live call graphs.

That statement is defensible against Cloudflare docs and the local code. The report's current conclusion is directionally right, but too permissive about runner RPC surfaces and too casual about the missing broker/router/policy layer.
