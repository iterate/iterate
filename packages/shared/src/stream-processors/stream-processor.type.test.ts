import { describe, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  assertNever,
  createEvent,
  defineProcessorContract,
  implementBuiltinProcessor,
  implementProcessor,
  runProcessorOnStart,
  runProcessorReduce,
  runProcessorAfterAppend,
  type ConsumedEvent,
  type EmittedInput,
  type EventCatalog,
  type FirstAttachAfterAppendPolicy,
  type StoredProcessorState,
  type ProcessorState,
  type ProcessorReduction,
  type ResolvedEventType,
  type StreamEvent,
} from "./stream-processor.ts";

const streamProcessorContract = defineProcessorContract({
  slug: "stream-core",
  version: "1.0.0",
  description: "Core stream event catalog.",
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

const standaloneEventCatalog = {
  ...createEvent({
    type: "catalog-event",
    payloadSchema: z.object({
      value: z.number(),
    }),
  }),
};

const agentProcessorContract = defineProcessorContract({
  slug: "agent",
  version: "1.0.0",
  description: "Agent event catalog.",
  stateSchema: z.object({}).default({}),
  processorDeps: [streamProcessorContract],
  events: {
    ...createEvent({
      type: "agent-input-added",
      payloadSchema: z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string(),
      }),
    }),
  },
  consumes: ["processor-registered", "agent-input-added"],
  emits: ["processor-registered", "agent-input-added"],
  reduce: ({ state }) => state,
});

const codemodeProcessorContract = defineProcessorContract({
  slug: "codemode",
  version: "1.0.0",
  description: "Codemode event catalog.",
  stateSchema: z
    .object({
      count: z.number().default(0),
    })
    .prefault({}),
  processorDeps: [streamProcessorContract, agentProcessorContract],
  events: {
    ...createEvent({
      type: "codemode-block-added",
      payloadSchema: z.object({
        script: z.string(),
      }),
    }),
    ...createEvent({
      type: "codemode-result-added",
      payloadSchema: z.object({
        result: z.unknown(),
      }),
    }),
  },
  consumes: ["processor-registered", "agent-input-added", "codemode-block-added"],
  emits: ["processor-registered", "agent-input-added", "codemode-result-added"],
  reduce: ({ state, event }) => {
    if (event.type === "agent-input-added") {
      expectTypeOf(event.payload).toEqualTypeOf<{
        role: "user" | "assistant";
        content: string;
      }>();
      // @ts-expect-error codemode block fields are not on agent input events.
      event.payload.script;
    }

    if (event.type === "codemode-block-added") {
      expectTypeOf(event.payload).toEqualTypeOf<{ script: string }>();
      return { count: state.count + 1 };
    }

    return state;
  },
});

const catalogConsumerContract = defineProcessorContract({
  slug: "catalog-consumer",
  version: "1.0.0",
  description: "Consumes an imported event catalog without depending on a full processor.",
  stateSchema: z.object({}).default({}),
  processorDeps: [standaloneEventCatalog],
  events: {},
  consumes: ["catalog-event"],
  emits: ["catalog-event"],
  reduce: ({ state, event }) => {
    expectTypeOf(event.payload).toEqualTypeOf<{ value: number }>();
    return state;
  },
});

const statelessForwarderContract = defineProcessorContract({
  slug: "stateless-forwarder",
  version: "1.0.0",
  description: "Side-effect-only processor with empty reduced state and no reducer.",
  stateSchema: z.object({}).default({}),
  processorDeps: [agentProcessorContract, codemodeProcessorContract],
  events: {},
  consumes: ["agent-input-added"],
  emits: ["codemode-result-added"],
});

describe("stream processor contract types", () => {
  it("infers initial state from defaultable state schemas", () => {
    expectTypeOf<ProcessorState<typeof codemodeProcessorContract>>().toEqualTypeOf<{
      count: number;
    }>();
  });

  it("types explicit empty object state for stateless processors", () => {
    expectTypeOf<ProcessorState<typeof statelessForwarderContract>>().toMatchTypeOf<object>();

    implementProcessor(statelessForwarderContract, {
      onStart: ({ state }) => {
        expectTypeOf(state).toMatchTypeOf<object>();
      },
      afterAppend: async ({ event, previousState, state, streamApi }) => {
        expectTypeOf(previousState).toMatchTypeOf<object>();
        expectTypeOf(state).toMatchTypeOf<object>();
        expectTypeOf(event.type).toEqualTypeOf<"agent-input-added">();
        expectTypeOf(event.payload).toEqualTypeOf<{
          role: "user" | "assistant";
          content: string;
        }>();

        await streamApi.append({
          event: {
            type: "codemode-result-added",
            payload: { result: event.payload.content },
          },
        });
      },
    });
  });

  it("narrows consumed events from string-keyed consumes", () => {
    type Consumed = ConsumedEvent<typeof codemodeProcessorContract>;

    expectTypeOf<Extract<Consumed, { type: "processor-registered" }>["payload"]>().toEqualTypeOf<{
      processorSlug: string;
      version: string;
    }>();
    expectTypeOf<Extract<Consumed, { type: "agent-input-added" }>["payload"]>().toEqualTypeOf<{
      role: "user" | "assistant";
      content: string;
    }>();
    expectTypeOf<Extract<Consumed, { type: "codemode-block-added" }>["payload"]>().toEqualTypeOf<{
      script: string;
    }>();
    expectTypeOf<Extract<Consumed, { type: "codemode-result-added" }>>().toEqualTypeOf<never>();
  });

  it("resolves autocomplete candidate event types from owned events and processor deps", () => {
    type Resolved = ResolvedEventType<
      typeof codemodeProcessorContract.events,
      typeof codemodeProcessorContract.processorDeps
    >;

    expectTypeOf<Resolved>().toEqualTypeOf<
      | "processor-registered"
      | "agent-input-added"
      | "codemode-block-added"
      | "codemode-result-added"
    >();

    const validConsumes = [
      "processor-registered",
      "agent-input-added",
      "codemode-block-added",
      "codemode-result-added",
    ] as const satisfies readonly Resolved[];

    [
      "processor-registered",
      // @ts-expect-error this is not owned locally or by processorDeps.
      "missing-event",
    ] as const satisfies readonly Resolved[];

    expectTypeOf<(typeof validConsumes)[number]>().toEqualTypeOf<
      | "processor-registered"
      | "agent-input-added"
      | "codemode-block-added"
      | "codemode-result-added"
    >();
  });

  it("preserves inline string-keyed event catalogs without createEvent", () => {
    const inlineContract = defineProcessorContract({
      slug: "inline",
      version: "1.0.0",
      description: "Uses the real inline event authoring shape.",
      stateSchema: z.object({ seen: z.number().default(0) }).prefault({}),
      events: {
        "inline-input": {
          description: "Inline input event.",
          payloadSchema: z.object({ text: z.string() }),
        },
        "inline-output": {
          description: "Inline output event.",
          payloadSchema: z.object({ value: z.number() }),
        },
      },
      consumes: ["inline-input"],
      emits: ["inline-output"],
      reduce: ({ state, event }) => {
        expectTypeOf(event.type).toEqualTypeOf<"inline-input">();
        expectTypeOf(event.payload).toEqualTypeOf<{ text: string }>();
        return { seen: state.seen + 1 };
      },
    });

    expectTypeOf<typeof inlineContract.consumes>().toEqualTypeOf<readonly ["inline-input"]>();
    expectTypeOf<typeof inlineContract.emits>().toEqualTypeOf<readonly ["inline-output"]>();
    expectTypeOf<
      Extract<ConsumedEvent<typeof inlineContract>, { type: "inline-input" }>["payload"]
    >().toEqualTypeOf<{ text: string }>();
    expectTypeOf<
      Extract<EmittedInput<typeof inlineContract>, { type: "inline-output" }>["payload"]
    >().toEqualTypeOf<{ value: number }>();
  });

  it("fails closed for widened event catalogs and widened event arrays", () => {
    const widenedEvents: EventCatalog = {
      "widened-event": {
        payloadSchema: z.object({}),
      },
    };

    defineProcessorContract({
      slug: "widened-events",
      version: "1.0.0",
      description: "Widened event catalogs should not make every string valid.",
      stateSchema: z.object({}).default({}),
      events: widenedEvents,
      // @ts-expect-error broad EventCatalog loses literal keys, so no local event strings are resolvable.
      consumes: ["widened-event"],
      emits: [],
    });

    const widenedConsumes = ["agent-input-added"];
    defineProcessorContract({
      slug: "widened-consumes",
      version: "1.0.0",
      description: "Widened arrays hide the visible event literal list.",
      stateSchema: z.object({}).default({}),
      processorDeps: [agentProcessorContract],
      events: {},
      // @ts-expect-error consumes should be a visible literal tuple, not string[].
      consumes: widenedConsumes,
      emits: [],
    });
  });

  it("supports exhaustive guards over consumed event unions", () => {
    function exhaustive(event: ConsumedEvent<typeof codemodeProcessorContract>) {
      switch (event.type) {
        case "processor-registered":
          return event.payload.version;
        case "agent-input-added":
          return event.payload.content;
        case "codemode-block-added":
          return event.payload.script;
        default:
          return assertNever(event);
      }
    }

    function missingOneCase(event: ConsumedEvent<typeof codemodeProcessorContract>) {
      switch (event.type) {
        case "processor-registered":
          return event.payload.version;
        case "agent-input-added":
          return event.payload.content;
        default:
          // @ts-expect-error codemode-block-added has not been handled.
          return assertNever(event);
      }
    }

    expectTypeOf(exhaustive).toEqualTypeOf<
      (event: ConsumedEvent<typeof codemodeProcessorContract>) => string
    >();
    expectTypeOf(missingOneCase).toEqualTypeOf<
      (event: ConsumedEvent<typeof codemodeProcessorContract>) => string
    >();
  });

  it("infers emitted append inputs from string-keyed emits", () => {
    type Emitted = EmittedInput<typeof codemodeProcessorContract>;

    expectTypeOf<Extract<Emitted, { type: "processor-registered" }>["payload"]>().toEqualTypeOf<{
      processorSlug: string;
      version: string;
    }>();
    expectTypeOf<Extract<Emitted, { type: "agent-input-added" }>["payload"]>().toEqualTypeOf<{
      role: "user" | "assistant";
      content: string;
    }>();
    expectTypeOf<Extract<Emitted, { type: "codemode-result-added" }>["payload"]>().toEqualTypeOf<{
      result: unknown;
    }>();
    expectTypeOf<Extract<Emitted, { type: "codemode-block-added" }>>().toEqualTypeOf<never>();
  });

  it("types processor implementation hooks from the contract", () => {
    implementProcessor(codemodeProcessorContract, {
      onStart: async ({ state, streamApi }) => {
        expectTypeOf(state).toEqualTypeOf<{ count: number }>();

        await streamApi.append({
          event: {
            type: "codemode-result-added",
            payload: { result: "started" },
          },
        });
      },
      afterAppend: async ({ event, streamApi }) => {
        expectTypeOf(event).toEqualTypeOf<ConsumedEvent<typeof codemodeProcessorContract>>();
        if (event.type !== "codemode-block-added") return;

        await streamApi.append({
          event: {
            type: "codemode-result-added",
            payload: { result: event.payload.script },
          },
        });

        await streamApi.append({
          event: {
            type: "agent-input-added",
            payload: { role: "user", content: "allowed" },
          },
        });

        await streamApi.append({
          event: {
            type: "processor-registered",
            payload: { processorSlug: "codemode", version: "1.0.0" },
          },
        });

        await streamApi.append({
          event: {
            // @ts-expect-error codemode-block-added is consumed but not emitted.
            type: "codemode-block-added",
            // @ts-expect-error codemode-block-added payload is not in the emitted union.
            payload: { script: "not allowed" },
          },
        });
      },
    });
  });

  it("rejects raw append inputs outside declared emitted events", () => {
    implementProcessor(codemodeProcessorContract, {
      afterAppend: async ({ streamApi }) => {
        await streamApi.append({
          event: {
            type: "codemode-result-added",
            payload: { result: "ok" },
          },
        });

        await streamApi.append({
          event: {
            type: "codemode-result-added",
            // @ts-expect-error payload must match the emitted event schema.
            payload: { wrong: "shape" },
          },
        });

        await streamApi.append({
          event: {
            // @ts-expect-error unknown events cannot be appended.
            type: "unknown-event",
            payload: { result: "nope" },
          },
        });
      },
    });
  });

  it("does not expose resolvable events unless they are listed in consumes or emits", () => {
    const selectiveContract = defineProcessorContract({
      slug: "selective",
      version: "1.0.0",
      description: "Only consumes and emits a subset of resolvable events.",
      stateSchema: z.object({}).default({}),
      processorDeps: [agentProcessorContract, codemodeProcessorContract],
      events: {
        ...createEvent({
          type: "selective-owned",
          payloadSchema: z.object({ owned: z.boolean() }),
        }),
      },
      consumes: ["agent-input-added"],
      emits: ["selective-owned"],
      reduce: ({ state }) => state,
    });

    type SelectiveConsumed = ConsumedEvent<typeof selectiveContract>;
    type SelectiveEmitted = EmittedInput<typeof selectiveContract>;

    expectTypeOf<
      Extract<SelectiveConsumed, { type: "agent-input-added" }>["payload"]
    >().toEqualTypeOf<{
      role: "user" | "assistant";
      content: string;
    }>();
    expectTypeOf<
      Extract<SelectiveConsumed, { type: "codemode-result-added" }>
    >().toEqualTypeOf<never>();
    expectTypeOf<
      Extract<SelectiveEmitted, { type: "selective-owned" }>["payload"]
    >().toEqualTypeOf<{
      owned: boolean;
    }>();
    expectTypeOf<Extract<SelectiveEmitted, { type: "agent-input-added" }>>().toEqualTypeOf<never>();

    implementProcessor(selectiveContract, {
      afterAppend: async ({ event, streamApi }) => {
        expectTypeOf(event.type).toEqualTypeOf<"agent-input-added">();

        await streamApi.append({
          event: {
            type: "selective-owned",
            payload: { owned: true },
          },
        });

        await streamApi.append({
          event: {
            // @ts-expect-error agent-input-added is resolvable but not emitted.
            type: "agent-input-added",
            // @ts-expect-error agent-input-added payload is not in the emitted union.
            payload: { role: "user", content: "not allowed" },
          },
        });
      },
    });
  });

  it("supports imported event catalogs without a full processor contract", () => {
    type CatalogConsumed = ConsumedEvent<typeof catalogConsumerContract>;

    expectTypeOf<Extract<CatalogConsumed, { type: "catalog-event" }>["payload"]>().toEqualTypeOf<{
      value: number;
    }>();
  });

  it("rejects unresolved consumed and emitted event types at the contract definition", () => {
    defineProcessorContract({
      slug: "bad-consumes",
      version: "1.0.0",
      description: "Contains a typo in consumes.",
      stateSchema: z.object({}).default({}),
      events: {
        ...createEvent({
          type: "known-event",
          payloadSchema: z.object({}),
        }),
      },
      // @ts-expect-error consumes must resolve against owned events and processorDeps.
      consumes: ["missing-event"],
      emits: [],
    });

    defineProcessorContract({
      slug: "bad-emits",
      version: "1.0.0",
      description: "Contains a typo in emits.",
      stateSchema: z.object({}).default({}),
      processorDeps: [agentProcessorContract],
      events: {},
      consumes: [],
      // @ts-expect-error emits must resolve against owned events and processorDeps.
      emits: ["missing-event"],
    });
  });

  it("keeps beforeAppend builtin-only", () => {
    implementBuiltinProcessor(streamProcessorContract, {
      beforeAppend: ({ event, state }) => {
        expectTypeOf(event.type).toEqualTypeOf<string>();
        expectTypeOf(state).toMatchTypeOf<object>();
      },
    });

    implementProcessor(streamProcessorContract, {
      // @ts-expect-error beforeAppend is only available to builtin processors.
      beforeAppend: () => {},
    });
  });

  it("allows explicit initial state when schemas do not parse undefined", () => {
    defineProcessorContract({
      slug: "valid-empty-state",
      version: "1.0.0",
      description: "Valid default empty state.",
      stateSchema: z.object({}).default({}),
      events: {},
      consumes: [],
      emits: [],
    });

    defineProcessorContract({
      slug: "valid",
      version: "1.0.0",
      description: "Valid defaultable state.",
      stateSchema: z.object({ count: z.number().default(0) }).prefault({}),
      events: {},
      consumes: [],
      emits: [],
      reduce: ({ state }) => state,
    });

    defineProcessorContract({
      slug: "invalid",
      version: "1.0.0",
      description: "Valid state with explicit initial state.",
      stateSchema: z.object({ count: z.number().default(0) }),
      initialState: {},
      events: {},
      consumes: [],
      emits: [],
      reduce: ({ state }) => state,
    });

    defineProcessorContract({
      slug: "invalid-initial-state",
      version: "1.0.0",
      description: "Invalid initial state input.",
      stateSchema: z.object({ count: z.number().default(0) }),
      // @ts-expect-error initialState must be valid input for stateSchema.
      initialState: { count: "nope" },
      events: {},
      consumes: [],
      emits: [],
    });
  });

  it("requires object-shaped state schemas", () => {
    defineProcessorContract({
      slug: "invalid-number-state",
      version: "1.0.0",
      description: "Invalid primitive state.",
      // @ts-expect-error processor state must be object-shaped.
      stateSchema: z.number().default(0),
      events: {},
      consumes: [],
      emits: [],
      reduce: ({ state }) => state,
    });

    defineProcessorContract({
      slug: "invalid-array-state",
      version: "1.0.0",
      description: "Invalid array state.",
      // @ts-expect-error processor state must be object-shaped.
      stateSchema: z.array(z.string()).default([]),
      events: {},
      consumes: [],
      emits: [],
      reduce: ({ state }) => state,
    });
  });

  it("types runProcessorReduce as consumed-event reduction or ignored event", () => {
    const processor = implementProcessor(codemodeProcessorContract, {});
    const event = null as unknown as StreamEvent;

    const result = runProcessorReduce({
      processor,
      state: { count: 0 },
      event,
    });

    expectTypeOf(result).toEqualTypeOf<
      ProcessorReduction<typeof codemodeProcessorContract> | undefined
    >();
  });

  it("types the stored runner state envelope from the processor contract", () => {
    expectTypeOf<StoredProcessorState<typeof codemodeProcessorContract>>().toEqualTypeOf<{
      state: { count: number };
      hasCompletedFirstAttach: boolean;
      liveAfterOffset: number;
      reducedThroughOffset: number;
      afterAppendCompletedThroughOffset: number;
    }>();
  });

  it("types runProcessorAfterAppend from the processor contract", async () => {
    const processor = implementProcessor(codemodeProcessorContract, {
      afterAppend: ({ event, state }) => {
        expectTypeOf(event).toEqualTypeOf<ConsumedEvent<typeof codemodeProcessorContract>>();
        expectTypeOf(state).toEqualTypeOf<{ count: number }>();
      },
    });
    const result = null as unknown as ProcessorReduction<typeof codemodeProcessorContract>;

    await runProcessorAfterAppend({
      processor,
      ...result,
      streamApi: {
        append: async (input) => {
          expectTypeOf(input).toEqualTypeOf<{
            event: EmittedInput<typeof codemodeProcessorContract>;
            streamPath?: string;
          }>();
          return null as unknown as StreamEvent;
        },
        read: async () => [],
        subscribe: () => null as unknown as AsyncIterable<StreamEvent>,
      },
      signal: new AbortController().signal,
    });
  });

  it("types implementation first-attach side-effect policy without putting it on the contract", () => {
    const processor = implementProcessor(codemodeProcessorContract, {
      firstAttachAfterAppend: { mode: "none" },
    });

    expectTypeOf(processor.contract).not.toHaveProperty("firstAttachAfterAppend");
    expectTypeOf(processor.implementation.firstAttachAfterAppend).toEqualTypeOf<
      FirstAttachAfterAppendPolicy | undefined
    >();
  });

  it("types runProcessorOnStart from the processor contract", async () => {
    const processor = implementProcessor(codemodeProcessorContract, {
      onStart: ({ state }) => {
        expectTypeOf(state).toEqualTypeOf<{ count: number }>();
      },
    });

    await runProcessorOnStart({
      processor,
      state: { count: 0 },
      streamApi: {
        append: async (input) => {
          expectTypeOf(input).toEqualTypeOf<{
            event: EmittedInput<typeof codemodeProcessorContract>;
            streamPath?: string;
          }>();
          return null as unknown as StreamEvent;
        },
        read: async () => [],
        subscribe: () => null as unknown as AsyncIterable<StreamEvent>,
      },
      signal: new AbortController().signal,
    });
  });

  it("rejects reducers that return non-state values", () => {
    defineProcessorContract({
      slug: "invalid-reducer-return",
      version: "1.0.0",
      description: "Invalid primitive reducer return.",
      stateSchema: z.object({}).default({}),
      events: {},
      consumes: [],
      emits: [],
      // @ts-expect-error reducers must return the object-shaped processor state, null, or undefined.
      reduce: () => 1,
    });
  });
});
