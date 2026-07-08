/**
 * The stream + processor RPC surface: the durable subscription handles, the
 * processor state-push contract, and the batch envelope the pump delivers.
 * These are hand-authored shapes (generics preserved) that both the public itx
 * contract and the server-side host/subscriber machinery build against.
 */
import type { StreamEvent } from "./schemas.ts";

/** Stable identity for one stream subscription connection. */
export type SubscriptionKey = string;

/** The read window accepted by `Stream.getEvents` / `Stream.readEvents`. */
export type StreamEventReadInput = {
  /** Exclusive lower bound. Defaults to 0. */
  afterOffset?: number;
  /** Exclusive upper bound. Omit/null to read through the current tail. */
  beforeOffset?: number | null;
  /** Event types to include. Omit or include "*" for all; [] matches none. */
  eventTypes?: readonly string[];
  /** Page size, 1-500. Defaults to 500. */
  limit?: number;
};

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

/**
 * The batch a PUSH subscription's receiver is invoked with: the ordinary
 * {@link StreamEventBatch} envelope every other subscriber gets ("stream
 * processor" is one shape), plus the fields an at-least-once stateless
 * receiver needs to dedupe and self-configure.
 */
export type StreamPushEventBatch = StreamEventBatch & {
  subscriptionKey: SubscriptionKey;
  /**
   * Stable across retries of the same batch (`${subscriptionKey}:${firstOffset}-${lastOffset}`),
   * so receivers can dedupe redeliveries even without per-event bookkeeping.
   * (`${event.path}@${event.offset}` remains the per-event idempotency idiom.)
   */
  deliveryId: string;
  /** 1-based consecutive attempt count for this batch. */
  attempt: number;
  /**
   * The exact committed `subscription-configured` event this delivery serves —
   * so a receiver can configure itself from committed stream state without a
   * side-channel registry (which stream, which selector, whose params).
   */
  configuredEvent: StreamEvent;
};

/**
 * What the stream sends when poking a durable wake-mode subscriber
 * (`wakeStreamSubscriber`): serializable coordinates only.
 */
export type StreamSubscriberWakeRequest = {
  stream: {
    projectId: string | null;
    path: string;
    streamMaxOffset: number;
  };
  subscriptionKey: SubscriptionKey;
  /** Which hosted processor the poke is for (multi-processor hosts resolve on it). */
  processorSlug?: string;
};

/**
 * What the poked subscriber hands back — the entire handshake in one return
 * value. The stream retains `sink` (ownership of a returned stub transfers to
 * the caller) and streams one-way batches into it from `checkpointOffset + 1`;
 * there is no subscribe-back call and therefore no handshake race to fence.
 */
export type StreamSubscriberWakeResponse = {
  /** The processor's durable checkpoint offset — replay resumes after it. */
  checkpointOffset: number;
  /** The live delivery callback the stream retains and invokes per batch. */
  sink: ProcessEventBatch;
  /**
   * Serializable subscriber identity (validated against
   * `StreamSubscriberDescriptor` by the stream) appended as the
   * subscriber-connected presence fact; carries the processor's contract
   * announcement for the stream's `processorsBySlug` registry.
   */
  subscriber?: unknown;
  /** Live runtime-state capability, retained for the connection lifetime. */
  getRuntimeState?: GetProcessorRuntimeState;
};

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
