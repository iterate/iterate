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
`events.iterate.com/core/stream-processor-registered`. Do not include `https://` or a
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

Runners initialize by parsing `initialState` through `stateSchema`. If
`initialState` is omitted, runners parse `undefined`, so Zod defaults still work
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
    firstAttachAfterAppend: { mode: "lookback", milliseconds: 250 },

    async afterAppend({ event, state, streamApi, signal }) {
      // call third-party APIs, schedule work, append derived events
    },
  });
}
```

Implementation hooks may use runtime dependencies. Contract reducers may not.

`firstAttachAfterAppend` is a runner preference, not a contract field. It tells
the runner whether very recent historical events should be allowed to run
`afterAppend` the first time this processor is attached to an existing stream.
Use it sparingly and pair it with idempotency keys for derived appends.

```ts
firstAttachAfterAppend: { mode: "none" }
firstAttachAfterAppend: { mode: "lookback", milliseconds: 250 }
firstAttachAfterAppend: { mode: "all" }
```

Most processors should use `none` or a short `lookback`. `all` is for deliberate
backfills where old side effects are desired.

## 7. Use State Plus Idempotency For Exactly-Once Appends

A common hook pattern is "append this helper event once, then remember that it
has round-tripped through the stream."

Do both parts:

- keep reduced state such as `hasAppendedCodemodePrompt`
- append with a stable idempotency key

```ts
// contract reducer
case "events.iterate.com/agent/input-added":
  return event.idempotencyKey === CODEMODE_PRIMER_IDEMPOTENCY_KEY
    ? { ...state, hasAppendedCodemodePrompt: true }
    : state;

// implementation hook
if (!state.hasAppendedCodemodePrompt) {
  await streamApi.append({
    event: {
      type: "events.iterate.com/agent/input-added",
      idempotencyKey: CODEMODE_PRIMER_IDEMPOTENCY_KEY,
      payload: {
        role: "user",
        content: CODEMODE_PRIMER_TEXT,
        triggerLlmRequest: { behaviour: "dont-trigger-request" },
      },
    },
  });
}
```

The state avoids trying to append on every live event. The idempotency key
handles races, retries, and repeated `afterAppend` attempts before the derived
event is observed back through the stream.

## 8. Derive Idempotency Keys From Source Events

When a hook appends because of a committed source event, derive the idempotency
key from that source event. This keeps retries safe without hiding the append
behind a special wrapper.

```ts
await streamApi.append({
  event: {
    type: "events.iterate.com/agent/input-added",
    idempotencyKey: buildDerivedIdempotencyKey({
      slug: CodemodeProcessorContract.slug,
      purpose: "result-to-agent-input",
      event,
    }),
    payload: {
      role: "user",
      content: renderCodemodeResult(event),
      triggerLlmRequest: { behaviour: "dont-trigger-request" },
    },
  },
});
```

Use a different `purpose` for each derivation site. One source event may produce
multiple derived events, but each derived event should have its own stable key.

## 9. Compose Dependency State By Running The Dependency Reducer

Do not reach into another processor instance. If a processor relies on another
processor's reduced state, make that dependency snapshot part of your own
reduced state.

```ts
stateSchema: z.object({
  processorDeps: z.object({
    agent: AgentProcessorContract.stateSchema,
  }),
  hasAppendedCodemodePrompt: z.boolean().default(false),
});
```

Then keep it current in your reducer by running the dependency reducer:

```ts
reduce({ state, event }) {
  const stateWithProcessorDeps = {
    ...state,
    processorDeps: {
      ...state.processorDeps,
      agent: reduceAgentEvents({
        state: state.processorDeps.agent,
        events: [event],
      }),
    },
  };

  // Continue reducing your own state from `stateWithProcessorDeps`.
}
```

Implementation hooks can then read the embedded dependency state directly:

```ts
const agentState = state.processorDeps.agent;

if (agentState.pendingTriggerCount === 0) {
  await streamApi.append({
    event: {
      type: "events.iterate.com/agent/status-updated",
      idempotencyKey: buildDerivedIdempotencyKey({
        slug: CodemodeProcessorContract.slug,
        purpose: "codemode-result-to-idle-status",
        event,
      }),
      payload: { status: "idle", reason: "codemode-result-added" },
    },
  });
}
```

This keeps reduced slices separate while still allowing local composition. The
conceptual model is "my processor's reduced state includes the dependency
snapshots it relies on", not "my hook reads another live processor object".

## 10. Frontend Projection Uses The Same Reducer

```ts
const state = reduceProcessorEvents({
  contract: AgentProcessorContract,
  events,
});
```

Frontend projection is reduce-only. It must not run `onStart`, `afterAppend`, or
any backend implementation factory.
