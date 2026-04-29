# Stream Processor Redesign Sketch

This folder is exploratory. It is not production code and should not be
imported by the app.

The goal is to make the design concrete enough to critique:

- AgentLoop and Codemode are separate processors.
- Each processor has its own contract, state schema, reducer, and implementation.
- Processors coordinate through stream events, not shared state or direct calls.
- Runners own persistence, subscriptions, stream bindings, and deployment details.
- Processor code is deployable in multiple ways:
  - pull subscription runner
  - inbound WebSocket subscription Durable Object
  - built-in processor inside `stream.ts`
  - future `withStreamProcessor(...)` Durable Object mixin
- The scoped stream API is a Cloudflare `WorkerEntrypoint` exported from the
  script main module and instantiated through `ctx.exports.StreamApi({ props })`.

## Current Recommended Shape

Processor contract:

```ts
export const AgentProcessorContract = defineProcessorContract({
  slug: "agent",
  version: "0.1.0",
  description: "Turns stream events into LLM lifecycle events.",
  stateSchema: AgentState,
  initialState: {},
  processorDeps: [CodemodeProcessorContract, CoreStreamProcessorContract],
  events: {
    "events.iterate.com/agent/input-added": {
      description: "A curated model-visible row of agent context.",
      payloadSchema: z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string(),
      }),
    },
  },
  consumes: ["events.iterate.com/agent/input-added", "events.iterate.com/codemode/result-added"],
  emits: ["events.iterate.com/agent/input-added", "events.iterate.com/agent/llm-request-scheduled"],
  reduce,
});
```

Processor implementation:

```ts
export function createAgentProcessor(deps: AgentDeps) {
  return implementProcessor(AgentProcessorContract, {
    firstAttachAfterAppend: { mode: "lookback", milliseconds: 250 },

    async onStart({ state, streamApi, signal }) {
      reconcileRuntimeFromReducedState({ state, streamApi, signal, deps });
    },
    async afterAppend({ event, state, previousState, streamApi, signal }) {
      // live side effects only
    },
  });
}
```

Runner live delivery:

```ts
const reduction = runProcessorReduce({ processor, event, state });

if (reduction != null) {
  await saveProcessorState(reduction.state);
  await runProcessorAfterAppend({ processor, ...reduction, streamApi, signal });
}
```

Runner replay:

```ts
for await (const event of historicEvents) {
  const reduction = runProcessorReduce({ processor, event, state });
  if (reduction != null) state = reduction.state;
}
await saveProcessorState(state);
await runProcessorOnStart({ processor, state, streamApi, signal });
```

## Important Design Lines

### Contract vs Implementation

The contract is importable anywhere:

- frontend projections
- tests
- dependent processors
- docs generation
- event schema catalog

The implementation is runner/runtime code:

- calls third-party APIs
- appends derived events
- starts timers
- reconciles runtime-only connections from reduced state

### Runtime State vs Reduced State

Reduced state is serializable and owned by the runner.

Runtime state belongs inside the implementation instance or a separate DO:

- timers
- abort controllers
- MCP connections
- loaded dynamic workers
- HTTP clients

`onStart` is the key bridge. It fires only after the runner has loaded or replayed
reduced state.

### Composition

Same-runner composition is a deployment optimization, not a correctness model.

If AgentLoop and Codemode run together, they still communicate through appended
events. The same code should work if they run across a network with different
latency.

### Built-in Processors

Built-in processors are the only processors allowed to use `beforeAppend`.
They run inside `stream.ts` because they can reject events before commit.

Everything else should be expressible as normal contracts plus normal
`afterAppend`.

## Files

- `contracts.ts`: concrete AgentLoop, Codemode, CoreStream, and MCP event shapes.
- `composition.ts`: same-runner composition without state sharing.
- `pull-runner.ts`: pull subscription runner sketch.
- `websocket-subscription-processor-do.ts`: inbound WebSocket subscription DO runner.
- `with-stream-processor.ts`: possible Durable Object mixin API.
- `clean-stream-do.ts`: what a cleaned-up `stream.ts` could look like.
- `mcp-connection-do.ts`: separate MCP connection DO / tool provider sketch.
- `frontend-reducer-poc.contract.ts`: frontend-safe AgentLoop contract/projection proof of concept.
- `frontend-reducer-poc.ui.tsx`: agents UI sketch that imports the contract but not the backend implementation.
- `frontend-reducer-poc.md`: notes from the frontend reducer proof of concept.
- `runner-sketches.md`: pull, Durable Object, and built-in stream runner sketches.
- `design-review-sharp-edges.md`: consolidated critique from review agents.
- `prior-art-notes.md`: prior art scan and blind spots.
- `how-to-write-a-processor.md`: concise authoring guide we update as the API settles.
- `questions.md`: open decisions worth discussing next.
