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
