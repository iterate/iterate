/**
 * Dedicated runtime check for the dynamic worker POC.
 * Set `EVENTS_BASE_URL` before running the suite.
 */
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, test } from "vitest";
import { type StreamPath } from "@iterate-com/events-contract";
import { createEvents2AppFixture, requireEventsBaseUrl } from "../helpers.ts";

const eventsBaseUrl = requireEventsBaseUrl();
const app = createEvents2AppFixture({
  baseURL: eventsBaseUrl,
});
const nextEventTimeoutMs = 10_000;

describe("dynamic worker POC", () => {
  test("the dynamic worker subscribes once and appends pong for later ping events", async () => {
    const path: StreamPath = `/smoke/${Date.now().toString(36)}-dynamic-worker`;
    const stream = await app.client.stream({
      path,
      live: true,
    });
    const iterator = stream[Symbol.asyncIterator]();

    try {
      expect(await readNextEvent(iterator)).toMatchObject({
        streamPath: path,
        type: "https://events.iterate.com/events/stream/initialized",
      });

      await app.append({
        streamPath: path,
        event: {
          type: "https://events.iterate.com/events/example/value-recorded",
          payload: {
            message: "hello ping world",
          },
        },
      });

      expect(await readNextEvent(iterator)).toMatchObject({
        streamPath: path,
        type: "https://events.iterate.com/events/example/value-recorded",
        payload: {
          message: "hello ping world",
        },
      });
      expect(await readNextEvent(iterator)).toMatchObject({
        streamPath: path,
        type: "pong",
      });

      await app.append({
        streamPath: path,
        event: {
          type: "https://events.iterate.com/events/example/value-recorded",
          payload: {
            message: "plain hello world",
          },
        },
      });

      expect(await readNextEvent(iterator)).toMatchObject({
        streamPath: path,
        type: "https://events.iterate.com/events/example/value-recorded",
        payload: {
          message: "plain hello world",
        },
      });

      await app.append({
        streamPath: path,
        event: {
          type: "https://events.iterate.com/events/example/value-recorded",
          payload: {
            message: "second ping from payload",
          },
        },
      });

      expect(await readNextEvent(iterator)).toMatchObject({
        streamPath: path,
        type: "https://events.iterate.com/events/example/value-recorded",
        payload: {
          message: "second ping from payload",
        },
      });
      expect(await readNextEvent(iterator)).toMatchObject({
        streamPath: path,
        type: "pong",
      });

      expect(await app.client.getState({ path })).toEqual({
        path,
        eventCount: 6,
        metadata: {},
        processors: {
          "circuit-breaker": {
            paused: false,
            pauseReason: null,
            pausedAt: null,
            recentEventTimestamps: Array.from({ length: 6 }, () => expect.any(String)),
          },
          "jsonata-transformer": {
            transformersBySlug: {},
          },
        },
      });
    } finally {
      await iterator.return?.();
    }
  });
});

async function readNextEvent(iterator: AsyncIterator<unknown>) {
  const next = await Promise.race([
    iterator.next(),
    delay(nextEventTimeoutMs).then(() => {
      throw new Error("Timed out waiting for next dynamic worker event");
    }),
  ]);

  expect(next.done).toBe(false);
  return next.value;
}
