import { describe, expect, test } from "vitest";

import { startEventBusTestFixture } from "./testing/orpc-test-server.ts";
import {
  collectSseDataEvents,
  sleep,
  toSseBaseURL,
  uniquePath,
} from "./testing/subscriptions-test-helpers.ts";

const TEST_TIMEOUT_MS = 5_000;
const FIREHOSE_TEST_EVENT_TYPE = "https://events.iterate.com/events/test/firehose-event-recorded";

describe("Firehose pull stream", () => {
  test("SSE firehose emits live events from multiple stream paths", async () => {
    await using eventBus = await startEventBusTestFixture();
    const client = eventBus.client;
    const streamA = uniquePath("firehose-stream-a");
    const streamB = uniquePath("firehose-stream-b");

    await client.append({
      path: streamA,
      events: [{ type: FIREHOSE_TEST_EVENT_TYPE, payload: { seed: "a" } }],
    });
    await client.append({
      path: streamB,
      events: [{ type: FIREHOSE_TEST_EVENT_TYPE, payload: { seed: "b" } }],
    });

    const firehoseUrl = `${toSseBaseURL(eventBus.url)}/api/firehose`;
    const firehoseEventsPromise = collectSseDataEvents(firehoseUrl, 2, TEST_TIMEOUT_MS);

    await sleep(50);

    await client.append({
      path: streamA,
      events: [{ type: FIREHOSE_TEST_EVENT_TYPE, payload: { stream: "a", value: 1 } }],
    });
    await client.append({
      path: streamB,
      events: [{ type: FIREHOSE_TEST_EVENT_TYPE, payload: { stream: "b", value: 2 } }],
    });

    const events = await firehoseEventsPromise;

    expect(events).toHaveLength(2);
    expect(events.map((event) => event["type"])).toEqual([
      FIREHOSE_TEST_EVENT_TYPE,
      FIREHOSE_TEST_EVENT_TYPE,
    ]);
    expect(events.map((event) => event["path"])).toEqual([streamA.slice(1), streamB.slice(1)]);
    expect(events.map((event) => event["payload"])).toEqual([
      { stream: "a", value: 1 },
      { stream: "b", value: 2 },
    ]);
  });

  test("SSE firehose is live-only and does not replay historic events", async () => {
    await using eventBus = await startEventBusTestFixture();
    const client = eventBus.client;
    const path = uniquePath("firehose-live-only");

    await client.append({
      path,
      events: [{ type: FIREHOSE_TEST_EVENT_TYPE, payload: { phase: "historic" } }],
    });

    const firehoseUrl = `${toSseBaseURL(eventBus.url)}/api/firehose`;
    const firehoseEventsPromise = collectSseDataEvents(firehoseUrl, 1, TEST_TIMEOUT_MS);

    await sleep(50);

    await client.append({
      path,
      events: [{ type: FIREHOSE_TEST_EVENT_TYPE, payload: { phase: "live" } }],
    });

    const [event] = await firehoseEventsPromise;
    expect(event?.["payload"]).toEqual({ phase: "live" });
    expect(event?.["offset"]).toBe("0000000000000001");
    expect(event?.["path"]).toBe(path.slice(1));
  });
});
