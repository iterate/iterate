# Implementation Plan

This is a proposed order that keeps the blast radius manageable.

## Phase 1: Keep Shared Primitives Small

Already mostly done:

- `createEvent`
- `defineProcessorContract`
- `implementProcessor`
- `implementBuiltinProcessor`
- `runProcessorOnStart`
- `runProcessorReduce`
- `runProcessorAfterAppend`
- required object-shaped `state`
- optional `reduce`
- string-keyed `consumes` / `emits`
- RPC-shaped `ProcessorStreamApi.append({ event, streamPath? })`

Next cleanup:

- Move any exploratory shared code out of failing/temporary state.
- Add docs near the shared primitives with one AgentLoop/Codemode example.
- Decide whether the `tmp` sketches should become tests or stay design-only.

## Phase 2: Formalize StreamApi

Current sketch exists in `apps/agents/src/entrypoints/stream-api.ts`.

Next:

1. Add a small unit test for stream path resolution:
   - bound path + no operation path
   - bound path + relative child path
   - bound path + absolute path
   - no bound path + absolute path
   - no bound path + relative path should throw
2. Decide whether `read` should be finite by default.
   - Current sketch uses `beforeOffset: "end"` for `read`.
   - `subscribe` remains open.
3. Decide whether this belongs only in `apps/agents`, or whether a generic
   StreamApi entrypoint belongs in the events app too.

## Phase 3: Split Contracts First

Create production-ish files, probably not under `durable-objects`:

```txt
apps/agents/src/stream-processors/
  agent-loop/
    contract.ts
    processor.ts
    state.ts
    events.ts
  codemode/
    contract.ts
    processor.ts
    state.ts
    events.ts
  mcp/
    contract.ts
```

Do not start with Durable Objects. First make the contracts importable and
unit-testable.

Hard rule:

- AgentLoop state and Codemode state stay separate.
- No `IterateAgentProcessorState`.
- No direct access to sibling reduced state.

## Phase 4: Build a Pull Runner

Implement a small runner outside the app DOs:

```ts
runPullProcessor({
  processor,
  streamApi,
  loadState,
  saveState,
  signal,
});
```

This proves that the processor implementation does not care whether it is
hosted in a DO or a long-running pull subscription.

Important:

- replay is reduce-only
- onStart after replay/cache load
- live delivery is reduce, save, afterAppend

## Phase 5: Replace IterateAgent with Explicit Processor DOs

Stop subclassing Cloudflare `Agent`.

Create something like:

```ts
export class AgentLoopProcessorDO extends DurableObject<Env> {}
export class CodemodeProcessorDO extends DurableObject<Env> {}
```

First version can be WebSocket-subscription based:

- Events service pushes committed events to the DO.
- DO stores its own reduced state.
- DO appends derived events through `StreamApi`.

This is conceptually closest to the current system but removes the `Agent`
base class and the fused processor state.

## Phase 6: Extract `withStreamProcessor`

Only after one or two real DOs exist, extract common host code into a mixin:

```ts
const Base = withStreamProcessor({
  createProcessor,
  createStreamApi,
})(withDurableObjectCore(DurableObject));

export class AgentLoopProcessorDO extends Base<Env> {}
```

Do not make it multi-stream at first.

Use the repo skill before implementing this for real:

```txt
adding-a-new-durable-object-mixin
```

The mixin should probably own:

- `processStreamEvent({ streamPath, event })`
- state load/save
- onStart once per stream path
- reduce/save/afterAppend

The mixin should not own:

- how the DO receives events
- how the processor is registered/subscribed
- access policy
- arbitrary task tracking

## Phase 7: Clean Up `stream.ts`

`stream.ts` should become a host for:

- append-only log
- offset allocation
- idempotency
- reduced state persistence
- subscriber fanout
- child stream propagation
- built-in `beforeAppend` processors only
- alarm slot delegation

Move out:

- dynamic worker behavior that can be a normal processor
- scheduler behavior except alarm pointer glue
- external subscriber behavior where possible
- processor registration/docs emission where possible

Some code remains core because it is not normal processor behavior:

- before-commit rejection
- storage transaction
- parent/child stream structural invariants
- websocket fanout

## Phase 8: MCPConnection DO

Create a separate DO:

```ts
export class MCPConnection extends DurableObject<Env> {}
export class MCPToolProvider extends WorkerEntrypoint<Env, { connectionId: string }> {}
```

Codemode should not hold live MCP connections. Codemode should consume events
that describe tool providers, then call provider bindings/callables.

Likely stream events:

- `mcp-connection-configured`
- `mcp-connection-ready`
- `mcp-connection-failed`
- `tool-provider-config-updated`

## Main Insights So Far

### Required State Is Better For Now

Allowing omitted state seemed ergonomic, but it made generic host helpers infer
`{}` or `unknown` in awkward places. Requiring `state: z.object({}).default({})`
for stateless processors is a good temporary tradeoff.

### Composition Is Mostly Hosting

There may not be a big conceptual difference between "small reusable logic" and
"processor composition". The key is whether the unit owns:

- public events
- state schema
- reducer
- live side effects

If yes, it is basically a small processor.

### Order Should Not Be Semantic

Same-host ordering can exist mechanically, but no ordinary processor should rely
on it for correctness. If Codemode needs AgentLoop to know something, it appends
an event.

### `onStart` Is Reconciliation, Not Construction

`onStart` means:

1. reduced state is available
2. historic replay or cache load is done
3. now reconcile runtime-only resources

It does not mean:

- DO constructor
- websocket connected
- process booted

### `stream.ts` Should Stay Boring

The more `stream.ts` looks like "append, persist, fan out, host built-ins", the
better. Processor-specific scheduling, dynamic workers, subscriptions, renderers,
and docs should move out where possible.
