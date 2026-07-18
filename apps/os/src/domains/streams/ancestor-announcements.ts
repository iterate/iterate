// Durable stream-topology announcements.
//
// A non-root stream owns one internal push subscription. Its one journaled
// request is delivered through the ordinary stream spine to the project root,
// which idempotently appends `child-stream-created` to every ancestor. The
// source cursor advances only after every append resolves, so an eviction or
// transient ancestor failure is a redelivery, not a silently orphaned stream.

import type { StreamEventInput, StreamPushEventBatch } from "iterate/processors";
import type { SubscriptionConfiguredPayload } from "./core-processor-contract.ts";

export const ANCESTOR_ANNOUNCEMENT_SUBSCRIPTION_KEY = "platform:ancestor-announcements";
export const ANCESTOR_ANNOUNCEMENT_REQUESTED_EVENT_TYPE =
  "events.iterate.com/internal/stream-ancestor-announcement-requested";

/** True for facts that can configure, advance, park, or trigger the platform obligation. */
export function isAncestorAnnouncementPlatformEvent(event: StreamEventInput): boolean {
  if (event.type === ANCESTOR_ANNOUNCEMENT_REQUESTED_EVENT_TYPE) return true;
  switch (event.type) {
    case "events.iterate.com/stream/subscription-configured":
    case "events.iterate.com/stream/subscription-removed":
    case "events.iterate.com/stream/subscription-parked":
    case "events.iterate.com/stream/subscription-resumed":
    case "events.iterate.com/stream/subscription-cursor-set": {
      const payload = event.payload;
      return (
        typeof payload === "object" &&
        payload !== null &&
        "subscriptionKey" in payload &&
        payload.subscriptionKey === ANCESTOR_ANNOUNCEMENT_SUBSCRIPTION_KEY
      );
    }
    default:
      return false;
  }
}

export function ancestorAnnouncementSubscriptionPayload(): SubscriptionConfiguredPayload {
  return {
    subscriptionKey: ANCESTOR_ANNOUNCEMENT_SUBSCRIPTION_KEY,
    delivery: {
      mode: "push",
      expression: ["streams", ["get", "/"], "acceptAncestorAnnouncements"],
    },
    description: "Maintain this stream's child-stream-created facts on every ancestor.",
    selector: { eventTypes: [ANCESTOR_ANNOUNCEMENT_REQUESTED_EVENT_TYPE] },
  };
}

/** Install/repair the durable delivery and put one item after its initial cursor. */
export function ancestorAnnouncementSetupEvents(): [StreamEventInput, StreamEventInput] {
  return [
    {
      type: "events.iterate.com/stream/subscription-configured",
      payload: ancestorAnnouncementSubscriptionPayload(),
    },
    {
      type: ANCESTOR_ANNOUNCEMENT_REQUESTED_EVENT_TYPE,
      payload: {},
    },
  ];
}

export type AncestorAnnouncementAppend = {
  path: string;
  event: StreamEventInput;
};

/** Validate one internal delivery and construct its idempotent ancestor appends. */
export function buildAncestorAnnouncementAppends(
  batch: StreamPushEventBatch,
): AncestorAnnouncementAppend[] {
  if (batch.subscriptionKey !== ANCESTOR_ANNOUNCEMENT_SUBSCRIPTION_KEY) {
    throw new Error(`unexpected ancestor-announcement subscription "${batch.subscriptionKey}"`);
  }
  if (batch.configuredEvent.path !== batch.path) {
    throw new Error("ancestor-announcement delivery coordinates do not match its config event");
  }
  const configuredPayload = batch.configuredEvent.payload as
    | { subscriptionKey?: unknown }
    | undefined;
  if (configuredPayload?.subscriptionKey !== ANCESTOR_ANNOUNCEMENT_SUBSCRIPTION_KEY) {
    throw new Error("ancestor-announcement delivery has the wrong configured payload");
  }

  const requests = batch.events.filter(
    (event) => event.type === ANCESTOR_ANNOUNCEMENT_REQUESTED_EVENT_TYPE,
  );
  if (requests.length === 0) {
    throw new Error("ancestor-announcement delivery contains no request fact");
  }
  if (
    requests.some(
      (event) => event.path !== batch.path || event.source?.crossPostedFrom !== undefined,
    )
  ) {
    throw new Error("ancestor-announcement request must be a first-hand fact on its source stream");
  }

  return ancestorPaths(batch.path).map((path) => ({
    path,
    event: {
      type: "events.iterate.com/stream/child-stream-created",
      idempotencyKey: `child-stream-created:${path}:${batch.path}`,
      payload: { childPath: batch.path },
    },
  }));
}

/** Root first, then each proper ancestor; the stream itself is excluded. */
export function ancestorPaths(path: string): string[] {
  const segments = path.split("/").filter(Boolean);
  const normalized = segments.length === 0 ? "/" : `/${segments.join("/")}`;
  if (normalized !== path) throw new Error(`stream path is not normalized: ${path}`);
  if (path === "/") return [];

  const paths = ["/"];
  for (let index = 1; index < segments.length; index += 1) {
    paths.push(`/${segments.slice(0, index).join("/")}`);
  }
  return paths;
}
