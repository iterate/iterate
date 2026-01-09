/**
 * Hook types for EventStream composition (Layer 2)
 *
 * Hooks have IDs for debugging/logging and future dependency-based execution.
 * Before-hooks can veto operations; after-hooks are fire-and-forget.
 */
import type { Effect } from "effect"
import { Schema } from "effect"
import type { Event, StreamName } from "./types.ts"

/** Error when a before-hook vetoes an operation */
export class HookError extends Schema.TaggedError<HookError>()("HookError", {
  hookId: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown)
}) {}

/** Before-hook: runs before append, can veto by failing with HookError */
export interface BeforeAppendHook {
  readonly id: string
  readonly run: (opts: {
    name: StreamName
    data: unknown
  }) => Effect.Effect<void, HookError>
}

/** After-hook: runs after successful append, errors logged but don't fail */
export interface AfterAppendHook {
  readonly id: string
  readonly run: (opts: {
    name: StreamName
    event: Event
  }) => Effect.Effect<void, never>
}

/** Hook configuration for an EventStream */
export interface StreamHooks {
  readonly beforeAppend?: ReadonlyArray<BeforeAppendHook>
  readonly afterAppend?: ReadonlyArray<AfterAppendHook>
}
