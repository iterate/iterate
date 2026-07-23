// Defines the built-in "core" processor contract.
// This processor owns stream durable state such as max offset, stream config,
// configured subscriptions, and whether appends are paused. Live
// connection presence belongs exclusively to runtime state. The Stream
// Durable Object runs it inline during append instead of through the normal
// event-batch runner. The same reducer also maintains the stream's token-bucket
// circuit-breaker state.
//
// Contract files are the schema/type layer: types.ts and the processor host
// import payload schemas from here, and processors that
// react to presence events list this contract in their `processorDeps`.

import { z } from "zod";
import {
  defineProcessorContract,
  ProcessorContractAnnouncement,
  type SubscriptionConfigurationForDelivery,
  type StreamEvent,
  StreamEvent as StreamEventSchema,
  STREAM_PROCESSOR_REVIVED_EVENT_TYPE,
} from "iterate/processors";
import { ItxExpression } from "../../itx/expression.ts";
import { canonicalizeStreamPath } from "../durable-object-names.ts";
import { EventFilter } from "./event-filter.ts";

// Version of the persisted core reduced state ("state" in KV). Bump this when
// the core reducer starts deriving NEW state from already-reduced events
// (already-committed events are never re-reduced on the incremental catch-up
// path). On wake, a stored version that differs from this constant discards
// the persisted state and rebuilds it by replaying the full event log from the
// DO's own SQLite -- the same path used when KV state is missing entirely.
// Version 22 establishes the current vocabulary: subscriptions are stored
// instructions, connections are live callbacks, deliveries are attempted
// batches or HTTP calls, and checkpoints/cursors record completed work.
// Version 24 makes each receiving stream's cross-post-list status a durable,
// replayable state machine instead of inferring a blocked list from a
// per-subscription halt or the SQLite retry scheduler.
// Version 25 records a random stream-lifetime identity. Creation time still
// orders destructive recreations, while the random ID prevents two lifetimes
// created in the same millisecond from sharing delivery-deduplication keys.
// Version 26 stores optional automatic-removal conditions directly on a
// subscription instead of beneath a redundant always-durable lifetime wrapper.
// Version 27 gives subscriptions one hierarchy: inbound subscriptions are
// grouped by source path and outbound subscriptions are keyed by their
// source-local key. Complete cross-post-list delivery work is separate because
// an empty list is still work the source must deliver.
export const CORE_STATE_VERSION = 27;

// Restored from the old built-in circuit-breaker processor. These defaults are
// intentionally high for normal browser/load tests; the breaker exists to stop
// runaway producers, not to meter ordinary stream traffic.
const DEFAULT_CIRCUIT_BREAKER_BURST_CAPACITY = 100_000;
const DEFAULT_CIRCUIT_BREAKER_REFILL_RATE_PER_MINUTE = 6_000_000;

/**
 * A delivery-addressing expression: an {@link ItxExpression} whose FINAL step
 * is a property step naming the method the stream will invoke. The call builder turns
 * that final item into a call step (`[..., [methodName, payload]]`), so
 * the invocation happens receiver-bound on the remote side — reading the
 * method as a property and applying it locally detaches it from `this` across
 * a real RPC hop. Enforced here so an invalid final item is rejected before the
 * config event commits, not discovered as a delivery failure forever after.
 */
const DeliveryExpression = ItxExpression.refine(
  (expression) => typeof expression.at(-1) === "string",
  { message: "delivery expression must end in a property step naming the method to invoke" },
);

/** The canonical URL-path identity persisted in stream subscription events. */
const StreamPath = z.string().trim().min(1).transform(canonicalizeStreamPath);

export const StreamConnectionKind = z.enum(["session", "hosted"]);
/** Who owns a live event-batch callback: the current session or a hosted processor. */
export type StreamConnectionKind = z.infer<typeof StreamConnectionKind>;

/** Where a cross-post, ITX-call, or webhook subscription starts reading the source stream. */
export const SubscriptionStart = z.union([
  z.literal("beginning"),
  z.literal("now"),
  z.strictObject({ afterOffset: z.number().int().nonnegative() }),
]);

export type SubscriptionStart = z.infer<typeof SubscriptionStart>;

/**
 * What a cross-post, ITX-call, or webhook subscription does when one specific batch keeps failing
 * while the receiver is otherwise alive: `halt` (default) stops delivery and
 * appends a `subscription-delivery-halted` event — ordered receivers like stream
 * must never skip (a skip is a silent gap in the target stream); `skip`
 * bisects the batch to isolate the failing event (webhook batches are already
 * single events), records an idempotent `error-occurred`, and steps over it —
 * right for feeds where one bad event must not silence everything after it
 * (the project worker feed).
 */
const OnFailingEventPolicy = z.enum(["halt", "skip"]);

/** Event sending halts only when delivering matching events exhausts its retry budget. */
const SubscriptionHaltReason = z.literal("delivery-failed");

/** Policy that exists only when the source owns an awaited delivery cursor. */
const DeliveryPolicy = z.strictObject({
  start: SubscriptionStart,
  onFailingEvent: OnFailingEventPolicy,
  includeEphemeral: z.boolean(),
});

/** Ordered stream copies may retry or halt, but can never skip a missing event. */
const StreamReceiverDeliveryPolicy = DeliveryPolicy.extend({
  onFailingEvent: z.literal("halt"),
});

/** A durable subscription ends when the first configured condition becomes true. */
export const SubscriptionEndCondition = z.strictObject({
  any: z
    .array(
      z.discriminatedUnion("kind", [
        z.strictObject({
          kind: z.literal("acknowledged-events"),
          count: z.number().int().positive(),
        }),
        z.strictObject({
          kind: z.literal("source-offset-acknowledged"),
          offset: z.number().int().nonnegative(),
        }),
        z.strictObject({
          kind: z.literal("time"),
          at: z.iso.datetime({ offset: true }),
        }),
      ]),
    )
    .min(1),
});

/** One or more source-observed completion conditions; the first match removes the subscription. */
export type SubscriptionEndCondition = z.infer<typeof SubscriptionEndCondition>;

/**
 * What one subscription does with matching source events. The action makes
 * invalid combinations unrepresentable: processor wake-ups own their
 * checkpoint; the other actions store their cursor and delivery policy on the source. A
 * cross-post names the receiving stream directly instead of hiding it inside
 * an ITX expression.
 */
export const SubscriptionReceiver = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("processor-wake"),
    expression: DeliveryExpression,
    processorSlug: z.string().trim().min(1).optional(),
  }),
  z.strictObject({
    action: z.literal("cross-post"),
    receivingStreamPath: StreamPath,
    transform: z.string().trim().min(1).optional(),
    delivery: StreamReceiverDeliveryPolicy,
  }),
  z.strictObject({
    action: z.literal("itx-call"),
    expression: DeliveryExpression,
    delivery: DeliveryPolicy,
  }),
  z.strictObject({
    action: z.literal("webhook-post"),
    url: z.url({ protocol: /^https?$/ }),
    delivery: DeliveryPolicy,
  }),
]);

export type SubscriptionReceiver = z.infer<typeof SubscriptionReceiver>;

const SubscriptionKey = z.string().trim().min(1);

export const SubscriptionConfiguredPayload = z
  .strictObject({
    /**
     * A caller-selected source-local identity. Omitting it creates a new
     * subscription whose effective key is derived from this event's committed
     * offset (`subscription:<offset>`).
     */
    subscriptionKey: SubscriptionKey.optional(),
    description: z.string().trim().min(1).optional(),
    filter: EventFilter.optional(),
    endWhen: SubscriptionEndCondition.optional(),
    receiver: SubscriptionReceiver,
  })
  .superRefine((payload, context) => {
    if (payload.receiver.action !== "processor-wake") return;
    for (const [index, condition] of (payload.endWhen?.any ?? []).entries()) {
      if (condition.kind === "time") continue;
      context.addIssue({
        code: "custom",
        path: ["endWhen", "any", index],
        message:
          "hosted processors own their checkpoint; only time can end them from the source stream",
      });
    }
  }) satisfies z.ZodType<SubscriptionConfigurationForDelivery["payload"]>;

export type SubscriptionConfiguredPayload = z.infer<typeof SubscriptionConfiguredPayload>;

type AssertTrue<Value extends true> = Value;
type MutuallyAssignable<Left, Right> = [Left] extends [Right]
  ? [Right] extends [Left]
    ? true
    : false
  : false;

/**
 * Compile-time proof that the app's validating schema and the delivery
 * envelope's shared payload type have exactly the same fields in both
 * directions.
 */
export type SubscriptionConfiguredDeliveryPayloadContractMatches = AssertTrue<
  MutuallyAssignable<
    z.output<typeof SubscriptionConfiguredPayload>,
    SubscriptionConfigurationForDelivery["payload"]
  >
>;

/** Reduced outbound configuration always contains the effective key. */
const EffectiveSubscriptionConfiguration = SubscriptionConfiguredPayload.safeExtend({
  subscriptionKey: SubscriptionKey,
});

const StreamCoordinate = z.strictObject({
  projectId: z.string().trim().min(1).nullable(),
  path: StreamPath,
  /** Random identity assigned when this source stream's storage was created. */
  streamId: z.uuid(),
  /** Creation time of the source stream; orders lifetimes whose offsets restart. */
  streamCreatedAt: z.iso.datetime({ offset: true }),
});

/** Hard bounds on what one receiving stream records from source streams. */
export const MAX_SOURCE_STREAMS_PER_RECEIVING_STREAM = 1_000;
export const MAX_SUBSCRIPTIONS_PER_RECEIVING_STREAM = 64;

/** The fields a receiving stream needs to explain and validate one source subscription. */
const RecordedSubscriptionConfiguration = z.strictObject({
  description: z.string().trim().min(1).optional(),
  filter: EventFilter.optional(),
  endWhen: SubscriptionEndCondition.optional(),
  delivery: StreamReceiverDeliveryPolicy,
  transform: z.string().trim().min(1).optional(),
});

/**
 * The complete current list of subscriptions one receiving stream records from
 * one source stream. A missing key removes that subscription; `sourceOffset` prevents
 * a delayed older call from replacing a newer list.
 */
export const CrossPostListRecordedPayload = z
  .strictObject({
    source: StreamCoordinate,
    sourceOffset: z.number().int().positive(),
    subscriptionsByKey: z.record(
      z.string().trim().min(1),
      z.strictObject({
        configuration: RecordedSubscriptionConfiguration,
        /** Offset of this key's own source-side configure event. */
        configuredAtSourceOffset: z.number().int().positive(),
      }),
    ),
  })
  .superRefine((payload, context) => {
    const count = Object.keys(payload.subscriptionsByKey).length;
    if (count > MAX_SUBSCRIPTIONS_PER_RECEIVING_STREAM) {
      context.addIssue({
        code: "custom",
        path: ["subscriptionsByKey"],
        message: `a source may cross-post through at most ${MAX_SUBSCRIPTIONS_PER_RECEIVING_STREAM} subscriptions to one receiving stream (received ${count})`,
      });
    }
  });

export type CrossPostListRecordedPayload = z.infer<typeof CrossPostListRecordedPayload>;

/** The exact committed receiver event embedded in the source's confirmation. */
const CrossPostListRecordedEvent = StreamEventSchema.extend({
  type: z.literal("events.iterate.com/stream/cross-post-list-recorded"),
  payload: CrossPostListRecordedPayload,
});

/** The exact subset of a source subscription that a receiving stream records. */
export function recordedSubscriptionForCrossPost(
  configuration: SubscriptionConfiguredPayload,
): CrossPostListRecordedPayload["subscriptionsByKey"][string]["configuration"] {
  if (configuration.receiver.action !== "cross-post") {
    throw new Error("only a cross-post action has a receiving-stream subscription record");
  }
  return {
    delivery: configuration.receiver.delivery,
    ...(configuration.endWhen === undefined ? {} : { endWhen: configuration.endWhen }),
    ...(configuration.description === undefined ? {} : { description: configuration.description }),
    ...(configuration.filter === undefined ? {} : { filter: configuration.filter }),
    ...(configuration.receiver.transform === undefined
      ? {}
      : { transform: configuration.receiver.transform }),
  };
}

/** The effective source-local key for one committed configuration event. */
export function subscriptionKeyForConfiguredEvent(event: {
  offset: number;
  payload: Pick<SubscriptionConfiguredPayload, "subscriptionKey">;
}): string {
  return event.payload.subscriptionKey ?? `subscription:${event.offset}`;
}

/**
 * Reconstruct the payload that was committed in a subscription-configured
 * event from reduced outbound state. Generated keys exist only in reduced
 * state: the original event omitted the key and derives it from its offset.
 *
 * Fresh callers cannot claim the `subscription:` namespace, and a later
 * replacement necessarily has a later offset, so equality with this event's
 * generated key is unambiguous.
 */
export function subscriptionConfiguredPayloadFromReducedState(args: {
  configuration: z.infer<typeof EffectiveSubscriptionConfiguration>;
  configuredAtOffset: number;
}): SubscriptionConfiguredPayload {
  if (
    args.configuration.subscriptionKey !==
    subscriptionKeyForConfiguredEvent({
      offset: args.configuredAtOffset,
      payload: {},
    })
  ) {
    return args.configuration;
  }

  const { subscriptionKey: _generatedKey, ...committedPayload } = args.configuration;
  return committedPayload;
}

const CircuitBreakerConfig = z.object({
  burstCapacity: z.number().int().positive(),
  refillRatePerMinute: z.number().int().positive(),
});

const StreamConfiguredPayload = z.object({
  config: z.object({
    circuitBreaker: CircuitBreakerConfig.optional(),
  }),
});

const SubscriptionRemovalReason = z.enum(["requested", "completed", "expired"]);

/**
 * Identity the caller passes when it opens a connection. All fields are
 * optional: anonymous session watchers (a stream-viewer tab) may pass nothing,
 * processor hosts pass their incarnation id plus a processor announcement.
 */
export const ConnectionOpenerDescriptor = z.object({
  /** Human-readable label, e.g. "browser" or "orpc-bridge". */
  description: z.string().optional(),
  /**
   * Self-reported display identity for an authenticated human client. This is
   * presence metadata, not authorization input; authority remains on the RPC
   * session that opened the subscription.
   */
  user: z
    .object({
      id: z.string().trim().min(1).optional(),
      email: z.string().trim().min(1),
      name: z.string().trim().min(1).optional(),
      picture: z.string().trim().min(1).optional(),
    })
    .optional(),
  /** Present when the subscriber is a stream processor. */
  processor: z
    .object({
      /** Serializable processor contract announcement persisted into presence events. */
      announcement: ProcessorContractAnnouncement,
    })
    .optional(),
});

/** Serializable identity of the caller that opened a connection. */
export type ConnectionOpenerDescriptor = z.infer<typeof ConnectionOpenerDescriptor>;

export const ConnectionCloseReason = z.enum([
  /** A new connection for the same connectionKey replaced this one. */
  "replaced",
  /** The owner closed the connection. */
  "closed-by-owner",
  /** The RPC session to the caller broke (it crashed or was evicted). */
  "rpc-broken",
  /** Calling processEventBatch failed (stub dead or callback threw). */
  "delivery-failed",
  /** The hosted processor's subscription was removed. */
  "subscription-removed",
  /**
   * The stream went quiet for longer than its idle window, so the Stream DO
   * deliberately dropped every hosted connection so both sides can
   * hibernate instead of accruing billable duration on idle cross-isolate RPC
   * sessions. The subscription is kept; the next append wakes the processor again.
   */
  "idle",
]);

export type ConnectionCloseReason = z.infer<typeof ConnectionCloseReason>;

export const CoreProcessorContract = defineProcessorContract({
  slug: "core",
  version: "0.1.0",
  description: "Maintains the stream's own reduced state.",
  stateSchema: z.object({
    projectId: z.string().trim().min(1).nullable().optional(),
    path: z.string().trim().min(1).optional(),
    streamId: z.uuid().optional(),
    createdAt: z.string().optional(),
    incarnationId: z.string().trim().min(1).optional(),
    /**
     * Events folded so far — durable AND ephemeral (both reduce). A rebuild
     * after ephemeral-row eviction counts only survivors, so this may
     * DECREASE across a rebuild; never compare it to `maxOffset`. Its one
     * load-bearing read is the constructor's `=== 0` birth check, which is
     * eviction-proof (`stream/created` can never be ephemeral).
     */
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
    subscriptions: z
      .object({
        /** Subscriptions on source streams that cross-post into this stream. */
        inbound: z
          .object({
            bySourcePath: z
              .record(
                z.string(),
                z.object({
                  source: StreamCoordinate,
                  /** Source event offset that produced this complete list. */
                  sourceOffset: z.number().int().positive(),
                  byKey: z.record(
                    z.string(),
                    z.object({
                      configuration: RecordedSubscriptionConfiguration,
                      configuredAtSourceOffset: z.number().int().positive(),
                      numEventsReceived: z.number().int().nonnegative(),
                      numEventsDropped: z.number().int().nonnegative(),
                      lastEventReceivedAt: z.string().optional(),
                    }),
                  ),
                }),
              )
              .default({}),
          })
          .default({ bySourcePath: {} }),
        /** Subscriptions configured on this source stream. */
        outbound: z
          .object({
            byKey: z
              .record(
                z.string(),
                z.object({
                  configuration: EffectiveSubscriptionConfiguration,
                  configuredAtOffset: z.number().int().positive(),
                  configuredAt: z.string(),
                  /**
                   * Present when the first configuration omitted its key. It
                   * lets the returned generated key name later replacements
                   * while fresh callers remain unable to claim that namespace.
                   */
                  subscriptionKeyWasGenerated: z.literal(true).optional(),
                  /**
                   * Latest explicit source read position. Delivery applies this
                   * level-triggered to its SQLite cursor row, so a post-commit
                   * interruption cannot lose an audited seek.
                   */
                  cursorSet: z
                    .strictObject({
                      afterOffset: z.number().int().nonnegative(),
                      setAtSourceOffset: z.number().int().positive(),
                    })
                    .optional(),
                  deliveryHalted: z
                    .strictObject({
                      reason: SubscriptionHaltReason,
                      /** Source-owned delivery cursor when this subscription stopped. */
                      afterOffset: z.number().int().nonnegative(),
                      attempts: z.number().int().positive(),
                      error: z.string().trim().min(1).optional(),
                    })
                    .optional(),
                }),
              )
              .default({}),
          })
          .default({ byKey: {} }),
      })
      .default({
        inbound: { bySourcePath: {} },
        outbound: { byKey: {} },
      }),
    /**
     * Delivery status for this source's complete cross-post list per receiving
     * stream. This is work tracking, not a second subscription collection:
     * sending an empty list is how the source removes its final cross-post.
     */
    crossPostListDeliveriesByReceivingStream: z
      .record(
        z.string(),
        z.discriminatedUnion("status", [
          z.strictObject({
            sourceOffset: z.number().int().positive(),
            status: z.literal("pending"),
            /** Keys in the last complete list this receiver confirmed. */
            subscriptionKeysRecordedByReceiver: z.array(z.string().trim().min(1)),
          }),
          z.strictObject({
            sourceOffset: z.number().int().positive(),
            status: z.literal("confirmed"),
            subscriptionKeysRecordedByReceiver: z.array(z.string().trim().min(1)),
          }),
          z.strictObject({
            sourceOffset: z.number().int().positive(),
            status: z.literal("blocked"),
            attempts: z.number().int().positive(),
            error: z.string().trim().min(1),
            blockedAt: z.iso.datetime({ offset: true }),
            subscriptionKeysRecordedByReceiver: z.array(z.string().trim().min(1)),
          }),
        ]),
      )
      .default({}),
  }),
  events: {
    "events.iterate.com/stream/created": {
      description: "Initializes the core reduced state for a stream.",
      payloadSchema: z.object({
        projectId: z.string().trim().min(1).nullable(),
        path: z.string().trim().min(1),
        streamId: z.uuid(),
      }),
    },
    "events.iterate.com/stream/woken": {
      description: "Records that a Durable Object incarnation has started running this stream.",
      payloadSchema: z.object({
        incarnationId: z.string().trim().min(1),
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
      description:
        "Configures or replaces one durable subscription for sending this stream's events to a receiver. This is the sole event that enables delivery.",
      payloadSchema: SubscriptionConfiguredPayload,
      examples: [
        {
          description:
            "A hosted agent processor owns its checkpoint and is woken by calling its durable ITX method.",
          payload: {
            subscriptionKey: "prj_01jzp3v9qkfxeb2m4n8r7wd5ha.iterate/agents/onboarding#agent",
            receiver: {
              action: "processor-wake",
              expression: [
                "agents",
                ["get", "/agents/onboarding"],
                "processor",
                "wakeStreamProcessor",
              ],
              processorSlug: "agent",
            },
          },
        },
        {
          description:
            "A cross-post copies one repository's GitHub webhooks from a connection stream, starting with new events from now on.",
          payload: {
            subscriptionKey: "github-repo:/repos/root",
            description:
              "Delivers GitHub webhooks for acme/widgets to this repo's stream so the repo processor can react to them.",
            filter: {
              eventTypes: ["events.iterate.com/github/webhook-received"],
              condition: 'payload.body.repository.full_name = "acme/widgets"',
            },
            receiver: {
              action: "cross-post",
              receivingStreamPath: "/repos/root",
              delivery: {
                start: "now",
                onFailingEvent: "halt",
                includeEphemeral: false,
              },
            },
          },
        },
        {
          description:
            "An ITX call sends matching task events to a project worker method and stores the completed offset on this source stream.",
          payload: {
            subscriptionKey: "tasks-for-project-worker",
            filter: { eventTypes: ["events.example/task-created"] },
            receiver: {
              action: "itx-call",
              expression: ["worker", "processEventBatch"],
              delivery: {
                start: "beginning",
                onFailingEvent: "halt",
                includeEphemeral: false,
              },
            },
          },
        },
        {
          description:
            "Webhook delivery: one HTTP POST per event to an external receiver, stepping over a repeatedly failing event instead of halting all later sends.",
          payload: {
            subscriptionKey: "ops-webhook",
            receiver: {
              action: "webhook-post",
              url: "https://hooks.example.com/iterate/stream-events",
              delivery: {
                start: "now",
                onFailingEvent: "skip",
                includeEphemeral: false,
              },
            },
          },
        },
      ],
    },
    "events.iterate.com/stream/cross-post-list-recorded": {
      description:
        "Records the complete current list of subscriptions from one source stream, replacing the previous list from that source. Platform-authored; the source still sends matching source events.",
      payloadSchema: CrossPostListRecordedPayload,
      examples: [
        {
          description:
            "The receiving repository stream records the complete current set copied by its integration source.",
          payload: {
            source: {
              projectId: "prj_01jzp3v9qkfxeb2m4n8r7wd5ha",
              path: "/integrations/github/acme",
              streamId: "019bffd8-2550-7a42-8b8f-90e71d19bcbc",
              streamCreatedAt: "2026-07-21T11:59:00.000Z",
            },
            sourceOffset: 42,
            subscriptionsByKey: {
              "github-repo:/repos/root": {
                configuredAtSourceOffset: 42,
                configuration: {
                  description: "Copies matching GitHub webhooks onto the repository stream.",
                  filter: { eventTypes: ["events.iterate.com/github/webhook-received"] },
                  delivery: {
                    start: "now",
                    onFailingEvent: "halt",
                    includeEphemeral: false,
                  },
                },
              },
            },
          },
        },
      ],
    },
    "events.iterate.com/stream/subscription-removed": {
      description:
        "Removes one durable subscription. If its receiver is a stream, the source sends that stream a replacement set without this key.",
      payloadSchema: z.strictObject({
        subscriptionKey: z.string().trim().min(1),
        reason: SubscriptionRemovalReason,
      }),
      examples: [
        {
          description: "An agent explicitly stops receiving repository events.",
          payload: { subscriptionKey: "github-repo:/repos/root", reason: "requested" },
        },
      ],
    },
    "events.iterate.com/stream/cross-post-list-confirmed": {
      description:
        "Records on the source that one receiving stream durably stored its latest cross-post list.",
      payloadSchema: z.strictObject({
        receivingStreamPath: StreamPath,
        sourceOffset: z.number().int().positive(),
        receivingStreamEvent: CrossPostListRecordedEvent,
      }),
      examples: [
        {
          description:
            "The source records that its latest complete set is visible on the receiving stream.",
          payload: {
            receivingStreamPath: "/repos/root",
            sourceOffset: 42,
            receivingStreamEvent: {
              type: "events.iterate.com/stream/cross-post-list-recorded",
              payload: {
                source: {
                  projectId: "prj_01jzp3v9qkfxeb2m4n8r7wd5ha",
                  path: "/integrations/github/acme",
                  streamId: "019bffd8-2550-7a42-8b8f-90e71d19bcbc",
                  streamCreatedAt: "2026-07-21T11:59:00.000Z",
                },
                sourceOffset: 42,
                subscriptionsByKey: {},
              },
              offset: 8,
              createdAt: "2026-07-21T12:00:00.000Z",
              path: "/repos/root",
            },
          },
        },
      ],
    },
    "events.iterate.com/stream/cross-post-list-delivery-blocked": {
      description:
        "Records that one receiving stream did not durably store this source's current cross-post list within the bounded retry budget.",
      payloadSchema: z.strictObject({
        receivingStreamPath: StreamPath,
        sourceOffset: z.number().int().positive(),
        attempts: z.number().int().positive(),
        error: z.string().trim().min(1).max(4_096),
      }),
      examples: [
        {
          description:
            "The receiving stream stayed unavailable through the bounded cross-post-list retry ladder.",
          payload: {
            receivingStreamPath: "/repos/root",
            sourceOffset: 42,
            attempts: 8,
            error: 'sending subscriptions to "/repos/root" failed: receiver unavailable',
          },
        },
      ],
    },
    "events.iterate.com/stream/cross-post-list-resend-requested": {
      description:
        "Audits an operator-requested retry after a receiving stream failed to record its latest cross-post list. The matching-event read position is unchanged.",
      payloadSchema: z.strictObject({
        receivingStreamPath: StreamPath,
      }),
      examples: [
        {
          description: "Retries sending the current list after its receiving stream recovered.",
          payload: { receivingStreamPath: "/repos/root" },
        },
      ],
    },
    "events.iterate.com/stream/cross-posted-events-dropped": {
      description:
        "Records source events that a receiving stream deliberately did not append because their stream-copy path contains this stream or reached the supported length.",
      payloadSchema: z.strictObject({
        source: StreamCoordinate,
        subscriptionKey: z.string().trim().min(1),
        reason: z.enum(["cycle", "hop-limit"]),
        count: z.number().int().positive(),
        firstOffset: z.number().int().nonnegative(),
        lastOffset: z.number().int().nonnegative(),
      }),
      examples: [
        {
          description: "A reciprocal stream link dropped an event instead of echoing it forever.",
          payload: {
            source: {
              projectId: "prj_01jzp3v9qkfxeb2m4n8r7wd5ha",
              path: "/agents/a",
              streamId: "019bffd8-2550-7a42-8b8f-90e71d19bcbc",
              streamCreatedAt: "2026-07-21T11:59:00.000Z",
            },
            subscriptionKey: "a-to-b",
            reason: "cycle",
            count: 1,
            firstOffset: 23,
            lastOffset: 23,
          },
        },
        {
          description:
            "A long acyclic stream-copy path reached its finite provenance bound and was acknowledged as dropped rather than retried.",
          payload: {
            source: {
              projectId: "prj_01jzp3v9qkfxeb2m4n8r7wd5ha",
              path: "/pipeline/stage-32",
              streamId: "019bffd8-2550-7a42-8b8f-90e71d19bcbc",
              streamCreatedAt: "2026-07-21T11:59:00.000Z",
            },
            subscriptionKey: "stage-32-to-33",
            reason: "hop-limit",
            count: 1,
            firstOffset: 81,
            lastOffset: 81,
          },
        },
      ],
    },
    "events.iterate.com/stream/subscription-delivery-halted": {
      description:
        "One subscription stopped after delivering matching source events exhausted the bounded retry count.",
      payloadSchema: z.strictObject({
        subscriptionKey: z.string().trim().min(1),
        reason: SubscriptionHaltReason,
        /** The cursor at halt time: delivery stopped without acking past this offset. */
        afterOffset: z.number().int().min(0),
        attempts: z.number().int().positive(),
        error: z.string().trim().min(1).max(4_096).optional(),
      }),
      examples: [
        {
          description:
            "A webhook receiver stayed down through the whole retry ladder, so delivery gave up loudly.",
          payload: {
            subscriptionKey: "ops-webhook",
            reason: "delivery-failed",
            afterOffset: 1874,
            attempts: 15,
            error:
              "webhook POST https://hooks.example.com/iterate/stream-events failed with status 503",
          },
        },
      ],
    },
    "events.iterate.com/stream/subscription-delivery-resumed": {
      description: "Resumes one halted subscription at its existing cursor.",
      payloadSchema: z.strictObject({
        subscriptionKey: z.string().trim().min(1),
      }),
      examples: [
        {
          description:
            "Resumes a subscription after the receiver recovered; delivery continues from the cursor where it halted.",
          payload: { subscriptionKey: "ops-webhook" },
        },
      ],
    },
    "events.iterate.com/stream/subscription-cursor-set": {
      description:
        "Changes the next source offset read by one cross-post, ITX-call, or webhook subscription (exclusive afterOffset semantics). It rejects offsets beyond the current stream head. A receiver call already in progress may still finish, but cannot advance this new position. Hosted processors reject this event because the processor stores its own checkpoint.",
      payloadSchema: z.strictObject({
        subscriptionKey: z.string().trim().min(1),
        afterOffset: z.number().int().min(0),
      }),
      examples: [
        {
          description:
            "Replays the stream's full history into the project worker feed (afterOffset is exclusive; 0 replays everything).",
          payload: { subscriptionKey: "project-worker", afterOffset: 0 },
        },
        {
          description:
            "Makes future cross-post sends read after offset 512; a receiver call already in progress may still finish.",
          payload: { subscriptionKey: "github-repo:/repos/root", afterOffset: 512 },
        },
      ],
    },
    "events.iterate.com/stream/connection-opened": {
      description:
        "A live connection from this stream to a processEventBatch callback opened. Appended by the stream itself once per actual open; reconnecting after a transient break is a new connection.",
      payloadSchema: z.object({
        connectionKey: z.string().trim().min(1),
        kind: StreamConnectionKind,
        openedBy: ConnectionOpenerDescriptor.optional(),
      }),
      examples: [
        {
          description:
            "A durable hosted processor was woken, returned its callback, and announced its contract (consumes/emits abridged).",
          payload: {
            connectionKey: "prj_01jzp3v9qkfxeb2m4n8r7wd5ha.iterate/agents/onboarding#agent",
            kind: "hosted",
            openedBy: {
              processor: {
                announcement: {
                  slug: "agent",
                  version: "5.0.0",
                  description:
                    "Maintains model-visible history, schedules debounced offset-identified LLM turns, and executes scripts through the capability host.",
                  consumes: [
                    "events.iterate.com/agents/context-added",
                    "events.iterate.com/agent/llm-request-settled",
                  ],
                  emits: [
                    "events.iterate.com/agents/context-added",
                    "events.iterate.com/agent/llm-request-requested",
                  ],
                  ownedEvents: [
                    {
                      type: "events.iterate.com/agents/context-added",
                      description: "A model-visible context item was added.",
                    },
                    { type: "events.iterate.com/agent/llm-request-requested" },
                  ],
                },
              },
            },
          },
        },
        {
          description:
            "An anonymous session connection: a browser stream-viewer tab receiving newly appended events.",
          payload: {
            connectionKey: "d4f8a1b2-6c3e-4e9a-8b57-0f1c2d3e4a5b",
            kind: "session",
            openedBy: { description: "browser" },
          },
        },
      ],
    },
    "events.iterate.com/stream/connection-closed": {
      description:
        "Observes that a live connection from this stream to a processEventBatch callback closed. Abrupt Durable Object teardown can end an in-memory connection without leaving this best-effort close fact; runtime connection state is authoritative for what is open now.",
      payloadSchema: z.object({
        connectionKey: z.string().trim().min(1),
        reason: ConnectionCloseReason,
        /** Present when the connection closed because an operation failed. */
        error: z.string().trim().min(1).optional(),
      }),
      examples: [
        {
          description: "A stream-viewer tab closed its session connection.",
          payload: {
            connectionKey: "d4f8a1b2-6c3e-4e9a-8b57-0f1c2d3e4a5b",
            reason: "closed-by-owner",
          },
        },
        {
          description:
            "The stream went quiet past its idle window and dropped its configured connections so everyone can hibernate; the durable config is kept and the next append re-wakes.",
          payload: {
            connectionKey: "prj_01jzp3v9qkfxeb2m4n8r7wd5ha.iterate/agents/onboarding#agent",
            reason: "idle",
          },
        },
      ],
    },
    [STREAM_PROCESSOR_REVIVED_EVENT_TYPE]: {
      description:
        "A recovery-wired stream processor was revived after its incarnation died owing background work (in-flight obligations lost to an eviction). Appended by the platform's recovery keepalive, never emitted by a processor; the payload's processorSlug names which processor was revived (the type string is shared by every recovery-wired processor). Consumption is optional and only needed when the processor reacts to the fact itself; an unconsumed tail still receives the runner's eventless at-head turn so open obligations are not stranded.",
      // Loose ON PURPOSE: the payload is authored by the shared recovery
      // durable recovery adapter, and future fields it
      // grows must not turn historical revivals into parse failures.
      payloadSchema: z.looseObject({
        processorSlug: z.string(),
        revivals: z.number(),
        version: z.string(),
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
      examples: [
        {
          description:
            'The stream stepped over a confirmed failing event on an onFailingEvent: "skip" subscription.',
          payload: {
            message:
              'subscription "project-worker" skipped failing event at offset 812 after 3 attempts: receiver rejected payload',
          },
        },
        {
          description:
            "A processor skipped an event that fails its contract's schema, with the structured cause attached.",
          payload: {
            message:
              'stream processor "agent" skipped event at offset 42 ("events.iterate.com/agents/context-added"): it fails the contract\'s schema',
            error: {
              name: "ZodError",
              message: 'Invalid input: expected string, received number at "content"',
            },
          },
        },
      ],
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
    "events.iterate.com/stream/child-stream-created",
    "events.iterate.com/stream/subscription-configured",
    "events.iterate.com/stream/cross-post-list-recorded",
    "events.iterate.com/stream/subscription-removed",
    "events.iterate.com/stream/cross-post-list-confirmed",
    "events.iterate.com/stream/cross-post-list-delivery-blocked",
    "events.iterate.com/stream/cross-post-list-resend-requested",
    "events.iterate.com/stream/subscription-delivery-halted",
    "events.iterate.com/stream/subscription-delivery-resumed",
    "events.iterate.com/stream/subscription-cursor-set",
    "events.iterate.com/stream/connection-opened",
    "events.iterate.com/stream/connection-closed",
    "events.iterate.com/stream/cross-posted-events-dropped",
    "events.iterate.com/stream/error-occurred",
    "events.iterate.com/stream/paused",
    "events.iterate.com/stream/resumed",
  ],
  emits: [
    "events.iterate.com/stream/connection-opened",
    "events.iterate.com/stream/connection-closed",
    "events.iterate.com/stream/cross-post-list-recorded",
    "events.iterate.com/stream/cross-post-list-confirmed",
    "events.iterate.com/stream/cross-post-list-delivery-blocked",
    "events.iterate.com/stream/cross-posted-events-dropped",
    "events.iterate.com/stream/subscription-delivery-halted",
    "events.iterate.com/stream/child-stream-created",
  ],
});

/**
 * The contract's type under the same identifier, so type-level helpers read
 * without `typeof`: `ProcessorState<CoreProcessorContract>`,
 * `ConsumedEvent<CoreProcessorContract>`.
 */
export type CoreProcessorContract = typeof CoreProcessorContract;

/** Durable state reduced from the events in one stream. */
export type CoreProcessorState = z.infer<typeof CoreProcessorContract.stateSchema>;

type ParsedCoreEvent = ReturnType<typeof CoreProcessorContract.parseEvent>;

/** One exact committed event from the core processor contract. */
export type CommittedCoreEvent<Type extends ParsedCoreEvent["type"]> = Extract<
  ParsedCoreEvent,
  { type: Type }
>;

/** One committed event that created or replaced a subscription on its source stream. */
export type CommittedSubscriptionConfiguredEvent =
  CommittedCoreEvent<"events.iterate.com/stream/subscription-configured">;
/** One committed event that removed a subscription from its source stream. */
export type CommittedSubscriptionRemovedEvent =
  CommittedCoreEvent<"events.iterate.com/stream/subscription-removed">;
/** One committed receiver event recording a source stream's complete cross-post list. */
export type CommittedCrossPostListRecordedEvent =
  CommittedCoreEvent<"events.iterate.com/stream/cross-post-list-recorded">;
/** One committed source event confirming the receiver recorded its cross-post list. */
export type CommittedCrossPostListConfirmedEvent =
  CommittedCoreEvent<"events.iterate.com/stream/cross-post-list-confirmed">;

/** Parse a committed event returned by an index or another Stream Durable Object. */
export function parseCommittedCoreEvent<const Type extends ParsedCoreEvent["type"]>(
  event: StreamEvent,
  expectedType: Type,
): CommittedCoreEvent<Type> {
  if (event.type !== expectedType) {
    throw new Error(
      `stream event boundary returned "${event.type}" where "${expectedType}" was expected`,
    );
  }
  return CoreProcessorContract.parseEvent(
    event as StreamEvent & { type: Type },
  ) as CommittedCoreEvent<Type>;
}

/**
 * Validate a committed subscription configuration and keep only the fields a
 * delivery receiver is promised. This intentionally drops event metadata,
 * provenance, and idempotency bookkeeping.
 */
export function subscriptionConfigurationForDelivery(
  event: StreamEvent,
): SubscriptionConfigurationForDelivery {
  const configured = parseCommittedCoreEvent(
    event,
    "events.iterate.com/stream/subscription-configured",
  );
  return {
    type: configured.type,
    offset: configured.offset,
    createdAt: configured.createdAt,
    path: configured.path,
    payload: configured.payload,
  };
}
