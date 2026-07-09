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
import { ItxExpression } from "../../itx/expression.ts";
import { EventSelector } from "./event-selector.ts";
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
// - 10: durable subscriptions unified — one `subscription-configured` payload
//      carries a delivery mode (`wake` to a Durable Object processor, `push`
//      to a persisted itx expression) plus selector / deliver / onPoison;
//      spine facts (subscription-parked/-resumed/-cursor-set) fold into the
//      subscription records; cross-post rules deleted (a cross-post is a push
//      subscription addressing the target stream's `ingest`); worker wake
//      targets deleted (stateless workers consume via push).
// - 11: one addressing grammar for every durable mode — wake targets are itx
//      expressions too, naming the domain node's processor (`["agents",
//      ["get", path], "processor", "wakeStreamSubscriber"]`) instead of a
//      typed Durable Object address, and `webhook` joins as the third mode
//      (per-EVENT HTTP POST on the push spine's cursor machinery).
// - 12: dead derived state deleted — `processorsBySlug` (written on every
//      connect fold, read by nothing; announcements live on presence facts)
//      and `metadata` + its `metadata-updated` event (no appender, no reader).
// - 13: seek verbs orthogonalized — `subscription-resumed` loses `afterOffset`
//      (resume = pure un-park at the cursor where delivery stopped);
//      `subscription-cursor-set` is the one and only seek. A redrive is two
//      facts (cursor-set + resumed), each honest about what it did.
export const CORE_STATE_VERSION = 13;

// Restored from the old built-in circuit-breaker processor. These defaults are
// intentionally high for normal browser/load tests; the breaker exists to stop
// runaway producers, not to meter ordinary stream traffic.
const DEFAULT_CIRCUIT_BREAKER_BURST_CAPACITY = 100_000;
const DEFAULT_CIRCUIT_BREAKER_REFILL_RATE_PER_MINUTE = 6_000_000;

/**
 * A delivery-addressing expression: an {@link ItxExpression} whose FINAL step
 * is a property step naming the method the spine will invoke. The dial turns
 * that tail into a call step at delivery time (`[..., [tail, payload]]`), so
 * the invocation happens receiver-bound on the remote side — reading the
 * method as a property and applying it locally detaches it from `this` across
 * a real RPC hop. Enforced here so an invalid tail is rejected before the
 * config event commits, not discovered as a delivery failure forever after.
 */
const DeliveryExpression = ItxExpression.refine(
  (expression) => typeof expression.at(-1) === "string",
  { message: "delivery expression must end in a property step naming the method to invoke" },
);

export const StreamSubscriptionType = z.enum(["configured", "ephemeral"]);
export type StreamSubscriptionType = z.infer<typeof StreamSubscriptionType>;

/**
 * How a durable subscription's events reach the subscriber — the three
 * modalities of the streams README's axes table. Wake and push share ONE
 * addressing grammar: a persisted {@link ItxExpression itx expression},
 * evaluated at delivery time against the stream's own authority root (the
 * project itx for project streams, the trusted deployment root for global
 * streams). The mode picks the delivery protocol, never the addressing:
 *
 * - `wake`: the subscriber is a stateful fold (a Durable-Object-hosted
 *   processor) that owns its own `{offset, state}` checkpoint. The expression
 *   names the poke method on the domain node's processor (`["agents", ["get",
 *   path], "processor", "wakeStreamSubscriber"]`, `["repos", …]`, the project
 *   root's own `["processor", "wakeStreamSubscriber"]`, …); the poke returns
 *   the checkpoint and a live one-way sink, and the stream streams batches
 *   into the sink from there. The stream-side cursor is an OBSERVATIONAL
 *   watermark (poke coalescing + lag); the subscriber's checkpoint is the
 *   truth.
 * - `push`: the subscriber is a stateless effect named by the expression
 *   (`["processEventBatch"]` — the project root's own dispatch point the
 *   birth-certificate worker feed names, `["streams", ["get", path],
 *   "ingest"]`, …). The stream owns the AUTHORITATIVE cursor, dials the
 *   expression fresh per batch, and advances only on a successful awaited
 *   call.
 * - `webhook`: push semantics over plain HTTP, one event per POST — the
 *   receiver is outside the itx world, and external webhook consumers expect
 *   individual events, so the cursor advances per event instead of per batch.
 *   POSTs ride the project egress lane (attributed + interceptable, never
 *   bare global fetch), so webhooks require a project-scoped stream.
 *
 * The criterion: the offset lives with whoever owns the state it must be
 * transactionally consistent with.
 */
const SubscriptionDelivery = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("wake"),
    expression: DeliveryExpression,
    /**
     * Which hosted processor the wake is for — multi-processor hosts (an
     * agent DO hosts agent + slack-agent + more) resolve on it;
     * single-processor hosts may omit it. Rides the wake request verbatim.
     */
    processorSlug: z.string().trim().min(1).optional(),
  }),
  z.strictObject({ mode: z.literal("push"), expression: DeliveryExpression }),
  z.strictObject({ mode: z.literal("webhook"), url: z.url({ protocol: /^https?$/ }) }),
]);

export type SubscriptionDelivery = z.infer<typeof SubscriptionDelivery>;

/**
 * Initial cursor for a stream-owned-cursor subscription (push/webhook).
 * `"new"` pins to the configuring event's own offset — deterministic under
 * log replay, no clock — and is the default. `"all"` replays the full history
 * (`afterOffset: 0`).
 */
const DeliverPolicy = z.union([
  z.literal("all"),
  z.literal("new"),
  z.strictObject({ afterOffset: z.number().int().nonnegative() }),
]);

export type DeliverPolicy = z.infer<typeof DeliverPolicy>;

/**
 * What a push/webhook subscription does when one specific batch keeps failing
 * while the receiver is otherwise alive: `park` (default) stops delivery and
 * records a `subscription-parked` fact — ordered receivers like cross-post
 * must never skip (a skip is a silent gap in the target stream); `skip`
 * bisects the batch to isolate the poison event (webhook batches are already
 * single events), records an idempotent `error-occurred`, and steps over it —
 * right for feeds where one bad event must not silence everything after it
 * (the project worker feed).
 */
const OnPoisonPolicy = z.enum(["park", "skip"]);

// Payloads shared between the event catalog below and the reduced-state
// records that store the latest committed configuration event, so the two can
// never drift apart.
const SubscriptionConfiguredPayload = z
  .object({
    subscriptionKey: z.string().trim().min(1),
    delivery: SubscriptionDelivery,
    /** Which events this subscription receives. Absent = everything. */
    selector: EventSelector.optional(),
    /** Initial cursor for push/webhook (see {@link DeliverPolicy}). Ignored for wake mode. */
    deliver: DeliverPolicy.optional(),
    /** Push/webhook poison policy (see {@link OnPoisonPolicy}). Ignored for wake mode. */
    onPoison: OnPoisonPolicy.optional(),
    /**
     * Receiver-owned configuration, passed through VERBATIM on every delivery
     * (the frame carries the configured event). The platform never interprets
     * this bag — the generic spine filters and dials, nothing more; a NAMED
     * receiver documents and applies its own params (selectors filter, receivers
     * transform). `Stream.ingest` reads `params.transform` here, for example.
     */
    params: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((payload, ctx) => {
    // Honesty at append time: these knobs are cursor policy for the
    // stream-owned-cursor modes. Accepting them on a wake config (where the
    // subscriber owns its checkpoint) would commit config that silently does
    // nothing.
    if (payload.delivery.mode !== "wake") return;
    for (const field of ["deliver", "onPoison"] as const) {
      if (payload[field] !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: `"${field}" only applies to push/webhook subscriptions (wake subscribers own their checkpoint)`,
        });
      }
    }
  });

export type SubscriptionConfiguredPayload = z.infer<typeof SubscriptionConfiguredPayload>;

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
 * subscriber is a hosted stream processor. It rides the presence facts
 * (`connectionsByKey[..].subscriber.processor.announcement`), which is where
 * UIs and tooling read it.
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
    configuredSubscribersByKey: z
      .record(
        z.string(),
        latestConfiguredEvent(
          "events.iterate.com/stream/subscription-configured",
          SubscriptionConfiguredPayload,
        ).extend({
          /**
           * Set by a `subscription-parked` fact (delivery gave up after
           * sustained failure), cleared by `subscription-resumed` or by a
           * fresh `subscription-configured` for the key (new config = fresh
           * chance). While set, the spine does not deliver. The cursor itself
           * is NOT here: acked offsets are storage (the spine's SQLite rows),
           * not facts — see the streams README doctrine.
           */
          parkedAtOffset: z.number().int().min(0).optional(),
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
      examples: [
        {
          description: "A project's agent stream is created.",
          payload: { projectId: "prj_01jzp3v9qkfxeb2m4n8r7wd5ha", path: "/agents/onboarding" },
        },
        {
          description: "A deployment-global stream (no owning project) is created.",
          payload: { projectId: null, path: "/repos/iterate-config-base" },
        },
      ],
    },
    "events.iterate.com/stream/woken": {
      description: "Records that a Durable Object incarnation has started running this stream.",
      payloadSchema: z.object({
        incarnationId: z.string().trim().min(1),
      }),
      examples: [
        {
          description:
            "A fresh Durable Object incarnation starts running the stream after hibernation.",
          payload: { incarnationId: "b7f9d2c4-3a1e-4f68-9c05-8d2e6a41f7b3" },
        },
      ],
    },
    "events.iterate.com/stream/configured": {
      description: "Configures core stream runtime policy.",
      payloadSchema: StreamConfiguredPayload,
      examples: [
        {
          description: "Sets an explicit append circuit-breaker budget for a capture stream.",
          payload: {
            config: { circuitBreaker: { burstCapacity: 100_000, refillRatePerMinute: 6_000_000 } },
          },
        },
      ],
    },
    "events.iterate.com/stream/child-stream-created": {
      description: "Records the immediate child stream segment under this stream.",
      payloadSchema: z.object({
        childPath: z.string().trim().min(1),
      }),
      examples: [
        {
          description: "The project root stream learns a new agent stream was born beneath it.",
          payload: { childPath: "/agents/onboarding" },
        },
        {
          description:
            "An ancestor stream records a newborn Slack thread agent; the reducer folds the full path down to the immediate child segment.",
          payload: { childPath: "/agents/slack/main/C0788AB12CD/ts-1751884800-123456" },
        },
      ],
    },
    "events.iterate.com/stream/subscription-configured": {
      description:
        "Configures or replaces a durable subscription for this stream (wake or push delivery; latest event per subscriptionKey wins). Re-configuring keeps the existing delivery cursor unless `deliver` is set, and clears any parked state — new config is a fresh chance.",
      payloadSchema: SubscriptionConfiguredPayload,
      examples: [
        {
          description:
            "Wake delivery: the agent processor hosted on the agent's Durable Object folds this stream; the subscriber owns its own checkpoint, so no deliver/onPoison here.",
          payload: {
            subscriptionKey: "prj_01jzp3v9qkfxeb2m4n8r7wd5ha.iterate/agents/onboarding#agent",
            delivery: {
              mode: "wake",
              expression: [
                "agents",
                ["get", "/agents/onboarding"],
                "processor",
                "wakeStreamSubscriber",
              ],
              processorSlug: "agent",
            },
          },
        },
        {
          description:
            "Push delivery: cross-posts one repository's GitHub webhooks from a connection stream onto the repo's own stream, live-tailing from now.",
          payload: {
            subscriptionKey: "github-repo:/repos/root",
            selector: {
              eventTypes: ["events.iterate.com/github/webhook-received"],
              condition: 'payload.body.repository.full_name = "acme/widgets"',
            },
            delivery: {
              mode: "push",
              expression: ["streams", ["get", "/repos/root"], "ingest"],
            },
            deliver: "new",
          },
        },
        {
          description:
            "Webhook delivery: one HTTP POST per event to an external receiver, stepping over a poison event instead of parking the whole feed.",
          payload: {
            subscriptionKey: "ops-webhook",
            delivery: {
              mode: "webhook",
              url: "https://hooks.example.com/iterate/stream-events",
            },
            deliver: "new",
            onPoison: "skip",
          },
        },
      ],
    },
    "events.iterate.com/stream/subscription-removed": {
      description:
        "Removes a durable subscription. Deleting the config is revocation: the stream is the only holder of the delivery machinery, and its cursor row is dropped with it.",
      payloadSchema: z.object({
        subscriptionKey: z.string().trim().min(1),
      }),
      examples: [
        {
          description: "Unlinking a repo from GitHub revokes its webhook cross-post subscription.",
          payload: { subscriptionKey: "github-repo:/repos/root" },
        },
      ],
    },
    "events.iterate.com/stream/subscription-parked": {
      description:
        "Delivery for one subscription gave up after sustained failure and stopped. Appended by the stream's own delivery spine, idempotent per (subscriptionKey, atOffset). Parked is a fact, loud by design; resume it explicitly with subscription-resumed.",
      payloadSchema: z.object({
        subscriptionKey: z.string().trim().min(1),
        /** The cursor at park time: delivery stopped without acking past this offset. */
        atOffset: z.number().int().min(0),
        attempts: z.number().int().positive(),
        error: z.string().trim().min(1).optional(),
      }),
      examples: [
        {
          description:
            "A webhook receiver stayed down through the whole retry ladder, so delivery gave up loudly.",
          payload: {
            subscriptionKey: "ops-webhook",
            atOffset: 1874,
            attempts: 15,
            error:
              "webhook POST https://hooks.example.com/iterate/stream-events failed with status 503",
          },
        },
      ],
    },
    "events.iterate.com/stream/subscription-resumed": {
      description:
        "Operator/agent verb: un-parks a subscription and kicks delivery, resuming at the cursor where it stopped. Moving the cursor is a different act with its own fact — append `subscription-cursor-set` first for a redrive (skip past a bad offset, replay a window).",
      payloadSchema: z.object({
        subscriptionKey: z.string().trim().min(1),
      }),
      examples: [
        {
          description:
            "Un-parks a subscription after the receiver recovered; delivery resumes from the cursor where it stopped.",
          payload: { subscriptionKey: "ops-webhook" },
        },
      ],
    },
    "events.iterate.com/stream/subscription-cursor-set": {
      description:
        "Operator/agent verb: THE seek — explicitly moves a push subscription's cursor (exclusive afterOffset semantics: 0 replays everything). The audited form of replay — the cursor row itself is storage, but moving it deliberately is a fact. For a parked subscription, follow with `subscription-resumed` to restart delivery.",
      payloadSchema: z.object({
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
            "Seeks a cross-post subscription's cursor forward: events at or below offset 512 are never delivered.",
          payload: { subscriptionKey: "github-repo:/repos/root", afterOffset: 512 },
        },
      ],
    },
    "events.iterate.com/stream/subscriber-connected": {
      description:
        "A delivery connection to one subscriber opened. Appended by the stream itself, once per actual open — which is why presence facts carry no idempotency keys: a re-handshake after a transient break genuinely is a new connection and must re-land on the roster. It is always the tail of any batch it shares (appended after the handshake fixes the replay offset), so state-at-event equals batch-final state.",
      payloadSchema: z.object({
        subscriptionKey: z.string().trim().min(1),
        subscriptionType: StreamSubscriptionType,
        subscriber: StreamSubscriberDescriptor.optional(),
      }),
      examples: [
        {
          description:
            "A wake subscription's poke handshake completed: the hosted agent processor connected and announced its contract (consumes/emits abridged).",
          payload: {
            subscriptionKey: "prj_01jzp3v9qkfxeb2m4n8r7wd5ha.iterate/agents/onboarding#agent",
            subscriptionType: "configured",
            subscriber: {
              processor: {
                announcement: {
                  slug: "agent",
                  version: "0.3.1",
                  description:
                    "Maintains model-visible web-chat history and requests LLM work from a provider processor.",
                  consumes: [
                    "events.iterate.com/agent/input-added",
                    "events.iterate.com/agents/user-message-received",
                    "events.iterate.com/agent/llm-request-completed",
                  ],
                  emits: [
                    "events.iterate.com/agent/input-added",
                    "events.iterate.com/agent/llm-request-scheduled",
                  ],
                  ownedEvents: [
                    {
                      type: "events.iterate.com/agent/input-added",
                      description: "A normalized model-visible input was added.",
                    },
                    { type: "events.iterate.com/agent/llm-request-scheduled" },
                  ],
                },
              },
            },
          },
        },
        {
          description:
            "An anonymous ephemeral watcher: a browser stream-viewer tab live-tailing the log.",
          payload: {
            subscriptionKey: "d4f8a1b2-6c3e-4e9a-8b57-0f1c2d3e4a5b",
            subscriptionType: "ephemeral",
            subscriber: { description: "browser" },
          },
        },
      ],
    },
    "events.iterate.com/stream/subscriber-disconnected": {
      description:
        "A delivery connection to one subscriber closed. Appended by the stream itself, once per actual close.",
      payloadSchema: z.object({
        subscriptionKey: z.string().trim().min(1),
        reason: StreamSubscriberDisconnectReason,
      }),
      examples: [
        {
          description: "A stream-viewer tab closed and unsubscribed.",
          payload: {
            subscriptionKey: "d4f8a1b2-6c3e-4e9a-8b57-0f1c2d3e4a5b",
            reason: "unsubscribed",
          },
        },
        {
          description:
            "The stream went quiet past its idle window and dropped its configured connections so everyone can hibernate; the durable config is kept and the next append re-wakes.",
          payload: {
            subscriptionKey: "prj_01jzp3v9qkfxeb2m4n8r7wd5ha.iterate/agents/onboarding#agent",
            reason: "idle",
          },
        },
      ],
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
            'The delivery spine stepped over a confirmed poison event on an onPoison: "skip" subscription.',
          payload: {
            message:
              'subscription "project-worker" skipped poison event at offset 812 after 3 attempts: receiver rejected payload',
          },
        },
        {
          description:
            "A processor skipped an event that fails its contract's schema, with the structured cause attached.",
          payload: {
            message:
              'stream processor "agent" skipped event at offset 42 ("events.iterate.com/agent/input-added"): it fails the contract\'s schema',
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
      examples: [
        {
          description:
            "The stream paused itself after its append circuit breaker tripped on a runaway producer.",
          payload: { reason: "circuit breaker tripped: burst rate limit exceeded" },
        },
      ],
    },
    "events.iterate.com/stream/resumed": {
      description: "Records that the stream has resumed accepting ordinary appends.",
      payloadSchema: z.object({
        reason: z.string().trim().min(1).optional(),
      }),
      examples: [
        {
          description: "An operator reopened the stream after investigating a tripped breaker.",
          payload: { reason: "operator resumed after raising the circuit-breaker budget" },
        },
      ],
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
    "events.iterate.com/stream/subscription-parked",
    "events.iterate.com/stream/subscription-resumed",
    "events.iterate.com/stream/subscription-cursor-set",
    "events.iterate.com/stream/subscriber-connected",
    "events.iterate.com/stream/subscriber-disconnected",
    "events.iterate.com/stream/error-occurred",
    "events.iterate.com/stream/paused",
    "events.iterate.com/stream/resumed",
  ],
  emits: [
    "events.iterate.com/stream/subscriber-connected",
    "events.iterate.com/stream/subscriber-disconnected",
    "events.iterate.com/stream/subscription-parked",
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
