/**
 * StreamManager tests
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Stream } from "effect";
import { StreamManagerService } from "./stream-manager.ts";
import { OFFSET_START, type StreamName } from "./types.ts";

const testStreamName = "test-stream" as StreamName;

describe("StreamManagerService", () => {
  describe("getStream", () => {
    it.effect("creates stream on first access", () =>
      Effect.gen(function* () {
        const manager = yield* StreamManagerService;
        const stream = yield* manager.getStream({ name: testStreamName });

        expect(stream.name).toBe(testStreamName);
      }).pipe(Effect.provide(StreamManagerService.InMemory)),
    );

    it.effect("returns cached stream on subsequent access", () =>
      Effect.gen(function* () {
        const manager = yield* StreamManagerService;
        const stream1 = yield* manager.getStream({ name: testStreamName });
        const stream2 = yield* manager.getStream({ name: testStreamName });

        // Should be exact same instance
        expect(stream1).toBe(stream2);
      }).pipe(Effect.provide(StreamManagerService.InMemory)),
    );

    it.effect("creates separate streams for different names", () =>
      Effect.gen(function* () {
        const manager = yield* StreamManagerService;
        const stream1 = yield* manager.getStream({ name: "stream-a" as StreamName });
        const stream2 = yield* manager.getStream({ name: "stream-b" as StreamName });

        expect(stream1.name).toBe("stream-a");
        expect(stream2.name).toBe("stream-b");
        expect(stream1).not.toBe(stream2);
      }).pipe(Effect.provide(StreamManagerService.InMemory)),
    );
  });

  describe("append", () => {
    it.effect("appends to new stream", () =>
      Effect.gen(function* () {
        const manager = yield* StreamManagerService;
        const event = yield* manager.append({ name: testStreamName, data: { msg: "hello" } });

        expect(event.data).toEqual({ msg: "hello" });
      }).pipe(Effect.provide(StreamManagerService.InMemory)),
    );

    it.effect("appends to existing stream", () =>
      Effect.gen(function* () {
        const manager = yield* StreamManagerService;
        const event1 = yield* manager.append({ name: testStreamName, data: "first" });
        const event2 = yield* manager.append({ name: testStreamName, data: "second" });

        expect(event1.offset < event2.offset).toBe(true);
      }).pipe(Effect.provide(StreamManagerService.InMemory)),
    );

    it.effect("appends to multiple streams independently", () =>
      Effect.gen(function* () {
        const manager = yield* StreamManagerService;

        yield* manager.append({ name: "stream-a" as StreamName, data: "a1" });
        yield* manager.append({ name: "stream-a" as StreamName, data: "a2" });
        yield* manager.append({ name: "stream-b" as StreamName, data: "b1" });

        const streamA = yield* manager.getStream({ name: "stream-a" as StreamName });
        const streamB = yield* manager.getStream({ name: "stream-b" as StreamName });

        const countA = yield* streamA.count;
        const countB = yield* streamB.count;

        expect(countA).toBe(2);
        expect(countB).toBe(1);
      }).pipe(Effect.provide(StreamManagerService.InMemory)),
    );
  });

  describe("subscribe", () => {
    it.effect("subscribes to new stream", () =>
      Effect.gen(function* () {
        const manager = yield* StreamManagerService;

        const eventStream = yield* manager.subscribe({ name: testStreamName });
        const fiber = yield* eventStream.pipe(Stream.take(2), Stream.runCollect, Effect.fork);

        yield* manager.append({ name: testStreamName, data: "event1" });
        yield* manager.append({ name: testStreamName, data: "event2" });

        const events = yield* Fiber.join(fiber).pipe(Effect.timeout("5 seconds"), Effect.orDie);

        expect(events.length).toBe(2);
      }).pipe(Effect.scoped, Effect.provide(StreamManagerService.InMemory)),
    );

    it.effect("subscribes with offset", () =>
      Effect.gen(function* () {
        const manager = yield* StreamManagerService;

        yield* manager.append({ name: testStreamName, data: "event0" });
        const event1 = yield* manager.append({ name: testStreamName, data: "event1" });
        yield* manager.append({ name: testStreamName, data: "event2" });

        // Subscribe starting from event1's offset
        const eventStream = yield* manager.subscribe({
          name: testStreamName,
          offset: event1.offset,
        });

        // Take 2 from historical (event1 + event2)
        const events = yield* eventStream.pipe(Stream.take(2), Stream.runCollect);

        // events is a Chunk, convert to array for assertions
        const arr = Array.from(events);
        expect(arr.length).toBe(2);
        expect(arr[0]!.data).toBe("event1");
        expect(arr[1]!.data).toBe("event2");
      }).pipe(Effect.scoped, Effect.provide(StreamManagerService.InMemory)),
    );

    it.effect("subscribes with OFFSET_START", () =>
      Effect.gen(function* () {
        const manager = yield* StreamManagerService;

        yield* manager.append({ name: testStreamName, data: "event0" });
        yield* manager.append({ name: testStreamName, data: "event1" });

        const eventStream = yield* manager.subscribe({
          name: testStreamName,
          offset: OFFSET_START,
        });

        const events = yield* eventStream.pipe(Stream.take(2), Stream.runCollect);

        const arr = Array.from(events);
        expect(arr[0]!.data).toBe("event0");
        expect(arr[1]!.data).toBe("event1");
      }).pipe(Effect.scoped, Effect.provide(StreamManagerService.InMemory)),
    );
  });

  describe("list", () => {
    it.effect("returns empty list initially", () =>
      Effect.gen(function* () {
        const manager = yield* StreamManagerService;
        const names = yield* manager.list();

        expect(names).toEqual([]);
      }).pipe(Effect.provide(StreamManagerService.InMemory)),
    );

    it.effect("returns stream names after creation", () =>
      Effect.gen(function* () {
        const manager = yield* StreamManagerService;

        yield* manager.append({ name: "stream-a" as StreamName, data: "a" });
        yield* manager.append({ name: "stream-b" as StreamName, data: "b" });

        const names = yield* manager.list();

        expect(names.length).toBe(2);
        expect(names).toContain("stream-a");
        expect(names).toContain("stream-b");
      }).pipe(Effect.provide(StreamManagerService.InMemory)),
    );
  });

  describe("delete", () => {
    it.effect("deletes stream", () =>
      Effect.gen(function* () {
        const manager = yield* StreamManagerService;

        yield* manager.append({ name: testStreamName, data: "event" });
        yield* manager.delete({ name: testStreamName });

        const names = yield* manager.list();
        expect(names).not.toContain(testStreamName);
      }).pipe(Effect.provide(StreamManagerService.InMemory)),
    );

    it.effect("creates fresh stream after delete", () =>
      Effect.gen(function* () {
        const manager = yield* StreamManagerService;

        yield* manager.append({ name: testStreamName, data: "before-delete" });
        yield* manager.delete({ name: testStreamName });

        // New append should create fresh stream
        const event = yield* manager.append({ name: testStreamName, data: "after-delete" });

        // Offset should be 0 (fresh start)
        expect(event.offset).toBe("0000000000000000");
      }).pipe(Effect.provide(StreamManagerService.InMemory)),
    );
  });
});
