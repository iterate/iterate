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
- `ingest({ events, streamMaxOffset })` is the host-facing sink — deliberately named outside the
  `process*` hook family. It is not overridable (enforced by lint): the serialization guarantee
  lives there and must stay on the base class.
- The base serializes batches in memory. A later batch never starts until the previous batch has
  either completed or failed.
- The `process*` family is the authoring surface. Subclasses extend up to three hooks, all of
  which run inside the serialized section:
  - `reduce(...)` — pure projection of one consumed event into the next state;
  - `processEvent(...)` — synchronous per-event side effects; what most processors implement;
  - `processEventBatch(...)` — async batch-level side effects (e.g. one SQLite transaction over
    the already-deduped new events). The default implementation calls `processEvent(...)` once
    per reduced event; overrides call `super.processEventBatch(args)` to keep that behavior.
- A fourth, optional `prepare()` hook runs once before the checkpoint is first read (via either
  `snapshot()` or the first batch). Use it for setup that can invalidate the stored checkpoint —
  e.g. schema migrations that reset projection tables — so it always lands before the resume
  cursor is decided.
- The checkpoint (reduced state + offset) is written only after `processEventBatch` and all
  `blockProcessorWhile` work succeed.
- Hooks receive plain state/event types and must treat them as immutable; there is no
  `DeepReadonly` wrapper because it forced a cast in every real subclass.
- Subclass overrides annotate their args as
  `Parameters<StreamProcessor<Contract>["method"]>[0]` — the single sanctioned spelling,
  enforced by the `iterate/stream-processor-override-args` lint rule. The arg shapes are
  deliberately not exported as named types.

## Consumes Semantics

`contract.consumes` is both a type-level and (eventually) delivery-level filter. The planned
subscription filtering will use it to only deliver named event types, with `"*"` as the explicit
opt-in for everything:

- named only — the hook event type is the exact union of those events; exhaustive switches can
  end in `assertNever(event)`;
- `["*"]` only — plain `StreamEvent` (real `type` string, `unknown` payload), for generic
  projectors;
- `["*", ...named]` — the named union plus `WildcardConsumedEvent`, whose `type` is the literal
  `"*"`. Named events keep exact payload inference; the wildcard branch is reachable (never-free)
  with an `unknown` payload. To string-match a specific event type, name it in `consumes` instead
  of comparing inside the wildcard branch.

`emits` must always be named — `"*"` is rejected at the definition site.

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

For that reason `CoreStreamProcessor` itself (not the base class) exposes explicit inline methods
used by the `Stream` Durable Object, built on the protected `reduceRawEvent` helper:

- `validateAppend({ event, state })`
- `reduceEvent({ event, state })`
- `processReducedEvent({ event, previousState, state })`

The base class stays a pure batch/checkpoint model; the inline surface is a core-processor
specialty. Open question: should the inline core eventually have a sibling base class, or is this
explicit inline surface enough?

## Open Decisions

- How does an embedded processor in an OS Durable Object subscribe to a stream?
- Does `Stream` remain generic and let OS subclass/override subscription target resolution?
- What is the smallest typed `iterateContext` surface processors should receive?
- Should the API distinguish stateful, stateless, and inline/built-in processors at the type level?
- What lint rule forbids dangling promises and side effects in `reduce(...)`?
