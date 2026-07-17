import { describe, expect, it, vi } from "vitest";
import { POSTHOG_SUBSCRIPTION_KEY, posthogSubscriptionEvent } from "../integrations/posthog.ts";
import { PROJECT_WORKER_SUBSCRIPTION_KEY } from "./core-processor-contract.ts";
import type { StreamPushEventBatch } from "./rpc-types.ts";
import type { StreamEvent } from "./schemas.ts";
import { StreamDurableObject } from "./stream-durable-object.ts";

describe("StreamDurableObject first-party PostHog boundaries", () => {
  it("installs the one fixed all-stream feed without accepting configuration", () => {
    const stream = prototypeStream();
    const configured = {
      ...posthogSubscriptionEvent(),
      offset: 6,
      createdAt: new Date(6).toISOString(),
      path: "/agents/ada",
    } satisfies StreamEvent;
    const append = vi.fn(() => [configured]);
    Object.defineProperty(stream, "append", { value: append });

    expect(stream.installFirstPartyPosthogSubscription()).toEqual(configured);
    expect(append).toHaveBeenCalledWith(posthogSubscriptionEvent());
  });

  it("constructs project group identity inside the root stream boundary", () => {
    const stream = prototypeStream("prj_test", "/");
    const projectProcessorSubscription = {
      type: "events.iterate.com/stream/subscription-configured",
      idempotencyKey: "project-processor-subscription-v1",
      payload: {
        subscriptionKey: "project-processor",
        delivery: {
          mode: "wake" as const,
          expression: ["processor", "wakeStreamSubscriber"],
        },
      },
    };
    const append = vi.fn(() => []);
    Object.defineProperty(stream, "append", { value: append });

    stream.initializeProjectRoot({
      creatorEmail: "private@example.com",
      projectProcessorSubscription,
      slug: "gold-path",
    });

    expect(append).toHaveBeenCalledWith(
      {
        type: "events.iterate.com/project/created",
        idempotencyKey: "project-created:prj_test",
        payload: {
          config: {
            creatorEmail: "private@example.com",
            onboardingActive: true,
            slug: "gold-path",
          },
        },
      },
      projectProcessorSubscription,
    );
  });

  it("keeps every local platform-subscription fact out of cross-post history", () => {
    const stream = prototypeStream();
    const append = vi.fn();
    Object.defineProperty(stream, "append", { value: append });
    const localPosthogConfiguration = {
      ...posthogSubscriptionEvent(),
      offset: 5,
      createdAt: new Date(5).toISOString(),
      path: "/source",
    } satisfies StreamEvent;
    const ready = event(10, "events.iterate.com/repo/ready", { path: "/repos/config" }, "/source");
    const localControlFacts = [
      event(
        2,
        "events.iterate.com/stream/subscription-configured",
        {
          subscriptionKey: PROJECT_WORKER_SUBSCRIPTION_KEY,
          delivery: { mode: "push", expression: ["processEventBatch"] },
          deliver: "all",
          onPoison: "skip",
        },
        "/source",
      ),
      {
        ...event(
          4,
          "events.iterate.com/project/created",
          { config: { slug: "source-project" } },
          "/source",
        ),
        idempotencyKey: "project-created:prj_test",
      },
      localPosthogConfiguration,
      event(
        7,
        "events.iterate.com/stream/subscription-parked",
        { subscriptionKey: POSTHOG_SUBSCRIPTION_KEY, atOffset: 4, attempts: 15 },
        "/source",
      ),
      event(
        8,
        "events.iterate.com/stream/subscription-resumed",
        { subscriptionKey: PROJECT_WORKER_SUBSCRIPTION_KEY },
        "/source",
      ),
      event(
        9,
        "events.iterate.com/stream/subscription-cursor-set",
        { subscriptionKey: POSTHOG_SUBSCRIPTION_KEY, afterOffset: 0 },
        "/source",
      ),
    ];

    expect(() =>
      stream.acceptCrossPost(crossPostBatch(undefined, [...localControlFacts, ready])),
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
      "project-worker removal",
      `{ "type": "events.iterate.com/stream/subscription-removed", "payload": { "subscriptionKey": "${PROJECT_WORKER_SUBSCRIPTION_KEY}" } }`,
    ],
    [
      "project birth",
      '{ "type": "events.iterate.com/project/created", "payload": { "config": { "slug": "forged" } } }',
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

function prototypeStream(projectId: string | null = "prj_test", path = "/agents/ada") {
  const stream = Object.create(StreamDurableObject.prototype) as StreamDurableObject;
  Object.defineProperty(stream, "name", {
    value: { path, projectId },
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
