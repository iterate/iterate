import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { unstable_dev, type Unstable_DevWorker } from "wrangler";
import type { Event, EventInput, StreamState } from "@iterate-com/events-contract";
import { StreamPath } from "@iterate-com/events-contract";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { decodeEventStream } from "~/lib/utils.ts";

describe("stream durable object runtime", () => {
  let worker: Unstable_DevWorker;
  let tempDir: string;

  beforeAll(async () => {
    tempDir = mkdtempSync(resolve(tmpdir(), "events-stream-runtime-"));
    const configPath = resolve(tempDir, "wrangler.jsonc");

    writeFileSync(
      configPath,
      JSON.stringify(
        {
          name: "events-stream-runtime-test",
          main: "src/stream-runtime-test-entry.workerd.ts",
          compatibility_date: "2025-02-24",
          durable_objects: {
            bindings: [
              {
                name: "STREAM",
                class_name: "StreamDurableObject",
                script_name: "events-stream-runtime-test",
              },
            ],
          },
          migrations: [
            {
              tag: "v1",
              new_sqlite_classes: ["StreamDurableObject"],
              new_classes: [],
            },
          ],
        },
        null,
        2,
      ),
    );

    worker = await unstable_dev("src/stream-runtime-test-entry.workerd.ts", {
      config: configPath,
      local: true,
      persistTo: resolve(tempDir, "persist"),
      logLevel: "error",
      experimental: {
        disableExperimentalWarning: true,
        testMode: true,
      },
    });

    const response = await worker.fetch(`http://127.0.0.1:${worker.port}/ping`);
    expect(await response.text()).toBe("ok");
  });

  afterAll(async () => {
    await worker.stop();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("SQLite-backed append assigns integer offsets and resume reads start after them", async () => {
    const path = uniqueStreamPath();

    const appended = await postJson<{ created: boolean; events: Event[] }>("/append", {
      path,
      events: [createEventInput(path, 1), createEventInput(path, 2), createEventInput(path, 3)],
    });

    expect(appended.created).toBe(true);
    expect(appended.events.map((event) => event.offset)).toEqual([1, 2, 3]);

    const state = await getJson<StreamState>(`/state?path=${encodeURIComponent(path)}`);
    expect(state).toEqual({
      path,
      lastOffset: 3,
      eventCount: 3,
      metadata: {},
    });

    const history = await getJson<Event[]>(
      `/history?path=${encodeURIComponent(path)}&afterOffset=1`,
    );
    expect(history.map((event) => event.offset)).toEqual([2, 3]);
    expect(history.map((event) => event.payload)).toEqual([{ value: 2 }, { value: 3 }]);

    const liveResponse = await worker.fetch(
      `http://127.0.0.1:${worker.port}/stream?path=${encodeURIComponent(path)}&afterOffset=1&live=true`,
    );
    expect(liveResponse.ok).toBe(true);
    expect(liveResponse.body).not.toBeNull();

    const liveStream = liveResponse.body as ReadableStream<Uint8Array>;
    const iterator = decodeEventStream(liveStream)[Symbol.asyncIterator]();

    try {
      expect(await iterator.next()).toMatchObject({
        done: false,
        value: {
          path,
          offset: 2,
          payload: { value: 2 },
        },
      });
      expect(await iterator.next()).toMatchObject({
        done: false,
        value: {
          path,
          offset: 3,
          payload: { value: 3 },
        },
      });

      const nextEventPromise = iterator.next();

      await postJson<{ created: boolean; events: Event[] }>("/append", {
        path,
        events: [createEventInput(path, 4)],
      });

      const next = await Promise.race([
        nextEventPromise,
        delay(2_000).then(() => {
          throw new Error("Timed out waiting for a live stream event");
        }),
      ]);

      expect(next.done).toBe(false);
      expect(next.value).toMatchObject({
        path,
        offset: 4,
        payload: { value: 4 },
      });
    } finally {
      await iterator.return?.();
    }
  });

  async function postJson<TResponse>(pathname: string, body: unknown) {
    const response = await worker.fetch(`http://127.0.0.1:${worker.port}${pathname}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

    expect(response.ok).toBe(true);
    return (await response.json()) as TResponse;
  }

  async function getJson<TResponse>(pathname: string) {
    const response = await worker.fetch(`http://127.0.0.1:${worker.port}${pathname}`);
    expect(response.ok).toBe(true);
    return (await response.json()) as TResponse;
  }
});

function uniqueStreamPath() {
  return StreamPath.parse(`/worker/${crypto.randomUUID().slice(0, 8)}`);
}

function createEventInput(path: string, value: number): EventInput {
  return {
    path,
    type: "https://events.iterate.com/events/example/value-recorded",
    payload: { value },
  };
}
