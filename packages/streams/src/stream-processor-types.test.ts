import { describe, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  defineProcessorContract,
  type ConsumedEvent,
  type EmittedInput,
  type WildcardConsumedEvent,
} from "./shared/stream-processors.ts";
import type { StreamEvent } from "./shared/event.ts";
import { StreamProcessor } from "./stream-processor.ts";

const DependencyProcessorContract = defineProcessorContract({
  slug: "test.dependency",
  version: "0.1.0",
  description: "Dependency processor for stream processor type tests.",
  stateSchema: z.object({}),
  initialState: {},
  events: {
    "events.test/dependency/input": {
      payloadSchema: z.object({ dependencyValue: z.string() }),
    },
    "events.test/dependency/output": {
      payloadSchema: z.object({ accepted: z.boolean() }),
    },
  },
  consumes: ["events.test/dependency/input"],
  emits: ["events.test/dependency/output"],
});

const TypeInferenceProcessorContract = defineProcessorContract({
  slug: "test.type-inference",
  version: "0.1.0",
  description: "Class processor type inference test.",
  stateSchema: z.object({ count: z.number() }),
  initialState: { count: 0 },
  processorDeps: [DependencyProcessorContract],
  events: {
    "events.test/local/input": {
      payloadSchema: z.object({ localValue: z.number() }),
    },
    "events.test/local/output": {
      payloadSchema: z.object({ total: z.number() }),
    },
  },
  consumes: ["events.test/dependency/input", "events.test/local/input"],
  emits: ["events.test/dependency/output", "events.test/local/output"],
});

type TypeInferenceProcessorContract = typeof TypeInferenceProcessorContract;
type TypeInferenceProcessorState = { count: number };

class TypeInferenceProcessor extends StreamProcessor<TypeInferenceProcessorContract> {
  readonly contract = TypeInferenceProcessorContract;

  protected override reduce(
    args: Parameters<StreamProcessor<TypeInferenceProcessorContract>["reduce"]>[0],
  ) {
    expectTypeOf(args.state).toEqualTypeOf<TypeInferenceProcessorState>();

    switch (args.event.type) {
      case "events.test/dependency/input":
        expectTypeOf(args.event.payload.dependencyValue).toEqualTypeOf<string>();
        // @ts-expect-error dependency events do not have local payload fields
        args.event.payload.localValue;
        return { count: args.state.count + 1 };

      case "events.test/local/input":
        expectTypeOf(args.event.payload.localValue).toEqualTypeOf<number>();
        // @ts-expect-error local events do not have dependency payload fields
        args.event.payload.dependencyValue;
        return { count: args.state.count + args.event.payload.localValue };

      default:
        expectTypeOf(args.event).toEqualTypeOf<never>();
        return { count: args.state.count };
    }
  }

  protected override processEvent(
    args: Parameters<StreamProcessor<TypeInferenceProcessorContract>["processEvent"]>[0],
  ): void {
    expectTypeOf(args.previousState).toEqualTypeOf<TypeInferenceProcessorState>();
    expectTypeOf(args.state).toEqualTypeOf<TypeInferenceProcessorState>();

    if (args.event.type === "events.test/dependency/input") {
      expectTypeOf(args.event.payload.dependencyValue).toEqualTypeOf<string>();
      args.runInBackground(async () => undefined);
      args.blockProcessorWhile(async () => undefined);
      return;
    }

    expectTypeOf(args.event.payload.localValue).toEqualTypeOf<number>();
  }

  protected override async processEventBatch(
    args: Parameters<StreamProcessor<TypeInferenceProcessorContract>["processEventBatch"]>[0],
  ): Promise<void> {
    expectTypeOf(args.events).toEqualTypeOf<readonly StreamEvent[]>();
    expectTypeOf(args.previousState).toEqualTypeOf<TypeInferenceProcessorState>();
    expectTypeOf(args.state).toEqualTypeOf<TypeInferenceProcessorState>();
    expectTypeOf(args.streamMaxOffset).toEqualTypeOf<number>();
    for (const reducedEvent of args.reducedEvents) {
      if (reducedEvent.event.type === "events.test/local/input") {
        expectTypeOf(reducedEvent.event.payload.localValue).toEqualTypeOf<number>();
      }
    }
    await super.processEventBatch(args);
  }
}

describe("StreamProcessor class type inference", () => {
  it("infers consumed dependency events and emitted dependency inputs", () => {
    new TypeInferenceProcessor({ iterateContext: { stream: { append() {}, appendBatch() {} } } });

    expectTypeOf<TypeInferenceProcessorContract["emits"][number]>().toEqualTypeOf<
      "events.test/dependency/output" | "events.test/local/output"
    >();

    const dependencyOutput = {
      type: "events.test/dependency/output",
      payload: { accepted: true },
    } satisfies EmittedInput<TypeInferenceProcessorContract>;
    const localOutput = {
      type: "events.test/local/output",
      payload: { total: 1 },
    } satisfies EmittedInput<TypeInferenceProcessorContract>;

    const wrongType = {
      // @ts-expect-error undeclared event type is not emitted by this processor
      type: "events.test/other/output",
      payload: { accepted: true },
    } satisfies EmittedInput<TypeInferenceProcessorContract>;
    const wrongDependencyPayload = {
      type: "events.test/dependency/output",
      // @ts-expect-error dependency output payload must match the dependency contract
      payload: { total: 1 },
    } satisfies EmittedInput<TypeInferenceProcessorContract>;

    void dependencyOutput;
    void localOutput;
    void wrongType;
    void wrongDependencyPayload;
  });
});

// ---------------------------------------------------------------------------
// consumes wildcard semantics
// ---------------------------------------------------------------------------

const WildcardOnlyContract = defineProcessorContract({
  slug: "test.wildcard-only",
  version: "0.1.0",
  description: "Consumes every stream event without naming any.",
  stateSchema: z.object({}),
  initialState: {},
  events: {},
  consumes: ["*"],
  emits: [],
});

const MixedWildcardContract = defineProcessorContract({
  slug: "test.mixed-wildcard",
  version: "0.1.0",
  description: "Consumes every stream event, with typed payloads for named ones.",
  stateSchema: z.object({ seen: z.number() }),
  initialState: { seen: 0 },
  events: {
    "events.test/mixed/named": {
      payloadSchema: z.object({ reason: z.string() }),
    },
  },
  consumes: ["*", "events.test/mixed/named"],
  emits: [],
});

type MixedWildcardContract = typeof MixedWildcardContract;

class MixedWildcardProcessor extends StreamProcessor<MixedWildcardContract> {
  readonly contract = MixedWildcardContract;

  protected override reduce(args: Parameters<StreamProcessor<MixedWildcardContract>["reduce"]>[0]) {
    // Offsets and metadata are available on every member of the union.
    expectTypeOf(args.event.offset).toEqualTypeOf<number>();

    switch (args.event.type) {
      case "events.test/mixed/named":
        // Named events keep exact payload inference despite the wildcard.
        expectTypeOf(args.event.payload.reason).toEqualTypeOf<string>();
        return { seen: args.state.seen + 1 };

      default:
        // The wildcard branch is reachable (not never) with an unknown payload.
        expectTypeOf(args.event).toEqualTypeOf<WildcardConsumedEvent>();
        expectTypeOf(args.event.payload).toEqualTypeOf<unknown>();
        return args.state;
    }
  }
}

describe("consumes wildcard typing", () => {
  it("['*'] alone consumes plain StreamEvents", () => {
    expectTypeOf<ConsumedEvent<typeof WildcardOnlyContract>>().toEqualTypeOf<StreamEvent>();
  });

  it("['*', ...named] is the named union plus the wildcard member", () => {
    new MixedWildcardProcessor({ iterateContext: { stream: { append() {}, appendBatch() {} } } });

    type Consumed = ConsumedEvent<MixedWildcardContract>;
    expectTypeOf<
      Extract<Consumed, { type: "events.test/mixed/named" }>["payload"]
    >().toEqualTypeOf<{
      reason: string;
    }>();
    expectTypeOf<Extract<Consumed, { type: "*" }>>().toEqualTypeOf<WildcardConsumedEvent>();
  });

  it("named-only contracts stay exhaustive: no wildcard member sneaks in", () => {
    type Consumed = ConsumedEvent<typeof DependencyProcessorContract>;
    expectTypeOf<Extract<Consumed, { type: "*" }>>().toEqualTypeOf<never>();
    expectTypeOf<Consumed["type"]>().toEqualTypeOf<"events.test/dependency/input">();
  });
});

// ---------------------------------------------------------------------------
// contract definition guards
// ---------------------------------------------------------------------------

describe("contract definition guards", () => {
  it("rejects consumes typos and wildcard emits at the definition site", () => {
    defineProcessorContract({
      slug: "test.bad-consumes",
      version: "0.1.0",
      description: "Typo in consumes fails to compile.",
      stateSchema: z.object({}),
      initialState: {},
      events: {
        "events.test/guard/known": { payloadSchema: z.object({}) },
      },
      // @ts-expect-error unresolvable event type string in consumes
      consumes: ["events.test/guard/unknown"],
      emits: [],
    });

    defineProcessorContract({
      slug: "test.bad-emits",
      version: "0.1.0",
      description: "Wildcard emits fails to compile; emits must be named.",
      stateSchema: z.object({}),
      initialState: {},
      events: {
        "events.test/guard/known": { payloadSchema: z.object({}) },
      },
      consumes: ["events.test/guard/known"],
      // @ts-expect-error "*" is not a valid emits entry
      emits: ["*"],
    });
  });
});
