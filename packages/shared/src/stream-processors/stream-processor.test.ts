import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createStoredProcessorState,
  createEvent,
  buildDerivedIdempotencyKey,
  defineProcessorContract,
  getEventInputSchema,
  getEventSchema,
  getInitialProcessorState,
  getProcessorStateSchema,
  implementProcessor,
  catchUpProcessorFromStream,
  consumeLiveProcessorEvent,
  runProcessorOnStart,
  runProcessorReduce,
  runProcessorAfterAppend,
  validateProcessorContract,
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
  stateSchema: z.object({}).default({}),
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
    expect(events["echo-requested"].description).toBe("Requests an echo response.");
    expect(
      getEventInputSchema({
        type: "echo-requested",
        payloadSchema: events["echo-requested"].payloadSchema,
      }).parse({
        type: "echo-requested",
        payload: { text: "hello" },
        idempotencyKey: "echo:1",
      }),
    ).toEqual({
      type: "echo-requested",
      payload: { text: "hello" },
      idempotencyKey: "echo:1",
    });
  });

  it("builds stable idempotency keys for derived appends", () => {
    expect(
      buildDerivedIdempotencyKey({
        slug: "codemode",
        purpose: "result-to-agent-input",
        event: {
          streamPath: "/agents/test",
          offset: 42,
        },
      }),
    ).toBe("stream-processor:codemode:derived:result-to-agent-input:/agents/test:42");
  });

  it("parses event input and event output strictly", () => {
    const events = {
      ...createEvent({
        type: "strict-event",
        payloadSchema: z.object({ text: z.string() }),
      }),
    };
    const eventInputSchema = getEventInputSchema({
      type: "strict-event",
      payloadSchema: events["strict-event"].payloadSchema,
    });
    const eventSchema = getEventSchema({
      type: "strict-event",
      payloadSchema: events["strict-event"].payloadSchema,
    });

    expect(() =>
      eventInputSchema.parse({
        type: "strict-event",
        payload: { text: "hello" },
        extra: true,
      }),
    ).toThrow();
    expect(() =>
      eventInputSchema.parse({
        type: "wrong-event",
        payload: { text: "hello" },
      }),
    ).toThrow();
    expect(() =>
      eventInputSchema.parse({
        type: "strict-event",
        payload: { text: "hello" },
        idempotencyKey: " ",
      }),
    ).toThrow();
    expect(() =>
      eventSchema.parse({
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
      stateSchema: z.object({ count: z.number().default(0) }).prefault({}),
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
      stateSchema: z.object({}).default({}),
      events: {},
      consumes: [],
      emits: [],
    });

    expect(getProcessorStateSchema(contract).parse(undefined)).toEqual({});
    expect(() => validateProcessorContract(contract)).not.toThrow();
  });

  it("accepts explicit initial state for schemas that cannot parse undefined", () => {
    const contract = {
      slug: "echo",
      stateSchema: z.object({ count: z.number() }),
      initialState: { count: 0 },
      events: {},
      consumes: [],
      emits: [],
    };

    expect(() => validateProcessorContract(contract)).not.toThrow();
    expect(getInitialProcessorState(contract)).toEqual({ count: 0 });
  });

  it("rejects schemas that cannot parse omitted initial state", () => {
    const contract = {
      slug: "echo",
      stateSchema: z.object({ count: z.number() }),
      events: {},
      consumes: [],
      emits: [],
    };

    expect(() => validateProcessorContract(contract)).toThrow();
  });

  it("rejects state schemas that parse undefined into non-object states", () => {
    const primitiveStateContract = {
      slug: "primitive-state",
      stateSchema: z.number().default(0),
      events: {},
      consumes: [],
      emits: [],
    };
    const arrayStateContract = {
      slug: "array-state",
      stateSchema: z.array(z.string()).default([]),
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
      stateSchema: z.object({ count: z.number().default(0) }).prefault({}),
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
      stateSchema: z.object({}).default({}),
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
      stateSchema: z.object({}).default({}),
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
      stateSchema: z.object({}).default({}),
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
      stateSchema: z.object({}).default({}),
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
      stateSchema: z.object({}).default({}),
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
      stateSchema: z.object({ count: z.number().default(0) }).prefault({}),
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
      stateSchema: z.object({ count: z.number().default(0) }).prefault({}),
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
      stateSchema: z.object({ count: z.number().default(0) }).prefault({}),
      events: eventDefinition,
      consumes: ["noop"],
      emits: [],
    });
    const nullReducerContract = defineProcessorContract({
      slug: "null-reducer",
      version: "1.0.0",
      description: "Uses null to keep state unchanged.",
      stateSchema: z.object({ count: z.number().default(0) }).prefault({}),
      events: eventDefinition,
      consumes: ["noop"],
      emits: [],
      reduce: () => null,
    });
    const undefinedReducerContract = defineProcessorContract({
      slug: "undefined-reducer",
      version: "1.0.0",
      description: "Uses undefined to keep state unchanged.",
      stateSchema: z.object({ count: z.number().default(0) }).prefault({}),
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
      stateSchema: z.object({ count: z.number().default(0) }).prefault({}),
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
      stateSchema: z.object({ count: z.number().default(0) }).prefault({}),
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
      stateSchema: z.object({ count: z.number().default(0) }).prefault({}),
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
      stateSchema: z.object({ connected: z.boolean().default(false) }).prefault({}),
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
      state: contract.stateSchema.parse(undefined),
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

  it("initializes stored processor state with runner progress defaults", () => {
    const contract = defineProcessorContract({
      slug: "counter",
      version: "1.0.0",
      description: "Counts committed increment events.",
      stateSchema: z.object({ count: z.number().default(0) }).prefault({}),
      events: {},
      consumes: [],
      emits: [],
    });

    expect(createStoredProcessorState({ contract })).toEqual({
      state: { count: 0 },
      hasCompletedFirstAttach: false,
      liveAfterOffset: 0,
      reducedThroughOffset: 0,
      afterAppendCompletedThroughOffset: 0,
    });
  });

  it("runs first attach catch-up as reduce-only before onStart when lookback is disabled", async () => {
    const calls: unknown[] = [];
    const contract = defineProcessorContract({
      slug: "counter",
      version: "1.0.0",
      description: "Counts committed increment events.",
      stateSchema: z.object({ count: z.number().default(0) }).prefault({}),
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
      onStart: ({ state }) => {
        calls.push(["onStart", state.count]);
      },
      afterAppend: ({ event }) => {
        calls.push(["afterAppend", event.offset]);
      },
    });

    const storedState = await catchUpProcessorFromStream({
      processor,
      storedState: createStoredProcessorState({ contract }),
      saveStoredProcessorState: async (nextStoredState) => {
        calls.push([
          "save",
          nextStoredState.state.count,
          nextStoredState.reducedThroughOffset,
          nextStoredState.afterAppendCompletedThroughOffset,
        ]);
      },
      streamApi: {
        ...createTestStreamApi<typeof contract>(),
        read: async () => [
          committedEvent({ type: "counter-incremented", payload: { by: 1 }, offset: 1 }),
          committedEvent({ type: "counter-incremented", payload: { by: 2 }, offset: 2 }),
        ],
      },
      signal: new AbortController().signal,
      firstAttachAfterAppend: { mode: "none" },
    });

    expect(storedState).toEqual({
      state: { count: 3 },
      hasCompletedFirstAttach: true,
      liveAfterOffset: 2,
      reducedThroughOffset: 2,
      afterAppendCompletedThroughOffset: 2,
    });
    expect(calls).toEqual([
      ["save", 3, 2, 0],
      ["onStart", 3],
      ["save", 3, 2, 2],
    ]);
  });

  it("runs first attach afterAppend only for events inside the default lookback window", async () => {
    const calls: unknown[] = [];
    const contract = defineProcessorContract({
      slug: "counter",
      version: "1.0.0",
      description: "Counts committed increment events.",
      stateSchema: z.object({ count: z.number().default(0) }).prefault({}),
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
      onStart: ({ state }) => {
        calls.push(["onStart", state.count]);
      },
      afterAppend: ({ event, state }) => {
        calls.push(["afterAppend", event.offset, state.count]);
      },
    });

    const storedState = await catchUpProcessorFromStream({
      processor,
      storedState: createStoredProcessorState({ contract }),
      saveStoredProcessorState: async (nextStoredState) => {
        calls.push([
          "save",
          nextStoredState.state.count,
          nextStoredState.reducedThroughOffset,
          nextStoredState.afterAppendCompletedThroughOffset,
        ]);
      },
      streamApi: {
        ...createTestStreamApi<typeof contract>(),
        read: async () => [
          committedEvent({
            type: "counter-incremented",
            payload: { by: 1 },
            offset: 1,
            createdAt: "2026-01-01T00:00:00.000Z",
          }),
          committedEvent({
            type: "counter-incremented",
            payload: { by: 2 },
            offset: 2,
            createdAt: "2026-01-01T00:00:00.900Z",
          }),
        ],
      },
      signal: new AbortController().signal,
      now: new Date("2026-01-01T00:00:01.001Z"),
    });

    expect(storedState).toEqual({
      state: { count: 3 },
      hasCompletedFirstAttach: true,
      liveAfterOffset: 2,
      reducedThroughOffset: 2,
      afterAppendCompletedThroughOffset: 2,
    });
    expect(calls).toEqual([
      ["save", 3, 2, 0],
      ["onStart", 3],
      ["afterAppend", 2, 3],
      ["save", 3, 2, 2],
    ]);
  });

  it("runs restart catch-up afterAppend for missed live events", async () => {
    const calls: unknown[] = [];
    const contract = defineProcessorContract({
      slug: "counter",
      version: "1.0.0",
      description: "Counts committed increment events.",
      stateSchema: z.object({ count: z.number().default(0) }).prefault({}),
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
      afterAppend: ({ event, previousState, state }) => {
        calls.push(["afterAppend", event.offset, previousState.count, state.count]);
      },
    });

    const storedState = await catchUpProcessorFromStream({
      processor,
      storedState: createStoredProcessorState({
        contract,
        state: { count: 3 },
        hasCompletedFirstAttach: true,
        liveAfterOffset: 2,
        reducedThroughOffset: 2,
        afterAppendCompletedThroughOffset: 2,
      }),
      saveStoredProcessorState: async (nextStoredState) => {
        calls.push([
          "save",
          nextStoredState.state.count,
          nextStoredState.reducedThroughOffset,
          nextStoredState.afterAppendCompletedThroughOffset,
        ]);
      },
      streamApi: {
        ...createTestStreamApi<typeof contract>(),
        read: async () => [
          committedEvent({ type: "counter-incremented", payload: { by: 4 }, offset: 3 }),
        ],
      },
      signal: new AbortController().signal,
    });

    expect(storedState).toEqual({
      state: { count: 7 },
      hasCompletedFirstAttach: true,
      liveAfterOffset: 2,
      reducedThroughOffset: 3,
      afterAppendCompletedThroughOffset: 3,
    });
    expect(calls).toEqual([
      ["save", 7, 3, 2],
      ["afterAppend", 3, 3, 7],
      ["save", 7, 3, 3],
    ]);
  });

  it("documents replay runner flow as reducer-only", () => {
    const afterAppendCalls: unknown[] = [];
    const contract = defineProcessorContract({
      slug: "counter",
      version: "1.0.0",
      description: "Counts committed increment events.",
      stateSchema: z.object({ count: z.number().default(0) }).prefault({}),
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
      state: contract.stateSchema.parse(undefined),
      events: [
        committedEvent({ type: "counter-incremented", payload: { by: 1 } }),
        committedEvent({ type: "counter-ignored", payload: {} }),
        committedEvent({ type: "counter-incremented", payload: { by: 2 } }),
      ],
    });

    expect(state).toEqual({ count: 3 });
    expect(afterAppendCalls).toEqual([]);
  });

  it("runs live events as reduce, save, then afterAppend", async () => {
    const calls: unknown[] = [];
    const contract = defineProcessorContract({
      slug: "counter",
      version: "1.0.0",
      description: "Counts committed increment events.",
      stateSchema: z.object({ count: z.number().default(0) }).prefault({}),
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

    const storedState = await consumeLiveProcessorEvent<typeof contract>({
      processor,
      storedState: createStoredProcessorState({ contract, state: { count: 1 } }),
      event: committedEvent({ type: "counter-incremented", payload: { by: 2 } }),
      saveStoredProcessorState: async (nextStoredState) => {
        calls.push(["save", nextStoredState.state.count, nextStoredState.reducedThroughOffset]);
      },
      streamApi: createTestStreamApi(),
      signal: new AbortController().signal,
    });

    expect(storedState).toMatchObject({
      state: { count: 3 },
      reducedThroughOffset: 1,
      afterAppendCompletedThroughOffset: 1,
    });
    expect(calls).toEqual([
      ["reduce", "counter-incremented", 1],
      ["save", 3, 1],
      ["afterAppend", "counter-incremented", 1, 3],
      ["save", 3, 1],
    ]);
  });

  it("advances live runner progress for ignored events without afterAppend", async () => {
    const calls: unknown[] = [];
    const contract = defineProcessorContract({
      slug: "counter",
      version: "1.0.0",
      description: "Counts committed increment events.",
      stateSchema: z.object({ count: z.number().default(0) }).prefault({}),
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

    const storedState = await consumeLiveProcessorEvent<typeof contract>({
      processor,
      storedState: createStoredProcessorState({ contract, state: { count: 1 } }),
      event: committedEvent({ type: "counter-ignored", payload: {}, offset: 4 }),
      saveStoredProcessorState: async (nextStoredState) => {
        calls.push(["save", nextStoredState.state.count, nextStoredState.reducedThroughOffset]);
      },
      streamApi: createTestStreamApi(),
      signal: new AbortController().signal,
    });

    expect(storedState).toMatchObject({
      state: { count: 1 },
      reducedThroughOffset: 4,
      afterAppendCompletedThroughOffset: 4,
    });
    expect(calls).toEqual([["save", 1, 4]]);
  });

  it("catches up lower-offset events before processing an out-of-order pushed event", async () => {
    const calls: unknown[] = [];
    const contract = defineProcessorContract({
      slug: "counter",
      version: "1.0.0",
      description: "Counts committed increment events.",
      stateSchema: z.object({ count: z.number().default(0) }).prefault({}),
      events: {
        ...createEvent({
          type: "counter-incremented",
          payloadSchema: z.object({ by: z.number() }),
        }),
      },
      consumes: ["counter-incremented"],
      emits: [],
      reduce: ({ state, event }) => {
        calls.push(["reduce", event.offset, event.type, state.count]);
        return { count: state.count + event.payload.by };
      },
    });
    const processor = implementProcessor(contract, {
      afterAppend: (args) => {
        calls.push(["afterAppend", args.event.offset, args.event.type]);
      },
    });

    const storedState = await consumeLiveProcessorEvent<typeof contract>({
      processor,
      storedState: createStoredProcessorState({
        contract,
        state: { count: 1 },
        reducedThroughOffset: 1,
        afterAppendCompletedThroughOffset: 1,
        hasCompletedFirstAttach: true,
        liveAfterOffset: 1,
      }),
      event: committedEvent({ type: "counter-ignored", payload: {}, offset: 3 }),
      saveStoredProcessorState: async (nextStoredState) => {
        calls.push(["save", nextStoredState.state.count, nextStoredState.reducedThroughOffset]);
      },
      streamApi: {
        ...createTestStreamApi<typeof contract>(),
        read: async (args = {}) => {
          calls.push(["read", args.afterOffset, args.beforeOffset]);
          return [committedEvent({ type: "counter-incremented", payload: { by: 2 }, offset: 2 })];
        },
      },
      signal: new AbortController().signal,
    });

    expect(storedState).toMatchObject({
      state: { count: 3 },
      reducedThroughOffset: 3,
      afterAppendCompletedThroughOffset: 3,
    });
    expect(calls).toEqual([
      ["read", 1, 3],
      ["reduce", 2, "counter-incremented", 1],
      ["save", 3, 2],
      ["afterAppend", 2, "counter-incremented"],
      ["save", 3, 2],
      ["save", 3, 3],
    ]);
  });

  it("keeps reduced progress separate from afterAppend completion for runner retries", async () => {
    const contract = defineProcessorContract({
      slug: "counter",
      version: "1.0.0",
      description: "Counts committed increment events.",
      stateSchema: z.object({ count: z.number().default(0) }).prefault({}),
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
      afterAppend: () => {
        throw new Error("transient side effect failure");
      },
    });
    const event = committedEvent({
      type: "counter-incremented",
      payload: { by: 2 },
      offset: 7,
    });
    let storedState = createStoredProcessorState({ contract, state: { count: 1 } });

    const reduction = runProcessorReduce({
      processor,
      state: storedState.state,
      event,
    });

    expect(reduction).toBeDefined();
    storedState = {
      ...storedState,
      state: reduction!.state,
      reducedThroughOffset: reduction!.event.offset,
    };
    await expect(
      runProcessorAfterAppend({
        processor,
        ...reduction!,
        streamApi: createTestStreamApi<typeof contract>(),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("transient side effect failure");

    expect(storedState).toEqual({
      state: { count: 3 },
      hasCompletedFirstAttach: false,
      liveAfterOffset: 0,
      reducedThroughOffset: 7,
      afterAppendCompletedThroughOffset: 0,
    });
  });

  it("reports live afterAppend errors before preserving retry semantics", async () => {
    const contract = defineProcessorContract({
      slug: "counter",
      version: "1.0.0",
      description: "Counts committed increment events.",
      stateSchema: z.object({ count: z.number().default(0) }).prefault({}),
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
      afterAppend: () => {
        throw new Error("transient side effect failure");
      },
    });
    const errors: unknown[] = [];

    await expect(
      consumeLiveProcessorEvent<typeof contract>({
        processor,
        storedState: createStoredProcessorState({ contract, state: { count: 1 } }),
        event: committedEvent({
          type: "counter-incremented",
          payload: { by: 2 },
          offset: 7,
        }),
        saveStoredProcessorState: async () => {},
        streamApi: createTestStreamApi<typeof contract>(),
        afterAppendError: ({ error, reduction }) => {
          errors.push({ error, offset: reduction.event.offset });
        },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("transient side effect failure");

    expect(errors).toMatchObject([{ offset: 7 }]);
    expect((errors[0] as { error: Error }).error.message).toBe("transient side effect failure");
  });

  it("marks afterAppend completion separately when live effects succeed", async () => {
    const contract = defineProcessorContract({
      slug: "counter",
      version: "1.0.0",
      description: "Counts committed increment events.",
      stateSchema: z.object({ count: z.number().default(0) }).prefault({}),
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
    const event = committedEvent({
      type: "counter-incremented",
      payload: { by: 2 },
      offset: 9,
    });
    let storedState = createStoredProcessorState({ contract, state: { count: 1 } });
    const reduction = runProcessorReduce({
      processor,
      state: storedState.state,
      event,
    });

    expect(reduction).toBeDefined();
    storedState = {
      ...storedState,
      state: reduction!.state,
      reducedThroughOffset: reduction!.event.offset,
    };
    await runProcessorAfterAppend({
      processor,
      ...reduction!,
      streamApi: createTestStreamApi<typeof contract>(),
      signal: new AbortController().signal,
    });
    storedState = {
      ...storedState,
      afterAppendCompletedThroughOffset: reduction!.event.offset,
    };

    expect(storedState).toEqual({
      state: { count: 3 },
      hasCompletedFirstAttach: false,
      liveAfterOffset: 0,
      reducedThroughOffset: 9,
      afterAppendCompletedThroughOffset: 9,
    });
  });

  it("projects frontend-visible agent loop state with the backend reducer only", () => {
    const agentLoopContract = defineProcessorContract({
      slug: "agent-loop",
      version: "1.0.0",
      description: "Frontend-visible agent loop projection.",
      stateSchema: z
        .object({
          computing: z.boolean().default(false),
          currentRequestId: z.string().nullable().default(null),
          queuedMessageCount: z.number().int().nonnegative().default(0),
          transcript: z
            .array(
              z.object({
                role: z.enum(["user", "assistant"]),
                content: z.string(),
              }),
            )
            .default([]),
        })
        .prefault({}),
      events: {
        ...createEvent({
          type: "agent-input-added",
          payloadSchema: z.object({
            role: z.enum(["user", "assistant"]),
            content: z.string(),
          }),
        }),
        ...createEvent({
          type: "llm-request-scheduled",
          payloadSchema: z.object({ requestId: z.string() }),
        }),
        ...createEvent({
          type: "llm-request-started",
          payloadSchema: z.object({ requestId: z.string() }),
        }),
        ...createEvent({
          type: "llm-request-completed",
          payloadSchema: z.object({ requestId: z.string() }),
        }),
      },
      consumes: [
        "agent-input-added",
        "llm-request-scheduled",
        "llm-request-started",
        "llm-request-completed",
      ],
      emits: [],
      reduce: ({ state, event }) => {
        switch (event.type) {
          case "agent-input-added":
            return {
              ...state,
              transcript: [
                ...state.transcript,
                { role: event.payload.role, content: event.payload.content },
              ],
            };
          case "llm-request-scheduled":
            return { ...state, queuedMessageCount: state.queuedMessageCount + 1 };
          case "llm-request-started":
            return {
              ...state,
              queuedMessageCount: Math.max(0, state.queuedMessageCount - 1),
              computing: true,
              currentRequestId: event.payload.requestId,
            };
          case "llm-request-completed":
            return state.currentRequestId === event.payload.requestId
              ? { ...state, computing: false, currentRequestId: null }
              : undefined;
          default:
            return undefined;
        }
      },
    });

    const state = replayProcessorEvents({
      processor: implementProcessor(agentLoopContract, {}),
      state: agentLoopContract.stateSchema.parse(undefined),
      events: [
        committedEvent({
          type: "agent-input-added",
          payload: { role: "user", content: "build the thing" },
          offset: 1,
        }),
        committedEvent({
          type: "llm-request-scheduled",
          payload: { requestId: "req_1" },
          offset: 2,
        }),
        committedEvent({
          type: "llm-request-started",
          payload: { requestId: "req_1" },
          offset: 3,
        }),
        committedEvent({
          type: "agent-input-added",
          payload: { role: "assistant", content: "working" },
          offset: 4,
        }),
      ],
    });

    expect(state).toEqual({
      computing: true,
      currentRequestId: "req_1",
      queuedMessageCount: 0,
      transcript: [
        { role: "user", content: "build the thing" },
        { role: "assistant", content: "working" },
      ],
    });
  });
});

function committedEvent(args: {
  type: string;
  payload: unknown;
  offset?: number;
  createdAt?: string;
}): StreamEvent {
  return {
    streamPath: "/streams/test",
    type: args.type,
    payload: args.payload,
    offset: args.offset ?? 1,
    createdAt: args.createdAt ?? "2026-01-01T00:00:00.000Z",
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

function createTestStreamApi<Contract>(): ProcessorStreamApi<Contract> {
  return {
    append: async () => committedEvent({ type: "unused", payload: {} }),
    read: async () => [],
    subscribe: () => emptyAsyncIterable(),
  };
}
