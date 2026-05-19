import { describe, expect, test } from "vitest";
import {
  hasInactiveCallableSubscriberDeliveries,
  selectCallableSubscriberDeliveries,
  type CallableSubscriberDeliveryQueue,
} from "./callable-subscriber-delivery.ts";

describe("callable subscriber delivery scheduling", () => {
  test("selects one queued event for every inactive subscriber", () => {
    const queue: CallableSubscriberDeliveryQueue = {
      "slack-agent:project:/agents/slack/thread": [2, 3, 4, 5],
      "agent:project:/agents/slack/thread": [2, 3, 4, 5],
    };

    expect(
      selectCallableSubscriberDeliveries({
        activeSubscriberSlugs: new Set(),
        queue,
      }),
    ).toEqual([
      {
        offsets: [2, 3, 4, 5],
        subscriberSlug: "slack-agent:project:/agents/slack/thread",
      },
      {
        offsets: [2, 3, 4, 5],
        subscriberSlug: "agent:project:/agents/slack/thread",
      },
    ]);
  });

  test("lets a fast subscriber keep moving while another subscriber is still active", () => {
    const queue: CallableSubscriberDeliveryQueue = {
      "slack-agent:project:/agents/slack/thread": [3, 4, 5],
      "agent:project:/agents/slack/thread": [2, 3, 4, 5],
    };

    expect(
      selectCallableSubscriberDeliveries({
        activeSubscriberSlugs: new Set(["agent:project:/agents/slack/thread"]),
        queue,
      }),
    ).toEqual([
      {
        offsets: [3, 4, 5],
        subscriberSlug: "slack-agent:project:/agents/slack/thread",
      },
    ]);
    expect(
      hasInactiveCallableSubscriberDeliveries({
        activeSubscriberSlugs: new Set(["agent:project:/agents/slack/thread"]),
        queue,
      }),
    ).toBe(true);
  });

  test("does not select a subscriber with an active delivery", () => {
    const queue: CallableSubscriberDeliveryQueue = {
      "slack-agent:project:/agents/slack/thread": [5],
      "agent:project:/agents/slack/thread": [2],
    };
    const activeSubscriberSlugs = new Set([
      "slack-agent:project:/agents/slack/thread",
      "agent:project:/agents/slack/thread",
    ]);

    expect(
      selectCallableSubscriberDeliveries({
        activeSubscriberSlugs,
        queue,
      }),
    ).toEqual([]);
    expect(
      hasInactiveCallableSubscriberDeliveries({
        activeSubscriberSlugs,
        queue,
      }),
    ).toBe(false);
  });
});
