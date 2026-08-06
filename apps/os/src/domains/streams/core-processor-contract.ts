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
// Version 24 makes each receiving stream's copy-list status a durable,
// replayable state machine instead of inferring a blocked list from a
// per-subscription halt or the SQLite retry scheduler.
// Version 25 records a random stream-lifetime identity. Creation time still
// orders destructive recreations, while the random ID prevents two lifetimes
// created in the same millisecond from sharing delivery-deduplication keys.
// Version 26 stores optional automatic-removal conditions directly on a
// subscription instead of beneath a redundant always-durable lifetime wrapper.
// Version 27 gives subscriptions one hierarchy: inbound subscriptions are
// grouped by source path and outbound subscriptions are keyed by their
// source-local key. Complete copy-list delivery work is separate because
// an empty list is still work the source must deliver.
// Version 28 deletes the copy-list handshake: inbound records are passive,
// derived from the `source.copiedFrom` stamps on committed copied events,
// capped at MAX_INBOUND_SOURCE_RECORDS, and exist only to fence stale source
// lifetimes/config generations and feed the debug card. The same version also
// removed the version-26 `endWhen` automatic-removal conditions and the
// copy-to-stream transform option. Still within version 28 (one undeployed
// flag day), the webhook-post receiver returned as the lane for
// remotely-hosted processors driven by webhooks, the JSONata fields took
// language-naming names (`jsonataCondition`, `jsonataTransform`), and the
// optional `jsonataTransform` became available on every push receiver (copy,
// ITX call, webhook) — never on processor-wake, whose delivery must feed the
// processor its committed log verbatim.
// Version 29 makes ephemeral events advance only `maxOffset`. Their bodies and
// all other reduced effects are memory-only, so rebuilding from the durable log
// produces the same durable core state after the Durable Object restarts.
// Version 30 implements the subscription-model redesign
// (docs/stream-subscription-model-redesign.md): the identity field is `name`
// (opaque, caller-chosen; auto-generated names keep the reserved
// `subscription:<offset>` form and are first-class — the old
// generated-key flag is gone), outbound subscriptions live
// under `subscriptions.outbound.byName`, the subscription NAME alone selects
// which registered contract a `processor-wake` runs (no receiver slug field;
// one identity — two instances of one contract are future work), and the
// receiver gains `placement: "facet"` (the subscription name IS the facet
// name; no itx expression).
export const CORE_STATE_VERSION = 30;

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

/** Where a copy, ITX-call, or webhook subscription starts reading the source stream. */
export const SubscriptionStart = z.enum(["beginning", "now"]);

export type SubscriptionStart = z.infer<typeof SubscriptionStart>;

/**
 * What a copy, ITX-call, or webhook subscription does when one specific event keeps failing
 * while the receiver is otherwise alive: `halt` (default) stops delivery and
 * appends a `subscription-delivery-halted` event — ordered receivers like stream
 * must never skip (a skip is a silent gap in the target stream); `skip`
 * retries the failing event alone (webhook deliveries are already single
 * events), records an idempotent `error-occurred`, and
 * steps over it — right for feeds where one bad event must not silence
 * everything after it (the project worker feed).
 */
const OnFailingEventPolicy = z.enum(["halt", "skip"]);

/** Event sending halts only when delivering matching events exhausts its retry budget. */
const SubscriptionHaltReason = z.literal("delivery-failed");

/** Policy for subscriptions whose awaited delivery cursor the source stream owns. */
const DeliveryPolicy = z.strictObject({
  start: SubscriptionStart,
  onFailingEvent: OnFailingEventPolicy,
});

/** Ordered stream copies may retry or halt, but can never skip a missing event. */
const StreamReceiverDeliveryPolicy = DeliveryPolicy.extend({
  onFailingEvent: z.literal("halt"),
});

/**
 * What one subscription does with matching source events. The action makes
 * invalid combinations unrepresentable: processor wake-ups own their
 * checkpoint; the other actions store their cursor and delivery policy on the source. A
 * copy names the receiving stream directly instead of hiding it inside
 * an ITX expression.
 */
export const SubscriptionReceiver = z.discriminatedUnion("action", [
  z
    .strictObject({
      // No jsonataTransform here, ever: a hosted processor's reduced state must
      // equal folding its stream's committed events. Wake delivery feeds the
      // processor its own log, so transforming it would break replay/rebuild
      // determinism.
      // The subscription NAME is the contract selector: it must equal the
      // registered processor slug (one identity; multi-instance — two names,
      // one slug — is deliberately future work; see
      // docs/stream-subscription-model-redesign.md). Nothing enforces that at
      // configure time: a name matching no registered processor fails loudly
      // at wake with the registry's unknown-name error.
      action: z.literal("processor-wake"),
      /**
       * Where the processor runs. `"facet"` hosts it as a facet of this
       * stream's own Durable Object: the subscription name IS the facet name
       * and delivery is an in-process parent→facet dial — no itx expression.
       * Omitted: the wake dials `expression` (own-DO or userspace-worker
       * placement, exactly as before).
       */
      placement: z.literal("facet").optional(),
      expression: DeliveryExpression.optional(),
    })
    .refine(
      (receiver) => (receiver.placement === "facet") !== (receiver.expression !== undefined),
      {
        message:
          'processor-wake requires exactly one of placement: "facet" or a delivery expression',
      },
    ),
  z.strictObject({
    action: z.literal("copy-to-stream"),
    receivingStreamPath: StreamPath,
    /**
     * Optional JSONata constructor evaluated per event to shape what the
     * receiving stream commits (`{ type?, payload?, metadata? }`; omitted
     * fields copy verbatim). The receiver applies it, then the platform
     * stamps `source.copiedFrom` and the source-coordinate idempotency key —
     * a transform can reshape the body but can never forge provenance or
     * affect deduplication. Parse-validated at configure time; an evaluation
     * failure at delivery time is an ordinary delivery failure.
     */
    jsonataTransform: z.string().trim().min(1).optional(),
    delivery: StreamReceiverDeliveryPolicy,
  }),
  z.strictObject({
    action: z.literal("itx-call"),
    expression: DeliveryExpression,
    /**
     * Optional JSONata constructor evaluated per event to shape each event in
     * the delivered batch (`{ type?, payload?, metadata? }`; omitted fields
     * copy verbatim) while the coordinates keep naming the source rows.
     * Parse-validated at configure time; an evaluation failure at send time
     * is an ordinary delivery failure.
     */
    jsonataTransform: z.string().trim().min(1).optional(),
    delivery: DeliveryPolicy,
  }),
  z.strictObject({
    action: z.literal("webhook-post"),
    url: z.url({ protocol: /^https?$/ }),
    /**
     * Optional JSONata constructor evaluated per event to shape the POSTed
     * event body (`{ type?, payload?, metadata? }`; omitted fields copy
     * verbatim) while the envelope keeps the real source coordinates.
     * Parse-validated at configure time; an evaluation failure at send time
     * is an ordinary delivery failure.
     */
    jsonataTransform: z.string().trim().min(1).optional(),
    delivery: DeliveryPolicy,
  }),
]);

export type SubscriptionReceiver = z.infer<typeof SubscriptionReceiver>;

/**
 * Bounded because every name is retained in reduced state on both sides of a
 * delivery — outbound configuration here, and one passive inbound record per
 * (source path, name) on each receiver. Names are opaque: the platform never
 * parses structure out of one. The single reserved form is the auto-generated
 * `subscription:<offset>`.
 */
const SubscriptionName = z.string().trim().min(1).max(500);

export const SubscriptionConfiguredPayload = z.strictObject({
  /**
   * A caller-selected source-local identity, reused verbatim as the catalog
   * key at the stream, the itx address segment, the facet name under facet
   * placement, and the progress-key component under own-DO placement.
   * Omitting it creates a new subscription whose effective name is derived
   * from this event's committed offset (`subscription:<offset>`).
   */
  name: SubscriptionName.optional(),
  description: z.string().trim().min(1).optional(),
  filter: EventFilter.optional(),
  receiver: SubscriptionReceiver,
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
 *
 * @public — never imported; the export exists so the compiler must evaluate
 * the assertion.
 */
export type SubscriptionConfiguredDeliveryPayloadContractMatches = AssertTrue<
  MutuallyAssignable<
    z.output<typeof SubscriptionConfiguredPayload>,
    SubscriptionConfigurationForDelivery["payload"]
  >
>;

/** Reduced outbound configuration always contains the effective name. */
const EffectiveSubscriptionConfiguration = SubscriptionConfiguredPayload.safeExtend({
  name: SubscriptionName,
});

/** Hard bound on how many subscriptions one source may point at one receiving stream. */
export const MAX_SUBSCRIPTIONS_PER_RECEIVING_STREAM = 64;

/** The effective source-local name for one committed configuration event. */
export function subscriptionNameForConfiguredEvent(event: {
  offset: number;
  payload: Pick<SubscriptionConfiguredPayload, "name">;
}): string {
  return event.payload.name ?? `subscription:${event.offset}`;
}

/**
 * Reconstruct the payload that was committed in a subscription-configured
 * event from reduced outbound state. Generated names exist only in reduced
 * state: the original event omitted the name and derives it from its offset.
 *
 * Fresh callers cannot claim the `subscription:` namespace, and a later
 * replacement necessarily has a later offset, so equality with this event's
 * generated name is unambiguous.
 */
export function subscriptionConfiguredPayloadFromReducedState(args: {
  configuration: z.infer<typeof EffectiveSubscriptionConfiguration>;
  configuredAtOffset: number;
}): SubscriptionConfiguredPayload {
  if (
    args.configuration.name !==
    subscriptionNameForConfiguredEvent({
      offset: args.configuredAtOffset,
      payload: {},
    })
  ) {
    return args.configuration;
  }

  const { name: _generatedName, ...committedPayload } = args.configuration;
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

const SubscriptionRemovalReason = z.literal("requested");

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
   * deliberately dropped every idle-eligible connection so both sides can
   * hibernate instead of accruing billable duration on idle cross-isolate RPC
   * sessions. For a hosted connection the subscription is kept and the next
   * append wakes the processor again; for a wake-socket-backed session
   * connection the subscriber stays present on its hibernatable socket and
   * the next matching append makes its relay re-dial (see wake-socket.ts).
   * An idle close is therefore NOT a departure; the dormant subscriber's
   * eventual real departure is the `"departed"` close below.
   */
  "idle",
  /**
   * A DORMANT subscriber's wake socket closed: the client behind an
   * idle-closed session connection actually went away (tab closed, device
   * offline, worker context canceled). Live connections never use this —
   * their close paths append their own reasons; this fact exists so audit
   * and presence consumers keying on close facts see the true departure
   * that `"idle"` deliberately is not.
   */
  "departed",
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
    /** Durable events folded so far. `maxOffset` also includes ephemeral offset gaps. */
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
        /**
         * Passive per-(source path, subscription name) records derived from
         * the `source.copiedFrom` stamps on committed copied events — never
         * from a configure-time handshake. They fence stale deliveries (an
         * older source lifetime, or an older config generation of the same
         * lifetime) and feed the debug card; the receiver learns about a
         * subscription only when its first copy arrives.
         */
        inbound: z
          .object({
            bySourcePath: z
              .record(
                z.string(),
                z.record(
                  z.string(),
                  z.object({
                    /** Random identity of the source stream lifetime last accepted. */
                    streamId: z.uuid(),
                    /** Creation time of that lifetime; orders destructive recreations. */
                    streamCreatedAt: z.string().trim().min(1),
                    /** Configure/cursor-set offset of the config generation last accepted. */
                    cursorChangedAtSourceOffset: z.number().int().positive(),
                    numEventsReceived: z.number().int().nonnegative(),
                    lastEventReceivedAt: z.string().optional(),
                  }),
                ),
              )
              .default({}),
          })
          .default({ bySourcePath: {} }),
        /** Subscriptions configured on this source stream, by their opaque name. */
        outbound: z
          .object({
            byName: z
              .record(
                z.string(),
                z.object({
                  configuration: EffectiveSubscriptionConfiguration,
                  configuredAtOffset: z.number().int().positive(),
                  configuredAt: z.string(),
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
          .default({ byName: {} }),
      })
      .default({
        inbound: { bySourcePath: {} },
        outbound: { byName: {} },
      }),
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
            name: "agent",
            receiver: {
              action: "processor-wake",
              expression: [
                "agents",
                ["get", "/agents/onboarding"],
                "processor",
                "wakeStreamProcessor",
              ],
            },
          },
        },
        {
          description:
            "A processor hosted as a facet of the stream's own Durable Object: the subscription name is the facet name; no expression is needed.",
          payload: {
            name: "device",
            receiver: {
              action: "processor-wake",
              placement: "facet",
            },
          },
        },
        {
          description:
            "A copy copies one repository's GitHub webhooks from a connection stream, starting with new events from now on.",
          payload: {
            name: "github-repo:/repos/root",
            description:
              "Delivers GitHub webhooks for acme/widgets to this repo's stream so the repo processor can react to them.",
            filter: {
              eventTypes: ["events.iterate.com/github/webhook-received"],
              jsonataCondition: 'payload.body.repository.full_name = "acme/widgets"',
            },
            receiver: {
              action: "copy-to-stream",
              receivingStreamPath: "/repos/root",
              delivery: {
                start: "now",
                onFailingEvent: "halt",
              },
            },
          },
        },
        {
          description:
            "An ITX call sends matching task events to a project worker method and stores the completed offset on this source stream.",
          payload: {
            name: "tasks-for-project-worker",
            filter: { eventTypes: ["events.example/task-created"] },
            receiver: {
              action: "itx-call",
              expression: ["worker", "processEventBatch"],
              delivery: {
                start: "beginning",
                onFailingEvent: "halt",
              },
            },
          },
        },
        {
          description:
            "Webhook delivery: one HTTP POST per event to an external receiver, stepping over a repeatedly failing event instead of halting all later sends.",
          payload: {
            name: "ops-webhook",
            receiver: {
              action: "webhook-post",
              url: "https://hooks.example.com/iterate/stream-events",
              delivery: {
                start: "now",
                onFailingEvent: "skip",
              },
            },
          },
        },
      ],
    },
    "events.iterate.com/stream/subscription-removed": {
      description: "Removes one durable subscription.",
      payloadSchema: z.strictObject({
        name: z.string().trim().min(1),
        reason: SubscriptionRemovalReason,
      }),
    },
    "events.iterate.com/stream/subscription-delivery-halted": {
      description:
        "One subscription stopped after delivering matching source events exhausted the bounded retry count.",
      payloadSchema: z.strictObject({
        name: z.string().trim().min(1),
        reason: SubscriptionHaltReason,
        /** The cursor at halt time: delivery stopped without confirming past this offset. */
        afterOffset: z.number().int().min(0),
        attempts: z.number().int().positive(),
        error: z.string().trim().min(1).max(4_096).optional(),
      }),
    },
    "events.iterate.com/stream/subscription-delivery-resumed": {
      description: "Resumes one halted subscription at its existing cursor.",
      payloadSchema: z.strictObject({
        name: z.string().trim().min(1),
      }),
    },
    "events.iterate.com/stream/subscription-cursor-set": {
      description:
        "Changes the next source offset read by one copy, ITX-call, or webhook subscription (exclusive afterOffset semantics). It rejects offsets beyond the current stream head. A receiver call already in progress may still finish, but cannot advance this new position. Hosted processors reject this event because the processor stores its own checkpoint.",
      payloadSchema: z.strictObject({
        name: z.string().trim().min(1),
        afterOffset: z.number().int().min(0),
      }),
      examples: [
        {
          description:
            "Replays the stream's full history into the project worker feed (afterOffset is exclusive; 0 replays everything).",
          payload: { name: "project-worker", afterOffset: 0 },
        },
        {
          description:
            "Makes future copy sends read after offset 512; a receiver call already in progress may still finish.",
          payload: { name: "github-repo:/repos/root", afterOffset: 512 },
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
    "events.iterate.com/stream/subscription-removed",
    "events.iterate.com/stream/subscription-delivery-halted",
    "events.iterate.com/stream/subscription-delivery-resumed",
    "events.iterate.com/stream/subscription-cursor-set",
    "events.iterate.com/stream/connection-opened",
    "events.iterate.com/stream/connection-closed",
    "events.iterate.com/stream/error-occurred",
    "events.iterate.com/stream/paused",
    "events.iterate.com/stream/resumed",
  ],
  emits: [
    "events.iterate.com/stream/connection-opened",
    "events.iterate.com/stream/connection-closed",
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
