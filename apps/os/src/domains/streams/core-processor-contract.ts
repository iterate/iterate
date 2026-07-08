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
import type { DurableObjectAddress as DurableObjectAddressType } from "../durable-object-names.ts";
import { normalizePath } from "../durable-object-names.ts";
import { DynamicWorkerRef } from "../workers/schemas.ts";
import type { GetProcessorRuntimeState } from "./rpc-types.ts";
import { defineProcessorContract } from "./processor-contracts.ts";

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
// - 9: stream circuit breaker token bucket added.
export const CORE_STATE_VERSION = 9;

// Restored from the old built-in circuit-breaker processor. These defaults are
// intentionally high for normal browser/load tests; the breaker exists to stop
// runaway producers, not to meter ordinary stream traffic.
const DEFAULT_CIRCUIT_BREAKER_BURST_CAPACITY = 100_000;
const DEFAULT_CIRCUIT_BREAKER_REFILL_RATE_PER_MINUTE = 6_000_000;

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

/**
 * The Durable Object kinds a stream may wake as a configured subscriber. Every
 * one is addressed the same way (a validated `DurableObjectAddress`); only the
 * binding they resolve to differs, so they share one union member rather than
 * five identical ones.
 */
export const ConfiguredSubscriberDurableObjectType = z.enum([
  "agent",
  "capability-host",
  "project",
  "repo",
  "scheduler",
  "secret",
]);
export type ConfiguredSubscriberDurableObjectType = z.infer<
  typeof ConfiguredSubscriberDurableObjectType
>;

export const ConfiguredStreamSubscriber = z.union([
  z.strictObject({
    type: ConfiguredSubscriberDurableObjectType,
    address: DurableObjectAddress,
  }),
  z.strictObject({
    type: z.literal("worker"),
    workerRef: DynamicWorkerRef,
  }),
]);

export type ConfiguredStreamSubscriber = z.infer<typeof ConfiguredStreamSubscriber>;

export const StreamSubscriptionType = z.enum(["configured", "ephemeral"]);
export type StreamSubscriptionType = z.infer<typeof StreamSubscriptionType>;

// Payloads shared between the event catalog below and the reduced-state
// records that store the latest committed configuration event, so the two can
// never drift apart.
const SubscriptionConfiguredPayload = z.object({
  subscriptionKey: z.string().trim().min(1),
  subscriber: ConfiguredStreamSubscriber,
});

const RuleConfiguredPayload = z.object({
  ruleId: z.string().trim().min(1),
  type: z.literal("cross-post"),
  projectId: z.string().trim().min(1).nullable().optional(),
  path: z.string().trim().min(1),
  eventTypes: z.array(z.string().trim().min(1)).min(1),
  /**
   * Optional JSONata expression evaluated against the committed event
   * (`{ type, payload, metadata, source, offset, createdAt }`). The event is
   * cross-posted only when the expression evaluates to exactly `true` — e.g.
   * `payload.body.repository.full_name = "acme/widgets"` narrows a GitHub
   * connection stream's webhook firehose to one repository. Parse errors are
   * rejected at configure time; an expression that throws or returns non-true
   * at match time skips the event and records a stream error.
   */
  condition: z.string().trim().min(1).optional(),
});

const CircuitBreakerConfig = z.object({
  burstCapacity: z.number().int().positive(),
  refillRatePerMinute: z.number().int().positive(),
});

const StreamConfiguredPayload = z.object({
  config: z.object({
    circuitBreaker: CircuitBreakerConfig.optional(),
  }),
});

/** Durable desired-state record: the latest committed configuration event for one key. */
const latestConfiguredEvent = <const Type extends string, Payload extends z.ZodType>(
  type: Type,
  payload: Payload,
) =>
  z.object({
    latestConfiguredEvent: z.object({
      offset: z.number().int().min(0),
      type: z.literal(type),
      payload,
      createdAt: z.string(),
    }),
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
  processor: z
    .object({
      /** Serializable processor contract announcement persisted into presence facts. */
      announcement: ProcessorContractAnnouncement,
    })
    .optional(),
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
    circuitBreaker: z
      .object({
        availableTokens: z.number().default(DEFAULT_CIRCUIT_BREAKER_BURST_CAPACITY),
        lastRefillAtMs: z.number().int().nonnegative().nullable().default(null),
        burstCapacity: z.number().int().positive().default(DEFAULT_CIRCUIT_BREAKER_BURST_CAPACITY),
        refillRatePerMinute: z
          .number()
          .int()
          .positive()
          .default(DEFAULT_CIRCUIT_BREAKER_REFILL_RATE_PER_MINUTE),
        trippedAtOffset: z.number().int().positive().nullable().default(null),
      })
      .default({
        availableTokens: DEFAULT_CIRCUIT_BREAKER_BURST_CAPACITY,
        lastRefillAtMs: null,
        burstCapacity: DEFAULT_CIRCUIT_BREAKER_BURST_CAPACITY,
        refillRatePerMinute: DEFAULT_CIRCUIT_BREAKER_REFILL_RATE_PER_MINUTE,
        trippedAtOffset: null,
      }),
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
      .record(
        z.string(),
        latestConfiguredEvent(
          "events.iterate.com/stream/subscription-configured",
          SubscriptionConfiguredPayload,
        ),
      )
      .default({}),
    rulesById: z
      .record(
        z.string(),
        latestConfiguredEvent("events.iterate.com/stream/rule-configured", RuleConfiguredPayload),
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
    "events.iterate.com/stream/configured": {
      description: "Configures core stream runtime policy.",
      payloadSchema: StreamConfiguredPayload,
    },
    "events.iterate.com/stream/child-stream-created": {
      description: "Records the immediate child stream segment under this stream.",
      payloadSchema: z.object({
        childPath: z.string().trim().min(1),
      }),
    },
    "events.iterate.com/stream/subscription-configured": {
      description: "Configures or replaces a wakeable subscriber for this stream.",
      payloadSchema: SubscriptionConfiguredPayload,
    },
    "events.iterate.com/stream/subscription-removed": {
      description: "Removes a previously configured wakeable subscriber for this stream.",
      payloadSchema: z.object({
        subscriptionKey: z.string().trim().min(1),
      }),
    },
    "events.iterate.com/stream/rule-configured": {
      description: "Configures or replaces a local stream rule.",
      payloadSchema: RuleConfiguredPayload,
    },
    "events.iterate.com/stream/rule-removed": {
      description: "Removes a previously configured local stream rule.",
      payloadSchema: z.object({
        ruleId: z.string().trim().min(1),
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
    "events.iterate.com/stream/configured",
    "events.iterate.com/stream/metadata-updated",
    "events.iterate.com/stream/child-stream-created",
    "events.iterate.com/stream/subscription-configured",
    "events.iterate.com/stream/subscription-removed",
    "events.iterate.com/stream/rule-configured",
    "events.iterate.com/stream/rule-removed",
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

/**
 * The contract's type under the same identifier, so type-level helpers read
 * without `typeof`: `ProcessorState<CoreProcessorContract>`,
 * `ConsumedEvent<CoreProcessorContract>`, `ProcessorEvent<CoreProcessorContract, T>`.
 */
export type CoreProcessorContract = typeof CoreProcessorContract;

export type CoreProcessorState = z.infer<typeof CoreProcessorContract.stateSchema>;
