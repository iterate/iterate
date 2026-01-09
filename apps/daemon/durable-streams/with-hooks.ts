/**
 * withHooks - Layer 2 wrapper for EventStream
 *
 * Pure function that wraps an EventStream with before/after hooks.
 * No services, no layers - just composition.
 */
import type { Scope, Stream } from "effect";
import { Effect } from "effect";
import type { HookError, StreamHooks } from "./hooks.ts";
import type { Event, InvalidOffsetError, Offset, StorageError, StreamName } from "./types.ts";

/** EventStream with hooks has HookError in its append error channel */
export interface HookedEventStream {
  readonly name: StreamName;
  append(opts: { data: unknown }): Effect.Effect<Event, StorageError | HookError>;
  subscribe: (opts?: {
    offset?: Offset;
  }) => Effect.Effect<Stream.Stream<Event>, InvalidOffsetError | StorageError, Scope.Scope>;
  getFrom: (opts: {
    offset: Offset;
    limit?: number;
  }) => Effect.Effect<ReadonlyArray<Event>, InvalidOffsetError | StorageError>;
  readonly count: Effect.Effect<number, StorageError>;
}

/**
 * Wrap an EventStream with before/after hooks.
 *
 * - Before hooks run sequentially in array order; any failure vetoes append
 * - After hooks run sequentially after successful append; errors logged, don't fail
 * - subscribe/getFrom/count pass through unchanged
 *
 * Note: Returns HookedEventStream which has HookError in the append error channel.
 */
export const withHooks = (
  base: {
    readonly name: StreamName;
    append(opts: { data: unknown }): Effect.Effect<Event, StorageError>;
    subscribe: HookedEventStream["subscribe"];
    getFrom: HookedEventStream["getFrom"];
    readonly count: Effect.Effect<number, StorageError>;
  },
  hooks: StreamHooks,
): HookedEventStream => {
  const { afterAppend = [], beforeAppend = [] } = hooks;

  const append = (opts: { data: unknown }): Effect.Effect<Event, StorageError | HookError> =>
    Effect.gen(function* () {
      // Run before hooks - failure vetoes append
      for (const hook of beforeAppend) {
        yield* hook
          .run({ name: base.name, data: opts.data })
          .pipe(Effect.annotateLogs({ hookId: hook.id }));
      }

      // Delegate to base
      const event = yield* base.append(opts);

      // Run after hooks - errors logged but don't fail
      for (const hook of afterAppend) {
        yield* hook.run({ name: base.name, event }).pipe(
          Effect.annotateLogs({ hookId: hook.id }),
          Effect.catchAll((e) =>
            Effect.logWarning("After-hook failed", { hookId: hook.id, error: e }),
          ),
        );
      }

      return event;
    });

  return {
    name: base.name,
    append,
    subscribe: base.subscribe,
    getFrom: base.getFrom,
    count: base.count,
  };
};
