/**
 * Dedicated runtime check for the dynamic worker POC.
 * Set `EVENTS_BASE_URL` before running the suite.
 */
import { describe, expect, test } from "vitest";
import { type StreamPath } from "@iterate-com/events-contract";
import {
  collectAsyncIterableUntilIdle,
  createEvents2AppFixture,
  requireEventsBaseUrl,
} from "../helpers.ts";

const eventsBaseUrl = requireEventsBaseUrl();
const app = createEvents2AppFixture({
  baseURL: eventsBaseUrl,
});
const dynamicWorkerIdleTimeoutMs = 1_000;

describe("dynamic worker POC", () => {
  test("a ping event triggers the dynamic worker to append pong", async () => {
    const path: StreamPath = `/smoke/${Date.now().toString(36)}-dynamic-worker`;

    await app.append({
      streamPath: path,
      event: {
        type: "ping",
        payload: {},
      },
    });

    const events = await collectAsyncIterableUntilIdle({
      iterable: await app.client.stream({
        path,
        live: true,
      }),
      idleMs: dynamicWorkerIdleTimeoutMs,
    });

    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      streamPath: path,
      type: "https://events.iterate.com/events/stream/initialized",
    });
    expect(events[1]).toMatchObject({
      streamPath: path,
      type: "ping",
    });
    expect(events[2]).toMatchObject({
      streamPath: path,
      type: "pong",
    });

    expect(await app.client.getState({ path })).toEqual({
      path,
      eventCount: 3,
      metadata: {},
      processors: {
        "circuit-breaker": {
          paused: false,
          pauseReason: null,
          pausedAt: null,
          recentEventTimestamps: Array.from({ length: 3 }, () => expect.any(String)),
        },
        "jsonata-transformer": {
          transformersBySlug: {},
        },
      },
    });
  });
});
