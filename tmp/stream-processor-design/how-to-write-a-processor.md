# How To Write A Processor

Draft. Keep this short and update it whenever the abstraction changes.

## 1. Put The Contract In A Frontend-Safe File

The contract file is the public surface. It may be imported by frontend code,
tests, other processors, and docs tooling.

Do include:

- Zod schemas
- `defineProcessorContract(...)`
- owned event definitions
- `stateSchema`
- optional `initialState`
- pure `reduce`

Do not include:

- Durable Object classes
- `WorkerEntrypoint`
- `Ai`, `Fetcher`, `WorkerLoader`
- MCP clients
- dynamic worker loaders
- HTTP calls, timers, sockets, or other runtime handles

## 2. Define Events Inline

```ts
export const AgentProcessorContract = defineProcessorContract({
  slug: "agent",
  version: "0.1.0",
  description: "Maintains model-visible context and LLM request state.",

  events: {
    "events.iterate.com/agent/input-added": {
      description: "A curated model-visible row of agent context.",
      payloadSchema: z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string(),
      }),
    },
  },

  consumes: ["events.iterate.com/agent/input-added"],
  emits: ["events.iterate.com/agent/input-added"],
});
```

Event definitions are keyed by their wire `type`. `consumes` and `emits` are
wire event type strings. TypeScript should reject strings that cannot be
resolved from owned events plus `processorDeps`.

Use event type strings in the shape `events.iterate.com/{processor-slug}/{short-event-type}`.
For core event shapes, use the core namespace, e.g.
`events.iterate.com/core/processor/registered`. Do not include `https://` or a
processor version in the event type.

## 3. Use `stateSchema` And Optional `initialState`

```ts
stateSchema: z.object({
  history: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string(),
  })),
}),
initialState: {
  history: [],
},
```

Hosts initialize by parsing `initialState` through `stateSchema`. If
`initialState` is omitted, hosts parse `undefined`, so Zod defaults still work
for tiny processors.

State must parse to an object. Do not use primitive or array top-level state.

## 4. Keep `reduce` Pure

```ts
reduce({ state, event }) {
  switch (event.type) {
    case "events.iterate.com/agent/input-added":
      return {
        ...state,
        history: [...state.history, event.payload],
      };
  }
}
```

Reducers:

- receive only events listed in `consumes`
- return the next serializable state object
- may return `undefined` or `null` for unchanged state
- must not call APIs, append events, start timers, mutate runtime state, or use
  backend-only dependencies

## 5. Declare Full Event Visibility In `consumes`

`consumes` means every event the processor may inspect in `reduce` or
`afterAppend`.

It is fine for a processor to own events it does not consume.

It is also fine for `reduce` to ignore an event that `afterAppend` needs. The
event should still appear in `consumes` so the implementation hook is typed and
the contract honestly describes processor visibility.

## 6. Put Side Effects In The Backend Implementation

The backend implementation lives in a separate file.

```ts
export function createAgentProcessor(deps: { ai: Ai }) {
  return implementProcessor(AgentProcessorContract, {
    async afterAppend({ event, state, streamApi, signal }) {
      // call third-party APIs, schedule work, append derived events
    },
  });
}
```

Implementation hooks may use runtime dependencies. Contract reducers may not.

## 7. Frontend Projection Uses The Same Reducer

```ts
const state = reduceProcessorEvents({
  contract: AgentProcessorContract,
  events,
});
```

Frontend projection is reduce-only. It must not run `onStart`, `afterAppend`, or
any backend implementation factory.
