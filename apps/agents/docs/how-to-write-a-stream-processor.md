# How To Write A Stream Processor

This is the current concise authoring guide for the processor abstraction we are still proving out.

## Split Contract And Implementation

Put the frontend-safe public contract in one module:

- `slug`, `version`, `description`
- inline event definitions keyed by full event type string
- `stateSchema` and optional `initialState`
- optional pure `reduce`
- explicit `processorDeps`, `consumes`, and `emits`

Do not import Cloudflare bindings, Durable Objects, dynamic worker loaders, MCP clients, AI bindings, or third-party API clients from contract modules. Frontend code should be able to import the contract and replay events through the reducer to compute UI state.

Put side effects in an implementation factory:

```ts
export function createAgentProcessor(deps: AgentProcessorDeps) {
  return implementProcessor(AgentProcessorContract, {
    async afterAppend({ event, state, streamApi, signal }) {
      // call services from deps
      // append derived stream events through streamApi
    },
  });
}
```

Runtime dependencies belong in `deps`: AI bindings, code executors, HTTP clients, tool registries, timers, MCP connection clients, and test doubles.

## Contract Shape

Author event definitions inline. Keep `consumes` and `emits` as visible strings so grep and code review can see the wire contract:

```ts
export const ExampleProcessorContract = defineProcessorContract({
  slug: "example",
  version: "0.1.0",
  description: "Example processor.",
  stateSchema: z.object({
    ...standardProcessorBehavior.stateShape,
    count: z.number().int().default(0),
  }),
  initialState: {
    ...standardProcessorBehavior.initialState,
  },
  processorDeps: [...standardProcessorBehavior.processorDeps],
  events: {
    "events.iterate.com/example/incremented": {
      description: "The example count was incremented.",
      payloadSchema: z.object({ by: z.number().int() }),
    },
  },
  consumes: [...standardProcessorBehavior.consumes, "events.iterate.com/example/incremented"],
  emits: [...standardProcessorBehavior.emits, "events.iterate.com/example/incremented"],
  reduce({ contract, state, event }) {
    let nextState = state;

    nextState = standardProcessorBehavior.reduce({
      contract,
      state: nextState,
      event,
    });

    switch (event.type) {
      case "events.iterate.com/core/stream-processor-registered":
        return nextState;
      case "events.iterate.com/example/incremented":
        return { ...nextState, count: nextState.count + event.payload.by };
      default:
        return assertNever(event);
    }
  },
});
```

`defineProcessorContract(...)` is a typed identity. It should not hide or rewrite your contract. Its job is to make bad strings, bad state shapes, and bad append types fail while preserving the object you wrote.

## Standard Processor Behavior

Most processors should include `standardProcessorBehavior` for now. It is a temporary bag of repeated pieces, not the final composition system.

It currently provides:

- base state for whether this processor version has registered itself
- core processor dependency
- core registration event in `consumes` and `emits`
- reducer fragment for observing your own registration event
- `afterAppend` fragment that appends your registration event exactly once

Call the reducer fragment near the start of your reducer, then handle your own
state changes normally. Call the `afterAppend` fragment near the start of your
implementation hook, then run processor-specific side effects normally.

Prefer ordinary reducer code over clever composition wrappers. If your processor
wants to reuse another processor's reducer, store the result in a normal state
field and update that field at the top of your reducer:

```ts
let nextState = state;

nextState = {
  ...nextState,
  agentProcessor: reduceAgentEvents({
    state: nextState.agentProcessor,
    events: [event],
  }),
};
```

This is just processor implementation code. We are deliberately not naming this
as a separate abstraction yet.

## Exactly Once Patterns

If a processor should do a one-time append, use both reduced state and stream idempotency.

Reduced state stops the implementation from trying every time it sees an event:

```ts
case "events.iterate.com/agent/input-added":
  return event.idempotencyKey === CODEMODE_PRIMER_IDEMPOTENCY_KEY
    ? { ...state, hasAppendedCodemodePrompt: true }
    : state;
```

The idempotency key protects against retries, cold starts, and duplicate delivery:

```ts
await streamApi.append({
  event: {
    type: "events.iterate.com/agent/input-added",
    payload: { role: "system", content },
    idempotencyKey: CODEMODE_PRIMER_IDEMPOTENCY_KEY,
  },
});
```

For derived events, use `buildDerivedIdempotencyKey(...)` and still call plain `streamApi.append(...)`. Do not add a special `appendDerived` wrapper:

```ts
await streamApi.append({
  event: {
    type: "events.iterate.com/agent/input-added",
    payload,
    idempotencyKey: buildDerivedIdempotencyKey({
      slug: CodemodeProcessorContract.slug,
      purpose: "codemode-result-to-agent-input",
      event,
    }),
  },
});
```

Use a distinct `purpose` for each derivation site.

## StreamProcessorRunners

A StreamProcessorRunner owns deployment mechanics: creating processor instances, injecting backend-only dependencies, storing reduced state, creating a scoped `streamApi`, catching up, and consuming pushed or subscribed events.

The current Durable Object StreamProcessorRunner pattern binds one runner instance to one stream path through lifecycle init params:

```ts
await runner.initialize({ name, streamPath });
await runner.consumeEvent({ event });
```

For push subscriptions, the worker websocket route initializes the StreamProcessorRunner with `{ name, streamPath }` and forwards frames into the Durable Object. The StreamProcessorRunner then catches up before it processes the first pushed event.

`apps/agents` currently uses three independent runners for one chat stream:

- `WebchatStreamProcessorRunner` consumes `events.iterate.com/webchat/*` and renders those raw events into `events.iterate.com/agent/input-added`.
- `AgentStreamProcessorRunner` consumes curated agent input and owns LLM scheduling/status events.
- `CodemodeStreamProcessorRunner` consumes agent assistant input, executes codemode blocks through an injected code executor, and may emit `events.iterate.com/webchat/agent-response-added`.

This separation is deliberate. The processors coordinate only through appended stream events, so they can later move across network boundaries without changing their contracts.

Do not assume same-runner ordering between processors. If Codemode needs Agent state, keep an explicit local projection in Codemode state and update it by running Agent's reducer over consumed Agent events.
