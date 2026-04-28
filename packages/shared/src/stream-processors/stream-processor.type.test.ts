import { describe, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  createEvent,
  defineProcessorContract,
  implementBuiltinProcessor,
  implementProcessor,
  type ConsumedEvent,
  type EmittedInput,
  type ProcessorState,
} from "./stream-processor.ts";

const streamProcessorContract = defineProcessorContract({
  slug: "stream-core",
  version: "1.0.0",
  description: "Core stream event catalog.",
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
  reducer: ({ state }) => state,
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
  state: z.object({}).default({}),
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
  reducer: ({ state }) => state,
});

const codemodeProcessorContract = defineProcessorContract({
  slug: "codemode",
  version: "1.0.0",
  description: "Codemode event catalog.",
  state: z
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
  reducer: ({ state, event }) => {
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
  state: z.object({}).default({}),
  processorDeps: [standaloneEventCatalog],
  events: {},
  consumes: ["catalog-event"],
  emits: ["catalog-event"],
  reducer: ({ state, event }) => {
    expectTypeOf(event.payload).toEqualTypeOf<{ value: number }>();
    return state;
  },
});

describe("stream processor contract types", () => {
  it("infers initial state from defaultable state schemas", () => {
    expectTypeOf<ProcessorState<typeof codemodeProcessorContract>>().toEqualTypeOf<{
      count: number;
    }>();
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

        await streamApi.append(
          codemodeProcessorContract.events["codemode-result-added"].createInput({
            payload: { result: "started" },
          }),
        );
      },
      onEvent: async ({ event, streamApi }) => {
        expectTypeOf(event).toEqualTypeOf<ConsumedEvent<typeof codemodeProcessorContract>>();
        if (event.type !== "codemode-block-added") return;

        await streamApi.append(
          codemodeProcessorContract.events["codemode-result-added"].createInput({
            payload: { result: event.payload.script },
          }),
        );

        await streamApi.append(
          agentProcessorContract.events["agent-input-added"].createInput({
            payload: { role: "user", content: "allowed" },
          }),
        );

        await streamApi.append(
          streamProcessorContract.events["processor-registered"].createInput({
            payload: { processorSlug: "codemode", version: "1.0.0" },
          }),
        );

        await streamApi.append(
          // @ts-expect-error codemode-block-added is consumed but not emitted.
          codemodeProcessorContract.events["codemode-block-added"].createInput({
            payload: { script: "not allowed" },
          }),
        );
      },
    });
  });

  it("rejects raw append inputs outside declared emitted events", () => {
    implementProcessor(codemodeProcessorContract, {
      onEvent: async ({ streamApi }) => {
        await streamApi.append({
          type: "codemode-result-added",
          payload: { result: "ok" },
        });

        await streamApi.append({
          type: "codemode-result-added",
          // @ts-expect-error payload must match the emitted event schema.
          payload: { wrong: "shape" },
        });

        await streamApi.append({
          // @ts-expect-error unknown events cannot be appended.
          type: "unknown-event",
          payload: { result: "nope" },
        });
      },
    });
  });

  it("does not expose resolvable events unless they are listed in consumes or emits", () => {
    const selectiveContract = defineProcessorContract({
      slug: "selective",
      version: "1.0.0",
      description: "Only consumes and emits a subset of resolvable events.",
      state: z.object({}).default({}),
      processorDeps: [agentProcessorContract, codemodeProcessorContract],
      events: {
        ...createEvent({
          type: "selective-owned",
          payloadSchema: z.object({ owned: z.boolean() }),
        }),
      },
      consumes: ["agent-input-added"],
      emits: ["selective-owned"],
      reducer: ({ state }) => state,
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
      onEvent: async ({ event, streamApi }) => {
        expectTypeOf(event.type).toEqualTypeOf<"agent-input-added">();

        await streamApi.append(
          selectiveContract.events["selective-owned"].createInput({
            payload: { owned: true },
          }),
        );

        await streamApi.append(
          // @ts-expect-error agent-input-added is resolvable but not emitted.
          agentProcessorContract.events["agent-input-added"].createInput({
            payload: { role: "user", content: "not allowed" },
          }),
        );
      },
    });
  });

  it("supports imported event catalogs without a full processor contract", () => {
    type CatalogConsumed = ConsumedEvent<typeof catalogConsumerContract>;

    expectTypeOf<Extract<CatalogConsumed, { type: "catalog-event" }>["payload"]>().toEqualTypeOf<{
      value: number;
    }>();
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

  it("requires state schemas that accept undefined", () => {
    defineProcessorContract({
      slug: "valid",
      version: "1.0.0",
      description: "Valid defaultable state.",
      state: z.object({ count: z.number().default(0) }).prefault({}),
      events: {},
      consumes: [],
      emits: [],
      reducer: ({ state }) => state,
    });

    defineProcessorContract({
      slug: "invalid",
      version: "1.0.0",
      description: "Invalid state without a top-level default.",
      // @ts-expect-error processor state must parse undefined into an initial state.
      state: z.object({ count: z.number().default(0) }),
      events: {},
      consumes: [],
      emits: [],
      reducer: ({ state }) => state,
    });
  });
});
