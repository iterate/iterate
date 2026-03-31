import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, test } from "vitest";
import {
  STREAM_CREATED_TYPE,
  STREAM_METADATA_UPDATED_TYPE,
  StreamPath,
  type Event,
  type StreamState,
} from "@iterate-com/events-contract";
import {
  collectAsyncIterableUntilIdle,
  createEvents2AppFixture,
  requireEventsBaseUrl,
  type Events2AppFixture,
} from "../helpers.ts";

const app = createEvents2AppFixture({
  baseURL: requireEventsBaseUrl(),
});
const postBootTimeoutMs = 2_000;
const historyIdleTimeoutMs = 250;
const pollIntervalMs = 50;
const testTimeoutMs = 5_000;

describe.sequential("events stream e2e", () => {
  test(
    "append via HTTP and replay via stream",
    async () => {
      const path = uniqueStreamPath();

      await app.client.append({
        path,
        type: "https://events.iterate.com/events/example/value-recorded",
        payload: { value: 42 },
      });

      const events = await collectStreamEvents(app, { path });

      expect(events).toEqual([
        {
          path,
          offset: expectedOffset(1),
          type: "https://events.iterate.com/events/example/value-recorded",
          payload: { value: 42 },
          createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        },
      ]);
    },
    testTimeoutMs,
  );

  test(
    "url-encoded slashes in path params resolve to nested stream paths",
    async () => {
      const path = StreamPath.parse(`/e2e/${randomUUID().slice(0, 6)}/${randomUUID().slice(0, 6)}`);
      const encodedPath = path.slice(1).replaceAll("/", "%2F");

      const appendResponse = await app.fetch(`/api/streams/${encodedPath}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          type: "https://events.iterate.com/events/example/value-recorded",
          payload: { encoded: true },
        }),
      });

      expect(appendResponse.status).toBe(200);
      expect(await appendResponse.json()).toMatchObject({
        created: true,
        events: [
          {
            path,
            payload: { encoded: true },
          },
        ],
      });

      const stateResponse = await app.fetch(`/api/stream-state/${encodedPath}`);

      expect(stateResponse.status).toBe(200);
      expect(await stateResponse.json()).toMatchObject({
        path,
        eventCount: 1,
      });
    },
    testTimeoutMs,
  );

  test(
    "append multiple assigns generated offsets in order",
    async () => {
      const path = uniqueStreamPath();

      await app.client.append({
        path,
        events: [
          {
            path,
            type: "https://events.iterate.com/events/example/value-recorded",
            payload: { value: 1 },
          },
          {
            path,
            type: "https://events.iterate.com/events/example/value-recorded",
            payload: { value: 2 },
          },
          {
            path,
            type: "https://events.iterate.com/events/example/value-recorded",
            payload: { value: 3 },
          },
        ],
      });

      const events = await collectStreamEvents(app, { path });

      expect(events.map((event) => event.offset)).toEqual([
        expectedOffset(1),
        expectedOffset(2),
        expectedOffset(3),
      ]);
      expect(events.map((event) => event.payload)).toEqual([
        { value: 1 },
        { value: 2 },
        { value: 3 },
      ]);
    },
    testTimeoutMs,
  );

  test(
    "getState returns an empty projection for untouched streams",
    async () => {
      const path = uniqueStreamPath();

      expect(await app.client.getState({ streamPath: path })).toEqual({
        path: null,
        lastOffset: null,
        eventCount: 0,
        metadata: {},
      });
    },
    testTimeoutMs,
  );

  test(
    "metadata update events replace reduced metadata",
    async () => {
      const path = uniqueStreamPath();

      await app.client.append({
        path,
        events: [
          {
            path,
            type: "https://events.iterate.com/events/example/value-recorded",
            payload: { step: 1 },
          },
          {
            path,
            type: STREAM_METADATA_UPDATED_TYPE,
            payload: {
              metadata: {
                owner: "first",
                stale: true,
              },
            },
          },
          {
            path,
            type: STREAM_METADATA_UPDATED_TYPE,
            payload: {
              metadata: {
                owner: "second",
              },
            },
          },
        ],
      });

      expect(await app.client.getState({ streamPath: path })).toEqual({
        path,
        lastOffset: expectedOffset(3),
        eventCount: 3,
        metadata: {
          owner: "second",
        },
      } satisfies StreamState);
    },
    testTimeoutMs,
  );

  test(
    "listStreams reads discovered paths from the root stream",
    async () => {
      const path = uniqueStreamPath();

      await app.client.append({
        path,
        type: "https://events.iterate.com/events/example/value-recorded",
        payload: { listed: true },
      });

      const stream = await waitForStream(app, path);

      expect(stream.createdAt).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/));
    },
    testTimeoutMs,
  );

  test(
    "root stream is explicitly listed as a known system stream",
    async () => {
      const streams = await app.client.listStreams({});

      expect(streams.some((stream) => stream.path === "/")).toBe(true);
    },
    testTimeoutMs,
  );

  test(
    "first append propagates stream-created events to parent paths",
    async () => {
      const path = StreamPath.parse(
        `/agents/${randomUUID().slice(0, 6)}/${randomUUID().slice(0, 6)}`,
      );
      const parentPath = StreamPath.parse(path.slice(0, path.lastIndexOf("/")));

      await app.client.append({
        path,
        type: "https://events.iterate.com/events/example/value-recorded",
        payload: { propagated: true },
      });

      const rootEvent = await waitForEvent(app, "/", (event) => isCreatedForPath(event, path));
      const parentEvent = await waitForEvent(app, parentPath, (event) =>
        isCreatedForPath(event, path),
      );

      expect(rootEvent.type).toBe(STREAM_CREATED_TYPE);
      expect(parentEvent.type).toBe(STREAM_CREATED_TYPE);
    },
    testTimeoutMs,
  );

  test(
    "existing parent still ladders child stream-created events up to root",
    async () => {
      const parentPath = StreamPath.parse("/banana");
      const childPath = StreamPath.parse("/banana/banana");

      await app.client.append({
        path: parentPath,
        type: "https://events.iterate.com/events/example/value-recorded",
        payload: { parent: true },
      });

      await waitForEvent(app, "/", (event) => isCreatedForPath(event, parentPath));

      await app.client.append({
        path: childPath,
        type: "https://events.iterate.com/events/example/value-recorded",
        payload: { child: true },
      });

      const parentEvent = await waitForEvent(app, parentPath, (event) =>
        isCreatedForPath(event, childPath),
      );
      const rootEvent = await waitForEvent(app, "/", (event) => isCreatedForPath(event, childPath));

      expect(parentEvent.type).toBe(STREAM_CREATED_TYPE);
      expect(rootEvent.type).toBe(STREAM_CREATED_TYPE);
    },
    testTimeoutMs,
  );

  test(
    "streams stay isolated by path",
    async () => {
      const pathA = uniqueStreamPath();
      const pathB = uniqueStreamPath();

      await app.client.append({
        path: pathA,
        type: "https://events.iterate.com/events/example/value-recorded",
        payload: { label: "A" },
      });
      await app.client.append({
        path: pathB,
        type: "https://events.iterate.com/events/example/value-recorded",
        payload: { label: "B" },
      });

      const eventsA = await collectStreamEvents(app, { path: pathA });
      const eventsB = await collectStreamEvents(app, { path: pathB });

      expect(eventsA.map((event) => event.payload)).toEqual([{ label: "A" }]);
      expect(eventsB.map((event) => event.payload)).toEqual([{ label: "B" }]);
    },
    testTimeoutMs,
  );

  test(
    "offset resume starts after the requested offset",
    async () => {
      const path = uniqueStreamPath();

      await app.client.append({
        path,
        events: [
          {
            path,
            type: "https://events.iterate.com/events/example/value-recorded",
            payload: { step: 1 },
          },
          {
            path,
            type: "https://events.iterate.com/events/example/value-recorded",
            payload: { step: 2 },
          },
          {
            path,
            type: "https://events.iterate.com/events/example/value-recorded",
            payload: { step: 3 },
          },
        ],
      });

      const resumed = await collectStreamEvents(app, {
        path,
        offset: expectedOffset(1),
      });

      expect(resumed.map((event) => event.payload)).toEqual([{ step: 2 }, { step: 3 }]);
    },
    testTimeoutMs,
  );

  test(
    "append validates non-empty event batches",
    async () => {
      const path = uniqueStreamPath();

      const error = await app.client
        .append({
          path,
          events: [],
        })
        .catch((caught) => caught);

      expect(String(error)).toContain("Input validation failed");
      expect(JSON.stringify(error)).toContain("events");
    },
    testTimeoutMs,
  );

  test(
    "live stream receives events appended after subscription",
    async () => {
      const path = uniqueStreamPath();
      const controller = new AbortController();
      const stream = await app.client.stream(
        {
          path,
          live: true,
        },
        { signal: controller.signal },
      );
      const iterator = stream[Symbol.asyncIterator]();

      try {
        setTimeout(() => {
          void app.client.append({
            path,
            type: "https://events.iterate.com/events/example/value-recorded",
            payload: { live: true },
          });
        }, 250);

        const next = await withTimeout(iterator.next(), postBootTimeoutMs);

        expect(next.done).toBe(false);
        expect(next.value).toMatchObject({
          path,
          offset: expectedOffset(1),
          payload: { live: true },
        });
      } finally {
        controller.abort();
        await iterator.return?.();
      }
    },
    testTimeoutMs,
  );
});

function uniqueStreamPath() {
  return StreamPath.parse(`/e2e/${randomUUID().slice(0, 8)}`);
}

function expectedOffset(value: number) {
  return String(value).padStart(16, "0");
}

async function collectStreamEvents(
  appFixture: Events2AppFixture,
  options: {
    path: StreamPath;
    offset?: string;
  },
) {
  return await collectAsyncIterableUntilIdle({
    iterable: await appFixture.client.stream({
      path: options.path,
      offset: options.offset,
      live: false,
    }),
    idleMs: historyIdleTimeoutMs,
  });
}

async function waitForStream(appFixture: Events2AppFixture, path: StreamPath) {
  const deadline = Date.now() + postBootTimeoutMs;

  while (Date.now() < deadline) {
    const streams = await appFixture.client.listStreams({});
    const stream = streams.find((candidate) => candidate.path === path);
    if (stream) {
      return stream;
    }

    await delay(pollIntervalMs);
  }

  throw new Error(`Timed out waiting for stream ${path}`);
}

async function waitForEvent(
  appFixture: Events2AppFixture,
  path: StreamPath,
  predicate: (event: Event) => boolean,
) {
  const deadline = Date.now() + postBootTimeoutMs;

  while (Date.now() < deadline) {
    const events = await collectStreamEvents(appFixture, { path });
    const event = events.find(predicate);
    if (event) {
      return event;
    }

    await delay(pollIntervalMs);
  }

  throw new Error(`Timed out waiting for event in ${path}`);
}

function isCreatedForPath(event: Event, path: StreamPath) {
  return (
    event.type === STREAM_CREATED_TYPE &&
    typeof event.payload.path === "string" &&
    event.payload.path === path
  );
}

async function withTimeout<T>(promise: Promise<T>, ms: number) {
  return await Promise.race([
    promise,
    delay(ms).then(() => {
      throw new Error(`Timed out after ${ms}ms`);
    }),
  ]);
}
