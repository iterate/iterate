// Defines the built-in "core" processor contract.
// This processor owns stream runtime state such as max offset, stream config,
// outbound subscription configuration, registered processors, and the
// paused/resumed door. The Stream Durable Object runs it inline during append
// instead of through a subscription runner. Token-bucket rate limiting lives in
// the circuit-breaker processor.

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

// Older subscriber shapes still present in stored events/state. They reduce
// without error but get dropped from supported runtime state, so streams with
// stale subscriptions simply stop dialing until a callable subscription is
// (re-)appended.
const HistoricalOutboundSubscriber = z.union([
  SupportedOutboundSubscriber,
  z.object({
    type: z.literal("built-in"),
    transport: z.enum(["workers-rpc", "capnweb-websocket"]),
    processorSlug: z.string().trim().min(1),
  }),
  z.object({
    type: z.literal("external-url"),
    transport: z.literal("capnweb-websocket"),
    url: z.url(),
    headers: z.record(z.string(), z.string()).optional(),
  }),
]);

export const SupportedSubscriptionConfiguredEvent = z.object({
  offset: z.number().int().min(0),
  type: z.literal("events.iterate.com/stream/subscription-configured"),
  payload: z.object({
    subscriptionKey: z.string().trim().min(1),
    subscriber: SupportedOutboundSubscriber,
  }),
  createdAt: z.string(),
});

const HistoricalSubscriptionConfiguredEvent = z.object({
  offset: z.number().int().min(0),
  type: z.literal("events.iterate.com/stream/subscription-configured"),
  payload: z.object({
    subscriptionKey: z.string().trim().min(1),
    subscriber: HistoricalOutboundSubscriber,
  }),
  createdAt: z.string(),
});

const SubscriptionsByKey = z
  .record(z.string(), z.object({ latestConfiguredEvent: HistoricalSubscriptionConfiguredEvent }))
  .transform(
    (
      subscriptions,
    ): Record<
      string,
      { latestConfiguredEvent: z.output<typeof SupportedSubscriptionConfiguredEvent> }
    > => {
      const supported: Record<
        string,
        { latestConfiguredEvent: z.output<typeof SupportedSubscriptionConfiguredEvent> }
      > = {};
      for (const [subscriptionKey, subscription] of Object.entries(subscriptions)) {
        const parsed = SupportedSubscriptionConfiguredEvent.safeParse(
          subscription.latestConfiguredEvent,
        );
        if (parsed.success) supported[subscriptionKey] = { latestConfiguredEvent: parsed.data };
      }
      return supported;
    },
  );

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
        latestRegisteredEvent: z.object({
          offset: z.number().int().min(0),
          type: z.literal("events.iterate.com/stream/processor-registered"),
          payload: z.object({
            slug: z.string().trim().min(1),
            version: z.string().trim().min(1),
            description: z.string(),
            consumes: z.array(z.string()),
            emits: z.array(z.string()),
            ownedEvents: z.array(
              z.object({
                type: z.string().trim().min(1),
                description: z.string().optional(),
                examples: z.array(z.unknown()).optional(),
              }),
            ),
          }),
          createdAt: z.string(),
        }),
      }),
    ),
    subscriptionsByKey: SubscriptionsByKey,
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
      description: "Records an immediate child stream under this stream.",
      payloadSchema: z.object({
        childPath: z.string().trim().min(1),
      }),
    },
    "events.iterate.com/stream/subscription-configured": {
      description: "Configures or replaces an outbound subscription for this stream.",
      payloadSchema: z.object({
        subscriptionKey: z.string().trim().min(1),
        subscriber: HistoricalOutboundSubscriber,
      }),
    },
    "events.iterate.com/stream/processor-registered": {
      description: "Records the public contract for a processor active on this stream.",
      payloadSchema: z.object({
        slug: z.string().trim().min(1),
        version: z.string().trim().min(1),
        description: z.string(),
        consumes: z.array(z.string()),
        emits: z.array(z.string()),
        ownedEvents: z.array(
          z.object({
            type: z.string().trim().min(1),
            description: z.string().optional(),
            examples: z.array(z.unknown()).optional(),
          }),
        ),
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
    "events.iterate.com/stream/processor-registered",
    "events.iterate.com/stream/error-occurred",
    "events.iterate.com/stream/paused",
    "events.iterate.com/stream/resumed",
  ],
  emits: [],
});

export type CoreProcessorState = z.infer<typeof CoreProcessorContract.stateSchema>;

export type SubscriptionConfiguredEvent =
  CoreProcessorState["subscriptionsByKey"][string]["latestConfiguredEvent"];

export type ProcessorRegisteredEvent =
  CoreProcessorState["processorsBySlug"][string]["latestRegisteredEvent"];
