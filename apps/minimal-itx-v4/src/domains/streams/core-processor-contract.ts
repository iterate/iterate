// Defines the built-in "core" processor contract.
// This processor owns stream runtime state such as max offset, stream config,
// configured subscriber desired state, the subscriber presence roster, and the
// paused/resumed door. The Stream Durable Object runs it inline during append
// instead of through a subscription runner. Token-bucket rate limiting lives in
// the circuit-breaker processor.
//
// Contract files are the schema/type layer: plumbing modules (types.ts, the
// processor host) import payload schemas from here, and processors that
// reconcile on presence facts list this contract in their `processorDeps`.

import { z } from "zod";
import type { GetProcessorRuntimeState } from "../../types.ts";
import type { DurableObjectAddress as DurableObjectAddressType } from "../durable-object-names.ts";
import { normalizePath } from "../durable-object-names.ts";
import { DynamicWorkerRef } from "../workers/schemas.ts";
import { defineProcessorContract } from "./stream-processor.ts";

// Version of the persisted core reduced state ("state" in KV). Bump this when
// the core reducer starts deriving NEW state from already-reduced events
// (already-committed events are never re-reduced on the incremental catch-up
// path). On wake, a stored version that differs from this constant discards
// the persisted state and rebuilds it by replaying the full event log from the
// DO's own SQLite -- the same path used when KV state is missing entirely.
//
// History:
// - 1 (implicit; no "stateVersion" key in KV): pre-descendantPaths state.
// - 2: childPaths gained a sibling descendantPaths (full announced paths).
// - 3: descendantPaths removed; callers should walk immediate childPaths.
// - 4: subscriber presence -- connectionsByKey roster added; processorsBySlug
//      reshaped to fold contract announcements from subscriber-connected
//      events instead of the removed processor-registered event.
// - 5: stream coordinate fields normalized to projectId/path.
// - 6: configured subscriber state and typed subscriber targets replaced the
//      old transport-direction subscription model.
// - 7: core's empty state is expressed directly by this schema's optional and
//      defaulted fields instead of a separate initial state object.
// - 8: cross-post stream rules are reduced into core state.
export const CORE_STATE_VERSION = 8;

/**
 * Persisted configured subscriber target. The stream resolves these narrow
 * targets itself, so subscription config cannot smuggle an arbitrary RPC method
 * or cross-project Durable Object name into the wake path.
 */
const DurableObjectAddress = z.strictObject({
  projectId: z.string().trim().min(1).nullable(),
  path: z.string().transform(normalizePath),
  props: z.record(z.string(), z.string()).default({}),
}) satisfies z.ZodType<DurableObjectAddressType, unknown>;

export const ConfiguredStreamSubscriber = z.discriminatedUnion("type", [
  z.strictObject({
    address: DurableObjectAddress,
    type: z.literal("agent"),
  }),
  z.strictObject({
    address: DurableObjectAddress,
    type: z.literal("itx"),
  }),
  z.strictObject({
    address: DurableObjectAddress,
    type: z.literal("project"),
  }),
  z.strictObject({
    address: DurableObjectAddress,
    type: z.literal("repo"),
  }),
  z.strictObject({
    address: DurableObjectAddress,
    type: z.literal("secret"),
  }),
  z.strictObject({
    type: z.literal("worker"),
    workerRef: DynamicWorkerRef,
  }),
]);

export type ConfiguredStreamSubscriber = z.infer<typeof ConfiguredStreamSubscriber>;

export const StreamSubscriptionType = z.enum(["configured", "ephemeral"]);
export type StreamSubscriptionType = z.infer<typeof StreamSubscriptionType>;

const StreamSubscriptionConfiguredEvent = z.object({
  offset: z.number().int().min(0),
  type: z.literal("events.iterate.com/stream/subscription-configured"),
  payload: z.object({
    subscriptionKey: z.string().trim().min(1),
    subscriber: ConfiguredStreamSubscriber,
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

const StreamSubscriberProcessorDescriptor = z.preprocess(
  (value) =>
    isRecord(value) && !isRecord(value.announcement) && typeof value.slug === "string"
      ? { announcement: value }
      : value,
  z.object({
    /** Serializable processor contract announcement persisted into presence facts. */
    announcement: ProcessorContractAnnouncement,
  }),
);

type StreamSubscriberProcessorDescriptor = z.infer<typeof StreamSubscriberProcessorDescriptor>;

/**
 * Identity the connecting party passes in its subscribe call. All fields are
 * optional: anonymous ephemeral watchers (a stream-viewer tab) may pass nothing,
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

/**
 * The runtime (non-serializable) view of a subscriber descriptor. Same shape as
 * the persisted `StreamSubscriberDescriptor`, but the processor entry may carry
 * a live `getRuntimeState` capability retained for the subscription lifetime. It
 * is not persisted into presence facts; the stream calls it on demand from
 * `getProcessorRuntimeState({ subscriptionKey })`.
 */
export type LiveStreamSubscriberDescriptor = Omit<StreamSubscriberDescriptor, "processor"> & {
  processor?: {
    announcement: ProcessorContractAnnouncement;
    getRuntimeState?: GetProcessorRuntimeState;
  };
};

export const StreamSubscriberDisconnectReason = z.enum([
  /** A new connection for the same subscriptionKey replaced this one. */
  "replaced",
  /** The subscriber called unsubscribe(). */
  "unsubscribed",
  /** The RPC session to the subscriber broke (subscriber crashed or was evicted). */
  "rpc-broken",
  /** Delivering a batch into the subscriber failed (stub dead or callback threw). */
  "delivery-failed",
  /** The configured subscriber's durable configuration was removed. */
  "subscription-removed",
  /**
   * The stream went quiet for longer than its idle window, so the Stream DO
   * deliberately dropped every configured connection to let itself (and its subscribers)
   * hibernate instead of accruing billable duration on idle cross-isolate RPC
   * sessions. The durable subscription config is kept; the next append re-wakes.
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
    projectId: z.string().trim().min(1).nullable().optional(),
    path: z.string().trim().min(1).optional(),
    createdAt: z.string().optional(),
    incarnationId: z.string().trim().min(1).optional(),
    metadata: z.record(z.string(), z.unknown()).default({}),
    eventCount: z.number().int().min(0).default(0),
    maxOffset: z.number().int().min(0).default(0),
    childPaths: z.array(z.string().trim().min(1)).default([]),
    paused: z.boolean().default(false),
    pauseReason: z.string().nullable().default(null),
    processorsBySlug: z
      .record(
        z.string(),
        z.object({
          announcedAtOffset: z.number().int().min(0),
          announcement: ProcessorContractAnnouncement,
        }),
      )
      .default({}),
    configuredSubscribersByKey: z
      .record(z.string(), z.object({ latestConfiguredEvent: StreamSubscriptionConfiguredEvent }))
      .default({}),
    rulesById: z
      .record(
        z.string(),
        z.object({
          latestConfiguredEvent: z.object({
            offset: z.number().int().min(0),
            type: z.literal("events.iterate.com/stream/rule-configured"),
            payload: z.object({
              ruleId: z.string().trim().min(1),
              type: z.literal("cross-post"),
              projectId: z.string().trim().min(1).nullable().optional(),
              path: z.string().trim().min(1),
              eventTypes: z.array(z.string().trim().min(1)).min(1),
            }),
            createdAt: z.string(),
          }),
        }),
      )
      .default({}),
    /**
     * Live presence roster: who is connected to this stream right now, keyed
     * by subscriptionKey — the event-sourced mirror of the runtime connection
     * map. `stream/woken` clears it (every connection died with the previous
     * stream incarnation; survivors reconnect and re-land), connected adds,
     * disconnected removes.
     */
    connectionsByKey: z
      .record(
        z.string(),
        z.object({
          subscriptionType: StreamSubscriptionType,
          connectedAtOffset: z.number().int().min(0),
          subscriber: StreamSubscriberDescriptor.optional(),
        }),
      )
      .default({}),
  }),
  events: {
    "events.iterate.com/stream/created": {
      description: "Initializes the core reduced state for a stream.",
      payloadSchema: z.object({
        projectId: z.string().trim().min(1).nullable(),
        path: z.string().trim().min(1),
      }),
    },
    "events.iterate.com/stream/woken": {
      description: "Records that a Durable Object incarnation has started running this stream.",
      payloadSchema: z.object({
        incarnationId: z.string().trim().min(1),
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
      description: "Configures or replaces a wakeable subscriber for this stream.",
      payloadSchema: z.object({
        subscriptionKey: z.string().trim().min(1),
        subscriber: ConfiguredStreamSubscriber,
      }),
    },
    "events.iterate.com/stream/subscription-removed": {
      description: "Removes a previously configured wakeable subscriber for this stream.",
      payloadSchema: z.object({
        subscriptionKey: z.string().trim().min(1),
      }),
    },
    "events.iterate.com/stream/rule-configured": {
      description: "Configures or replaces a local stream rule.",
      payloadSchema: z.object({
        ruleId: z.string().trim().min(1),
        type: z.literal("cross-post"),
        projectId: z.string().trim().min(1).nullable().optional(),
        path: z.string().trim().min(1),
        eventTypes: z.array(z.string().trim().min(1)).min(1),
      }),
    },
    "events.iterate.com/stream/subscriber-connected": {
      description:
        "A delivery connection to one subscriber opened. Appended by the stream itself, once per actual open — which is why presence facts carry no idempotency keys: a re-handshake after a transient break genuinely is a new connection and must re-land on the roster. Reconciling processors treat this as 'someone's runtime state was reset'; it is always the tail of any batch it shares (appended after the handshake fixes the replay offset), so state-at-event equals batch-final state.",
      payloadSchema: z.object({
        subscriptionKey: z.string().trim().min(1),
        subscriptionType: StreamSubscriptionType,
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
    "events.iterate.com/stream/metadata-updated",
    "events.iterate.com/stream/child-stream-created",
    "events.iterate.com/stream/subscription-configured",
    "events.iterate.com/stream/subscription-removed",
    "events.iterate.com/stream/rule-configured",
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
