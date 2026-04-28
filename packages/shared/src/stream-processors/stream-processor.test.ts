import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createEvent,
  defineProcessorContract,
  getProcessorStateSchema,
  implementProcessor,
  runProcessorOnStart,
  runProcessorReduce,
  runProcessorAfterAppend,
  validateProcessorContract,
  type ConsumedEvent,
  type EventCatalog,
  type Processor,
  type ProcessorState,
  type ProcessorStreamApi,
  type StreamEvent,
} from "./stream-processor.ts";

const streamProcessorContract = defineProcessorContract({
  slug: "stream-core",
  version: "1.0.0",
  description: "Core stream events.",
  state: z.object({}).default({}),
  events: {
    ...createEvent({
      type: "processor-registered",
      payloadSchema: z.object({
        processorSlug: z.string(),
        version: z.string(),
      }),
    }),
  },
  consumes: ["processor-registered"],
  emits: ["processor-registered"],
  reduce: ({ state }) => state,
});

describe("stream processor contracts", () => {
  it("creates event definitions keyed by wire event type", () => {
    const events = {
      ...createEvent({
        type: "echo-requested",
        description: "Requests an echo response.",
        payloadSchema: z.object({ text: z.string() }),
      }),
    };

    expect(Object.keys(events)).toEqual(["echo-requested"]);
    expect(events["echo-requested"].type).toBe("echo-requested");
    expect(events["echo-requested"].description).toBe("Requests an echo response.");
    expect(
      events["echo-requested"].createInput({
        payload: { text: "hello" },
        idempotencyKey: "echo:1",
      }),
    ).toEqual({
      type: "echo-requested",
      payload: { text: "hello" },
      idempotencyKey: "echo:1",
    });
  });

  it("parses event input and event output strictly", () => {
    const events = {
      ...createEvent({
        type: "strict-event",
        payloadSchema: z.object({ text: z.string() }),
      }),
    };

    expect(() =>
      events["strict-event"].input.parse({
        type: "strict-event",
        payload: { text: "hello" },
        extra: true,
      }),
    ).toThrow();
    expect(() =>
      events["strict-event"].input.parse({
        type: "wrong-event",
        payload: { text: "hello" },
      }),
    ).toThrow();
    expect(() =>
      events["strict-event"].input.parse({
        type: "strict-event",
        payload: { text: "hello" },
        idempotencyKey: " ",
      }),
    ).toThrow();
    expect(() =>
      events["strict-event"].event.parse({
        type: "strict-event",
        payload: { text: "hello" },
        streamPath: "/stream",
        offset: 1,
      }),
    ).toThrow();
  });

  it("validates state schemas that provide initial state", () => {
    const contract = defineProcessorContract({
      slug: "echo",
      version: "1.0.0",
      description: "Echo test processor.",
      state: z.object({ count: z.number().default(0) }).prefault({}),
      processorDeps: [streamProcessorContract],
      events: {
        ...createEvent({
          type: "echo-requested",
          payloadSchema: z.object({ text: z.string() }),
        }),
      },
      consumes: ["processor-registered", "echo-requested"],
      emits: ["processor-registered"],
      reduce: ({ state }) => state,
    });

    expect(() => validateProcessorContract(contract)).not.toThrow();
  });

  it("accepts explicit empty object state for stateless processors", () => {
    const contract = defineProcessorContract({
      slug: "stateless",
      version: "1.0.0",
      description: "Stateless test processor.",
      state: z.object({}).default({}),
      events: {},
      consumes: [],
      emits: [],
    });

    expect(getProcessorStateSchema(contract).parse(undefined)).toEqual({});
    expect(() => validateProcessorContract(contract)).not.toThrow();
  });

  it("rejects state schemas that cannot parse undefined", () => {
    const contract = {
      slug: "echo",
      state: z.object({ count: z.number() }),
      events: {},
      consumes: [],
      emits: [],
    };

    expect(() => validateProcessorContract(contract)).toThrow();
  });

  it("rejects state schemas that parse undefined into non-object states", () => {
    const primitiveStateContract = {
      slug: "primitive-state",
      state: z.number().default(0),
      events: {},
      consumes: [],
      emits: [],
    };
    const arrayStateContract = {
      slug: "array-state",
      state: z.array(z.string()).default([]),
      events: {},
      consumes: [],
      emits: [],
    };

    expect(() => validateProcessorContract(primitiveStateContract)).toThrow(
      'Processor "primitive-state" state must be an object.',
    );
    expect(() => validateProcessorContract(arrayStateContract)).toThrow(
      'Processor "array-state" state must be an object.',
    );
  });

  it("rejects unresolved consumed and emitted event types", () => {
    const contract = {
      slug: "echo",
      version: "1.0.0",
      description: "Echo test processor.",
      state: z.object({ count: z.number().default(0) }).prefault({}),
      events: {},
      consumes: ["missing-consumed-event"],
      emits: ["missing-emitted-event"],
    };

    expect(() => validateProcessorContract(contract)).toThrow(
      'Unresolved stream processor consumes event type "missing-consumed-event".',
    );
  });

  it("rejects unresolved emitted event types", () => {
    const contract = {
      slug: "echo",
      version: "1.0.0",
      description: "Echo test processor.",
      state: z.object({}).default({}),
      events: {},
      consumes: [],
      emits: ["missing-emitted-event"],
    };

    expect(() => validateProcessorContract(contract)).toThrow(
      'Unresolved stream processor emits event type "missing-emitted-event".',
    );
  });

  it("rejects duplicate event ownership across processor deps", () => {
    const duplicateProcessorContract = defineProcessorContract({
      slug: "duplicate-stream-core",
      version: "1.0.0",
      description: "Duplicate core stream events.",
      state: z.object({}).default({}),
      events: {
        ...createEvent({
          type: "processor-registered",
          payloadSchema: z.object({ duplicate: z.boolean() }),
        }),
      },
      consumes: ["processor-registered"],
      emits: ["processor-registered"],
      reduce: ({ state }) => state,
    });

    const contract = defineProcessorContract({
      slug: "echo",
      version: "1.0.0",
      description: "Echo test processor.",
      state: z.object({}).default({}),
      processorDeps: [streamProcessorContract, duplicateProcessorContract],
      events: {},
      consumes: ["processor-registered"],
      emits: [],
      reduce: ({ state }) => state,
    });

    expect(() => validateProcessorContract(contract)).toThrow(
      'Duplicate stream processor event type "processor-registered" owned by both "stream-core" and "duplicate-stream-core".',
    );
  });

  it("rejects duplicate event ownership between processor deps and local events", () => {
    const contract = defineProcessorContract({
      slug: "echo",
      version: "1.0.0",
      description: "Echo test processor.",
      state: z.object({}).default({}),
      processorDeps: [streamProcessorContract],
      events: {
        ...createEvent({
          type: "processor-registered",
          payloadSchema: z.object({ duplicate: z.boolean() }),
        }),
      },
      consumes: ["processor-registered"],
      emits: [],
      reduce: ({ state }) => state,
    });

    expect(() => validateProcessorContract(contract)).toThrow(
      'Duplicate stream processor event type "processor-registered" owned by both "stream-core" and "echo".',
    );
  });

  it("allows emitted events owned by processor deps and standalone event catalogs", () => {
    const standaloneEvents = {
      ...createEvent({
        type: "standalone-event",
        payloadSchema: z.object({ value: z.number() }),
      }),
    };
    const contract = defineProcessorContract({
      slug: "echo",
      version: "1.0.0",
      description: "Echo test processor.",
      state: z.object({}).default({}),
      processorDeps: [streamProcessorContract, standaloneEvents],
      events: {},
      consumes: [],
      emits: ["processor-registered", "standalone-event"],
      reduce: ({ state }) => state,
    });

    expect(() => validateProcessorContract(contract)).not.toThrow();
  });

  it("reduces consumed events after parsing them through their declared event schema", () => {
    const contract = defineProcessorContract({
      slug: "counter",
      version: "1.0.0",
      description: "Counts committed increment events.",
      state: z.object({ count: z.number().default(0) }).prefault({}),
      events: {
        ...createEvent({
          type: "counter-incremented",
          payloadSchema: z.object({ by: z.number() }),
        }),
      },
      consumes: ["counter-incremented"],
      emits: [],
      reduce: ({ state, event }) => ({ count: state.count + event.payload.by }),
    });
    const processor = implementProcessor(contract, {});

    expect(
      runProcessorReduce({
        processor,
        state: { count: 1 },
        event: committedEvent({
          type: "counter-incremented",
          payload: { by: 2 },
        }),
      }),
    ).toMatchObject({
      event: {
        type: "counter-incremented",
        payload: { by: 2 },
      },
      previousState: { count: 1 },
      state: { count: 3 },
    });
  });

  it("returns undefined for events that are not consumed", () => {
    const contract = defineProcessorContract({
      slug: "counter",
      version: "1.0.0",
      description: "Counts committed increment events.",
      state: z.object({ count: z.number().default(0) }).prefault({}),
      events: {
        ...createEvent({
          type: "counter-incremented",
          payloadSchema: z.object({ by: z.number() }),
        }),
        ...createEvent({
          type: "counter-ignored",
          payloadSchema: z.object({}),
        }),
      },
      consumes: ["counter-incremented"],
      emits: [],
      reduce: ({ state, event }) => ({ count: state.count + event.payload.by }),
    });
    const processor = implementProcessor(contract, {});

    expect(
      runProcessorReduce({
        processor,
        state: { count: 1 },
        event: committedEvent({
          type: "counter-ignored",
          payload: {},
        }),
      }),
    ).toBeUndefined();
  });

  it("treats missing, null, and undefined reducers as unchanged state for consumed events", () => {
    const eventDefinition = createEvent({
      type: "noop",
      payloadSchema: z.object({}),
    });
    const noReducerContract = defineProcessorContract({
      slug: "no-reducer",
      version: "1.0.0",
      description: "Consumes without reducing.",
      state: z.object({ count: z.number().default(0) }).prefault({}),
      events: eventDefinition,
      consumes: ["noop"],
      emits: [],
    });
    const nullReducerContract = defineProcessorContract({
      slug: "null-reducer",
      version: "1.0.0",
      description: "Uses null to keep state unchanged.",
      state: z.object({ count: z.number().default(0) }).prefault({}),
      events: eventDefinition,
      consumes: ["noop"],
      emits: [],
      reduce: () => null,
    });
    const undefinedReducerContract = defineProcessorContract({
      slug: "undefined-reducer",
      version: "1.0.0",
      description: "Uses undefined to keep state unchanged.",
      state: z.object({ count: z.number().default(0) }).prefault({}),
      events: eventDefinition,
      consumes: ["noop"],
      emits: [],
      reduce: () => undefined,
    });
    const state = { count: 1 };
    const event = committedEvent({ type: "noop", payload: {} });

    expect(
      runProcessorReduce({
        processor: implementProcessor(noReducerContract, {}),
        state,
        event,
      })?.state,
    ).toBe(state);
    expect(
      runProcessorReduce({
        processor: implementProcessor(nullReducerContract, {}),
        state,
        event,
      })?.state,
    ).toBe(state);
    expect(
      runProcessorReduce({
        processor: implementProcessor(undefinedReducerContract, {}),
        state,
        event,
      })?.state,
    ).toBe(state);
  });

  it("throws when a consumed event does not match its declared schema", () => {
    const contract = defineProcessorContract({
      slug: "counter",
      version: "1.0.0",
      description: "Counts committed increment events.",
      state: z.object({ count: z.number().default(0) }).prefault({}),
      events: {
        ...createEvent({
          type: "counter-incremented",
          payloadSchema: z.object({ by: z.number() }),
        }),
      },
      consumes: ["counter-incremented"],
      emits: [],
      reduce: ({ state, event }) => ({ count: state.count + event.payload.by }),
    });
    const processor = implementProcessor(contract, {});

    expect(() =>
      runProcessorReduce({
        processor,
        state: { count: 1 },
        event: committedEvent({
          type: "counter-incremented",
          payload: { by: "2" },
        }),
      }),
    ).toThrow();
  });

  it("rejects reducers that produce non-object state at runtime", () => {
    const contract = defineProcessorContract({
      slug: "bad-reducer",
      version: "1.0.0",
      description: "Has a reducer that is patched to return bad state.",
      state: z.object({ count: z.number().default(0) }).prefault({}),
      events: {
        ...createEvent({
          type: "counter-incremented",
          payloadSchema: z.object({ by: z.number() }),
        }),
      },
      consumes: ["counter-incremented"],
      emits: [],
      reduce: ({ state, event }) => ({ count: state.count + event.payload.by }),
    });
    Object.assign(contract, {
      reduce: () => 1,
    });
    const processor = implementProcessor(contract, {});

    expect(() =>
      runProcessorReduce({
        processor,
        state: { count: 1 },
        event: committedEvent({
          type: "counter-incremented",
          payload: { by: 2 },
        }),
      }),
    ).toThrow('Processor "bad-reducer" state must be an object.');
  });

  it("runs afterAppend with the parsed consumed event and reduced state", async () => {
    const calls: unknown[] = [];
    const contract = defineProcessorContract({
      slug: "counter",
      version: "1.0.0",
      description: "Counts committed increment events.",
      state: z.object({ count: z.number().default(0) }).prefault({}),
      events: {
        ...createEvent({
          type: "counter-incremented",
          payloadSchema: z.object({ by: z.number() }),
        }),
      },
      consumes: ["counter-incremented"],
      emits: [],
      reduce: ({ state, event }) => ({ count: state.count + event.payload.by }),
    });
    const processor = implementProcessor(contract, {
      afterAppend: (args) => {
        calls.push({
          event: args.event,
          previousState: args.previousState,
          state: args.state,
        });
      },
    });
    const result = runProcessorReduce({
      processor,
      state: { count: 1 },
      event: committedEvent({
        type: "counter-incremented",
        payload: { by: 2 },
      }),
    });

    expect(result).toBeDefined();
    await runProcessorAfterAppend({
      processor,
      event: result!.event,
      previousState: result!.previousState,
      state: result!.state,
      streamApi: {
        append: async () => committedEvent({ type: "unused", payload: {} }),
        read: async () => [],
        subscribe: () => emptyAsyncIterable(),
      },
      signal: new AbortController().signal,
    });

    expect(calls).toMatchObject([
      {
        event: {
          type: "counter-incremented",
          payload: { by: 2 },
        },
        previousState: { count: 1 },
        state: { count: 3 },
      },
    ]);
  });

  it("runs onStart with initialized state and stream API", async () => {
    const calls: unknown[] = [];
    const contract = defineProcessorContract({
      slug: "starter",
      version: "1.0.0",
      description: "Starts from reduced state.",
      state: z.object({ connected: z.boolean().default(false) }).prefault({}),
      events: {},
      consumes: [],
      emits: [],
    });
    const processor = implementProcessor(contract, {
      onStart: (args) => {
        calls.push({
          state: args.state,
          aborted: args.signal.aborted,
        });
      },
    });

    await runProcessorOnStart({
      processor,
      state: contract.state.parse(undefined),
      streamApi: {
        append: async () => committedEvent({ type: "unused", payload: {} }),
        read: async () => [],
        subscribe: () => emptyAsyncIterable(),
      },
      signal: new AbortController().signal,
    });

    expect(calls).toEqual([
      {
        state: { connected: false },
        aborted: false,
      },
    ]);
  });

  it("documents replay host flow as reducer-only", () => {
    const afterAppendCalls: unknown[] = [];
    const contract = defineProcessorContract({
      slug: "counter",
      version: "1.0.0",
      description: "Counts committed increment events.",
      state: z.object({ count: z.number().default(0) }).prefault({}),
      events: {
        ...createEvent({
          type: "counter-incremented",
          payloadSchema: z.object({ by: z.number() }),
        }),
      },
      consumes: ["counter-incremented"],
      emits: [],
      reduce: ({ state, event }) => ({ count: state.count + event.payload.by }),
    });
    const processor = implementProcessor(contract, {
      afterAppend: (args) => {
        afterAppendCalls.push(args.event);
      },
    });

    const state = replayProcessorEvents({
      processor,
      state: contract.state.parse(undefined),
      events: [
        committedEvent({ type: "counter-incremented", payload: { by: 1 } }),
        committedEvent({ type: "counter-ignored", payload: {} }),
        committedEvent({ type: "counter-incremented", payload: { by: 2 } }),
      ],
    });

    expect(state).toEqual({ count: 3 });
    expect(afterAppendCalls).toEqual([]);
  });

  it("documents live host flow as reduce, save, then afterAppend", async () => {
    const calls: unknown[] = [];
    const contract = defineProcessorContract({
      slug: "counter",
      version: "1.0.0",
      description: "Counts committed increment events.",
      state: z.object({ count: z.number().default(0) }).prefault({}),
      events: {
        ...createEvent({
          type: "counter-incremented",
          payloadSchema: z.object({ by: z.number() }),
        }),
      },
      consumes: ["counter-incremented"],
      emits: [],
      reduce: ({ state, event }) => {
        calls.push(["reduce", event.type, state.count]);
        return { count: state.count + event.payload.by };
      },
    });
    const processor = implementProcessor(contract, {
      afterAppend: (args) => {
        calls.push(["afterAppend", args.event.type, args.previousState.count, args.state.count]);
      },
    });

    const state = await processLiveProcessorEvent<typeof contract>({
      processor,
      state: { count: 1 },
      event: committedEvent({ type: "counter-incremented", payload: { by: 2 } }),
      saveProcessorState: async (nextState) => {
        calls.push(["save", nextState.count]);
      },
      streamApi: createTestStreamApi(),
      signal: new AbortController().signal,
    });

    expect(state).toEqual({ count: 3 });
    expect(calls).toEqual([
      ["reduce", "counter-incremented", 1],
      ["save", 3],
      ["afterAppend", "counter-incremented", 1, 3],
    ]);
  });

  it("documents live host flow for ignored events as no save and no afterAppend", async () => {
    const calls: unknown[] = [];
    const contract = defineProcessorContract({
      slug: "counter",
      version: "1.0.0",
      description: "Counts committed increment events.",
      state: z.object({ count: z.number().default(0) }).prefault({}),
      events: {
        ...createEvent({
          type: "counter-incremented",
          payloadSchema: z.object({ by: z.number() }),
        }),
      },
      consumes: ["counter-incremented"],
      emits: [],
      reduce: ({ state, event }) => ({ count: state.count + event.payload.by }),
    });
    const processor = implementProcessor(contract, {
      afterAppend: (args) => {
        calls.push(["afterAppend", args.event.type]);
      },
    });

    const state = await processLiveProcessorEvent<typeof contract>({
      processor,
      state: { count: 1 },
      event: committedEvent({ type: "counter-ignored", payload: {} }),
      saveProcessorState: async (nextState) => {
        calls.push(["save", nextState.count]);
      },
      streamApi: createTestStreamApi(),
      signal: new AbortController().signal,
    });

    expect(state).toEqual({ count: 1 });
    expect(calls).toEqual([]);
  });
});

function committedEvent(args: { type: string; payload: unknown }): StreamEvent {
  return {
    streamPath: "/streams/test",
    type: args.type,
    payload: args.payload,
    offset: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

async function* emptyAsyncIterable(): AsyncIterable<StreamEvent> {}

type RunnableProcessorContract = {
  events: EventCatalog;
  processorDeps?: readonly unknown[];
  consumes: readonly string[];
};

function replayProcessorEvents<const Contract extends RunnableProcessorContract>(args: {
  processor: Processor<Contract>;
  state: ProcessorState<Contract>;
  events: StreamEvent[];
}): ProcessorState<Contract> {
  let state = args.state;
  for (const event of args.events) {
    const reduction = runProcessorReduce({
      processor: args.processor,
      event,
      state,
    });
    if (reduction == null) {
      continue;
    }
    state = reduction.state;
  }
  return state;
}

async function processLiveProcessorEvent<
  const Contract extends RunnableProcessorContract & {
    reduce?: (args: {
      state: ProcessorState<Contract>;
      event: ConsumedEvent<Contract>;
    }) => ProcessorState<Contract> | null | undefined;
  },
>(args: {
  processor: Processor<Contract>;
  state: ProcessorState<Contract>;
  event: StreamEvent;
  saveProcessorState(state: ProcessorState<Contract>): Promise<void>;
  streamApi: ProcessorStreamApi<Contract>;
  signal: AbortSignal;
}): Promise<ProcessorState<Contract>> {
  const reduction = runProcessorReduce({
    processor: args.processor,
    event: args.event,
    state: args.state,
  });
  if (reduction == null) {
    return args.state;
  }

  await args.saveProcessorState(reduction.state);
  await runProcessorAfterAppend({
    processor: args.processor,
    ...reduction,
    streamApi: args.streamApi,
    signal: args.signal,
  });
  return reduction.state;
}

function createTestStreamApi<Contract>(): ProcessorStreamApi<Contract> {
  return {
    append: async () => committedEvent({ type: "unused", payload: {} }),
    read: async () => [],
    subscribe: () => emptyAsyncIterable(),
  };
}
