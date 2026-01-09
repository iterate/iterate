/**
 * E2E tests for subscribeAll functionality
 *
 * Tests:
 * - Receives events from existing streams
 * - Receives events from multiple streams
 * - Discovers new streams dynamically
 * - eventStreamId identifies source stream
 * - Only live events (no historical replay)
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Stream } from "effect";
import { StreamManagerService } from "./stream-manager.ts";
import type { StreamName } from "./types.ts";

describe("subscribeAll", () => {
  // Use it.live for real time tests (subscription and fiber coordination)
  it.live("receives events from existing streams", () =>
    Effect.gen(function* () {
      const manager = yield* StreamManagerService;

      // Create a stream first
      yield* manager.append({ name: "stream-a" as StreamName, data: "setup" });

      // Subscribe to all
      const allEvents = yield* manager.subscribeAll();

      // Fork consumer
      const fiber = yield* allEvents.pipe(Stream.take(1), Stream.runCollect, Effect.fork);

      // Small delay to ensure consumer is ready to receive from merged PubSub
      yield* Effect.sleep("100 millis");

      // Append to existing stream
      yield* manager.append({ name: "stream-a" as StreamName, data: "live-event" });

      // Get result
      const events = yield* Fiber.join(fiber).pipe(Effect.timeout("5 seconds"), Effect.orDie);

      const eventsArray = Array.from(events);
      expect(eventsArray.length).toBe(1);
      expect(eventsArray[0]!.data).toBe("live-event");
    }).pipe(Effect.scoped, Effect.provide(StreamManagerService.InMemory)),
  );

  it.live("receives events from multiple streams", () =>
    Effect.gen(function* () {
      const manager = yield* StreamManagerService;

      // Create two streams
      yield* manager.append({ name: "multi-a" as StreamName, data: "setup-a" });
      yield* manager.append({ name: "multi-b" as StreamName, data: "setup-b" });

      // Subscribe to all
      const allEvents = yield* manager.subscribeAll();

      // Fork consumer for 2 events
      const fiber = yield* allEvents.pipe(Stream.take(2), Stream.runCollect, Effect.fork);

      // Small delay to ensure subscription is set up
      yield* Effect.sleep("50 millis");

      // Append to both streams
      yield* manager.append({ name: "multi-a" as StreamName, data: "event-a" });
      yield* manager.append({ name: "multi-b" as StreamName, data: "event-b" });

      // Get results
      const events = yield* Fiber.join(fiber).pipe(Effect.timeout("5 seconds"), Effect.orDie);

      expect(events.length).toBe(2);
      const dataValues = Array.from(events).map((e) => e.data);
      expect(dataValues).toContain("event-a");
      expect(dataValues).toContain("event-b");
    }).pipe(Effect.scoped, Effect.provide(StreamManagerService.InMemory)),
  );

  it.live("eventStreamId identifies source stream", () =>
    Effect.gen(function* () {
      const manager = yield* StreamManagerService;

      // Create streams
      yield* manager.append({ name: "id-test-a" as StreamName, data: "setup" });
      yield* manager.append({ name: "id-test-b" as StreamName, data: "setup" });

      // Subscribe to all
      const allEvents = yield* manager.subscribeAll();

      // Fork consumer
      const fiber = yield* allEvents.pipe(Stream.take(2), Stream.runCollect, Effect.fork);

      // Small delay to ensure subscription is set up
      yield* Effect.sleep("50 millis");

      // Append to both streams
      yield* manager.append({ name: "id-test-a" as StreamName, data: "from-a" });
      yield* manager.append({ name: "id-test-b" as StreamName, data: "from-b" });

      const events = yield* Fiber.join(fiber).pipe(Effect.timeout("5 seconds"), Effect.orDie);

      // Each event should have eventStreamId matching its source stream
      const eventsArray = Array.from(events);
      const eventFromA = eventsArray.find((e) => e.data === "from-a");
      const eventFromB = eventsArray.find((e) => e.data === "from-b");

      expect(eventFromA).toBeDefined();
      expect(eventFromB).toBeDefined();
      expect(eventFromA!.eventStreamId).toBe("id-test-a");
      expect(eventFromB!.eventStreamId).toBe("id-test-b");
    }).pipe(Effect.scoped, Effect.provide(StreamManagerService.InMemory)),
  );

  it.live("only live events - no historical replay", () =>
    Effect.gen(function* () {
      const manager = yield* StreamManagerService;

      // Append historical events BEFORE subscribing
      yield* manager.append({ name: "history-test" as StreamName, data: "historical-1" });
      yield* manager.append({ name: "history-test" as StreamName, data: "historical-2" });

      // Subscribe to all
      const allEvents = yield* manager.subscribeAll();

      // Fork consumer
      const fiber = yield* allEvents.pipe(Stream.take(1), Stream.runCollect, Effect.fork);

      // Small delay to ensure subscription is set up
      yield* Effect.sleep("100 millis");

      // Append live event AFTER subscribing
      yield* manager.append({ name: "history-test" as StreamName, data: "live-event" });

      const events = yield* Fiber.join(fiber).pipe(Effect.timeout("5 seconds"), Effect.orDie);

      // Should only receive the live event, not historical
      const eventsArray = Array.from(events);
      expect(eventsArray.length).toBe(1);
      expect(eventsArray[0]!.data).toBe("live-event");
    }).pipe(Effect.scoped, Effect.provide(StreamManagerService.InMemory)),
  );

  it.live("discovers new streams dynamically", () =>
    Effect.gen(function* () {
      const manager = yield* StreamManagerService;

      // Subscribe to all BEFORE creating any streams
      const allEvents = yield* manager.subscribeAll();

      // Fork consumer
      const fiber = yield* allEvents.pipe(Stream.take(1), Stream.runCollect, Effect.fork);

      // Wait past discovery interval (1 second) to allow initial discovery loop to run
      yield* Effect.sleep("1200 millis");

      // Create a NEW stream after subscription - the discovery loop should pick it up
      yield* manager.append({ name: "dynamic-stream" as StreamName, data: "discovered" });

      // Wait for next discovery cycle to subscribe to new stream and forward event
      yield* Effect.sleep("1200 millis");

      const events = yield* Fiber.join(fiber).pipe(Effect.timeout("10 seconds"), Effect.orDie);

      const eventsArray = Array.from(events);
      expect(eventsArray.length).toBe(1);
      expect(eventsArray[0]!.data).toBe("discovered");
      expect(eventsArray[0]!.eventStreamId).toBe("dynamic-stream");
    }).pipe(Effect.scoped, Effect.provide(StreamManagerService.InMemory)),
  );
});
