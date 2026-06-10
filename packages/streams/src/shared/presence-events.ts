// Presence facts: durable observations that a delivery connection between this
// stream and one subscriber opened or closed.
//
// The stream itself appends these from its connection-management code, exactly
// once per actual open/close — which is why they carry no idempotency keys: a
// re-handshake after a transient break genuinely is a new connection and must
// re-land on the roster.
//
// Subscribers that reconcile runtime state against reduced state (in-flight
// LLM calls, timers, sockets) list `subscriber-connected` in their contract's
// `consumes` (with this catalog in `processorDeps`): a connected event is the
// signal that some participant's runtime state was reset, and it is always the
// tail of any batch it shares — it is appended after the handshake fixes the
// replay offset, so its offset exceeds every replayed event and
// state-at-event equals batch-final state.

import { z } from "zod";
import { createEvent } from "./stream-processors.ts";

/**
 * A processor contract announcement carried on the connect event when the
 * subscriber is a hosted stream processor. This is what feeds the stream's
 * `processorsBySlug` documentation registry (it replaces the old standalone
 * `stream/processor-registered` event).
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
 * optional: anonymous inbound watchers (a stream-viewer tab) may pass nothing,
 * processor hosts pass their incarnation id plus a contract announcement.
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
  /** Present when the subscriber is a hosted stream processor. */
  processor: ProcessorContractAnnouncement.optional(),
});

export type StreamSubscriberDescriptor = z.infer<typeof StreamSubscriberDescriptor>;

export const StreamSubscriberDisconnectReason = z.enum([
  /** A new connection for the same subscriptionKey replaced this one. */
  "replaced",
  /** The subscriber called unsubscribe(). */
  "unsubscribed",
  /** The RPC session to the subscriber broke (subscriber crashed or was evicted). */
  "rpc-broken",
  /** The outbound subscription's configuration was removed. */
  "subscription-removed",
]);

export type StreamSubscriberDisconnectReason = z.infer<typeof StreamSubscriberDisconnectReason>;

/**
 * Standalone catalog so processor contracts can consume presence events via
 * `processorDeps` without depending on the full core contract. The core
 * contract spreads these same definitions into its own catalog (same object
 * references, so duplicate-ownership validation accepts both).
 */
export const StreamPresenceEvents = {
  ...createEvent({
    type: "events.iterate.com/stream/subscriber-connected",
    description:
      "A delivery connection to one subscriber opened. Appended by the stream itself, once per actual open. Reconciling processors treat this as 'someone's runtime state was reset'.",
    payloadSchema: z.object({
      subscriptionKey: z.string().trim().min(1),
      direction: z.enum(["inbound", "outbound"]),
      subscriber: StreamSubscriberDescriptor.optional(),
    }),
  }),
  ...createEvent({
    type: "events.iterate.com/stream/subscriber-disconnected",
    description:
      "A delivery connection to one subscriber closed. Appended by the stream itself, once per actual close.",
    payloadSchema: z.object({
      subscriptionKey: z.string().trim().min(1),
      reason: StreamSubscriberDisconnectReason,
    }),
  }),
};

export type StreamSubscriberConnectedPayload = z.infer<
  (typeof StreamPresenceEvents)["events.iterate.com/stream/subscriber-connected"]["payloadSchema"]
>;

export type StreamSubscriberDisconnectedPayload = z.infer<
  (typeof StreamPresenceEvents)["events.iterate.com/stream/subscriber-disconnected"]["payloadSchema"]
>;
