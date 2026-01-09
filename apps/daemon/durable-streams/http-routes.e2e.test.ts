/**
 * E2E tests using native fetch against a real HTTP server.
 *
 * Starts the server on a random port, tests with standard fetch API.
 */
import { createServer } from "node:http";
import { HttpServer } from "@effect/platform";
import { NodeHttpServer } from "@effect/platform-node";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { eventStreamRouter } from "./http-routes.ts";
import { StreamManagerService } from "./stream-manager.ts";
import type { Event } from "./types.ts";

let baseUrl: string;
let serverFiber: Fiber.RuntimeFiber<void, unknown>;

beforeAll(async () => {
  // Build server layer with random port (port 0)
  const serverLayer = Layer.mergeAll(
    NodeHttpServer.layer(createServer, { port: 0 }),
    StreamManagerService.InMemory,
  ).pipe(Layer.provideMerge(HttpServer.layerContext));

  // Create a deferred to signal when address is available
  const fiberId = Effect.runSync(Effect.fiberId);
  const addressDeferred = Deferred.unsafeMake<HttpServer.Address>(fiberId);

  // Server effect that publishes address then serves forever
  const serverEffect = Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer;
    yield* Deferred.succeed(addressDeferred, server.address);
    yield* HttpServer.serveEffect(eventStreamRouter);
    return yield* Effect.never;
  }).pipe(Effect.scoped, Effect.provide(serverLayer));

  // Fork server in background
  serverFiber = Effect.runFork(serverEffect);

  // Wait for address
  const address = await Effect.runPromise(Deferred.await(addressDeferred));

  if (address._tag === "TcpAddress") {
    baseUrl = `http://127.0.0.1:${address.port}`;
  } else {
    throw new Error("Expected TCP address");
  }
});

afterAll(async () => {
  await Effect.runPromise(Fiber.interrupt(serverFiber));
});

describe("Native Fetch E2E", () => {
  describe("GET /streams", () => {
    test("returns empty list initially", async () => {
      const response = await fetch(`${baseUrl}/streams`);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");

      const body = await response.json();
      expect(body).toEqual({ streams: [] });
    });
  });

  describe("POST /streams/:name", () => {
    test("appends event and returns 201", async () => {
      const response = await fetch(`${baseUrl}/streams/fetch-test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: { message: "hello from fetch" } }),
      });

      expect(response.status).toBe(201);

      const event = (await response.json()) as Event;
      expect(event.offset).toBe("0000000000000000");
      expect(event.data).toEqual({ message: "hello from fetch" });
      expect(typeof event.createdAt).toBe("string");
    });

    test("assigns sequential offsets", async () => {
      const res1 = await fetch(`${baseUrl}/streams/fetch-sequential`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: "event1" }),
      });
      const event1 = (await res1.json()) as Event;

      const res2 = await fetch(`${baseUrl}/streams/fetch-sequential`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: "event2" }),
      });
      const event2 = (await res2.json()) as Event;

      expect(event1.offset).toBe("0000000000000000");
      expect(event2.offset).toBe("0000000000000001");
    });

    test("returns 400 for invalid JSON", async () => {
      const response = await fetch(`${baseUrl}/streams/fetch-invalid`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not valid json",
      });

      expect(response.status).toBe(400);
    });
  });

  describe("GET /streams/:name (SSE)", () => {
    test("returns historical events as SSE", async () => {
      // Add some events first
      await fetch(`${baseUrl}/streams/fetch-sse`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: "sse-event1" }),
      });
      await fetch(`${baseUrl}/streams/fetch-sse`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: "sse-event2" }),
      });

      // Subscribe to SSE stream
      const response = await fetch(`${baseUrl}/streams/fetch-sse`);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/event-stream");

      // Read SSE events from stream
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      const events: Array<Event> = [];
      let buffer = "";

      while (events.length < 2) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE events from buffer
        const lines = buffer.split("\n\n");
        buffer = lines.pop() || ""; // Keep incomplete chunk

        for (const chunk of lines) {
          if (chunk.startsWith("data: ")) {
            const json = chunk.slice(6);
            events.push(JSON.parse(json));
          }
        }
      }

      reader.cancel();

      expect(events.length).toBe(2);
      expect(events[0]!.data).toBe("sse-event1");
      expect(events[1]!.data).toBe("sse-event2");
    });

    test("supports offset query parameter", async () => {
      // Add 3 events
      await fetch(`${baseUrl}/streams/fetch-offset`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: "offset-event0" }),
      });

      const res1 = await fetch(`${baseUrl}/streams/fetch-offset`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: "offset-event1" }),
      });
      const event1 = (await res1.json()) as Event;

      await fetch(`${baseUrl}/streams/fetch-offset`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: "offset-event2" }),
      });

      // Subscribe starting from event1's offset
      const response = await fetch(`${baseUrl}/streams/fetch-offset?offset=${event1.offset}`);

      expect(response.status).toBe(200);

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      const events: Array<Event> = [];
      let buffer = "";

      while (events.length < 2) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop() || "";

        for (const chunk of lines) {
          if (chunk.startsWith("data: ")) {
            events.push(JSON.parse(chunk.slice(6)));
          }
        }
      }

      reader.cancel();

      // Should start from event1, not event0
      expect(events[0]!.data).toBe("offset-event1");
      expect(events[1]!.data).toBe("offset-event2");
    });
  });

  describe("DELETE /streams/:name", () => {
    test("deletes stream and returns 204", async () => {
      // Create stream
      await fetch(`${baseUrl}/streams/fetch-delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: "to be deleted" }),
      });

      // Verify it exists
      const listBefore = await fetch(`${baseUrl}/streams`);
      const bodyBefore = (await listBefore.json()) as { streams: Array<string> };
      expect(bodyBefore.streams).toContain("fetch-delete");

      // Delete it
      const deleteRes = await fetch(`${baseUrl}/streams/fetch-delete`, {
        method: "DELETE",
      });
      expect(deleteRes.status).toBe(204);

      // Verify it's gone
      const listAfter = await fetch(`${baseUrl}/streams`);
      const bodyAfter = (await listAfter.json()) as { streams: Array<string> };
      expect(bodyAfter.streams).not.toContain("fetch-delete");
    });
  });

  describe("GET /streams (listing)", () => {
    test("lists streams that were created", async () => {
      // Create a unique stream for this test
      const streamName = `list-test-${Date.now()}`;
      await fetch(`${baseUrl}/streams/${streamName}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: "for listing" }),
      });

      const response = await fetch(`${baseUrl}/streams`);
      const body = (await response.json()) as { streams: Array<string> };

      expect(body.streams).toContain(streamName);
    });
  });
});
