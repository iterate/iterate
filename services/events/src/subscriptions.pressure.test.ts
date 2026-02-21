import { describe, expect, test } from "vitest";
import type { EventBusContract } from "@iterate-com/services-contracts/events";

import {
  startEventBusTestFixture,
  type OrpcTestWebSocketClientFixture,
} from "./testing/orpc-test-server.ts";
import {
  appendSubscriptionRegistration,
  collectIteratorEvents,
  disposeWithTimeout,
  expectedOffsets,
  formatOffset,
  sleep,
  startWebhookFixture,
  startWebSocketFixture,
  uniquePath,
  waitUntil,
  withTimeout,
} from "./testing/subscriptions-test-helpers.ts";

const PRESSURE_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 20;

describe("Subscription pressure", () => {
  test(
    "webhook delivers large burst with no loss or duplication",
    async () => {
      await using eventBus = await startEventBusTestFixture();
      await using callback = await startWebhookFixture(
        { statusCodes: [200] },
        { timeoutMs: PRESSURE_TIMEOUT_MS, intervalMs: POLL_INTERVAL_MS },
      );
      const client = eventBus.client;
      const pathName = uniquePath("pressure-webhook-burst");
      const eventCount = 250;

      await appendSubscriptionRegistration(client, {
        path: pathName,
        callbackURL: callback.url,
        subscriptionSlug: "sub-webhook-burst",
      });

      await client.append({
        path: pathName,
        events: Array.from({ length: eventCount }, (_, index) => ({
          type: "https://events.iterate.com/events/test/event-recorded",
          payload: { value: index },
        })),
      });

      await callback.waitForDeliveries(eventCount + 1);
      expect(callback.bodies).toHaveLength(eventCount + 1);
      const receivedOffsets = callback.bodies.map((body) => String(body["offset"]));
      expect(new Set(receivedOffsets).size).toBe(eventCount + 1);
      expect(receivedOffsets.slice().sort()).toEqual(expectedOffsets(0, eventCount + 1));
    },
    PRESSURE_TIMEOUT_MS,
  );

  test(
    "webhook-with-ack stays single-flight under burst append",
    async () => {
      await using eventBus = await startEventBusTestFixture();

      let inflight = 0;
      let maxInflight = 0;
      await using callback = await startWebhookFixture(
        {
          statusCodes: [200],
          beforeRespond: async () => {
            inflight += 1;
            maxInflight = Math.max(maxInflight, inflight);
            await sleep(2);
            inflight -= 1;
          },
        },
        { timeoutMs: PRESSURE_TIMEOUT_MS, intervalMs: POLL_INTERVAL_MS },
      );

      const client = eventBus.client;
      const pathName = uniquePath("pressure-webhook-ack-burst");
      const eventCount = 120;

      await appendSubscriptionRegistration(client, {
        path: pathName,
        callbackURL: callback.url,
        subscriptionSlug: "sub-webhook-ack-burst",
        subscriptionType: "webhook-with-ack",
      });

      await client.append({
        path: pathName,
        events: Array.from({ length: eventCount }, (_, index) => ({
          type: "https://events.iterate.com/events/test/event-recorded",
          payload: { value: index },
        })),
      });

      await callback.waitForDeliveries(eventCount + 1);

      expect(maxInflight).toBe(1);
      expect(callback.bodies.map((body) => body["offset"])).toEqual(
        expectedOffsets(0, eventCount + 1),
      );
      expect(new Set(callback.bodies.map((body) => String(body["offset"]))).size).toBe(
        eventCount + 1,
      );
    },
    PRESSURE_TIMEOUT_MS,
  );

  test(
    "websocket reconnects after idle disconnect",
    async () => {
      let eventBus: Awaited<ReturnType<typeof startEventBusTestFixture>> | undefined;
      let websocketReceiver: Awaited<ReturnType<typeof startWebSocketFixture>> | undefined;

      try {
        eventBus = await startEventBusTestFixture({
          env: { ITERATE_EVENTS_WS_IDLE_DISCONNECT_MS: 200 },
        });
        websocketReceiver = await startWebSocketFixture(
          {},
          { timeoutMs: PRESSURE_TIMEOUT_MS, intervalMs: POLL_INTERVAL_MS },
        );
        const receiver = websocketReceiver;
        const client = eventBus.client;
        const pathName = uniquePath("pressure-websocket-burst-idle");
        const eventCount = 4;

        await appendSubscriptionRegistration(client, {
          path: pathName,
          callbackURL: receiver.url,
          subscriptionSlug: "sub-websocket-burst-idle",
          subscriptionType: "websocket",
        });

        await client.append({
          path: pathName,
          events: Array.from({ length: eventCount }, (_, index) => ({
            type: "https://events.iterate.com/events/test/event-recorded",
            payload: { value: index },
          })),
        });

        await receiver.waitForEvents(1);
        expect(receiver.events[0]?.["offset"]).toBe(formatOffset(0));

        await sleep(500);

        await client.append({
          path: pathName,
          events: [
            {
              type: "https://events.iterate.com/events/test/event-recorded",
              payload: { value: "after-idle" },
            },
          ],
        });

        await waitUntil(
          () =>
            receiver.events.some(
              (event) =>
                (event["payload"] as Record<string, unknown> | undefined)?.["value"] ===
                "after-idle",
            ),
          {
            timeoutMs: 5_000,
            intervalMs: POLL_INTERVAL_MS,
            timeoutMessage: "Expected post-idle websocket event to be delivered",
          },
        );
        await waitUntil(() => receiver.getConnectionCount() >= 2, {
          timeoutMs: 5_000,
          intervalMs: POLL_INTERVAL_MS,
          timeoutMessage: `Expected websocket reconnect after idle timeout, saw ${receiver.getConnectionCount()} connection(s)`,
        });
        expect(receiver.getConnectionCount()).toBeGreaterThanOrEqual(2);
      } finally {
        await disposeWithTimeout(websocketReceiver);
        await disposeWithTimeout(eventBus);
      }
    },
    PRESSURE_TIMEOUT_MS,
  );

  test(
    "websocket-with-ack handles high volume with explicit ackOffset procedure",
    async () => {
      let eventBus: Awaited<ReturnType<typeof startEventBusTestFixture>> | undefined;
      let websocketReceiver: Awaited<ReturnType<typeof startWebSocketFixture>> | undefined;
      let websocketControl: OrpcTestWebSocketClientFixture<EventBusContract> | undefined;

      try {
        eventBus = await startEventBusTestFixture({
          env: { ITERATE_EVENTS_WS_IDLE_DISCONNECT_MS: 30 },
        });
        const client = eventBus.client;
        websocketControl = await eventBus.startWebSocketClientFixture();
        const websocketControlClient = websocketControl.client;
        const pathName = uniquePath("pressure-websocket-ack-burst");
        const subscriptionSlug = "sub-websocket-ack-burst";
        const eventCount = 120;
        let ackCount = 0;

        websocketReceiver = await startWebSocketFixture(
          {
            onEvent: async ({ event }) => {
              await websocketControlClient.ackOffset({
                path: pathName,
                subscriptionSlug,
                offset: String(event["offset"]),
              });
              ackCount += 1;
            },
          },
          { timeoutMs: PRESSURE_TIMEOUT_MS, intervalMs: POLL_INTERVAL_MS },
        );

        await appendSubscriptionRegistration(client, {
          path: pathName,
          callbackURL: websocketReceiver.url,
          subscriptionSlug,
          subscriptionType: "websocket-with-ack",
        });

        await client.append({
          path: pathName,
          events: Array.from({ length: eventCount }, (_, index) => ({
            type: "https://events.iterate.com/events/test/event-recorded",
            payload: { value: index },
          })),
        });

        await websocketReceiver.waitForEvents(eventCount + 1);

        expect(websocketReceiver.events.map((event) => event["offset"])).toEqual(
          expectedOffsets(0, eventCount + 1),
        );
        expect(ackCount).toBe(eventCount + 1);
      } finally {
        await disposeWithTimeout(websocketControl);
        await disposeWithTimeout(websocketReceiver);
        await disposeWithTimeout(eventBus);
      }
    },
    PRESSURE_TIMEOUT_MS,
  );

  test(
    "jsonata filter + transform remain correct under burst",
    async () => {
      await using eventBus = await startEventBusTestFixture();
      await using callback = await startWebhookFixture(
        { statusCodes: [200] },
        { timeoutMs: PRESSURE_TIMEOUT_MS, intervalMs: POLL_INTERVAL_MS },
      );
      const client = eventBus.client;
      const pathName = uniquePath("pressure-jsonata");
      const eventCount = 90;

      await appendSubscriptionRegistration(client, {
        path: pathName,
        callbackURL: callback.url,
        subscriptionSlug: "sub-jsonata-pressure",
        jsonataFilter:
          "type = 'https://events.iterate.com/events/test/event-recorded' and payload.keep = true",
        jsonataTransform: '{"id": id, "double": value * 2}',
      });

      await client.append({
        path: pathName,
        events: Array.from({ length: eventCount }, (_, index) => ({
          type: "https://events.iterate.com/events/test/event-recorded",
          payload: {
            id: index,
            value: index,
            keep: index % 3 === 0,
          },
        })),
      });

      const matchingIndexes = Array.from({ length: eventCount }, (_, index) => index).filter(
        (index) => index % 3 === 0,
      );

      await callback.waitForDeliveries(matchingIndexes.length);

      expect(callback.bodies).toHaveLength(matchingIndexes.length);
      const expectedOffsetSet = new Set(matchingIndexes.map((index) => formatOffset(index + 1)));
      const receivedOffsetSet = new Set(callback.bodies.map((body) => String(body["offset"])));
      expect(receivedOffsetSet).toEqual(expectedOffsetSet);

      for (const body of callback.bodies) {
        const payload = body["payload"] as Record<string, unknown> | undefined;
        const id = Number(payload?.["id"]);
        const doubled = Number(payload?.["double"]);

        expect(Number.isInteger(id)).toBe(true);
        expect(matchingIndexes).toContain(id);
        expect(doubled).toBe(id * 2);
        expect(String(body["offset"])).toBe(formatOffset(id + 1));
      }
    },
    PRESSURE_TIMEOUT_MS,
  );

  test(
    "sendHistoricEventsFromOffset replays large history then continues live",
    async () => {
      await using eventBus = await startEventBusTestFixture();
      await using callback = await startWebhookFixture(
        { statusCodes: [200] },
        { timeoutMs: PRESSURE_TIMEOUT_MS, intervalMs: POLL_INTERVAL_MS },
      );
      const client = eventBus.client;
      const pathName = uniquePath("pressure-historic-replay");
      const historicalCount = 140;
      const replayFrom = 80;

      await client.append({
        path: pathName,
        events: Array.from({ length: historicalCount }, (_, index) => ({
          type: "https://events.iterate.com/events/test/event-recorded",
          payload: { value: index },
        })),
      });

      await appendSubscriptionRegistration(client, {
        path: pathName,
        callbackURL: callback.url,
        subscriptionSlug: "sub-historic-pressure",
        sendHistoricEventsFromOffset: formatOffset(replayFrom),
      });

      const expectedReplayCount = historicalCount - replayFrom + 1;
      await callback.waitForDeliveries(expectedReplayCount);

      await client.append({
        path: pathName,
        events: [
          {
            type: "https://events.iterate.com/events/test/event-recorded",
            payload: { value: "live" },
          },
        ],
      });

      await callback.waitForDeliveries(expectedReplayCount + 1);

      const offsets = callback.bodies.map((body) => String(body["offset"]));
      expect(offsets[0]).toBe(formatOffset(replayFrom));
      expect(offsets[offsets.length - 1]).toBe(formatOffset(historicalCount + 1));
      expect(callback.bodies[offsets.length - 1]?.["payload"]).toEqual({ value: "live" });
    },
    PRESSURE_TIMEOUT_MS,
  );

  test(
    "pull websocket live stream handles burst appends without gaps",
    async () => {
      await using eventBus = await startEventBusTestFixture();
      await using websocketClientFixture = await eventBus.startWebSocketClientFixture();
      const websocketClient = websocketClientFixture.client;
      const pathName = uniquePath("pressure-pull-websocket");
      const eventCount = 220;

      const iterator = await websocketClient.stream({
        path: pathName,
        live: true,
      });

      await websocketClient.append({
        path: pathName,
        events: Array.from({ length: eventCount }, (_, index) => ({
          type: "https://events.iterate.com/events/test/event-recorded",
          payload: { value: index },
        })),
      });

      const events = await withTimeout(
        collectIteratorEvents(iterator, eventCount, PRESSURE_TIMEOUT_MS),
        PRESSURE_TIMEOUT_MS,
      );

      expect(events).toHaveLength(eventCount);
      expect(events.map((event) => event["offset"])).toEqual(expectedOffsets(0, eventCount));
      expect(events[0]?.["payload"]).toEqual({ value: 0 });
      expect(events[eventCount - 1]?.["payload"]).toEqual({ value: eventCount - 1 });
    },
    PRESSURE_TIMEOUT_MS,
  );
});
