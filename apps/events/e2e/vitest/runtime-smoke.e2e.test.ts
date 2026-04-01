/**
 * These smoke checks only talk to an externally managed worker over the network.
 * Set `EVENTS_BASE_URL` before running the suite.
 * CI skips this suite so branch test runs do not depend on deployed app smoke checks.
 */
import { setTimeout as delay } from "node:timers/promises";
import { extractPublicConfigSchema } from "@iterate-com/shared/apps/config";
import { getNextEventOffset } from "@iterate-com/shared/events/offset";
import { describe, expect, test } from "vitest";
import {
  STREAM_METADATA_UPDATED_TYPE,
  type StreamPath,
  type StreamState,
} from "@iterate-com/events-contract";
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

      expect(body.paths).toHaveProperty("/streams");
      expect(body.paths).toHaveProperty("/streams/{path}");
      expect(body.paths).toHaveProperty("/stream-state/{streamPath}");
    },
    testTimeoutMs,
  );

  test(
    "append, stream, getState, and live stream work over the network",
    async () => {
      const path: StreamPath = `/smoke/${Date.now().toString(36)}`;

      await app.client.append({
        path,
        type: "https://events.iterate.com/events/example/value-recorded",
        payload: { smoke: true },
      });

      const streams = await app.client.listStreams({});
      expect(streams.some((stream) => stream.path === path)).toBe(true);

      const events = await collectAsyncIterableUntilIdle({
        iterable: await app.client.stream({
          path,
          live: false,
        }),
        idleMs: historyIdleTimeoutMs,
      });

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        path,
        offset: expectedOffset(1),
        payload: { smoke: true },
      });

      expect(await app.client.getState({ streamPath: path })).toEqual({
        path,
        lastOffset: expectedOffset(1),
        eventCount: 1,
        metadata: {},
      } satisfies StreamState);

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
            path,
            type: STREAM_METADATA_UPDATED_TYPE,
            payload: {
              metadata: {
                live: true,
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
          path,
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
  let offset: string | null = null;

  for (let index = 0; index < value; index += 1) {
    offset = getNextEventOffset(offset);
  }

  if (offset == null) {
    throw new Error("expectedOffset requires a positive integer.");
  }

  return offset;
}
