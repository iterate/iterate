import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Stream } from "../../itx-api.generated.ts";
import type { StreamEvent, StreamEventInput } from "./schemas.ts";
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
    path: "/tests/counter",
  };
}

function unrelatedEvent(offset?: number): StreamEvent {
  nextOffset = offset ?? nextOffset + 1;
  return {
    type: "events.iterate.com/other/happened",
    createdAt: new Date(nextOffset).toISOString(),
    offset: nextOffset,
    path: "/tests/counter",
  };
}

function counter() {
  nextOffset = 0;
  return new CounterProcessor({ stream: neverStream, path: "/tests/counter", projectId: null });
}

describe("StreamProcessor.observeStateChanges", () => {
  it("notifies the observer with the new snapshot after every state-changing batch", async () => {
    const processor = counter();
    const snapshots: { offset: number; state: { count: number } }[] = [];
    processor.observeStateChanges((snapshot) => void snapshots.push(snapshot));

    await processor.ingest({ events: [incrementedEvent(2)], streamMaxOffset: 1 });
    await processor.ingest({
      events: [incrementedEvent(3), incrementedEvent(5)],
      streamMaxOffset: 3,
    });

    expect(snapshots).toEqual([
      { offset: 1, state: { count: 2 } },
      { offset: 3, state: { count: 10 } },
    ]);
  });

  it("does not notify when a batch leaves state unchanged", async () => {
    const processor = counter();
    const snapshots: unknown[] = [];
    processor.observeStateChanges((snapshot) => void snapshots.push(snapshot));

    await processor.ingest({ events: [unrelatedEvent()], streamMaxOffset: 1 });

    expect(snapshots).toHaveLength(0);
    await expect(processor.snapshot()).resolves.toEqual({ offset: 1, state: { count: 0 } });
  });

  it("stops notifying after unsubscribe; currentState reflects the fold", async () => {
    const processor = counter();
    const snapshots: unknown[] = [];
    const unsubscribe = processor.observeStateChanges((snapshot) => void snapshots.push(snapshot));

    await processor.ingest({ events: [incrementedEvent(1)], streamMaxOffset: 1 });
    expect(snapshots).toHaveLength(1);
    expect(processor.currentState).toEqual({ count: 1 });

    unsubscribe();
    await processor.ingest({ events: [incrementedEvent(1)], streamMaxOffset: 2 });
    expect(snapshots).toHaveLength(1);
  });
});

describe("StreamProcessor.ingestThrough", () => {
  it("durably checkpoints a filtered scan through omitted events and reconciles at head", async () => {
    nextOffset = 0;
    const writes: { offset: number; state: { count: number } }[] = [];
    const reconciledOffsets: number[] = [];
    class ScannedCounter extends CounterProcessor {
      protected override async reconcile(
        args: Parameters<StreamProcessor<typeof CounterContract>["reconcile"]>[0],
      ): Promise<void> {
        reconciledOffsets.push(args.checkpointOffset);
      }
    }
    const processor = new ScannedCounter({
      stream: neverStream,
      path: "/tests/counter",
      projectId: null,
      writeState: (snapshot) => void writes.push(snapshot),
    });
    const caughtUp = processor.waitUntilEvent({ offset: 3 });
    await Promise.resolve();

    await processor.ingestThrough({
      events: [incrementedEvent(2, 1)],
      deliveryThroughOffset: 3,
      streamMaxOffset: 3,
    });

    await expect(caughtUp).resolves.toBeUndefined();
    await expect(processor.snapshot()).resolves.toEqual({ offset: 3, state: { count: 2 } });
    expect(writes).toEqual([{ offset: 3, state: { count: 2 } }]);
    expect(reconciledOffsets).toEqual([3]);

    await processor.ingestThrough({
      events: [incrementedEvent(2, 1)],
      deliveryThroughOffset: 3,
      streamMaxOffset: 3,
    });
    expect(writes).toHaveLength(1);
    expect(reconciledOffsets).toHaveLength(1);
  });

  it("keeps a checkpoint-only scan retryable when persistence fails", async () => {
    let failWrite = true;
    const processor = new CounterProcessor({
      stream: neverStream,
      path: "/tests/counter",
      projectId: null,
      writeState: () => {
        if (failWrite) throw new Error("checkpoint write failed");
      },
    });

    await expect(
      processor.ingestThrough({ events: [], deliveryThroughOffset: 2, streamMaxOffset: 2 }),
    ).rejects.toThrow("checkpoint write failed");
    await expect(processor.snapshot()).resolves.toEqual({ offset: 0, state: { count: 0 } });

    failWrite = false;
    await processor.ingestThrough({ events: [], deliveryThroughOffset: 2, streamMaxOffset: 2 });
    await expect(processor.snapshot()).resolves.toEqual({ offset: 2, state: { count: 0 } });
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
      path: "/tests/counter",
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
    return {
      appends,
      processor: new CounterProcessor({ stream, path: "/tests/counter", projectId: null }),
    };
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
        idempotencyKey: "test-counter/event-parse-failed@/tests/counter:2",
        source: {
          processor: {
            slug: "test-counter",
            stream: { path: "/tests/counter", projectId: null },
            whileProcessing: { offset: 2, type: "events.iterate.com/test/incremented" },
          },
        },
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
        path: "/tests/counter",
        projectId: null,
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

describe("StreamProcessor.reconcile", () => {
  class ReconcilingCounter extends CounterProcessor {
    reconciledStates: { count: number }[] = [];
    protected override async reconcile(
      args: Parameters<StreamProcessor<typeof CounterContract>["reconcile"]>[0],
    ): Promise<void> {
      this.reconciledStates.push(args.state);
    }
  }

  it("runs after at-head batches with the batch's final fold", async () => {
    nextOffset = 0;
    const processor = new ReconcilingCounter({
      stream: neverStream,
      path: "/tests/counter",
      projectId: null,
    });
    await processor.ingest({
      events: [incrementedEvent(2), incrementedEvent(3)],
      streamMaxOffset: 2,
    });
    expect(processor.reconciledStates).toEqual([{ count: 5 }]);
  });

  it("never runs for a mid-catch-up batch (behind streamMaxOffset)", async () => {
    nextOffset = 0;
    const processor = new ReconcilingCounter({
      stream: neverStream,
      path: "/tests/counter",
      projectId: null,
    });
    // A refold in progress: the head sits at offset 10, this page ends at 2.
    await processor.ingest({
      events: [incrementedEvent(2), incrementedEvent(3)],
      streamMaxOffset: 10,
    });
    expect(processor.reconciledStates).toEqual([]);
    // The final catch-up page reaches the head; reconciliation gets its pass.
    await processor.ingest({ events: [incrementedEvent(5, 10)], streamMaxOffset: 10 });
    expect(processor.reconciledStates).toEqual([{ count: 10 }]);
  });
});

// Every append a processor makes through the emitted lanes carries
// `source.processor`: who appended (slug/version + home stream) and — on the
// per-event lanes — while processing which event. These tests pin the stamp's
// shape, the overwrite rule, and the batch-level omission of `whileProcessing`.
describe("StreamProcessor provenance stamping", () => {
  const EchoContract = defineProcessorContract({
    slug: "test-echo",
    version: "0.0.1",
    description: "Echoes triggers; exists to test append-lane provenance stamping.",
    stateSchema: z.object({ seen: z.number().default(0) }),
    events: {
      "events.iterate.com/test/triggered": {
        description: "A trigger the echo processor consumes.",
        payloadSchema: z.object({ id: z.string() }),
      },
      "events.iterate.com/test/echoed": {
        description: "The echo emitted in response to a trigger.",
        payloadSchema: z.object({ id: z.string() }),
      },
    },
    consumes: ["events.iterate.com/test/triggered"],
    emits: ["events.iterate.com/test/echoed"],
  });

  const HOME = { path: "/tests/echo", projectId: "prj_echo" };
  const STAMP = { slug: "test-echo", version: "0.0.1", stream: HOME };

  function triggeredEvent(offset: number): StreamEvent {
    return {
      type: "events.iterate.com/test/triggered",
      payload: { id: `t${offset}` },
      createdAt: new Date(offset).toISOString(),
      offset,
      path: HOME.path,
    };
  }

  // A stream whose own appends AND `at(path)` children record into one log,
  // tagged with the destination path.
  function recordingNetwork() {
    const appends: { path: string; event: StreamEventInput }[] = [];
    const streamAt = (path: string): Stream =>
      ({
        append: (...events: StreamEventInput[]) => {
          appends.push(...events.map((event) => ({ path, event })));
          return Promise.resolve(
            events.map((event, index) => ({
              ...event,
              offset: 1_000 + appends.length + index,
              createdAt: new Date(0).toISOString(),
              path,
            })),
          );
        },
        at: (child: string) => streamAt(child),
      }) as unknown as Stream;
    return { appends, stream: streamAt(HOME.path) };
  }

  class EchoProcessor extends StreamProcessor<typeof EchoContract> {
    readonly contract = EchoContract;

    protected override processEvent({
      event,
      append,
      appendTo,
      blockProcessorWhile,
    }: Parameters<StreamProcessor<typeof EchoContract>["processEvent"]>[0]): undefined {
      const echo = {
        type: "events.iterate.com/test/echoed" as const,
        idempotencyKey: this.idempotencyKey("echo", event),
        payload: { id: event.payload.id },
      };
      blockProcessorWhile(async () => {
        await append(echo);
        await appendTo("/tests/echo-sibling", {
          ...echo,
          // The caller's stamp claim must lose to the framework's.
          source: { processor: { slug: "forged", version: "9", stream: HOME } },
        });
      });
    }
  }

  class BatchEchoProcessor extends StreamProcessor<typeof EchoContract> {
    readonly contract = EchoContract;

    protected override async processEventBatch(
      args: Parameters<StreamProcessor<typeof EchoContract>["processEventBatch"]>[0],
    ): Promise<void> {
      await super.processEventBatch(args);
      await args.append({
        type: "events.iterate.com/test/echoed",
        idempotencyKey: this.idempotencyKey(`batch-summary:${args.checkpointOffset}`),
        payload: { id: "batch" },
      });
    }
  }

  it("stamps per-event appends with the processor and the event being processed", async () => {
    const { appends, stream } = recordingNetwork();
    const processor = new EchoProcessor({ stream, ...HOME });

    await processor.ingest({ events: [triggeredEvent(7)], streamMaxOffset: 7 });

    const home = appends.filter(({ path }) => path === HOME.path);
    expect(home).toHaveLength(1);
    expect(home[0]!.event).toMatchObject({
      idempotencyKey: "test-echo/echo@/tests/echo:7",
      source: {
        processor: {
          ...STAMP,
          whileProcessing: { offset: 7, type: "events.iterate.com/test/triggered" },
        },
      },
    });
  });

  it("self-measured metrics: home appends open the consume-own-append loop; ingest past the committed offset closes it", async () => {
    const { stream } = recordingNetwork();
    const processor = new EchoProcessor({ stream, ...HOME });

    // The trigger makes the processor append its echo (home commits at offset
    // 1001 in the recording network) plus a sibling copy — only the HOME
    // append is timed: the sibling never loops back through this subscription.
    await processor.ingest({ events: [triggeredEvent(7)], streamMaxOffset: 7 });
    let report = processor.subscriberMetrics.report();
    expect(report.appendRoundTripMs).toMatchObject({ samples: 1 });
    expect(report.consumeOwnAppendMs).toBeNull(); // echo not delivered back yet
    expect(report.batchesIngested).toBe(1);
    expect(report.eventsIngested).toBe(1);
    expect(report.ingestMs).not.toBeNull();

    // A later (non-consumed) event past the committed echo offset advances the
    // checkpoint through it — the loop closes on real delivery, not on append.
    await processor.ingest({
      events: [
        {
          type: "events.iterate.com/test/unrelated",
          offset: 1_500,
          createdAt: new Date(1_500).toISOString(),
          path: HOME.path,
          payload: {},
        },
      ],
      streamMaxOffset: 1_500,
    });
    report = processor.subscriberMetrics.report();
    expect(report.consumeOwnAppendMs).toMatchObject({ samples: 1 });
    expect(report.appendRoundTripMs).toMatchObject({ samples: 1 });
  });

  it("appendTo lands on the sibling stream with the same stamp, overwriting claims", async () => {
    const { appends, stream } = recordingNetwork();
    const processor = new EchoProcessor({ stream, ...HOME });

    await processor.ingest({ events: [triggeredEvent(7)], streamMaxOffset: 7 });

    const sibling = appends.filter(({ path }) => path === "/tests/echo-sibling");
    expect(sibling).toHaveLength(1);
    expect(sibling[0]!.event.source?.processor).toEqual({
      ...STAMP,
      whileProcessing: { offset: 7, type: "events.iterate.com/test/triggered" },
    });
  });

  it("stamps batch-level appends without whileProcessing", async () => {
    const { appends, stream } = recordingNetwork();
    const processor = new BatchEchoProcessor({ stream, ...HOME });

    await processor.ingest({ events: [triggeredEvent(7)], streamMaxOffset: 7 });

    const summary = appends.find(({ event }) => event.idempotencyKey?.includes("batch-summary"));
    expect(summary?.event.idempotencyKey).toBe("test-echo/batch-summary:7");
    expect(summary?.event.source?.processor).toEqual(STAMP);
  });

  it("refuses to append an event type missing from emits, on both lanes", () => {
    const { stream } = recordingNetwork();
    const processor = new (class extends StreamProcessor<typeof EchoContract> {
      readonly contract = EchoContract;
      emitForeign() {
        return this.append({
          type: "events.iterate.com/test/triggered",
          payload: { id: "x" },
        } as never);
      }
      forwardForeign() {
        return this.appendTo("/tests/echo-sibling", {
          type: "events.iterate.com/test/triggered",
          payload: { id: "x" },
        } as never);
      }
    })({ stream, ...HOME });

    expect(() => processor.emitForeign()).toThrow(/cannot build emitted event/);
    expect(() => processor.forwardForeign()).toThrow(/cannot build emitted event/);
  });
});

describe("StreamProcessor checkpoint loading", () => {
  it("treats a snapshot that fails the current state schema as a cache miss and refolds", async () => {
    // The deploy-a-schema-change scenario: the stored checkpoint carries the
    // OLD state shape. Wedging on it would make snapshot()/ingest() reject
    // forever — with the recovery machinery itself crash-looping on the
    // parse. The checkpoint is a disposable cache of the fold; discard and
    // refold from the journal.
    nextOffset = 0;
    const processor = new CounterProcessor({
      stream: neverStream,
      path: "/tests/counter",
      projectId: null,
      readState: () => ({
        offset: 7,
        state: { count: "three", legacyField: true } as never,
      }),
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await processor.ingest({
        events: [incrementedEvent(2, 1), incrementedEvent(3, 2)],
        streamMaxOffset: 2,
      });
      // The poisoned offset-7 checkpoint was discarded: both events (below
      // offset 7) folded from scratch.
      expect(processor.state).toEqual({ count: 5 });
      expect(processor.checkpointOffset).toBe(2);
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("discarding the cache"),
        expect.anything(),
      );
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe("contract event-input envelope", () => {
  it("accepts ephemeral: true on an emitted input (the strict envelope must know the key)", () => {
    // Load-bearing: getEventInputSchema is .strict(), so without `ephemeral`
    // in the envelope every processor-lane ephemeral append (the agent's LLM
    // chunks) would throw "Unrecognized key" at parse.
    const parsed = CounterContract.parseEventInput("events.iterate.com/test/incremented", {
      type: "events.iterate.com/test/incremented",
      ephemeral: true,
      payload: { by: 1 },
    });
    expect(parsed.ephemeral).toBe(true);
  });
});
