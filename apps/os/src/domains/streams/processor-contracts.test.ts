import { z } from "zod";
import { describe, expect, expectTypeOf, test } from "vitest";
import {
  defineProcessorContract,
  mergeProcessorConfig,
  type ConsumedInput,
  type StreamEventInput,
} from "iterate/processors";

describe("mergeProcessorConfig", () => {
  test("recurses through plain objects and retains omitted keys", () => {
    expect(
      mergeProcessorConfig(
        {
          feature: { enabled: true, limits: { daily: 10, monthly: 100 } },
          retained: "yes",
        },
        { feature: { limits: { daily: 20 } } },
      ),
    ).toEqual({
      feature: { enabled: true, limits: { daily: 20, monthly: 100 } },
      retained: "yes",
    });
  });

  test("replaces arrays, scalars, and null wholesale", () => {
    expect(
      mergeProcessorConfig(
        { array: [1, 2], nullable: { nested: true }, scalar: "before" },
        { array: [3], nullable: null, scalar: "after" },
      ),
    ).toEqual({ array: [3], nullable: null, scalar: "after" });
  });
});

const AppendDoorContract = defineProcessorContract({
  slug: "append-door-test",
  version: "1.0.0",
  description: "Exercises the processor-derived domain append boundary.",
  stateSchema: z.object({}),
  events: {
    "events.iterate.com/test/appendable-input": {
      payloadSchema: z.object({ value: z.string().transform(Number) }),
    },
    "events.iterate.com/test/resolved-but-unconsumed": {
      payloadSchema: z.object({ value: z.string() }),
    },
  },
  consumes: ["events.iterate.com/test/appendable-input"],
  emits: [],
});

const ParserInferenceContract = defineProcessorContract({
  slug: "parser-inference-test",
  version: "1.0.0",
  description: "Exercises discriminator inference and parsed output types.",
  stateSchema: z.object({}),
  events: {
    "events.iterate.com/test/number": {
      payloadSchema: z.object({ value: z.string().transform(Number) }),
    },
    "events.iterate.com/test/length": {
      payloadSchema: z.object({ value: z.string().transform((value) => value.length) }),
    },
    "events.iterate.com/test/transient": {
      ephemeral: true,
      payloadSchema: z.object({ value: z.string() }),
    },
  },
  consumes: ["events.iterate.com/test/number", "events.iterate.com/test/length"],
  emits: ["events.iterate.com/test/number", "events.iterate.com/test/transient"],
});

describe("processor-derived append inputs", () => {
  test("derive required durable inputs from consumes and parse their payload output", () => {
    type Input = ConsumedInput<typeof AppendDoorContract>;

    expectTypeOf<Input>().toMatchTypeOf<{
      type: "events.iterate.com/test/appendable-input";
      payload: { value: string };
      ephemeral?: never;
    }>();
    expectTypeOf<{
      type: "events.iterate.com/test/appendable-input";
    }>().not.toMatchTypeOf<Input>();
    expectTypeOf<{
      type: "events.iterate.com/test/appendable-input";
      payload: { value: string };
      ephemeral: true;
    }>().not.toMatchTypeOf<Input>();

    const parsed = AppendDoorContract.parseConsumedInput({
      type: "events.iterate.com/test/appendable-input",
      payload: { value: "42" },
    });
    expectTypeOf(parsed.payload.value).toEqualTypeOf<number>();
    expect(parsed.payload.value).toBe(42);
  });

  test("rejects resolved-but-unconsumed and ephemeral events at runtime", () => {
    const parseRemoteInput = AppendDoorContract.parseConsumedInput as (
      event: StreamEventInput,
    ) => unknown;

    expect(() =>
      parseRemoteInput({
        type: "events.iterate.com/test/resolved-but-unconsumed",
        payload: { value: "no" },
      }),
    ).toThrow(
      'Processor "append-door-test" does not consume event "events.iterate.com/test/resolved-but-unconsumed".',
    );
    expect(() =>
      parseRemoteInput({
        type: "events.iterate.com/test/appendable-input",
        payload: { value: "no" },
        ephemeral: true,
      }),
    ).toThrow(
      'Processor "append-door-test" cannot consume ephemeral event "events.iterate.com/test/appendable-input".',
    );
  });
});

describe("contract event helpers", () => {
  test("infer parsed output from the event discriminator", () => {
    const built = ParserInferenceContract.buildEvent({
      type: "events.iterate.com/test/number",
      payload: { value: "42" },
    });
    expectTypeOf(built.payload.value).toEqualTypeOf<number>();
    expect(built.payload.value).toBe(42);

    const parsedInput = ParserInferenceContract.parseEventInput({
      type: "events.iterate.com/test/length",
      payload: { value: "four" },
    });
    expectTypeOf(parsedInput.payload.value).toEqualTypeOf<number>();
    expect(parsedInput.payload.value).toBe(4);

    const parsedEvent = ParserInferenceContract.parseEvent({
      type: "events.iterate.com/test/number",
      payload: { value: "7" },
      offset: 1,
      createdAt: new Date(0).toISOString(),
      path: "/tests/parser-inference",
    });
    expectTypeOf(parsedEvent.payload.value).toEqualTypeOf<number>();
    expect(parsedEvent.payload.value).toBe(7);

    const consumed = ParserInferenceContract.parseConsumedInput({
      type: "events.iterate.com/test/length",
      payload: { value: "three" },
    });
    expectTypeOf(consumed.type).toEqualTypeOf<"events.iterate.com/test/length">();
    expectTypeOf(consumed.payload.value).toEqualTypeOf<number>();
    expect(consumed.payload.value).toBe(5);
  });

  test("returns a discriminated union for broadly typed input", () => {
    const input: StreamEventInput = {
      type: "events.iterate.com/test/number",
      payload: { value: "42" },
    };
    const parsed = ParserInferenceContract.parseEventInput(input);

    if (parsed.type === "events.iterate.com/test/number") {
      expectTypeOf(parsed.payload.value).toEqualTypeOf<number>();
      expect(parsed.payload.value).toBe(42);
    } else {
      throw new Error(`unexpected parsed event type: ${parsed.type}`);
    }
  });

  test("reflects forced ephemeral defaults in parsed output types", () => {
    const built = ParserInferenceContract.buildEvent({
      type: "events.iterate.com/test/transient",
      payload: { value: "temporary" },
    });
    expectTypeOf(built.ephemeral).toEqualTypeOf<true>();
    expect(built.ephemeral).toBe(true);
  });
});
