/**
 * These smoke checks only talk to an externally managed worker over the network.
 * Set `EVENTS_BASE_URL` before running the suite.
 * CI skips this suite so branch test runs do not depend on deployed app smoke checks.
 */
import { setTimeout as delay } from "node:timers/promises";
import { extractPublicConfigSchema } from "@iterate-com/shared/apps/config";
import { describe, expect, test } from "vitest";
import { type StreamPath } from "@iterate-com/events-contract";
import { AppConfig } from "../../src/app.ts";
import {
  collectAsyncIterableUntilIdle,
  createEvents2AppFixture,
  defaultE2EProjectSlug,
  requireEventsBaseUrl,
} from "../helpers.ts";

const eventsBaseUrl = process.env.CI ? "http://127.0.0.1" : requireEventsBaseUrl();
const app = createEvents2AppFixture({
  baseURL: eventsBaseUrl,
});
const postBootTimeoutMs = 2_000;
const historyIdleTimeoutMs = 250;
const defaultProjectSlug = defaultE2EProjectSlug;
const PublicConfigSchema = extractPublicConfigSchema(AppConfig);
const testTimeoutMs = 10_000;
const describeRuntimeSmoke = process.env.CI ? describe.skip : describe;
describeRuntimeSmoke("events runtime smoke", () => {
  test(
    "streams page responds",
    async () => {
      const res = await app.fetch(`/streams?projectSlug=${defaultProjectSlug}`, {
        signal: AbortSignal.timeout(8_000),
      });

      expect(res.ok).toBe(true);
      expect(await res.text()).toContain("Create stream");
    },
    testTimeoutMs,
  );

  test(
    "public config and openapi docs are reachable",
    async () => {
      const config = PublicConfigSchema.parse(await app.client.__internal.publicConfig({}));
      expect(config.iterateOauth.clientId).toEqual(expect.any(String));
      expect(config.posthog.apiKey).toEqual(expect.any(String));

      const res = await app.fetch("/api/openapi.json", {
        signal: AbortSignal.timeout(3_000),
      });
      expect(res.ok).toBe(true);

      const body = (await res.json()) as {
        paths?: Record<string, unknown>;
      };

      const paths = body.paths ?? {};

      expect(paths).toHaveProperty("/streams/{path}");
      expect(paths).toHaveProperty("/streams/__state/{path}");
      expect(paths).toHaveProperty("/streams/__children/{path}");
      expect(paths).not.toHaveProperty("/streams");
      expect(paths).not.toHaveProperty("/stream-state/{streamPath}");
      expect(paths).not.toHaveProperty("/__list/{path}");
      expect(paths).not.toHaveProperty("/__state/{path}");
      expect(paths).not.toHaveProperty("/streams/__list");
      expect(paths).not.toHaveProperty("/__state");
      expect(paths["/streams/{path}"]).toMatchObject({
        post: {
          parameters: expect.arrayContaining([
            expect.objectContaining({
              in: "path",
              name: "path",
            }),
          ]),
        },
        delete: {
          parameters: expect.arrayContaining([
            expect.objectContaining({
              in: "query",
              name: "destroyChildren",
            }),
          ]),
        },
      });
    },
    testTimeoutMs,
  );

  test(
    "append, stream, getState, and live stream work over the network",
    async () => {
      const path: StreamPath = `/smoke/${Date.now().toString(36)}`;

      await app.append({
        streamPath: path,
        event: {
          type: "https://events.iterate.com/events/example/value-recorded",
          payload: { smoke: true },
        },
      });

      await waitForStream(path);

      const rootEvents = await collectAsyncIterableUntilIdle({
        iterable: await app.client.stream({ path: "/" }),
        idleMs: historyIdleTimeoutMs,
      });
      expect(rootEvents[0]).toMatchObject({
        streamPath: "/",
        type: "https://events.iterate.com/events/stream/initialized",
      });
      expect(await app.client.getState({ path: "/" })).toMatchObject({
        projectSlug: defaultProjectSlug,
        path: "/",
        metadata: {},
      });

      const events = await collectAsyncIterableUntilIdle({
        iterable: await app.client.stream({
          path,
          live: false,
        }),
        idleMs: historyIdleTimeoutMs,
      });

      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        streamPath: path,
        type: "https://events.iterate.com/events/stream/initialized",
        offset: expectedStoredOffset(0),
        payload: { projectSlug: defaultProjectSlug, path },
      });
      expect(events[1]).toMatchObject({
        streamPath: path,
        offset: expectedOffset(1),
        payload: { smoke: true },
      });

      expect(await app.client.getState({ path })).toEqual({
        projectSlug: defaultProjectSlug,
        path,
        eventCount: 2,
        childPaths: [],
        metadata: {},
        processors: expectedProcessorsWithRecentEventCount(2),
      });

      const rootHistoryResponse = await app.fetch("/api/streams/%2F");
      expect(rootHistoryResponse.status).toBe(200);
      expect(await rootHistoryResponse.text()).toContain(
        "https://events.iterate.com/events/stream/initialized",
      );

      const rootStateResponse = await app.fetch("/api/streams/__state/%2F");
      expect(rootStateResponse.status).toBe(200);
      expect(await rootStateResponse.json()).toMatchObject({
        projectSlug: defaultProjectSlug,
        path: "/",
      });

      const controller = new AbortController();
      const liveStream = await app.client.stream(
        {
          path,
          offset: expectedOffset(1),
          live: true,
        },
        { signal: controller.signal },
      );
      const iterator = liveStream[Symbol.asyncIterator]();

      try {
        setTimeout(() => {
          void app.append({
            streamPath: path,
            event: {
              type: "https://events.iterate.com/events/stream/metadata-updated",
              payload: {
                metadata: {
                  live: true,
                },
              },
            },
          });
        }, 250);

        const next = await Promise.race([
          iterator.next(),
          delay(postBootTimeoutMs).then(() => {
            throw new Error("Timed out waiting for live stream event");
          }),
        ]);

        expect(next.done).toBe(false);
        expect(next.value).toMatchObject({
          streamPath: path,
          offset: expectedOffset(2),
        });
      } finally {
        controller.abort();
        await iterator.return?.();
      }
    },
    testTimeoutMs,
  );
});

function expectedOffset(value: number) {
  return value + 1;
}

function expectedStoredOffset(value: number) {
  return value + 1;
}

function expectedProcessorsWithRecentEventCount(count: number) {
  return {
    "circuit-breaker": {
      paused: false,
      pauseReason: null,
      pausedAt: null,
      recentEventTimestamps: Array.from({ length: count }, () => expect.any(String)),
    },
    "dynamic-worker": {
      workersBySlug: {},
    },
    "jsonata-transformer": {
      transformersBySlug: {},
    },
  };
}

async function waitForStream(path: StreamPath) {
  const deadline = Date.now() + postBootTimeoutMs;

  while (Date.now() < deadline) {
    const streams = await app.client.listChildren({ path: "/" });
    const stream = streams.find((candidate) => candidate.path === path);
    if (stream) {
      return stream;
    }

    await delay(100);
  }

  throw new Error(`Timed out waiting for stream ${path}`);
}
