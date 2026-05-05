# How To Write A Stream Processor

This is the current concise authoring guide for the processor abstraction we are still proving out.

This guide sits underneath [jonasland/RULES.md](../../../jonasland/RULES.md).
Those repo-wide rules still apply here: put the most important thing at the top,
write invisible TypeScript, do not declare infrequently used aliases, and only
extract abstractions that are easy to explain.

## Split Contract And Implementation

Put the frontend-safe public contract in one module:

- `slug`, `version`, `description`
- inline event definitions keyed by full event type string
- `stateSchema` and optional `initialState`
- optional pure `reduce`
- explicit `processorDeps`, `consumes`, and `emits`

Prefer defining the processor state schema inline as `stateSchema: z.object(...)`
inside the contract. Do not pull it up into `FooStateSchema` just to immediately
write `export type FooState = z.infer<typeof FooStateSchema>`. The contract
already carries the state type; use `ProcessorState<typeof FooProcessorContract>`
in tests or integration code when a named state type is genuinely needed.

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

When a feature contains multiple processors, give each processor its own folder
with its own `contract.ts`, `implementation.ts`, and one integrated test file
named after the processor folder, for example `slack.test.ts` or
`slack-thread.test.ts`. That test should cover reducer behavior and
implementation `afterAppend` behavior together, because the contract and
implementation are two halves of one stream processor.

Keep the dependency direction explicit. A pure router should not import the
interpreter or worker that consumes routed events. The downstream processor may
depend on the router contract when it consumes router-owned events.

For example, Slack is split into `slack` and `slack-thread`. The `slack`
processor owns the raw `events.iterate.com/slack/webhook-received` event, keeps
a reduced `channel:slack_ts -> streamPath` lookup table, and forwards raw
webhooks when it can derive a lookup key. It does not know about the Agent
processor and does not translate Slack into agent input. The `slack-thread`
processor runs on the Slack-backed agent stream, consumes the forwarded raw
webhooks, and is the only Slack processor that interprets Slack activity as
agent events. In the current POC, it should only emit agent input. Slack writes
such as reactions, status updates, or thread replies should be ordinary agent
tool calls unless we later decide there is a durable processor-level side effect
that truly belongs in the event model.

## Keep TypeScript Boring

Processor implementation files should read like ordinary event handlers. The
same switch conventions apply in `afterAppend` hooks as in reducers: real work
first, deliberately ignored consumed events stacked at the end, then a plain
`default` that returns. We are not using exhaustive match guards here for now;
the standard processor behavior splat makes that more awkward than useful.

Prefer a slightly longer `afterAppend` switch over helper extraction that needs
local type aliases just to recover the event narrowing you already had inside
the case.

Idiomatic:

```ts
async afterAppend({ event, state, streamApi }) {
  await standardProcessorBehavior.afterAppend({ contract: ExampleContract, state, streamApi });

  switch (event.type) {
    case "events.iterate.com/example/commanded":
      await streamApi.append({
        event: {
          type: "events.iterate.com/agent/input-added",
          payload: { content: event.payload.text },
          idempotencyKey: buildDerivedIdempotencyKey({
            slug: ExampleContract.slug,
            purpose: "commanded-to-agent-input",
            event,
          }),
        },
      });
      return;
    case "events.iterate.com/core/stream-processor-registered":
    case "events.iterate.com/example/observed":
    default:
      return;
  }
}
```

Not idiomatic:

```ts
type ExampleApi = ProcessorStreamApi<typeof ExampleContract>;
type CommandedEvent = Extract<
  ConsumedEvent<typeof ExampleContract>,
  { type: "events.iterate.com/example/commanded" }
>;

async function handleCommanded(args: { event: CommandedEvent; streamApi: ExampleApi }) {
  // ...
}
```

Names should earn their keep. `ExampleProcessorDeps` is useful because it names
a public dependency contract. `CommandedEvent` and `ExampleApi` usually just
rename framework machinery. If a helper needs twenty lines of TypeScript to
exist, the helper probably made the file harder to read.

Use helpers only when they remove real domain complexity. Keep framework
plumbing in the visible `switch` until we have a well-motivated framework
helper. Do not invent local middleware or wrapper abstractions just to hide
standard processor behavior.

When an event payload has its own discriminant and the processor is actually
interpreting that discriminant, prefer a nested switch over a run of sibling
`if` statements. The nested switch should follow the same order: handled cases
first, ignored cases stacked at the end, then a plain `default`.

```ts
case "events.iterate.com/example/webhook-received": {
  const webhook = event.payload.body;

  switch (webhook.kind) {
    case "command":
      // append command-derived events
      return;
    case "status":
      // append status-derived events
      return;
    case "ignored":
    default:
      return;
  }
}
```

Do not invent a discriminated wrapper just to get a switch. The Slack webhook
router is intentionally structural: if a raw Slack webhook gives us a
`channel:slack_ts` key that already exists in reduced state, the router forwards
the raw webhook; otherwise it does nothing.

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
        return nextState;
    }
  },
});
```

`defineProcessorContract(...)` is a typed identity. It should not hide or rewrite your contract. Its job is to make bad strings, bad state shapes, and bad append types fail while preserving the object you wrote.

### Event Lifecycle Naming

Use event suffixes to say what the processor knows at the time it appends the
event.

Use `requested` when a processor records intent for another processor or
runtime to act later. For example, an agent processor should append
`events.iterate.com/agent/llm-request-requested` when it has prepared the LLM
input and is handing the request to whichever LLM processor is subscribed. The
agent has not started the provider call, so `started` would overclaim.

Use `started` when the processor that owns the side effect has actually begun
executing it. For example, a Cloudflare AI processor may append
`events.iterate.com/cloudflare-ai/llm-request-started` immediately before it
calls the Cloudflare binding or Gateway endpoint.

Use one terminal `completed` event for both success and failure. Put the outcome
in the payload instead of splitting terminal events into `completed` and
`failed` siblings:

```ts
"events.iterate.com/example/llm-request-completed": {
  payloadSchema: z.object({
    llmRequestId: z.number().int(),
    durationMs: z.number().int(),
    result: z.discriminatedUnion("status", [
      z.object({
        status: z.literal("success"),
        output: z.string(),
      }),
      z.object({
        status: z.literal("failure"),
        error: z.object({ message: z.string() }),
      }),
    ]),
  }),
},
```

This keeps subscribers simple: they watch one terminal event and switch on the
payload when they need to distinguish success from failure. Use separate
streaming or transport events only for facts that happen before the terminal
event, such as `sse-event-received`, `websocket-message-received`, or
`http-response-received`.

### Cross-Processor Request Contracts

Processors coordinate by appending stream events into the ether. A processor
that appends a request event is declaring work it wants done; it is not calling
a specific processor directly. A subscribed processor that understands that
request event may later append response events that satisfy the request.

Document this ownership in the contract description and event descriptions for
both sides. A reader should be able to answer:

- which processor appends the request event
- which processor family is expected to consume it
- which events the consumer must append in response
- which event id or offset correlates the response back to the request

For LLM requests, the agent processor owns the request intent:

```ts
events.iterate.com / agent / llm - request - requested;
// appended by: agent
// consumed by: one subscribed LLM request processor, such as openai-ws or cloudflare-ai
// correlation: llmRequestId is the offset of this requested event
```

The subscribed LLM request processor owns provider execution and must append
the agent-level response events directly. The agent processor should not
translate provider-specific completions into agent output; that would make the
agent processor know every provider's response shape.

```ts
events.iterate.com / agent / output - added;
// appended by: subscribed LLM request processor
// consumed by: agent, codemode, webchat, and other output-aware processors

events.iterate.com / agent / llm - request - completed;
// appended by: subscribed LLM request processor
// consumed by: agent and other lifecycle-aware processors
// payload result.status is "success" or "failure"
```

Provider processors may also append provider-owned trace events, such as
`events.iterate.com/openai-ws/websocket-message-received` or
`events.iterate.com/cloudflare-ai/sse-event-received`. Those events are for raw
transcript, replay, and debugging. They do not replace the agent-level response
events the provider owes back to the stream.

## Reducer Shape

Reducers and implementation hooks should branch on `event.type` with a
top-level `switch`. Use nested `if` statements or nested switches inside a case
when the payload needs more branching, but do not write a chain of top-level
`if (event.type === ...)` checks.

This is a convention, not just style preference. A switch keeps the consumed
event surface visible and makes later additions easier to review. For now,
finish switches with a plain `default` branch that returns unchanged state from
reducers or returns from implementation hooks. Do not use exhaustive match
guards until the standard processor behavior has better ergonomics.

If a reducer or `afterAppend` hook intentionally ignores consumed events, put
those cases at the end of the switch, immediately before `default`. It is fine
to stack multiple ignored cases on top of each other. This is active
documentation: the processor consumes those events, has considered them, and
currently does not reduce state or run side effects from them.

Idiomatic:

```ts
reduce({ contract, state, event }) {
  const nextState = standardProcessorBehavior.reduce({ contract, state, event });

  switch (event.type) {
    case "events.iterate.com/example/incremented":
      if (event.payload.by === 0) return nextState;
      return { ...nextState, count: nextState.count + event.payload.by };
    case "events.iterate.com/core/stream-processor-registered":
    case "events.iterate.com/example/observed":
    case "events.iterate.com/agent/status-updated":
    default:
      return nextState;
  }
}
```

`standardProcessorBehavior.consumes` means your reducer consumes the core
registration event too. Handle it as a normal inline wire string:

```ts
case "events.iterate.com/core/stream-processor-registered":
  return nextState;
```

Do not import `CoreProcessorRegisteredEventType` just to avoid writing this
string in the switch. Core processor events are still stream event strings, so
the same inline-string rule applies.

Not idiomatic:

```ts
reduce({ state, event }) {
  if (event.type === "events.iterate.com/example/incremented") {
    return { ...state, count: state.count + event.payload.by };
  }
  return state;
}
```

Also not idiomatic:

```ts
switch (event.type) {
  case CoreProcessorRegisteredEventType:
    return nextState;
}
```

### Event Strings Are The Contract

Use full event type strings inline in the contract and implementation. This is
intentional duplication: the string is the durable wire API, and reviewers
should be able to see it at every use site without jumping through an exported
constant.

Idiomatic:

```ts
events: {
  "events.iterate.com/slack/webhook-received": {
    payloadSchema: z.object({ body: z.record(z.string(), z.unknown()) }),
  },
},
consumes: [
  ...standardProcessorBehavior.consumes,
  "events.iterate.com/slack/webhook-received",
],
reduce({ state, event }) {
  switch (event.type) {
    case "events.iterate.com/core/stream-processor-registered":
      return state;
    case "events.iterate.com/slack/webhook-received":
      // event.payload is narrowed here
    default:
      return state;
  }
}
```

Not idiomatic:

```ts
export const slackWebhookReceivedEventType = "events.iterate.com/slack/webhook-received";

events: {
  [slackWebhookReceivedEventType]: { /* ... */ },
},
consumes: [slackWebhookReceivedEventType],
```

Do not export event-type constants just to avoid repeating strings. Exported
constants make the public API larger, make contracts harder to scan, and hide
the actual wire string from grep-oriented review. If an event string changes,
that is a contract change; update each use site deliberately.

Named helpers are still fine when they encode behavior rather than aliases.
`slackWebhookReceivedEventType` is not useful because it only renames the wire
string.

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

## First Attach Side Effects

`afterAppend` usually runs only for live events. When a processor first attaches
to an existing stream, the runner first catches up reduced state from historical
events. To avoid missing the common race where a processor is subscribed just
after a stream is created, the framework default also runs `afterAppend` for
events from the last one second of first-attach history.

Almost never set `firstAttachAfterAppend` on a processor. Leave it unset for the
standard short lookback default:

```ts
export function createExampleProcessor() {
  return implementProcessor(ExampleProcessorContract, {
    async afterAppend({ event, state, streamApi }) {
      // ...
    },
  });
}
```

Set it explicitly only when the default would be surprising. Use `none` when
even very recent first-attach side effects would be confusing or unsafe:

```ts
export function createExampleProcessor() {
  return implementProcessor(ExampleProcessorContract, {
    firstAttachAfterAppend: { mode: "none" },
    async afterAppend({ event, state, streamApi }) {
      // ...
    },
  });
}
```

Do not set `{ mode: "lookback", milliseconds: 1_000 }` just to repeat the
default. This is runner lifecycle policy, so it belongs in the implementation
or runner override, not in the contract.

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
    payload: { content },
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
