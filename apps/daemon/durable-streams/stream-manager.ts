/**
 * StreamManager - Layer 4
 *
 * Manages multiple named EventStreams with lazy initialization.
 * Each stream is created on first access and cached.
 * Uses EventStreamFactory for stream creation (enables hook composition).
 */
import type { Scope } from "effect"
import { Duration, Effect, Fiber, HashMap, HashSet, Layer, PubSub, Ref, Stream } from "effect"
import { Storage } from "./storage.ts"
import { EventStreamFactory, PlainFactory } from "./stream-factory.ts"
import type { EventStream } from "./stream.ts"
import {
  type Event,
  type InvalidOffsetError,
  makeOffset,
  type Offset,
  OFFSET_START,
  StorageError,
  type StreamName
} from "./types.ts"

/** StreamManager service interface */
export interface StreamManager {
  /** Get or create a stream by name */
  getStream(opts: { name: StreamName }): Effect.Effect<EventStream, StorageError>

  /** Append to a stream (creates if not exists) */
  append(opts: { name: StreamName; data: unknown }): Effect.Effect<Event, StorageError>

  /** Subscribe to a stream (creates if not exists) */
  subscribe(opts: {
    name: StreamName
    offset?: Offset | undefined
  }): Effect.Effect<Stream.Stream<Event>, InvalidOffsetError | StorageError, Scope.Scope>

  /** Get events from a stream (one-shot, no live subscription) */
  getFrom(opts: {
    name: StreamName
    offset?: Offset | undefined
    limit?: number
  }): Effect.Effect<ReadonlyArray<Event>, InvalidOffsetError | StorageError>

  /** List all stream names */
  list(): Effect.Effect<ReadonlyArray<StreamName>, StorageError>

  /** Delete a stream */
  delete(opts: { name: StreamName }): Effect.Effect<void, StorageError>

  /** Subscribe to ALL streams (live events only, no history).
   * Dynamically discovers new streams created after subscription starts. */
  subscribeAll(): Effect.Effect<Stream.Stream<Event, StorageError>, StorageError, Scope.Scope>
}

/** Helper to create StreamManager implementation given factory and storage */
const makeStreamManager = Effect.gen(function*() {
  const factory = yield* EventStreamFactory
  const storage = yield* Storage

  // Cache of initialized streams
  const streamsRef = yield* Ref.make(HashMap.empty<StreamName, EventStream>())

  const getStream = (opts: { name: StreamName }): Effect.Effect<EventStream, StorageError> =>
    Effect.gen(function*() {
      const streams = yield* Ref.get(streamsRef)
      const existing = HashMap.get(streams, opts.name)

      if (existing._tag === "Some") {
        return existing.value
      }

      // Create new stream via factory
      const stream = yield* factory.make(opts)
      yield* Ref.update(streamsRef, HashMap.set(opts.name, stream))
      return stream
    })

  const append = (opts: { name: StreamName; data: unknown }): Effect.Effect<Event, StorageError> =>
    Effect.gen(function*() {
      const stream = yield* getStream({ name: opts.name })
      return yield* stream.append({ data: opts.data })
    })

  const subscribe = (opts: {
    name: StreamName
    offset?: Offset | undefined
  }): Effect.Effect<Stream.Stream<Event>, InvalidOffsetError | StorageError, Scope.Scope> =>
    Effect.gen(function*() {
      const stream = yield* getStream({ name: opts.name })
      return yield* stream.subscribe(opts.offset !== undefined ? { offset: opts.offset } : {})
    })

  const getFrom = (opts: {
    name: StreamName
    offset?: Offset | undefined
    limit?: number
  }): Effect.Effect<ReadonlyArray<Event>, InvalidOffsetError | StorageError> =>
    Effect.gen(function*() {
      const stream = yield* getStream({ name: opts.name })
      const offset = opts.offset ?? OFFSET_START
      return yield* stream.getFrom(
        opts.limit !== undefined ? { offset, limit: opts.limit } : { offset }
      )
    })

  const list = (): Effect.Effect<ReadonlyArray<StreamName>, StorageError> => storage.list()

  const deleteStream = (opts: { name: StreamName }): Effect.Effect<void, StorageError> =>
    Effect.gen(function*() {
      yield* storage.delete(opts)
      yield* Ref.update(streamsRef, HashMap.remove(opts.name))
    })

  /** Interval between stream discovery polls */
  const DISCOVERY_INTERVAL = Duration.seconds(1)

  const subscribeAll = (): Effect.Effect<Stream.Stream<Event, StorageError>, StorageError, Scope.Scope> =>
    Effect.gen(function*() {
      // Global PubSub for merged events from all streams
      const mergedPubSub = yield* PubSub.unbounded<Event>()

      // Track which streams we've already subscribed to
      const subscribedStreamsRef = yield* Ref.make(HashSet.empty<StreamName>())

      // Subscribe to a single stream, forwarding live events to merged PubSub
      // For existingStream=true: start from end (skip history)
      // For existingStream=false: start from beginning (newly discovered, catch all events)
      const subscribeToStream = (
        name: StreamName,
        existingStream: boolean
      ): Effect.Effect<void, StorageError, Scope.Scope> =>
        Effect.gen(function*() {
          const alreadySubscribed = yield* Ref.get(subscribedStreamsRef).pipe(
            Effect.map(HashSet.has(name))
          )
          if (alreadySubscribed) return

          yield* Ref.update(subscribedStreamsRef, HashSet.add(name))

          const stream = yield* getStream({ name })

          // For existing streams: start from end (no history replay)
          // For newly discovered streams: start from beginning (they're all "live" to us)
          const startOffset = existingStream
            ? makeOffset(yield* stream.count)
            : OFFSET_START

          const eventStream = yield* stream.subscribe({ offset: startOffset }).pipe(
            Effect.catchTag("InvalidOffsetError", () => Effect.fail(new StorageError({ message: "Invalid offset" })))
          )

          // Fork a fiber to forward events to merged PubSub
          yield* eventStream.pipe(
            Stream.runForEach((event) => PubSub.publish(mergedPubSub, event)),
            Effect.fork
          )

          // Yield to allow forked fiber to start consuming from stream's PubSub
          yield* Effect.yieldNow()
        })

      // Subscribe to all existing streams (existing=true to skip their history)
      const existingNames = yield* list()
      yield* Effect.forEach(existingNames, (name) => subscribeToStream(name, true), { discard: true })

      // Background fiber that polls for new streams
      const discoveryFiber = yield* Effect.gen(function*() {
        while (true) {
          yield* Effect.sleep(DISCOVERY_INTERVAL)
          const currentNames = yield* list()
          const subscribed = yield* Ref.get(subscribedStreamsRef)

          for (const name of currentNames) {
            if (!HashSet.has(subscribed, name)) {
              // New stream discovered after subscribeAll started - read from beginning
              yield* subscribeToStream(name, false)
            }
          }
        }
      }).pipe(
        Effect.catchAll(() => Effect.void), // Ignore errors in discovery loop
        Effect.fork
      )

      // Register finalizer to interrupt discovery fiber when scope closes
      yield* Effect.addFinalizer(() => Fiber.interrupt(discoveryFiber))

      // Return stream from merged PubSub
      const dequeue = yield* PubSub.subscribe(mergedPubSub)
      return Stream.fromQueue(dequeue)
    })

  return {
    getStream,
    append,
    subscribe,
    getFrom,
    list,
    delete: deleteStream,
    subscribeAll
  } satisfies StreamManager
})

/** StreamManager service tag and layer */
export class StreamManagerService extends Effect.Service<StreamManagerService>()(
  "@event-stream/StreamManager",
  {
    effect: makeStreamManager,
    dependencies: [Storage.Default, EventStreamFactory.Default]
  }
) {
  /** Create a StreamManagerService layer - requires Storage and EventStreamFactory */
  static readonly Live: Layer.Layer<StreamManagerService, never, Storage | EventStreamFactory> = Layer.effect(
    StreamManagerService,
    makeStreamManager as Effect.Effect<StreamManagerService>
  )

  /** In-memory layer with plain factory (for tests) */
  static readonly InMemory: Layer.Layer<StreamManagerService> = StreamManagerService.Live.pipe(
    Layer.provide(PlainFactory),
    Layer.provide(Storage.InMemory)
  )
}
