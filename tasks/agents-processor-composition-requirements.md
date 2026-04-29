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
- In Cloudflare Workers, the scoped stream API should be a top-level named `WorkerEntrypoint` export instantiated through `ctx.exports.StreamApi({ props: { streamPath } })`.
- `StreamApi` props should currently include `streamPath?: string`, with room for future operation policies.
- A processor is bound to a stream path.
- Appending without a path appends to the bound stream.
- Appending with a relative path appends to a child/relative stream path.
- Appending with an absolute path appends to that absolute stream path.
- The redesign does not need to preserve the current implementation model.
- Initial redesign target assumes one processor instance is scoped to one stream and has simple local reduced state for that stream.
- The host deployment mode owns persistence of reduced state.
- The processor owns state schema and reducer logic when it needs them, but not where reduced state is stored.
- Processor state schema is required for now. Name the property `stateSchema`.
- `initialState` is optional. If it is present, hosts parse it through `stateSchema`; if it is omitted, hosts parse `undefined` through `stateSchema`.
- Prefer explicit `initialState` for non-trivial processors so authors do not need to know Zod's `.prefault(...)` behavior.
- Stateless processors may declare `stateSchema: z.object({}).default({})` and omit `initialState`.
- Add runtime validation/tests that processor contracts can produce an initial state from `initialState` or `undefined`.
- Processor state must always be object-shaped. Primitive or array state schemas should fail type tests for authored contracts and fail runtime validation for dynamically assembled contracts.
- Authored contracts should fail at `defineProcessorContract(...)` when `consumes` or `emits` names an event type that cannot be resolved from owned events plus `processorDeps`.
- Runtime contract validation is still required for dynamically loaded or assembled contracts.
- Omitted `reduce` means identity reduction. This keeps side-effect-only processors lightweight while preserving one host lifecycle.
- A reducer may return `null` or `undefined` to mean that a consumed event leaves state unchanged.
- Reducer outputs must also be object-shaped at runtime, so a bad dynamic contract cannot corrupt a persisted state slice with a primitive or array.
- Do not add lifecycle hooks such as `stop` unless a concrete processor example proves the need.
- Add a concrete startup hook for the point after reduced state has caught up from persisted state or historical replay.
- The startup hook exists to materialize non-serializable runtime state from reduced state, such as MCP server connections, HTTP clients, subscriptions, timers, or other live handles.
- The startup hook should not run before the host has restored/replayed the processor's reduced state.
- Pull-based processor hosts should connect to the stream, read historic events, reduce state, and only then call the startup hook.
- Durable Object hosts may load cached reduced state instead of replaying all events, but should still call the startup hook only after that state is available.
- Push-based hosts such as a Durable Object with an inbound WebSocket stream subscription should call the startup hook when they consume the first live event, after any required reduced-state catch-up for that event.
- Across deployment modes, the startup invariant is: restore or replay reduced state, then call startup hook, then run live `afterAppend` processing.
- The shared startup helper should expose this as `runProcessorOnStart({ processor, state, streamApi, signal })`.
- Processor authors may choose whether to depend on raw host bindings/services or narrower wrapper services. The framework should not force one style unless a deployment mode requires it.
- Processor implementations should be factory functions that receive dependencies once and return the mountable implementation. Those dependencies are then available inside implementation hooks.
- Hook argument objects should use object parameters, not positional parameters.
- In a class-based implementation, hooks should read reduced state from `this.state` rather than receiving state as a positional or hook-local argument.
- The class instance may keep the current reduced state as an in-memory mirror, while the host still owns persistence.
- When present, the reducer must remain a standalone contract function so frontend code, tests, projections, and dependent processors can import it without constructing the processor implementation.
- Do not lead with a class-based implementation API in the first design. Class-backed processors remain a possible later implementation style, but object/factory processors infer hook argument types more cleanly from the contract.
- Processor hook designs should pass `previousState` and current `state` in object args because reconciliation logic often needs both.
- Runtime-only resources such as MCP connections should be reconciled from reduced state, not incrementally trusted. Connection setup/removal should use cancellation or generation checks so stale async work cannot reintroduce removed resources.
- Processors should not read sibling reduced state by default.
- If a processor needs another processor's view, it should consume that processor's public events and reduce its own local view, or directly import that processor's reducer for an independent projection.
- Sibling state access may exist only as an explicit escape hatch for permanently same-host built-in processors.
- Except for built-in `beforeAppend`, processor designs must assume arbitrary network lag and no same-turn ordering guarantees.
- `reduce` must not depend on processor ordering.
- `afterAppend` must not require ordering guarantees between processors. Any coordination must happen through committed stream events.
- Events appended by processors are eventually appended as new committed facts with their own offsets. Same-host append is not a same-turn processor call and must not be treated as an ordering guarantee.
- Built-in `beforeAppend` is the special privileged exception because it runs synchronously before stream commit inside `stream.ts`.
- Derived appends need a first-class idempotency convention based on processor identity, source event offset/id, and a caller-provided suffix.
- Do not add a special `appendDerived` stream method in the first design. Prefer a small helper that returns ordinary event input fields that can be spread into `createInput(...)`.
- Hosts should treat processor delivery, reduced-state persistence, checkpoints, and derived appends as one consistency problem. The transaction boundary must be explicit in the design before stabilizing the public API.
- Host-owned processor progress should keep reduced-state progress separate from live hook completion.
- The current minimal host state envelope is `{ state, reducedThroughOffset, afterAppendCompletedThroughOffset }`.
- `reducedThroughOffset` means the reducer result for that committed event has been persisted.
- `afterAppendCompletedThroughOffset` means live `afterAppend` work for that committed event has completed successfully.
- If `afterAppend` fails after state is reduced, the host must be able to see that `afterAppendCompletedThroughOffset < reducedThroughOffset` and retry live effects without re-reducing from scratch.
- Durable Object hosts must serialize processor delivery and avoid reentrant processor delivery when processors append during event handling.
- Pull/replay hosts must make replay/live behavior explicit. Historical catch-up should not run side-effect hooks by default.
- `contract.consumes` should mean every event the processor may inspect in `reducer` or `afterAppend`.
- Reducers should receive events matching the declared consumed event types, not arbitrary stream events.
- `afterAppend` should receive events matching the declared consumed event types.
- Hosts are responsible for filtering/narrowing stream events against `contract.consumes` before invoking a reducer or `afterAppend`.
- The shared reduction helper should expose this as `runProcessorReduce({ processor, event, state })`, returning `{ event, previousState, state }` for consumed events and `undefined` for ignored events.
- Live hosts should then persist the returned state and call `runProcessorAfterAppend({ processor, ...result, streamApi, signal })`.
- Historic replay should only call `runProcessorReduce`; it should not call `runProcessorAfterAppend` unless a future processor explicitly opts into replay side effects.
- `contract.consumes` should currently be expressed as wire event type strings resolved against owned `events` plus `processorDeps`.
- A processor that consumes all events still needs a deliberate design; do not add an `"all"` string or option branch casually.
- `stream.append` inside an implementation should accept only events declared in `contract.emits`.
- `contract.emits` should currently be expressed as wire event type strings resolved against owned `events` plus `processorDeps`.
- Append input types are derived from the event definitions resolved by `contract.emits`.
- Raw `schematch` should remain usable; not every processor will use `schematch`.
- `apps/events/src/durable-objects/stream.ts` should be a processor host using the same host/runtime primitives as future Agent/Codemode processor Durable Objects.
- The reusable host responsibility should include loading/initializing reduced state, persisting reduced state, running reducers, exposing scoped `streamApi`, calling startup once reduced state is available, calling post-commit hooks, and handling hook errors/lifetime management.
- Use a simple `waitUntil(promise)` host hook for now. Do not add task tracking / keepalive abstractions until a concrete processor host needs them.
- Durable Object hosts should contribute deployment-specific pieces: storage adapter, transaction boundary, `waitUntil`, bindings, alarms, sockets, and request routing.
- Processor contracts and implementations should not know whether they are hosted by `stream.ts`, an Agent Durable Object, a Codemode Durable Object, a pull runtime, or a future system-managed facet host.
- The existing pull/push runtime in `apps/events-contract/src/sdk.ts` is prior art and should be reconciled with the new shared processor contract model rather than left as an unrelated abstraction.
- For the current exploration, do not change `events-contract`; continue proving the processor abstraction independently before reconciling envelopes and SDKs.
- The first extraction from `stream.ts` should prove the shared host shape by moving reducer/hook orchestration into a small host helper reusable by future agent/codemode Durable Objects.

## Design Implications

- AgentLoop and Codemode should communicate through events, not direct calls or shared mutable state.
- AgentLoop and Codemode must be modeled as clearly separate processor contracts, implementations, and reduced state slices.
- Do not preserve the current `IterateAgent` / composed `IterateAgentProcessorState` design as the target architecture; it can be replaced.
- The future agent processor Durable Object should not subclass Cloudflare's `Agent`.
- MCP connections should move into a separate Durable Object, e.g. `MCPConnection`, that can act as a Codemode tool provider.
- Same-host composition may be an optimization, but must not be required for correctness unless the processor is explicitly built-in-only.
- If Codemode emits an event that AgentLoop consumes, correctness should come from the later committed event offset, not from Codemode running first in an in-process loop.
- Composition APIs should avoid implying deterministic same-turn ordering for ordinary processors.
- Public schemas/reducers should be ordinary TypeScript imports, not runtime dependency injection.
- Frontend code should be able to import processor contract modules without importing backend-only runtime implementations.
- Frontend projection should use the same pure reducer path as replay hosts to compute UI state from committed stream events.
- Contract modules intended for frontend import must not import Durable Objects, `WorkerEntrypoint`, `Ai`, `Fetcher`, dynamic worker loaders, MCP clients, or other backend-only runtime objects.
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
- Public processor modules should still expose ergonomic namespace-like access such as `AgentProcessorContract.events.InputAddedEvent` and `AgentProcessorContract.reduce?.({ state, event })`.
- A downstream processor such as Codemode should be able to import `AgentProcessorContract` and use both its event schemas and reducer directly when it wants an independent projection.
- `contract.events` means event definitions owned by that processor contract.
- `contract.consumes` and `contract.emits` may reference event definitions owned by other processor contracts.
- Each event definition should have one canonical owning contract.
- A processor must not depend on two event catalogs/contracts that own the same wire event type. Duplicate event type ownership in the dependency set should fail contract definition.
- Use string-keyed `consumes` / `emits` as the current direction because it supports inline event definitions in a single contract object.
- The framework must resolve `consumes` / `emits` strings against owned events plus declared processor dependency event catalogs.
- Name the schema/event dependency field `processorDeps`, not `dependencies` or `eventCatalogs`.
- `processorDeps` should be an array/set of processor contracts or event catalogs, not an alias object.
- The framework must provide strong type tests and runtime validation for string-keyed event resolution because schema identity is recovered from event type strings.
- Event catalogs should be keyed by wire event type strings.
- Inline event definitions plus explicit event-definition `consumes` / `emits` can only avoid self-reference by using a second phase or callbacks such as `consumes: ({ events, external }) => [...]`.
- If the contract must remain a single inline object with `events: { ...createEvent(...) }` and plain `consumes` / `emits`, the string-keyed approach is the viable shape.
- Prototype typecheck demos in `/tmp/processor-contract-demo-a`, `/tmp/processor-contract-demo-b`, `/tmp/processor-contract-demo-c`, and `/tmp/processor-contract-demo-main` showed both callback-hybrid and string-keyed designs can typecheck with inferred consumed event unions and emitted append input unions.
- The callback-hybrid pushes ceremony to processor authors. The string-keyed design keeps the authoring shape simpler but requires stronger framework-side type/runtime validation for event lookup and duplicate ownership.
- Semantic local event aliases such as `events.inputAdded` are under scrutiny because they introduce a second naming system distinct from the stable wire event type.
- Processor registration events should not include event owner metadata in the first design.
- Processor registration should include event docs / JSON Schema only for events owned by the registering contract.
- Consumed/emitted external events should appear as event type strings only in processor registration.
- Processor registration should be idempotent by processor slug and version within a stream.
- A new processor version should produce a new registration event.
- Processor registration/self-description should be appended by the processor itself, not only by the host.
- Processors should track in their own reduced state whether their current-version registration/docs event has been appended.
- Each processor state should include a standard registration state field for this in the first design.
- Processor implementations need access to their contract slug and version.
- Registration/self-description will be a recurring pattern and likely needs a small reusable helper.
- Processor registration/self-description should be a core stream event owned by the events system, not an agents-only event.
- Standard processor registration behavior currently lives in a temporary `wellBehavedProcessorDefaults` bag with `stateShape`, `initialState`, `processorDeps`, `consumes`, `emits`, `reduce`, and `afterAppend` pieces.
- `wellBehavedProcessorDefaults` is also the current home for base reduced state that every ordinary processor wants. Today that base state is `hasRegisteredCurrentVersion`; add future universal processor state here before inventing a new base-state abstraction.
- `wellBehavedProcessorDefaults` is deliberately not the final composition abstraction. It records recurring behavior while we learn whether these pieces should become a small processor in their own right.
- The core processor registration event type is `events.iterate.com/core/stream-processor-registered`.
- Processor event type strings should not include `https://`.
- Processor event type strings should not include the processor version for now.
- Processor-owned event types should use `events.iterate.com/{processor-slug}/{short-event-type}`.
- Do not add extra slash subfolders under ordinary processor namespaces for now; prefer `events.iterate.com/agent/input-added`, not `events.iterate.com/agent/input/added`.
- Processors should explicitly include `events.iterate.com/core/stream-processor-registered` in `consumes` if their reducer handles registration state.
- Processors that append their own registration/self-description event should explicitly include `events.iterate.com/core/stream-processor-registered` in `emits`, so typed `stream.append` allows it.
- Shared constants/helpers may make this boilerplate small, but the final contract should remain explicit.
- `consumes` and `emits` arrays should show visible string literals in processor contracts, not hidden helper constants.
- Zod schemas and event identifiers should start with a capital letter.
- Zod schemas and their inferred types should share the same identifier.
- Zod schema identifiers should not end in `Schema`.
- Zod docs support the existing repo convention: define a schema value, infer its type with `z.infer<typeof Value>`, and use `z.input` / `z.output` when input and parsed output diverge.
- Zod 4 metadata registries and `.meta()` may be useful for processor/event documentation.
- Zod 4 `z.toJSONSchema()` can generate event docs, but `z.custom()` and similar unrepresentable types need care.
- Event definitions should be authored inline as string-keyed objects, e.g. `"events.iterate.com/agent/input-added": { description, payloadSchema }`.
- Event definitions should be authored with normal Zod objects and `.meta(...)` for docs where possible.
- Event descriptors do not need a `.Payload` property.
- Do not require a `createEvent(...)` spread helper in authored processor contracts.
- Event input helper naming remains open now that event definitions are plain inline objects.

## Discuss Later

- Whether `append` is the right name, or whether APIs should use names like `onEvent` / `emit` / `write`.
- Testability: unit-test reducers, test processor runtime hooks, and run multiple processors together in harnesses to observe cross-processor event interactions before deployment.
- Composition: clarify the difference, if any, between small reusable processor logic/slices and composing multiple processors into one host runtime.
- Composition: decide whether same-host composition is only host configuration, or whether a composed processor can itself have a contract.
- Stream Durable Object refactor: explore which logic can move out of `apps/events/src/durable-objects/stream.ts` into processor contracts, processor runtime helpers, Durable Object mixins, dedicated processor Durable Objects, or Durable Object facets.
- Stream Durable Object refactor: distinguish ordinary in-process composition from Cloudflare Dynamic Workers Durable Object Facets.
- Future deployment topology: support advanced processors that handle many streams in one Durable Object, or singleton Durable Object processors subscribed to singleton/pattern streams such as `/slack/webhooks`.
- Future question: whether many-stream Durable Object processors should use Durable Object facets, a parent Durable Object with per-stream child routing, or a simpler internal map.
- Future question: whether reusable state slices/mixins are actually just small processors or composition units.
- Future deployment topology: support processors run by the system itself, dynamically created and updated on the fly, potentially using Durable Object facets in the events service or another system host.
- What the processor identity object should be called: slug, id, key, name, or something else.
- Event schemas should be nested under `contract.events`; do not duplicate them both flat and nested.
- Class-based runtime instances are deferred. Use plain object/factory processors first unless a concrete implementation proves classes are worth the type ceremony.
- How much of this should be shared with `apps/events/src/durable-objects/stream.ts` immediately versus later.
- How dependencies should be modeled concretely for AgentLoop's AI binding and Codemode's WorkerLoader/outbound fetch/callable dispatch.
- Whether the scoped stream service should be injected once into the processor factory/constructor as a standard dependency, or passed explicitly to `onStart` / `afterAppend` hook calls.
- Prefer naming the scoped stream service `streamApi` or `streamClient` over just `stream`.
- Whether append APIs inside hooks should append immediately or buffer append commands for the host to commit after state/checkpoint persistence.
- Whether a future class-backed implementation should use `this.state`, receive `{ state, previousState }`, or both.
- Whether `onStart` should receive `{ state, stream, signal }`, and whether it may be retried by hosts after failure.
- What schema matching over `match(event).case(Some.events.foo.event, ...)` should look like in the redesigned API.
- How to support quick throwaway processor contracts with inline event schemas without forcing every event definition to be named above the contract object.
- Whether event catalogs should be keyed by stable wire event type strings such as `events["agent-input-added"]` instead of semantic property names such as `events.InputAddedEvent`.
- `processorDeps` shape is currently favored as an array of processor contracts or event catalogs.
- Dependency reduced-state composition should stay explicit for now. If codemode relies on agent state, codemode should store a serializable snapshot such as `state.processorDeps.agent` and update it by running `reduceAgentEvents(...)` inside its own reducer.
- We may introduce helper syntax for dependency state later, but do not make `stateSchema` a function of deps yet; keep contracts plain and inspectable while this is still being designed.
- Whether processor contract values should be lower camel case, e.g. `agentProcessorContract`, since they are ordinary values rather than classes or Zod schemas.
- Avoid naming schema/event imports `dependencies`, because runtime processor factories also receive dependencies such as AI bindings, loaders, MCP clients, and `streamApi`.
- Add expect-type tests for processor factories/contracts showing event narrowing and append rejection for undeclared emitted events.
- Add comments/docstrings around the generic type machinery so future maintainers can understand consumed-event and emitted-input inference.
- Add docs with concrete AgentProcessor/CodemodeProcessor examples for contract definitions, processor factories, typed reducer events, typed `afterAppend`, and typed `stream.append`.

## Soft-Locked Direction

- Use `AgentProcessorContract` / `AgentProcessor` style naming.
- A processor contract is the public processor surface: identity, version, description, event schemas, optional state schema, optional reducer, `consumes`, and `emits`.
- `defineProcessorContract` should be a typed identity function, not a builder that mutates, duplicates, or restructures the contract.
- A processor implementation is created by a factory such as `createAgentProcessor(deps)`.
- The implementation factory may return a plain object or a class-backed implementation.
- Classes are allowed and likely useful for implementations with live dependencies/state, but the public contract stays importable without constructing a class.
- `implementProcessor(contract, implementation)` should type implementation hooks from the contract:
- the handled event is narrowed from `contract.consumes`
- `stream.append` accepts only events from `contract.emits`
- `stateSchema` is required; `initialState` is optional and is parsed through `stateSchema`
- `reduce` is optional and defaults to identity
- Event definition shape is soft-locked:
  - authored inline as `{ "events.iterate.com/agent/input-added": { description, payloadSchema } }`
  - the event catalog key is the wire event type string
  - the event definition stores `description` and `payloadSchema`
  - append input and committed event schemas can be derived by host/helpers from the catalog key and `payloadSchema`
  - append object literals should be typechecked from `contract.emits`; do not require generated `.createInput(...)`
  - no `.Payload` property
- Startup semantics are soft-locked:
  - the startup hook means reduced state has caught up and the processor may hydrate runtime-only resources from it
  - the startup hook is called before the first live `afterAppend`
  - pull-based hosts call startup after historic replay and before live subscription processing
  - push-based hosts call startup lazily when consuming the first live event, after reduced-state catch-up
  - the startup hook must not mean Durable Object construction, socket connection, or process boot
