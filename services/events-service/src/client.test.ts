import { describe, expect, test } from "vitest";

import { startEventBusTestFixture } from "./testing/orpc-test-server.ts";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

describe("oRPC Event Bus Client", () => {
  test("append and stream round-trip", async () => {
    await using eventBus = await startEventBusTestFixture();
    const client = eventBus.client;
    const path = "/test/roundtrip";
    const stream = await client.stream({ path, live: true });
    try {
      await sleep(10);
      await client.append({
        path,
        events: [
          {
            type: "https://events.iterate.com/events/test/event-recorded",
            payload: { message: "hello from orpc client" },
          },
        ],
      });

      const event = await stream.next();
      expect(event.done).toBe(false);
      if (event.done) throw new Error("Expected a stream event");
      expect((event.value.payload as Record<string, unknown>)["message"]).toBe(
        "hello from orpc client",
      );
    } finally {
      await stream.return?.();
    }
  });

  test("multiple events in sequence", async () => {
    await using eventBus = await startEventBusTestFixture();
    const client = eventBus.client;
    const path = "/test/sequence";
    const stream = await client.stream({ path, live: true });
    try {
      await sleep(10);
      await client.append({
        path,
        events: [
          { type: "https://events.iterate.com/events/test/event-recorded", payload: { n: 1 } },
        ],
      });
      await client.append({
        path,
        events: [
          { type: "https://events.iterate.com/events/test/event-recorded", payload: { n: 2 } },
        ],
      });
      await client.append({
        path,
        events: [
          { type: "https://events.iterate.com/events/test/event-recorded", payload: { n: 3 } },
        ],
      });

      const event1 = await stream.next();
      const event2 = await stream.next();
      const event3 = await stream.next();
      if (event1.done || event2.done || event3.done) {
        throw new Error("Expected three stream events");
      }

      expect([
        (event1.value.payload as Record<string, unknown>)["n"],
        (event2.value.payload as Record<string, unknown>)["n"],
        (event3.value.payload as Record<string, unknown>)["n"],
      ]).toEqual([1, 2, 3]);
    } finally {
      await stream.return?.();
    }
  });
});
