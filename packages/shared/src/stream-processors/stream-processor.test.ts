import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createEvent,
  defineProcessorContract,
  validateProcessorContract,
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
  reducer: ({ state }) => state,
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
      reducer: ({ state }) => state,
    });

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
      reducer: ({ state }) => state,
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
      reducer: ({ state }) => state,
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
      reducer: ({ state }) => state,
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
      reducer: ({ state }) => state,
    });

    expect(() => validateProcessorContract(contract)).not.toThrow();
  });
});
