// Defines the built-in "core" processor contract.
// This processor owns stream runtime state such as max offset, stream config,
// outbound subscription configuration, registered processors, and the
// paused/resumed door. The Stream Durable Object runs it inline during append
// instead of through a subscription runner. Token-bucket rate limiting lives in
// the circuit-breaker processor.

import { z } from "zod";
import { defineProcessorContract } from "../../shared/stream-processors.ts";

const BuiltInWorkersRpcSubscriber = z.object({
  type: z.literal("built-in"),
  transport: z.literal("workers-rpc"),
  processorSlug: z.string().trim().min(1),
});

const ProjectWorkerEntrypointSubscriber = z.object({
  type: z.literal("project-worker-entrypoint"),
  entrypoint: z.string().trim().min(1).default("default"),
});

const DurableObjectProcessorSubscriber = z.object({
  type: z.literal("durable-object-processor"),
  durableObject: z.string().trim().min(1),
  processor: z.string().trim().min(1),
});

const SupportedOutboundSubscriber = z.discriminatedUnion("type", [
  BuiltInWorkersRpcSubscriber,
  ProjectWorkerEntrypointSubscriber,
  DurableObjectProcessorSubscriber,
]);
// TODO: Add dynamic-worker when a worker-name/entrypoint dialer exists.
// TODO: Add webhooks only if we want non-capnweb delivery semantics.

const HistoricalOutboundSubscriber = z.union([
  SupportedOutboundSubscriber,
  z.object({
    type: z.literal("built-in"),
    transport: z.literal("capnweb-websocket"),
    processorSlug: z.string().trim().min(1),
  }),
  z.object({
    type: z.literal("external-url"),
    transport: z.literal("capnweb-websocket"),
    url: z.url(),
    headers: z.record(z.string(), z.string()).optional(),
  }),
]);

const SupportedSubscriptionConfiguredEvent = z.object({
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

export const coreProcessorContract = defineProcessorContract({
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
  reduce({ state, event }) {
    const next = {
      ...state,
      eventCount: state.eventCount + 1,
      maxOffset: event.offset,
    };

    switch (event.type) {
      case "events.iterate.com/stream/paused":
        return {
          ...next,
          paused: true,
          pauseReason: event.payload.reason ?? null,
        };

      case "events.iterate.com/stream/resumed":
        return {
          ...next,
          paused: false,
          pauseReason: null,
        };

      case "events.iterate.com/stream/created":
        if (event.offset !== 1) {
          throw new Error(
            "events.iterate.com/stream/created must be the first event and have offset 1",
          );
        }
        return {
          ...next,
          namespace: event.payload.namespace,
          path: event.payload.path,
          createdAt: event.createdAt,
        };

      case "events.iterate.com/stream/woken":
        return {
          ...next,
          incarnationId: event.payload.incarnationId,
        };

      case "events.iterate.com/stream/configured":
        return {
          ...next,
          config: {
            ...next.config,
            ...event.payload.config,
          },
        };

      case "events.iterate.com/stream/metadata-updated":
        return {
          ...next,
          metadata: event.payload.metadata,
        };

      case "events.iterate.com/stream/child-stream-created": {
        const childPath = getImmediateChildPath({
          parentPath: state.path,
          childPath: event.payload.childPath,
        });
        if (childPath === null || next.childPaths.includes(childPath)) return next;
        return {
          ...next,
          childPaths: [...next.childPaths, childPath],
        };
      }

      case "events.iterate.com/stream/subscription-configured": {
        const parsed = SupportedSubscriptionConfiguredEvent.safeParse(event);
        if (!parsed.success) {
          const { [event.payload.subscriptionKey]: _removed, ...subscriptionsByKey } =
            next.subscriptionsByKey;
          return { ...next, subscriptionsByKey };
        }
        return {
          ...next,
          subscriptionsByKey: {
            ...next.subscriptionsByKey,
            [event.payload.subscriptionKey]: { latestConfiguredEvent: parsed.data },
          },
        };
      }

      case "events.iterate.com/stream/processor-registered":
        return {
          ...next,
          processorsBySlug: {
            ...next.processorsBySlug,
            [event.payload.slug]: { latestRegisteredEvent: event },
          },
        };

      default:
        return next;
    }
  },
});

export type CoreProcessorState = z.infer<typeof coreProcessorContract.stateSchema>;

export type SubscriptionConfiguredEvent =
  CoreProcessorState["subscriptionsByKey"][string]["latestConfiguredEvent"];

export type ProcessorRegisteredEvent =
  CoreProcessorState["processorsBySlug"][string]["latestRegisteredEvent"];

function getImmediateChildPath(args: { parentPath: string; childPath: string }): string | null {
  if (args.childPath === args.parentPath) return null;
  if (args.parentPath === "/") {
    const [firstSegment] = args.childPath.split("/").filter(Boolean);
    return firstSegment === undefined ? null : `/${firstSegment}`;
  }

  const parentPrefix = `${args.parentPath}/`;
  if (!args.childPath.startsWith(parentPrefix)) return null;
  const [firstSegment] = args.childPath.slice(parentPrefix.length).split("/").filter(Boolean);
  return firstSegment === undefined ? null : `${args.parentPath}/${firstSegment}`;
}
