import {
  Callable as CallableSchema,
  CALLABLE_SCHEMA,
  FetchCallable as FetchCallableSchema,
} from "./descriptor-types.ts";
import type {
  Callable as CallableDescriptor,
  DurableObjectSelector,
  FetchCallable as FetchCallableDescriptor,
  WorkersRpcCallable,
} from "./descriptor-types.ts";

export { CALLABLE_SCHEMA };
export const Callable = CallableSchema;
export const FetchCallable = FetchCallableSchema;
export type Callable = CallableDescriptor;
export type FetchCallable = FetchCallableDescriptor;
export type { DurableObjectSelector, WorkersRpcCallable };

/**
 * A `Callable` is intentionally just JSON data. It names a way to invoke
 * something, but it does not contain the live Worker binding, Durable Object
 * stub, or public `fetch` capability.
 *
 * Treat a Callable as untrusted code. Dispatching it with `ctx.env` is an
 * explicit decision to let the JSON select from those binding names. V1 keeps
 * policy out of the kernel so the first slice stays small, but callers must not
 * pass sensitive bindings unless they mean to make them nameable by the
 * Callable. `tasks/capability-policy.md` tracks the hardened resolver/policy
 * layer.
 */
export type CallableContext = {
  /**
   * Worker bindings keyed by their runtime binding name. `env-binding` via
   * keep only `bindingName`, so this object is where a stored Callable resolves
   * to a live platform capability.
   *
   * Cloudflare bindings are intentionally capability-bearing APIs, not plain
   * configuration values:
   * https://developers.cloudflare.com/workers/runtime-apis/bindings/
   */
  env?: Record<string, unknown>;
  /**
   * Loopback bindings from `ctx.exports`, keyed by top-level export name.
   *
   * Cloudflare documents `ctx.exports` as automatically configured loopback
   * bindings for this Worker's own exports. They can represent service
   * bindings and Durable Object namespace bindings. Loopback service bindings
   * can also receive dynamic `props`.
   * https://developers.cloudflare.com/workers/runtime-apis/context/#exports
   */
  exports?: Record<string, unknown>;
  /**
   * Host-owned values available to JSONata expressions as `$ambient`.
   *
   * The expression root remains the callable input so `$` is always the value
   * being transformed. Keeping ambient data in a JSONata variable avoids
   * smuggling host context into user payload fields.
   */
  ambient?: Record<string, unknown>;
  /**
   * Public URL fetch capability used only by callables using
   * `{ type: "url" }`.
   *
   * Worker-boundary code can pass the runtime function directly as
   * `{ fetch }`. Keeping it explicit is important: public egress should not be
   * created by a shared helper silently reading `globalThis.fetch`. Env and
   * loopback binding via values ignore this field because their authority comes
   * from `env` or `ctx.exports`.
   */
  fetch?: typeof globalThis.fetch;
};

export type CallableErrorCode =
  | "DESCRIPTOR_VALIDATION_FAILED"
  | "PAYLOAD_VALIDATION_FAILED"
  | "RESOLUTION_FAILED"
  | "TRANSPORT_FAILED"
  | "REMOTE_ERROR";

export class CallableError extends Error {
  readonly code: CallableErrorCode;
  readonly retryable: boolean;
  readonly cause: unknown;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: CallableErrorCode,
    message: string,
    options: { retryable?: boolean; cause?: unknown; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = "CallableError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.cause = options.cause;
    this.details = options.details;
  }
}
