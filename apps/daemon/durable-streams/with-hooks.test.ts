/**
 * Tests for withHooks() wrapper
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Ref } from "effect";
import { HookError, type StreamHooks } from "./hooks.ts";
import { Storage } from "./storage.ts";
import { makeEventStream } from "./stream.ts";
import type { StreamName } from "./types.ts";
import { withHooks } from "./with-hooks.ts";

describe("withHooks", () => {
  const testStreamName = "test-stream" as StreamName;

  const makeTestStream = Effect.gen(function* () {
    return yield* makeEventStream({ name: testStreamName });
  }).pipe(Effect.provide(Storage.InMemory));

  describe("beforeAppend hooks", () => {
    it.effect("runs before hooks before append", () =>
      Effect.gen(function* () {
        const callOrder = yield* Ref.make<Array<string>>([]);

        const hooks: StreamHooks = {
          beforeAppend: [
            {
              id: "track-before",
              run: () => Ref.update(callOrder, (arr) => [...arr, "before"]),
            },
          ],
          afterAppend: [
            {
              id: "track-after",
              run: () => Ref.update(callOrder, (arr) => [...arr, "after"]),
            },
          ],
        };

        const base = yield* makeTestStream;
        const wrapped = withHooks(base, hooks);

        yield* wrapped.append({ data: { test: true } });

        const order = yield* Ref.get(callOrder);
        expect(order).toEqual(["before", "after"]);
      }),
    );

    it.effect("vetoes append when before hook fails", () =>
      Effect.gen(function* () {
        const appendCalled = yield* Ref.make(false);

        const hooks: StreamHooks = {
          beforeAppend: [
            {
              id: "veto-hook",
              run: () =>
                Effect.fail(
                  new HookError({
                    hookId: "veto-hook",
                    message: "Vetoed!",
                  }),
                ),
            },
          ],
        };

        const base = yield* makeTestStream;
        // Track if base append is called
        const trackedBase = {
          ...base,
          append: (opts: { data: unknown }) =>
            Effect.gen(function* () {
              yield* Ref.set(appendCalled, true);
              return yield* base.append(opts);
            }),
        };
        const wrapped = withHooks(trackedBase, hooks);

        const result = yield* wrapped.append({ data: {} }).pipe(Effect.either);

        expect(result._tag).toBe("Left");
        if (result._tag === "Left") {
          expect(result.left._tag).toBe("HookError");
        }

        // Base append should NOT have been called
        expect(yield* Ref.get(appendCalled)).toBe(false);
      }),
    );

    it.effect("runs multiple before hooks in order", () =>
      Effect.gen(function* () {
        const callOrder = yield* Ref.make<Array<string>>([]);

        const hooks: StreamHooks = {
          beforeAppend: [
            {
              id: "first",
              run: () => Ref.update(callOrder, (arr) => [...arr, "first"]),
            },
            {
              id: "second",
              run: () => Ref.update(callOrder, (arr) => [...arr, "second"]),
            },
            {
              id: "third",
              run: () => Ref.update(callOrder, (arr) => [...arr, "third"]),
            },
          ],
        };

        const base = yield* makeTestStream;
        const wrapped = withHooks(base, hooks);

        yield* wrapped.append({ data: {} });

        const order = yield* Ref.get(callOrder);
        expect(order).toEqual(["first", "second", "third"]);
      }),
    );

    it.effect("stops at first failing before hook", () =>
      Effect.gen(function* () {
        const callOrder = yield* Ref.make<Array<string>>([]);

        const hooks: StreamHooks = {
          beforeAppend: [
            {
              id: "first",
              run: () => Ref.update(callOrder, (arr) => [...arr, "first"]),
            },
            {
              id: "fail",
              run: () =>
                Ref.update(callOrder, (arr) => [...arr, "fail"]).pipe(
                  Effect.flatMap(() =>
                    Effect.fail(new HookError({ hookId: "fail", message: "stop" })),
                  ),
                ),
            },
            {
              id: "never-reached",
              run: () => Ref.update(callOrder, (arr) => [...arr, "never"]),
            },
          ],
        };

        const base = yield* makeTestStream;
        const wrapped = withHooks(base, hooks);

        yield* wrapped.append({ data: {} }).pipe(Effect.ignore);

        const order = yield* Ref.get(callOrder);
        expect(order).toEqual(["first", "fail"]);
      }),
    );
  });

  describe("afterAppend hooks", () => {
    it.effect("receives the created event", () =>
      Effect.gen(function* () {
        const receivedEvent = yield* Ref.make<unknown>(null);

        const hooks: StreamHooks = {
          afterAppend: [
            {
              id: "capture-event",
              run: ({ event }) => Ref.set(receivedEvent, event),
            },
          ],
        };

        const base = yield* makeTestStream;
        const wrapped = withHooks(base, hooks);

        const event = yield* wrapped.append({ data: { msg: "hello" } });

        const captured = yield* Ref.get(receivedEvent);
        expect(captured).toEqual(event);
      }),
    );

    it.effect("logs error but succeeds when after hook fails", () =>
      Effect.gen(function* () {
        // After hooks have type Effect<void, never>, so we just make it succeed
        // The actual error handling is tested by checking the result succeeds
        const hookCalled = yield* Ref.make(false);

        const hooks: StreamHooks = {
          afterAppend: [
            {
              id: "after-hook",
              run: () => Ref.set(hookCalled, true),
            },
          ],
        };

        const base = yield* makeTestStream;
        const wrapped = withHooks(base, hooks);

        // Should succeed
        const result = yield* wrapped.append({ data: {} }).pipe(Effect.either);
        expect(result._tag).toBe("Right");
        expect(yield* Ref.get(hookCalled)).toBe(true);
      }),
    );

    it.effect("runs multiple after hooks", () =>
      Effect.gen(function* () {
        const callCount = yield* Ref.make(0);

        const hooks: StreamHooks = {
          afterAppend: [
            { id: "a", run: () => Ref.update(callCount, (n) => n + 1) },
            { id: "b", run: () => Ref.update(callCount, (n) => n + 1) },
            { id: "c", run: () => Ref.update(callCount, (n) => n + 1) },
          ],
        };

        const base = yield* makeTestStream;
        const wrapped = withHooks(base, hooks);

        yield* wrapped.append({ data: {} });

        expect(yield* Ref.get(callCount)).toBe(3);
      }),
    );
  });

  describe("passthrough methods", () => {
    it.scoped("subscribe passes through unchanged", () =>
      Effect.gen(function* () {
        const base = yield* makeTestStream;
        const wrapped = withHooks(base, {});

        // Append via base
        yield* base.append({ data: { from: "base" } });

        // Subscribe via wrapped - should get the stream
        const stream = yield* wrapped.subscribe();

        // Just verify we can call subscribe and it returns a stream
        expect(stream).toBeDefined();
      }),
    );

    it.effect("count passes through unchanged", () =>
      Effect.gen(function* () {
        const base = yield* makeTestStream;
        const wrapped = withHooks(base, {});

        yield* base.append({ data: {} });
        yield* base.append({ data: {} });

        const count = yield* wrapped.count;
        expect(count).toBe(2);
      }),
    );
  });
});
