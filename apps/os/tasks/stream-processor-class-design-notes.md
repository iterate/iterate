# Stream Processor Class Design Notes

This branch moves the first processor hosts toward a class-based `StreamProcessor`
API in `packages/streams`. It is intentionally a narrow migration slice: prove the
base class against browser-hosted processors and keep the OS Durable Object routing
questions as design work, not half-wired runtime behavior.

## Current Shape

- `StreamProcessor<Contract, Deps>` lives in `@iterate-com/streams/stream-processor`.
- A processor is parameterized by its contract object/type and its processor-specific deps:
  `class RepoProcessor extends StreamProcessor<RepoProcessorContract, RepoProcessorDeps>`.
- Contract values and their matching type aliases are capitalized and share the same name:
  `RepoProcessorContract`, not `repoProcessorContract`.
- Contracts describe event schemas, state schemas, and metadata. Reducers live on processor
  classes, not contracts.
- The base constructor owns common deps:
  - `iterateContext`, exposed to subclasses as `this.ctx`
  - optional `keepAliveWhile`
  - optional `readState` and `writeState`
- If no state storage is passed, the base uses an in-memory snapshot. That keeps tests and
  stateless experiments cheap.
- `processEventBatch({ events, streamMaxOffset })` is the public sink.
- The base serializes batches in memory. A later batch never starts until the previous batch has
  either completed or failed.
- The base reduces every new event in the batch first, then calls `processEvent(...)` once per
  reduced event.
- `processEvent(...)` is synchronous. Async side effects must be registered through one of the
  provided helpers.
- Subclass overrides annotate their args as
  `Parameters<StreamProcessor<Contract>["method"]>[0]` — the single sanctioned spelling,
  enforced by the `iterate/stream-processor-override-args` lint rule. The arg shapes are
  deliberately not exported as named types.

## Async Side Effects

Processors should not create dangling promises. The point of a synchronous authoring hook is to
force an explicit processing decision for every async side effect.

- `blockProcessorWhile(async () => ...)`
  - waits before advancing the checkpoint
  - prevents the next batch from starting
  - should be used when the side effect is part of the durable processing result
- `runInBackground(async () => ...)`
  - lets the checkpoint advance after synchronous reduction/projection work
  - catches and logs failures
  - should be used for best-effort or replay-safe side effects

The best default is not to block if the side effect can be made idempotent. When appending follow-up
events, derive an idempotency key from the triggering event. The same applies to third-party APIs
such as Stripe.

## Checkpoints

A checkpoint is the persisted pair of:

- reduced processor state
- highest stream offset successfully reduced and processed by that processor

The base class does not write the checkpoint until all registered blocking work for that batch has
resolved. Background work does not hold the checkpoint.

## Browser Slice

The browser-hosted processors now use the class API:

- `BrowserRawEventsProcessor`
  - owns the `events` table
  - batch-writes raw events in one SQLite transaction
- `BrowserEventFeedProcessor`
  - owns the `feed_items` table
  - batch-writes grouped feed operations in one SQLite transaction

Browser processor state is stored in a shared `processor_state` table:

- `processor_slug`
- `subscription_key`
- `reduced_state`
- `max_offset`

This keeps the processor checkpoint separate from processor-owned projection tables while still
letting each browser view clear its local mirror consistently.

## Core Processor

`CoreStreamProcessor` now replaces the old object-literal built-in processor implementation in
`packages/streams/src/processors/core/implementation.ts`.

The stream core is not an ordinary subscription processor:

- it can reject events before append through `validateAppend`
- it owns stream runtime state
- it triggers stream-internal side effects such as child-stream propagation

For that reason the class exposes explicit inline methods used by the `Stream` Durable Object:

- `validateAppend({ event, state })`
- `reduceEvent({ event, state })`
- `processReducedEvent({ event, previousState, state })`

Open question: should the inline core eventually have a sibling base class, or is this explicit
inline surface enough?

## Open Decisions

- How does an embedded processor in an OS Durable Object subscribe to a stream?
- Does `Stream` remain generic and let OS subclass/override subscription target resolution?
- What is the smallest typed `iterateContext` surface processors should receive?
- Should the API distinguish stateful, stateless, and inline/built-in processors at the type level?
- What lint rule forbids dangling promises and side effects in `reduce(...)`?
