/**
 * E2E tests proving hooks are executed.
 *
 * Tests ValidatedFactory which requires _type field on all events.
 */
import { HttpServer } from "@effect/platform"
import { NodeHttpServer } from "@effect/platform-node"
import { Deferred, Effect, Fiber, Layer, Ref } from "effect"
import { createServer } from "node:http"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import type { StreamHooks } from "./hooks.ts"
import { HookError } from "./hooks.ts"
import { eventStreamRouter } from "./http-routes.ts"
import { Storage } from "./storage.ts"
import { EventStreamFactory } from "./stream-factory.ts"
import { StreamManagerService } from "./stream-manager.ts"
import type { Event } from "./types.ts"

describe("Hooks E2E", () => {
  describe("ValidatedFactory (before hook)", () => {
    let baseUrl: string
    let serverFiber: Fiber.RuntimeFiber<void, unknown>

    // Before hook that requires _type field
    const validatedHooks: StreamHooks = {
      beforeAppend: [
        {
          id: "require-type-field",
          run: ({ data }) => {
            const obj = data as Record<string, unknown>
            if (typeof obj._type !== "string") {
              return Effect.fail(
                new HookError({
                  hookId: "require-type-field",
                  message: "Data must have _type string field"
                })
              )
            }
            return Effect.void
          }
        }
      ]
    }

    beforeAll(async () => {
      // Build server with ValidatedFactory
      const serverLayer = Layer.mergeAll(
        NodeHttpServer.layer(createServer, { port: 0 }),
        StreamManagerService.Live.pipe(
          Layer.provide(EventStreamFactory.WithHooks(validatedHooks)),
          Layer.provide(Storage.InMemory)
        )
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

      serverFiber = Effect.runFork(serverEffect)

      const address = await Effect.runPromise(Deferred.await(addressDeferred))
      if (address._tag === "TcpAddress") {
        baseUrl = `http://127.0.0.1:${address.port}`
      } else {
        throw new Error("Expected TCP address")
      }
    })

    afterAll(async () => {
      await Effect.runPromise(Fiber.interrupt(serverFiber))
    })

    test("rejects events without _type field (before hook vetoes)", async () => {
      const response = await fetch(`${baseUrl}/streams/validated-test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: { message: "no type field" } })
      })

      // Should fail because _type is missing - HookError returns 400
      expect(response.status).toBe(400)
      const body = await response.json() as { error: string; hookId: string }
      expect(body.error).toBe("Data must have _type string field")
      expect(body.hookId).toBe("require-type-field")
    })

    test("accepts events with _type field (before hook passes)", async () => {
      const response = await fetch(`${baseUrl}/streams/validated-test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: { _type: "message", text: "hello" } })
      })

      expect(response.status).toBe(201)

      const event = await response.json() as Event
      expect(event.offset).toBe("0000000000000000")
      expect(event.data).toEqual({ _type: "message", text: "hello" })
    })
  })

  describe("Custom hooks (after hook)", () => {
    let baseUrl: string
    let serverFiber: Fiber.RuntimeFiber<void, unknown>
    let afterHookCallCount: Ref.Ref<number>

    beforeAll(async () => {
      // Create a ref to track after hook calls
      afterHookCallCount = Effect.runSync(Ref.make(0))

      // After hook that increments counter
      const trackingHooks: StreamHooks = {
        afterAppend: [
          {
            id: "track-append",
            run: () => Ref.update(afterHookCallCount, (n) => n + 1)
          }
        ]
      }

      const serverLayer = Layer.mergeAll(
        NodeHttpServer.layer(createServer, { port: 0 }),
        StreamManagerService.Live.pipe(
          Layer.provide(EventStreamFactory.WithHooks(trackingHooks)),
          Layer.provide(Storage.InMemory)
        )
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

      serverFiber = Effect.runFork(serverEffect)

      const address = await Effect.runPromise(Deferred.await(addressDeferred))
      if (address._tag === "TcpAddress") {
        baseUrl = `http://127.0.0.1:${address.port}`
      } else {
        throw new Error("Expected TCP address")
      }
    })

    afterAll(async () => {
      await Effect.runPromise(Fiber.interrupt(serverFiber))
    })

    test("after hook is called on successful append", async () => {
      // Get initial count
      const initialCount = Effect.runSync(Ref.get(afterHookCallCount))

      // Append 3 events
      await fetch(`${baseUrl}/streams/after-hook-test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: "event1" })
      })
      await fetch(`${baseUrl}/streams/after-hook-test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: "event2" })
      })
      await fetch(`${baseUrl}/streams/after-hook-test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: "event3" })
      })

      // Check after hook was called 3 times
      const finalCount = Effect.runSync(Ref.get(afterHookCallCount))
      expect(finalCount - initialCount).toBe(3)
    })
  })

  describe("Both hooks", () => {
    let baseUrl: string
    let serverFiber: Fiber.RuntimeFiber<void, unknown>
    let hookOrder: Ref.Ref<Array<string>>

    beforeAll(async () => {
      // Track hook execution order
      hookOrder = Effect.runSync(Ref.make<Array<string>>([]))

      const orderTrackingHooks: StreamHooks = {
        beforeAppend: [
          {
            id: "before-1",
            run: () => Ref.update(hookOrder, (arr) => [...arr, "before-1"])
          },
          {
            id: "before-2",
            run: () => Ref.update(hookOrder, (arr) => [...arr, "before-2"])
          }
        ],
        afterAppend: [
          {
            id: "after-1",
            run: () => Ref.update(hookOrder, (arr) => [...arr, "after-1"])
          },
          {
            id: "after-2",
            run: () => Ref.update(hookOrder, (arr) => [...arr, "after-2"])
          }
        ]
      }

      const serverLayer = Layer.mergeAll(
        NodeHttpServer.layer(createServer, { port: 0 }),
        StreamManagerService.Live.pipe(
          Layer.provide(EventStreamFactory.WithHooks(orderTrackingHooks)),
          Layer.provide(Storage.InMemory)
        )
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

      serverFiber = Effect.runFork(serverEffect)

      const address = await Effect.runPromise(Deferred.await(addressDeferred))
      if (address._tag === "TcpAddress") {
        baseUrl = `http://127.0.0.1:${address.port}`
      } else {
        throw new Error("Expected TCP address")
      }
    })

    afterAll(async () => {
      await Effect.runPromise(Fiber.interrupt(serverFiber))
    })

    test("hooks run in correct order: before-1, before-2, after-1, after-2", async () => {
      // Reset order
      Effect.runSync(Ref.set(hookOrder, []))

      await fetch(`${baseUrl}/streams/order-test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: "test" })
      })

      const order = Effect.runSync(Ref.get(hookOrder))
      expect(order).toEqual(["before-1", "before-2", "after-1", "after-2"])
    })
  })
})
