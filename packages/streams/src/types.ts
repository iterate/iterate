import type { StreamEvent, StreamEventInput } from "./shared/event.ts";
import type { Snapshot } from "./processor-runner.ts";
import type {
  CoreProcessorState,
  SubscriptionConfiguredEvent,
} from "./processors/core/contract.ts";

type MaybePromise<T> = T | Promise<T>;

export type StreamCoreProcessorState = CoreProcessorState;

export type StreamEventBatch = {
  namespace: string;
  path: string;
  events: StreamEvent[];
  /**
   * Piggybacked on each delivery so subscribers can compute lag without an
   * extra runtimeState() round trip.
   */
  streamMaxOffset: number;
};

export type ProcessEventBatch = (batch: StreamEventBatch) => unknown;

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
   * Subscribes to catch-up then live event batches. Type-filtered subscriptions
   * are planned, but not part of this first simplified storage shape.
   */
  subscribe(args: {
    subscriptionKey?: SubscriptionKey;
    processEventBatch: ProcessEventBatch;
    replayAfterOffset?: number;
    /** Only deliver these event types. Omit (or include `"*"`) for everything. */
    eventTypes?: readonly string[];
  }): MaybePromise<StreamSubscriptionHandle>;
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

export type StreamProcessorRunnerSnapshot = Snapshot<unknown>;

export type StreamProcessorRunnerRuntimeState = {
  processorSlug: string | undefined;
  snapshot: StreamProcessorRunnerSnapshot | undefined;
};

export type StreamProcessorRunnerRpc = {
  requestSubscription(args: {
    stream: StreamRpc;
    subscriptionKey: SubscriptionKey;
    streamMaxOffset: number;
    subscriptionConfiguredEvent: SubscriptionConfiguredEvent;
    streamRuntimeState: { coreProcessorState: StreamCoreProcessorState };
  }): MaybePromise<void>;
  runtimeState(): StreamProcessorRunnerRuntimeState;
};
