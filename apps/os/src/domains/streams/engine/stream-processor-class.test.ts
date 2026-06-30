// Runtime regression tests for the class-based StreamProcessor in
// stream-processor.ts: batch serialization, checkpoint semantics, blocking vs
// background side effects, storage retry, and wildcard consume behavior.
// Compile-time inference is covered separately in stream-processor-types.test.ts.

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineProcessorContract } from "./shared/stream-processors.ts";
import type { StreamEvent } from "./shared/event.ts";
import {
  StreamProcessor,
  type StreamProcessorDeps,
  type StreamProcessorSnapshot,
} from "./stream-processor.ts";
import type { StreamRpc } from "./types.ts";

const iso = new Date(0).toISOString();
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const stream = () => ({ append() {}, appendBatch() {} }) as unknown as StreamRpc;

// ---------------------------------------------------------------------------
// counter — a named-only contract with spy hooks injected through deps
// ---------------------------------------------------------------------------

const CounterContract = defineProcessorContract({
  slug: "test.counter",
  version: "0.1.0",
  description: "Counts amounts for StreamProcessor behavior tests.",
  stateSchema: z.object({ total: z.number().default(0) }),
  initialState: {},
  events: {
    "test/add": { payloadSchema: z.object({ amount: z.number() }) },
    "test/ignored": { payloadSchema: z.object({}) },
  },
  consumes: ["test/add"],
  emits: [],
});
type CounterContract = typeof CounterContract;
type CounterState = { total: number };
type CounterSnapshot = StreamProcessorSnapshot<CounterState>;

type SideEffectHelpers = {
  blockProcessorWhile: (work: () => Promise<unknown>) => void;
  runInBackground: (work: () => Promise<unknown>) => void;
};

type CounterDeps = StreamProcessorDeps<
  CounterContract,
  {
    onProcessEvent?: (
      args: {
        event: StreamEvent;
        previousState: CounterState;
        state: CounterState;
        checkpointOffset: number;
        streamMaxOffset: number;
      } & SideEffectHelpers,
    ) => void;
    onProcessEventBatch?: (
      args: {
        events: readonly StreamEvent[];
        reducedEvents: readonly {
          event: StreamEvent;
          previousState: CounterState;
          state: CounterState;
        }[];
        previousState: CounterState;
        state: CounterState;
        streamMaxOffset: number;
        checkpointOffset: number;
      } & SideEffectHelpers,
    ) => void | Promise<void>;
  }
>;

class CounterProcessor extends StreamProcessor<CounterContract, CounterDeps> {
  readonly contract = CounterContract;

  protected override reduce(args: Parameters<StreamProcessor<CounterContract>["reduce"]>[0]) {
    return { total: args.state.total + args.event.payload.amount };
  }

  protected override processEvent(
    args: Parameters<StreamProcessor<CounterContract>["processEvent"]>[0],
  ): void {
    this.deps.onProcessEvent?.(args);
  }

  protected override async processEventBatch(
    args: Parameters<StreamProcessor<CounterContract>["processEventBatch"]>[0],
  ): Promise<void> {
    await this.deps.onProcessEventBatch?.(args);
    await super.processEventBatch(args);
  }
}

function add(offset: number, amount: number): StreamEvent {
  return { type: "test/add", payload: { amount }, offset, createdAt: iso };
}

function ignored(offset: number): StreamEvent {
  return { type: "test/ignored", payload: {}, offset, createdAt: iso };
}

const SameStateContract = defineProcessorContract({
  slug: "test.same-state",
  version: "0.1.0",
  description: "Returns the same state object for subscription behavior tests.",
  stateSchema: z.object({ seen: z.number().default(0) }),
  initialState: {},
  events: {
    "test/same": { payloadSchema: z.object({}) },
  },
  consumes: ["test/same"],
  emits: [],
});
type SameStateContract = typeof SameStateContract;

class SameStateProcessor extends StreamProcessor<SameStateContract> {
  readonly contract = SameStateContract;

  protected override reduce(args: Parameters<StreamProcessor<SameStateContract>["reduce"]>[0]) {
    return args.state;
  }
}

describe("reduce and checkpoint", () => {
  it("reduces consumed events into state and checkpoints once per batch", async () => {
    const writes: CounterSnapshot[] = [];
    const processor = new CounterProcessor({
      stream: stream(),
      writeState: (snapshot) => void writes.push(snapshot),
    });

    await processor.ingest({ events: [add(1, 5), add(2, 7)], streamMaxOffset: 2 });

    expect(processor.state).toEqual({ total: 12 });
    expect(processor.checkpointOffset).toBe(2);
    expect(writes).toEqual([{ offset: 2, state: { total: 12 } }]);
  });

  it("resumes from readState, parsing the stored state through the schema", async () => {
    const processor = new CounterProcessor({
      stream: stream(),
      // `total` is omitted: the schema default must fill it in on load.
      readState: () => ({ offset: 5, state: {} as CounterState }),
    });

    await processor.ingest({ events: [add(4, 100), add(5, 100), add(6, 3)], streamMaxOffset: 6 });

    // Offsets 4 and 5 are at or below the checkpoint and must not re-reduce.
    expect(processor.state).toEqual({ total: 3 });
    expect(processor.checkpointOffset).toBe(6);
  });

  it("does not write a checkpoint for a fully-replayed batch", async () => {
    const writes: CounterSnapshot[] = [];
    const hooks = vi.fn();
    const processor = new CounterProcessor({
      stream: stream(),
      writeState: (snapshot) => void writes.push(snapshot),
      onProcessEvent: hooks,
      onProcessEventBatch: hooks,
    });

    await processor.ingest({ events: [add(1, 1)], streamMaxOffset: 1 });
    expect(writes).toHaveLength(1);
    expect(hooks).toHaveBeenCalledTimes(2);

    await processor.ingest({ events: [add(1, 1)], streamMaxOffset: 1 });
    expect(writes).toHaveLength(1);
    expect(hooks).toHaveBeenCalledTimes(2);
    expect(processor.state).toEqual({ total: 1 });
  });

  it("advances the checkpoint past events it does not consume, without hooks", async () => {
    const writes: CounterSnapshot[] = [];
    const onProcessEvent = vi.fn();
    const processor = new CounterProcessor({
      stream: stream(),
      writeState: (snapshot) => void writes.push(snapshot),
      onProcessEvent,
    });

    await processor.ingest({ events: [ignored(1)], streamMaxOffset: 1 });

    expect(processor.state).toEqual({ total: 0 });
    expect(processor.checkpointOffset).toBe(1);
    expect(writes).toEqual([{ offset: 1, state: { total: 0 } }]);
    expect(onProcessEvent).not.toHaveBeenCalled();
  });
});

describe("state change subscriptions", () => {
  it("pushes the loaded current state immediately", async () => {
    const processor = new CounterProcessor({
      stream: stream(),
      readState: () => ({ offset: 5, state: { total: 9 } }),
    });
    const states: CounterState[] = [];

    const unsubscribe = await processor.onStateChange((state) => states.push(state));

    expect(states).toEqual([{ total: 9 }]);
    unsubscribe();
  });

  it("notifies after ingest only when the reduced state reference changes", async () => {
    const processor = new CounterProcessor({ stream: stream() });
    const states: CounterState[] = [];
    const unsubscribe = await processor.onStateChange((state) => states.push(state));

    await processor.ingest({ events: [ignored(1)], streamMaxOffset: 1 });
    await processor.ingest({ events: [add(2, 3)], streamMaxOffset: 2 });
    await processor.ingest({ events: [add(2, 3)], streamMaxOffset: 2 });

    expect(states).toEqual([{ total: 0 }, { total: 3 }]);
    unsubscribe();
  });

  it("does not notify when a reducer returns the same state object", async () => {
    const processor = new SameStateProcessor({ stream: stream() });
    const states: Array<{ seen: number }> = [];
    const unsubscribe = await processor.onStateChange((state) => states.push(state));

    await processor.ingest({
      events: [{ type: "test/same", payload: {}, offset: 1, createdAt: iso }],
      streamMaxOffset: 1,
    });

    expect(states).toEqual([{ seen: 0 }]);
    unsubscribe();
  });

  it("unsubscribes and disposes a retained callback stub", async () => {
    const disposeOriginal = vi.fn();
    const disposeRetained = vi.fn();
    const original = Object.assign(vi.fn(), {
      [Symbol.dispose]: disposeOriginal,
      dup: () => Object.assign(vi.fn(), { [Symbol.dispose]: disposeRetained }),
    });
    const processor = new CounterProcessor({ stream: stream() });

    const unsubscribe = await processor.onStateChange(original);
    await processor.ingest({ events: [add(1, 1)], streamMaxOffset: 1 });
    unsubscribe();
    await processor.ingest({ events: [add(2, 1)], streamMaxOffset: 2 });

    expect(original).not.toHaveBeenCalled();
    expect(disposeOriginal).not.toHaveBeenCalled();
    expect(disposeRetained).toHaveBeenCalledTimes(1);
  });
});

describe("hook wiring", () => {
  it("default processEventBatch calls processEvent once per reduced event with per-event states", async () => {
    const calls: { offset: number; previousTotal: number; total: number; checkpoint: number }[] =
      [];
    const processor = new CounterProcessor({
      stream: stream(),
      onProcessEvent: (args) => {
        calls.push({
          offset: args.event.offset,
          previousTotal: args.previousState.total,
          total: args.state.total,
          checkpoint: args.checkpointOffset,
        });
      },
    });

    await processor.ingest({ events: [add(1, 5), add(2, 7)], streamMaxOffset: 9 });

    expect(calls).toEqual([
      { offset: 1, previousTotal: 0, total: 5, checkpoint: 2 },
      { offset: 2, previousTotal: 5, total: 12, checkpoint: 2 },
    ]);
  });

  it("processEventBatch sees deduped events plus batch-entry and batch-exit state", async () => {
    const batches: { offsets: number[]; previousTotal: number; total: number }[] = [];
    const processor = new CounterProcessor({
      stream: stream(),
      readState: () => ({ offset: 1, state: { total: 1 } }),
      onProcessEventBatch: (args) => {
        batches.push({
          offsets: args.events.map((event) => event.offset),
          previousTotal: args.previousState.total,
          total: args.state.total,
        });
        expect(args.reducedEvents).toHaveLength(2);
      },
    });

    await processor.ingest({ events: [add(1, 99), add(2, 2), add(3, 3)], streamMaxOffset: 3 });

    expect(batches).toEqual([{ offsets: [2, 3], previousTotal: 1, total: 6 }]);
  });
});

describe("batch serialization", () => {
  it("a later batch never starts until the previous one finished", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const processor = new CounterProcessor({
      stream: stream(),
      onProcessEventBatch: async (args) => {
        const firstOffset = args.events[0]!.offset;
        order.push(`start:${firstOffset}`);
        if (firstOffset === 1) await gate;
        order.push(`end:${firstOffset}`);
      },
    });

    const first = processor.ingest({ events: [add(1, 1)], streamMaxOffset: 1 });
    const second = processor.ingest({ events: [add(2, 1)], streamMaxOffset: 2 });
    await tick();
    expect(order).toEqual(["start:1"]);

    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["start:1", "end:1", "start:2", "end:2"]);
  });

  it("a failed batch is not checkpointed, does not poison the queue, and can be redelivered", async () => {
    const writes: CounterSnapshot[] = [];
    let failNext = true;
    const processor = new CounterProcessor({
      stream: stream(),
      writeState: (snapshot) => void writes.push(snapshot),
      onProcessEventBatch: () => {
        if (failNext) {
          failNext = false;
          throw new Error("batch boom");
        }
      },
    });

    await expect(processor.ingest({ events: [add(1, 5)], streamMaxOffset: 1 })).rejects.toThrow(
      "batch boom",
    );
    expect(writes).toEqual([]);
    expect(processor.checkpointOffset).toBe(0);

    // At-least-once: the same batch redelivers and reduces from the old state.
    await processor.ingest({ events: [add(1, 5)], streamMaxOffset: 1 });
    expect(processor.state).toEqual({ total: 5 });
    expect(writes).toEqual([{ offset: 1, state: { total: 5 } }]);
  });
});

describe("blocking and background side effects", () => {
  it("blockProcessorWhile holds the checkpoint until the work completes", async () => {
    const writes: CounterSnapshot[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const processor = new CounterProcessor({
      stream: stream(),
      writeState: (snapshot) => void writes.push(snapshot),
      onProcessEvent: ({ blockProcessorWhile }) => blockProcessorWhile(() => gate),
    });

    const processed = processor.ingest({ events: [add(1, 1)], streamMaxOffset: 1 });
    await tick();
    expect(writes).toEqual([]);

    release();
    await processed;
    expect(writes).toEqual([{ offset: 1, state: { total: 1 } }]);
  });

  it("failed blocking work fails the batch and skips the checkpoint", async () => {
    const writes: CounterSnapshot[] = [];
    let failNext = true;
    const processor = new CounterProcessor({
      stream: stream(),
      writeState: (snapshot) => void writes.push(snapshot),
      onProcessEvent: ({ blockProcessorWhile }) => {
        blockProcessorWhile(async () => {
          if (failNext) {
            failNext = false;
            throw new Error("side effect failed");
          }
        });
      },
    });

    await expect(processor.ingest({ events: [add(1, 1)], streamMaxOffset: 1 })).rejects.toThrow(
      "side effect failed",
    );
    expect(writes).toEqual([]);

    await processor.ingest({ events: [add(1, 1)], streamMaxOffset: 1 });
    expect(writes).toEqual([{ offset: 1, state: { total: 1 } }]);
  });

  it("settles blocking work registered before a hook throw instead of abandoning it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let blockingWorkFinished = false;
    const processor = new CounterProcessor({
      stream: stream(),
      onProcessEvent: ({ event, blockProcessorWhile }) => {
        if (event.offset === 1) {
          blockProcessorWhile(() =>
            gate.then(() => {
              blockingWorkFinished = true;
            }),
          );
        }
        if (event.offset === 2) throw new Error("hook boom");
      },
    });

    const outcome = processor.ingest({ events: [add(1, 1), add(2, 1)], streamMaxOffset: 2 }).then(
      () => "resolved",
      (error: unknown) => (error as Error).message,
    );

    // The hook for offset 2 already threw, but the batch must not settle until
    // the blocking work from offset 1 has settled too.
    expect(await Promise.race([outcome, tick().then(() => "pending")])).toBe("pending");

    release();
    expect(await outcome).toBe("hook boom");
    expect(blockingWorkFinished).toBe(true);
  });

  it("runInBackground does not hold the checkpoint and logs failures", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const writes: CounterSnapshot[] = [];
    const processor = new CounterProcessor({
      stream: stream(),
      writeState: (snapshot) => void writes.push(snapshot),
      onProcessEvent: ({ runInBackground }) => {
        runInBackground(async () => {
          throw new Error("background fail");
        });
      },
    });

    await processor.ingest({ events: [add(1, 1)], streamMaxOffset: 1 });
    expect(writes).toHaveLength(1);

    await tick();
    expect(errorSpy).toHaveBeenCalledWith(
      "stream processor background work failed",
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });

  it("routes async work through the host's keepAliveWhile", async () => {
    const keepAliveWhile = vi.fn((work: () => Promise<unknown>) => void work());
    const processor = new CounterProcessor({
      stream: stream(),
      keepAliveWhile,
      onProcessEvent: ({ blockProcessorWhile, runInBackground }) => {
        blockProcessorWhile(async () => {});
        runInBackground(async () => {});
      },
    });

    await processor.ingest({ events: [add(1, 1)], streamMaxOffset: 1 });
    expect(keepAliveWhile).toHaveBeenCalledTimes(2);
  });
});

describe("state storage", () => {
  it("retries a failed readState on the next batch instead of caching the rejection", async () => {
    let attempts = 0;
    const processor = new CounterProcessor({
      stream: stream(),
      readState: () => {
        attempts += 1;
        if (attempts === 1) throw new Error("storage offline");
        return { offset: 3, state: { total: 9 } };
      },
    });

    await expect(processor.ingest({ events: [add(4, 1)], streamMaxOffset: 4 })).rejects.toThrow(
      "storage offline",
    );

    await processor.ingest({ events: [add(4, 1)], streamMaxOffset: 4 });
    expect(attempts).toBe(2);
    expect(processor.state).toEqual({ total: 10 });
    expect(processor.checkpointOffset).toBe(4);
  });

  it("falls back to in-memory snapshots when no storage is provided", async () => {
    const processor = new CounterProcessor({ stream: stream() });

    await processor.ingest({ events: [add(1, 5)], streamMaxOffset: 1 });

    expect(await processor.snapshot()).toEqual({ offset: 1, state: { total: 5 } });
  });
});

// ---------------------------------------------------------------------------
// wildcard consume runtime semantics
// ---------------------------------------------------------------------------

const WildcardContract = defineProcessorContract({
  slug: "test.wildcard-runtime",
  version: "0.1.0",
  description: "Mixed wildcard consumption for runtime behavior tests.",
  stateSchema: z.object({
    named: z.number().default(0),
    other: z.number().default(0),
  }),
  initialState: {},
  events: {
    "test/named": { payloadSchema: z.object({ value: z.number() }) },
  },
  consumes: ["*", "test/named"],
  emits: [],
});
type WildcardContract = typeof WildcardContract;

class WildcardProcessor extends StreamProcessor<WildcardContract> {
  readonly contract = WildcardContract;

  protected override reduce(args: Parameters<StreamProcessor<WildcardContract>["reduce"]>[0]) {
    switch (args.event.type) {
      case "test/named":
        return { ...args.state, named: args.state.named + args.event.payload.value };
      default:
        return { ...args.state, other: args.state.other + 1 };
    }
  }
}

describe("wildcard consumption", () => {
  it("validates named event payloads and passes unnamed events through", async () => {
    const processor = new WildcardProcessor({ stream: stream() });

    await processor.ingest({
      events: [
        { type: "test/named", payload: { value: 5 }, offset: 1, createdAt: iso },
        { type: "test/unrelated", payload: { anything: ["goes"] }, offset: 2, createdAt: iso },
        { type: "test/named", payload: { value: 2 }, offset: 3, createdAt: iso },
      ],
      streamMaxOffset: 3,
    });

    expect(processor.state).toEqual({ named: 7, other: 1 });
  });

  it("rejects the batch when a named event payload fails its schema", async () => {
    const processor = new WildcardProcessor({ stream: stream() });

    await expect(
      processor.ingest({
        events: [{ type: "test/named", payload: { value: "nope" }, offset: 1, createdAt: iso }],
        streamMaxOffset: 1,
      }),
    ).rejects.toThrow();
    expect(processor.checkpointOffset).toBe(0);
  });
});
