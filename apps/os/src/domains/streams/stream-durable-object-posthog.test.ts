import { describe, expect, it } from "vitest";
import { POSTHOG_SUBSCRIPTION_KEY } from "../integrations/posthog.ts";
import type { StreamPushEventBatch } from "./rpc-types.ts";
import type { StreamEvent } from "./schemas.ts";
import { StreamDurableObject } from "./stream-durable-object.ts";

describe("StreamDurableObject first-party PostHog boundaries", () => {
  it.each([
    [
      "reserved subscription removal",
      `{ "type": "events.iterate.com/stream/subscription-removed", "payload": { "subscriptionKey": "${POSTHOG_SUBSCRIPTION_KEY}" } }`,
    ],
    [
      "durable ephemeral-delivery escalation",
      '{ "type": "events.iterate.com/stream/subscription-configured", "payload": { "subscriptionKey": "attacker", "delivery": { "mode": "push", "expression": ["processEventBatch"] }, "includeEphemeral": true } }',
    ],
  ])("rejects a cross-post transform attempting %s", (_label, transform) => {
    // This method reaches its guard before any private DO state. A prototype
    // instance keeps the test pinned to the real append boundary without
    // constructing an unrelated SQLite/storage/runtime harness. If the guard
    // disappears, the expected policy error disappears too.
    const stream = Object.create(StreamDurableObject.prototype) as StreamDurableObject;
    Object.defineProperty(stream, "name", {
      value: { path: "/agents/ada", projectId: "prj_test" },
    });

    expect(() => stream.acceptCrossPost(crossPostBatch(transform))).toThrow(
      /managed by Iterate|reserved for first-party PostHog/,
    );
  });
});

function crossPostBatch(transform: string): StreamPushEventBatch {
  return {
    projectId: "prj_test",
    path: "/source",
    events: [event(5, "customer/source", { value: 1 }, "/source")],
    streamMaxOffset: 5,
    subscriptionKey: "customer-cross-post",
    deliveryId: "customer-cross-post:5-5",
    attempt: 1,
    configuredEvent: event(
      2,
      "events.iterate.com/stream/subscription-configured",
      {
        subscriptionKey: "customer-cross-post",
        delivery: {
          mode: "push",
          expression: ["streams", ["get", "/agents/ada"], "acceptCrossPost"],
        },
        params: { transform },
      },
      "/source",
    ),
  };
}

function event(
  offset: number,
  type: string,
  payload?: Record<string, unknown>,
  path = "/agents/ada",
) {
  return {
    type,
    ...(payload === undefined ? {} : { payload }),
    offset,
    createdAt: new Date(offset).toISOString(),
    path,
  } satisfies StreamEvent;
}
