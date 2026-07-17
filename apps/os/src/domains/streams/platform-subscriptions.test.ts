import { describe, expect, it } from "vitest";
import { CoreProcessorContract } from "./core-processor-contract.ts";
import {
  PLATFORM_PUSH_DELIVERY_BATCH_WINDOW_MS,
  projectWorkerSubscriptionEvent,
  searchIndexSubscriptionEvent,
} from "./platform-subscriptions.ts";

describe("platform stream subscriptions", () => {
  it("delivers the project worker outside the stream append invocation", () => {
    const event = projectWorkerSubscriptionEvent();

    expect(event).toEqual({
      type: "events.iterate.com/stream/subscription-configured",
      payload: {
        subscriptionKey: "project-worker",
        delivery: {
          mode: "push",
          expression: ["processEventBatch"],
          batchWindowMs: PLATFORM_PUSH_DELIVERY_BATCH_WINDOW_MS,
        },
        deliver: "all",
        onPoison: "skip",
      },
    });
    expect(() =>
      CoreProcessorContract.parseEventInput(
        "events.iterate.com/stream/subscription-configured",
        event,
      ),
    ).not.toThrow();
  });

  it("coalesces search projection writes on the same durable delivery lane", () => {
    const event = searchIndexSubscriptionEvent();

    expect(event).toEqual({
      type: "events.iterate.com/stream/subscription-configured",
      payload: {
        subscriptionKey: "platform-search-index",
        delivery: {
          mode: "push",
          expression: ["indexStreamSearchBatch"],
          batchWindowMs: PLATFORM_PUSH_DELIVERY_BATCH_WINDOW_MS,
        },
        deliver: "all",
        onPoison: "park",
      },
    });
    expect(() =>
      CoreProcessorContract.parseEventInput(
        "events.iterate.com/stream/subscription-configured",
        event,
      ),
    ).not.toThrow();
  });
});
