import { describe, expect, test, vi } from "vitest";
import {
  Event as EventSchema,
  SUBSCRIPTION_CURSOR_UPDATED_TYPE,
  SUBSCRIPTION_DELIVERY_FAILED_TYPE,
  SUBSCRIPTION_DELIVERY_SUCCEEDED_TYPE,
  SUBSCRIPTION_REMOVED_TYPE,
  SUBSCRIPTION_SET_TYPE,
  type Event as StreamEvent,
} from "@iterate-com/events-contract";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class DurableObject {
    protected ctx: DurableObjectState;
    protected env: unknown;

    constructor(ctx: DurableObjectState, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

const streamModule = await import("./stream.ts");
const { createEmptyStreamState, reduceStreamState, isInternalSubscriptionEventType } = streamModule;
type LocalStreamState = ReturnType<typeof createEmptyStreamState>;

describe("stream reducer and helpers", () => {
  test("initial state starts with no subscriptions", () => {
    expect(createEmptyStreamState()).toEqual({
      path: null,
      lastOffset: null,
      eventCount: 0,
      metadata: {},
      subscriptions: {},
    });
  });

  test("subscription.set with head creates a due webhook subscription", () => {
    const state = reduce(createEmptyStreamState(), [
      event({
        offset: "0000000000000001",
        type: SUBSCRIPTION_SET_TYPE,
        payload: {
          slug: "alpha",
          subscription: {
            type: "webhook",
            url: "https://example.com/hook",
            startFrom: "head",
          },
        },
      }),
    ]);

    expect(state.subscriptions.alpha).toMatchObject({
      type: "webhook",
      url: "https://example.com/hook",
      headers: {},
      revision: 1,
      cursor: {
        lastAcknowledgedOffset: null,
        nextDeliveryAt: "2026-01-01T00:00:00.000Z",
        retries: 0,
        lastError: null,
      },
    });
  });

  test("subscription.set with tail starts at the set event offset", () => {
    const state = reduce(createEmptyStreamState(), [
      event({
        offset: "0000000000000004",
        type: SUBSCRIPTION_SET_TYPE,
        payload: {
          slug: "alpha",
          subscription: {
            type: "webhook",
            url: "https://example.com/hook",
            startFrom: "tail",
          },
        },
      }),
    ]);

    expect(state.subscriptions.alpha?.cursor).toEqual({
      lastAcknowledgedOffset: "0000000000000004",
      nextDeliveryAt: null,
      retries: 0,
      lastError: null,
    });
    expect(state.subscriptions.alpha?.revision).toBe(1);
  });

  test("subscription.set on an existing slug rewinds the cursor", () => {
    const state = reduce(createEmptyStreamState(), [
      event({
        offset: "0000000000000001",
        type: SUBSCRIPTION_SET_TYPE,
        payload: {
          slug: "alpha",
          subscription: {
            type: "webhook",
            url: "https://example.com/one",
            startFrom: "tail",
          },
        },
      }),
      event({
        offset: "0000000000000002",
        type: SUBSCRIPTION_SET_TYPE,
        payload: {
          slug: "alpha",
          subscription: {
            type: "webhook",
            url: "https://example.com/two",
            startFrom: { afterOffset: null },
          },
        },
      }),
    ]);

    expect(state.subscriptions.alpha).toMatchObject({
      url: "https://example.com/two",
      revision: 2,
      cursor: {
        lastAcknowledgedOffset: null,
        nextDeliveryAt: "2026-01-01T00:00:00.000Z",
      },
    });
  });

  test("subscription.removed deletes the subscription entry", () => {
    const state = reduce(createEmptyStreamState(), [
      event({
        offset: "0000000000000001",
        type: SUBSCRIPTION_SET_TYPE,
        payload: {
          slug: "alpha",
          subscription: {
            type: "webhook",
            url: "https://example.com/hook",
            startFrom: "head",
          },
        },
      }),
      event({
        offset: "0000000000000002",
        type: SUBSCRIPTION_REMOVED_TYPE,
        payload: {
          slug: "alpha",
        },
      }),
    ]);

    expect(state.subscriptions).toEqual({});
  });

  test("non-internal events arm idle subscriptions", () => {
    const state = reduce(createEmptyStreamState(), [
      event({
        offset: "0000000000000001",
        type: SUBSCRIPTION_SET_TYPE,
        payload: {
          slug: "alpha",
          subscription: {
            type: "webhook",
            url: "https://example.com/hook",
            startFrom: "tail",
          },
        },
      }),
      event({
        offset: "0000000000000002",
        type: "https://events.iterate.com/events/example/value-recorded",
        payload: { value: 1 },
      }),
    ]);

    expect(state.subscriptions.alpha?.cursor.nextDeliveryAt).toBe("2026-01-01T00:00:00.000Z");
  });

  test("internal subscription events do not arm idle subscriptions", () => {
    const state = reduce(createEmptyStreamState(), [
      event({
        offset: "0000000000000001",
        type: SUBSCRIPTION_SET_TYPE,
        payload: {
          slug: "alpha",
          subscription: {
            type: "webhook",
            url: "https://example.com/hook",
            startFrom: "tail",
          },
        },
      }),
      event({
        offset: "0000000000000002",
        type: SUBSCRIPTION_DELIVERY_SUCCEEDED_TYPE,
        payload: {
          slug: "alpha",
          deliveryRevision: 1,
          deliveredEventOffset: "0000000000000001",
          observedLastOffset: "0000000000000001",
          attempted: {
            at: "2026-01-01T00:00:00.000Z",
            url: "https://example.com/hook",
            headers: {
              "content-type": "application/json",
            },
            body: {
              subscriptionSlug: "alpha",
              event: event({
                offset: "0000000000000001",
                type: SUBSCRIPTION_SET_TYPE,
                payload: {
                  slug: "alpha",
                  subscription: {
                    type: "webhook",
                    url: "https://example.com/hook",
                    startFrom: "tail",
                  },
                },
              }),
            },
          },
          response: {
            statusCode: 200,
            bodyPreview: "ok",
          },
          cursor: {
            lastAcknowledgedOffset: "0000000000000001",
            nextDeliveryAt: null,
            retries: 0,
            lastError: null,
          },
        },
      }),
    ]);

    expect(state.subscriptions.alpha?.cursor.nextDeliveryAt).toBeNull();
  });

  test("delivery-succeeded replaces the cursor exactly", () => {
    const state = reduce(createEmptyStreamState(), [
      event({
        offset: "0000000000000001",
        type: SUBSCRIPTION_SET_TYPE,
        payload: {
          slug: "alpha",
          subscription: {
            type: "webhook",
            url: "https://example.com/hook",
            startFrom: "head",
          },
        },
      }),
      event({
        offset: "0000000000000002",
        type: "https://events.iterate.com/events/example/value-recorded",
        payload: { value: 1 },
      }),
      event({
        offset: "0000000000000003",
        type: SUBSCRIPTION_DELIVERY_SUCCEEDED_TYPE,
        payload: {
          slug: "alpha",
          deliveryRevision: 1,
          deliveredEventOffset: "0000000000000002",
          observedLastOffset: "0000000000000002",
          attempted: {
            at: "2026-01-01T00:00:00.000Z",
            url: "https://example.com/hook",
            headers: {
              "content-type": "application/json",
            },
            body: {
              subscriptionSlug: "alpha",
              event: event({
                offset: "0000000000000002",
                type: "https://events.iterate.com/events/example/value-recorded",
                payload: { value: 1 },
              }),
            },
          },
          response: {
            statusCode: 200,
            bodyPreview: "ok",
          },
          cursor: {
            lastAcknowledgedOffset: "0000000000000002",
            nextDeliveryAt: null,
            retries: 0,
            lastError: null,
          },
        },
      }),
    ]);

    expect(state.subscriptions.alpha?.cursor).toEqual({
      lastAcknowledgedOffset: "0000000000000002",
      nextDeliveryAt: null,
      retries: 0,
      lastError: null,
    });
  });

  test("delivery-failed replaces the cursor exactly", () => {
    const state = reduce(createEmptyStreamState(), [
      event({
        offset: "0000000000000001",
        type: SUBSCRIPTION_SET_TYPE,
        payload: {
          slug: "alpha",
          subscription: {
            type: "webhook",
            url: "https://example.com/hook",
            startFrom: "head",
          },
        },
      }),
      event({
        offset: "0000000000000002",
        type: "https://events.iterate.com/events/example/value-recorded",
        payload: { value: 1 },
      }),
      event({
        offset: "0000000000000003",
        type: SUBSCRIPTION_DELIVERY_FAILED_TYPE,
        payload: {
          slug: "alpha",
          deliveryRevision: 1,
          deliveredEventOffset: "0000000000000002",
          observedLastOffset: "0000000000000002",
          attempted: {
            at: "2026-01-01T00:00:00.000Z",
            url: "https://example.com/hook",
            headers: {
              "content-type": "application/json",
            },
            body: {
              subscriptionSlug: "alpha",
              event: event({
                offset: "0000000000000002",
                type: "https://events.iterate.com/events/example/value-recorded",
                payload: { value: 1 },
              }),
            },
          },
          response: {
            statusCode: 500,
            bodyPreview: "nope",
            message: "Webhook failed with 500",
          },
          cursor: {
            lastAcknowledgedOffset: null,
            nextDeliveryAt: "2026-01-01T00:00:00.250Z",
            retries: 1,
            lastError: {
              message: "Webhook failed with 500",
              statusCode: 500,
              bodyPreview: "nope",
              at: "2026-01-01T00:00:00.000Z",
            },
          },
        },
      }),
    ]);

    expect(state.subscriptions.alpha?.cursor).toEqual({
      lastAcknowledgedOffset: null,
      nextDeliveryAt: "2026-01-01T00:00:00.250Z",
      retries: 1,
      lastError: {
        message: "Webhook failed with 500",
        statusCode: 500,
        bodyPreview: "nope",
        at: "2026-01-01T00:00:00.000Z",
      },
    });
  });

  test("delivery-failed payload records the attempted webhook context", () => {
    const failedEvent = event({
      offset: "0000000000000003",
      type: SUBSCRIPTION_DELIVERY_FAILED_TYPE,
      payload: {
        slug: "alpha",
        deliveryRevision: 1,
        deliveredEventOffset: "0000000000000002",
        observedLastOffset: "0000000000000002",
        attempted: {
          at: "2026-01-01T00:00:00.000Z",
          url: "https://example.com/hook",
          headers: {
            "content-type": "application/json",
            "x-test": "true",
          },
          body: {
            subscriptionSlug: "alpha",
            event: event({
              offset: "0000000000000002",
              type: "https://events.iterate.com/events/example/value-recorded",
              payload: { value: 1 },
            }),
          },
        },
        response: {
          statusCode: 500,
          bodyPreview: "nope",
          message: "Webhook failed with 500",
        },
        cursor: {
          lastAcknowledgedOffset: null,
          nextDeliveryAt: "2026-01-01T00:00:00.250Z",
          retries: 1,
          lastError: {
            message: "Webhook failed with 500",
            statusCode: 500,
            bodyPreview: "nope",
            at: "2026-01-01T00:00:00.000Z",
          },
        },
      },
    });

    const state = reduce(createEmptyStreamState(), [
      event({
        offset: "0000000000000001",
        type: SUBSCRIPTION_SET_TYPE,
        payload: {
          slug: "alpha",
          subscription: {
            type: "webhook",
            url: "https://example.com/hook",
            startFrom: "head",
          },
        },
      }),
      event({
        offset: "0000000000000002",
        type: "https://events.iterate.com/events/example/value-recorded",
        payload: { value: 1 },
      }),
      failedEvent,
    ]);

    expect(failedEvent.payload).toMatchObject({
      attempted: {
        url: "https://example.com/hook",
        headers: {
          "content-type": "application/json",
          "x-test": "true",
        },
        body: {
          subscriptionSlug: "alpha",
          event: {
            offset: "0000000000000002",
            payload: { value: 1 },
          },
        },
      },
    });
    expect(state.subscriptions.alpha?.cursor.retries).toBe(1);
  });

  test("delivery-succeeded payload records the attempted webhook context", () => {
    const succeededEvent = event({
      offset: "0000000000000003",
      type: SUBSCRIPTION_DELIVERY_SUCCEEDED_TYPE,
      payload: {
        slug: "alpha",
        deliveryRevision: 1,
        deliveredEventOffset: "0000000000000002",
        observedLastOffset: "0000000000000002",
        attempted: {
          at: "2026-01-01T00:00:00.000Z",
          url: "https://example.com/hook",
          headers: {
            "content-type": "application/json",
            "x-test": "true",
          },
          body: {
            subscriptionSlug: "alpha",
            event: event({
              offset: "0000000000000002",
              type: "https://events.iterate.com/events/example/value-recorded",
              payload: { value: 1 },
            }),
          },
        },
        response: {
          statusCode: 200,
          bodyPreview: "ok",
        },
        cursor: {
          lastAcknowledgedOffset: "0000000000000002",
          nextDeliveryAt: null,
          retries: 0,
          lastError: null,
        },
      },
    });

    const state = reduce(createEmptyStreamState(), [
      event({
        offset: "0000000000000001",
        type: SUBSCRIPTION_SET_TYPE,
        payload: {
          slug: "alpha",
          subscription: {
            type: "webhook",
            url: "https://example.com/hook",
            startFrom: "head",
          },
        },
      }),
      event({
        offset: "0000000000000002",
        type: "https://events.iterate.com/events/example/value-recorded",
        payload: { value: 1 },
      }),
      succeededEvent,
    ]);

    expect(succeededEvent.payload).toMatchObject({
      attempted: {
        url: "https://example.com/hook",
        headers: {
          "content-type": "application/json",
          "x-test": "true",
        },
        body: {
          subscriptionSlug: "alpha",
          event: {
            offset: "0000000000000002",
            payload: { value: 1 },
          },
        },
      },
    });
    expect(state.subscriptions.alpha?.cursor.lastAcknowledgedOffset).toBe("0000000000000002");
  });

  test("cursor-updated clears due state when a head subscription is caught up", () => {
    const state = reduce(createEmptyStreamState(), [
      event({
        offset: "0000000000000001",
        type: SUBSCRIPTION_SET_TYPE,
        payload: {
          slug: "alpha",
          subscription: {
            type: "webhook",
            url: "https://example.com/hook",
            startFrom: "head",
          },
        },
      }),
      event({
        offset: "0000000000000002",
        type: SUBSCRIPTION_CURSOR_UPDATED_TYPE,
        payload: {
          slug: "alpha",
          deliveryRevision: 1,
          observedLastOffset: "0000000000000001",
          reason: "caught-up",
          cursor: {
            lastAcknowledgedOffset: null,
            nextDeliveryAt: null,
            retries: 0,
            lastError: null,
          },
        },
      }),
    ]);

    expect(state.subscriptions.alpha?.cursor.nextDeliveryAt).toBeNull();
  });

  test("stale outcomes are ignored after a rewind", () => {
    const state = reduce(createEmptyStreamState(), [
      event({
        offset: "0000000000000001",
        type: SUBSCRIPTION_SET_TYPE,
        payload: {
          slug: "alpha",
          subscription: {
            type: "webhook",
            url: "https://example.com/hook",
            startFrom: "head",
          },
        },
      }),
      event({
        offset: "0000000000000002",
        type: "https://events.iterate.com/events/example/value-recorded",
        payload: { value: 1 },
      }),
      event({
        offset: "0000000000000003",
        type: SUBSCRIPTION_SET_TYPE,
        payload: {
          slug: "alpha",
          subscription: {
            type: "webhook",
            url: "https://example.com/hook",
            startFrom: "head",
          },
        },
      }),
      event({
        offset: "0000000000000004",
        type: SUBSCRIPTION_DELIVERY_SUCCEEDED_TYPE,
        payload: {
          slug: "alpha",
          deliveryRevision: 1,
          deliveredEventOffset: "0000000000000002",
          observedLastOffset: "0000000000000002",
          attempted: {
            at: "2026-01-01T00:00:00.000Z",
            url: "https://example.com/hook",
            headers: {
              "content-type": "application/json",
            },
            body: {
              subscriptionSlug: "alpha",
              event: event({
                offset: "0000000000000002",
                type: "https://events.iterate.com/events/example/value-recorded",
                payload: { value: 1 },
              }),
            },
          },
          response: {
            statusCode: 200,
            bodyPreview: "ok",
          },
          cursor: {
            lastAcknowledgedOffset: "0000000000000002",
            nextDeliveryAt: null,
            retries: 0,
            lastError: null,
          },
        },
      }),
    ]);

    expect(state.subscriptions.alpha?.revision).toBe(2);
    expect(state.subscriptions.alpha?.cursor.lastAcknowledgedOffset).toBeNull();
    expect(state.subscriptions.alpha?.cursor.nextDeliveryAt).toBe("2026-01-01T00:00:00.000Z");
  });

  test("internal event type detection only matches subscription bookkeeping", () => {
    expect(
      isInternalSubscriptionEventType("https://events.iterate.com/events/subscription/removed"),
    ).toBe(true);
    expect(
      isInternalSubscriptionEventType("https://events.iterate.com/events/example/value-recorded"),
    ).toBe(false);
  });
});

function reduce(state: LocalStreamState, events: StreamEvent[]) {
  return events.reduce<LocalStreamState>((currentState, currentEvent) => {
    return reduceStreamState({
      state: currentState,
      event: currentEvent,
    });
  }, state);
}

function event(offset: string, type: string, payload?: StreamEvent["payload"]): StreamEvent;
function event(args: {
  offset: string;
  type: string;
  payload: StreamEvent["payload"];
}): StreamEvent;
function event(
  argsOrOffset: string | { offset: string; type: string; payload: StreamEvent["payload"] },
  maybeType?: string,
  maybePayload: StreamEvent["payload"] = {},
) {
  if (typeof argsOrOffset === "string") {
    return EventSchema.parse({
      path: "/subscriptions/unit",
      offset: argsOrOffset,
      type: maybeType,
      payload: maybePayload,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  }

  return EventSchema.parse({
    path: "/subscriptions/unit",
    offset: argsOrOffset.offset,
    type: argsOrOffset.type,
    payload: argsOrOffset.payload,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
}
