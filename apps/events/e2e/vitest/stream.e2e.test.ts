import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, test } from "vitest";
import {
  ChildStreamCreatedEvent,
  StreamInitializedEvent,
  StreamPath,
  type Event,
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
    "new streams always store self stream-initialized at offset 0 before caller events",
    async () => {
      const path = uniqueStreamPath();

      const result = await app.client.append({
        params: { path },
        body: {
          type: "https://events.iterate.com/events/example/value-recorded",
          payload: { value: 42 },
        },
      });

      expect(result.event).toMatchObject({
        streamPath: path,
        offset: expectedOffset(1),
        type: "https://events.iterate.com/events/example/value-recorded",
        payload: { value: 42 },
      });

      expect(await collectStreamEvents(app, { path })).toEqual([
        {
          streamPath: path,
          offset: expectedOffset(1),
          type: "https://events.iterate.com/events/example/value-recorded",
          payload: { value: 42 },
          createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        },
      ]);
      expect(await collectAllStreamEvents(app, { path })).toMatchObject([
        {
          streamPath: path,
          offset: expectedStoredOffset(0),
          type: "https://events.iterate.com/events/stream/initialized",
          payload: { path },
        },
        {
          streamPath: path,
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
        params: { path },
        body: {
          type: "https://events.iterate.com/events/example/value-recorded",
          payload: { value: 42 },
          metadata: {
            actor: "e2e",
            attempts: 1,
            tags: ["round-trip"],
          },
        },
      });

      const events = await collectStreamEvents(app, { path });

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        streamPath: path,
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
        params: { path },
        body: {
          type: "https://events.iterate.com/events/example/value-recorded",
          payload: { value: 1 },
          metadata: {
            source: "first-call",
          },
          idempotencyKey,
        },
      });

      const second = await app.client.append({
        params: { path },
        body: {
          type: "https://events.iterate.com/events/example/value-recorded",
          payload: { value: 999 },
          metadata: {
            source: "second-call",
          },
          idempotencyKey,
        },
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
          params: { path },
          body: {
            type: "https://events.iterate.com/events/example/value-recorded",
            payload: { value: 1 },
            idempotencyKey: "",
          },
        }),
      ).rejects.toThrow(/input validation failed/i);
    },
    testTimeoutMs,
  );

  test(
    "public append allows child-stream-created and rejects only a second stream-initialized",
    async () => {
      const path = uniqueStreamPath();
      const childPath = StreamPath.parse(`${path}/child`);

      const childCreatedResponse = await app.fetch(`/api/streams/${routePathFor(path)}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          type: "https://events.iterate.com/events/stream/child-stream-created",
          payload: { path: childPath },
        }),
      });

      const initializedResponse = await app.fetch(`/api/streams/${routePathFor(path)}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          type: "https://events.iterate.com/events/stream/initialized",
          payload: { path },
        }),
      });

      expect(childCreatedResponse.status).toBe(200);
      await expect(childCreatedResponse.json()).resolves.toMatchObject({
        event: {
          streamPath: path,
          type: "https://events.iterate.com/events/stream/child-stream-created",
          payload: { path: childPath },
        },
      });
      expect(initializedResponse.status).toBe(400);
      expect(await initializedResponse.text()).toContain(
        "stream-initialized may only be appended once",
      );
    },
    testTimeoutMs,
  );

  test(
    "append rejects the wrong first user offset and leaves only the synthetic self-initialized event",
    async () => {
      const path = uniqueStreamPath();

      await expect(
        app.client.append({
          params: { path },
          body: {
            type: "https://events.iterate.com/events/example/value-recorded",
            payload: { step: 1 },
            offset: expectedOffset(2),
          },
        }),
      ).rejects.toThrow(/next generated offset/i);

      expect(await app.client.getState({ path })).toEqual({
        path,
        maxOffset: 1,
        metadata: {},
      });
      expect(await collectStreamEvents(app, { path })).toEqual([]);
      expect(await collectAllStreamEvents(app, { path })).toMatchObject([
        {
          streamPath: path,
          offset: expectedStoredOffset(0),
          type: "https://events.iterate.com/events/stream/initialized",
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
        params: { path },
        body: {
          type: "https://events.iterate.com/events/example/value-recorded",
          payload: { step: 1 },
          offset: expectedOffset(1),
        },
      });

      const second = await app.client.append({
        params: { path },
        body: {
          type: "https://events.iterate.com/events/example/value-recorded",
          payload: { step: 2 },
          offset: expectedOffset(2),
        },
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
        params: { path },
        body: {
          type: "https://events.iterate.com/events/example/value-recorded",
          payload: { step: 1 },
          idempotencyKey,
          offset: expectedOffset(1),
        },
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
          params: { path },
          body: {
            type: "https://events.iterate.com/events/example/value-recorded",
            payload: { step: "duplicate" },
            idempotencyKey,
            offset: expectedOffset(1),
          },
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
    "getState initializes untouched streams before returning state",
    async () => {
      const path = uniqueStreamPath();

      expect(await app.client.getState({ path })).toEqual({
        path,
        maxOffset: 1,
        metadata: {},
      });
    },
    testTimeoutMs,
  );

  test(
    "root uses the same stream and state procedures as every other path",
    async () => {
      const rootHistory = await collectAsyncIterableUntilIdle({
        iterable: await app.client.stream({ path: "/" }),
        idleMs: historyIdleTimeoutMs,
      });

      expect(await app.client.getState({ path: "/" })).toMatchObject({
        path: "/",
        metadata: {},
      });

      const escapedRootHistoryResponse = await app.fetch("/api/streams/%2F");
      expect(escapedRootHistoryResponse.status).toBe(200);
      expect(await escapedRootHistoryResponse.text()).toContain(
        "https://events.iterate.com/events/stream/initialized",
      );

      const escapedRootStateResponse = await app.fetch("/api/__state/%2F");
      expect(escapedRootStateResponse.status).toBe(200);
      expect(await escapedRootStateResponse.json()).toEqual(
        await app.client.getState({ path: "/" }),
      );
      expect(rootHistory[0]).toMatchObject({
        streamPath: "/",
        type: "https://events.iterate.com/events/stream/initialized",
      });
    },
    testTimeoutMs,
  );

  test(
    "metadata update events replace reduced metadata",
    async () => {
      const path = uniqueStreamPath();

      await app.client.append({
        params: { path },
        body: {
          type: "https://events.iterate.com/events/example/value-recorded",
          payload: { step: 1 },
        },
      });
      await app.client.append({
        params: { path },
        body: {
          type: "https://events.iterate.com/events/stream/metadata-updated",
          payload: {
            metadata: {
              owner: "first",
              stale: true,
            },
          },
        },
      });
      await app.client.append({
        params: { path },
        body: {
          type: "https://events.iterate.com/events/stream/metadata-updated",
          payload: {
            metadata: {
              owner: "second",
            },
          },
        },
      });

      expect(await app.client.getState({ path })).toEqual({
        path,
        maxOffset: 4,
        metadata: {
          owner: "second",
        },
      });
    },
    testTimeoutMs,
  );

  test(
    "history and state accept both raw nested segments and escaped path forms over HTTP",
    async () => {
      const path = StreamPath.parse(`/e2e/${randomUUID().slice(0, 6)}/${randomUUID().slice(0, 6)}`);
      const routePath = routePathFor(path);

      await app.client.append({
        params: { path },
        body: {
          type: "https://events.iterate.com/events/example/value-recorded",
          payload: { encoded: true },
        },
      });

      const rawHistoryResponse = await app.fetch(`/api/streams${path}`);
      const escapedHistoryResponse = await app.fetch(`/api/streams/${routePath}`);

      expect(rawHistoryResponse.status).toBe(200);
      expect(await escapedHistoryResponse.text()).toEqual(await rawHistoryResponse.text());

      const rawStateResponse = await app.fetch(`/api/__state${path}`);
      const escapedStateResponse = await app.fetch(`/api/__state/${routePath}`);

      expect(rawStateResponse.status).toBe(200);
      expect(await escapedStateResponse.json()).toEqual(await rawStateResponse.json());
    },
    testTimeoutMs,
  );

  test(
    "listStreams reads discovered paths from the root stream",
    async () => {
      const path = uniqueStreamPath();

      await app.client.append({
        params: { path },
        body: {
          type: "https://events.iterate.com/events/example/value-recorded",
          payload: { listed: true },
        },
      });

      const stream = await waitForStream(app, path);
      expect(stream.createdAt).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/));
    },
    testTimeoutMs,
  );

  test(
    "listStreams is exposed at /api/streams",
    async () => {
      const streams = await app.client.listStreams({});
      const response = await app.fetch("/api/streams");

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(streams);
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
    "destroy wipes an existing stream and returns pre-destruction state",
    async () => {
      const path = uniqueStreamPath();

      await app.client.append({
        params: { path },
        body: {
          type: "https://events.iterate.com/events/example/value-recorded",
          payload: { step: 1 },
        },
      });
      await app.client.append({
        params: { path },
        body: {
          type: "https://events.iterate.com/events/stream/metadata-updated",
          payload: { metadata: { owner: "destroy-me" } },
        },
      });

      const stateBeforeDestroy = await app.client.getState({ path });

      const result = await app.client.destroy({ path });
      expect(result).toEqual({
        destroyed: true,
        finalState: stateBeforeDestroy,
      });
    },
    testTimeoutMs,
  );

  test(
    "destroy on untouched stream returns null finalState",
    async () => {
      const path = uniqueStreamPath();

      expect(await app.client.destroy({ path })).toEqual({
        destroyed: true,
        finalState: null,
      });
    },
    testTimeoutMs,
  );

  test(
    "destroy only wipes the targeted stream",
    async () => {
      const pathA = uniqueStreamPath();
      const pathB = uniqueStreamPath();

      await app.client.append({
        params: { path: pathA },
        body: {
          type: "https://events.iterate.com/events/example/value-recorded",
          payload: { label: "A" },
        },
      });
      await app.client.append({
        params: { path: pathB },
        body: {
          type: "https://events.iterate.com/events/example/value-recorded",
          payload: { label: "B" },
        },
      });

      await app.client.destroy({ path: pathA });

      expect(await collectStreamEvents(app, { path: pathB })).toEqual([
        expect.objectContaining({
          streamPath: pathB,
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
        params: { path },
        body: {
          type: "https://events.iterate.com/events/example/value-recorded",
          payload: { listed: true },
        },
      });

      await waitForStream(app, path);
      await app.client.destroy({ path });

      const streams = await app.client.listStreams({});
      expect(streams.some((stream) => stream.path === path)).toBe(true);
    },
    testTimeoutMs,
  );

  test(
    "destroy allows wiping the root stream",
    async () => {
      const stateBeforeDestroy = await app.client.getState({ path: "/" });

      const result = await app.client.destroy({ path: "/" });
      expect(result).toEqual({
        destroyed: true,
        finalState: stateBeforeDestroy,
      });
    },
    testTimeoutMs,
  );

  test(
    "first append to a nested stream initializes the chain and propagates child-stream-created events upward",
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
        params: { path },
        body: {
          type: "https://events.iterate.com/events/example/value-recorded",
          payload: { propagated: true },
        },
      });

      await waitForEvent(app, "/", (event) => isChildStreamCreatedForPath(event, path));

      expect(await collectStreamEvents(app, { path })).toMatchObject([
        {
          streamPath: path,
          offset: expectedOffset(1),
          payload: { propagated: true },
        },
      ]);

      expect(await collectAllStreamEvents(app, { path })).toMatchObject([
        {
          streamPath: path,
          offset: expectedStoredOffset(0),
          type: "https://events.iterate.com/events/stream/initialized",
          payload: { path },
        },
        {
          streamPath: path,
          offset: expectedOffset(1),
          type: "https://events.iterate.com/events/example/value-recorded",
          payload: { propagated: true },
        },
      ]);

      const parentEvents = await collectAllStreamEvents(app, { path: parentPath });
      expect(
        parentEvents
          .filter(
            (event) =>
              event.type === "https://events.iterate.com/events/stream/child-stream-created",
          )
          .map((event) => getPayloadPath(event)),
      ).toEqual([path]);

      const rootEvents = await collectAllStreamEvents(app, { path: "/" });
      const rootPropagatedPaths = rootEvents
        .filter(
          (event) =>
            event.type === "https://events.iterate.com/events/stream/child-stream-created" &&
            event.streamPath === "/" &&
            typeof getPayloadPath(event) === "string" &&
            propagatedPaths.includes(getPayloadPath(event) as StreamPath),
        )
        .map((event) => getPayloadPath(event));

      expect(rootPropagatedPaths).toEqual(propagatedPaths);
    },
    testTimeoutMs,
  );

  test(
    "later non-stream-initialized appends do not propagate additional child-stream-created events",
    async () => {
      const top = randomUUID().slice(0, 6);
      const second = randomUUID().slice(0, 6);
      const third = randomUUID().slice(0, 6);
      const fourth = randomUUID().slice(0, 6);
      const childPath = StreamPath.parse(`/${top}/${second}/${third}/${fourth}`);
      const parentPath = StreamPath.parse(`/${top}/${second}/${third}`);

      await app.client.append({
        params: { path: childPath },
        body: {
          type: "https://events.iterate.com/events/example/value-recorded",
          payload: { child: true },
        },
      });

      await waitForEvent(app, "/", (event) => isChildStreamCreatedForPath(event, childPath));

      const parentInitializedBefore = (
        await collectAllStreamEvents(app, { path: parentPath })
      ).filter(
        (event) =>
          event.type === "https://events.iterate.com/events/stream/child-stream-created" &&
          getPayloadPath(event) === childPath,
      );
      const rootInitializedBefore = (await collectAllStreamEvents(app, { path: "/" })).filter(
        (event) =>
          event.type === "https://events.iterate.com/events/stream/child-stream-created" &&
          getPayloadPath(event) === childPath,
      );

      await app.client.append({
        params: { path: childPath },
        body: {
          type: "https://events.iterate.com/events/example/value-recorded",
          payload: { child: "second" },
        },
      });

      expect(
        (await collectAllStreamEvents(app, { path: parentPath })).filter(
          (event) =>
            event.type === "https://events.iterate.com/events/stream/child-stream-created" &&
            getPayloadPath(event) === childPath,
        ),
      ).toHaveLength(parentInitializedBefore.length);
      expect(
        (await collectAllStreamEvents(app, { path: "/" })).filter(
          (event) =>
            event.type === "https://events.iterate.com/events/stream/child-stream-created" &&
            getPayloadPath(event) === childPath,
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
        params: { path },
        body: {
          type: "https://events.iterate.com/events/example/value-recorded",
          payload: { step: 1 },
        },
      });
      await app.client.append({
        params: { path },
        body: {
          type: "https://events.iterate.com/events/example/value-recorded",
          payload: { step: 2 },
        },
      });
      await app.client.append({
        params: { path },
        body: {
          type: "https://events.iterate.com/events/example/value-recorded",
          payload: { step: 3 },
        },
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
          streamPath: path,
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
        params: { path },
        body: {
          type: "https://events.iterate.com/events/example/value-recorded",
          payload: { step: 1 },
        },
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
    "__ path segments are valid stream path segments now that root uses the normal procedures",
    async () => {
      const appendResponse = await app.fetch("/api/streams/e2e/__reserved", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          type: "https://events.iterate.com/events/example/value-recorded",
          payload: { invalid: true },
        }),
      });
      const historyResponse = await app.fetch("/api/streams/e2e/__reserved");
      const stateResponse = await app.fetch("/api/__state/e2e/__reserved");

      expect(appendResponse.status).toBe(200);
      expect(historyResponse.status).toBe(200);
      expect(stateResponse.status).toBe(200);
    },
    testTimeoutMs,
  );

  test(
    "jsonataTransform turns a webhook payload into an appended event",
    async () => {
      const path = uniqueStreamPath();
      const response = await app.fetch(
        `/api/streams${path}?jsonataTransform=${encodeURIComponent(
          '{"type":"slack.event_callback","payload":$,"metadata":{"source":"slack","team_id":team_id}}',
        )}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            token: "slack-token",
            team_id: "T123",
            type: "event_callback",
            event: { type: "app_mention", text: "hello" },
          }),
        },
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        event: {
          streamPath: path,
          type: "slack.event_callback",
          payload: {
            token: "slack-token",
            team_id: "T123",
            type: "event_callback",
            event: { type: "app_mention", text: "hello" },
          },
          metadata: { source: "slack", team_id: "T123" },
        },
      });
    },
    testTimeoutMs,
  );

  test(
    "jsonataTransform rejects invalid expressions",
    async () => {
      const path = uniqueStreamPath();
      const response = await app.fetch(
        `/api/streams${path}?jsonataTransform=${encodeURIComponent(")")}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ value: 1 }),
        },
      );

      expect(response.status).toBe(400);
      expect(await response.text()).toContain("invalid_jsonata_transform");
    },
    testTimeoutMs,
  );

  test(
    "jsonataTransform rejects transformed payloads that are not valid events",
    async () => {
      const path = uniqueStreamPath();
      const response = await app.fetch(
        `/api/streams${path}?jsonataTransform=${encodeURIComponent('{"payload":$}')}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ value: 1 }),
        },
      );

      expect(response.status).toBe(400);
      expect(await response.text()).toContain("type");
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
            params: { path },
            body: {
              type: "https://events.iterate.com/events/example/value-recorded",
              payload: { live: true },
            },
          });
        }, 250);

        const first = await withTimeout(iterator.next(), postBootTimeoutMs);
        const second = await withTimeout(iterator.next(), postBootTimeoutMs);

        expect(first.done).toBe(false);
        expect(first.value).toMatchObject({
          streamPath: path,
          offset: expectedStoredOffset(0),
          type: "https://events.iterate.com/events/stream/initialized",
          payload: { path },
        });

        expect(second.done).toBe(false);
        expect(second.value).toMatchObject({
          streamPath: path,
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

function routePathFor(path: StreamPath) {
  return path === "/" ? "%2F" : path.slice(1).replaceAll("/", "%2F");
}

function expectedOffset(value: number) {
  return value + 1;
}

function expectedStoredOffset(value: number) {
  return value + 1;
}

async function collectStreamEvents(
  appFixture: Events2AppFixture,
  options: {
    path: StreamPath;
    offset?: number;
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
        event.type === "https://events.iterate.com/events/stream/initialized" &&
        event.streamPath === options.path &&
        getPayloadPath(event) === options.path
      ),
  );
}

async function collectAllStreamEvents(
  appFixture: Events2AppFixture,
  options: {
    path: StreamPath;
    offset?: number;
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

function isChildStreamCreatedForPath(event: Event, path: StreamPath) {
  return (
    event.type === "https://events.iterate.com/events/stream/child-stream-created" &&
    getPayloadPath(event) === path
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

function getPayloadPath(event: Event) {
  if (
    event.type === "https://events.iterate.com/events/stream/initialized" ||
    event.type === "https://events.iterate.com/events/stream/child-stream-created"
  ) {
    return getPathPayload(event);
  }

  return undefined;
}

function getPathPayload(event: Event) {
  if (event.type === "https://events.iterate.com/events/stream/initialized") {
    return StreamInitializedEvent.parse(event).payload.path;
  }

  if (event.type === "https://events.iterate.com/events/stream/child-stream-created") {
    return ChildStreamCreatedEvent.parse(event).payload.path;
  }

  throw new Error(`Expected a path payload event, received ${event.type}.`);
}
