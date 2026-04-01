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

      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.events).toEqual(first.events);

      const events = await collectStreamEvents(app, { path });

      expect(events).toEqual(first.events);
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
      ).rejects.toThrow(/idempotency/i);
    },
    testTimeoutMs,
  );

  test(
    "different idempotency keys create distinct events",
    async () => {
      const path = uniqueStreamPath();

      const first = await app.client.append({
        path,
        type: "https://events.iterate.com/events/example/value-recorded",
        payload: { step: 1 },
        idempotencyKey: `idem-${randomUUID()}`,
      });

      const second = await app.client.append({
        path,
        type: "https://events.iterate.com/events/example/value-recorded",
        payload: { step: 2 },
        idempotencyKey: `idem-${randomUUID()}`,
      });

      expect(first.events[0]?.offset).toEqual(expectedOffset(1));
      expect(second.events[0]?.offset).toEqual(expectedOffset(2));

      const events = await collectStreamEvents(app, { path });

      expect(events.map((event) => event.payload)).toEqual([{ step: 1 }, { step: 2 }]);
    },
    testTimeoutMs,
  );

  test(
    "duplicate idempotencyKey does not publish a second live event",
    async () => {
      const path = uniqueStreamPath();
      const idempotencyKey = `idem-${randomUUID()}`;

      const first = await app.client.append({
        path,
        type: "https://events.iterate.com/events/example/value-recorded",
        payload: { step: "initial" },
        idempotencyKey,
      });

      const controller = new AbortController();
      const stream = await app.client.stream(
        {
          path,
          offset: first.events[0]?.offset,
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
        });

        expect(duplicate.events).toEqual(first.events);

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
    "batch append applies idempotency per event",
    async () => {
      const path = uniqueStreamPath();
      const existingKey = `idem-${randomUUID()}`;
      const batchKey = `idem-${randomUUID()}`;

      const existing = await app.client.append({
        path,
        type: "https://events.iterate.com/events/example/value-recorded",
        payload: { step: "existing" },
        idempotencyKey: existingKey,
      });

      const batch = await app.client.append({
        path,
        events: [
          {
            path,
            type: "https://events.iterate.com/events/example/value-recorded",
            payload: { step: "ignored-duplicate" },
            idempotencyKey: existingKey,
          },
          {
            path,
            type: "https://events.iterate.com/events/example/value-recorded",
            payload: { step: "new-in-batch" },
            idempotencyKey: batchKey,
          },
          {
            path,
            type: "https://events.iterate.com/events/example/value-recorded",
            payload: { step: "ignored-same-batch-duplicate" },
            idempotencyKey: batchKey,
          },
        ],
      });

      expect(batch.created).toBe(false);
      expect(batch.events).toHaveLength(3);
      expect(batch.events[0]).toEqual(existing.events[0]);
      expect(batch.events[1]?.offset).toEqual(expectedOffset(2));
      expect(batch.events[1]?.payload).toEqual({ step: "new-in-batch" });
      expect(batch.events[2]).toEqual(batch.events[1]);

      const events = await collectStreamEvents(app, { path });

      expect(events.map((event) => event.offset)).toEqual([expectedOffset(1), expectedOffset(2)]);
      expect(events.map((event) => event.payload)).toEqual([
        { step: "existing" },
        { step: "new-in-batch" },
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
    "destroy wipes an existing stream and resets its projection",
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
                owner: "destroy-me",
              },
            },
          },
        ],
      });

      expect(await app.client.destroy({ path })).toEqual({
        path,
        lastOffset: expectedOffset(2),
        eventCount: 2,
        metadata: {
          owner: "destroy-me",
        },
      });

      expect(await collectStreamEvents(app, { path })).toEqual([]);
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
    "destroy reports deleted false for an untouched stream",
    async () => {
      const path = uniqueStreamPath();

      expect(await app.client.destroy({ path })).toEqual({
        path: null,
        lastOffset: null,
        eventCount: 0,
        metadata: {},
      });
    },
    testTimeoutMs,
  );

  test(
    "destroyed streams can be recreated from offset one",
    async () => {
      const path = uniqueStreamPath();

      await app.client.append({
        path,
        type: "https://events.iterate.com/events/example/value-recorded",
        payload: { beforeDestroy: true },
      });

      await app.client.destroy({ path });

      const recreated = await app.client.append({
        path,
        type: "https://events.iterate.com/events/example/value-recorded",
        payload: { afterDestroy: true },
      });

      expect(recreated.created).toBe(true);
      expect(recreated.events[0]).toMatchObject({
        path,
        offset: expectedOffset(1),
        payload: { afterDestroy: true },
      });
      expect(await collectStreamEvents(app, { path })).toEqual(recreated.events);
    },
    testTimeoutMs,
  );

  test(
    "destroy only wipes the targeted stream",
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

      await app.client.destroy({ path: pathA });

      expect(await collectStreamEvents(app, { path: pathA })).toEqual([]);
      expect(await collectStreamEvents(app, { path: pathB })).toEqual([
        expect.objectContaining({
          path: pathB,
          payload: { label: "B" },
        }),
      ]);
    },
    testTimeoutMs,
  );

  test(
    "destroy does not remove stale discovery entries from listStreams",
    async () => {
      const path = uniqueStreamPath();

      await app.client.append({
        path,
        type: "https://events.iterate.com/events/example/value-recorded",
        payload: { listed: true },
      });

      await waitForStream(app, path);
      await app.client.destroy({ path });

      const streams = await app.client.listStreams({});

      expect(streams.some((stream) => stream.path === path)).toBe(true);
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
    "destroy rejects the root stream",
    async () => {
      await expect(app.client.destroy({ path: "/" })).rejects.toThrow(/root stream/i);
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
    "append rejects array metadata",
    async () => {
      const path = uniqueStreamPath();

      const response = await app.fetch(`/api/streams${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          type: "https://events.iterate.com/events/example/value-recorded",
          payload: { value: 1 },
          metadata: ["not", "an", "object"],
        }),
      });

      expect(response.ok).toBe(false);
      expect(await response.text()).toContain("metadata");
    },
    testTimeoutMs,
  );

  test(
    "append rejects scalar metadata",
    async () => {
      const path = uniqueStreamPath();

      const response = await app.fetch(`/api/streams${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          type: "https://events.iterate.com/events/example/value-recorded",
          payload: { value: 1 },
          metadata: "not-an-object",
        }),
      });

      expect(response.ok).toBe(false);
      expect(await response.text()).toContain("metadata");
    },
    testTimeoutMs,
  );

  test(
    "append rejects null metadata",
    async () => {
      const path = uniqueStreamPath();

      const response = await app.fetch(`/api/streams${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          type: "https://events.iterate.com/events/example/value-recorded",
          payload: { value: 1 },
          metadata: null,
        }),
      });

      expect(response.ok).toBe(false);
      expect(await response.text()).toContain("metadata");
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
