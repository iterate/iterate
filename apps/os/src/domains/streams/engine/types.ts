import type { StreamEvent, StreamEventInput } from "./shared/event.ts";
import type {
  CoreProcessorState,
  ProcessorContractAnnouncement,
  StreamSubscriberDescriptor,
} from "./processors/core/contract.ts";
import type { StreamProcessorRuntimeState } from "./stream-processor.ts";

type MaybePromise<T> = T | Promise<T>;

export type StreamCoreProcessorState = CoreProcessorState;

export type StreamEventBatch = {
  namespace: string;
  path: string;
  /**
   * The delivered events in offset order. Empty in exactly two cases: the
   * initial push every subscription receives on open (state +
   * `streamMaxOffset`, no events yet to deliver) and every batch of an
   * `events: false` (state-only) subscription. Kept as an empty array rather
   * than omitted so the batch shape is stable across modes.
   */
  events: StreamEvent[];
  /**
   * Piggybacked on each delivery so subscribers can compute lag without an
   * extra runtimeState() round trip.
   */
  streamMaxOffset: number;
  /**
   * The stream's core reduced state as of `streamMaxOffset`, read at delivery
   * time. At the live edge this is exactly the state after this batch's last
   * event; while a subscriber is catching up on a backlog it can be ahead of
   * `events.at(-1)?.offset` (the stream has committed more than this batch
   * carries). One subscription primitive carries both events and state, so a
   * subscriber paints its first render and stays current without separate
   * getState calls or polling.
   */
  state: StreamCoreProcessorState;
};

export type ProcessEventBatch = (batch: StreamEventBatch) => unknown;

export type ProcessorRuntimeState = StreamProcessorRuntimeState<unknown>;

export type GetProcessorRuntimeState = () => MaybePromise<ProcessorRuntimeState>;

export type LiveStreamSubscriberDescriptor = Omit<StreamSubscriberDescriptor, "processor"> & {
  processor?: {
    announcement: ProcessorContractAnnouncement;
    /**
     * Live-only capability retained for the subscription lifetime. It is not
     * persisted into presence facts; the stream calls it on demand from
     * getProcessorRuntimeState({ subscriptionKey }).
     */
    getRuntimeState?: GetProcessorRuntimeState;
  };
};

/** The minimal append surface a processor's iterate context exposes. */
export type ProcessorStream = {
  append(args: { streamPath?: string; event: StreamEventInput }): unknown;
  appendBatch(args: { streamPath?: string; events: StreamEventInput[] }): unknown;
};

export type StreamRpc = {
  append(args: { streamPath?: string; event: StreamEventInput }): MaybePromise<StreamEvent>;
  appendBatch(args: {
    streamPath?: string;
    events: StreamEventInput[];
  }): MaybePromise<StreamEvent[]>;
  getEvent(
    args: { offset: number; idempotencyKey?: never } | { idempotencyKey: string; offset?: never },
  ): MaybePromise<StreamEvent | undefined>;
  /**
   * Reads events by numeric offset boundaries. Type filtering belongs here later,
   * but the first SQLite rewrite keeps the read API offset-only.
   */
  getEvents(args?: {
    afterOffset?: number;
    beforeOffset?: number | null;
    limit?: number;
  }): MaybePromise<StreamEvent[]>;
  /**
   * Waits for the first event after `afterOffset` whose predicate returns true.
   * Omitting `afterOffset` waits from the live edge; pass 0 to include history.
   */
  waitForEvent(args: {
    afterOffset?: number;
    eventTypes?: readonly string[];
    predicate: (event: StreamEvent) => MaybePromise<boolean>;
    timeoutMs: number;
  }): MaybePromise<StreamEvent>;
  /**
   * Subscribes to catch-up then live event batches. Every subscription
   * immediately receives one batch carrying the current `state` and
   * `streamMaxOffset` (plus the replayed events when `replayAfterOffset`
   * yields any), so the first render never needs a separate getState call.
   */
  subscribe(args: {
    subscriptionKey?: SubscriptionKey;
    processEventBatch: ProcessEventBatch;
    replayAfterOffset?: number;
    /** Only deliver these event types. Omit (or include `"*"`) for everything. */
    eventTypes?: readonly string[];
    /**
     * `false` = state-only mode: batches arrive with `events: []` but current
     * `state`/`streamMaxOffset`, one per state advance (appends a slow
     * subscriber missed are coalesced). Replay is meaningless without events,
     * so state-only subscriptions are implicitly live-from-now —
     * `replayAfterOffset` is ignored. Defaults to `true`.
     */
    events?: boolean;
    /** Who is subscribing; serializable fields land on the presence roster. */
    subscriber?: LiveStreamSubscriberDescriptor;
  }): MaybePromise<StreamSubscriptionHandle>;
  getProcessorRuntimeState(args: {
    subscriptionKey: SubscriptionKey;
  }): MaybePromise<ProcessorRuntimeState | null>;
  runtimeState(): MaybePromise<{
    coreProcessorState: StreamCoreProcessorState;
    runtime: {
      connections: Record<SubscriptionKey, ConnectionInfo>;
    };
  }>;
  kill(): MaybePromise<void>;
  /** Clears all durable storage for this stream, then aborts the current incarnation. */
  reset(): Promise<void>;
  reduce(args: {
    event: StreamEvent;
    coreProcessorState?: StreamCoreProcessorState;
  }): MaybePromise<StreamCoreProcessorState>;
};

export type SubscriptionKey = string;

export type StreamSubscriptionHandle = {
  subscriptionKey: SubscriptionKey;
  streamMaxOffset: number;
  unsubscribe(): void;
};

/** Serializable debug view of a live delivery connection, returned by `runtimeState()`. */
export type ConnectionInfo = {
  direction: "inbound" | "outbound";
  startedAt: string;
  cursor: number;
  batchesSent: number;
  eventsSent: number;
  lastDeliveredAt?: string;
};
