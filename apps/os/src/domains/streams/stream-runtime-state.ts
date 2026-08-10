import type { StreamThroughputMetrics } from "iterate/processors";
import type { CoreProcessorState } from "./core-processor-contract.ts";
import type { EphemeralEventBufferRuntimeState } from "./ephemeral-event-buffer.ts";
import type { ConnectionRuntimeState, SubscriptionRuntimeState } from "./stream-event-sender.ts";

/** Serializable stream-core and delivery-runtime state exposed through `Stream.liveState`. */
export type StreamRuntimeDebugState = {
  /** Durable stream events reduced by the core processor. */
  coreProcessorState: CoreProcessorState;
  runtime: {
    connections: Record<string, ConnectionRuntimeState>;
    /**
     * Idle-closed session connections whose subscriber is still present on a
     * hibernatable Subscriber Pager that the client gave the Stream DO
     * (stream-subscriber-pager.ts). Presence surfaces should
     * render these as dormant, not gone: their `connection-closed
     * reason:"idle"` fact is deliberately not a departure.
     */
    dormantSubscribers: Record<string, { idleDeliveredThrough: number; pageSentAtOffset?: number }>;
    /** Stored subscription progress, keyed by subscription key. */
    subscriptions: Record<string, SubscriptionRuntimeState>;
    metrics: StreamThroughputMetrics;
    /** Memory-only ephemeral events retained by this Durable Object incarnation. */
    ephemeralEvents: EphemeralEventBufferRuntimeState;
    /** SQLite database size in bytes (event log + delivery rows + chunks). */
    storageSizeBytes: number;
  };
};
