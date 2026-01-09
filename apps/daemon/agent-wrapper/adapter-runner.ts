/**
 * Adapter Runner
 *
 * Orchestrates the lifecycle of agent harness adapters.
 * - Ensures stream server is running
 * - Creates streams for new agent sessions
 * - Starts and manages adapters
 */
import { Console, Deferred, Effect, Fiber, Ref } from "effect"
import { v4 as uuidv4 } from "uuid"
import type { ClientError } from "../durable-streams/client.ts"
import { StreamClientService } from "../durable-streams/client.ts"
import type { StreamName } from "../durable-streams/types.ts"
import { runPiAdapter } from "./pi-adapter.ts"
import { type EventStreamId, makeSessionCreateEvent } from "./types.ts"

/**
 * Info about a running adapter
 */
interface AdapterInfo {
  streamName: StreamName
  eventStreamId: EventStreamId
  harness: "pi" | "claude" | "opencode" | "iterate"
  fiber: Fiber.RuntimeFiber<void, ClientError>
  createdAt: Date
}

/**
 * AdapterRunner service
 *
 * Manages the lifecycle of agent adapters connected to durable streams.
 */
export class AdapterRunnerService extends Effect.Service<AdapterRunnerService>()(
  "@agent-wrapper/AdapterRunner",
  {
    effect: Effect.gen(function*() {
      const client = yield* StreamClientService
      const adaptersRef = yield* Ref.make<Map<string, AdapterInfo>>(new Map())

      /**
       * Start a new Pi agent session.
       *
       * Creates a new stream, starts the Pi adapter, and sends the session-create action.
       * Returns the stream name that clients can subscribe to.
       * Session files are stored in Pi's default location (~/.pi/agent/sessions/).
       *
       * @param options.sessionFile - Specific session file to resume
       */
      const startPiSession = (
        options?: { cwd?: string; model?: string; thinkingLevel?: string; sessionFile?: string }
      ): Effect.Effect<{ streamName: StreamName; eventStreamId: EventStreamId }, ClientError> =>
        Effect.gen(function*() {
          // Generate unique stream name
          const sessionId = uuidv4().slice(0, 8)
          const streamName = `pi-${sessionId}` as StreamName
          const eventStreamId = streamName as unknown as EventStreamId

          yield* Console.log(`[AdapterRunner] Starting Pi session: ${streamName}`)

          // Create a deferred to wait for adapter to be ready
          const adapterReady = yield* Deferred.make<void, never>()

          // Start the adapter (runs in background)
          const fiber = yield* Effect.fork(
            runPiAdapter(streamName, eventStreamId, adapterReady).pipe(
              Effect.provideService(StreamClientService, client)
            )
          )

          // Track the adapter
          yield* Ref.update(adaptersRef, (adapters) => {
            const newAdapters = new Map(adapters)
            newAdapters.set(streamName, {
              streamName,
              eventStreamId,
              harness: "pi",
              fiber,
              createdAt: new Date()
            })
            return newAdapters
          })

          // Wait for adapter to signal it's ready (subscription is active)
          yield* Deferred.await(adapterReady)

          const createEvent = makeSessionCreateEvent(
            eventStreamId,
            options
          )

          yield* client.append({
            name: streamName,
            data: createEvent
          })

          yield* Console.log(`[AdapterRunner] Pi session started: ${streamName}`)

          return { streamName, eventStreamId }
        })

      /**
       * Stop an adapter and remove it from tracking.
       */
      const stopAdapter = (streamName: StreamName): Effect.Effect<boolean> =>
        Effect.gen(function*() {
          const adapters = yield* Ref.get(adaptersRef)
          const adapter = adapters.get(streamName)

          if (!adapter) {
            return false
          }

          yield* Console.log(`[AdapterRunner] Stopping adapter: ${streamName}`)

          yield* Fiber.interrupt(adapter.fiber)

          yield* Ref.update(adaptersRef, (current) => {
            const newAdapters = new Map(current)
            newAdapters.delete(streamName)
            return newAdapters
          })

          return true
        })

      /**
       * List all running adapters.
       */
      const listAdapters = (): Effect.Effect<ReadonlyArray<Omit<AdapterInfo, "fiber">>> =>
        Effect.gen(function*() {
          const adapters = yield* Ref.get(adaptersRef)
          return Array.from(adapters.values()).map(({ fiber: _, ...info }) => info)
        })

      /**
       * Stop all adapters.
       */
      const stopAll = (): Effect.Effect<void> =>
        Effect.gen(function*() {
          const adapters = yield* Ref.get(adaptersRef)

          for (const [streamName, adapter] of adapters) {
            yield* Console.log(`[AdapterRunner] Stopping adapter: ${streamName}`)
            yield* Fiber.interrupt(adapter.fiber)
          }

          yield* Ref.set(adaptersRef, new Map())
        })

      return {
        startPiSession,
        stopAdapter,
        listAdapters,
        stopAll
      }
    }),
    dependencies: [StreamClientService.Default]
  }
) {}
