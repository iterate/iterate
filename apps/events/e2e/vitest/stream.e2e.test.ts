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

const app = createEvents2AppFixture({
  baseURL: requireEventsBaseUrl(),
});
const postBootTimeoutMs = 2_000;
const historyIdleTimeoutMs = 250;
const pollIntervalMs = 50;
const testTimeoutMs = 5_000;

describe.sequential("events stream e2e", () => {
  test(
    "new streams always store self stream-created at offset 0 before caller events",
    async () => {
      const path = uniqueStreamPath();

      await app.client.append({
        path,
        type: "https://events.iterate.com/events/example/value-recorded",
        payload: { value: 42 },
      });

      const events = await collectStreamEvents(app, { path });
      const storedEvents = await collectAllStreamEvents(app, { path });

      expect(events).toEqual([
        {
          path,
          offset: expectedOffset(1),
          type: "https://events.iterate.com/events/example/value-recorded",
          payload: { value: 42 },
          createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        },
      ]);
      expect(storedEvents).toMatchObject([
        {
          path,
          offset: expectedStoredOffset(0),
          type: "https://events.iterate.com/events/stream/created",
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
      ).rejects.toThrow(/input validation failed/i);
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
            type: "https://events.iterate.com/events/example/value-recorded",
            payload: { step: "ignored-duplicate" },
            idempotencyKey: existingKey,
          },
          {
            type: "https://events.iterate.com/events/example/value-recorded",
            payload: { step: "new-in-batch" },
            idempotencyKey: batchKey,
          },
          {
            type: "https://events.iterate.com/events/example/value-recorded",
            payload: { step: "ignored-same-batch-duplicate" },
            idempotencyKey: batchKey,
          },
        ],
      });

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
        initialized: true,
        path,
        eventCount: 2,
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
            type: "https://events.iterate.com/events/example/value-recorded",
            payload: { value: 1 },
          },
          {
            type: "https://events.iterate.com/events/example/value-recorded",
            payload: { value: 2 },
          },
          {
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
    "append rejects the wrong first user offset and leaves only the synthetic self-created event",
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
          type: "https://events.iterate.com/events/stream/created",
          payload: { path },
        },
      ]);
      expect((await app.client.listStreams({})).some((stream) => stream.path === path)).toBe(true);
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

      expect(first.events[0]?.offset).toEqual(expectedOffset(1));
      expect(second.events[0]?.offset).toEqual(expectedOffset(2));
    },
    testTimeoutMs,
  );

  test(
    "batch append accepts a full supplied offset chain",
    async () => {
      const path = uniqueStreamPath();

      await app.client.append({
        path,
        events: [
          {
            type: "https://events.iterate.com/events/example/value-recorded",
            payload: { step: 1 },
            offset: expectedOffset(1),
          },
          {
            type: "https://events.iterate.com/events/example/value-recorded",
            payload: { step: 2 },
            offset: expectedOffset(2),
          },
          {
            type: "https://events.iterate.com/events/example/value-recorded",
            payload: { step: 3 },
            offset: expectedOffset(3),
          },
        ],
      });

      const events = await collectStreamEvents(app, { path });

      expect(events.map((event) => event.offset)).toEqual([
        expectedOffset(1),
        expectedOffset(2),
        expectedOffset(3),
      ]);
    },
    testTimeoutMs,
  );

  test(
    "append rejects a supplied offset that does not match the next generated offset",
    async () => {
      const path = uniqueStreamPath();

      await app.client.append({
        path,
        type: "https://events.iterate.com/events/example/value-recorded",
        payload: { step: 1 },
      });

      await expect(
        app.client.append({
          path,
          type: "https://events.iterate.com/events/example/value-recorded",
          payload: { step: 2 },
          offset: expectedOffset(1),
        }),
      ).rejects.toThrow(/next generated offset/i);
    },
    testTimeoutMs,
  );

  test(
    "batch append fails atomically for caller rows when a later supplied offset is wrong",
    async () => {
      const path = uniqueStreamPath();

      await expect(
        app.client.append({
          path,
          events: [
            {
              type: "https://events.iterate.com/events/example/value-recorded",
              payload: { step: 1 },
              offset: expectedOffset(1),
            },
            {
              type: "https://events.iterate.com/events/example/value-recorded",
              payload: { step: 2 },
              offset: expectedOffset(9),
            },
          ],
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
          type: "https://events.iterate.com/events/stream/created",
          payload: { path },
        },
      ]);
      expect((await app.client.listStreams({})).some((stream) => stream.path === path)).toBe(true);
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
          offset: expectedOffset(1),
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
    "failed guarded append does not advance resume boundaries",
    async () => {
      const path = uniqueStreamPath();

      const first = await app.client.append({
        path,
        type: "https://events.iterate.com/events/example/value-recorded",
        payload: { step: 1 },
      });

      await expect(
        app.client.append({
          path,
          type: "https://events.iterate.com/events/example/value-recorded",
          payload: { step: 2 },
          offset: expectedOffset(1),
        }),
      ).rejects.toThrow(/next generated offset/i);

      const resumed = await collectStreamEvents(app, {
        path,
        offset: first.events[0]?.offset,
      });

      expect(resumed).toEqual([]);
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
        events: [
          {
            type: "https://events.iterate.com/events/example/value-recorded",
            payload: { step: 1 },
          },
          {
            type: "https://events.iterate.com/events/stream/metadata-updated",
            payload: {
              metadata: {
                owner: "first",
                stale: true,
              },
            },
          },
          {
            type: "https://events.iterate.com/events/stream/metadata-updated",
            payload: {
              metadata: {
                owner: "second",
              },
            },
          },
        ],
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
    "first append to a nested stream initializes the chain and propagates stream-created events upward",
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

      await waitForEvent(app, "/", (event) => isCreatedForPath(event, path));

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
          type: "https://events.iterate.com/events/stream/created",
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
          .filter((event) => event.type === "https://events.iterate.com/events/stream/created")
          .map((event) => event.payload.path),
      ).toEqual([parentPath, path]);

      const rootEvents = await collectAllStreamEvents(app, { path: "/" });
      const rootPropagatedPaths = rootEvents
        .filter(
          (event) =>
            event.type === "https://events.iterate.com/events/stream/created" &&
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
    "later non-stream-created appends do not propagate additional stream-created events",
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

      await waitForEvent(app, "/", (event) => isCreatedForPath(event, childPath));

      const parentCreatedBefore = (await collectAllStreamEvents(app, { path: parentPath })).filter(
        (event) =>
          event.type === "https://events.iterate.com/events/stream/created" &&
          event.payload.path === childPath,
      );
      const rootCreatedBefore = (await collectAllStreamEvents(app, { path: "/" })).filter(
        (event) =>
          event.type === "https://events.iterate.com/events/stream/created" &&
          event.payload.path === childPath,
      );

      await app.client.append({
        path: childPath,
        type: "https://events.iterate.com/events/example/value-recorded",
        payload: { child: "second" },
      });

      expect(
        (await collectAllStreamEvents(app, { path: parentPath })).filter(
          (event) =>
            event.type === "https://events.iterate.com/events/stream/created" &&
            event.payload.path === childPath,
        ),
      ).toHaveLength(parentCreatedBefore.length);
      expect(
        (await collectAllStreamEvents(app, { path: "/" })).filter(
          (event) =>
            event.type === "https://events.iterate.com/events/stream/created" &&
            event.payload.path === childPath,
        ),
      ).toHaveLength(rootCreatedBefore.length);
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
            type: "https://events.iterate.com/events/example/value-recorded",
            payload: { step: 1 },
          },
          {
            type: "https://events.iterate.com/events/example/value-recorded",
            payload: { step: 2 },
          },
          {
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
        events: [
          {
            path,
            offset: expectedOffset(1),
            payload: { via: "http" },
          },
        ],
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

        const first = await withTimeout(iterator.next(), postBootTimeoutMs);
        const second = await withTimeout(iterator.next(), postBootTimeoutMs);

        expect(first.done).toBe(false);
        expect(first.value).toMatchObject({
          path,
          offset: expectedStoredOffset(0),
          type: "https://events.iterate.com/events/stream/created",
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

  test(
    "rejected guarded append does not publish a live event",
    async () => {
      const path = uniqueStreamPath();

      const first = await app.client.append({
        path,
        type: "https://events.iterate.com/events/example/value-recorded",
        payload: { step: "initial" },
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
        await expect(
          app.client.append({
            path,
            type: "https://events.iterate.com/events/example/value-recorded",
            payload: { step: "rejected" },
            offset: expectedOffset(1),
          }),
        ).rejects.toThrow(/next generated offset/i);

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
        event.type === "https://events.iterate.com/events/stream/created" &&
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

function isCreatedForPath(event: Event, path: StreamPath) {
  return (
    event.type === "https://events.iterate.com/events/stream/created" &&
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
