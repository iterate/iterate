import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Stream, StreamEvent, StreamEventInput } from "../../types.ts";
import { defineProcessorContract } from "./processor-contracts.ts";
import { StreamProcessor } from "./stream-processor.ts";

const CounterContract = defineProcessorContract({
  slug: "test-counter",
  version: "0.0.1",
  description: "Counts increments; exists to test the base class subscription machinery.",
  stateSchema: z.object({ count: z.number().default(0) }),
  events: {
    "events.iterate.com/test/incremented": {
      description: "The counter was incremented.",
      payloadSchema: z.object({ by: z.number() }),
    },
  },
  consumes: ["events.iterate.com/test/incremented"],
  emits: [],
});

class CounterProcessor extends StreamProcessor<typeof CounterContract> {
  readonly contract = CounterContract;

  protected override reduce({
    event,
    state,
  }: {
    event: { payload: { by: number } };
    state: { count: number };
  }) {
    return { count: state.count + event.payload.by };
  }
}

const neverStream = new Proxy({} as Stream, {
  get(_target, property) {
    throw new Error(`Unexpected stream access: ${String(property)}`);
  },
});

let nextOffset = 0;
function incrementedEvent(by: number, offset?: number): StreamEvent {
  nextOffset = offset ?? nextOffset + 1;
  return {
    type: "events.iterate.com/test/incremented",
    payload: { by },
    createdAt: new Date(nextOffset).toISOString(),
    offset: nextOffset,
  };
}

function unrelatedEvent(offset?: number): StreamEvent {
  nextOffset = offset ?? nextOffset + 1;
  return {
    type: "events.iterate.com/other/happened",
    createdAt: new Date(nextOffset).toISOString(),
    offset: nextOffset,
  };
}

function counter() {
  nextOffset = 0;
  return new CounterProcessor({ stream: neverStream });
}

describe("StreamProcessor.onStateChange", () => {
  it("pushes the current checkpoint snapshot immediately on subscribe", async () => {
    const processor = counter();
    const pushes: unknown[] = [];
    await processor.onStateChange((snapshot) => void pushes.push(snapshot));
    expect(pushes).toEqual([{ offset: 0, state: { count: 0 } }]);
  });

  it("pushes { offset, state } after every checkpointed batch that changed state", async () => {
    const processor = counter();
    const pushes: { offset: number; state: { count: number } }[] = [];
    await processor.onStateChange((snapshot) => void pushes.push(snapshot));

    await processor.ingest({ events: [incrementedEvent(2)], streamMaxOffset: 1 });
    await processor.ingest({
      events: [incrementedEvent(3), incrementedEvent(5)],
      streamMaxOffset: 3,
    });

    expect(pushes).toEqual([
      { offset: 0, state: { count: 0 } },
      { offset: 1, state: { count: 2 } },
      { offset: 3, state: { count: 10 } },
    ]);
  });

  it("advances the checkpoint through non-consumed events without pushing", async () => {
    const processor = counter();
    const pushes: unknown[] = [];
    await processor.onStateChange((snapshot) => void pushes.push(snapshot));

    await processor.ingest({ events: [unrelatedEvent()], streamMaxOffset: 1 });

    expect(pushes).toHaveLength(1);
    await expect(processor.snapshot()).resolves.toEqual({ offset: 1, state: { count: 0 } });
  });

  it("unsubscribe stops pushes and isLive reports the drop", async () => {
    const processor = counter();
    const pushes: unknown[] = [];
    const handle = await processor.onStateChange((snapshot) => void pushes.push(snapshot));

    expect(handle.isLive()).toBe(true);
    handle.unsubscribe();
    expect(handle.isLive()).toBe(false);

    await processor.ingest({ events: [incrementedEvent(1)], streamMaxOffset: 1 });
    expect(pushes).toHaveLength(1);
  });

  // NOTE: callbacks in these tests count calls manually instead of via vi.fn —
  // the processor DISPOSES a dropped callback (releasing the RPC stub), and
  // vitest mocks implement Symbol.dispose as mockRestore, which wipes the call
  // record the moment the (correct) disposal happens.
  it("a synchronously throwing callback rejects the subscribe and registers nothing", async () => {
    const processor = counter();
    let calls = 0;
    const cb = () => {
      calls += 1;
      throw new Error("broken stub");
    };
    await expect(processor.onStateChange(cb)).rejects.toThrow("broken stub");
    expect(calls).toBe(1);

    // Nothing registered: the next state change must not call it again.
    await processor.ingest({ events: [incrementedEvent(1)], streamMaxOffset: 1 });
    expect(calls).toBe(1);
  });

  it("an async delivery rejection drops the subscription (dead remotes self-prune)", async () => {
    const processor = counter();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      let calls = 0;
      const handle = await processor.onStateChange(() => {
        calls += 1;
        // The initial push succeeds; every later delivery rejects, the way a
        // dead capnweb/Workers RPC stub rejects every call.
        return calls === 1 ? undefined : Promise.reject(new Error("stub is broken"));
      });

      await processor.ingest({ events: [incrementedEvent(1)], streamMaxOffset: 1 });
      // The rejection is observed asynchronously.
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(handle.isLive()).toBe(false);
      await processor.ingest({ events: [incrementedEvent(1)], streamMaxOffset: 2 });
      expect(calls).toBe(2);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("a transport onRpcBroken signal drops the subscription", async () => {
    const processor = counter();
    let broken: ((error: unknown) => void) | undefined;
    let calls = 0;
    const cb = Object.assign(() => void (calls += 1), {
      onRpcBroken(register: (error: unknown) => void) {
        broken = register;
      },
    });

    const handle = await processor.onStateChange(cb);
    expect(handle.isLive()).toBe(true);
    expect(calls).toBe(1);

    broken?.(new Error("session lost"));
    expect(handle.isLive()).toBe(false);

    await processor.ingest({ events: [incrementedEvent(1)], streamMaxOffset: 1 });
    expect(calls).toBe(1);
  });

  it("dup()s a retainable callback and disposes the duplicate on unsubscribe", async () => {
    const processor = counter();
    const dispose = vi.fn();
    const duplicate = Object.assign(vi.fn(), { [Symbol.dispose]: dispose });
    const cb = Object.assign(vi.fn(), { dup: () => duplicate });

    const handle = await processor.onStateChange(cb);
    expect(duplicate).toHaveBeenCalledTimes(1); // deliveries go to the duplicate
    expect(cb).not.toHaveBeenCalled();

    handle.unsubscribe();
    expect(dispose).toHaveBeenCalledTimes(1);

    handle.unsubscribe(); // idempotent: a second call must not double-dispose
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});

// Streams accept raw appends by design, so a committed event can carry a
// consumed TYPE with a shape the contract rejects. These tests pin the
// skip-and-record behavior: the fold advances past the event (no wedged
// checkpoint) and the skip is recorded on the stream, idempotently.
describe("StreamProcessor parse-failure skipping", () => {
  function unparseableEvent(offset?: number): StreamEvent {
    nextOffset = offset ?? nextOffset + 1;
    return {
      type: "events.iterate.com/test/incremented",
      payload: { by: "not-a-number" },
      createdAt: new Date(nextOffset).toISOString(),
      offset: nextOffset,
    };
  }

  function recordingStream() {
    const appends: StreamEventInput[] = [];
    const stream = {
      append: (...events: StreamEventInput[]) => {
        appends.push(...events);
        return Promise.resolve(
          events.map((event, index) => ({
            ...event,
            offset: 1_000 + appends.length + index,
            createdAt: new Date(0).toISOString(),
          })),
        );
      },
    } as unknown as Stream;
    return { appends, stream };
  }

  function recordingCounter() {
    nextOffset = 0;
    const { appends, stream } = recordingStream();
    return { appends, processor: new CounterProcessor({ stream }) };
  }

  it("skips an unparseable consumed-type event and folds the rest of the batch", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { processor } = recordingCounter();
      await processor.ingest({
        events: [incrementedEvent(2), unparseableEvent(), incrementedEvent(3)],
        streamMaxOffset: 3,
      });
      await expect(processor.snapshot()).resolves.toEqual({ offset: 3, state: { count: 5 } });
    } finally {
      consoleError.mockRestore();
    }
  });

  it("advances the checkpoint past a batch containing only an unparseable event", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { processor } = recordingCounter();
      await processor.ingest({ events: [unparseableEvent()], streamMaxOffset: 1 });
      await expect(processor.snapshot()).resolves.toEqual({ offset: 1, state: { count: 0 } });
    } finally {
      consoleError.mockRestore();
    }
  });

  it("records each skip on the stream with an offset-scoped idempotency key", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { appends, processor } = recordingCounter();
      await processor.ingest({
        events: [incrementedEvent(1), unparseableEvent()],
        streamMaxOffset: 2,
      });

      // The record append is fire-and-forget background work.
      await vi.waitFor(() => expect(appends).toHaveLength(1));
      expect(appends[0]).toMatchObject({
        type: "events.iterate.com/stream/error-occurred",
        idempotencyKey: "processor-event-parse-failed:test-counter:2",
      });
      expect(consoleError).toHaveBeenCalledTimes(1);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("redelivery of an already-skipped event neither re-reduces nor re-records", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { appends, processor } = recordingCounter();
      const batch = [incrementedEvent(2), unparseableEvent()];
      await processor.ingest({ events: batch, streamMaxOffset: 2 });
      await vi.waitFor(() => expect(appends).toHaveLength(1));

      await processor.ingest({ events: batch, streamMaxOffset: 2 });
      await new Promise((resolve) => setTimeout(resolve, 0));

      await expect(processor.snapshot()).resolves.toEqual({ offset: 2, state: { count: 2 } });
      expect(appends).toHaveLength(1);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("a failing record append is logged, never rethrown into the batch", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      nextOffset = 0;
      const processor = new CounterProcessor({
        stream: {
          append: () => Promise.reject(new Error("append transport down")),
        } as unknown as Stream,
      });

      await processor.ingest({ events: [unparseableEvent()], streamMaxOffset: 1 });
      await new Promise((resolve) => setTimeout(resolve, 0));

      // The skip committed even though recording it failed.
      await expect(processor.snapshot()).resolves.toEqual({ offset: 1, state: { count: 0 } });
    } finally {
      consoleError.mockRestore();
    }
  });
});
