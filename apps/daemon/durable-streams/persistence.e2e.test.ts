/**
 * E2E tests for persistence across server restarts.
 *
 * Tests that events stored in FileSystem storage survive server restarts.
 * Tests run sequentially to avoid port conflicts and shared state issues.
 */
import { HttpServer } from "@effect/platform"
import { NodeContext, NodeHttpServer } from "@effect/platform-node"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import { eventStreamRouter } from "./http-routes.ts"
import { Storage } from "./storage.ts"
import { PlainFactory } from "./stream-factory.ts"
import { StreamManagerService } from "./stream-manager.ts"
import type { Event } from "./types.ts"

/** Helper to start a server with FileSystem storage */
const startServer = async (dataDir: string): Promise<{
  baseUrl: string
  fiber: Fiber.RuntimeFiber<void, unknown>
}> => {
  const storageLayer = Storage.FileSystem({ dataDir }).pipe(
    Layer.provide(NodeContext.layer)
  )
  const serviceLayer = StreamManagerService.Live.pipe(
    Layer.provide(PlainFactory),
    Layer.provide(storageLayer)
  )

  const serverLayer = Layer.mergeAll(
    NodeHttpServer.layer(createServer, { port: 0 }),
    serviceLayer
  ).pipe(Layer.provideMerge(HttpServer.layerContext))

  const fiberId = Effect.runSync(Effect.fiberId)
  const addressDeferred = Deferred.unsafeMake<HttpServer.Address>(fiberId)

  const serverEffect = Effect.gen(function*() {
    const server = yield* HttpServer.HttpServer
    yield* Deferred.succeed(addressDeferred, server.address)
    yield* HttpServer.serveEffect(eventStreamRouter)
    return yield* Effect.never
  }).pipe(
    Effect.scoped,
    Effect.provide(serverLayer)
  )

  const fiber = Effect.runFork(serverEffect)
  const address = await Effect.runPromise(Deferred.await(addressDeferred))

  if (address._tag !== "TcpAddress") {
    throw new Error("Expected TCP address")
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    fiber
  }
}

/** Helper to stop server */
const stopServer = async (fiber: Fiber.RuntimeFiber<void, unknown>) => {
  await Effect.runPromise(Fiber.interrupt(fiber))
}

describe("Persistence E2E", () => {
  test("events persist across server restarts", async () => {
    const testDir = await mkdtemp(join(tmpdir(), "persist-test-"))
    console.log(`Test dir: ${testDir}`)

    try {
      // Start first server
      let server = await startServer(testDir)
      const streamName = "persist-test"

      // 1. Append events to stream
      const res1 = await fetch(`${server.baseUrl}/streams/${streamName}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: { message: "first event" } })
      })
      expect(res1.status).toBe(201)
      const event1 = await res1.json() as Event

      const res2 = await fetch(`${server.baseUrl}/streams/${streamName}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: { message: "second event" } })
      })
      expect(res2.status).toBe(201)
      const event2 = await res2.json() as Event

      // Verify offsets
      expect(event1.offset).toBe("0000000000000000")
      expect(event2.offset).toBe("0000000000000001")

      // 2. Get events before restart (verify they exist)
      const beforeRes = await fetch(`${server.baseUrl}/streams/${streamName}/events`)
      expect(beforeRes.status).toBe(200)
      const beforeBody = await beforeRes.json() as { events: Array<Event> }
      expect(beforeBody.events).toHaveLength(2)

      // 3. Stop server
      await stopServer(server.fiber)
      await new Promise((resolve) => setTimeout(resolve, 100))

      // 4. Start server again (same data directory)
      server = await startServer(testDir)

      // 5. Get events after restart - should still be there
      const afterRes = await fetch(`${server.baseUrl}/streams/${streamName}/events`)
      expect(afterRes.status).toBe(200)
      const afterBody = await afterRes.json() as { events: Array<Event> }

      expect(afterBody.events).toHaveLength(2)
      expect(afterBody.events[0]!.offset).toBe("0000000000000000")
      expect(afterBody.events[0]!.data).toEqual({ message: "first event" })
      expect(afterBody.events[1]!.offset).toBe("0000000000000001")
      expect(afterBody.events[1]!.data).toEqual({ message: "second event" })

      // 6. Append more events after restart - offsets should continue
      const res3 = await fetch(`${server.baseUrl}/streams/${streamName}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: { message: "third event after restart" } })
      })
      expect(res3.status).toBe(201)
      const event3 = await res3.json() as Event

      // Offset should continue from where we left off
      expect(event3.offset).toBe("0000000000000002")

      await stopServer(server.fiber)
    } finally {
      await rm(testDir, { recursive: true, force: true })
    }
  })

  test("stream list survives restart", async () => {
    const testDir = await mkdtemp(join(tmpdir(), "list-persist-"))
    console.log(`Test dir: ${testDir}`)

    try {
      let server = await startServer(testDir)
      const streamName = `list-persist-${Date.now()}`

      // Create a stream
      const createRes = await fetch(`${server.baseUrl}/streams/${streamName}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: "test" })
      })
      expect(createRes.status).toBe(201)

      // Verify stream appears in list
      const listBefore = await fetch(`${server.baseUrl}/streams`)
      const bodyBefore = await listBefore.json() as { streams: Array<string> }
      expect(bodyBefore.streams).toContain(streamName)

      // Restart server
      await stopServer(server.fiber)
      await new Promise((resolve) => setTimeout(resolve, 100))
      server = await startServer(testDir)

      // Verify stream still in list after restart
      const listAfter = await fetch(`${server.baseUrl}/streams`)
      const bodyAfter = await listAfter.json() as { streams: Array<string> }
      expect(bodyAfter.streams).toContain(streamName)

      await stopServer(server.fiber)
    } finally {
      await rm(testDir, { recursive: true, force: true })
    }
  })

  test("get events with offset and limit", async () => {
    const testDir = await mkdtemp(join(tmpdir(), "pagination-"))
    console.log(`Test dir: ${testDir}`)

    try {
      const server = await startServer(testDir)
      const streamName = "pagination-test"

      // Add 5 events
      for (let i = 0; i < 5; i++) {
        await fetch(`${server.baseUrl}/streams/${streamName}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ data: { index: i } })
        })
      }

      // Get all events
      const allRes = await fetch(`${server.baseUrl}/streams/${streamName}/events`)
      const allBody = await allRes.json() as { events: Array<Event> }
      expect(allBody.events).toHaveLength(5)

      // Get with limit
      const limitRes = await fetch(`${server.baseUrl}/streams/${streamName}/events?limit=2`)
      const limitBody = await limitRes.json() as { events: Array<Event> }
      expect(limitBody.events).toHaveLength(2)
      expect((limitBody.events[0]!.data as { index: number }).index).toBe(0)

      // Get with offset (start from event 2)
      const offset = allBody.events[2]!.offset
      const offsetRes = await fetch(`${server.baseUrl}/streams/${streamName}/events?offset=${offset}`)
      const offsetBody = await offsetRes.json() as { events: Array<Event> }
      expect(offsetBody.events).toHaveLength(3) // events 2, 3, 4
      expect((offsetBody.events[0]!.data as { index: number }).index).toBe(2)

      // Get with offset and limit
      const combinedRes = await fetch(`${server.baseUrl}/streams/${streamName}/events?offset=${offset}&limit=1`)
      const combinedBody = await combinedRes.json() as { events: Array<Event> }
      expect(combinedBody.events).toHaveLength(1)
      expect((combinedBody.events[0]!.data as { index: number }).index).toBe(2)

      await stopServer(server.fiber)
    } finally {
      await rm(testDir, { recursive: true, force: true })
    }
  })
})
