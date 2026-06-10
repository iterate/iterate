// Runnable in the Node/vitest runtime, fully in-process (no worker needed).
// Exercises the example processors through the class-based StreamProcessor
// model: echo fan-out + replay dedupe, the side-effect anchor, the core append
// validation gate, child-stream topology, and the circuit breaker.
// Base-class semantics (checkpointing, blocking work, batch serialization) are
// covered in stream-processor-class.test.ts.

import { describe, expect, it } from "vitest";
import { getInitialProcessorState } from "./shared/stream-processors.ts";
import type { StreamEvent, StreamEventInput } from "./shared/event.ts";
import { durableObjectProcessorSubscriber } from "./shared/callable-subscriber.ts";
import { EchoExampleProcessor } from "./processors/examples/echo/implementation.ts";
import { CircuitBreakerProcessor } from "./processors/circuit-breaker/implementation.ts";
import { CoreStreamProcessor } from "./processors/core/implementation.ts";
import { CoreProcessorContract } from "./processors/core/contract.ts";
import type { StreamCoreProcessorState } from "./types.ts";
import type { StreamProcessorIterateContext, StreamProcessorSnapshot } from "./stream-processor.ts";

const iso = (ms = 0) => new Date(ms).toISOString();
// Both example processors append via runInBackground, so tests tick the
// microtask/timer queue once after ingest before asserting on appends.
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function event(args: {
  type: string;
  payload?: unknown;
  offset: number;
  createdAtMs?: number;
  idempotencyKey?: string;
}): StreamEvent {
  return {
    type: args.type,
    payload: args.payload,
    offset: args.offset,
    createdAt: iso(args.createdAtMs),
    ...(args.idempotencyKey === undefined ? {} : { idempotencyKey: args.idempotencyKey }),
  };
}

// A stream stub that records appends in memory — just the `{ append,
// appendBatch }` surface the class's iterateContext needs.
function memoryStream(options: { startOffset?: number } = {}) {
  let nextOffset = options.startOffset ?? 100;
  const committed: StreamEvent[] = [];
  const stream: StreamProcessorIterateContext["stream"] = {
    append: (args) => {
      const e: StreamEvent = { ...args.event, offset: nextOffset++, createdAt: iso(1) };
      committed.push(e);
      return e;
    },
    appendBatch: (args) =>
      args.events.map((input) => {
        const e: StreamEvent = { ...input, offset: nextOffset++, createdAt: iso(1) };
        committed.push(e);
        return e;
      }),
  };
  return { stream, committed };
}

// ---------------------------------------------------------------------------
// echo — default fire-and-forget pattern
// ---------------------------------------------------------------------------

const echoInput = (offset: number): StreamEvent =>
  event({ type: "events.iterate.com/echo-example/input-received", payload: {}, offset });

describe("echo example processor", () => {
  it("reduces, emits the running count, and checkpoints", async () => {
    const { stream, committed } = memoryStream();
    const writes: StreamProcessorSnapshot<{ seen: number }>[] = [];
    const processor = new EchoExampleProcessor({
      iterateContext: { stream },
      writeState: (snapshot) => void writes.push(snapshot),
    });

    await processor.ingest({ events: [echoInput(2)], streamMaxOffset: 2 });
    await tick();

    expect(committed).toMatchObject([
      { type: "events.iterate.com/echo-example/output-echoed", payload: { seen: 1 } },
    ]);
    expect(processor.checkpointOffset).toBe(2);
    expect(writes).toEqual([{ offset: 2, state: { seen: 1 } }]);
  });

  it("dedups a re-delivered batch instead of emitting twice", async () => {
    const { stream, committed } = memoryStream();
    const processor = new EchoExampleProcessor({ iterateContext: { stream } });

    await processor.ingest({ events: [echoInput(1), echoInput(2)], streamMaxOffset: 2 });
    await processor.ingest({ events: [echoInput(1), echoInput(2)], streamMaxOffset: 2 });
    await tick();

    expect(processor.state).toEqual({ seen: 2 });
    expect(committed).toMatchObject([
      { type: "events.iterate.com/echo-example/output-echoed", payload: { seen: 1 } },
      { type: "events.iterate.com/echo-example/output-echoed", payload: { seen: 2 } },
    ]);
  });

  it("resumes from a persisted snapshot and ignores already-processed offsets", async () => {
    const { stream, committed } = memoryStream();
    const processor = new EchoExampleProcessor({
      iterateContext: { stream },
      readState: () => ({ offset: 5, state: { seen: 2 } }),
    });

    // A re-delivered historical event (offset 4 <= snapshot 5) must be ignored.
    await processor.ingest({ events: [echoInput(4)], streamMaxOffset: 6 });
    await tick();
    expect(committed).toHaveLength(0);

    // A genuinely new event resumes from the persisted count.
    await processor.ingest({ events: [echoInput(6)], streamMaxOffset: 6 });
    await tick();
    expect(committed).toMatchObject([
      { type: "events.iterate.com/echo-example/output-echoed", payload: { seen: 3 } },
    ]);
    expect(processor.checkpointOffset).toBe(6);
  });

  it("reduces pre-anchor events into state but only runs side effects past the anchor", async () => {
    const { stream, committed } = memoryStream();
    const processor = new EchoExampleProcessor({
      iterateContext: { stream },
      sideEffectsAfterOffset: () => 10,
    });

    await processor.ingest({
      events: [echoInput(9), echoInput(10), echoInput(11)],
      streamMaxOffset: 11,
    });
    await tick();

    // All three inputs reduce, but only offset 11 (past the anchor) echoes.
    expect(processor.state).toEqual({ seen: 3 });
    expect(committed).toMatchObject([
      { type: "events.iterate.com/echo-example/output-echoed", payload: { seen: 3 } },
    ]);
  });
});

// ---------------------------------------------------------------------------
// core stream state + subscription processors
// ---------------------------------------------------------------------------

class CoreStreamSim {
  readonly streams = new Map<
    string,
    { coreProcessorState: StreamCoreProcessorState; events: StreamEvent[] }
  >();

  #entry(path: string) {
    let entry = this.streams.get(path);
    if (entry === undefined) {
      entry = {
        coreProcessorState: initialCoreProcessorState({ namespace: "stream", path }),
        events: [],
      };
      this.streams.set(path, entry);
    }
    return entry;
  }

  append(path: string, input: StreamEventInput, createdAtMs = 0): StreamEvent {
    const entry = this.#entry(path);
    const coreInline = new CoreStreamProcessor({
      iterateContext: {
        stream: {
          append: (args) => this.append(args.streamPath ?? path, args.event, createdAtMs),
          appendBatch: (args) =>
            args.events.map((event) => this.append(args.streamPath ?? path, event, createdAtMs)),
        },
      },
    });

    coreInline.validateAppend({
      event: input,
      state: entry.coreProcessorState,
    });

    const committed: StreamEvent = {
      ...input,
      offset: entry.coreProcessorState.maxOffset + 1,
      createdAt: iso(createdAtMs),
    };

    const previousCoreProcessorState = entry.coreProcessorState;
    entry.coreProcessorState = coreInline.reduceEvent({
      event: committed,
      state: previousCoreProcessorState,
    });
    entry.events.push(committed);

    coreInline.processReducedEvent({
      event: committed,
      previousState: previousCoreProcessorState,
      state: entry.coreProcessorState,
    });

    return committed;
  }
}

function initialCoreProcessorState(args: {
  namespace: string;
  path: string;
}): StreamCoreProcessorState {
  return CoreProcessorContract.stateSchema.parse({
    ...getInitialProcessorState(CoreProcessorContract),
    namespace: args.namespace,
    path: args.path,
  });
}

describe("core stream state and subscription processors", () => {
  it("propagates child-stream-created up the ancestor chain", () => {
    const sim = new CoreStreamSim();
    sim.append("/a/b/c", {
      type: "events.iterate.com/stream/created",
      payload: { namespace: "stream", path: "/a/b/c" },
    });
    expect(sim.streams.get("/")?.coreProcessorState.childPaths).toEqual(["/a"]);
    expect(sim.streams.get("/a")?.coreProcessorState.childPaths).toEqual(["/a/b"]);
    expect(sim.streams.get("/a/b")?.coreProcessorState.childPaths).toEqual(["/a/b/c"]);
    // Every ancestor also keeps the FULL announced path (the root's copy is
    // the namespace catalog that stream listing reads with one getState).
    expect(sim.streams.get("/")?.coreProcessorState.descendantPaths).toEqual(["/a/b/c"]);
    expect(sim.streams.get("/a")?.coreProcessorState.descendantPaths).toEqual(["/a/b/c"]);
    expect(sim.streams.get("/a/b")?.coreProcessorState.descendantPaths).toEqual(["/a/b/c"]);
  });

  it("circuit breaker trips from an ordinary subscription processor", async () => {
    const sim = new CoreStreamSim();
    sim.append("/cb", {
      type: "events.iterate.com/stream/created",
      payload: { namespace: "stream", path: "/cb" },
    });
    const subscriptionConfigured = sim.append("/cb", {
      type: "events.iterate.com/stream/subscription-configured",
      payload: {
        subscriptionKey: "circuit-breaker",
        subscriber: durableObjectProcessorSubscriber({
          bindingName: "PROCESSOR_HOST",
          durableObjectName: "cb-host",
          processorName: "circuit-breaker",
        }),
      },
    });
    sim.append("/cb", {
      type: "events.iterate.com/circuit-breaker/configured",
      payload: { burstCapacity: 2, refillRatePerMinute: 1 },
    });

    for (let i = 0; i < 5; i++) {
      sim.append("/cb", { type: "test.widget", payload: { i } }, i + 1);
    }

    const entry = sim.streams.get("/cb");
    if (entry === undefined) throw new Error("missing /cb stream");
    // Snapshot the batch now: the breaker's paused append grows entry.events.
    const batch = [...entry.events];

    const writes: StreamProcessorSnapshot<unknown>[] = [];
    const processor = new CircuitBreakerProcessor({
      iterateContext: {
        stream: {
          append: (args) => sim.append(args.streamPath ?? "/cb", args.event),
          appendBatch: (args) =>
            args.events.map((event) => sim.append(args.streamPath ?? "/cb", event)),
        },
      },
      writeState: (snapshot) => void writes.push(snapshot),
      // The subscription anchor: replay before it reduces but stays side-effect free.
      sideEffectsAfterOffset: () => subscriptionConfigured.offset,
    });

    await processor.ingest({
      events: batch,
      streamMaxOffset: batch.at(-1)?.offset ?? 0,
    });
    await tick();

    expect(sim.streams.get("/cb")?.coreProcessorState.paused).toBe(true);
    expect(writes.at(-1)?.offset).toBe(batch.at(-1)?.offset);
    expect(() => sim.append("/cb", { type: "test.widget", payload: { afterPause: true } })).toThrow(
      "stream paused",
    );
  });

  it("does not pause the stream from pre-anchor circuit breaker replay", async () => {
    const { stream, committed } = memoryStream();
    const processor = new CircuitBreakerProcessor({
      iterateContext: { stream },
      sideEffectsAfterOffset: () => 4,
    });

    await processor.ingest({
      events: [
        event({
          type: "events.iterate.com/circuit-breaker/configured",
          offset: 1,
          payload: { burstCapacity: 1, refillRatePerMinute: 1 },
          createdAtMs: 1_000,
        }),
        event({ type: "test.widget", offset: 2, payload: {}, createdAtMs: 2_000 }),
        event({ type: "test.widget", offset: 3, payload: {}, createdAtMs: 3_000 }),
      ],
      streamMaxOffset: 3,
    });
    await tick();

    // The breaker tripped during replay (offsets <= anchor), so no paused append.
    expect(committed).toEqual([]);
    expect(processor.checkpointOffset).toBe(3);
  });
});
