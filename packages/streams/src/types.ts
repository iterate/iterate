import type { RpcStub, RpcTarget } from "capnweb";
import type { StreamEvent, StreamEventInput } from "./shared/event.ts";
import type { Snapshot } from "./processor-runner.ts";
import type {
  CoreProcessorState,
  SubscriptionConfiguredEvent,
} from "./processors/core/contract.ts";

type MaybePromise<T> = T | Promise<T>;

export type StreamCoreProcessorState = CoreProcessorState;

/**
 * The subscriber-side capnweb RPC target that receives stream event batches.
 * The stream piggybacks its current max offset so subscribers can compute lag
 * without an extra round trip.
 */
export type SubscriptionSink = RpcTarget & {
  processEventBatch(args: { events: StreamEvent[]; streamMaxOffset: number }): unknown;
};

export type StreamRpc = {
  append(args: { streamPath?: string; event: StreamEventInput }): MaybePromise<StreamEvent>;
  appendBatch(args: {
    streamPath?: string;
    events: StreamEventInput[];
  }): MaybePromise<StreamEvent[]>;
  getEvent(
    args: { offset: number; idempotencyKey?: never } | { idempotencyKey: string; offset?: never },
  ): StreamEvent | undefined;
  /**
   * Reads events by numeric offset boundaries. Type filtering belongs here later,
   * but the first SQLite rewrite keeps the read API offset-only.
   */
  getEvents(args?: {
    afterOffset?: number;
    beforeOffset?: number | null;
    limit?: number;
  }): StreamEvent[];
  /**
   * Subscribes to catch-up then live event batches. Type-filtered subscriptions
   * are planned, but not part of this first simplified storage shape.
   */
  subscribe(args: {
    subscriptionKey?: SubscriptionKey;
    sink: RpcStub<SubscriptionSink>;
    replayAfterOffset?: number;
  }): { subscriptionKey: SubscriptionKey; streamMaxOffset: number; unsubscribe(): void };
  runtimeState(): {
    coreProcessorState: StreamCoreProcessorState;
    runtime: {
      connections: Record<SubscriptionKey, ConnectionInfo>;
    };
  };
  kill(): void;
  /** Clears all durable storage for this stream, then aborts the current incarnation. */
  reset(): Promise<void>;
  reduce(args: {
    event: StreamEvent;
    coreProcessorState?: StreamCoreProcessorState;
  }): StreamCoreProcessorState;
};

export type SubscriptionKey = string;

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
    stream: RpcStub<StreamRpc>;
    subscriptionKey: SubscriptionKey;
    streamMaxOffset: number;
    subscriptionConfiguredEvent: SubscriptionConfiguredEvent;
    streamRuntimeState: { coreProcessorState: StreamCoreProcessorState };
  }): MaybePromise<{ sink: SubscriptionSink; replayAfterOffset?: number }>;
  runtimeState(): StreamProcessorRunnerRuntimeState;
};
