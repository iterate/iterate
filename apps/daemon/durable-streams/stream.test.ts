/**
 * Tests for EventStream (Layer 0)
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Queue, Stream } from "effect";
import { Storage } from "./storage.ts";
import { makeEventStream } from "./stream.ts";
import { makeOffset, type Offset, OFFSET_START, type StreamName } from "./types.ts";

const testStreamName = "test-stream" as StreamName;

describe("EventStream", () => {
  describe("append", () => {
    it.effect("assigns sequential offsets", () =>
      Effect.gen(function* () {
        const stream = yield* makeEventStream({ name: testStreamName });

        const e1 = yield* stream.append({ data: { msg: "first" } });
        const e2 = yield* stream.append({ data: { msg: "second" } });

        expect(e1.offset).toBe(makeOffset(0));
        expect(e2.offset).toBe(makeOffset(1));
      }).pipe(Effect.provide(Storage.InMemory)),
    );

    it.effect("stores data correctly", () =>
      Effect.gen(function* () {
        const stream = yield* makeEventStream({ name: testStreamName });

        const event = yield* stream.append({ data: { key: "value" } });

        expect(event.data).toEqual({ key: "value" });
        expect(typeof event.createdAt).toBe("string");
        expect(new Date(event.createdAt).toISOString()).toBe(event.createdAt);
      }).pipe(Effect.provide(Storage.InMemory)),
    );

    it.effect("increments count", () =>
      Effect.gen(function* () {
        const stream = yield* makeEventStream({ name: testStreamName });

        expect(yield* stream.count).toBe(0);

        yield* stream.append({ data: { n: 1 } });
        expect(yield* stream.count).toBe(1);

        yield* stream.append({ data: { n: 2 } });
        expect(yield* stream.count).toBe(2);
      }).pipe(Effect.provide(Storage.InMemory)),
    );
  });

  describe("subscribe", () => {
    it.effect("returns historical events", () =>
      Effect.gen(function* () {
        const stream = yield* makeEventStream({ name: testStreamName });

        yield* stream.append({ data: { msg: "first" } });
        yield* stream.append({ data: { msg: "second" } });

        const eventStream = yield* stream.subscribe();
        const events = yield* eventStream.pipe(
          Stream.take(2),
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
        );

        expect(events).toHaveLength(2);
        expect(events[0]?.data).toEqual({ msg: "first" });
        expect(events[1]?.data).toEqual({ msg: "second" });
      }).pipe(Effect.scoped, Effect.provide(Storage.InMemory)),
    );

    it.effect("receives live events after subscribing", () =>
      Effect.gen(function* () {
        const stream = yield* makeEventStream({ name: testStreamName });
        const collected = yield* Queue.unbounded<unknown>();

        // Subscribe first (no historical events)
        // PubSub.subscribe guarantees subscription IS established when this completes
        const eventStream = yield* stream.subscribe();

        // Fork consumer
        const fiber = yield* eventStream.pipe(
          Stream.take(2),
          Stream.runForEach((e) => Queue.offer(collected, e.data)),
          Effect.fork,
        );

        // Append live events immediately - subscription is already established
        yield* stream.append({ data: { msg: "live1" } });
        yield* stream.append({ data: { msg: "live2" } });

        // Wait for consumer with timeout
        yield* Fiber.join(fiber).pipe(Effect.timeout("5 seconds"), Effect.orDie);

        // Check results
        const results: Array<unknown> = [];
        let item = yield* Queue.poll(collected);
        while (item._tag === "Some") {
          results.push(item.value);
          item = yield* Queue.poll(collected);
        }

        expect(results).toEqual([{ msg: "live1" }, { msg: "live2" }]);
      }).pipe(Effect.scoped, Effect.provide(Storage.InMemory)),
    );

    it.effect("returns both historical and live events", () =>
      Effect.gen(function* () {
        const stream = yield* makeEventStream({ name: testStreamName });
        const collected = yield* Queue.unbounded<unknown>();

        // Add historical
        yield* stream.append({ data: { type: "historical" } });

        // Subscribe - subscription is established when this completes
        const eventStream = yield* stream.subscribe();

        // Fork consumer for 3 events
        const fiber = yield* eventStream.pipe(
          Stream.take(3),
          Stream.runForEach((e) => Queue.offer(collected, e.data)),
          Effect.fork,
        );

        // Add live immediately
        yield* stream.append({ data: { type: "live1" } });
        yield* stream.append({ data: { type: "live2" } });

        yield* Fiber.join(fiber).pipe(Effect.timeout("5 seconds"), Effect.orDie);

        const results: Array<unknown> = [];
        let item = yield* Queue.poll(collected);
        while (item._tag === "Some") {
          results.push(item.value);
          item = yield* Queue.poll(collected);
        }

        expect(results).toEqual([{ type: "historical" }, { type: "live1" }, { type: "live2" }]);
      }).pipe(Effect.scoped, Effect.provide(Storage.InMemory)),
    );
  });

  describe("subscribe with offset", () => {
    it.effect("returns events from specified offset", () =>
      Effect.gen(function* () {
        const stream = yield* makeEventStream({ name: testStreamName });

        yield* stream.append({ data: { n: 0 } });
        yield* stream.append({ data: { n: 1 } });
        yield* stream.append({ data: { n: 2 } });

        // Subscribe from offset 1 (should get n:1 and n:2)
        const eventStream = yield* stream.subscribe({ offset: makeOffset(1) });
        const events = yield* eventStream.pipe(
          Stream.take(2),
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
        );

        expect(events).toHaveLength(2);
        expect(events[0]?.data).toEqual({ n: 1 });
        expect(events[1]?.data).toEqual({ n: 2 });
      }).pipe(Effect.scoped, Effect.provide(Storage.InMemory)),
    );

    it.effect("handles -1 offset (start from beginning)", () =>
      Effect.gen(function* () {
        const stream = yield* makeEventStream({ name: testStreamName });

        yield* stream.append({ data: { n: 0 } });
        yield* stream.append({ data: { n: 1 } });

        const eventStream = yield* stream.subscribe({ offset: OFFSET_START });
        const events = yield* eventStream.pipe(
          Stream.take(2),
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
        );

        expect(events).toHaveLength(2);
        expect(events[0]?.data).toEqual({ n: 0 });
      }).pipe(Effect.scoped, Effect.provide(Storage.InMemory)),
    );

    it.effect("fails with invalid offset", () =>
      Effect.gen(function* () {
        const stream = yield* makeEventStream({ name: testStreamName });

        const result = yield* stream.subscribe({ offset: "invalid" as Offset }).pipe(Effect.either);

        expect(result._tag).toBe("Left");
        if (result._tag === "Left") {
          expect(result.left._tag).toBe("InvalidOffsetError");
        }
      }).pipe(Effect.scoped, Effect.provide(Storage.InMemory)),
    );
  });

  describe("multiple subscribers", () => {
    it.effect("all subscribers receive the same events", () =>
      Effect.gen(function* () {
        const stream = yield* makeEventStream({ name: testStreamName });

        const q1 = yield* Queue.unbounded<unknown>();
        const q2 = yield* Queue.unbounded<unknown>();
        const q3 = yield* Queue.unbounded<unknown>();

        // Create 3 subscribers - all established when this completes
        const s1 = yield* stream.subscribe();
        const s2 = yield* stream.subscribe();
        const s3 = yield* stream.subscribe();

        // Fork all consumers
        const f1 = yield* s1.pipe(
          Stream.take(2),
          Stream.runForEach((e) => Queue.offer(q1, e.data)),
          Effect.fork,
        );
        const f2 = yield* s2.pipe(
          Stream.take(2),
          Stream.runForEach((e) => Queue.offer(q2, e.data)),
          Effect.fork,
        );
        const f3 = yield* s3.pipe(
          Stream.take(2),
          Stream.runForEach((e) => Queue.offer(q3, e.data)),
          Effect.fork,
        );

        // Publish events immediately
        yield* stream.append({ data: { msg: "a" } });
        yield* stream.append({ data: { msg: "b" } });

        // Wait for all with timeout
        yield* Fiber.join(f1).pipe(Effect.timeout("5 seconds"), Effect.orDie);
        yield* Fiber.join(f2).pipe(Effect.timeout("5 seconds"), Effect.orDie);
        yield* Fiber.join(f3).pipe(Effect.timeout("5 seconds"), Effect.orDie);

        // Collect results
        const collect = (q: Queue.Queue<unknown>) =>
          Effect.gen(function* () {
            const results: Array<unknown> = [];
            let item = yield* Queue.poll(q);
            while (item._tag === "Some") {
              results.push(item.value);
              item = yield* Queue.poll(q);
            }
            return results;
          });

        const r1 = yield* collect(q1);
        const r2 = yield* collect(q2);
        const r3 = yield* collect(q3);

        expect(r1).toEqual([{ msg: "a" }, { msg: "b" }]);
        expect(r2).toEqual([{ msg: "a" }, { msg: "b" }]);
        expect(r3).toEqual([{ msg: "a" }, { msg: "b" }]);
      }).pipe(Effect.scoped, Effect.provide(Storage.InMemory)),
    );
  });
});
