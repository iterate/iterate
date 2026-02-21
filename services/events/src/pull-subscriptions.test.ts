import { describe, expect, test } from "vitest";

import {
  collectIteratorEvents,
  uniquePath,
  withTimeout,
} from "./testing/subscriptions-test-helpers.ts";
import { startEventBusTestFixture } from "./testing/orpc-test-server.ts";

const TEST_TIMEOUT_MS = 3_000;

describe("Pull subscriptions", () => {
  test("history read returns existing events in offset order", async () => {
    await using eventBus = await startEventBusTestFixture();
    const client = eventBus.client;
    const pathName = uniquePath("pull-sse-read");

    await client.append({
      path: pathName,
      events: [
        { type: "https://events.iterate.com/events/test/event-recorded", payload: { value: 1 } },
        { type: "https://events.iterate.com/events/test/event-recorded", payload: { value: 2 } },
      ],
    });

    const iterator = await client.stream({ path: pathName, live: false });
    const events = await collectIteratorEvents(iterator, 2, TEST_TIMEOUT_MS);
    await iterator.return?.();

    expect(events.map((event) => event["offset"])).toEqual([
      "0000000000000000",
      "0000000000000001",
    ]);
    expect(events[0]?.["payload"]).toEqual({ value: 1 });
    expect(events[1]?.["payload"]).toEqual({ value: 2 });
  });

  test("read with offset resumes after known offset", async () => {
    await using eventBus = await startEventBusTestFixture();
    const client = eventBus.client;
    const pathName = uniquePath("pull-sse-offset");

    await client.append({
      path: pathName,
      events: [
        { type: "https://events.iterate.com/events/test/event-recorded", payload: { value: 1 } },
        { type: "https://events.iterate.com/events/test/event-recorded", payload: { value: 2 } },
      ],
    });

    const iterator = await client.stream({
      path: pathName,
      offset: "0000000000000000",
      live: false,
    });
    const events = await collectIteratorEvents(iterator, 1, TEST_TIMEOUT_MS);
    await iterator.return?.();

    expect(events[0]?.["offset"]).toBe("0000000000000001");
    expect(events[0]?.["payload"]).toEqual({ value: 2 });
  });

  test("websocket pull stream receives live events in offset order", async () => {
    await using eventBus = await startEventBusTestFixture();
    await using websocketClientFixture = await eventBus.startWebSocketClientFixture();
    const websocketClient = websocketClientFixture.client;
    const pathName = uniquePath("pull-websocket-live");

    const iterator = await withTimeout(
      websocketClient.stream({
        path: pathName,
        live: true,
      }),
      TEST_TIMEOUT_MS,
    );

    await withTimeout(
      websocketClient.append({
        path: pathName,
        events: [
          { type: "https://events.iterate.com/events/test/event-recorded", payload: { value: 1 } },
        ],
      }),
      TEST_TIMEOUT_MS,
    );
    await withTimeout(
      websocketClient.append({
        path: pathName,
        events: [
          { type: "https://events.iterate.com/events/test/event-recorded", payload: { value: 2 } },
        ],
      }),
      TEST_TIMEOUT_MS,
    );

    const events = await withTimeout(collectIteratorEvents(iterator, 2, TEST_TIMEOUT_MS), 4_000);
    expect(events.map((event) => event["offset"])).toEqual([
      "0000000000000000",
      "0000000000000001",
    ]);
    expect(events[0]?.["payload"]).toEqual({ value: 1 });
    expect(events[1]?.["payload"]).toEqual({ value: 2 });
  });

  test("websocket pull stream and append use the same oRPC websocket transport", async () => {
    await using eventBus = await startEventBusTestFixture();
    await using websocketClientFixture = await eventBus.startWebSocketClientFixture();
    const websocketClient = websocketClientFixture.client;
    const pathName = uniquePath("pull-websocket-append");

    const iterator = await withTimeout(
      websocketClient.stream({
        path: pathName,
        live: true,
      }),
      TEST_TIMEOUT_MS,
    );

    await withTimeout(
      websocketClient.append({
        path: pathName,
        events: [
          { type: "https://events.iterate.com/events/test/event-recorded", payload: { value: 99 } },
        ],
      }),
      TEST_TIMEOUT_MS,
    );

    const events = await withTimeout(collectIteratorEvents(iterator, 1, TEST_TIMEOUT_MS), 4_000);
    expect(events[0]?.["offset"]).toBe("0000000000000000");
    expect(events[0]?.["payload"]).toEqual({ value: 99 });
  });
});
