// Runnable in the Node/vitest runtime, fully in-process (no worker needed).
// Proves the processor model: per-event afterAppend, durable blockProcessorUntil,
// the core beforeAppend gate, child-stream topology, circuit breaker, and the
// SQLite-projector shape.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  defineProcessorContract,
  getInitialProcessorState,
  runProcessorReduce,
} from "./shared/stream-processors.ts";
import type { StreamEvent, StreamEventInput } from "./shared/event.ts";
import { implementProcessor } from "./processor.ts";
import { createProcessorRunner, type Snapshot, type ProcessorStream } from "./processor-runner.ts";
import { echoExampleProcessor } from "./processors/examples/echo/implementation.ts";
import { circuitBreakerProcessor } from "./processors/circuit-breaker/implementation.ts";
import type { CircuitBreakerProcessorState } from "./processors/circuit-breaker/contract.ts";
import { coreProcessor, getAncestorStreamPaths } from "./processors/core/implementation.ts";
import { coreProcessorContract } from "./processors/core/contract.ts";
import type { StreamCoreProcessorState } from "./types.ts";
import type { StreamRpc } from "./types.ts";

const iso = (ms = 0) => new Date(ms).toISOString();

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

// A stream stub that commits appends in memory and (optionally) fans them back.
function memoryStream(options: { onCommit?: (e: StreamEvent) => void; startOffset?: number } = {}) {
  let nextOffset = options.startOffset ?? 100;
  const committed: StreamEvent[] = [];
  const stream: StreamRpc = {
    append: (args) => {
      const e: StreamEvent = { ...args.event, offset: nextOffset++, createdAt: iso(1) };
      committed.push(e);
      options.onCommit?.(e);
      return e;
    },
    appendBatch: (batch) =>
      batch.events.map((input) => {
        const e: StreamEvent = { ...input, offset: nextOffset++, createdAt: iso(1) };
        committed.push(e);
        options.onCommit?.(e);
        return e;
      }),
    getEvent: () => undefined,
    getEvents: () => [],
    subscribe: () => {
      throw new Error("memoryStream does not implement subscribe");
    },
    runtimeState: () => {
      throw new Error("memoryStream does not implement runtimeState");
    },
    kill: () => {},
    reset: async () => {},
    reduce: () => {
      throw new Error("memoryStream does not implement reduce");
    },
  };
  return { stream, committed };
}

// ---------------------------------------------------------------------------
// echo — default fire-and-forget pattern
// ---------------------------------------------------------------------------

const echoContract = defineProcessorContract({
  slug: "test.echo",
  version: "0.1.0",
  description: "echo",
  stateSchema: z.object({ seen: z.number().int().min(0).default(0) }),
  initialState: {},
  events: {
    "test.input": { description: "in", payloadSchema: z.object({ path: z.string() }) },
    "test.output": { description: "out", payloadSchema: z.object({ seen: z.number() }) },
  },
  consumes: ["test.input"],
  emits: ["test.output"],
  reduce({ state, event }) {
    return event.type === "test.input" ? { seen: state.seen + 1 } : state;
  },
});

const echo = implementProcessor(echoContract, () => ({
  afterAppend({ event, state, stream, keepAlive }) {
    if (event.type !== "test.input") return;
    keepAlive(stream.append({ event: { type: "test.output", payload: { seen: state.seen } } }));
  },
}));

describe("subscription processor (node, in-process)", () => {
  it("echo reduces, emits, and advances the snapshot", async () => {
    const { stream, committed } = memoryStream();
    let saved: Snapshot<{ seen: number }> | undefined;
    const runner = createProcessorRunner({
      processor: echo,
      deps: undefined,
      storage: { load: () => saved, save: (s) => void (saved = s) },
      stream,
    });

    await runner.processEventBatch({
      namespace: "test",
      path: "/test",
      events: [event({ type: "test.input", payload: { path: "/x" }, offset: 2 })],
      streamMaxOffset: 2,
    });

    expect(committed).toMatchObject([{ type: "test.output", payload: { seen: 1 } }]);
    expect((await runner.snapshot())?.offset).toBe(2);
    expect(saved?.offset).toBe(2);
  });

  it("dedups already-processed offsets on replay", async () => {
    const { stream, committed } = memoryStream();
    const runner = createProcessorRunner({
      processor: echo,
      deps: undefined,
      storage: { load: () => ({ state: { seen: 0 }, offset: 5 }), save: () => {} },
      stream,
    });
    await runner.processEventBatch({
      namespace: "test",
      path: "/test",
      events: [event({ type: "test.input", payload: { path: "/x" }, offset: 3 })],
      streamMaxOffset: 5,
    });
    expect(committed).toHaveLength(0); // offset 3 <= snapshot 5
  });

  it("runs echo side effects only after the subscription anchor", async () => {
    const { stream, committed } = memoryStream();
    const runner = createProcessorRunner({
      processor: echoExampleProcessor,
      deps: undefined,
      storage: { load: () => undefined, save: () => {} },
      stream,
      sideEffectAnchor: { offset: 10, createdAt: iso(10_000) },
    });

    await runner.processEventBatch({
      namespace: "test",
      path: "/test",
      events: [
        event({
          type: "events.iterate.com/echo-example/input-received",
          offset: 9,
          payload: {},
          createdAtMs: 9_000,
        }),
        event({
          type: "events.iterate.com/echo-example/input-received",
          offset: 10,
          payload: {},
          createdAtMs: 10_000,
        }),
        event({
          type: "events.iterate.com/echo-example/input-received",
          offset: 11,
          payload: {},
          createdAtMs: 11_000,
        }),
      ],
      streamMaxOffset: 11,
    });

    expect(committed).toMatchObject([
      { type: "events.iterate.com/stream/processor-registered" },
      { type: "events.iterate.com/echo-example/output-echoed", payload: { seen: 3 } },
    ]);
  });
});

// ---------------------------------------------------------------------------
// transcribe — durable blockProcessorUntil (at-least-once)
// ---------------------------------------------------------------------------

const transcribeContract = defineProcessorContract({
  slug: "test.transcribe",
  version: "0.1.0",
  description: "transcribe",
  stateSchema: z.object({ done: z.number().int().min(0).default(0) }),
  initialState: {},
  events: {
    "test.audio": { description: "in", payloadSchema: z.object({ url: z.string() }) },
    "test.transcript": {
      description: "out",
      payloadSchema: z.object({ url: z.string(), text: z.string() }),
    },
  },
  consumes: ["test.audio"],
  emits: ["test.transcript"],
  reduce({ state, event }) {
    return event.type === "test.audio" ? { done: state.done + 1 } : state;
  },
});

const transcribe = implementProcessor(
  transcribeContract,
  (deps: { transcribe(url: string): Promise<string> }) => ({
    afterAppend({ event, stream, blockProcessorUntil }) {
      if (event.type !== "test.audio") return;
      const url = event.payload.url;
      blockProcessorUntil(async () => {
        const text = await deps.transcribe(url);
        await stream.append({ event: { type: "test.transcript", payload: { url, text } } });
      });
    },
  }),
);

describe("durable processor (blockProcessorUntil)", () => {
  it("holds the checkpoint until the side effect completes", async () => {
    const { stream, committed } = memoryStream();
    const saves: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));

    const runner = createProcessorRunner({
      processor: transcribe,
      deps: {
        transcribe: async (url) => {
          await gate;
          return `transcript:${url}`;
        },
      },
      storage: { load: () => undefined, save: (s) => void saves.push(s.offset) },
      stream,
    });

    const processed = runner.processEventBatch({
      namespace: "test",
      path: "/test",
      events: [event({ type: "test.audio", payload: { url: "/a" }, offset: 2 })],
      streamMaxOffset: 2,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(saves).toEqual([]); // blocked: not yet checkpointed

    release();
    await processed;
    expect(committed).toMatchObject([
      { type: "test.transcript", payload: { url: "/a", text: "transcript:/a" } },
    ]);
    expect(saves).toContain(2); // checkpointed only after the work completed
  });
});

// ---------------------------------------------------------------------------
// SQLite projector shape — fire-and-forget bulk write
// ---------------------------------------------------------------------------

const projectorContract = defineProcessorContract({
  slug: "test.sqlite-projector",
  version: "0.1.0",
  description: "project",
  stateSchema: z.object({}),
  initialState: {},
  events: {},
  consumes: ["*"],
  emits: [],
});

describe("projector processor (consumes everything, writes to a db port)", () => {
  it("writes every delivered event", async () => {
    const written: number[] = [];
    const projector = implementProcessor(
      projectorContract,
      (deps: { write(e: StreamEvent): void }) => ({
        afterAppend({ event }) {
          deps.write(event);
        },
      }),
    );
    const { stream } = memoryStream();
    const runner = createProcessorRunner({
      processor: projector,
      deps: { write: (e) => written.push(e.offset) },
      storage: { load: () => undefined, save: () => {} },
      stream,
    });
    await runner.processEventBatch({
      namespace: "test",
      path: "/test",
      events: [event({ type: "a", offset: 0, payload: {} })],
      streamMaxOffset: 1,
    });
    await runner.processEventBatch({
      namespace: "test",
      path: "/test",
      events: [event({ type: "b", offset: 1, payload: {} })],
      streamMaxOffset: 1,
    });
    expect(written).toEqual([0, 1]);
  });

  it("can commit a delivered batch as one side-effect/checkpoint unit", async () => {
    const written: number[][] = [];
    const saves: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const projector = implementProcessor(projectorContract, () => ({
      afterAppendBatch({ events, blockProcessorUntil }) {
        blockProcessorUntil(async () => {
          await gate;
          written.push(
            events.map(({ event }) => {
              const streamEvent: StreamEvent = event;
              return streamEvent.offset;
            }),
          );
        });
      },
    }));
    const { stream } = memoryStream();
    const runner = createProcessorRunner({
      processor: projector,
      deps: undefined,
      storage: { load: () => undefined, save: (snapshot) => void saves.push(snapshot.offset) },
      stream,
    });

    const processed = runner.processEventBatch({
      namespace: "test",
      path: "/test",
      events: [
        event({ type: "a", offset: 1, payload: {} }),
        event({ type: "b", offset: 2, payload: {} }),
      ],
      streamMaxOffset: 2,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(written).toEqual([]);
    expect(saves).toEqual([]);

    release();
    await processed;
    expect(written).toEqual([[1, 2]]);
    expect(saves).toEqual([2]);
  });

  it("lets a processor decide side-effect eligibility from the subscription anchor and grace period", async () => {
    const written: number[] = [];
    const projector = implementProcessor(projectorContract, () => ({
      afterAppendBatch({ events, shouldApplySideEffects }) {
        for (const { event } of events) {
          const streamEvent: StreamEvent = event;
          if (shouldApplySideEffects({ event: streamEvent, gracePeriodMs: 6_000 })) {
            written.push(streamEvent.offset);
          }
        }
      },
    }));
    const { stream } = memoryStream();
    const runner = createProcessorRunner({
      processor: projector,
      deps: undefined,
      storage: { load: () => undefined, save: () => {} },
      stream,
      sideEffectAnchor: { offset: 10, createdAt: iso(10_000) },
    });

    await runner.processEventBatch({
      namespace: "test",
      path: "/test",
      events: [
        event({ type: "a", offset: 8, payload: {}, createdAtMs: 0 }),
        event({ type: "b", offset: 9, payload: {}, createdAtMs: 5_000 }),
        event({ type: "c", offset: 10, payload: {}, createdAtMs: 10_000 }),
        event({ type: "d", offset: 11, payload: {}, createdAtMs: 11_000 }),
      ],
      streamMaxOffset: 11,
    });

    expect(written).toEqual([9, 11]);
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
    const coreInline = coreProcessor.build({
      propagateChildStreamCreated: (coreState) => {
        for (const ancestor of getAncestorStreamPaths(coreState.path)) {
          this.append(ancestor, {
            type: "events.iterate.com/stream/child-stream-created",
            payload: { childPath: coreState.path },
            idempotencyKey: `child-stream-created:${ancestor}:${coreState.path}`,
          });
        }
      },
    });

    coreInline.beforeAppend?.({
      event: input,
      state: entry.coreProcessorState,
    });

    const committed: StreamEvent = {
      ...input,
      offset: entry.coreProcessorState.maxOffset + 1,
      createdAt: iso(createdAtMs),
    };
    const appendStream: ProcessorStream = {
      append: (args) => this.append(path, args.event, createdAtMs),
      appendBatch: (args) => args.events.map((event) => this.append(path, event, createdAtMs)),
    };

    const previousCoreState = entry.coreProcessorState;

    const coreReduction = runProcessorReduce({
      processor: { contract: coreProcessorContract },
      event: committed,
      state: previousCoreState,
    });
    if (coreReduction === undefined) {
      throw new Error(`core cannot reduce ${committed.type}`);
    }

    entry.coreProcessorState = coreProcessorContract.stateSchema.parse(coreReduction.state);
    entry.events.push(committed);

    coreInline.afterAppend?.({
      event: coreReduction.event,
      previousState: previousCoreState,
      state: entry.coreProcessorState,
      streamMaxOffset: committed.offset,
      stream: appendStream,
      shouldApplySideEffects: () => true,
      blockProcessorUntil: (work) => void work(),
      keepAlive: (work) => void work,
    });

    return committed;
  }
}

function initialCoreProcessorState(args: {
  namespace: string;
  path: string;
}): StreamCoreProcessorState {
  return coreProcessorContract.stateSchema.parse({
    ...getInitialProcessorState(coreProcessorContract),
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
        subscriber: {
          type: "built-in",
          transport: "workers-rpc",
          processorSlug: "circuit-breaker",
        },
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

    let saved: Snapshot<CircuitBreakerProcessorState> | undefined;
    const runner = createProcessorRunner({
      processor: circuitBreakerProcessor,
      deps: undefined,
      storage: { load: () => saved, save: (snapshot) => void (saved = snapshot) },
      stream: {
        append: (args) => sim.append("/cb", args.event),
        appendBatch: (args) => args.events.map((event) => sim.append("/cb", event)),
      },
      sideEffectAnchor: {
        offset: subscriptionConfigured.offset,
        createdAt: subscriptionConfigured.createdAt,
      },
    });

    await runner.processEventBatch({
      namespace: "test",
      path: "/test",
      events: [...entry.events],
      streamMaxOffset: entry.coreProcessorState.maxOffset,
    });

    expect(sim.streams.get("/cb")?.coreProcessorState.paused).toBe(true);
    let rejected = 0;
    try {
      sim.append("/cb", { type: "test.widget", payload: { afterPause: true } });
    } catch {
      rejected += 1;
    }
    expect(rejected).toBeGreaterThan(0);
  });

  it("does not pause the stream from pre-anchor circuit breaker replay", async () => {
    const { stream, committed } = memoryStream();
    let saved: Snapshot<CircuitBreakerProcessorState> | undefined;
    const runner = createProcessorRunner({
      processor: circuitBreakerProcessor,
      deps: undefined,
      storage: { load: () => undefined, save: (snapshot) => void (saved = snapshot) },
      stream,
      sideEffectAnchor: { offset: 4, createdAt: iso(4_000) },
    });

    await runner.processEventBatch({
      namespace: "test",
      path: "/test",
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

    expect(committed).toEqual([]);
    expect(saved?.offset).toBe(3);
  });
});
