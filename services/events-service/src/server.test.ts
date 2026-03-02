import { describe, expect, test } from "vitest";

import { startEventBusTestFixture } from "./testing/orpc-test-server.ts";
import { toSseBaseURL } from "./testing/subscriptions-test-helpers.ts";

describe("Durable Stream Server via oRPC", () => {
  test("append returns success and read returns stored event", async () => {
    await using eventBus = await startEventBusTestFixture();
    const client = eventBus.client;
    const path = "/test/stream";

    await client.append({
      path,
      events: [
        {
          type: "https://events.iterate.com/events/test/event-recorded",
          payload: { msg: "hello" },
        },
      ],
    });

    const stream = await client.stream({ path, live: false });
    const event = await stream.next();
    await stream.return?.();

    expect(event.done).toBe(false);
    if (event.done) throw new Error("Expected a stream event");
    expect((event.value.payload as Record<string, unknown>)["msg"]).toBe("hello");
  });

  test("concurrent first appends to a new path produce unique offsets", async () => {
    await using eventBus = await startEventBusTestFixture();
    const client = eventBus.client;
    const path = "/test/concurrent-initialize";
    const appendCount = 12;
    let releaseStart: (() => void) | undefined;
    const start = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });

    const appendTasks = Array.from({ length: appendCount }, (_, index) =>
      (async () => {
        await start;
        await client.append({
          path,
          events: [
            {
              type: "https://events.iterate.com/events/test/concurrent-recorded",
              payload: { index },
            },
          ],
        });
      })(),
    );

    releaseStart?.();
    await Promise.all(appendTasks);

    const stream = await client.stream({ path, live: false });
    const events: Array<{ offset: string }> = [];
    try {
      for (let index = 0; index < appendCount; index += 1) {
        const nextEvent = await stream.next();
        expect(nextEvent.done).toBe(false);
        if (nextEvent.done) throw new Error("Expected stream event");
        events.push({ offset: nextEvent.value.offset });
      }

      const terminalEvent = await stream.next();
      expect(terminalEvent.done).toBe(true);
    } finally {
      await stream.return?.();
    }

    const expectedOffsets = Array.from({ length: appendCount }, (_, index) =>
      String(index).padStart(16, "0"),
    );
    const actualOffsets = events.map((event) => event.offset);

    expect(actualOffsets).toEqual(expectedOffsets);
  });

  test("listStreams includes a live-connected stream", async () => {
    await using eventBus = await startEventBusTestFixture();
    const client = eventBus.client;
    const path = "/ui/implicit-created";
    const stream = await client.stream({ path, live: true });

    try {
      const streams = await client.listStreams({});
      const summary = streams.find((entry) => entry.path === path);
      expect(summary).toBeDefined();
      expect(summary?.eventCount).toBe(0);
    } finally {
      await stream.return?.();
    }
  });

  test("serves OpenAPI spec JSON", async () => {
    await using eventBus = await startEventBusTestFixture();
    const response = await fetch(`${toSseBaseURL(eventBus.url)}/openapi.json`);
    expect(response.status).toBe(200);
    const spec = (await response.json()) as {
      openapi?: string;
      paths?: Record<string, unknown>;
    };

    expect(spec.openapi).toBeDefined();
    expect(spec.paths).toBeDefined();
  });

  test("serves OpenAPI docs UI", async () => {
    await using eventBus = await startEventBusTestFixture();
    const response = await fetch(`${toSseBaseURL(eventBus.url)}/docs`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html.toLowerCase()).toContain("<html");
  });

  test("serves default /health route", async () => {
    await using eventBus = await startEventBusTestFixture();
    const response = await fetch(`${toSseBaseURL(eventBus.url)}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  test("does not expose legacy /healthz route", async () => {
    await using eventBus = await startEventBusTestFixture();
    const response = await fetch(`${toSseBaseURL(eventBus.url)}/healthz`);
    expect(response.status).toBe(404);
  });
});
