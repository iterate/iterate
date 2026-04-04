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
  requireEventsBaseUrl,
} from "../helpers.ts";

const eventsBaseUrl = process.env.CI ? "http://127.0.0.1" : requireEventsBaseUrl();
const app = createEvents2AppFixture({
  baseURL: eventsBaseUrl,
});
const postBootTimeoutMs = 2_000;
const historyIdleTimeoutMs = 250;
const PublicConfigSchema = extractPublicConfigSchema(AppConfig);
const testTimeoutMs = 5_000;
const describeRuntimeSmoke = process.env.CI ? describe.skip : describe;
describeRuntimeSmoke("events runtime smoke", () => {
  test(
    "streams page responds",
    async () => {
      const res = await app.fetch("/streams", {
        signal: AbortSignal.timeout(3_000),
      });

      expect(res.ok).toBe(true);
      expect(await res.text()).toContain("Create stream");
    },
    testTimeoutMs,
  );

  test(
    "public config and openapi docs are reachable",
    async () => {
      const config = PublicConfigSchema.parse(await app.client.common.publicConfig({}));
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

      expect(paths).toHaveProperty("/streams");
      expect(paths).toHaveProperty("/streams/{path}");
      expect(paths).toHaveProperty("/__state/{path}");
      expect(paths).not.toHaveProperty("/stream-state/{streamPath}");
      expect(paths).not.toHaveProperty("/streams/__list");
      expect(paths).not.toHaveProperty("/__state");
      expect(paths["/streams/{path}"]).toMatchObject({
        post: {
          parameters: expect.arrayContaining([
            expect.objectContaining({
              in: "query",
              name: "jsonataTransform",
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

      await app.client.append({
        params: { path },
        body: {
          type: "https://events.iterate.com/events/example/value-recorded",
          payload: { smoke: true },
        },
      });

      const streams = await app.client.listStreams({});
      expect(streams.some((stream) => stream.path === path)).toBe(true);

      const rootEvents = await collectAsyncIterableUntilIdle({
        iterable: await app.client.stream({ path: "/" }),
        idleMs: historyIdleTimeoutMs,
      });
      expect(rootEvents[0]).toMatchObject({
        streamPath: "/",
        type: "https://events.iterate.com/events/stream/initialized",
      });
      expect(await app.client.getState({ path: "/" })).toMatchObject({
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
        payload: { path },
      });
      expect(events[1]).toMatchObject({
        streamPath: path,
        offset: expectedOffset(1),
        payload: { smoke: true },
      });

      expect(await app.client.getState({ path })).toEqual({
        path,
        maxOffset: 2,
        metadata: {},
      });

      const rootHistoryResponse = await app.fetch("/api/streams/%2F");
      expect(rootHistoryResponse.status).toBe(200);
      expect(await rootHistoryResponse.text()).toContain(
        "https://events.iterate.com/events/stream/initialized",
      );

      const rootStateResponse = await app.fetch("/api/__state/%2F");
      expect(rootStateResponse.status).toBe(200);
      expect(await rootStateResponse.json()).toMatchObject({
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
          void app.client.append({
            params: { path },
            body: {
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
