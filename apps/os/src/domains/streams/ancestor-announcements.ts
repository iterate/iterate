// Durable stream-topology announcements.
//
// A non-root stream owns one derived platform push subscription. Its existing
// `stream/created` birth fact is the trigger delivered through the ordinary
// stream spine to the project root, which idempotently appends
// `child-stream-created` to every ancestor. The source cursor advances only
// after every append resolves, so an eviction or transient ancestor failure is
// a redelivery, not a silently orphaned stream. Deriving the obligation from
// the birth fact keeps platform plumbing out of the public stream log.

import type { StreamEventInput, StreamPushEventBatch } from "iterate/processors";
import type { SubscriptionConfiguredPayload } from "./core-processor-contract.ts";

export const ANCESTOR_ANNOUNCEMENT_SUBSCRIPTION_KEY = "platform:ancestor-announcements";

/** True for facts that can configure, advance, or park the platform obligation. */
export function isAncestorAnnouncementPlatformEvent(event: StreamEventInput): boolean {
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
    selector: { eventTypes: ["events.iterate.com/stream/created"] },
    deliver: "all",
  };
}

/** Validate one internal delivery and construct its idempotent ancestor appends. */
export function buildAncestorAnnouncementAppends(
  batch: StreamPushEventBatch,
): Array<{ path: string; event: StreamEventInput }> {
  if (batch.subscriptionKey !== ANCESTOR_ANNOUNCEMENT_SUBSCRIPTION_KEY) {
    throw new Error(`unexpected ancestor-announcement subscription "${batch.subscriptionKey}"`);
  }
  if (batch.configuredEvent.path !== batch.path) {
    throw new Error("ancestor-announcement delivery coordinates do not match its config event");
  }
  if (batch.configuredEvent.type !== "events.iterate.com/stream/created") {
    throw new Error("ancestor-announcement delivery was not derived from stream creation");
  }

  const births = batch.events.filter((event) => event.type === "events.iterate.com/stream/created");
  if (births.length !== 1) {
    throw new Error("ancestor-announcement delivery must contain exactly one stream birth fact");
  }
  if (
    births.some((event) => event.path !== batch.path || event.source?.crossPostedFrom !== undefined)
  ) {
    throw new Error("ancestor-announcement birth must be a first-hand fact on its source stream");
  }
  const birthPayload = births[0]!.payload as { path?: unknown; projectId?: unknown } | undefined;
  if (birthPayload?.path !== batch.path || birthPayload.projectId !== batch.projectId) {
    throw new Error("ancestor-announcement birth coordinates do not match its delivery");
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
