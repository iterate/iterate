import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, test } from "vitest";
import { StreamPath, type Event } from "@iterate-com/events-contract";
import { getNextEventOffset } from "@iterate-com/shared/events/offset";
import {
  collectAsyncIterableUntilIdle,
  createEvents2AppFixture,
  requireEventsBaseUrl,
  type Events2AppFixture,
} from "../helpers.ts";

const STREAM_INITIALIZED_EVENT_TYPE = "https://events.iterate.com/events/stream/initialized";

const app = createEvents2AppFixture({
  baseURL: requireEventsBaseUrl(),
});
const postBootTimeoutMs = 2_000;
const historyIdleTimeoutMs = 250;
const pollIntervalMs = 50;
const testTimeoutMs = 5_000;

describe.sequential("events stream e2e", () => {
  test(
    "new streams always store self stream-initialized at offset 0 before caller events",
    async () => {
      const path = uniqueStreamPath();

      const result = await app.client.append({
        path,
        type: "https://events.iterate.com/events/example/value-recorded",
        payload: { value: 42 },
      });

      expect(result.event).toMatchObject({
        path,
        offset: expectedOffset(1),
        type: "https://events.iterate.com/events/example/value-recorded",
        payload: { value: 42 },
      });

      expect(await collectStreamEvents(app, { path })).toEqual([
        {
          path,
          offset: expectedOffset(1),
          type: "https://events.iterate.com/events/example/value-recorded",
          payload: { value: 42 },
          createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        },
      ]);
      expect(await collectAllStreamEvents(app, { path })).toMatchObject([
        {
          path,
          offset: expectedStoredOffset(0),
          type: STREAM_INITIALIZED_EVENT_TYPE,
          payload: { path },
        },
        {
          path,
          offset: expectedOffset(1),
          type: "https://events.iterate.com/events/example/value-recorded",
          payload: { value: 42 },
        },
      ]);
    },
    testTimeoutMs,
  );

  test(
    "event metadata round-trips through append and replay",
    async () => {
      const path = uniqueStreamPath();

      await app.client.append({
        path,
        type: "https://events.iterate.com/events/example/value-recorded",
        payload: { value: 42 },
        metadata: {
          actor: "e2e",
          attempts: 1,
          tags: ["round-trip"],
        },
      });

      const events = await collectStreamEvents(app, { path });

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        path,
        offset: expectedOffset(1),
        type: "https://events.iterate.com/events/example/value-recorded",
        payload: { value: 42 },
        metadata: {
          actor: "e2e",
          attempts: 1,
          tags: ["round-trip"],
        },
        createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      });
    },
    testTimeoutMs,
  );

  test(
    "duplicate idempotencyKey returns the stored event instead of creating a second row",
    async () => {
      const path = uniqueStreamPath();
      const idempotencyKey = `idem-${randomUUID()}`;

      const first = await app.client.append({
        path,
        type: "https://events.iterate.com/events/example/value-recorded",
        payload: { value: 1 },
        metadata: {
          source: "first-call",
        },
        idempotencyKey,
      });

      const second = await app.client.append({
        path,
        type: "https://events.iterate.com/events/example/value-recorded",
        payload: { value: 999 },
        metadata: {
          source: "second-call",
        },
        idempotencyKey,
      });

      expect(second.event).toEqual(first.event);
      expect(await collectStreamEvents(app, { path })).toEqual([first.event]);
    },
    testTimeoutMs,
  );

  test(
    "empty idempotencyKey is rejected",
    async () => {
      const path = uniqueStreamPath();

      await expect(
        app.client.append({
          path,
          type: "https://events.iterate.com/events/example/value-recorded",
          payload: { value: 1 },
          idempotencyKey: "",
        }),
      ).rejects.toThrow(/input validation failed/i);
    },
    testTimeoutMs,
  );

  test(
    "append rejects the wrong first user offset and leaves only the synthetic self-initialized event",
    async () => {
      const path = uniqueStreamPath();

      await expect(
        app.client.append({
          path,
          type: "https://events.iterate.com/events/example/value-recorded",
          payload: { step: 1 },
          offset: expectedOffset(2),
        }),
      ).rejects.toThrow(/next generated offset/i);

      expect(await app.client.getState({ streamPath: path })).toEqual({
        initialized: true,
        path,
        lastOffset: expectedStoredOffset(0),
        eventCount: 1,
        metadata: {},
      });
      expect(await collectStreamEvents(app, { path })).toEqual([]);
      expect(await collectAllStreamEvents(app, { path })).toMatchObject([
        {
          path,
          offset: expectedStoredOffset(0),
          type: STREAM_INITIALIZED_EVENT_TYPE,
          payload: { path },
        },
      ]);
    },
    testTimeoutMs,
  );

  test(
    "append accepts the exact next offset when supplied",
    async () => {
      const path = uniqueStreamPath();

      const first = await app.client.append({
        path,
        type: "https://events.iterate.com/events/example/value-recorded",
        payload: { step: 1 },
        offset: expectedOffset(1),
      });

      const second = await app.client.append({
        path,
        type: "https://events.iterate.com/events/example/value-recorded",
        payload: { step: 2 },
        offset: expectedOffset(2),
      });

      expect(first.event.offset).toEqual(expectedOffset(1));
      expect(second.event.offset).toEqual(expectedOffset(2));
    },
    testTimeoutMs,
  );

  test(
    "idempotent retry with a stale supplied offset returns the stored event and stays quiet",
    async () => {
      const path = uniqueStreamPath();
      const idempotencyKey = `idem-${randomUUID()}`;

      const first = await app.client.append({
        path,
        type: "https://events.iterate.com/events/example/value-recorded",
        payload: { step: 1 },
        idempotencyKey,
        offset: expectedOffset(1),
      });

      const controller = new AbortController();
      const stream = await app.client.stream(
        {
          path,
          offset: first.event.offset,
          live: true,
        },
        { signal: controller.signal },
      );
      const iterator = stream[Symbol.asyncIterator]();

      try {
        const duplicate = await app.client.append({
          path,
          type: "https://events.iterate.com/events/example/value-recorded",
          payload: { step: "duplicate" },
          idempotencyKey,
          offset: expectedOffset(1),
        });

        expect(duplicate.event).toEqual(first.event);

        const next = await Promise.race([
          iterator.next().then((result) => ({ kind: "next" as const, result })),
          delay(historyIdleTimeoutMs).then(() => ({ kind: "idle" as const })),
        ]);

        expect(next).toEqual({ kind: "idle" });
      } finally {
        controller.abort();
        await iterator.return?.();
      }
    },
    testTimeoutMs,
  );

  test(
    "getState returns an empty projection for untouched streams",
    async () => {
      const path = uniqueStreamPath();

      expect(await app.client.getState({ streamPath: path })).toEqual({
        initialized: false,
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
        type: "https://events.iterate.com/events/example/value-recorded",
        payload: { step: 1 },
      });
      await app.client.append({
        path,
        type: "https://events.iterate.com/events/stream/metadata-updated",
        payload: {
          metadata: {
            owner: "first",
            stale: true,
          },
        },
      });
      await app.client.append({
        path,
        type: "https://events.iterate.com/events/stream/metadata-updated",
        payload: {
          metadata: {
            owner: "second",
          },
        },
      });

      expect(await app.client.getState({ streamPath: path })).toEqual({
        initialized: true,
        path,
        lastOffset: expectedOffset(3),
        eventCount: 4,
        metadata: {
          owner: "second",
        },
      });
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
    "first append to a nested stream initializes the chain and propagates stream-initialized events upward",
    async () => {
      const top = randomUUID().slice(0, 6);
      const second = randomUUID().slice(0, 6);
      const third = randomUUID().slice(0, 6);
      const fourth = randomUUID().slice(0, 6);
      const path = StreamPath.parse(`/${top}/${second}/${third}/${fourth}`);
      const parentPath = StreamPath.parse(`/${top}/${second}/${third}`);
      const propagatedPaths = [
        StreamPath.parse(`/${top}`),
        StreamPath.parse(`/${top}/${second}`),
        parentPath,
        path,
      ];

      await app.client.append({
        path,
        type: "https://events.iterate.com/events/example/value-recorded",
        payload: { propagated: true },
      });

      await waitForEvent(app, "/", (event) => isInitializedForPath(event, path));

      expect(await collectStreamEvents(app, { path })).toMatchObject([
        {
          path,
          offset: expectedOffset(1),
          payload: { propagated: true },
        },
      ]);

      expect(await collectAllStreamEvents(app, { path })).toMatchObject([
        {
          path,
          offset: expectedStoredOffset(0),
          type: STREAM_INITIALIZED_EVENT_TYPE,
          payload: { path },
        },
        {
          path,
          offset: expectedOffset(1),
          type: "https://events.iterate.com/events/example/value-recorded",
          payload: { propagated: true },
        },
      ]);

      const parentEvents = await collectAllStreamEvents(app, { path: parentPath });
      expect(
        parentEvents
          .filter((event) => event.type === STREAM_INITIALIZED_EVENT_TYPE)
          .map((event) => event.payload.path),
      ).toEqual([parentPath, path]);

      const rootEvents = await collectAllStreamEvents(app, { path: "/" });
      const rootPropagatedPaths = rootEvents
        .filter(
          (event) =>
            event.type === STREAM_INITIALIZED_EVENT_TYPE &&
            event.path === "/" &&
            typeof event.payload.path === "string" &&
            propagatedPaths.includes(event.payload.path as StreamPath),
        )
        .map((event) => event.payload.path);

      expect(rootPropagatedPaths).toEqual(propagatedPaths);
    },
    testTimeoutMs,
  );

  test(
    "later non-stream-initialized appends do not propagate additional stream-initialized events",
    async () => {
      const top = randomUUID().slice(0, 6);
      const second = randomUUID().slice(0, 6);
      const third = randomUUID().slice(0, 6);
      const fourth = randomUUID().slice(0, 6);
      const childPath = StreamPath.parse(`/${top}/${second}/${third}/${fourth}`);
      const parentPath = StreamPath.parse(`/${top}/${second}/${third}`);

      await app.client.append({
        path: childPath,
        type: "https://events.iterate.com/events/example/value-recorded",
        payload: { child: true },
      });

      await waitForEvent(app, "/", (event) => isInitializedForPath(event, childPath));

      const parentInitializedBefore = (
        await collectAllStreamEvents(app, { path: parentPath })
      ).filter(
        (event) => event.type === STREAM_INITIALIZED_EVENT_TYPE && event.payload.path === childPath,
      );
      const rootInitializedBefore = (await collectAllStreamEvents(app, { path: "/" })).filter(
        (event) => event.type === STREAM_INITIALIZED_EVENT_TYPE && event.payload.path === childPath,
      );

      await app.client.append({
        path: childPath,
        type: "https://events.iterate.com/events/example/value-recorded",
        payload: { child: "second" },
      });

      expect(
        (await collectAllStreamEvents(app, { path: parentPath })).filter(
          (event) =>
            event.type === STREAM_INITIALIZED_EVENT_TYPE && event.payload.path === childPath,
        ),
      ).toHaveLength(parentInitializedBefore.length);
      expect(
        (await collectAllStreamEvents(app, { path: "/" })).filter(
          (event) =>
            event.type === STREAM_INITIALIZED_EVENT_TYPE && event.payload.path === childPath,
        ),
      ).toHaveLength(rootInitializedBefore.length);
    },
    testTimeoutMs,
  );

  test(
    "offset resume starts after the requested offset",
    async () => {
      const path = uniqueStreamPath();

      await app.client.append({
        path,
        type: "https://events.iterate.com/events/example/value-recorded",
        payload: { step: 1 },
      });
      await app.client.append({
        path,
        type: "https://events.iterate.com/events/example/value-recorded",
        payload: { step: 2 },
      });
      await app.client.append({
        path,
        type: "https://events.iterate.com/events/example/value-recorded",
        payload: { step: 3 },
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
    "http append accepts offset without an event-local path",
    async () => {
      const path = uniqueStreamPath();

      const response = await app.fetch(`/api/streams${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          type: "https://events.iterate.com/events/example/value-recorded",
          payload: { via: "http" },
          offset: expectedOffset(1),
        }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        event: {
          path,
          offset: expectedOffset(1),
          payload: { via: "http" },
        },
      });
    },
    testTimeoutMs,
  );

  test(
    "http append with a stale supplied offset returns a precondition failure",
    async () => {
      const path = uniqueStreamPath();

      await app.client.append({
        path,
        type: "https://events.iterate.com/events/example/value-recorded",
        payload: { step: 1 },
      });

      const response = await app.fetch(`/api/streams${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          type: "https://events.iterate.com/events/example/value-recorded",
          payload: { step: 2 },
          offset: expectedOffset(1),
        }),
      });

      expect(response.status).toBe(412);
      expect(await response.text()).toContain("does not match next generated offset");
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

        const first = await withTimeout(iterator.next(), postBootTimeoutMs);
        const second = await withTimeout(iterator.next(), postBootTimeoutMs);

        expect(first.done).toBe(false);
        expect(first.value).toMatchObject({
          path,
          offset: expectedStoredOffset(0),
          type: STREAM_INITIALIZED_EVENT_TYPE,
          payload: { path },
        });

        expect(second.done).toBe(false);
        expect(second.value).toMatchObject({
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
  return expectedStoredOffset(value);
}

function expectedStoredOffset(value: number) {
  let offset: string | null = null;

  for (let index = 0; index <= value; index += 1) {
    offset = getNextEventOffset(offset);
  }

  if (offset == null) {
    throw new Error("expectedStoredOffset requires a non-negative integer.");
  }

  return offset;
}

async function collectStreamEvents(
  appFixture: Events2AppFixture,
  options: {
    path: StreamPath;
    offset?: string;
  },
) {
  const events = await collectAsyncIterableUntilIdle({
    iterable: await appFixture.client.stream({
      path: options.path,
      offset: options.offset,
      live: false,
    }),
    idleMs: historyIdleTimeoutMs,
  });

  return events.filter(
    (event) =>
      !(
        event.type === STREAM_INITIALIZED_EVENT_TYPE &&
        event.path === options.path &&
        event.payload.path === options.path
      ),
  );
}

async function collectAllStreamEvents(
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
    const events = await collectAllStreamEvents(appFixture, { path });
    const event = events.find(predicate);
    if (event) {
      return event;
    }

    await delay(pollIntervalMs);
  }

  throw new Error(`Timed out waiting for event in ${path}`);
}

function isInitializedForPath(event: Event, path: StreamPath) {
  return (
    event.type === STREAM_INITIALIZED_EVENT_TYPE &&
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
