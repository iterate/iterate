import { describe, expect, it, vi } from "vitest";
import { POSTHOG_SUBSCRIPTION_KEY, posthogSubscriptionEvent } from "../integrations/posthog.ts";
import type { StreamPushEventBatch } from "./rpc-types.ts";
import type { StreamEvent } from "./schemas.ts";
import { StreamDurableObject } from "./stream-durable-object.ts";

describe("StreamDurableObject first-party PostHog boundaries", () => {
  it("keeps local PostHog configuration out of a mixed cross-post batch", () => {
    const stream = prototypeStream();
    const append = vi.fn();
    Object.defineProperty(stream, "append", { value: append });
    const localPosthogConfiguration = {
      ...posthogSubscriptionEvent(),
      offset: 5,
      createdAt: new Date(5).toISOString(),
      path: "/source",
    } satisfies StreamEvent;
    const ready = event(6, "events.iterate.com/repo/ready", { path: "/repos/config" }, "/source");

    expect(() =>
      stream.acceptCrossPost(crossPostBatch(undefined, [localPosthogConfiguration, ready])),
    ).not.toThrow();
    expect(append).toHaveBeenCalledOnce();
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: ready.type,
        payload: ready.payload,
        source: expect.objectContaining({ crossPostedFrom: expect.any(Array) }),
      }),
    );
  });

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
    const stream = prototypeStream();

    expect(() => stream.acceptCrossPost(crossPostBatch(transform))).toThrow(
      /managed by Iterate|reserved for first-party PostHog/,
    );
  });
});

function prototypeStream(): StreamDurableObject {
  const stream = Object.create(StreamDurableObject.prototype) as StreamDurableObject;
  Object.defineProperty(stream, "name", {
    value: { path: "/agents/ada", projectId: "prj_test" },
  });
  return stream;
}

function crossPostBatch(
  transform?: string,
  events: StreamEvent[] = [event(5, "customer/source", { value: 1 }, "/source")],
): StreamPushEventBatch {
  return {
    projectId: "prj_test",
    path: "/source",
    events,
    streamMaxOffset: events.at(-1)?.offset ?? 0,
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
        ...(transform === undefined ? {} : { params: { transform } }),
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
