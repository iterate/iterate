# Prior Art Notes

This is a broad scan, not a decision to adopt any one library. The useful
question is what blind spots these systems reveal for our processor contract.

## Redux

Redux is the cleanest frontend analogy for the contract side:

- actions are plain event objects with a readable `type`;
- reducers are pure functions from current state plus event/action to next
  state;
- state should be plain serializable data;
- async work and side effects do not belong in reducers.

Relevant docs:

- https://redux.js.org/tutorials/fundamentals/part-3-state-actions-reducers

Design lesson:

- Our contract reducer being frontend-importable is the right shape.
- The frontend should be able to replay stream events into reduced state without
  importing backend processor implementations.

Blind spot:

- Redux also makes reducer purity culturally obvious. Our docs need to be just
  as blunt: reducers must not call APIs, schedule timers, mutate state, or
  append events.

## ReactiveX / RxJS `scan`

ReactiveX describes `scan` as an accumulator over an observable sequence that
feeds each intermediate result back into the next call.

Relevant docs:

- https://reactivex.io/documentation/id/operators/scan.html

Design lesson:

- Historic replay and frontend projection are basically `scan` over committed
  stream events.
- The initial state question matters. Rx-style APIs distinguish seeded and
  unseeded scans; our equivalent is explicit optional `initialState`, falling
  back to parsing `undefined` only when it is omitted.

Blind spot:

- RxJS has lots of composition operators, but that power comes with a learning
  curve. We should avoid making processor authors learn an operator algebra just
  to write `reduce` plus `afterAppend`.

## Kafka Streams Processor API

Kafka Streams separates processor code from the runtime context. A processor
gets an injected context for forwarding records, scheduling periodic work, and
committing progress. Stateful processors use state stores owned by the runtime.

Relevant docs:

- https://docs.confluent.io/platform/current/streams/developer-guide/processor-api.html
- https://kafka.apache.org/11/streams/developer-guide/processor-api/

Design lessons:

- `ProcessorContext` maps loosely to our scoped `streamApi` plus host services.
- Processor instance factories matter. Kafka explicitly warns that processor
  suppliers must return fresh instances rather than singletons.
- State stores are associated with processors by the host/topology, not
  randomly reached through globals.
- Scheduling/timers are real processor needs, but they should be modeled as
  host/runtime capabilities, not hidden global timers.

Blind spots:

- We do not yet have an explicit story for progress commits relative to
  side effects. Kafka's model makes commit/progress a first-class runtime
  concern.
- We have not designed punctuation/timers beyond "use `waitUntil`", but AgentLoop
  debounce and delayed LLM requests will need a durable scheduling answer.

## XState Actors

XState actors receive input at creation time, can invoke/spawn child actors, and
can persist snapshots. XState's `fromTransition` is very close to a reducer
actor.

Relevant docs:

- https://stately.ai/docs/input
- https://stately.ai/docs/invoke
- https://stately.ai/docs/actors

Design lessons:

- Runtime input/dependencies at actor creation map to our implementation
  factory dependencies.
- `input` is not automatically updated after actor creation. That mirrors our
  concern that stream path/deps binding needs to be clear at instance creation.
- Child actor lifecycle is explicit. If we later reintroduce a class or actor
  style for MCP connections, lifecycle/cleanup has to be part of the model.

Blind spot:

- XState has explicit stop/invoke lifecycle semantics. We intentionally deferred
  `stop`, but runtime resources such as MCP connections will eventually need
  abort/cleanup semantics even if we avoid a public `stop` hook for now.

## Beam / Akka / Lagom / EventStoreDB Themes

The prior-art agent looked more broadly at these systems and found common
themes:

- replay/recovery handlers must stay pure;
- runtime hooks after recovery are a known concept;
- processors and their host/runtime are distinct;
- offset/progress tracking is not optional;
- registration/projection metadata as events or streams is a defensible shape.

Design lessons:

- `onStart` should mean "the reduced state is ready", not "constructor ran".
- Processor registration as a normal stream event is reasonable.
- Host-owned `{ state, offset }` is not invented ceremony; it is the minimum
  viable progress model for replayable processors.

Blind spots:

- Poison event handling, retries, dead-letter streams, and backoff policy are
  still missing.
- Schema evolution/upcasting is still missing.
- Access policy for absolute-path appends is future work, but the API shape
  should leave room for it.

## Net Takeaway

The design direction still looks defensible:

- contract: identity, version, descriptions, event schemas, state schema,
  reducer;
- implementation: side-effect hooks and runtime dependencies;
- host: persistence, offset/progress, stream subscription, `streamApi`, lifecycle;
- frontend: import contract/reducer only and project state from committed events.

The big missing piece is not "class vs function". It is the host consistency
model: exactly what is persisted, when `afterAppend` is retried, and how the host
avoids missing events while switching from replay to live subscription.
