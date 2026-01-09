/**
 * EventStream - Layer 0 core primitive
 *
 * A single named stream with append and subscribe operations.
 * Uses PubSub for live subscriptions with historical catch-up.
 */
import type { Scope } from "effect"
import { Effect, PubSub, Ref, Stream } from "effect"
import { Storage } from "./storage.ts"
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  Event,
  type EventStreamId,
  InvalidOffsetError,
  isStartOffset,
  makeOffset,
  type Offset,
  OFFSET_START,
  parseOffset,
  StorageError,
  type StreamName
} from "./types.ts"

/** EventStream interface - all methods use object params */
export interface EventStream {
  readonly name: StreamName

  /** Append data to stream, returns event with assigned offset */
  append(opts: { data: unknown }): Effect.Effect<Event, StorageError>

  /** Subscribe to events. Returns historical + live. Use offset to start from position.
   * Requires Scope - subscription stays active while scope is open. */
  subscribe(opts?: { offset?: Offset }): Effect.Effect<
    Stream.Stream<Event>,
    InvalidOffsetError | StorageError,
    Scope.Scope
  >

  /** Get events from offset (for historic reads without live subscription) */
  getFrom(opts: { offset: Offset; limit?: number }): Effect.Effect<
    ReadonlyArray<Event>,
    InvalidOffsetError | StorageError
  >

  /** Current event count */
  readonly count: Effect.Effect<number, StorageError>
}

/** Create an EventStream instance for a given name */
export const makeEventStream = (opts: {
  name: StreamName
}): Effect.Effect<EventStream, StorageError, Storage> =>
  Effect.gen(function*() {
    const storage = yield* Storage
    const { name } = opts

    // Ensure stream exists in storage
    yield* storage.create({ name })

    // PubSub for live event fan-out
    const pubsub = yield* PubSub.unbounded<Event>()

    // Sync offset counter with storage
    const events = yield* storage.getAll({ name })
    const nextOffsetRef = yield* Ref.make(events.length)

    const append = (appendOpts: { data: unknown }): Effect.Effect<Event, StorageError> =>
      Effect.gen(function*() {
        const counter = yield* Ref.getAndUpdate(nextOffsetRef, (n) => n + 1)
        const offset = makeOffset(counter)
        const createdAt = new Date().toISOString()

        const event = new Event({
          offset,
          eventStreamId: name as unknown as EventStreamId,
          data: appendOpts.data,
          createdAt
        })

        // Store the event
        yield* storage.append({ name, events: [{ data: appendOpts.data }] })

        // Broadcast to live subscribers
        yield* PubSub.publish(pubsub, event)

        return event
      })

    const subscribe = (
      subscribeOpts?: { offset?: Offset }
    ): Effect.Effect<Stream.Stream<Event>, InvalidOffsetError | StorageError, Scope.Scope> =>
      Effect.gen(function*() {
        const offset = subscribeOpts?.offset ?? OFFSET_START

        // Validate offset format (unless it's the start sentinel)
        if (!isStartOffset(offset)) {
          const parsed = parseOffset(offset)
          if (isNaN(parsed) || parsed < 0) {
            return yield* Effect.fail(
              new InvalidOffsetError({
                offset,
                message: "Offset must be a non-negative integer string or -1"
              })
            )
          }
        }

        // Subscribe to PubSub FIRST (before fetching historical)
        // PubSub.subscribe guarantees subscription is established when this completes
        // Scope keeps subscription alive - caller must provide scope
        const dequeue = yield* PubSub.subscribe(pubsub)

        // Get historical events (subscription already established, no gap)
        const historical = yield* storage.getFrom({ name, offset })

        // Track last historical offset to avoid duplicates in live
        const lastHistoricalOffset = historical.length > 0
          ? historical[historical.length - 1]!.offset
          : null

        // Create historical stream
        const historicalStream = Stream.fromIterable(historical)

        // Create live stream from PubSub, filtering out duplicates
        const liveStream = Stream.fromQueue(dequeue).pipe(
          Stream.filter((e) =>
            lastHistoricalOffset === null
              ? (isStartOffset(offset) || e.offset >= offset)
              : e.offset > lastHistoricalOffset
          )
        )

        // Concat: historical first, then live
        return Stream.concat(historicalStream, liveStream)
      })

    const getFrom = (
      getFromOpts: { offset: Offset; limit?: number }
    ): Effect.Effect<ReadonlyArray<Event>, InvalidOffsetError | StorageError> =>
      Effect.gen(function*() {
        const { limit, offset } = getFromOpts

        // Validate offset format (unless it's the start sentinel)
        if (!isStartOffset(offset)) {
          const parsed = parseOffset(offset)
          if (isNaN(parsed) || parsed < 0) {
            return yield* Effect.fail(
              new InvalidOffsetError({
                offset,
                message: "Offset must be a non-negative integer string or -1"
              })
            )
          }
        }

        return yield* storage.getFrom(limit !== undefined ? { name, offset, limit } : { name, offset })
      })

    const count: Effect.Effect<number, StorageError> = Effect.gen(function*() {
      const events = yield* storage.getAll({ name })
      return events.length
    })

    return {
      name,
      append,
      subscribe,
      getFrom,
      count
    }
  })
