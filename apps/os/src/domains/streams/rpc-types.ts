/**
 * The stream + processor RPC surface: the durable subscription handles, the
 * processor state-push contract, and the batch envelope the pump delivers.
 * These are hand-authored shapes (generics preserved) that both the public itx
 * contract and the server-side host/subscriber machinery build against.
 */
import type { StreamEvent } from "./schemas.ts";

/** Stable identity for one stream subscription connection. */
export type SubscriptionKey = string;

export type ProcessorSnapshot<State> = {
  offset: number;
  state: State;
};

/**
 * Live handle for one `onStateChange` subscription.
 *
 * `ping()` is the liveness probe: `true` while the subscription is still
 * registered on the live processor, `false` once it was dropped (delivery
 * failure, explicit unsubscribe). The call REJECTS when the hosting Durable
 * Object incarnation is gone. For a subscriber, `false` and a rejection mean
 * the same thing: re-subscribe. Pushes stop silently when a DO restarts or a
 * transport half-opens, so a periodic ping is how a client turns "silently
 * stale" into "detectably dead".
 */
export type ProcessorStateSubscriptionHandle = Disposable & {
  ping(): boolean | Promise<boolean>;
  unsubscribe(): void;
};

export interface StreamProcessorRpc<State = unknown> {
  getRuntimeState(): Promise<ProcessorRuntimeState<State>>;
  /**
   * Server-push of the processor's reduced state. The callback receives the
   * durable checkpoint `{ offset, state }` — offset-carrying so clients can
   * commit pushes and `snapshot()` reads monotonically against each other —
   * once immediately on subscribe (current state IS the first paint) and then
   * after every checkpointed batch that changed state.
   */
  onStateChange(
    cb: (snapshot: ProcessorSnapshot<State>) => unknown,
  ): Promise<ProcessorStateSubscriptionHandle>;
  snapshot(): Promise<ProcessorSnapshot<State>>;
  waitUntilEvent(input: { offset: number; timeoutMs?: number }): Promise<void>;
}

/**
 * Batch delivered to stream processors and live subscribers.
 *
 * Kept named because callback retention, processor hosts, and tests all depend
 * on the same cross-RPC batch envelope.
 */
export type StreamEventBatch = {
  projectId: string | null;
  path: string;
  events: StreamEvent[];
  streamMaxOffset: number;
  state: unknown;
};

/**
 * Callback invoked by the stream pump for each delivered batch.
 *
 * It stays as a named type because Workers RPC callback lifecycle helpers need
 * to duplicate, retain, and dispose exactly this callback shape.
 */
export type ProcessEventBatch = (batch: StreamEventBatch) => unknown;

/** Serializable snapshot plus optional live runtime debug state for a processor. */
export type ProcessorRuntimeState<State = unknown> = {
  snapshot: { offset: number; state: State };
  runtime?: Record<string, unknown>;
};

/**
 * Optional runtime-state callback exposed by a hosted processor.
 *
 * It accepts sync or async implementations because local processors can return
 * immediately, while RPC-backed processors may need an async round trip.
 */
export type GetProcessorRuntimeState = () => ProcessorRuntimeState | Promise<ProcessorRuntimeState>;

/**
 * Live subscription handle returned by `Stream.subscribe`.
 *
 * `ping()` mirrors {@link ProcessorStateSubscriptionHandle.ping}: `true` while
 * the connection is still open on the live stream, `false` after it closed
 * (replaced, delivery failure, unsubscribe); it rejects when the stream's
 * Durable Object incarnation is gone. Either non-`true` outcome means the
 * subscriber should re-subscribe.
 */
export type StreamSubscriptionHandle = Disposable & {
  /** Stable identity of this subscription connection. */
  subscriptionKey: SubscriptionKey;
  /** The stream's max offset at subscribe time (replay starts behind it). */
  streamMaxOffset: number;
  ping(): boolean | Promise<boolean>;
  /** Close this connection; safe to call more than once. */
  unsubscribe(): void;
};
