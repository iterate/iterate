import assert from "node:assert/strict";
import test from "node:test";
import type { Event, EventInput, JSONObject } from "./contract.ts";
import { PullSubscriptionProcessorRuntime } from "./pull-subscription-processor-runtime.ts";
import { defineProcessor } from "./stream-process.ts";

test("catch-up reduces history without calling onEvent", async () => {
  const seenOnEvent: string[] = [];

  const runtime = new PullSubscriptionProcessorRuntime({
    eventsClient: createFakeEventsClient({
      historyEvents: [
        makeEvent({
          offset: 1,
          type: "message",
          payload: { role: "assistant", content: "history" },
        }),
      ],
      liveEvents: [],
    }),
    processor: defineProcessor({
      initialState: { count: 0 },
      reduce: (state, event) => (event.type !== "message" ? state : { count: state.count + 1 }),
      onEvent: async ({ event }) => {
        seenOnEvent.push(String(event.offset));
      },
    }),
    streamPath: "/test",
  });

  await runtime.run();

  assert.deepEqual(seenOnEvent, []);
  assert.deepEqual(runtime.getState(), { count: 1 });
});

test("onEvent receives prevState while state holds the reduced next state", async () => {
  const snapshots: Array<{ prevCount: number; nextCount: number }> = [];

  await new PullSubscriptionProcessorRuntime({
    eventsClient: createFakeEventsClient({
      historyEvents: [],
      liveEvents: [
        makeEvent({
          offset: 1,
          type: "message",
          payload: { role: "user", content: "hello" },
        }),
      ],
    }),
    processor: defineProcessor({
      initialState: { count: 0 },
      reduce: (state, event) => (event.type !== "message" ? state : { count: state.count + 1 }),
      onEvent: async ({ state, prevState }) => {
        snapshots.push({
          prevCount: prevState.count,
          nextCount: state.count,
        });
      },
    }),
    streamPath: "/test",
  }).run();

  assert.deepEqual(snapshots, [{ prevCount: 0, nextCount: 1 }]);
});

test("async onEvent serializes live events and preserves ordering", async () => {
  const steps: string[] = [];
  let releaseFirstEvent: (() => void) | undefined;

  const runtime = new PullSubscriptionProcessorRuntime({
    eventsClient: createFakeEventsClient({
      historyEvents: [],
      liveEvents: [
        makeEvent({
          offset: 1,
          type: "message",
          payload: { role: "user", content: "first" },
        }),
        makeEvent({
          offset: 2,
          type: "message",
          payload: { role: "user", content: "second" },
        }),
      ],
    }),
    processor: defineProcessor({
      initialState: { count: 0 },
      reduce: (state, event) => {
        if (event.type !== "message") {
          return state;
        }

        steps.push(`reduce:${event.offset}`);
        return { count: state.count + 1 };
      },
      onEvent: async ({ event, state, prevState }) => {
        steps.push(`onEvent:start:${event.offset}:${prevState.count}->${state.count}`);

        if (event.offset === 1) {
          await new Promise<void>((resolve) => {
            releaseFirstEvent = resolve;
          });
        }

        steps.push(`onEvent:end:${event.offset}`);
      },
    }),
    streamPath: "/test",
  });

  const runPromise = runtime.run();

  await waitForMicrotasks();
  await waitForMicrotasks();

  assert.deepEqual(steps, ["reduce:1", "onEvent:start:1:0->1"]);

  releaseFirstEvent?.();
  await runPromise;

  assert.deepEqual(steps, [
    "reduce:1",
    "onEvent:start:1:0->1",
    "onEvent:end:1",
    "reduce:2",
    "onEvent:start:2:1->2",
    "onEvent:end:2",
  ]);
});

test("self-appended events are processed after the triggering onEvent completes", async () => {
  const order: string[] = [];
  const liveQueue = createLiveQueue();

  liveQueue.push(
    makeEvent({
      offset: 1,
      type: "message",
      payload: { role: "user", content: "start" },
    }),
  );
  liveQueue.closeWhenEmpty();

  const runtime = new PullSubscriptionProcessorRuntime({
    eventsClient: {
      append: async ({ event, path }) => {
        const appendedEvent = makeEvent({
          offset: 2,
          streamPath: path,
          payload: event.payload,
          type: event.type,
        });
        liveQueue.push(appendedEvent);

        return { created: true, event: appendedEvent, events: [appendedEvent] };
      },
      stream: async (input, options) =>
        input.live ? liveQueue.stream(options.signal) : arrayStream([]),
    },
    processor: defineProcessor({
      initialState: { seen: [] as number[] },
      reduce: (state, event) =>
        event.type !== "message" ? state : { seen: [...state.seen, event.offset] },
      onEvent: async ({ append, event }) => {
        order.push(`start:${event.offset}`);

        if (event.offset === 1) {
          await append({
            type: "message",
            payload: { role: "assistant", content: "follow-up" },
          });
        }

        order.push(`end:${event.offset}`);
      },
    }),
    streamPath: "/test",
  });

  await runtime.run();

  assert.deepEqual(order, ["start:1", "end:1", "start:2", "end:2"]);
  assert.deepEqual(runtime.getState(), { seen: [1, 2] });
});

test("stop aborts a waiting live stream cleanly", async () => {
  const liveQueue = createLiveQueue();
  const runtime = new PullSubscriptionProcessorRuntime({
    eventsClient: {
      append: async () => {
        const event = makeEvent({ offset: 1 });
        return { created: true, event, events: [event] };
      },
      stream: async (input, options) =>
        input.live ? liveQueue.stream(options.signal) : arrayStream([]),
    },
    processor: defineProcessor({
      initialState: { count: 0 },
      reduce: (state) => state,
    }),
    streamPath: "/test",
  });

  const runPromise = runtime.run();

  await waitForMicrotasks();
  runtime.stop();
  await runPromise;
});

test("live boundary does not process the last catch-up event twice", async () => {
  const seenOffsets: string[] = [];

  await new PullSubscriptionProcessorRuntime({
    eventsClient: createFakeEventsClient({
      historyEvents: [
        makeEvent({
          offset: 1,
          type: "message",
          payload: { role: "assistant", content: "history" },
        }),
      ],
      liveEvents: [
        makeEvent({
          offset: 1,
          type: "message",
          payload: { role: "assistant", content: "duplicate-boundary" },
        }),
        makeEvent({
          offset: 2,
          type: "message",
          payload: { role: "user", content: "live" },
        }),
      ],
    }),
    processor: defineProcessor({
      initialState: { offsets: [] as number[] },
      reduce: (state, event) =>
        event.type !== "message" ? state : { offsets: [...state.offsets, event.offset] },
      onEvent: async ({ event }) => {
        seenOffsets.push(String(event.offset));
      },
    }),
    streamPath: "/test",
  }).run();

  assert.deepEqual(seenOffsets, ["2"]);
});

function createFakeEventsClient({
  historyEvents,
  liveEvents,
}: {
  historyEvents: readonly Event[];
  liveEvents: readonly Event[];
}) {
  return {
    append: async ({ event, path }: { event: EventInput; path: string }) => {
      const appendedEvent = makeEvent({
        offset: 10,
        streamPath: path,
        payload: event.payload,
        type: event.type,
      });

      return {
        created: true,
        event: appendedEvent,
        events: [appendedEvent],
      };
    },
    stream: async (input: { live?: boolean }) =>
      input.live ? arrayStream(liveEvents) : arrayStream(historyEvents),
  };
}

function makeEvent({
  offset,
  streamPath = "/test",
  payload = { ok: true },
  type = "test",
}: {
  offset: number;
  streamPath?: string;
  payload?: JSONObject;
  type?: string;
}): Event {
  return {
    offset,
    streamPath,
    payload,
    type,
    createdAt: new Date().toISOString(),
  };
}

async function* arrayStream(events: readonly Event[]) {
  for (const event of events) {
    yield event;
  }
}

function createLiveQueue() {
  const events: Event[] = [];
  const waiters: Array<() => void> = [];
  let shouldCloseWhenEmpty = false;

  return {
    push(event: Event) {
      events.push(event);
      waiters.shift()?.();
    },
    closeWhenEmpty() {
      shouldCloseWhenEmpty = true;
      waiters.shift()?.();
    },
    async *stream(signal?: AbortSignal) {
      while (true) {
        if (events.length > 0) {
          yield events.shift()!;
          continue;
        }

        if (shouldCloseWhenEmpty) {
          return;
        }

        await new Promise<void>((resolve, reject) => {
          const onAbort = () => {
            signal?.removeEventListener("abort", onAbort);
            reject(abortError());
          };

          signal?.addEventListener("abort", onAbort, { once: true });
          waiters.push(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
          });
        });
      }
    },
  };
}

function abortError() {
  return new DOMException("Aborted", "AbortError");
}

async function waitForMicrotasks() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}
