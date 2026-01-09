/**
 * Pi Harness Adapter
 *
 * Connects a Pi coding agent session to a durable event stream.
 * - Subscribes to stream for action events (prompt, abort)
 * - Calls Pi SDK methods in response
 * - Wraps Pi SDK events and appends to stream
 */
import type {
  AgentSession,
  AgentSessionEvent,
  SessionManager as SessionManagerType
} from "@mariozechner/pi-coding-agent"
import { createAgentSession, discoverAuthStorage, discoverModels, SessionManager } from "@mariozechner/pi-coding-agent"
import { Console, Deferred, Effect, Fiber, Queue, Stream } from "effect"
import type { ClientError } from "../durable-streams/client.ts"
import { StreamClientService } from "../durable-streams/client.ts"
import type { StreamName } from "../durable-streams/types.ts"
import { type EventStreamId, makePiEventReceivedEvent, PiEventTypes, type SessionCreatePayload } from "./types.ts"

/**
 * State of the Pi adapter
 */
interface PiAdapterState {
  session: AgentSession | null
  sessionManager: SessionManagerType | null
  eventUnsubscribe: (() => void) | null
}

/**
 * Create and run a Pi adapter for a given stream.
 *
 * The adapter:
 * 1. Subscribes to the stream for action events
 * 2. Creates a Pi session when session-create action is received
 * 3. Forwards prompts to the Pi session
 * 4. Wraps Pi events and appends them to the stream
 *
 * @param readyDeferred - Optional deferred to signal when subscription is consuming events
 */
export const runPiAdapter = (
  streamName: StreamName,
  eventStreamId: EventStreamId,
  readyDeferred?: Deferred.Deferred<void, never>
): Effect.Effect<void, ClientError, StreamClientService> =>
  Effect.gen(function*() {
    const client = yield* StreamClientService

    const state: PiAdapterState = {
      session: null,
      sessionManager: null,
      eventUnsubscribe: null
    }

    // Queue for Pi events to append to stream
    const piEventQueue = yield* Queue.unbounded<AgentSessionEvent>()

    // Fiber to process Pi events and append to stream
    const appendFiber = yield* Effect.fork(
      Stream.fromQueue(piEventQueue).pipe(
        Stream.runForEach((piEvent) =>
          Effect.gen(function*() {
            const wrappedEvent = makePiEventReceivedEvent(
              eventStreamId,
              piEvent.type,
              piEvent
            )
            yield* client.append({
              name: streamName,
              data: wrappedEvent
            })
          })
        )
      )
    )

    /**
     * Subscribe to Pi session events and forward to queue
     */
    const subscribeToPiEvents = (session: AgentSession): void => {
      if (state.eventUnsubscribe) {
        state.eventUnsubscribe()
      }

      state.eventUnsubscribe = session.subscribe((event) => {
        // Fire-and-forget: queue the event for async processing
        Effect.runFork(Queue.offer(piEventQueue, event))
      })
    }

    /**
     * Handle session create action
     */
    const handleSessionCreate = (payload: SessionCreatePayload): Effect.Effect<void, never, never> =>
      Effect.gen(function*() {
        yield* Console.log("[Pi Adapter] Creating session...")

        const authStorage = discoverAuthStorage()
        const modelRegistry = discoverModels(authStorage)
        // Use INIT_CWD (set by pnpm to original shell dir) if available, else process.cwd()
        const cwd = payload.cwd ?? process.env.INIT_CWD ?? process.cwd()

        // Use file-based session (same behavior as pi CLI)
        const sessionManager = payload.sessionFile
          ? SessionManager.open(payload.sessionFile)
          : SessionManager.create(cwd)

        const { session } = yield* Effect.promise(() =>
          createAgentSession({
            sessionManager,
            authStorage,
            modelRegistry,
            cwd
          })
        )

        state.session = session
        state.sessionManager = sessionManager
        subscribeToPiEvents(session)

        const sessionFile = sessionManager.getSessionFile()
        yield* Console.log(`[Pi Adapter] Session created${sessionFile ? ` (file: ${sessionFile})` : " (in-memory)"}`)
      })

    /**
     * Handle prompt action
     */
    const handlePrompt = (content: string): Effect.Effect<void, never, never> =>
      Effect.gen(function*() {
        if (!state.session) {
          yield* Console.error("[Pi Adapter] No session - ignoring prompt")
          return
        }

        yield* Console.log(`[Pi Adapter] Sending prompt: ${content.slice(0, 50)}...`)

        yield* Effect.promise(() => state.session!.prompt(content))

        yield* Console.log("[Pi Adapter] Prompt completed")
      })

    /**
     * Handle abort action
     */
    const handleAbort = (): Effect.Effect<void, never, never> =>
      Effect.gen(function*() {
        if (!state.session) {
          yield* Console.error("[Pi Adapter] No session - ignoring abort")
          return
        }

        yield* Console.log("[Pi Adapter] Aborting...")

        yield* Effect.promise(() => state.session!.abort())

        yield* Console.log("[Pi Adapter] Aborted")
      })

    // Subscribe to stream and handle action events
    yield* Console.log(`[Pi Adapter] Subscribing to stream: ${streamName}`)

    const eventStream = yield* client.subscribe({ name: streamName })

    // Process events in a forked fiber
    const processFiber = yield* Effect.fork(
      eventStream.pipe(
        Stream.runForEach((event) =>
          Effect.gen(function*() {
            const data = event.data as { type?: string; payload?: unknown } | null

            if (!data || typeof data.type !== "string") {
              return
            }

            switch (data.type) {
              case PiEventTypes.SESSION_CREATE:
                yield* handleSessionCreate(data.payload as SessionCreatePayload)
                break

              case PiEventTypes.PROMPT:
                yield* handlePrompt((data.payload as { content: string }).content)
                break

              case PiEventTypes.ABORT:
                yield* handleAbort()
                break
            }
          })
        )
      )
    )

    // Yield to scheduler to let the forked fiber start executing
    yield* Effect.yieldNow()

    // Signal ready after forking - the fiber has started and will begin the HTTP request
    if (readyDeferred) {
      yield* Deferred.succeed(readyDeferred, undefined)
    }
    yield* Console.log(`[Pi Adapter] Subscription active, waiting for events...`)

    // Wait for the processing fiber to complete (or be interrupted)
    yield* Fiber.join(processFiber)

    // Cleanup
    if (state.eventUnsubscribe) {
      state.eventUnsubscribe()
    }
    yield* Fiber.interrupt(appendFiber)
  })
