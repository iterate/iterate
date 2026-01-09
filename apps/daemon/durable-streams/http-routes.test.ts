/**
 * E2E tests for event-stream HTTP routes
 *
 * Uses @effect/platform-node's layerTest for automatic server setup.
 * HttpClient is pre-configured with the server's base URL.
 */
import { HttpClient, HttpClientRequest, HttpServer } from "@effect/platform"
import { NodeHttpServer } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Stream } from "effect"
import { eventStreamRouter } from "./http-routes.ts"
import { StreamManagerService } from "./stream-manager.ts"
import type { Event } from "./types.ts"

// Test layer: Node HTTP server + StreamManager + serve the router
const testLayer = Layer.mergeAll(
  NodeHttpServer.layerTest,
  StreamManagerService.InMemory
).pipe(
  Layer.provideMerge(HttpServer.layerContext)
)

describe("HTTP Routes E2E", () => {
  describe("GET /streams", () => {
    it.effect("returns empty list initially", () =>
      Effect.gen(function*() {
        yield* HttpServer.serveEffect(eventStreamRouter)
        const client = yield* HttpClient.HttpClient

        const response = yield* client.get("/streams")
        expect(response.status).toBe(200)

        const body = yield* response.json
        expect(body).toEqual({ streams: [] })
      }).pipe(Effect.scoped, Effect.provide(testLayer)))
  })

  describe("POST /streams/:name", () => {
    it.effect("appends event and returns 201", () =>
      Effect.gen(function*() {
        yield* HttpServer.serveEffect(eventStreamRouter)
        const client = yield* HttpClient.HttpClient

        const request = yield* HttpClientRequest.post("/streams/test-stream").pipe(
          HttpClientRequest.bodyJson({ data: { message: "hello world" } })
        )
        const response = yield* client.execute(request)

        expect(response.status).toBe(201)

        const event = (yield* response.json) as Event
        expect(event.offset).toBe("0000000000000000")
        expect(event.data).toEqual({ message: "hello world" })
        expect(typeof event.createdAt).toBe("string")
      }).pipe(Effect.scoped, Effect.provide(testLayer)))

    it.effect("assigns sequential offsets", () =>
      Effect.gen(function*() {
        yield* HttpServer.serveEffect(eventStreamRouter)
        const client = yield* HttpClient.HttpClient

        const req1 = yield* HttpClientRequest.post("/streams/sequential-test").pipe(
          HttpClientRequest.bodyJson({ data: "event1" })
        )
        const res1 = yield* client.execute(req1)
        const event1 = (yield* res1.json) as Event

        const req2 = yield* HttpClientRequest.post("/streams/sequential-test").pipe(
          HttpClientRequest.bodyJson({ data: "event2" })
        )
        const res2 = yield* client.execute(req2)
        const event2 = (yield* res2.json) as Event

        expect(event1.offset).toBe("0000000000000000")
        expect(event2.offset).toBe("0000000000000001")
      }).pipe(Effect.scoped, Effect.provide(testLayer)))

    it.effect("returns 400 for invalid JSON", () =>
      Effect.gen(function*() {
        yield* HttpServer.serveEffect(eventStreamRouter)
        const client = yield* HttpClient.HttpClient

        const request = HttpClientRequest.post("/streams/invalid-json-test").pipe(
          HttpClientRequest.bodyText("not valid json", "application/json")
        )
        const response = yield* client.execute(request)

        expect(response.status).toBe(400)
      }).pipe(Effect.scoped, Effect.provide(testLayer)))
  })

  describe("GET /streams/:name (SSE subscription)", () => {
    it.effect("returns historical events as SSE", () =>
      Effect.gen(function*() {
        yield* HttpServer.serveEffect(eventStreamRouter)
        const client = yield* HttpClient.HttpClient

        // Add some events first
        const req1 = yield* HttpClientRequest.post("/streams/sse-test").pipe(
          HttpClientRequest.bodyJson({ data: "event1" })
        )
        yield* client.execute(req1)

        const req2 = yield* HttpClientRequest.post("/streams/sse-test").pipe(
          HttpClientRequest.bodyJson({ data: "event2" })
        )
        yield* client.execute(req2)

        // Subscribe and get the stream
        const response = yield* client.get("/streams/sse-test")

        expect(response.status).toBe(200)
        expect(response.headers["content-type"]).toBe("text/event-stream")

        // Read first 2 events from the SSE stream
        const events: Array<Event> = []

        yield* response.stream.pipe(
          Stream.decodeText(),
          Stream.mapConcat((chunk) => chunk.split("\n\n")),
          Stream.filter((line) => line.startsWith("data: ")),
          Stream.map((line) => JSON.parse(line.slice(6)) as Event),
          Stream.take(2),
          Stream.runForEach((event) => Effect.sync(() => events.push(event)))
        )

        expect(events.length).toBe(2)
        expect(events[0]!.data).toBe("event1")
        expect(events[1]!.data).toBe("event2")
      }).pipe(Effect.scoped, Effect.provide(testLayer)))

    it.effect("supports offset query parameter", () =>
      Effect.gen(function*() {
        yield* HttpServer.serveEffect(eventStreamRouter)
        const client = yield* HttpClient.HttpClient

        // Add 3 events
        const req0 = yield* HttpClientRequest.post("/streams/offset-test").pipe(
          HttpClientRequest.bodyJson({ data: "event0" })
        )
        yield* client.execute(req0)

        const req1 = yield* HttpClientRequest.post("/streams/offset-test").pipe(
          HttpClientRequest.bodyJson({ data: "event1" })
        )
        const res1 = yield* client.execute(req1)
        const event1 = (yield* res1.json) as Event

        const req2 = yield* HttpClientRequest.post("/streams/offset-test").pipe(
          HttpClientRequest.bodyJson({ data: "event2" })
        )
        yield* client.execute(req2)

        // Subscribe starting from event1's offset
        const response = yield* client.get(`/streams/offset-test?offset=${event1.offset}`)

        expect(response.status).toBe(200)

        const events: Array<Event> = []
        yield* response.stream.pipe(
          Stream.decodeText(),
          Stream.mapConcat((chunk) => chunk.split("\n\n")),
          Stream.filter((line) => line.startsWith("data: ")),
          Stream.map((line) => JSON.parse(line.slice(6)) as Event),
          Stream.take(2),
          Stream.runForEach((event) => Effect.sync(() => events.push(event)))
        )

        // Should start from event1, not event0
        expect(events[0]!.data).toBe("event1")
        expect(events[1]!.data).toBe("event2")
      }).pipe(Effect.scoped, Effect.provide(testLayer)))
  })

  describe("DELETE /streams/:name", () => {
    it.effect("deletes stream and returns 204", () =>
      Effect.gen(function*() {
        yield* HttpServer.serveEffect(eventStreamRouter)
        const client = yield* HttpClient.HttpClient

        // Create stream
        const createReq = yield* HttpClientRequest.post("/streams/delete-test").pipe(
          HttpClientRequest.bodyJson({ data: "to be deleted" })
        )
        yield* client.execute(createReq)

        // Verify it exists
        const listBefore = yield* client.get("/streams")
        const bodyBefore = (yield* listBefore.json) as { streams: Array<string> }
        expect(bodyBefore.streams).toContain("delete-test")

        // Delete it
        const deleteRes = yield* client.del("/streams/delete-test")
        expect(deleteRes.status).toBe(204)

        // Verify it's gone
        const listAfter = yield* client.get("/streams")
        const bodyAfter = (yield* listAfter.json) as { streams: Array<string> }
        expect(bodyAfter.streams).not.toContain("delete-test")
      }).pipe(Effect.scoped, Effect.provide(testLayer)))
  })
})
