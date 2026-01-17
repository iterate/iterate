/**
 * Pi Harness Adapter
 *
 * Connects a Pi coding agent session to an event stream.
 * - Subscribes to stream for action events (prompt, abort)
 * - Calls Pi SDK methods in response
 * - Wraps Pi SDK events and appends to stream
 */
import type {
  AgentSession,
  AgentSessionEvent,
  SessionManager as SessionManagerType,
} from "@mariozechner/pi-coding-agent";
import {
  createAgentSession,
  discoverAuthStorage,
  discoverModels,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import { Console, Deferred, Effect, Fiber, Queue, Scope, Stream } from "effect";
import { StreamManagerService } from "../../event-stream/stream-manager.ts";
import {
  OFFSET_START,
  type StreamName,
  type StorageError,
  type InvalidOffsetError,
} from "../../event-stream/types.ts";
import {
  type EventStreamId,
  makePiErrorEvent,
  makePiEventReceivedEvent,
  makeSessionReadyEvent,
  PiEventTypes,
  type SessionCreatePayload,
} from "./types.ts";

/**
 * State of the Pi adapter
 */
interface PiAdapterState {
  session: AgentSession | null;
  sessionManager: SessionManagerType | null;
  eventUnsubscribe: (() => void) | null;
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
  readyDeferred?: Deferred.Deferred<void, never>,
): Effect.Effect<void, StorageError | InvalidOffsetError, StreamManagerService | Scope.Scope> =>
  Effect.gen(function* () {
    const manager = yield* StreamManagerService;

    const state: PiAdapterState = {
      session: null,
      sessionManager: null,
      eventUnsubscribe: null,
    };

    // Queue for Pi events to append to stream
    const piEventQueue = yield* Queue.unbounded<AgentSessionEvent>();

    // Fiber to process Pi events and append to stream
    const appendFiber = yield* Effect.fork(
      Stream.fromQueue(piEventQueue).pipe(
        Stream.runForEach((piEvent) =>
          Effect.gen(function* () {
            const wrappedEvent = makePiEventReceivedEvent(eventStreamId, piEvent.type, piEvent);
            yield* manager.append({
              name: streamName,
              data: wrappedEvent,
            });
          }),
        ),
      ),
    );

    /**
     * Subscribe to Pi session events and forward to queue
     */
    const subscribeToPiEvents = (session: AgentSession): void => {
      if (state.eventUnsubscribe) {
        state.eventUnsubscribe();
      }

      state.eventUnsubscribe = session.subscribe((event) => {
        // Fire-and-forget: queue the event for async processing
        Effect.runFork(Queue.offer(piEventQueue, event));
      });
    };

    /**
     * Append an error event to the stream
     */
    const appendErrorEvent = (error: unknown, context: string): Effect.Effect<void, StorageError> =>
      manager
        .append({ name: streamName, data: makePiErrorEvent(eventStreamId, error, context) })
        .pipe(Effect.asVoid);

    /**
     * Handle session create action
     */
    const handleSessionCreate = (
      payload: SessionCreatePayload,
    ): Effect.Effect<void, StorageError> =>
      Effect.gen(function* () {
        yield* Console.log("[Pi Adapter] Creating session...");

        const cwd = payload.cwd ?? process.env.INIT_CWD ?? process.cwd();

        yield* Effect.tryPromise({
          try: async () => {
            const authStorage = discoverAuthStorage();
            const modelRegistry = discoverModels(authStorage);

            // Use file-based session (same behavior as pi CLI)
            const sessionManager = payload.sessionFile
              ? SessionManager.open(payload.sessionFile)
              : SessionManager.create(cwd);

            const { session } = await createAgentSession({
              sessionManager,
              authStorage,
              modelRegistry,
              cwd,
            });

            state.session = session;
            state.sessionManager = sessionManager;
            subscribeToPiEvents(session);

            const sessionFile = sessionManager.getSessionFile() ?? null;
            return sessionFile;
          },
          catch: (error) => error,
        }).pipe(
          Effect.flatMap((sessionFile) =>
            Effect.gen(function* () {
              yield* Console.log(
                `[Pi Adapter] Session created${sessionFile ? ` (file: ${sessionFile})` : " (in-memory)"}`,
              );
              yield* manager.append({
                name: streamName,
                data: makeSessionReadyEvent(eventStreamId, sessionFile, cwd),
              });
            }),
          ),
          Effect.catchAll((error) =>
            Effect.gen(function* () {
              yield* Console.error(
                `[Pi Adapter] Session create error: ${error instanceof Error ? error.message : String(error)}`,
              );
              yield* appendErrorEvent(error, "session-create");
            }),
          ),
        );
      });

    /**
     * Handle prompt action
     */
    const handlePrompt = (content: string): Effect.Effect<void, StorageError> =>
      Effect.gen(function* () {
        if (!state.session) {
          yield* Console.error("[Pi Adapter] No session - ignoring prompt");
          yield* appendErrorEvent("No session available", "prompt");
          return;
        }

        yield* Console.log(`[Pi Adapter] Sending prompt: ${content.slice(0, 50)}...`);

        yield* Effect.tryPromise({
          try: () => state.session!.prompt(content),
          catch: (error) => error,
        }).pipe(
          Effect.catchAll((error) =>
            Effect.gen(function* () {
              yield* Console.error(
                `[Pi Adapter] Prompt error: ${error instanceof Error ? error.message : String(error)}`,
              );
              yield* appendErrorEvent(error, "prompt");
            }),
          ),
        );

        yield* Console.log("[Pi Adapter] Prompt completed");
      });

    /**
     * Handle abort action
     */
    const handleAbort = (): Effect.Effect<void, never, never> =>
      Effect.gen(function* () {
        if (!state.session) {
          yield* Console.error("[Pi Adapter] No session - ignoring abort");
          return;
        }

        yield* Console.log("[Pi Adapter] Aborting...");

        yield* Effect.promise(() => state.session!.abort());

        yield* Console.log("[Pi Adapter] Aborted");
      });

    // Subscribe to stream from the END (only new events)
    // This prevents replaying historical prompts that have already been processed
    yield* Console.log(`[Pi Adapter] Subscribing to stream: ${streamName}`);

    // Get current events and subscribe from after the last one
    // Uses the last event's actual offset for correct exclusive filtering (offset > lastOffset)
    const existingEvents = yield* manager.getFrom({ name: streamName });
    const startOffset =
      existingEvents.length > 0 ? existingEvents[existingEvents.length - 1].offset : OFFSET_START;
    yield* Console.log(
      `[Pi Adapter] Starting from offset ${startOffset} (${existingEvents.length} existing events)`,
    );

    // When reattaching to an existing stream, we need to recreate the session
    // and replay any PROMPT events that may have been missed
    if (existingEvents.length > 0) {
      const sessionCreateEvent = existingEvents.find((event) => {
        const data = event.data as { type?: string } | null;
        return data?.type === PiEventTypes.SESSION_CREATE;
      });

      if (sessionCreateEvent) {
        const data = sessionCreateEvent.data as { payload?: unknown };
        yield* Console.log("[Pi Adapter] Reattaching - replaying session create");
        yield* handleSessionCreate(data.payload as SessionCreatePayload).pipe(
          Effect.catchAll((e) =>
            Console.error(`[Pi Adapter] Replay session create failed: ${e.message}`),
          ),
        );

        // Replay any PROMPT events that came after SESSION_CREATE
        // This handles the case where prompts were written but the adapter was killed (HMR)
        const promptEvents = existingEvents.filter((event) => {
          const d = event.data as { type?: string } | null;
          return d?.type === PiEventTypes.PROMPT;
        });

        if (promptEvents.length > 0) {
          yield* Console.log(`[Pi Adapter] Replaying ${promptEvents.length} historical prompt(s)`);
          for (const promptEvent of promptEvents) {
            const d = promptEvent.data as { payload?: { content: string } };
            if (d.payload?.content) {
              yield* handlePrompt(d.payload.content).pipe(
                Effect.catchAll((e) =>
                  Console.error(`[Pi Adapter] Replay prompt failed: ${e.message}`),
                ),
              );
            }
          }
        }
      }
    }

    const eventStream = yield* manager.subscribe({ name: streamName, offset: startOffset });

    // Process events in a forked fiber
    const processFiber = yield* Effect.fork(
      eventStream.pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            const data = event.data as { type?: string; payload?: unknown } | null;

            if (!data || typeof data.type !== "string") {
              return;
            }

            switch (data.type) {
              case PiEventTypes.SESSION_CREATE:
                yield* handleSessionCreate(data.payload as SessionCreatePayload).pipe(
                  Effect.catchAll((e) =>
                    Console.error(`[Pi Adapter] Session create failed: ${e.message}`),
                  ),
                );
                break;

              case PiEventTypes.PROMPT:
                yield* handlePrompt((data.payload as { content: string }).content).pipe(
                  Effect.catchAll((e) => Console.error(`[Pi Adapter] Prompt failed: ${e.message}`)),
                );
                break;

              case PiEventTypes.ABORT:
                yield* handleAbort();
                break;
            }
          }),
        ),
      ),
    );

    // Yield to scheduler to let the forked fiber start executing
    yield* Effect.yieldNow();

    // Signal ready after forking - the fiber has started and will begin the HTTP request
    if (readyDeferred) {
      yield* Deferred.succeed(readyDeferred, undefined);
    }
    yield* Console.log(`[Pi Adapter] Subscription active, waiting for events...`);

    // Wait for the processing fiber to complete (or be interrupted)
    yield* Fiber.join(processFiber);

    // Cleanup
    if (state.eventUnsubscribe) {
      state.eventUnsubscribe();
    }
    yield* Fiber.interrupt(appendFiber);
  });
