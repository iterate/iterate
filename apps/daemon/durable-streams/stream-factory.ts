/**
 * EventStreamFactory - Service that creates EventStream instances
 *
 * Different factory implementations provide different behaviors:
 * - Plain: returns base EventStream unchanged
 * - WithHooks: wraps streams with before/after hooks
 */
import { Effect, Layer } from "effect";
import { HookError, type StreamHooks } from "./hooks.ts";
import { Storage } from "./storage.ts";
import { type EventStream, makeEventStream } from "./stream.ts";
import type { StorageError, StreamName } from "./types.ts";
import { withHooks } from "./with-hooks.ts";

/** Factory interface - creates EventStream instances (Storage already provided) */
export class EventStreamFactory extends Effect.Service<EventStreamFactory>()(
  "@event-stream/EventStreamFactory",
  {
    succeed: {
      // Note: Layers provide Storage closure, so make() returns Effect without Storage requirement
      make: (_opts: { name: StreamName }): Effect.Effect<EventStream, StorageError> =>
        Effect.die("EventStreamFactory.Default not usable - use Plain or WithHooks layer"),
    },
  },
) {
  /** Plain factory - returns base EventStream unchanged */
  static readonly Plain: Layer.Layer<EventStreamFactory, never, Storage> = Layer.effect(
    EventStreamFactory,
    Effect.gen(function* () {
      const storage = yield* Storage;
      return {
        make: (opts: { name: StreamName }) =>
          makeEventStream(opts).pipe(Effect.provideService(Storage, storage)),
      } as EventStreamFactory;
    }),
  );

  /** Factory that wraps streams with hooks */
  static WithHooks(hooks: StreamHooks): Layer.Layer<EventStreamFactory, never, Storage> {
    return Layer.effect(
      EventStreamFactory,
      Effect.gen(function* () {
        const storage = yield* Storage;
        return {
          make: (opts: { name: StreamName }) =>
            makeEventStream(opts).pipe(
              Effect.provideService(Storage, storage),
              // withHooks returns HookedEventStream which is compatible with EventStream
              // (HookError is added to append error channel)
              Effect.map((base) => withHooks(base, hooks) as unknown as EventStream),
            ),
        } as EventStreamFactory;
      }),
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PLAYGROUND - Define variant configurations here, change ActiveFactory to swap
// ═══════════════════════════════════════════════════════════════════════════════

/** Validated streams - require _type field */
const validatedHooks: StreamHooks = {
  beforeAppend: [
    {
      id: "require-type-field",
      run: ({ data }) => {
        const obj = data as Record<string, unknown>;
        if (typeof obj._type !== "string") {
          return Effect.fail(
            new HookError({
              hookId: "require-type-field",
              message: "Data must have _type string field",
            }),
          );
        }
        return Effect.void;
      },
    },
  ],
};

/** Embryonic agent streams - agent event validation + logging */
const embryonicAgentHooks: StreamHooks = {
  beforeAppend: [
    {
      id: "validate-agent-event",
      run: ({ data }) => {
        const obj = data as Record<string, unknown>;
        if (typeof obj._type !== "string" || !obj._type.startsWith("agent:")) {
          return Effect.fail(
            new HookError({
              hookId: "validate-agent-event",
              message: "Agent events must have _type starting with 'agent:'",
            }),
          );
        }
        return Effect.void;
      },
    },
  ],
  afterAppend: [
    {
      id: "log-agent-event",
      run: ({ event, name }) =>
        Effect.log("Agent event", {
          stream: name,
          offset: event.offset,
          type: (event.data as Record<string, unknown>)._type,
        }),
    },
  ],
};

// Variant layers
export const PlainFactory = EventStreamFactory.Plain;
export const ValidatedFactory = EventStreamFactory.WithHooks(validatedHooks);
export const EmbryonicAgentFactory = EventStreamFactory.WithHooks(embryonicAgentHooks);

// ═══════════════════════════════════════════════════════════════════════════════
// CHANGE THIS LINE TO SWAP IMPLEMENTATION
// ═══════════════════════════════════════════════════════════════════════════════
export const ActiveFactory = PlainFactory;
