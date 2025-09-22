import { describe, expect, it, vi } from "vitest";
import { expectTypeOf } from "expect-type";
import { z } from "zod/v4";
import { AgentCore, type AgentCoreDeps, defineAgentCoreSlice } from "./agent-core.ts";
import {
  CoreTestHarness,
  createAgentCoreTest,
  setupConsoleCaptureForTest,
} from "./agent-core-test-harness.ts";

// Create minimal mock deps for type testing
// These tests are focused on compile-time type safety, not runtime behavior
function createMockDeps(): AgentCoreDeps {
  return {
    getRuleMatchData: (state) => ({ agentCoreStae: state }),
    storeEvents: () => {},
    background: () => {},
    getOpenAIClient: async () => ({}) as any,
    toolSpecsToImplementations: () => [],
    console: console,
  };
}

describe("AgentCore with ONE slice", () => {
  // Define test slice using the helper
  const TestSliceInput = z.discriminatedUnion("type", [
    z.object({
      type: z.literal("TEST:ACTION_START"),
      data: z.object({
        config: z.object({
          name: z.string().optional(),
          value: z.number().optional(),
        }),
      }),
      eventIndex: z.number().optional(),
      createdAt: z.string().optional(),
    }),
    z.object({
      type: z.literal("TEST:ACTION_END"),
      data: z.object({
        result: z.string(),
      }),
      eventIndex: z.number().optional(),
      createdAt: z.string().optional(),
    }),
  ]);

  const TestSliceOutput = z.discriminatedUnion("type", [
    z.object({
      type: z.literal("TEST:ACTION_START"),
      data: z.object({
        config: z.object({
          name: z.string().optional(),
          value: z.number().optional(),
        }),
      }),
      eventIndex: z.number(),
      createdAt: z.string(),
    }),
    z.object({
      type: z.literal("TEST:ACTION_END"),
      data: z.object({
        result: z.string(),
      }),
      eventIndex: z.number(),
      createdAt: z.string(),
    }),
  ]);

  const testSlice = defineAgentCoreSlice<{
    SliceState: { isActive: boolean };
    EventSchema: typeof TestSliceOutput;
    EventInputSchema: typeof TestSliceInput;
  }>({
    name: "testSlice",
    eventSchema: TestSliceOutput,
    eventInputSchema: TestSliceInput,
    initialState: { isActive: false },
    reduce(_state, _deps, event) {
      switch (event.type) {
        case "TEST:ACTION_START":
          return { isActive: true };
        case "TEST:ACTION_END":
          return { isActive: false };
        default:
          return {};
      }
    },
  });

  it("addEvent accepts core and slice events (single and arrays)", async () => {
    const agent = new AgentCore({ deps: createMockDeps(), slices: [testSlice] });
    await agent.initializeWithEvents([]);

    // INVALID: Single events - still no primitives
    // @ts-expect-error - string not allowed
    expect(() => agent.addEvent("string")).toThrow();
    // @ts-expect-error - boolean not allowed
    expect(() => agent.addEvent(true)).toThrow();
    // @ts-expect-error - number not allowed
    expect(() => agent.addEvent(42)).toThrow();

    // INVALID: Single events - wrong event types
    // @ts-expect-error - invalid event type
    expect(() => agent.addEvent({ type: "MADE_UP:EVENT" })).toThrow();
    // @ts-expect-error - missing required data
    expect(() => agent.addEvent({ type: "TEST:ACTION_END" })).toThrow();
    expect(() =>
      agent.addEvent({
        type: "TEST:ACTION_START",
        // @ts-expect-error - wrong data
        data: { result: "wrong" }, // This is ACTION_END data
      }),
    ).toThrow();

    // VALID: Single events
    await agent.addEvent({ type: "CORE:PAUSE_LLM_REQUESTS" });
    await agent.addEvent({
      type: "TEST:ACTION_START",
      data: { config: {} },
    });
    await agent.addEvent({
      type: "TEST:ACTION_END",
      data: { result: "done" },
    });

    // @ts-expect-error - array with bad events
    expect(() => agent.addEvents(["not", "events", 123])).toThrow();
    expect(() =>
      agent.addEvents([
        { type: "TEST:ACTION_START", data: { config: {} } },
        // @ts-expect-error - wrong data
        { type: "BOGUS:EVENT" },
      ]),
    ).toThrow();
    expect(() =>
      agent.addEvents([
        { type: "CORE:PAUSE_LLM_REQUESTS" },
        // @ts-expect-error - missing data
        { type: "TEST:ACTION_END" },
      ]),
    ).toThrow();

    // VALID: Arrays of mixed events
    await agent.addEvents([
      { type: "CORE:LLM_REQUEST_START", data: {} },
      { type: "TEST:ACTION_START", data: { config: { name: "test" } } },
      { type: "CORE:LLM_REQUEST_END", data: { rawResponse: {} } },
      { type: "TEST:ACTION_END", data: { result: "complete" } },
    ]);
  });
});

describe("AgentCore with TWO slices", () => {
  // First slice - simple object schema
  const Slice1Input = z.object({
    type: z.literal("SLICE1:ACTION"),
    data: z.object({ value: z.number() }),
    eventIndex: z.number().optional(),
    createdAt: z.string().optional(),
  });

  const Slice1Output = z.object({
    type: z.literal("SLICE1:ACTION"),
    data: z.object({ value: z.number() }),
    eventIndex: z.number(),
    createdAt: z.string(),
  });

  const slice1 = defineAgentCoreSlice<{
    SliceState: { count: number };
    EventSchema: typeof Slice1Output;
    EventInputSchema: typeof Slice1Input;
  }>({
    name: "slice1",
    eventSchema: Slice1Output,
    eventInputSchema: Slice1Input,
    initialState: { count: 0 },
    reduce(state, _deps, event) {
      if (event.type === "SLICE1:ACTION") {
        return { count: state.count + (event as any).data.value };
      }
      return {};
    },
  });

  // Second slice - discriminated union
  const Slice2Input = z.discriminatedUnion("type", [
    z.object({
      type: z.literal("SLICE2:START"),
      data: z.object({ name: z.string() }),
      eventIndex: z.number().optional(),
      createdAt: z.string().optional(),
    }),
    z.object({
      type: z.literal("SLICE2:END"),
      data: z.object({ success: z.boolean() }),
      eventIndex: z.number().optional(),
      createdAt: z.string().optional(),
    }),
  ]);

  const Slice2Output = z.discriminatedUnion("type", [
    z.object({
      type: z.literal("SLICE2:START"),
      data: z.object({ name: z.string() }),
      eventIndex: z.number(),
      createdAt: z.string(),
    }),
    z.object({
      type: z.literal("SLICE2:END"),
      data: z.object({ success: z.boolean() }),
      eventIndex: z.number(),
      createdAt: z.string(),
    }),
  ]);

  const slice2 = defineAgentCoreSlice<{
    SliceState: { status: string };
    EventSchema: typeof Slice2Output;
    EventInputSchema: typeof Slice2Input;
  }>({
    name: "slice2",
    eventSchema: Slice2Output,
    eventInputSchema: Slice2Input,
    initialState: { status: "idle" },
    reduce(_state, _deps, event) {
      switch (event.type) {
        case "SLICE2:START":
          return { status: "running" };
        case "SLICE2:END":
          return { status: (event as any).data.success ? "success" : "failed" };
        default:
          return {};
      }
    },
  });

  it("addEvent accepts core and both slice events (single and arrays)", async () => {
    const agent = new AgentCore({ deps: createMockDeps(), slices: [slice1, slice2] });
    await agent.initializeWithEvents([]);

    // INVALID: Single events - primitives
    // @ts-expect-error - string not allowed
    expect(() => agent.addEvent("not an event")).toThrow();
    // @ts-expect-error - number not allowed
    expect(() => agent.addEvent(123)).toThrow();

    // INVALID: Single events - wrong types
    // @ts-expect-error - made up event
    expect(() => agent.addEvent({ type: "UNKNOWN:EVENT" })).toThrow();
    // @ts-expect-error - missing data
    expect(() => agent.addEvent({ type: "SLICE2:END" })).toThrow();
    expect(() =>
      agent.addEvent({
        type: "SLICE1:ACTION",
        // @ts-expect-error - wrong data
        data: { success: true }, // SLICE2:END data
      }),
    ).toThrow();

    // VALID: Single events from all sources
    await agent.addEvent({ type: "CORE:PAUSE_LLM_REQUESTS" });
    await agent.addEvent({ type: "SLICE1:ACTION", data: { value: 100 } });
    await agent.addEvent({ type: "SLICE2:START", data: { name: "process" } });
    await agent.addEvent({ type: "SLICE2:END", data: { success: false } });

    // INVALID: Arrays with bad events
    expect(() => agent.addEvents(["string", 42, null] as any)).toThrow();
    expect(() =>
      agent.addEvents([
        { type: "SLICE1:ACTION", data: { value: 1 } },
        { type: "FAKE:TYPE" },
      ] as any),
    ).toThrow();
    expect(() =>
      agent.addEvents([
        { type: "SLICE2:START", data: { value: 99 } }, // wrong data
        { type: "SLICE1:ACTION", data: { name: "bad" } }, // wrong data
      ] as any),
    ).toThrow();

    // VALID: Arrays mixing all event types
    await agent.addEvents([
      { type: "CORE:LLM_REQUEST_START" },
      { type: "SLICE1:ACTION", data: { value: 1 } },
      { type: "SLICE2:START", data: { name: "begin" } },
      { type: "CORE:PAUSE_LLM_REQUESTS" },
      { type: "SLICE2:END", data: { success: true } },
      { type: "CORE:RESUME_LLM_REQUESTS" },
    ]);
  });
});

describe("with slice dependencies", () => {
  it("allows a slice to access state and deps from a dependent slice", async () => {
    // 1. Define parent slice with its own state, deps, and events
    const ParentSliceEventInput = z.object({
      type: z.literal("PARENT:SET_NAME"),
      data: z.object({ name: z.string() }),
      eventIndex: z.number().optional(),
      createdAt: z.string().optional(),
    });

    const ParentSliceEventOutput = z.object({
      type: z.literal("PARENT:SET_NAME"),
      data: z.object({ name: z.string() }),
      eventIndex: z.number(),
      createdAt: z.string(),
    });

    interface ParentSliceDeps {
      getParentName(): string;
    }

    const parentSlice = defineAgentCoreSlice<{
      SliceState: { parentName: string };
      EventSchema: typeof ParentSliceEventOutput;
      EventInputSchema: typeof ParentSliceEventInput;
      SliceDeps: ParentSliceDeps;
    }>({
      name: "parentSlice",
      eventSchema: ParentSliceEventOutput,
      eventInputSchema: ParentSliceEventInput,
      initialState: { parentName: "initial" },
      reduce(_state, _deps, event) {
        if (event.type === "PARENT:SET_NAME") {
          return { parentName: (event as any).data.name };
        }
        return {};
      },
    });

    // 2. Define child slice that depends on parent slice
    const ChildSliceEventInput = z.object({
      type: z.literal("CHILD:GET_PARENT_NAME"),
      data: z.object({}),
      eventIndex: z.number().optional(),
      createdAt: z.string().optional(),
    });

    const ChildSliceEventOutput = z.object({
      type: z.literal("CHILD:GET_PARENT_NAME"),
      data: z.object({}),
      eventIndex: z.number(),
      createdAt: z.string(),
    });

    const childSlice = defineAgentCoreSlice<{
      SliceState: { childStatus: string };
      EventSchema: typeof ChildSliceEventOutput;
      EventInputSchema: typeof ChildSliceEventInput;
      DependsOnSlices: [typeof parentSlice];
    }>({
      name: "childSlice",
      dependencies: [parentSlice],
      eventSchema: ChildSliceEventOutput,
      eventInputSchema: ChildSliceEventInput,
      initialState: { childStatus: "idle" },
      reduce(state, deps, event) {
        if (event.type === "CHILD:GET_PARENT_NAME") {
          // Access parent state and deps
          const parentNameFromState = state.parentName; // Should be typed!
          const parentNameFromDep = deps.getParentName(); // Should be typed!

          // For the test, we can just check they exist
          expect(parentNameFromState).toBeDefined();
          expect(parentNameFromDep).toBeDefined();

          return { childStatus: `Accessed parent: ${parentNameFromState}` };
        }
        return {};
      },
    });

    // 3. Setup AgentCore with both slices and the required deps
    const mockGetParentName = vi.fn().mockReturnValue("dep name");

    const depsForAgent = {
      ...createMockDeps(),
      getParentName: mockGetParentName,
    } satisfies AgentCoreDeps & ParentSliceDeps;

    const agent = new AgentCore({
      slices: [parentSlice, childSlice] as const,
      deps: depsForAgent,
    });
    await agent.initializeWithEvents([]);

    // 4. Run events and assert
    await agent.addEvent({ type: "PARENT:SET_NAME", data: { name: "test parent" } });
    expect(agent.state.parentName).toBe("test parent");

    await agent.addEvent({ type: "CHILD:GET_PARENT_NAME", data: {} });
    expect(agent.state.childStatus).toBe("Accessed parent: test parent");
    expect(mockGetParentName).toHaveBeenCalled();
  });
});

describe("Slice-specific tests", () => {
  describe("Input vs Output schema typing", () => {
    it("properly handles optional fields with separate input/output schemas", async () => {
      // Define output schema with required fields
      const SliceOutput = z.object({
        type: z.literal("TEST:EVENT"),
        data: z.object({ value: z.string() }),
        createdAt: z.string(),
        eventIndex: z.number(),
      });

      // Define input schema with optional fields
      const SliceInput = z.object({
        type: z.literal("TEST:EVENT"),
        data: z.object({ value: z.string() }),
        createdAt: z.string().optional(),
        eventIndex: z.number().optional(),
      });

      const testSlice = defineAgentCoreSlice<{
        EventSchema: typeof SliceOutput;
        EventInputSchema: typeof SliceInput;
      }>({
        name: "testSlice",
        eventSchema: SliceOutput,
        eventInputSchema: SliceInput,
        reduce: () => {},
      });

      const agent = new AgentCore({ deps: createMockDeps(), slices: [testSlice] });
      await agent.initializeWithEvents([]);

      // Add an event without createdAt/eventIndex (should work now!)
      await agent.addEvent({
        type: "TEST:EVENT",
        data: { value: "hello" },
      });

      // Get the events back
      const events = agent.events;
      const lastEvent = events[events.length - 1];

      // In reality, createdAt and eventIndex are ALWAYS present in stored events
      if (lastEvent.type === "TEST:EVENT") {
        // These assertions pass at runtime
        expect(lastEvent.createdAt).toBeDefined();
        expect(lastEvent.eventIndex).toBeDefined();

        // Now TypeScript correctly knows these are non-optional!
        expectTypeOf(lastEvent.createdAt).toEqualTypeOf<string>();
        expectTypeOf(lastEvent.eventIndex).toEqualTypeOf<number>();
      }
    });
  });

  describe("Slice agentCore access", () => {
    createAgentCoreTest([])(
      "provides agentCore reference to all slices automatically",
      async ({ h: _h }) => {
        let capturedDeps: any = null;
        let capturedAgentCore: any = null;

        const TestSliceOutput = z.discriminatedUnion("type", [
          z.object({
            type: z.literal("TEST:CHECK_DEPS"),
            data: z.object({}).default({}),
            eventIndex: z.number(),
            createdAt: z.string(),
          }),
        ]);

        const TestSliceInput = z.discriminatedUnion("type", [
          z.object({
            type: z.literal("TEST:CHECK_DEPS"),
            data: z.object({}).default({}),
            eventIndex: z.number().optional(),
            createdAt: z.string().optional(),
          }),
        ]);

        const testSlice = defineAgentCoreSlice<{
          SliceState: { hasAgentCore: boolean };
          EventSchema: typeof TestSliceOutput;
          EventInputSchema: typeof TestSliceInput;
        }>({
          name: "testSlice",
          eventSchema: TestSliceOutput,
          eventInputSchema: TestSliceInput,
          initialState: { hasAgentCore: false },
          reduce(_state, deps, event) {
            if (event.type === "TEST:CHECK_DEPS") {
              capturedDeps = deps;
              capturedAgentCore = deps.agentCore;
              return { hasAgentCore: !!deps.agentCore };
            }
            return {};
          },
        });

        // Create harness with the test slice
        const testHarness = CoreTestHarness.create({ slices: [testSlice] });
        testHarness.begin("2024-01-01T00:00:00.000Z");

        await testHarness.initializeAgent();

        await testHarness.agentCore.addEvent({
          type: "TEST:CHECK_DEPS",
        });

        // Verify that agentCore was available in deps
        expect(capturedDeps).toBeTruthy();
        expect(capturedAgentCore).toBeTruthy();
        expect(capturedAgentCore).toBe(testHarness.agentCore);

        // Verify the slice state was updated
        expect((testHarness.agentCore.state as any).hasAgentCore).toBe(true);

        testHarness.end();
      },
    );
  });

  describe("Error handling", () => {
    createAgentCoreTest([])(
      "creates internal error event when slice reducer fails",
      async ({ h: _h }) => {
        // Create a failing slice
        const FailingSliceOutput = z.discriminatedUnion("type", [
          z.object({
            type: z.literal("FAILING:TEST"),
            data: z.object({ shouldFail: z.boolean() }),
            eventIndex: z.number(),
            createdAt: z.string(),
          }),
        ]);

        const FailingSliceInput = z.discriminatedUnion("type", [
          z.object({
            type: z.literal("FAILING:TEST"),
            data: z.object({ shouldFail: z.boolean() }),
            eventIndex: z.number().optional(),
            createdAt: z.string().optional(),
          }),
        ]);

        const failingSlice = defineAgentCoreSlice<{
          SliceState: { isOk: boolean };
          EventSchema: typeof FailingSliceOutput;
          EventInputSchema: typeof FailingSliceInput;
        }>({
          name: "failingSlice",
          eventSchema: FailingSliceOutput,
          eventInputSchema: FailingSliceInput,
          initialState: { isOk: true },
          reduce: (_state, _deps, event) => {
            if (event.type === "FAILING:TEST" && event.data?.shouldFail) {
              throw new Error("Slice reducer intentionally failed");
            }
            // Return partial update for slice state
            return { isOk: true };
          },
        });

        // Setup console capture for this test
        const consoleCapture = setupConsoleCaptureForTest();
        const h = CoreTestHarness.create({
          slices: [failingSlice],
          console: consoleCapture.console,
        });
        h.begin("2024-01-01T00:00:00.000Z");
        await h.initializeAgent();

        // Get initial state
        const initialEventCount = h.getEvents().length;
        const initialIsOk = (h.agentCore.state as any).isOk;

        // Try to add an event that will cause the slice reducer to fail
        expect(() =>
          h.agentCore.addEvent({
            type: "FAILING:TEST",
            data: { shouldFail: true },
          }),
        ).toThrow("Slice reducer intentionally failed");

        // Check that slice state was rolled back
        expect((h.agentCore.state as any).isOk).toEqual(initialIsOk);

        // Should have exactly one more event than before (the INTERNAL_ERROR)
        expect(h.getEvents().length).toBe(initialEventCount + 1);

        // Verify the INTERNAL_ERROR event was added
        const errorEvents = h.getEvents().filter((e) => e.type === "CORE:INTERNAL_ERROR");
        expect(errorEvents).toHaveLength(1);
        expect(errorEvents[0].data.error).toContain("Error while calling addEvents");
        expect(errorEvents[0].data.error).toContain("Slice reducer intentionally failed");
        expect(errorEvents[0].data.error).toContain("Events batch:");
        expect(errorEvents[0].data.stack).toBeDefined();

        // Verify that a non-failing event works fine
        await h.agentCore.addEvent({
          type: "FAILING:TEST",
          data: { shouldFail: false },
        });

        // This time it should have been added
        const eventsAfter = h.getEvents();
        const nonFailingEvents = eventsAfter.filter(
          (e: any) => e.type === "FAILING:TEST" && !e.data?.shouldFail,
        );
        expect(nonFailingEvents.length).toBe(1);

        h.end();
      },
    );
  });
});
