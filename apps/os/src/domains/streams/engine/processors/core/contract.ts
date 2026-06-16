// Defines the built-in "core" processor contract.
// This processor owns stream runtime state such as max offset, stream config,
// outbound subscription configuration, the subscriber presence roster, and the
// paused/resumed door. The Stream Durable Object runs it inline during append
// instead of through a subscription runner. Token-bucket rate limiting lives in
// the circuit-breaker processor.
//
// Contract files are the schema/type layer: plumbing modules (types.ts, the
// processor host) import payload schemas from here, and processors that
// reconcile on presence facts list this contract in their `processorDeps`.

import { z } from "zod";
import { Callable } from "@iterate-com/shared/callable/types.ts";
import { defineProcessorContract } from "../../shared/stream-processors.ts";

/**
 * The one supported subscriber shape: a Callable descriptor the Stream DO
 * dispatches with the subscription handshake. The callable names the host
 * (worker entrypoint or durable object) and the RPC method to invoke; the host
 * then calls back `subscribeOutbound` to receive batches. No authorization yet:
 * any appender can point a subscription at any dispatchable target.
 */
const SupportedOutboundSubscriber = z.object({
  type: z.literal("callable"),
  callable: Callable,
});

export const SupportedSubscriptionConfiguredEvent = z.object({
  offset: z.number().int().min(0),
  type: z.literal("events.iterate.com/stream/subscription-configured"),
  payload: z.object({
    subscriptionKey: z.string().trim().min(1),
    subscriber: SupportedOutboundSubscriber,
  }),
  createdAt: z.string(),
});

/**
 * A processor contract announcement carried on the connect event when the
 * subscriber is a hosted stream processor. This is what feeds the stream's
 * `processorsBySlug` documentation registry.
 */
export const ProcessorContractAnnouncement = z.object({
  slug: z.string().trim().min(1),
  version: z.string().trim().min(1),
  description: z.string(),
  consumes: z.array(z.string()),
  emits: z.array(z.string()),
  ownedEvents: z.array(
    z.object({
      type: z.string().trim().min(1),
      description: z.string().optional(),
    }),
  ),
});

export type ProcessorContractAnnouncement = z.infer<typeof ProcessorContractAnnouncement>;

export const StreamSubscriberProcessorDescriptor = z.preprocess(
  (value) =>
    isRecord(value) && !isRecord(value.announcement) && typeof value.slug === "string"
      ? { announcement: value }
      : value,
  z.object({
    /** Serializable processor contract announcement persisted into presence facts. */
    announcement: ProcessorContractAnnouncement,
  }),
);

export type StreamSubscriberProcessorDescriptor = z.infer<
  typeof StreamSubscriberProcessorDescriptor
>;

/**
 * Identity the connecting party passes in its subscribe call. All fields are
 * optional: anonymous inbound watchers (a stream-viewer tab) may pass nothing,
 * processor hosts pass their incarnation id plus a processor announcement.
 */
export const StreamSubscriberDescriptor = z.object({
  /**
   * Stable for one instance of the subscriber's runtime (e.g. one Durable
   * Object incarnation). A connected event with a new incarnationId means the
   * subscriber's non-serializable runtime state was reset.
   */
  incarnationId: z.string().trim().min(1).optional(),
  /** Human-readable label, e.g. "browser" or "orpc-bridge". */
  description: z.string().optional(),
  /** Present when the subscriber is a stream processor. */
  processor: StreamSubscriberProcessorDescriptor.optional(),
});

export type StreamSubscriberDescriptor = z.infer<typeof StreamSubscriberDescriptor>;

export const StreamSubscriberDisconnectReason = z.enum([
  /** A new connection for the same subscriptionKey replaced this one. */
  "replaced",
  /** The subscriber called unsubscribe(). */
  "unsubscribed",
  /** The RPC session to the subscriber broke (subscriber crashed or was evicted). */
  "rpc-broken",
  /** Delivering a batch into the subscriber failed (stub dead or callback threw). */
  "delivery-failed",
  /** The outbound subscription's configuration was removed. */
  "subscription-removed",
  /**
   * The stream went quiet for longer than its idle window, so the Stream DO
   * deliberately dropped every connection to let itself (and its subscribers)
   * hibernate instead of accruing billable duration on idle cross-isolate RPC
   * sessions. The durable subscription config is kept; the next append re-dials.
   */
  "idle",
]);

export type StreamSubscriberDisconnectReason = z.infer<typeof StreamSubscriberDisconnectReason>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

export const CoreProcessorContract = defineProcessorContract({
  slug: "core",
  version: "0.1.0",
  description: "Maintains the stream's own reduced state.",
  stateSchema: z.object({
    namespace: z.string().trim().min(1),
    path: z.string().trim().min(1),
    createdAt: z.string(),
    incarnationId: z.string().trim().min(1),
    metadata: z.record(z.string(), z.unknown()),
    config: z.object({
      simulatedStorageSyncDelayMs: z.number().int().min(0).default(0).nullable(),
    }),
    eventCount: z.number().int().min(0),
    maxOffset: z.number().int().min(0),
    childPaths: z.array(z.string().trim().min(1)),
    paused: z.boolean(),
    pauseReason: z.string().nullable(),
    processorsBySlug: z.record(
      z.string(),
      z.object({
        announcedAtOffset: z.number().int().min(0),
        announcement: ProcessorContractAnnouncement,
      }),
    ),
    subscriptionsByKey: z.record(
      z.string(),
      z.object({ latestConfiguredEvent: SupportedSubscriptionConfiguredEvent }),
    ),
    /**
     * Live presence roster: who is connected to this stream right now, keyed
     * by subscriptionKey — the event-sourced mirror of the runtime connection
     * map. `stream/woken` clears it (every connection died with the previous
     * stream incarnation; survivors re-dial and re-land), connected adds,
     * disconnected removes.
     */
    connectionsByKey: z.record(
      z.string(),
      z.object({
        direction: z.enum(["inbound", "outbound"]),
        connectedAtOffset: z.number().int().min(0),
        subscriber: StreamSubscriberDescriptor.optional(),
      }),
    ),
  }),
  initialState: {
    namespace: "uninitialized",
    path: "uninitialized",
    createdAt: "uninitialized",
    incarnationId: "uninitialized",
    metadata: {},
    config: {
      simulatedStorageSyncDelayMs: 0,
    },
    eventCount: 0,
    maxOffset: 0,
    childPaths: [],
    paused: false,
    pauseReason: null,
    processorsBySlug: {},
    subscriptionsByKey: {},
    connectionsByKey: {},
  },
  events: {
    "events.iterate.com/stream/created": {
      description: "Initializes the core reduced state for a stream.",
      payloadSchema: z.object({
        namespace: z.string().trim().min(1),
        path: z.string().trim().min(1),
      }),
    },
    "events.iterate.com/stream/woken": {
      description: "Records that a Durable Object incarnation has started running this stream.",
      payloadSchema: z.object({
        incarnationId: z.string().trim().min(1),
      }),
    },
    "events.iterate.com/stream/configured": {
      description: "Configures stream-level options.",
      payloadSchema: z.object({
        config: z.object({
          simulatedStorageSyncDelayMs: z.number().int().min(0),
        }),
      }),
    },
    "events.iterate.com/stream/metadata-updated": {
      description: "Replaces stream metadata kept in core reduced state.",
      payloadSchema: z.object({
        metadata: z.record(z.string(), z.unknown()),
      }),
    },
    "events.iterate.com/stream/child-stream-created": {
      description: "Records the immediate child stream segment under this stream.",
      payloadSchema: z.object({
        childPath: z.string().trim().min(1),
      }),
    },
    "events.iterate.com/stream/subscription-configured": {
      description: "Configures or replaces an outbound subscription for this stream.",
      payloadSchema: z.object({
        subscriptionKey: z.string().trim().min(1),
        subscriber: SupportedOutboundSubscriber,
      }),
    },
    "events.iterate.com/stream/subscription-removed": {
      description: "Removes a previously configured outbound subscription for this stream.",
      payloadSchema: z.object({
        subscriptionKey: z.string().trim().min(1),
      }),
    },
    "events.iterate.com/stream/subscriber-connected": {
      description:
        "A delivery connection to one subscriber opened. Appended by the stream itself, once per actual open — which is why presence facts carry no idempotency keys: a re-handshake after a transient break genuinely is a new connection and must re-land on the roster. Reconciling processors treat this as 'someone's runtime state was reset'; it is always the tail of any batch it shares (appended after the handshake fixes the replay offset), so state-at-event equals batch-final state.",
      payloadSchema: z.object({
        subscriptionKey: z.string().trim().min(1),
        direction: z.enum(["inbound", "outbound"]),
        subscriber: StreamSubscriberDescriptor.optional(),
      }),
    },
    "events.iterate.com/stream/subscriber-disconnected": {
      description:
        "A delivery connection to one subscriber closed. Appended by the stream itself, once per actual close.",
      payloadSchema: z.object({
        subscriptionKey: z.string().trim().min(1),
        reason: StreamSubscriberDisconnectReason,
      }),
    },
    "events.iterate.com/stream/error-occurred": {
      description: "Records a structured stream or processor runner error.",
      payloadSchema: z.object({
        message: z.string().trim().min(1),
        error: z
          .object({
            name: z.string().trim().min(1).optional(),
            message: z.string().trim().min(1),
            code: z.string().trim().min(1).optional(),
            stack: z.string().trim().min(1).optional(),
          })
          .optional(),
      }),
    },
    "events.iterate.com/stream/paused": {
      description: "Records that the stream is paused and should reject ordinary appends.",
      payloadSchema: z.object({
        reason: z.string().trim().min(1).optional(),
      }),
    },
    "events.iterate.com/stream/resumed": {
      description: "Records that the stream has resumed accepting ordinary appends.",
      payloadSchema: z.object({
        reason: z.string().trim().min(1).optional(),
      }),
    },
  },
  consumes: [
    "*",
    "events.iterate.com/stream/created",
    "events.iterate.com/stream/woken",
    "events.iterate.com/stream/configured",
    "events.iterate.com/stream/metadata-updated",
    "events.iterate.com/stream/child-stream-created",
    "events.iterate.com/stream/subscription-configured",
    "events.iterate.com/stream/subscription-removed",
    "events.iterate.com/stream/subscriber-connected",
    "events.iterate.com/stream/subscriber-disconnected",
    "events.iterate.com/stream/error-occurred",
    "events.iterate.com/stream/paused",
    "events.iterate.com/stream/resumed",
  ],
  emits: [
    "events.iterate.com/stream/subscriber-connected",
    "events.iterate.com/stream/subscriber-disconnected",
    "events.iterate.com/stream/child-stream-created",
  ],
});

export type CoreProcessorState = z.infer<typeof CoreProcessorContract.stateSchema>;

export type SubscriptionConfiguredEvent =
  CoreProcessorState["subscriptionsByKey"][string]["latestConfiguredEvent"];
