---
state: open
priority: high
size: medium
dependsOn: []
---

# Agents Processor Composition Requirements

Working note for the `apps/agents` processor redesign discussion. This is not constrained to the current implementation shape.

## Concrete Examples To Keep In View

- `AgentLoop` and `Codemode` processors. They currently run together in one Durable Object, but should be designed as if they may later run independently across a network.
- `apps/events/src/durable-objects/stream.ts` built-in processors. They run together in the stream Durable Object, share the same state storage, and are privileged enough to use `beforeAppend`.

## Deployment Modes

- Built-in processor: runs inside the stream Durable Object, shares stream state storage, may use `beforeAppend`.
- Durable Object processor: runs in its own Durable Object or agent Durable Object, keeps local durable state, communicates through stream events.
- Pull-based processor: subscribes to stream events remotely, rebuilds reduced state by replay, runs side effects only for live events unless explicitly designed otherwise.

## Resolved Requirements

- Reduced state slices must be separate. Do not merge processor states into one flat object.
- Composed state should be keyed by processor identity, likely the processor slug or similarly stable identifier.
- The stream is an append-only log. It assigns offsets. Processors do not choose offsets and do not decide where events land in the log.
- The only stream operations available to processors are: read, subscribe, append.
- Processor framing, docs, and APIs should make the read / subscribe / append model obvious.
- Processor runtime hooks should receive a scoped stream service API, not a vague context object.
- A processor is bound to a stream path.
- Appending without a path appends to the bound stream.
- Appending with a relative path appends to a child/relative stream path.
- Appending with an absolute path appends to that absolute stream path.
- The redesign does not need to preserve the current implementation model.
- Initial redesign target assumes one processor instance is scoped to one stream and has simple local reduced state for that stream.
- The host deployment mode owns persistence of reduced state.
- The processor owns state schema, initial state, and reducer logic, but not where reduced state is stored.
- Do not add lifecycle hooks such as `stop` unless a concrete processor example proves the need.
- Processor authors may choose whether to depend on raw host bindings/services or narrower wrapper services. The framework should not force one style unless a deployment mode requires it.
- Processors should not read sibling reduced state by default.
- If a processor needs another processor's view, it should consume that processor's public events and reduce its own local view, or directly import that processor's reducer for an independent projection.
- Sibling state access may exist only as an explicit escape hatch for permanently same-host built-in processors.
- Except for built-in `beforeAppend`, processor designs must assume arbitrary network lag and no same-turn ordering guarantees.
- `reduce` must not depend on processor ordering.
- `afterAppend` must not require ordering guarantees between processors. Any coordination must happen through committed stream events.
- Events appended by processors are eventually appended as new committed facts with their own offsets. Same-host append is not a same-turn processor call and must not be treated as an ordering guarantee.
- Built-in `beforeAppend` is the special privileged exception because it runs synchronously before stream commit inside `stream.ts`.

## Design Implications

- AgentLoop and Codemode should communicate through events, not direct calls or shared mutable state.
- Same-host composition may be an optimization, but must not be required for correctness unless the processor is explicitly built-in-only.
- If Codemode emits an event that AgentLoop consumes, correctness should come from the later committed event offset, not from Codemode running first in an in-process loop.
- Composition APIs should avoid implying deterministic same-turn ordering for ordinary processors.
- Public schemas/reducers should be ordinary TypeScript imports, not runtime dependency injection.
- `append` should be framed as writing a new event to the stream, not invoking another processor.
- `afterAppend` primarily needs the scoped stream API for appending derived events; read/subscribe may still belong on the same scoped stream service for completeness and testing.
- Processor self-description is important. A processor should be able to append an event describing itself, including event schemas and documentation.
- Processor self-description should include JSON Schema versions of event schemas where possible, so other processors and tools can inspect event types dynamically.
- Processor self-description must be represented as a normal stream event, not only as a host metadata endpoint.
- The event means roughly "this processor is registered/available/on the scene now".
- Processor registration/self-description events should include one processor `version`.
- Do not include state schema versions or event schema versions in the first design. Revisit schema versioning later.
- Processor registration should describe events the processor `consumes` and `emits`.
- Agent/codemode workflows should be able to read processor/event documentation from the stream.
- Tooling should support reading raw events by offset for LLM/codemode/debug use cases.
- Event catalogs should be defined separately from processor definitions to avoid self-referential definitions.
- Public processor modules should still expose ergonomic namespace-like access such as `AgentLoop.events.inputAdded`, `AgentLoop.reducer({ state, event })`, and `AgentLoop.initialState`.
- A downstream processor such as Codemode should be able to import `AgentLoop` and use both its event schemas and reducer directly when it wants an independent projection.
- Event construction helper naming is unresolved. Candidate helpers include `create`, `createInput`, or raw object literals with `satisfies`.

## Discuss Later

- Whether `append` is the right name, or whether APIs should use names like `onEvent` / `emit` / `write`.
- Testability: unit-test reducers, test processor runtime hooks, and run multiple processors together in harnesses to observe cross-processor event interactions before deployment.
- Future deployment topology: support advanced processors that handle many streams in one Durable Object, or singleton Durable Object processors subscribed to singleton/pattern streams such as `/slack/webhooks`.
- Future question: whether many-stream Durable Object processors should use Durable Object facets, a parent Durable Object with per-stream child routing, or a simpler internal map.
- Future deployment topology: support processors run by the system itself, dynamically created and updated on the fly, potentially using Durable Object facets in the events service or another system host.
- What the processor identity object should be called: slug, id, key, name, or something else.
- Whether event schema exports should be grouped as namespace-like objects such as `AgentLoop.events.inputAdded`.
- Whether class-based runtime instances or plain-object processors are the better first implementation for `apps/agents`.
- How much of this should be shared with `apps/events/src/durable-objects/stream.ts` immediately versus later.
- How dependencies should be modeled concretely for AgentLoop's AI binding and Codemode's WorkerLoader/outbound fetch/callable dispatch.
- What schema matching over `match(event).case(Some.events.foo.event, ...)` should look like in the redesigned API.
