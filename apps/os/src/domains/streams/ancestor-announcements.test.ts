import { describe, expect, it } from "vitest";
import type { StreamEvent, StreamPushEventBatch } from "iterate/processors";
import {
  ANCESTOR_ANNOUNCEMENT_REQUESTED_EVENT_TYPE,
  ANCESTOR_ANNOUNCEMENT_SUBSCRIPTION_KEY,
  ancestorAnnouncementSetupEvents,
  ancestorPaths,
  buildAncestorAnnouncementAppends,
  isAncestorAnnouncementPlatformEvent,
} from "./ancestor-announcements.ts";

describe("durable ancestor announcements", () => {
  it("installs a push obligation with its request after the initial cursor", () => {
    const [configured, requested] = ancestorAnnouncementSetupEvents();

    expect(configured).toMatchObject({
      type: "events.iterate.com/stream/subscription-configured",
      payload: {
        subscriptionKey: ANCESTOR_ANNOUNCEMENT_SUBSCRIPTION_KEY,
        delivery: {
          mode: "push",
          expression: ["streams", ["get", "/"], "acceptAncestorAnnouncements"],
        },
        selector: { eventTypes: [ANCESTOR_ANNOUNCEMENT_REQUESTED_EVENT_TYPE] },
      },
    });
    expect(requested).toEqual({
      type: ANCESTOR_ANNOUNCEMENT_REQUESTED_EVENT_TYPE,
      payload: {},
    });
  });

  it("targets root and every proper ancestor with stable idempotency keys", () => {
    const batch = announcementBatch("/agents/slack/thread");

    expect(buildAncestorAnnouncementAppends(batch)).toEqual([
      announcement("/", batch.path),
      announcement("/agents", batch.path),
      announcement("/agents/slack", batch.path),
    ]);
  });

  it("rejects a delivery that did not come from the internal subscription", () => {
    expect(() =>
      buildAncestorAnnouncementAppends({
        ...announcementBatch("/child"),
        subscriptionKey: "user-controlled",
      }),
    ).toThrow('unexpected ancestor-announcement subscription "user-controlled"');
  });

  it("identifies platform-owned trigger and subscription lifecycle facts", () => {
    const [configured, requested] = ancestorAnnouncementSetupEvents();
    expect(isAncestorAnnouncementPlatformEvent(configured)).toBe(true);
    expect(isAncestorAnnouncementPlatformEvent(requested)).toBe(true);
    expect(
      isAncestorAnnouncementPlatformEvent({
        type: "events.iterate.com/stream/subscription-cursor-set",
        payload: {
          subscriptionKey: ANCESTOR_ANNOUNCEMENT_SUBSCRIPTION_KEY,
          afterOffset: 10,
        },
      }),
    ).toBe(true);
    expect(
      isAncestorAnnouncementPlatformEvent({
        type: "events.iterate.com/stream/subscription-removed",
        payload: { subscriptionKey: "user-owned" },
      }),
    ).toBe(false);
    expect(
      isAncestorAnnouncementPlatformEvent({
        type: "events.iterate.test/product-event",
        payload: { subscriptionKey: ANCESTOR_ANNOUNCEMENT_SUBSCRIPTION_KEY },
      }),
    ).toBe(false);
  });

  it("treats the root as having no ancestors", () => {
    expect(ancestorPaths("/")).toEqual([]);
  });
});

function announcement(path: string, childPath: string) {
  return {
    path,
    event: {
      type: "events.iterate.com/stream/child-stream-created",
      idempotencyKey: `child-stream-created:${path}:${childPath}`,
      payload: { childPath },
    },
  };
}

function announcementBatch(path: string): StreamPushEventBatch {
  const requested: StreamEvent = {
    type: ANCESTOR_ANNOUNCEMENT_REQUESTED_EVENT_TYPE,
    payload: {},
    path,
    offset: 4,
    createdAt: "2026-07-18T00:00:00.000Z",
  };
  return {
    projectId: "prj_test",
    path,
    events: [requested],
    streamMaxOffset: 4,
    subscriptionKey: ANCESTOR_ANNOUNCEMENT_SUBSCRIPTION_KEY,
    deliveryId: `${ANCESTOR_ANNOUNCEMENT_SUBSCRIPTION_KEY}:4-4`,
    attempt: 1,
    configuredEvent: {
      type: "events.iterate.com/stream/subscription-configured",
      offset: 3,
      createdAt: "2026-07-18T00:00:00.000Z",
      path,
      payload: {
        subscriptionKey: ANCESTOR_ANNOUNCEMENT_SUBSCRIPTION_KEY,
      },
    },
  };
}
