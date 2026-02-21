import { PUSH_SUBSCRIPTION_CALLBACK_ADDED_TYPE } from "@iterate-com/services-contracts/events";
import { describe, expect, test } from "vitest";

import { startEventBusTestFixture } from "./testing/orpc-test-server.ts";
import {
  appendSubscriptionRegistration,
  sleep,
  startTempDirFixture,
  startWebhookFixture,
  startWebSocketFixture,
  uniquePath,
  waitForDbOffset,
} from "./testing/subscriptions-test-helpers.ts";

describe("Push subscriptions", () => {
  test("registering a webhook causes registration and future events to be delivered", async () => {
    await using events = await startEventBusTestFixture();
    await using callback = await startWebhookFixture({ statusCodes: [200] });
    const client = events.client;
    const pathName = uniquePath("push-subscriptions");

    await appendSubscriptionRegistration(client, {
      path: pathName,
      callbackURL: callback.url,
      subscriptionSlug: "sub-a",
    });

    await client.append({
      path: pathName,
      events: [
        {
          type: "https://events.iterate.com/events/test/event-recorded",
          payload: { value: 42 },
        },
      ],
    });

    await callback.waitForDeliveries(2);
    const [registration, appended] = callback.bodies;

    expect(registration?.["type"]).toBe(PUSH_SUBSCRIPTION_CALLBACK_ADDED_TYPE);
    expect(registration?.["offset"]).toBe("0000000000000000");
    expect(registration?.["path"]).toBe(pathName.slice(1));
    expect(appended?.["type"]).toBe("https://events.iterate.com/events/test/event-recorded");
    expect(appended?.["offset"]).toBe("0000000000000001");
    expect(appended?.["payload"]).toEqual({ value: 42 });
  });

  test("retryPolicy.times=1 retries once when callback initially fails", async () => {
    await using events = await startEventBusTestFixture();
    await using callback = await startWebhookFixture({ statusCodes: [500, 200] });
    const client = events.client;
    const pathName = uniquePath("push-retry");

    await appendSubscriptionRegistration(client, {
      path: pathName,
      callbackURL: callback.url,
      subscriptionSlug: "sub-retry",
      retryPolicy: {
        times: 1,
        schedule: {
          type: "fixed",
          intervalMs: 1,
        },
      },
    });

    await callback.waitForDeliveries(2);
    const [first, second] = callback.bodies;

    expect(first?.["offset"]).toBe("0000000000000000");
    expect(second?.["offset"]).toBe("0000000000000000");
    expect(second?.["type"]).toBe(PUSH_SUBSCRIPTION_CALLBACK_ADDED_TYPE);
  });

  test("webhook-with-ack sends one request at a time in offset order", async () => {
    await using events = await startEventBusTestFixture();

    let releaseFirstResponse: (() => void) | undefined;
    const firstResponseGate = new Promise<void>((resolve) => {
      releaseFirstResponse = resolve;
    });

    let inflight = 0;
    let maxInflight = 0;
    await using callback = await startWebhookFixture({
      statusCodes: [200, 200, 200],
      beforeRespond: async ({ attempt }) => {
        inflight += 1;
        maxInflight = Math.max(maxInflight, inflight);
        if (attempt === 1) {
          await firstResponseGate;
        }
        inflight -= 1;
      },
    });

    const client = events.client;
    const pathName = uniquePath("push-ack-sequential");

    await appendSubscriptionRegistration(client, {
      path: pathName,
      callbackURL: callback.url,
      subscriptionSlug: "sub-ack",
      subscriptionType: "webhook-with-ack",
    });
    await client.append({
      path: pathName,
      events: [
        { type: "https://events.iterate.com/events/test/event-recorded", payload: { value: 1 } },
      ],
    });
    await client.append({
      path: pathName,
      events: [
        { type: "https://events.iterate.com/events/test/event-recorded", payload: { value: 2 } },
      ],
    });

    await sleep(100);
    expect(callback.bodies).toHaveLength(1);

    releaseFirstResponse?.();
    await callback.waitForDeliveries(3);

    expect(maxInflight).toBe(1);
    expect(callback.bodies.map((body) => body["offset"])).toEqual([
      "0000000000000000",
      "0000000000000001",
      "0000000000000002",
    ]);
  });

  test("websocket sends events in offset order", async () => {
    await using events = await startEventBusTestFixture({
      env: { ITERATE_EVENTS_WS_IDLE_DISCONNECT_MS: 20 },
    });
    await using websocketReceiver = await startWebSocketFixture();
    const client = events.client;
    const pathName = uniquePath("push-websocket");

    await appendSubscriptionRegistration(client, {
      path: pathName,
      callbackURL: websocketReceiver.url,
      subscriptionSlug: "sub-websocket",
      subscriptionType: "websocket",
    });
    await client.append({
      path: pathName,
      events: [
        { type: "https://events.iterate.com/events/test/event-recorded", payload: { value: 1 } },
      ],
    });
    await client.append({
      path: pathName,
      events: [
        { type: "https://events.iterate.com/events/test/event-recorded", payload: { value: 2 } },
      ],
    });

    await websocketReceiver.waitForEvents(3);
    expect(websocketReceiver.events.map((event) => event["offset"])).toEqual([
      "0000000000000000",
      "0000000000000001",
      "0000000000000002",
    ]);
    await sleep(100);
  });

  test("websocket receiver can append events through websocket oRPC transport", async () => {
    await using events = await startEventBusTestFixture({
      env: { ITERATE_EVENTS_WS_IDLE_DISCONNECT_MS: 20 },
    });
    const client = events.client;
    await using websocketControl = await events.startWebSocketClientFixture();
    const websocketControlClient = websocketControl.client;
    const pathName = uniquePath("push-websocket-bidirectional");

    await using websocketReceiver = await startWebSocketFixture({
      onEvent: async ({ event, attempt }) => {
        if (attempt !== 1) return;
        if (event["offset"] !== "0000000000000000") return;

        await websocketControlClient.append({
          path: pathName,
          events: [
            {
              type: "https://events.iterate.com/events/test/event-recorded",
              payload: { value: 123 },
            },
          ],
        });
      },
    });

    await appendSubscriptionRegistration(client, {
      path: pathName,
      callbackURL: websocketReceiver.url,
      subscriptionSlug: "sub-websocket-bidirectional",
      subscriptionType: "websocket",
    });

    await websocketReceiver.waitForEvents(2);
    expect(websocketReceiver.events.map((event) => event["offset"])).toEqual([
      "0000000000000000",
      "0000000000000001",
    ]);
    expect(websocketReceiver.events[1]?.["payload"]).toEqual({ value: 123 });
    await sleep(100);
  });

  test("websocket-with-ack waits for ackOffset before sending next event", async () => {
    await using events = await startEventBusTestFixture({
      env: { ITERATE_EVENTS_WS_IDLE_DISCONNECT_MS: 20 },
    });
    const client = events.client;
    await using websocketControl = await events.startWebSocketClientFixture();
    const websocketControlClient = websocketControl.client;
    const pathName = uniquePath("push-websocket-ack");
    const subscriptionSlug = "sub-websocket-ack";

    let releaseFirstAck: (() => void) | undefined;
    const firstAckGate = new Promise<void>((resolve) => {
      releaseFirstAck = resolve;
    });

    await using websocketReceiver = await startWebSocketFixture({
      onEvent: async ({ event, attempt }) => {
        if (attempt === 1) {
          await firstAckGate;
        }
        await websocketControlClient.ackOffset({
          path: pathName,
          subscriptionSlug,
          offset: String(event["offset"]),
        });
      },
    });

    await appendSubscriptionRegistration(client, {
      path: pathName,
      callbackURL: websocketReceiver.url,
      subscriptionSlug,
      subscriptionType: "websocket-with-ack",
    });
    await client.append({
      path: pathName,
      events: [
        { type: "https://events.iterate.com/events/test/event-recorded", payload: { value: 1 } },
      ],
    });
    await client.append({
      path: pathName,
      events: [
        { type: "https://events.iterate.com/events/test/event-recorded", payload: { value: 2 } },
      ],
    });

    await sleep(100);
    expect(websocketReceiver.events).toHaveLength(1);

    releaseFirstAck?.();
    await websocketReceiver.waitForEvents(3);

    expect(websocketReceiver.events.map((event) => event["offset"])).toEqual([
      "0000000000000000",
      "0000000000000001",
      "0000000000000002",
    ]);
  });

  test("jsonataFilter delivers only matching events", async () => {
    await using events = await startEventBusTestFixture();
    await using callback = await startWebhookFixture({ statusCodes: [200] });
    const client = events.client;
    const pathName = uniquePath("push-jsonata-filter");

    await appendSubscriptionRegistration(client, {
      path: pathName,
      callbackURL: callback.url,
      subscriptionSlug: "sub-jsonata-filter",
      jsonataFilter:
        "type = 'https://events.iterate.com/events/test/event-recorded' and payload.value >= 2",
    });

    await client.append({
      path: pathName,
      events: [
        { type: "https://events.iterate.com/events/test/event-recorded", payload: { value: 1 } },
      ],
    });
    await client.append({
      path: pathName,
      events: [
        { type: "https://events.iterate.com/events/test/event-recorded", payload: { value: 2 } },
      ],
    });

    await callback.waitForDeliveries(1);
    expect(callback.bodies).toHaveLength(1);
    expect(callback.bodies[0]?.["offset"]).toBe("0000000000000002");
    expect(callback.bodies[0]?.["payload"]).toEqual({ value: 2 });
  });

  test("jsonataTransform rewrites payload before delivery", async () => {
    await using events = await startEventBusTestFixture();
    await using callback = await startWebhookFixture({ statusCodes: [200] });
    const client = events.client;
    const pathName = uniquePath("push-jsonata-transform");

    await appendSubscriptionRegistration(client, {
      path: pathName,
      callbackURL: callback.url,
      subscriptionSlug: "sub-jsonata-transform",
      jsonataFilter: "type = 'https://events.iterate.com/events/test/event-recorded'",
      jsonataTransform: '{"value": value * 2}',
    });

    await client.append({
      path: pathName,
      events: [
        { type: "https://events.iterate.com/events/test/event-recorded", payload: { value: 21 } },
      ],
    });

    await callback.waitForDeliveries(1);
    expect(callback.bodies[0]?.["payload"]).toEqual({ value: 42 });
  });

  test("httpRequestHeaders are sent on webhook requests", async () => {
    await using events = await startEventBusTestFixture();
    await using callback = await startWebhookFixture({ statusCodes: [200] });
    const client = events.client;
    const pathName = uniquePath("push-http-headers-webhook");

    await appendSubscriptionRegistration(client, {
      path: pathName,
      callbackURL: callback.url,
      subscriptionSlug: "sub-http-headers-webhook",
      jsonataFilter: "type = 'https://events.iterate.com/events/test/event-recorded'",
      httpRequestHeaders: { "x-test-header": "header-value" },
    });
    await client.append({
      path: pathName,
      events: [
        { type: "https://events.iterate.com/events/test/event-recorded", payload: { value: 1 } },
      ],
    });

    await callback.waitForDeliveries(1);
    expect(callback.headers[0]?.["x-test-header"]).toBe("header-value");
  });

  test("httpRequestHeaders are sent in websocket handshake", async () => {
    await using events = await startEventBusTestFixture({
      env: { ITERATE_EVENTS_WS_IDLE_DISCONNECT_MS: 20 },
    });
    await using websocketReceiver = await startWebSocketFixture();
    const client = events.client;
    const pathName = uniquePath("push-http-headers-websocket");

    await appendSubscriptionRegistration(client, {
      path: pathName,
      callbackURL: websocketReceiver.url,
      subscriptionSlug: "sub-http-headers-websocket",
      subscriptionType: "websocket",
      httpRequestHeaders: { "x-test-header": "ws-header" },
    });
    await client.append({
      path: pathName,
      events: [
        { type: "https://events.iterate.com/events/test/event-recorded", payload: { value: 1 } },
      ],
    });

    await websocketReceiver.waitForEvents(2);
    expect(websocketReceiver.requestHeaders[0]?.["x-test-header"]).toBe("ws-header");
  });

  test("sendHistoricEventsFromOffset replays historical events on subscription", async () => {
    await using events = await startEventBusTestFixture();
    await using callback = await startWebhookFixture({ statusCodes: [200] });
    const client = events.client;
    const pathName = uniquePath("push-historic");

    await client.append({
      path: pathName,
      events: [
        { type: "https://events.iterate.com/events/test/event-recorded", payload: { value: 1 } },
      ],
    });
    await client.append({
      path: pathName,
      events: [
        { type: "https://events.iterate.com/events/test/event-recorded", payload: { value: 2 } },
      ],
    });

    await appendSubscriptionRegistration(client, {
      path: pathName,
      callbackURL: callback.url,
      subscriptionSlug: "sub-historic",
      sendHistoricEventsFromOffset: "0000000000000001",
    });
    await callback.waitForDeliveries(2);
    await client.append({
      path: pathName,
      events: [
        { type: "https://events.iterate.com/events/test/event-recorded", payload: { value: 3 } },
      ],
    });

    await callback.waitForDeliveries(3);
    expect(callback.bodies.map((body) => body["offset"])).toEqual([
      "0000000000000001",
      "0000000000000002",
      "0000000000000003",
    ]);
  });

  test("subscribe procedure appends registration event", async () => {
    await using events = await startEventBusTestFixture();
    await using callback = await startWebhookFixture({ statusCodes: [200] });
    const client = events.client;
    const pathName = uniquePath("push-subscribe-procedure");

    await client.subscribe({
      path: pathName,
      subscription: {
        type: "webhook",
        URL: callback.url,
        subscriptionSlug: "sub-via-procedure",
      },
    });
    await client.append({
      path: pathName,
      events: [
        { type: "https://events.iterate.com/events/test/event-recorded", payload: { value: 99 } },
      ],
    });

    await callback.waitForDeliveries(2);
    expect(callback.bodies.map((body) => body["offset"])).toEqual([
      "0000000000000000",
      "0000000000000001",
    ]);
  });
});

describe("Push subscriptions sqlite offsets", () => {
  test("updates last_delivered_offset after each successful delivery", async () => {
    await using tempDir = await startTempDirFixture("event-bus-push-sqlite");
    const dbPath = `${tempDir.path}/events.sqlite`;
    await using events = await startEventBusTestFixture({
      env: { DATABASE_URL: dbPath },
    });
    await using callback = await startWebhookFixture({ statusCodes: [200] });
    const client = events.client;
    const pathName = uniquePath("push-offsets");
    const streamPath = pathName.slice(1);

    await appendSubscriptionRegistration(client, {
      path: pathName,
      callbackURL: callback.url,
      subscriptionSlug: "sub-offset",
    });
    await client.append({
      path: pathName,
      events: [
        { type: "https://events.iterate.com/events/test/event-recorded", payload: { value: 1 } },
      ],
    });

    await callback.waitForDeliveries(2);
    await waitForDbOffset(dbPath, streamPath, "sub-offset", "0000000000000001");

    await client.append({
      path: pathName,
      events: [
        { type: "https://events.iterate.com/events/test/event-recorded", payload: { value: 2 } },
      ],
    });

    await callback.waitForDeliveries(3);
    await waitForDbOffset(dbPath, streamPath, "sub-offset", "0000000000000002");
  });

  test("resumes push delivery after server restart from persisted sqlite offsets", async () => {
    await using tempDir = await startTempDirFixture("event-bus-push-restart");
    const dbPath = `${tempDir.path}/events.sqlite`;
    await using callback = await startWebhookFixture({ statusCodes: [200] });
    const pathName = uniquePath("push-restart");
    const streamPath = pathName.slice(1);

    {
      await using events = await startEventBusTestFixture({
        env: { DATABASE_URL: dbPath },
      });
      const client = events.client;

      await appendSubscriptionRegistration(client, {
        path: pathName,
        callbackURL: callback.url,
        subscriptionSlug: "sub-restart",
      });
      await client.append({
        path: pathName,
        events: [
          { type: "https://events.iterate.com/events/test/event-recorded", payload: { value: 1 } },
        ],
      });

      await callback.waitForDeliveries(2);
      await waitForDbOffset(dbPath, streamPath, "sub-restart", "0000000000000001");
    }

    {
      await using restartedEvents = await startEventBusTestFixture({
        env: { DATABASE_URL: dbPath },
      });
      const restartedClient = restartedEvents.client;

      await restartedClient.append({
        path: pathName,
        events: [
          { type: "https://events.iterate.com/events/test/event-recorded", payload: { value: 2 } },
        ],
      });

      await callback.waitForDeliveries(3);
      await waitForDbOffset(dbPath, streamPath, "sub-restart", "0000000000000002");
    }

    expect(callback.bodies.map((body) => body["offset"])).toEqual([
      "0000000000000000",
      "0000000000000001",
      "0000000000000002",
    ]);
  });
});
