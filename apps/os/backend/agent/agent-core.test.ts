import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { pluckFields } from "../utils/test-helpers/test-utils.ts";
import { AgentCore } from "./agent-core.ts";
import { f } from "./prompt-fragments.ts";
import {
  CoreTestHarness,
  createAgentCoreTest,
  makeFunctionCallChunk,
  makeResponseChunks,
  makeResponseCreatedChunk,
  makeUserInputTextEvent,
  setupConsoleCaptureForTest,
} from "./agent-core-test-harness.ts";
import type { ContextItem } from "./context-schemas.ts";

describe("AgentCore", () => {
  createAgentCoreTest([])("handles a simple user message and assistant response", async ({ h }) => {
    await h.initializeAgent();

    const stream = h.enqueueMockOpenAIStream();
    // Test invalid event handling separately
    await h.agentCore.addEvent(makeUserInputTextEvent("Hello"));
    await h.waitUntilThinking();
    stream.streamChunks(makeResponseChunks("Hello! How can I help you?"));
    stream.complete();
    await h.waitUntilNotThinking();
  });

  createAgentCoreTest([])("merges metadata", async ({ h }) => {
    await h.initializeAgent();

    await h.agentCore.addEvent({ type: "CORE:SET_METADATA", data: { foo: { bar: 1 } } });
    await h.agentCore.addEvent({ type: "CORE:SET_METADATA", data: { foo: { baz: 2 } } });

    expect(h.agentCore.state.metadata).toEqual({ foo: { bar: 1, baz: 2 } });
  });

  createAgentCoreTest([])("adds labels to metadata", async ({ h }) => {
    await h.initializeAgent();

    await h.agentCore.addEvent({ type: "CORE:ADD_LABEL", data: { label: "GMAIL" } });
    await h.agentCore.addEvent({ type: "CORE:ADD_LABEL", data: { label: "GCALENDAR" } });

    expect(h.agentCore.state.metadata.labels).toEqual(["GMAIL", "GCALENDAR"]);
  });

  createAgentCoreTest([])("does not add duplicate labels", async ({ h }) => {
    await h.initializeAgent();

    await h.agentCore.addEvent({ type: "CORE:ADD_LABEL", data: { label: "GMAIL" } });
    await h.agentCore.addEvent({ type: "CORE:ADD_LABEL", data: { label: "GMAIL" } });

    expect(h.agentCore.state.metadata.labels).toEqual(["GMAIL"]);
  });

  createAgentCoreTest([])(
    "executes function tools and creates function call events",
    async ({ h }) => {
      // Initialize the agent
      await h.initializeAgent();

      // Register a mock tool
      h.registerMockTool("calculate", async (_call, args) => {
        return {
          toolCallResult: {
            result: (args as { a: number; b: number }).a + (args as { a: number; b: number }).b,
          },
        };
      });

      // Add the tool spec to the agent
      h.agentCore.addEvent({
        type: "CORE:ADD_CONTEXT_RULES",
        data: {
          rules: [
            {
              key: "test-rule",
              tools: [
                {
                  type: "agent_durable_object_tool",
                  methodName: "calculate",
                },
              ],
            },
          ],
        },
      });

      // Setup OpenAI mock response with function call
      const stream1 = h.enqueueMockOpenAIStream();
      stream1.streamChunks([
        makeResponseCreatedChunk("resp_1"),
        makeFunctionCallChunk("calculate", { a: 2, b: 3 }),
        { type: "response.completed" },
      ]);
      stream1.complete();

      // Setup second response after function execution
      const stream2 = h.enqueueMockOpenAIStream();
      stream2.streamChunks(makeResponseChunks("The result is 5."));
      stream2.complete();

      // Send user message
      await h.agentCore.addEvent(makeUserInputTextEvent("What is 2 + 3?"));

      // Wait for processing
      await h.waitUntilThinking();
      await h.waitUntilNotThinking();

      // Check events
      const events = h.getEvents();

      expect(
        pluckFields(events, [
          "type",
          "data.content[0].text",
          "data.call.name",
          "data.result.success",
          "data.result.output.result",
        ]),
      ).toMatchInlineSnapshot(`
        "["CORE:INITIALIZED_WITH_EVENTS",null,null,null,null]
        ["CORE:SET_SYSTEM_PROMPT",null,null,null,null]
        ["CORE:SET_MODEL_OPTS",null,null,null,null]
        ["CORE:ADD_CONTEXT_RULES",null,null,null,null]
        ["CORE:LLM_INPUT_ITEM",null,null,null,null]
        ["CORE:LLM_REQUEST_START",null,null,null,null]
        ["CORE:LOCAL_FUNCTION_TOOL_CALL",null,"calculate",true,5]
        ["CORE:LLM_REQUEST_END",null,null,null,null]
        ["CORE:LLM_REQUEST_START",null,null,null,null]
        ["CORE:LLM_OUTPUT_ITEM",null,null,null,null]
        ["CORE:LLM_REQUEST_END",null,null,null,null]"
      `);
    },
  );

  createAgentCoreTest([])("handles tool execution failures gracefully", async ({ h }) => {
    // Initialize the agent
    await h.initializeAgent();

    // Register a failing tool
    h.registerMockTool("failing_tool", async () => {
      throw new Error("Tool execution failed");
    });

    // Add the tool spec to the agent
    await h.agentCore.addEvent({
      type: "CORE:ADD_CONTEXT_RULES",
      data: {
        rules: [
          {
            key: "test-rule",
            tools: [
              {
                type: "agent_durable_object_tool",
                methodName: "failing_tool",
              },
            ],
          },
        ],
      },
    });

    // Setup OpenAI mock response with function call
    const stream1 = h.enqueueMockOpenAIStream();
    stream1.streamChunks([
      makeResponseCreatedChunk("resp_1"),
      makeFunctionCallChunk("failing_tool", {}),
      { type: "response.completed" },
    ]);
    stream1.complete();

    // Setup second response after function failure
    const stream2 = h.enqueueMockOpenAIStream();
    stream2.streamChunks(makeResponseChunks("I apologize, but the tool failed."));
    stream2.complete();

    // Send user message
    await h.agentCore.addEvent(makeUserInputTextEvent("Try the failing tool"));

    // Wait for processing
    await h.waitUntilThinking();
    await h.waitUntilNotThinking();

    // Check that function call error was handled
    const events = h.getEvents();
    const functionCallEvents = events.filter((e) => e.type === "CORE:LOCAL_FUNCTION_TOOL_CALL");
    const plucked = pluckFields(functionCallEvents, ["data.result.success", "data.result.error"]);
    expect(plucked).toContain('[false,"');
    expect(plucked).toMatch(
      /^(\[)?\[false,"Error in tool failing_tool: Tool execution failed\\nError: Tool execution failed\\n\s+at /,
    );
  });

  createAgentCoreTest([])("handles multiple function tool calls in sequence", async ({ h }) => {
    // Initialize the agent
    await h.initializeAgent();

    // Register multiple mock tools
    h.registerMockTool("get_weather", async (_call, args) => {
      const city = (args as { city: string }).city;
      return {
        toolCallResult: {
          city,
          temperature: 22,
          conditions: "sunny",
        },
      };
    });

    h.registerMockTool("get_activity_suggestion", async (_call, args) => {
      const weather = (args as { weather: string }).weather;
      if (weather === "sunny") {
        return {
          toolCallResult: {
            activity: "Go for a picnic in the park",
          },
        };
      }
      return {
        toolCallResult: {
          activity: "Visit a museum",
        },
      };
    });

    // Add the tool specs to the agent
    await h.agentCore.addEvent({
      type: "CORE:ADD_CONTEXT_RULES",
      data: {
        rules: [
          {
            key: "test-rule",
            tools: [
              {
                type: "agent_durable_object_tool",
                methodName: "get_weather",
              },
              {
                type: "agent_durable_object_tool",
                methodName: "get_activity_suggestion",
              },
            ],
          },
        ],
      },
    });

    // Setup OpenAI mock response with first function call (get weather)
    const stream1 = h.enqueueMockOpenAIStream();
    stream1.streamChunks([
      makeResponseCreatedChunk("resp_1"),
      makeFunctionCallChunk("get_weather", { city: "San Francisco" }),
      { type: "response.completed" },
    ]);
    stream1.complete();

    // Setup second response with another function call (get activity suggestion)
    const stream2 = h.enqueueMockOpenAIStream();
    stream2.streamChunks([
      makeResponseCreatedChunk("resp_2"),
      makeFunctionCallChunk("get_activity_suggestion", { weather: "sunny" }),
      { type: "response.completed" },
    ]);
    stream2.complete();

    // Setup final response with the complete answer
    const stream3 = h.enqueueMockOpenAIStream();
    stream3.streamChunks(
      makeResponseChunks(
        "The weather in San Francisco is sunny with 22°C. I suggest you go for a picnic in the park!",
      ),
    );
    stream3.complete();

    // Send user message
    await h.agentCore.addEvent(
      makeUserInputTextEvent("What's the weather in San Francisco and what should I do today?"),
    );

    // Wait for all processing to complete
    await h.waitUntilThinking();
    await h.waitUntilNotThinking();

    // Check events
    const events = h.getEvents();

    // Find all function call events
    const functionCallEvents = events.filter((e) => e.type === "CORE:LOCAL_FUNCTION_TOOL_CALL");
    expect(functionCallEvents).toHaveLength(2);

    expect(
      pluckFields(functionCallEvents, [
        "data.call.name",
        "data.result.success",
        "data.result.output.city",
        "data.result.output.temperature",
        "data.result.output.activity",
      ]),
    ).toMatchInlineSnapshot(`
      "["get_weather",true,"San Francisco",22,null]
      ["get_activity_suggestion",true,null,null,"Go for a picnic in the park"]"
    `);

    // Verify the final response
    const outputEvents = events.filter((e) => e.type === "CORE:LLM_OUTPUT_ITEM");
    expect(pluckFields(outputEvents, ["data.content[0].text"])).toMatchInlineSnapshot(`"[null]"`);
  });

  createAgentCoreTest([])("handles function tools without arguments", async ({ h }) => {
    // Initialize the agent
    await h.initializeAgent();

    // Register a mock tool that doesn't require arguments
    h.registerMockTool("get_current_time", async () => {
      return {
        toolCallResult: {
          time: "2024-01-01T12:00:00Z",
          timezone: "UTC",
        },
      };
    });

    // Add the tool spec to the agent
    await h.agentCore.addEvent({
      type: "CORE:ADD_CONTEXT_RULES",
      data: {
        rules: [
          {
            key: "test-rule",
            tools: [
              {
                type: "agent_durable_object_tool",
                methodName: "get_current_time",
              },
            ],
          },
        ],
      },
    });

    // Setup OpenAI mock response with function call (no arguments)
    const stream1 = h.enqueueMockOpenAIStream();
    stream1.streamChunks([
      makeResponseCreatedChunk("resp_1"),
      makeFunctionCallChunk("get_current_time", {}),
      { type: "response.completed" },
    ]);
    stream1.complete();

    // Setup second response after function execution
    const stream2 = h.enqueueMockOpenAIStream();
    stream2.streamChunks(
      makeResponseChunks("The current time is 12:00 PM UTC on January 1st, 2024."),
    );
    stream2.complete();

    // Send user message
    await h.agentCore.addEvent(makeUserInputTextEvent("What time is it?"));

    // Wait for processing
    await h.waitUntilThinking();
    await h.waitUntilNotThinking();

    // Check events
    const events = h.getEvents();

    expect(
      pluckFields(events, [
        "type",
        "data.call.name",
        "data.result.output.time",
        "data.content[0].text",
      ]),
    ).toMatchInlineSnapshot(`
      "["CORE:INITIALIZED_WITH_EVENTS",null,null,null]
      ["CORE:SET_SYSTEM_PROMPT",null,null,null]
      ["CORE:SET_MODEL_OPTS",null,null,null]
      ["CORE:ADD_CONTEXT_RULES",null,null,null]
      ["CORE:LLM_INPUT_ITEM",null,null,null]
      ["CORE:LLM_REQUEST_START",null,null,null]
      ["CORE:LOCAL_FUNCTION_TOOL_CALL","get_current_time","2024-01-01T12:00:00Z",null]
      ["CORE:LLM_REQUEST_END",null,null,null]
      ["CORE:LLM_REQUEST_START",null,null,null]
      ["CORE:LLM_OUTPUT_ITEM",null,null,null]
      ["CORE:LLM_REQUEST_END",null,null,null]"
    `);
  });

  createAgentCoreTest([])("cancels in-flight requests when new trigger arrives", async ({ h }) => {
    // Initialize the agent
    await h.initializeAgent();

    // First stream that will never complete
    const stream1 = h.enqueueMockOpenAIStream();
    stream1.streamChunks([makeResponseCreatedChunk("resp_1")]);
    // Don't complete stream1

    // Second stream for the new request
    const stream2 = h.enqueueMockOpenAIStream();
    stream2.streamChunks(makeResponseChunks("Response to second message"));
    stream2.complete();

    // Send first message
    await h.agentCore.addEvent(makeUserInputTextEvent("First message"));
    await h.waitUntilThinking();

    // Send second message while first is processing
    await h.agentCore.addEvent(makeUserInputTextEvent("Second message"));

    // Wait for async reducers to complete

    // The first request should be cancelled
    const events = h.getEvents();
    const cancelEvents = events.filter((e) => e.type === "CORE:LLM_REQUEST_CANCEL");
    expect(pluckFields(cancelEvents, ["data.reason"])).toMatchInlineSnapshot(`"["superseded"]"`);

    // System-generated events should have empty metadata
    const cancelEvent = cancelEvents[0];
    expect(cancelEvent.metadata).toEqual({});
  });

  createAgentCoreTest([])("updates assistant specification", async ({ h }) => {
    // Initialize the agent
    await h.initializeAgent();

    // Update the system prompt
    await h.agentCore.addEvent({
      type: "CORE:SET_SYSTEM_PROMPT",
      data: {
        prompt: "You are a helpful coding assistant.",
      },
    });

    // Update model options
    await h.agentCore.addEvent({
      type: "CORE:SET_MODEL_OPTS",
      data: {
        model: "gpt-4.1",
        temperature: 0.7,
      },
    });

    // Wait for async reducers to complete

    // The state should be updated
    const state = h.agentCore.state;
    expect(state.systemPrompt).toBe("You are a helpful coding assistant.");
    expect(state.modelOpts.model).toBe("gpt-4.1");
    expect(state.modelOpts.temperature).toBe(0.7);
  });

  createAgentCoreTest([])("manages tools through activation events", async ({ h }) => {
    // Initialize the agent
    await h.initializeAgent();

    // Register mock tools to satisfy toolSpecToImplementation
    h.registerMockTool("tool1", async () => ({ toolCallResult: { result: "tool1 result" } }));
    h.registerMockTool("tool2", async () => ({ toolCallResult: { result: "tool2 result" } }));

    const toolSpec1 = {
      type: "agent_durable_object_tool" as const,
      methodName: "tool1",
    };

    const toolSpec2 = {
      type: "agent_durable_object_tool" as const,
      methodName: "tool2",
    };

    // Add tools via ADD_TOOL_SPECS event with metadata
    await h.agentCore.addEvent({
      type: "CORE:ADD_CONTEXT_RULES",
      data: {
        rules: [
          {
            key: "test-rule",
            tools: [toolSpec1, toolSpec2],
          },
        ],
      },
      metadata: {
        toolVersion: "1.0",
        addedBy: "test",
      },
    });

    // Wait for async reducers to complete

    const state = h.agentCore.state;
    expect(state.contextRules).toHaveProperty("test-rule");
    expect(state.contextRules["test-rule"].tools).toHaveLength(2);

    // Tool implementations are derived from specs
    expect(state.runtimeTools).toHaveLength(2);
    expect(pluckFields(state.runtimeTools, ["type", "name"])).toMatchInlineSnapshot(`
      "["function","tool1"]
      ["function","tool2"]"
    `);

    // Verify metadata is preserved
    const events = h.getEvents();
    const toolSpecEvent = events.find((e) => e.type === "CORE:ADD_CONTEXT_RULES");
    expect(toolSpecEvent?.metadata).toMatchObject({
      toolVersion: "1.0",
      addedBy: "test",
    });
  });

  createAgentCoreTest([])("calls streaming chunk callback when provided", async ({ h }) => {
    const receivedChunks: any[] = [];

    // Create a new harness with streaming callback
    const harnessWithCallback = h.withStreamingCallback((chunk: any) => {
      receivedChunks.push(chunk);
    });

    // Initialize the agent
    await harnessWithCallback.initializeAgent();

    // Setup OpenAI mock response with multiple chunks
    const stream = harnessWithCallback.enqueueMockOpenAIStream();
    const testChunks = [
      makeResponseCreatedChunk("resp_1"),
      {
        type: "response.output_item.done",
        item: {
          type: "message",
          role: "assistant",
          status: "completed",
          id: "msg_1",
          content: [{ type: "output_text", text: "Hello", annotations: [] }],
        },
      },
      { type: "response.completed" },
    ];
    stream.streamChunks(testChunks);
    stream.complete();

    // Send user message to trigger LLM call
    await harnessWithCallback.agentCore.addEvent(makeUserInputTextEvent("Hello"));

    // Wait for processing
    await harnessWithCallback.waitUntilThinking();
    await harnessWithCallback.waitUntilNotThinking();

    // Verify callback was called with all chunks
    expect(receivedChunks).toHaveLength(3);
    expect(pluckFields(receivedChunks, ["type"])).toMatchInlineSnapshot(`
      "["response.created"]
      ["response.output_item.done"]
      ["response.completed"]"
    `);
  });

  describe("State management", () => {
    createAgentCoreTest([])("loads events from store correctly", async ({ h }) => {
      // Create some initial events

      // Load events
      await h.agentCore.initializeWithEvents([
        {
          type: "CORE:SET_SYSTEM_PROMPT" as const,
          data: {
            prompt: "You are a helpful assistant.",
          },
          metadata: {},
          triggerLLMRequest: `false:initial-state-nothing-to-do-yet`,
          eventIndex: 0,
          createdAt: "2024-01-01T00:00:00.000Z",
        },
      ]);

      // Wait for async reducers to complete

      // Verify state was restored
      const state = h.agentCore.state;
      expect(state.systemPrompt).toBe("You are a helpful assistant.");
    });

    createAgentCoreTest([])("correctly identifies computation state", async ({ h }) => {
      // Initialize the agent
      await h.initializeAgent();

      // Initially not computing
      expect(h.isComputing()).toBe(false);

      // Add computation start event
      await h.agentCore.addEvent({
        type: "CORE:LLM_REQUEST_START",
      });

      // Wait for async reducers to complete

      // Should be computing now
      expect(h.isComputing()).toBe(true);

      // Add computation end event
      await h.agentCore.addEvent({
        type: "CORE:LLM_REQUEST_END",
        data: { rawResponse: {} },
      });

      // Wait for async reducers to complete

      // Should not be computing anymore
      expect(h.isComputing()).toBe(false);
    });
  });

  createAgentCoreTest([])("strips Symbol properties from tool execution results", async ({ h }) => {
    // Initialize the agent
    await h.initializeAgent();

    const symbolKey = Symbol("metadata");

    // Register a mock tool that returns an object with Symbol properties
    h.registerMockTool("test-tool", async () => {
      // Simulate what SafeDurableObjectBuilder might return
      const result = {
        message: "Hello",
        nested: {
          value: 42,
          [symbolKey]: "This should be stripped",
        },
        [symbolKey]: "This metadata should be stripped",
      };
      // Add a symbol to the result object itself
      Object.defineProperty(result, Symbol.for("internal"), {
        value: "internal data",
        enumerable: false,
      });
      return { toolCallResult: result };
    });

    // Add the tool spec to the agent
    await h.agentCore.addEvent({
      type: "CORE:ADD_CONTEXT_RULES",
      data: {
        rules: [
          {
            key: "test-rule",
            tools: [
              {
                type: "agent_durable_object_tool",
                methodName: "test-tool",
              },
            ],
          },
        ],
      },
    });

    // Setup OpenAI mock response with function call
    const stream1 = h.enqueueMockOpenAIStream();
    stream1.streamChunks([
      makeResponseCreatedChunk("resp_1"),
      makeFunctionCallChunk("test-tool", {}),
      { type: "response.completed" },
    ]);
    stream1.complete();

    // Setup second response after function execution
    const stream2 = h.enqueueMockOpenAIStream();
    stream2.streamChunks(makeResponseChunks("The tool ran successfully."));
    stream2.complete();

    // Send user message
    await h.agentCore.addEvent(makeUserInputTextEvent("Test the tool"));

    // Wait for processing
    await h.waitUntilThinking();
    await h.waitUntilNotThinking();

    // Check events
    const events = h.getEvents();

    // Find the function call event
    const functionCallEvent = events.find((e) => e.type === "CORE:LOCAL_FUNCTION_TOOL_CALL");
    expect(functionCallEvent).toBeDefined();

    // Type assertion to handle union type
    const successResult = functionCallEvent?.data?.result;
    if (successResult?.success === true) {
      expect(successResult.output).toEqual({
        message: "Hello",
        nested: {
          value: 42,
        },
      });

      // Verify no Symbol properties exist in the output
      const symbolKeys = Object.getOwnPropertySymbols(successResult.output);
      expect(symbolKeys).toHaveLength(0);

      // Also check nested objects
      const output = successResult.output as any;
      const nestedSymbolKeys = Object.getOwnPropertySymbols(output?.nested || {});
      expect(nestedSymbolKeys).toHaveLength(0);
    } else {
      // This should not happen in this test
      expect(successResult?.success, JSON.stringify(successResult)).toBe(true);
    }
  });

  createAgentCoreTest([])("includes raw response in LLM_REQUEST_END event", async ({ h }) => {
    // Initialize the agent
    await h.initializeAgent();

    const stream = h.enqueueMockOpenAIStream();
    const testChunks = [
      makeResponseCreatedChunk("resp_1"),
      {
        type: "response.output_item.done",
        item: {
          type: "message",
          role: "assistant",
          status: "completed",
          id: "msg_1",
          content: [{ type: "output_text", text: "Hello there!", annotations: [] }],
        },
      },
      { type: "response.completed", blahBlahUsageInfo: { tokensUsed: 123456 } },
    ];
    stream.streamChunks(testChunks);
    stream.complete();

    await h.agentCore.addEvent(makeUserInputTextEvent("Hello"));

    // Wait for processing to complete
    await h.waitUntilThinking();
    await h.waitUntilNotThinking();

    // Check events
    const requestEndEvents = h.getEvents().filter((e) => e.type === "CORE:LLM_REQUEST_END");
    expect(requestEndEvents).toHaveLength(1);
    expect(requestEndEvents).toMatchObject([{ data: { rawResponse: {} } }]);
    expect(requestEndEvents[0].data.rawResponse).toEqual(testChunks.at(-1));

    expect(requestEndEvents).toMatchInlineSnapshot(`
      [
        {
          "createdAt": "2024-01-01T00:00:00.100Z",
          "data": {
            "rawResponse": {
              "blahBlahUsageInfo": {
                "tokensUsed": 123456,
              },
              "type": "response.completed",
            },
          },
          "eventIndex": 6,
          "metadata": {},
          "triggerLLMRequest": false,
          "type": "CORE:LLM_REQUEST_END",
        },
      ]
    `);
  });

  createAgentCoreTest([])(
    "prevents LLM output events when explicit cancel event is inserted",
    async ({ h }) => {
      // Initialize the agent
      await h.initializeAgent();

      // Setup a mock OpenAI stream but DON'T stream chunks yet
      const stream = h.enqueueMockOpenAIStream();

      // Send user message to trigger LLM request
      await h.agentCore.addEvent(makeUserInputTextEvent("Hello"));

      // Wait until the agent starts thinking
      await h.waitUntilThinking();

      // Insert a cancel event while the LLM request is in progress
      await h.agentCore.addEvent({
        type: "CORE:LLM_REQUEST_CANCEL",
        data: { reason: "explicit cancellation" },
      });

      // NOW stream the chunks after cancel event is processed
      stream.streamChunks([
        makeResponseCreatedChunk("resp_1"),
        {
          type: "response.output_item.done",
          item: {
            type: "message",
            role: "assistant",
            status: "completed",
            id: "msg_1",
            content: [{ type: "output_text", text: "This should not appear", annotations: [] }],
          },
        },
        { type: "response.completed" },
      ]);
      stream.complete();

      // Wait until the agent is not thinking anymore
      await h.waitUntilNotThinking();

      // Check events
      const events = h.getEvents();

      expect(pluckFields(events, ["type", "data.reason", "data.content[0].text"]))
        .toMatchInlineSnapshot(`
          "["CORE:INITIALIZED_WITH_EVENTS",null,null]
          ["CORE:SET_SYSTEM_PROMPT",null,null]
          ["CORE:SET_MODEL_OPTS",null,null]
          ["CORE:LLM_INPUT_ITEM",null,null]
          ["CORE:LLM_REQUEST_START",null,null]
          ["CORE:LLM_REQUEST_CANCEL","explicit cancellation",null]"
        `);

      // Should also not have CORE:LLM_REQUEST_END event after cancel
      const cancelEvent = events.find((e) => e.type === "CORE:LLM_REQUEST_CANCEL");
      const cancelEventIndex = cancelEvent?.eventIndex ?? -1;
      const endEventAfterCancel = events.find(
        (e) => e.type === "CORE:LLM_REQUEST_END" && e.eventIndex > cancelEventIndex,
      );
      expect(endEventAfterCancel).toBeUndefined();

      // State should reflect that LLM request is no longer running
      expect(h.agentCore.state.llmRequestStartedAtIndex).toBeNull();
    },
  );

  createAgentCoreTest([])(
    "prevents LLM output events from being processed after explicit cancellation",
    async ({ h }) => {
      // Initialize the agent
      await h.initializeAgent();

      // Track background execution promises
      const backgroundPromises: Promise<void>[] = [];

      // Override the background mock to capture promises
      h.backgroundMock.mockImplementation((fn: () => Promise<void>) => {
        backgroundPromises.push(fn());
      });

      // Setup a mock OpenAI stream that will emit content
      const stream = h.enqueueMockOpenAIStream();

      // Send user message to trigger LLM request
      await h.agentCore.addEvent(makeUserInputTextEvent("Tell me a long story"));

      // Wait until the agent starts thinking
      await h.waitUntilThinking();

      // Get the request start index
      const requestStartIndex = h.agentCore.state.llmRequestStartedAtIndex;
      expect(requestStartIndex).not.toBeNull();

      // Insert a cancel event while the LLM request is in progress
      await h.agentCore.addEvent({
        type: "CORE:LLM_REQUEST_CANCEL",
        data: { reason: "User requested cancellation" },
      });

      // Wait for async reducers to complete after cancel

      // After cancel, llmRequestStartedAtIndex should be null
      expect(h.agentCore.state.llmRequestStartedAtIndex).toBeNull();

      // Now stream chunks after cancellation
      stream.streamChunks([
        makeResponseCreatedChunk("resp_1"),
        // This chunk is sent after we cancel
        {
          type: "response.output_item.done",
          item: {
            type: "message",
            role: "assistant",
            status: "completed",
            id: "msg_1",
            content: [
              { type: "output_text", text: "This should NOT appear after cancel", annotations: [] },
            ],
          },
        },
        { type: "response.completed" },
      ]);
      stream.complete();

      // Wait for all background operations to complete
      await Promise.all(backgroundPromises);

      // Check events
      const events = h.getEvents();

      // Find the cancel event
      const cancelEvent = events.find((e) => e.type === "CORE:LLM_REQUEST_CANCEL");
      expect(cancelEvent).toBeDefined();
      const cancelEventIndex = cancelEvent?.eventIndex ?? -1;

      // Should NOT have any LLM output events after the cancel
      const outputEventsAfterCancel = events.filter(
        (e) => e.type === "CORE:LLM_OUTPUT_ITEM" && e.eventIndex > cancelEventIndex,
      );

      // This test currently FAILS - we get output events after cancel
      expect(outputEventsAfterCancel).toHaveLength(0);

      // Should also not have CORE:LLM_REQUEST_END event after cancel
      const endEventAfterCancel = events.find(
        (e) => e.type === "CORE:LLM_REQUEST_END" && e.eventIndex > cancelEventIndex,
      );
      expect(endEventAfterCancel).toBeUndefined();
    },
  );

  createAgentCoreTest([])(
    "prevents LLM output events from previous request when new request starts",
    async ({ h }) => {
      // Initialize the agent
      await h.initializeAgent();

      // Track background execution promises
      const backgroundPromises: Promise<void>[] = [];

      // Override the background mock to capture promises
      h.backgroundMock.mockImplementation((fn: () => Promise<void>) => {
        backgroundPromises.push(fn());
      });

      // Setup first mock OpenAI stream that will emit content
      const stream1 = h.enqueueMockOpenAIStream();

      // Setup second mock OpenAI stream for the new request
      const stream2 = h.enqueueMockOpenAIStream();

      // Send first user message to trigger LLM request
      await h.agentCore.addEvent(makeUserInputTextEvent("First message"));

      // Wait until the agent starts thinking
      await h.waitUntilThinking();

      // Get the first request start index
      const firstRequestStartIndex = h.agentCore.state.llmRequestStartedAtIndex;
      expect(firstRequestStartIndex).not.toBeNull();

      // Send second message while first is processing (this will cancel and restart)
      await h.agentCore.addEvent(makeUserInputTextEvent("Second message"));

      // Wait for async reducers to complete

      // The first request should be cancelled
      const cancelEvent = h.getEvents().find((e) => e.type === "CORE:LLM_REQUEST_CANCEL");
      expect(cancelEvent).toBeDefined();

      // New request should have started with a different index
      const secondRequestStartIndex = h.agentCore.state.llmRequestStartedAtIndex;
      expect(secondRequestStartIndex).not.toBeNull();
      expect(secondRequestStartIndex).not.toBe(firstRequestStartIndex);

      // Now stream chunks from the FIRST request (simulating delayed response)
      stream1.streamChunks([
        makeResponseCreatedChunk("resp_1"),
        {
          type: "response.output_item.done",
          item: {
            type: "message",
            role: "assistant",
            status: "completed",
            id: "msg_1",
            content: [
              {
                type: "output_text",
                text: "Response to FIRST message - should NOT appear",
                annotations: [],
              },
            ],
          },
        },
        { type: "response.completed" },
      ]);
      stream1.complete();

      // Stream chunks from the SECOND request
      stream2.streamChunks([
        makeResponseCreatedChunk("resp_2"),
        {
          type: "response.output_item.done",
          item: {
            type: "message",
            role: "assistant",
            status: "completed",
            id: "msg_2",
            content: [{ type: "output_text", text: "Response to SECOND message", annotations: [] }],
          },
        },
        { type: "response.completed" },
      ]);
      stream2.complete();

      // Wait for all background operations to complete
      await Promise.all(backgroundPromises);

      // Check events
      const events = h.getEvents();

      // Find all output events
      const outputEvents = events.filter((e) => e.type === "CORE:LLM_OUTPUT_ITEM");

      // Should only have output from the second request
      expect(outputEvents).toHaveLength(1);
      expect((outputEvents[0] as any).data.content[0].text).toBe("Response to SECOND message");

      // Should NOT have any output mentioning "FIRST message"
      const firstMessageOutputs = outputEvents.filter((e: any) =>
        e.data?.content?.[0]?.text?.includes("FIRST message"),
      );
      expect(firstMessageOutputs).toHaveLength(0);

      // Should have exactly one LLM_REQUEST_END event (for the second request)
      const endEvents = events.filter((e) => e.type === "CORE:LLM_REQUEST_END");
      expect(endEvents).toHaveLength(1);

      // The END event should come after the second request start
      expect(endEvents[0].eventIndex).toBeGreaterThan(secondRequestStartIndex!);
    },
  );

  createAgentCoreTest([])(
    "does not cancel LLM request when tool call events are added as a batch",
    async ({ h }) => {
      // Initialize the agent
      await h.initializeAgent();

      // Register a mock tool
      h.registerMockTool("test_tool", async (_call, _args) => {
        return { toolCallResult: { result: "Tool executed successfully" } };
      });

      // Add the tool spec to the agent
      await h.agentCore.addEvent({
        type: "CORE:ADD_CONTEXT_RULES",
        data: {
          rules: [
            {
              key: "test-rule",
              tools: [
                {
                  type: "agent_durable_object_tool",
                  methodName: "test_tool",
                },
              ],
            },
          ],
        },
      });

      // Setup OpenAI mock response with function call
      const stream1 = h.enqueueMockOpenAIStream();
      stream1.streamChunks([
        makeResponseCreatedChunk("resp_1"),
        makeFunctionCallChunk("test_tool", { input: "test" }),
        { type: "response.completed" },
      ]);
      stream1.complete();

      // Setup second response after function execution
      const stream2 = h.enqueueMockOpenAIStream();
      stream2.streamChunks(makeResponseChunks("Tool was executed and returned a result."));
      stream2.complete();

      // Send user message to trigger first LLM request
      await h.agentCore.addEvent(makeUserInputTextEvent("Please use the test tool"));

      // Wait for processing
      await h.waitUntilThinking();
      await h.waitUntilNotThinking();

      // Check events
      const events = h.getEvents();

      expect(
        pluckFields(events, [
          "type",
          "data.call.name",
          "data.result.success",
          "data.content[0].text",
        ]),
      ).toMatchInlineSnapshot(`
        "["CORE:INITIALIZED_WITH_EVENTS",null,null,null]
        ["CORE:SET_SYSTEM_PROMPT",null,null,null]
        ["CORE:SET_MODEL_OPTS",null,null,null]
        ["CORE:ADD_CONTEXT_RULES",null,null,null]
        ["CORE:LLM_INPUT_ITEM",null,null,null]
        ["CORE:LLM_REQUEST_START",null,null,null]
        ["CORE:LOCAL_FUNCTION_TOOL_CALL","test_tool",true,null]
        ["CORE:LLM_REQUEST_END",null,null,null]
        ["CORE:LLM_REQUEST_START",null,null,null]
        ["CORE:LLM_OUTPUT_ITEM",null,null,null]
        ["CORE:LLM_REQUEST_END",null,null,null]"
      `);

      // There should be NO cancel events at all
      const cancelEvents = events.filter((e) => e.type === "CORE:LLM_REQUEST_CANCEL");
      expect(cancelEvents).toHaveLength(0);

      // Should have exactly 2 LLM request starts (initial request + tool call trigger)
      const startEvents = events.filter((e) => e.type === "CORE:LLM_REQUEST_START");
      expect(startEvents).toHaveLength(2);

      // Should have exactly 2 LLM request ends
      const endEvents = events.filter((e) => e.type === "CORE:LLM_REQUEST_END");
      expect(endEvents).toHaveLength(2);
    },
  );

  createAgentCoreTest([])(
    "creates internal error event when core reducer fails",
    async ({ h: _h }) => {
      // Setup console capture for this test
      const consoleCapture = setupConsoleCaptureForTest();
      const h = CoreTestHarness.create({ console: consoleCapture.console });
      h.begin("2024-01-01T00:00:00.000Z");

      // Initialize the agent
      await h.initializeAgent();

      // Mock the reduce method to throw an error
      const originalReduce = (h.agentCore as any).reduceCore;
      (h.agentCore as any).reduceCore = (_state: any, event: any) => {
        if (event.type === "CORE:SET_SYSTEM_PROMPT" && event.data?.prompt === "FAIL") {
          throw new Error("Core reducer failed");
        }
        return originalReduce.call(h.agentCore, _state, event);
      };

      // Get initial state
      const initialEventCount = h.getEvents().length;
      const initialSystemPrompt = h.agentCore.state.systemPrompt;

      // Try to add an event that will cause the reducer to fail
      expect(() =>
        h.agentCore.addEvent({
          type: "CORE:SET_SYSTEM_PROMPT",
          data: { prompt: "FAIL" },
        }),
      ).toThrow("Core reducer failed");

      // Check that state was rolled back
      expect(h.agentCore.state.systemPrompt).toBe(initialSystemPrompt);

      // Should have exactly one more event than before (the INTERNAL_ERROR)
      expect(h.getEvents().length).toBe(initialEventCount + 1);

      // Verify the INTERNAL_ERROR event was added
      const errorEvents = h.getEvents().filter((e) => e.type === "CORE:INTERNAL_ERROR");
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0].data.error).toContain("Error while calling addEvents");
      expect(errorEvents[0].data.error).toContain("Core reducer failed");
      expect(errorEvents[0].data.error).toContain("Events batch:");
      expect(errorEvents[0].data.stack).toBeDefined();

      // Restore original method
      (h.agentCore as any).reduceCore = originalReduce;
    },
  );

  createAgentCoreTest([])(
    "atomic batch: when second event fails, no events from batch are added",
    async ({ h: _h }) => {
      // Setup console capture for this test
      const consoleCapture = setupConsoleCaptureForTest();
      const h = CoreTestHarness.create({ console: consoleCapture.console });
      h.begin("2024-01-01T00:00:00.000Z");

      // Initialize the agent
      await h.initializeAgent();

      // Mock the reduce method to throw an error when processing the batch's SET_MODEL_OPTS
      const originalReduce = (h.agentCore as any).reduceCore;
      (h.agentCore as any).reduceCore = (_state: any, event: any) => {
        // Fail specifically when we see the batch's SET_MODEL_OPTS with gpt-4.1
        if (event.type === "CORE:SET_MODEL_OPTS" && event.data?.model === "gpt-4.1") {
          throw new Error("Second event reducer failed");
        }
        return originalReduce.call(h.agentCore, _state, event);
      };

      // Get initial state
      const initialEventCount = h.getEvents().length;
      const initialSystemPrompt = h.agentCore.state.systemPrompt;
      const initialModel = h.agentCore.state.modelOpts.model;

      // Try to add two events as a batch, where the second will fail
      expect(() =>
        h.agentCore.addEvents([
          {
            type: "CORE:SET_SYSTEM_PROMPT",
            data: { prompt: "New prompt that should not be applied" },
          },
          {
            type: "CORE:SET_MODEL_OPTS",
            data: { model: "gpt-4.1", temperature: 0.8 },
          },
        ]),
      ).toThrow("Second event reducer failed");

      // Check that neither event from the batch was added
      const events = h.getEvents();

      // Debug: log all events to understand what's happening
      const systemPromptEventsAfter = events.filter((e) => e.type === "CORE:SET_SYSTEM_PROMPT");
      const modelOptsEventsAfter = events.filter((e) => e.type === "CORE:SET_MODEL_OPTS");

      // Neither of the batch events should have been added
      expect(systemPromptEventsAfter).toHaveLength(1); // Only initial one
      expect(systemPromptEventsAfter[0].data?.prompt).toBe("You are a helpful assistant."); // Initial prompt

      expect(modelOptsEventsAfter).toHaveLength(1); // Only initial one
      expect(modelOptsEventsAfter[0].data?.model).toBe("gpt-4.1-mini"); // Initial model

      // Check that state was rolled back - neither event should have affected state
      expect(h.agentCore.state.systemPrompt).toBe(initialSystemPrompt);
      expect(h.agentCore.state.modelOpts.model).toBe(initialModel);

      // Should have exactly one more event than before (the INTERNAL_ERROR)
      expect(h.getEvents().length).toBe(initialEventCount + 1);

      // Verify the INTERNAL_ERROR event was added
      const errorEvents = events.filter((e) => e.type === "CORE:INTERNAL_ERROR");
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0].data.error).toContain("Error while calling addEvents");
      expect(errorEvents[0].data.error).toContain("Second event reducer failed");
      expect(errorEvents[0].data.error).toContain("Events batch:");
      expect(errorEvents[0].data.stack).toBeDefined();

      // Restore original method
      (h.agentCore as any).reduceCore = originalReduce;
    },
  );

  createAgentCoreTest([])(
    "feeds LLM output back as LLM input on subsequent requests",
    async ({ h }) => {
      await h.initializeAgent();

      // 1. First user message and LLM response
      const stream1 = h.enqueueMockOpenAIStream();
      stream1.streamChunks(makeResponseChunks("Assistant response to first message."));
      stream1.complete();

      await h.agentCore.addEvent(makeUserInputTextEvent("User's first message."));
      await h.waitUntilThinking();
      await h.waitUntilNotThinking();

      // 2. Second user message, which should trigger a new request with history
      const stream2 = h.enqueueMockOpenAIStream();
      stream2.streamChunks(makeResponseChunks("Assistant response to second message."));
      stream2.complete();

      await h.agentCore.addEvent(makeUserInputTextEvent("User's second message."));
      await h.waitUntilThinking();
      await h.waitUntilNotThinking();

      // 3. Assert on the inputs to the second LLM call
      const openAICalls = h.openAIClient.streamMock.mock.calls;
      expect(openAICalls).toHaveLength(2);

      const secondCallArgs = openAICalls[1][0];
      expect(secondCallArgs).toBeDefined();
      const secondCallMessages = secondCallArgs.input;

      // Pluck relevant fields for snapshot
      const simplifiedMessages = secondCallMessages.map((m: any) => ({
        role: m.role,
        content: m.content[0].text,
      }));

      expect(simplifiedMessages).toMatchInlineSnapshot(`
        [
          {
            "content": "User's first message.",
            "role": "user",
          },
          {
            "content": "Assistant response to first message.",
            "role": "assistant",
          },
          {
            "content": "User's second message.",
            "role": "user",
          },
        ]
      `);
    },
  );

  createAgentCoreTest([])(
    "does not share mutable state between separate AgentCore instances",
    async ({ h }) => {
      // Create a completely separate harness (and therefore a separate AgentCore instance)
      const h2 = CoreTestHarness.create();
      h2.begin("2024-01-01T00:00:00.000Z");

      try {
        // Initialise both agents with the default system prompt / model opts
        await h.initializeAgent();
        await h2.initializeAgent();

        // Sanity-check: both agents start with empty inputItems arrays
        expect(h.agentCore.state.inputItems).toHaveLength(0);
        expect(h2.agentCore.state.inputItems).toHaveLength(0);

        // Add a user message only to the first agent
        await h.agentCore.addEvent(makeUserInputTextEvent("Hello, Agent 1!"));

        // Wait until the first agent has processed the event (it will start thinking)
        await h.waitUntilThinking();

        // Verify the first agent's state changed
        expect(h.agentCore.state.inputItems.length).toBeGreaterThan(0);

        // The second agent must remain unaffected – this would fail if the array was shared
        expect(h2.agentCore.state.inputItems).toHaveLength(0);

        // Also ensure the arrays are not the same reference
        expect(h.agentCore.state.inputItems).not.toBe(h2.agentCore.state.inputItems);
      } finally {
        // Clean up the secondary harness to restore timers/mocks
        h2.end();
      }
    },
  );
});

describe("Pause/Resume functionality", () => {
  createAgentCoreTest([])("ignores LLM triggers when paused", async ({ h }) => {
    // Initialize the agent
    await h.initializeAgent();

    // Pause LLM requests
    await h.agentCore.addEvent({
      type: "CORE:PAUSE_LLM_REQUESTS",
    });

    // Wait for async reducers to complete

    // Verify the agent is paused
    expect(h.agentCore.state.paused).toBe(true);

    // Try to send user message (should not trigger LLM)
    await h.agentCore.addEvent(makeUserInputTextEvent("This should not trigger LLM"));

    // Wait for async reducers to complete

    // Check that no LLM request was started
    const events = h.getEvents();
    const startEvents = events.filter((e) => e.type === "CORE:LLM_REQUEST_START");
    expect(startEvents).toHaveLength(0);

    // Should still have the input event
    const inputEvents = events.filter((e) => e.type === "CORE:LLM_INPUT_ITEM");
    expect(inputEvents).toHaveLength(1);
  });

  createAgentCoreTest([])("resumes LLM processing after resume", async ({ h }) => {
    // Initialize the agent
    await h.initializeAgent();

    // Setup OpenAI mock response
    const stream = h.enqueueMockOpenAIStream();
    stream.streamChunks(makeResponseChunks("Hello after resume!"));
    stream.complete();

    // Pause LLM requests
    await h.agentCore.addEvent({
      type: "CORE:PAUSE_LLM_REQUESTS",
    });

    // Try to send user message while paused
    await h.agentCore.addEvent(makeUserInputTextEvent("Message while paused"));

    // Verify no LLM request started
    let events = h.getEvents();
    let startEvents = events.filter((e) => e.type === "CORE:LLM_REQUEST_START");
    expect(startEvents).toHaveLength(0);

    // Resume LLM requests
    await h.agentCore.addEvent({
      type: "CORE:RESUME_LLM_REQUESTS",
    });

    // Verify the agent is no longer paused
    expect(h.agentCore.state.paused).toBe(false);

    // Send another message (should trigger LLM)
    await h.agentCore.addEvent(makeUserInputTextEvent("Message after resume"));

    // Wait for processing
    await h.waitUntilThinking();
    await h.waitUntilNotThinking();

    // Check that LLM request was started and completed
    events = h.getEvents();
    startEvents = events.filter((e) => e.type === "CORE:LLM_REQUEST_START");
    expect(startEvents).toHaveLength(1);

    const endEvents = events.filter((e) => e.type === "CORE:LLM_REQUEST_END");
    expect(endEvents).toHaveLength(1);

    // Should have the response
    const outputEvents = events.filter((e) => e.type === "CORE:LLM_OUTPUT_ITEM");
    expect(outputEvents).toHaveLength(1);
    expect((outputEvents[0] as any).data.content[0].text).toBe("Hello after resume!");
  });

  createAgentCoreTest([])("allows ongoing requests to complete when paused", async ({ h }) => {
    // Initialize the agent
    await h.initializeAgent();

    // Track background execution promises
    const backgroundPromises: Promise<void>[] = [];

    // Override the background mock to capture promises
    h.backgroundMock.mockImplementation((fn: () => Promise<void>) => {
      backgroundPromises.push(fn());
    });

    // Setup OpenAI mock response BEFORE starting the request
    const stream = h.enqueueMockOpenAIStream();
    stream.streamChunks(makeResponseChunks("Response from ongoing request"));
    stream.complete();

    // Start an LLM request
    await h.agentCore.addEvent(makeUserInputTextEvent("Start request"));

    // Wait for async reducers to complete so LLM request is triggered

    // Wait until request starts
    await h.waitUntilThinking();

    // Verify request is running
    expect(h.agentCore.state.llmRequestStartedAtIndex).not.toBeNull();

    // Pause while request is in progress
    await h.agentCore.addEvent({
      type: "CORE:PAUSE_LLM_REQUESTS",
    });

    // Wait for async reducers to complete

    // Verify paused state
    expect(h.agentCore.state.paused).toBe(true);

    // Wait for the ongoing request to complete
    await Promise.all(backgroundPromises);

    // The request should be allowed to complete even when paused
    const events = h.getEvents();
    const endEvents = events.filter((e) => e.type === "CORE:LLM_REQUEST_END");
    expect(endEvents).toHaveLength(1); // Request should complete

    const outputEvents = events.filter((e) => e.type === "CORE:LLM_OUTPUT_ITEM");
    expect(outputEvents).toHaveLength(1); // Should have output from the request

    // Try to start a new request while paused (should be ignored)
    await h.agentCore.addEvent(makeUserInputTextEvent("New request while paused"));

    // Should still only have one LLM_REQUEST_START event
    const startEvents = h.getEvents().filter((e) => e.type === "CORE:LLM_REQUEST_START");
    expect(startEvents).toHaveLength(1);
  });

  createAgentCoreTest([])("handles multiple pause/resume cycles", async ({ h }) => {
    // Initialize the agent
    await h.initializeAgent();

    // Setup multiple OpenAI mock responses
    const stream1 = h.enqueueMockOpenAIStream();
    stream1.streamChunks(makeResponseChunks("Response 1"));
    stream1.complete();

    const stream2 = h.enqueueMockOpenAIStream();
    stream2.streamChunks(makeResponseChunks("Response 2"));
    stream2.complete();

    // First pause
    await h.agentCore.addEvent({
      type: "CORE:PAUSE_LLM_REQUESTS",
    });

    await h.agentCore.addEvent(makeUserInputTextEvent("Message 1 (paused)"));

    // First resume
    await h.agentCore.addEvent({
      type: "CORE:RESUME_LLM_REQUESTS",
    });

    await h.agentCore.addEvent(makeUserInputTextEvent("Message 1 (resumed)"));
    await h.waitUntilThinking();
    await h.waitUntilNotThinking();

    // Second pause
    await h.agentCore.addEvent({
      type: "CORE:PAUSE_LLM_REQUESTS",
    });

    await h.agentCore.addEvent(makeUserInputTextEvent("Message 2 (paused)"));

    // Second resume
    await h.agentCore.addEvent({
      type: "CORE:RESUME_LLM_REQUESTS",
    });

    await h.agentCore.addEvent(makeUserInputTextEvent("Message 2 (resumed)"));
    await h.waitUntilThinking();
    await h.waitUntilNotThinking();

    // Check events
    const events = h.getEvents();

    // Should have 2 pause events and 2 resume events
    const pauseEvents = events.filter((e) => e.type === "CORE:PAUSE_LLM_REQUESTS");
    expect(pauseEvents).toHaveLength(2);

    const resumeEvents = events.filter((e) => e.type === "CORE:RESUME_LLM_REQUESTS");
    expect(resumeEvents).toHaveLength(2);

    // Should have exactly 2 LLM requests (only the resumed ones)
    const startEvents = events.filter((e) => e.type === "CORE:LLM_REQUEST_START");
    expect(startEvents).toHaveLength(2);

    const endEvents = events.filter((e) => e.type === "CORE:LLM_REQUEST_END");
    expect(endEvents).toHaveLength(2);

    // Should have 2 responses
    const outputEvents = events.filter((e) => e.type === "CORE:LLM_OUTPUT_ITEM");
    expect(outputEvents).toHaveLength(2);

    // Verify final state is not paused
    expect(h.agentCore.state.paused).toBe(false);
  });

  createAgentCoreTest([])(
    "triggerLLMRequest state is managed correctly through event flow",
    async ({ h }) => {
      // Initialize the agent
      await h.initializeAgent();

      // Setup mock response
      const stream = h.enqueueMockOpenAIStream();
      stream.streamChunks(makeResponseChunks("Test response"));
      stream.complete();

      // Verify initial state
      expect(h.agentCore.state.triggerLLMRequest).toBe(false);

      // Add an event with triggerLLMRequest: true
      await h.agentCore.addEvent(makeUserInputTextEvent("Hello"));

      // LLM request should start immediately (triggerLLMRequest is consumed)
      await h.waitUntilThinking();

      // triggerLLMRequest should be consumed by LLM_REQUEST_START
      expect(h.agentCore.state.triggerLLMRequest).toBe(false);

      await h.waitUntilNotThinking();

      // Test that pause clears triggerLLMRequest when added atomically
      // Add both events in a single batch to ensure atomic processing
      await h.agentCore.addEvents([
        makeUserInputTextEvent("Should trigger but we'll pause"),
        {
          type: "CORE:PAUSE_LLM_REQUESTS",
        },
      ]);

      // should not trigger either
      await h.agentCore.addEvent(makeUserInputTextEvent("Hello again"));

      const events = h.getEvents();

      expect(pluckFields(events, ["type"])).toMatchInlineSnapshot(`
        "["CORE:INITIALIZED_WITH_EVENTS"]
        ["CORE:SET_SYSTEM_PROMPT"]
        ["CORE:SET_MODEL_OPTS"]
        ["CORE:LLM_INPUT_ITEM"]
        ["CORE:LLM_REQUEST_START"]
        ["CORE:LLM_OUTPUT_ITEM"]
        ["CORE:LLM_REQUEST_END"]
        ["CORE:LLM_INPUT_ITEM"]
        ["CORE:PAUSE_LLM_REQUESTS"]
        ["CORE:LLM_INPUT_ITEM"]"
      `);
    },
  );
});

describe("Core event field typing issues", () => {
  createAgentCoreTest([])(
    "demonstrates createdAt and eventIndex are incorrectly typed as optional",
    async ({ h }) => {
      // Initialize the agent
      await h.initializeAgent();

      // Add a core event
      await h.agentCore.addEvent({
        type: "CORE:SET_SYSTEM_PROMPT",
        data: { prompt: "Test prompt" },
      });

      // Get the events back
      const events = h.getEvents();
      const lastEvent = events[events.length - 1];

      // In reality, createdAt and eventIndex are ALWAYS present in stored events
      expect(lastEvent.createdAt).toBeDefined();
      expect(lastEvent.eventIndex).toBeDefined();

      expectTypeOf(lastEvent.createdAt).toEqualTypeOf<string>();
      expectTypeOf(lastEvent.eventIndex).toEqualTypeOf<number>();
    },
  );
});

describe("Event metadata functionality", () => {
  createAgentCoreTest([])(
    "supports custom metadata and defaults to empty object",
    async ({ h }) => {
      // Initialize the agent
      await h.initializeAgent();

      // Add event with custom metadata (using ADD_TOOL_SPECS since SET_SYSTEM_PROMPT already exists)
      await h.agentCore.addEvent({
        type: "CORE:ADD_CONTEXT_RULES",
        data: { rules: [] },
        metadata: {
          source: "test",
          version: 1,
        },
      });

      const events = h.getEvents();
      const toolSpecEvent = events.find((e) => e.type === "CORE:ADD_CONTEXT_RULES");

      // Verify custom metadata is preserved
      expect(toolSpecEvent?.metadata).toMatchObject({ source: "test", version: 1 });
    },
  );
});

describe("Idempotency key deduplication", () => {
  createAgentCoreTest([])(
    "deduplicates events with the same idempotency key",
    async ({ h: _h }) => {
      // Setup console capture for this test
      const consoleCapture = setupConsoleCaptureForTest();
      const h = CoreTestHarness.create({ console: consoleCapture.console });
      h.begin("2024-01-01T00:00:00.000Z");

      // Initialize the agent
      await h.initializeAgent();

      // Add an event with idempotency key
      await h.agentCore.addEvent({
        type: "CORE:SET_SYSTEM_PROMPT",
        data: { prompt: "First prompt" },
        idempotencyKey: "test-key-1",
      });

      // Try to add the same event with the same idempotency key
      await h.agentCore.addEvent({
        type: "CORE:SET_SYSTEM_PROMPT",
        data: { prompt: "Second prompt - should be ignored" },
        idempotencyKey: "test-key-1",
      });

      // Check that only the first event was processed
      const events = h.getEvents();
      const systemPromptEvents = events.filter((e) => e.type === "CORE:SET_SYSTEM_PROMPT");

      // Should have 2 total (1 from initialization + 1 from our test)
      expect(systemPromptEvents).toHaveLength(2);
      expect(systemPromptEvents[1].data?.prompt).toBe("First prompt");

      // State should reflect the first prompt only
      expect(h.agentCore.state.systemPrompt).toBe("First prompt");

      // Check that a warning was logged
      const warnings = consoleCapture.getLogs().filter((log) => log.startsWith("[WARN]"));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(
        "[AgentCore] Skipping duplicate event with idempotencyKey: test-key-1",
      );
    },
  );

  createAgentCoreTest([])("allows events without idempotency keys", async ({ h }) => {
    // Initialize the agent
    await h.initializeAgent();

    // Add events without idempotency keys
    await h.agentCore.addEvent({
      type: "CORE:SET_SYSTEM_PROMPT",
      data: { prompt: "First prompt" },
    });

    await h.agentCore.addEvent({
      type: "CORE:SET_SYSTEM_PROMPT",
      data: { prompt: "Second prompt" },
    });

    // Both events should be processed
    const events = h.getEvents();
    const systemPromptEvents = events.filter((e) => e.type === "CORE:SET_SYSTEM_PROMPT");

    // Should have 3 total (1 from initialization + 2 from our test)
    expect(systemPromptEvents).toHaveLength(3);
    expect(systemPromptEvents[1].data?.prompt).toBe("First prompt");
    expect(systemPromptEvents[2].data?.prompt).toBe("Second prompt");

    // State should reflect the second prompt
    expect(h.agentCore.state.systemPrompt).toBe("Second prompt");
  });

  createAgentCoreTest([])("deduplicates within a batch of events", async ({ h: _h }) => {
    // Setup console capture for this test
    const consoleCapture = setupConsoleCaptureForTest();
    const h = CoreTestHarness.create({ console: consoleCapture.console });
    h.begin("2024-01-01T00:00:00.000Z");

    // Initialize the agent
    await h.initializeAgent();

    // Add multiple events in a single batch, some with duplicate keys
    await h.agentCore.addEvents([
      {
        type: "CORE:SET_SYSTEM_PROMPT",
        data: { prompt: "Prompt 1" },
        idempotencyKey: "key-1",
      },
      {
        type: "CORE:SET_MODEL_OPTS",
        data: { model: "gpt-4.1" },
        idempotencyKey: "key-2",
      },
      {
        type: "CORE:SET_SYSTEM_PROMPT",
        data: { prompt: "Prompt 2 - should be ignored" },
        idempotencyKey: "key-1", // Duplicate key
      },
      {
        type: "CORE:SET_MODEL_OPTS",
        data: { model: "gpt-4.1-mini", temperature: 0.5 },
        idempotencyKey: "key-3",
      },
    ]);

    // Check that duplicates were skipped
    const events = h.getEvents();
    const systemPromptEvents = events.filter((e) => e.type === "CORE:SET_SYSTEM_PROMPT");
    const modelOptsEvents = events.filter((e) => e.type === "CORE:SET_MODEL_OPTS");

    // Should have only one new system prompt event (the first one)
    expect(systemPromptEvents).toHaveLength(2); // 1 from init + 1 from test
    expect(systemPromptEvents[1].data?.prompt).toBe("Prompt 1");

    // Should have both model opts events
    expect(modelOptsEvents).toHaveLength(3); // 1 from init + 2 from test
    expect(modelOptsEvents[1].data?.model).toBe("gpt-4.1");
    expect(modelOptsEvents[2].data?.model).toBe("gpt-4.1-mini");

    // Check that a warning was logged for the duplicate
    const warnings = consoleCapture.getLogs().filter((log) => log.startsWith("[WARN]"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(
      "[AgentCore] Skipping duplicate event with idempotencyKey: key-1",
    );
  });

  createAgentCoreTest([])(
    "tracks idempotency keys across multiple addEvents calls",
    async ({ h: _h }) => {
      // Setup console capture for this test
      const consoleCapture = setupConsoleCaptureForTest();
      const h = CoreTestHarness.create({ console: consoleCapture.console });
      h.begin("2024-01-01T00:00:00.000Z");

      // Initialize the agent
      await h.initializeAgent();

      // First batch of events
      await h.agentCore.addEvents([
        {
          type: "CORE:SET_SYSTEM_PROMPT",
          data: { prompt: "Prompt A" },
          idempotencyKey: "prompt-key",
        },
        {
          type: "CORE:SET_MODEL_OPTS",
          data: { model: "gpt-4.1" },
          idempotencyKey: "model-key",
        },
      ]);

      // Second batch with some duplicate keys
      await h.agentCore.addEvents([
        {
          type: "CORE:SET_SYSTEM_PROMPT",
          data: { prompt: "Prompt B - should be ignored" },
          idempotencyKey: "prompt-key", // Duplicate from first batch
        },
        {
          type: "CORE:ADD_CONTEXT_RULES",
          data: { rules: [] },
          idempotencyKey: "tool-key", // New key
        },
      ]);

      // Third batch
      await h.agentCore.addEvent({
        type: "CORE:SET_MODEL_OPTS",
        data: { model: "gpt-4.1-mini" },
        idempotencyKey: "model-key", // Duplicate from first batch
      });

      // Check events
      const events = h.getEvents();
      const systemPromptEvents = events.filter((e) => e.type === "CORE:SET_SYSTEM_PROMPT");
      const modelOptsEvents = events.filter((e) => e.type === "CORE:SET_MODEL_OPTS");
      const toolSpecEvents = events.filter((e) => e.type === "CORE:ADD_CONTEXT_RULES");

      // Should have only one new system prompt (from first batch)
      expect(systemPromptEvents).toHaveLength(2); // 1 from init + 1 from test
      expect(systemPromptEvents[1].data?.prompt).toBe("Prompt A");

      // Should have only one new model opts (from first batch)
      expect(modelOptsEvents).toHaveLength(2); // 1 from init + 1 from test
      expect(modelOptsEvents[1].data?.model).toBe("gpt-4.1");

      // Should have the tool spec event
      expect(toolSpecEvents).toHaveLength(1);

      // Check warnings
      const warnings = consoleCapture.getLogs().filter((log) => log.startsWith("[WARN]"));
      expect(warnings).toHaveLength(2);
      expect(warnings[0]).toContain("prompt-key");
      expect(warnings[1]).toContain("model-key");
    },
  );

  createAgentCoreTest([])(
    "tracks idempotency keys from initializeWithEvents",
    async ({ h: _h }) => {
      // Setup console capture for this test
      const consoleCapture = setupConsoleCaptureForTest();
      const h = CoreTestHarness.create({ console: consoleCapture.console });
      h.begin("2024-01-01T00:00:00.000Z");

      // Initialize with events that have idempotency keys
      await h.agentCore.initializeWithEvents([
        {
          type: "CORE:SET_SYSTEM_PROMPT",
          data: { prompt: "Initial prompt" },
          metadata: {},
          triggerLLMRequest: `false:`,
          eventIndex: 0,
          createdAt: "2024-01-01T00:00:00.000Z",
          idempotencyKey: "init-key-1",
        },
        {
          type: "CORE:SET_MODEL_OPTS",
          data: { model: "gpt-4.1" },
          metadata: {},
          triggerLLMRequest: `false:setting-model-opts-nothing-to-do-yet`,
          eventIndex: 1,
          createdAt: "2024-01-01T00:00:01.000Z",
          idempotencyKey: "init-key-2",
        },
      ]);

      // Try to add events with the same idempotency keys
      await h.agentCore.addEvents([
        {
          type: "CORE:SET_SYSTEM_PROMPT",
          data: { prompt: "New prompt - should be ignored" },
          idempotencyKey: "init-key-1",
        },
        {
          type: "CORE:SET_MODEL_OPTS",
          data: { model: "gpt-4.1-mini" },
          idempotencyKey: "init-key-2",
        },
        {
          type: "CORE:ADD_CONTEXT_RULES",
          data: { rules: [] },
          idempotencyKey: "new-key",
        },
      ]);

      // Check that duplicates were skipped
      const events = h.getEvents();
      const systemPromptEvents = events.filter((e) => e.type === "CORE:SET_SYSTEM_PROMPT");
      const modelOptsEvents = events.filter((e) => e.type === "CORE:SET_MODEL_OPTS");
      const toolSpecEvents = events.filter((e) => e.type === "CORE:ADD_CONTEXT_RULES");

      // Should only have the initial events, not the duplicates
      expect(systemPromptEvents).toHaveLength(1);
      expect(systemPromptEvents[0].data?.prompt).toBe("Initial prompt");

      expect(modelOptsEvents).toHaveLength(1);
      expect(modelOptsEvents[0].data?.model).toBe("gpt-4.1");

      // Should have the new event
      expect(toolSpecEvents).toHaveLength(1);

      // Check warnings for duplicates
      const warnings = consoleCapture.getLogs().filter((log) => log.startsWith("[WARN]"));
      expect(warnings).toHaveLength(2);
      expect(warnings[0]).toContain("init-key-1");
      expect(warnings[1]).toContain("init-key-2");
    },
  );

  createAgentCoreTest([])(
    "allows different events with different idempotency keys",
    async ({ h }) => {
      // Initialize the agent
      await h.initializeAgent();

      // Add events with different idempotency keys
      await h.agentCore.addEvents([
        {
          type: "CORE:SET_SYSTEM_PROMPT",
          data: { prompt: "Prompt 1" },
          idempotencyKey: "unique-key-1",
        },
        {
          type: "CORE:SET_SYSTEM_PROMPT",
          data: { prompt: "Prompt 2" },
          idempotencyKey: "unique-key-2",
        },
        {
          type: "CORE:SET_MODEL_OPTS",
          data: { model: "gpt-4.1" },
          idempotencyKey: "unique-key-3",
        },
      ]);

      // All events should be processed
      const events = h.getEvents();
      const systemPromptEvents = events.filter((e) => e.type === "CORE:SET_SYSTEM_PROMPT");
      const modelOptsEvents = events.filter((e) => e.type === "CORE:SET_MODEL_OPTS");

      expect(systemPromptEvents).toHaveLength(3); // 1 from init + 2 from test
      expect(systemPromptEvents[1].data?.prompt).toBe("Prompt 1");
      expect(systemPromptEvents[2].data?.prompt).toBe("Prompt 2");

      expect(modelOptsEvents).toHaveLength(2); // 1 from init + 1 from test
      expect(modelOptsEvents[1].data?.model).toBe("gpt-4.1");
    },
  );

  createAgentCoreTest([])("preserves idempotency keys in events", async ({ h }) => {
    // Initialize the agent
    await h.initializeAgent();

    // Add an event with idempotency key
    await h.agentCore.addEvent({
      type: "CORE:SET_SYSTEM_PROMPT",
      data: { prompt: "Test prompt" },
      idempotencyKey: "preserve-me",
    });

    // Check that the idempotency key is preserved in the stored event
    const events = h.getEvents();
    const systemPromptEvents = events.filter((e) => e.type === "CORE:SET_SYSTEM_PROMPT");
    const lastEvent = systemPromptEvents[systemPromptEvents.length - 1];

    expect(lastEvent.idempotencyKey).toBe("preserve-me");
  });
});

describe("CORE:FILE_SHARED event handling", () => {
  createAgentCoreTest([])("handles CORE:FILE_SHARED from user to agent", async ({ h }) => {
    await h.initializeAgent();

    // Add a FILE:SHARED event from user to agent
    await h.agentCore.addEvent({
      type: "CORE:FILE_SHARED",
      data: {
        direction: "from-user-to-agent",
        iterateFileId: "file_123",
        originalFilename: "test-image.png",
        size: 1024,
        mimeType: "image/png",
        openAIFileId: "file-openai-123",
      },
    });

    // Should add an input_image item to state
    const inputItems = h.agentCore.state.inputItems;
    expect(inputItems).toHaveLength(2);

    const inputItem = inputItems[0];
    expect(inputItem).toEqual({
      type: "message",
      role: "user",
      content: [
        {
          detail: "auto",
          type: "input_image",
          file_id: "file-openai-123",
        },
      ],
    });

    const devMessage = inputItems[1];
    expect(devMessage).toEqual({
      type: "message",
      role: "developer",
      content: [
        {
          type: "input_text",
          text: "Use either of the following identifiers to use this file in other tools:\n\niterateFileId: file_123.\n\nPublic URL: https://you-must-inject-this-into-agent-core.com/file_123.",
        },
      ],
    });
  });

  createAgentCoreTest([])("throws error when OpenAI file ID is missing", async ({ h }) => {
    await h.initializeAgent();

    // Try to add a FILE:SHARED event without OpenAI file ID
    expect(() =>
      h.agentCore.addEvent({
        type: "CORE:FILE_SHARED",
        data: {
          direction: "from-user-to-agent",
          iterateFileId: "file_no_openai",
          originalFilename: "missing-openai-id.png",
          size: 1024,
          mimeType: "image/png",
          // No openAIFileId provided
        },
      }),
    ).toThrow("CORE:FILE_SHARED event missing required OpenAI file ID for file file_no_openai");
  });

  createAgentCoreTest([])("handles multiple files in sequence", async ({ h }) => {
    await h.initializeAgent();

    // Add multiple FILE:SHARED events with PDFs (which are supported)
    await h.agentCore.addEvent({
      type: "CORE:FILE_SHARED",
      data: {
        direction: "from-user-to-agent",
        iterateFileId: "file_1",
        originalFilename: "doc1.pdf",
        size: 100,
        openAIFileId: "file-openai-1",
        mimeType: "application/pdf",
      },
    });

    await h.agentCore.addEvent({
      type: "CORE:FILE_SHARED",
      data: {
        direction: "from-user-to-agent",
        iterateFileId: "file_2",
        originalFilename: "doc2.pdf",
        size: 200,
        openAIFileId: "file-openai-2",
        mimeType: "application/pdf",
      },
    });

    // Should have both files as input items (each file should have a user message and a developer one)
    const inputItems = h.agentCore.state.inputItems;
    expect(inputItems).toHaveLength(4);

    // Check the first item is a message with input_file content
    const firstItem = inputItems[0];
    expect(firstItem.type).toBe("message");
    if (firstItem.type === "message") {
      expect(firstItem.content[0]).toMatchObject({
        type: "input_file",
        file_id: "file-openai-1",
      });
    }

    // Check the third item is a message with input_file content for the second file
    const secondItem = inputItems[2];
    expect(secondItem.type).toBe("message");
    if (secondItem.type === "message") {
      expect(secondItem.content[0]).toMatchObject({
        type: "input_file",
        file_id: "file-openai-2",
      });
    }
  });

  createAgentCoreTest([])("resumes interrupted LLM request on initialization", async () => {
    // Setup console capture for this test
    const consoleCapture = setupConsoleCaptureForTest();
    const hWithConsole = CoreTestHarness.create({ console: consoleCapture.console });
    hWithConsole.begin("2024-01-01T00:00:00.000Z");

    // Mock stream that will be used for the resumed request
    const resumeStream = hWithConsole.enqueueMockOpenAIStream();
    resumeStream.streamChunks(makeResponseChunks("Resumed response"));
    resumeStream.complete();

    // Initialize with events where an LLM request was started but never finished
    await hWithConsole.agentCore.initializeWithEvents([
      {
        type: "CORE:SET_SYSTEM_PROMPT",
        data: { prompt: "You are a helpful assistant." },
        metadata: {},
        triggerLLMRequest: `false:`,
        eventIndex: 0,
        createdAt: "2024-01-01T00:00:00.000Z",
      },
      {
        type: "CORE:SET_MODEL_OPTS",
        data: { model: "gpt-4.1-mini" },
        metadata: {},
        triggerLLMRequest: `false:`,
        eventIndex: 1,
        createdAt: "2024-01-01T00:00:01.000Z",
      },
      {
        type: "CORE:LLM_INPUT_ITEM",
        data: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Hello" }],
        },
        metadata: {},
        triggerLLMRequest: `false:`,
        eventIndex: 2,
        createdAt: "2024-01-01T00:00:02.000Z",
      },
      {
        type: "CORE:LLM_REQUEST_START",
        data: {},
        metadata: {},
        triggerLLMRequest: `false:`,
        eventIndex: 3,
        createdAt: "2024-01-01T00:00:03.000Z",
      },
      // Note: No CORE:LLM_REQUEST_END event - this simulates a crash
    ]);

    // Wait for the resumed request to complete
    await hWithConsole.waitUntilThinking();
    await hWithConsole.waitUntilNotThinking();

    // Check that the LLM request was resumed
    const events = hWithConsole.getEvents();
    const llmRequestEndEvents = events.filter((e) => e.type === "CORE:LLM_REQUEST_END");
    expect(llmRequestEndEvents).toHaveLength(1);

    // Check that warning log was written
    const warnLogs = consoleCapture.getLogs().filter((log) => log.includes("[WARN]"));
    expect(
      warnLogs.some((log) => log.includes("Resuming interrupted LLM request at index 3")),
    ).toBe(true);

    // Verify the agent is no longer thinking
    expect(hWithConsole.isComputing()).toBe(false);
  });

  createAgentCoreTest([])("does not resume if no LLM request was in progress", async () => {
    // Setup console capture for this test
    const consoleCapture = setupConsoleCaptureForTest();
    const hWithConsole = CoreTestHarness.create({ console: consoleCapture.console });
    hWithConsole.begin("2024-01-01T00:00:00.000Z");

    // Initialize with events where no LLM request was in progress
    await hWithConsole.agentCore.initializeWithEvents([
      {
        type: "CORE:SET_SYSTEM_PROMPT",
        data: { prompt: "You are a helpful assistant." },
        metadata: {},
        triggerLLMRequest: `false:`,
        eventIndex: 0,
        createdAt: "2024-01-01T00:00:00.000Z",
      },
      {
        type: "CORE:SET_MODEL_OPTS",
        data: { model: "gpt-4.1-mini" },
        metadata: {},
        triggerLLMRequest: `false:`,
        eventIndex: 1,
        createdAt: "2024-01-01T00:00:01.000Z",
      },
    ]);

    // Check that no resume warning log was written
    const warnLogs = consoleCapture.getLogs().filter((log) => log.includes("[WARN]"));
    expect(warnLogs.some((log) => log.includes("Resuming interrupted LLM request"))).toBe(false);

    // Verify no LLM request is running
    expect(hWithConsole.isComputing()).toBe(false);
  });

  createAgentCoreTest([])(
    "handles resume request failure gracefully",
    async () => {
      // Setup console capture for this test
      const consoleCapture = setupConsoleCaptureForTest();
      const hWithConsole = CoreTestHarness.create({ console: consoleCapture.console });
      hWithConsole.begin("2024-01-01T00:00:00.000Z");

      // Track background promises manually
      const backgroundPromises: Promise<void>[] = [];
      hWithConsole.backgroundMock.mockImplementation((fn: () => Promise<void>) => {
        const promise = fn();
        backgroundPromises.push(promise);
      });

      // Mock a failing OpenAI client
      hWithConsole.getOpenAIClientMock.mockRejectedValue(new Error("OpenAI service unavailable"));

      // Initialize with events where an LLM request was started but never finished
      await hWithConsole.agentCore.initializeWithEvents([
        {
          type: "CORE:SET_SYSTEM_PROMPT",
          data: { prompt: "You are a helpful assistant." },
          metadata: {},
          triggerLLMRequest: `false:`,
          eventIndex: 0,
          createdAt: "2024-01-01T00:00:00.000Z",
        },
        {
          type: "CORE:LLM_REQUEST_START",
          data: {},
          metadata: {},
          triggerLLMRequest: `false:`,
          eventIndex: 1,
          createdAt: "2024-01-01T00:00:01.000Z",
        },
      ]);

      // Wait for all background promises to settle
      if (backgroundPromises.length > 0) {
        await Promise.allSettled(backgroundPromises);
      }

      // Check that error log was written
      const errorLogs = consoleCapture.getLogs().filter((log) => log.includes("[ERROR]"));
      expect(errorLogs.some((log) => log.includes("LLM request 1 failed"))).toBe(true);

      // Check that error events were added
      const events = hWithConsole.getEvents();
      const errorEvents = events.filter((e) => e.type === "CORE:INTERNAL_ERROR");
      const cancelEvents = events.filter((e) => e.type === "CORE:LLM_REQUEST_CANCEL");

      expect(errorEvents.length).toBeGreaterThan(0);
      expect(cancelEvents.length).toBeGreaterThan(0);

      // Verify the agent is no longer thinking
      expect(hWithConsole.isComputing()).toBe(false);
    },
    10000,
  ); // Increased timeout to 10 seconds

  createAgentCoreTest([])("handles CORE:FILE_SHARED from agent to user", async ({ h }) => {
    await h.initializeAgent();

    // Add a FILE:SHARED event from agent to user
    await h.agentCore.addEvent({
      type: "CORE:FILE_SHARED",
      data: {
        direction: "from-agent-to-user",
        iterateFileId: "file_agent_123",
        originalFilename: "generated-chart.png",
        size: 2048,
        mimeType: "image/png",
        openAIFileId: "file-openai-agent-123",
      },
    });

    // Should add a user message with input_image item and a developer message to state
    const inputItems = h.agentCore.state.inputItems;
    expect(inputItems).toHaveLength(2);

    const inputItem = inputItems[0];
    expect(inputItem).toEqual({
      type: "message",
      role: "user",
      content: [
        {
          detail: "auto",
          type: "input_image",
          file_id: "file-openai-agent-123",
        },
      ],
    });

    // Second item should be the developer message
    const developerMessage = inputItems[1];
    expect(developerMessage).toEqual({
      type: "message",
      role: "developer",
      content: [
        {
          type: "input_text",
          text: "Note: The previous file was something you created as the result of a tool call.\n\nUse either of the following identifiers to use this file in other tools:\n\niterateFileId: file_agent_123.\n\nPublic URL: https://you-must-inject-this-into-agent-core.com/file_agent_123.",
        },
      ],
    });
  });

  createAgentCoreTest([])(
    "detects image files by extension when MIME type is missing",
    async ({ h }) => {
      await h.initializeAgent();

      const imageExtensions = ["png", "jpg", "jpeg", "gif", "webp", "bmp"];

      for (const ext of imageExtensions) {
        await h.agentCore.addEvent({
          type: "CORE:FILE_SHARED",
          data: {
            direction: "from-user-to-agent",
            iterateFileId: `file_${ext}_123`,
            originalFilename: `test-image.${ext}`,
            openAIFileId: `file-openai-${ext}-123`,
          },
        });
      }

      // All should be treated as images
      const inputItems = h.agentCore.state.inputItems;
      expect(inputItems).toHaveLength(imageExtensions.length * 2);

      // check only the user messages contain the image content
      inputItems.forEach((item, idx) => {
        expect(item.type).toBe("message");
        if (item.type === "message" && idx % 2 === 0) {
          const imgIdx = idx / 2;
          expect(item.content[0]).toMatchObject({
            type: "input_image",
            detail: "auto",
            file_id: `file-openai-${imageExtensions[imgIdx]}-123`,
          });
        }
      });
    },
  );
});

describe("Image generation handling", () => {
  createAgentCoreTest([])("handles image generation output from LLM", async ({ h }) => {
    await h.initializeAgent();

    // Mock uploadFile dependency
    const uploadFileMock = vi.fn().mockResolvedValue({
      fileId: "uploaded_file_123",
      openAIFileId: "file-openai-uploaded-123",
      size: 1024,
      mimeType: "image/png",
    });

    // Create harness with uploadFile dependency
    const hWithUpload = CoreTestHarness.create({
      extraDeps: { uploadFile: uploadFileMock },
      console: (h.agentCore as any).deps.console,
    });
    hWithUpload.begin("2024-01-01T00:00:00.000Z");
    await hWithUpload.initializeAgent();

    // Setup OpenAI mock response with image generation
    const stream = hWithUpload.enqueueMockOpenAIStream();

    // Simulate base64 image data
    const mockBase64Image = btoa("fake image data");

    stream.streamChunks([
      makeResponseCreatedChunk("resp_1"),
      {
        type: "response.output_item.done",
        item: {
          id: "img_gen_123",
          type: "image_generation_call",
          call_id: "img_gen_123",
          status: "completed",
          result: mockBase64Image,
          output_format: "png",
          revised_prompt: "A beautiful landscape with mountains",
          size: "1024x1024",
          quality: "standard",
        },
      },
      makeResponseChunks("I've generated an image for you."),
      { type: "response.completed" },
    ]);
    stream.complete();

    // Send user message
    await hWithUpload.agentCore.addEvent(makeUserInputTextEvent("Generate an image of mountains"));

    // Wait for processing
    await hWithUpload.waitUntilThinking();
    await hWithUpload.waitUntilNotThinking();

    // Check events
    const events = hWithUpload.getEvents();
    console.log("events", events);
    // Find the FILE:SHARED event
    const fileSharedEvent = events.find((e) => e.type === "CORE:FILE_SHARED");

    expect(fileSharedEvent?.data).toMatchObject({
      direction: "from-agent-to-user",
      iterateFileId: "uploaded_file_123",
      openAIFileId: "file-openai-uploaded-123",
      originalFilename: expect.stringMatching(/^generated-image-\d+\.png$/),
      mimeType: "image/png",
    });

    // Check that additional image generation metadata is preserved in event metadata
    expect(fileSharedEvent?.data.openAIOutputItemWithoutResult).toMatchInlineSnapshot(`
      {
        "id": "img_gen_123",
        "result": null,
        "status": "completed",
        "type": "image_generation_call",
      }
    `);

    // Verify the file shared event was added to input items
    const inputItems = hWithUpload.agentCore.state.inputItems;
    const imageGenerationCallItem = inputItems.find(
      (item) => item.type === "image_generation_call",
    );

    expect(imageGenerationCallItem).toMatchInlineSnapshot(
      `
        {
          "id": "img_gen_123",
          "result": null,
          "status": "completed",
          "type": "image_generation_call",
        }
      `,
    );

    // Also check for the developer message that should be added for agent-to-user file shares
    const developerMessage = inputItems.find(
      (item) =>
        item.type === "message" &&
        item.role === "developer" &&
        item.content?.[0] &&
        typeof item.content[0] === "object" &&
        "type" in item.content[0] &&
        item.content[0].type === "input_text" &&
        "text" in item.content[0] &&
        item.content[0].text?.includes("previous file was something you created"),
    );
    expect(developerMessage).toBeDefined();
  });

  createAgentCoreTest([])(
    "throws error when uploadFile is not provided for image generation",
    async ({ h }) => {
      await h.initializeAgent();

      // Setup OpenAI mock response with image generation
      const stream = h.enqueueMockOpenAIStream();
      const mockBase64Image = btoa("fake image data");

      stream.streamChunks([
        makeResponseCreatedChunk("resp_1"),
        {
          type: "response.output_item.done",
          item: {
            id: "img_gen_123",
            type: "image_generation_call",
            call_id: "img_gen_123",
            status: "completed",
            result: mockBase64Image,
          },
        },
        { type: "response.completed" },
      ]);
      stream.complete();

      // Send user message
      await h.agentCore.addEvent(makeUserInputTextEvent("Generate an image"));

      // Wait for processing to complete and check for error
      await h.waitUntilThinking();
      await h.waitUntilNotThinking();

      // Check that an internal error event was created
      const events = h.getEvents();
      const errorEvent = events.find((e) => e.type === "CORE:INTERNAL_ERROR");
      expect(errorEvent).toBeDefined();
      expect(errorEvent?.data?.error).toContain(
        "uploadFile dependency is required to handle image generation output",
      );
    },
  );
});

// -----------------------------------------------------------------------------
// onEventAdded callback – currently wrong behaviour demonstration -------------
// -----------------------------------------------------------------------------

describe("onEventAdded callback state timing", () => {
  it("should receive the state after each individual event when added separately", async () => {
    const callbacks: any[] = [];

    // Minimal deps – none of the tested events trigger OpenAI calls or tools
    const deps = {
      storeEvents: () => {
        /* noop */
      },
      background: () => {
        /* noop */
      },
      getOpenAIClient: async () => {
        throw new Error("OpenAI client should not be requested in this test");
      },
      toolSpecToImplementation: async () => {
        throw new Error("toolSpecToImplementation should not be called in this test");
      },
      console,
    } as any;

    const agentCore = new AgentCore({
      deps: {
        ...deps,
        onEventAdded: (payload) => callbacks.push(payload),
      },
      slices: [],
    });

    await agentCore.initializeWithEvents([]);

    // Clear callbacks from initialization
    callbacks.length = 0;

    // 1. Set system prompt
    await agentCore.addEvent({
      type: "CORE:SET_SYSTEM_PROMPT",
      data: { prompt: "Prompt 1" },
    });

    // 2. Change model
    await agentCore.addEvent({
      type: "CORE:SET_MODEL_OPTS",
      data: { model: "gpt-4.1" },
    });

    expect(callbacks).toHaveLength(2);

    // Expect first callback to reflect only first change (systemPrompt updated, model still default)
    expect(callbacks[0].reducedState.systemPrompt).toBe("Prompt 1");
    expect(callbacks[0].reducedState.model).not.toBe("gpt-4.1");

    // Expect second callback to have model updated
    expect(callbacks[1].reducedState.modelOpts.model).toBe("gpt-4.1");
  });

  it("should receive state after each event when adding BATCH", async () => {
    const callbacks: Array<{ event: any; reducedState: any }> = [];

    // Minimal deps – none of the tested events trigger OpenAI calls or tools
    const deps = {
      storeEvents: () => {},
      background: () => {},
      getOpenAIClient: async () => {
        throw new Error("OpenAI client should not be requested in this test");
      },
      toolSpecToImplementation: async () => {
        throw new Error("toolSpecToImplementation should not be called in this test");
      },
      console,
    } as any;

    const agentCore = new AgentCore({
      deps: {
        ...deps,
        onEventAdded: (payload) => callbacks.push({ ...payload }),
      },
      slices: [],
    });

    await agentCore.initializeWithEvents([]);

    // Clear callbacks from initialization
    callbacks.length = 0;

    // Add BOTH events in a single batch
    await agentCore.addEvents([
      {
        type: "CORE:SET_SYSTEM_PROMPT",
        data: { prompt: "Prompt 1" },
      },
      {
        type: "CORE:SET_MODEL_OPTS",
        data: { model: "gpt-4.1" },
      },
    ]);

    expect(callbacks).toHaveLength(2);

    // What we WANT: first callback sees state after first event only
    expect(callbacks[0].event.type).toBe("CORE:SET_SYSTEM_PROMPT");
    expect(callbacks[0].reducedState.systemPrompt).toBe("Prompt 1");
    expect(callbacks[0].reducedState.modelOpts.model).toBe("gpt-5"); // Should still be default!

    // What we WANT: second callback sees state after both events
    expect(callbacks[1].event.type).toBe("CORE:SET_MODEL_OPTS");
    expect(callbacks[1].reducedState.systemPrompt).toBe("Prompt 1");
    expect(callbacks[1].reducedState.modelOpts.model).toBe("gpt-4.1");

    // This test verifies that onEventAdded receives the correct incremental state
  });
});

describe("AgentCore ephemeralPromptFragments", () => {
  createAgentCoreTest([])(
    "should render ephemeral context items into the system prompt",
    async ({ h }) => {
      // Set up context items that should be rendered
      const contextItems: ContextItem[] = [
        {
          key: "test-context",
          prompt: f("context", "This is important ephemeral context data"),
          description: "Test context item",
        },
        {
          key: "another-context",
          prompt: f("rule", "Another piece of context information"),
          description: "Another test context",
        },
      ];

      // Override the collectContextItems dependency to return our test items
      // Initialize the agent
      await h.initializeAgent();

      h.agentCore.addEvent({
        type: "CORE:ADD_CONTEXT_RULES",
        data: {
          rules: contextItems,
        },
      });

      // Set up mock OpenAI response
      const stream = h.enqueueMockOpenAIStream();
      stream.streamChunks(makeResponseChunks("Response acknowledging context"));
      stream.complete();

      // Send user message to trigger LLM request
      await h.agentCore.addEvent(makeUserInputTextEvent("Please use the context provided"));

      // Wait for LLM request to complete
      await h.waitUntilThinking();
      await h.waitUntilNotThinking();

      // Assert on the OpenAI client call
      const openAICalls = h.openAIClient.streamMock.mock.calls;
      expect(openAICalls).toHaveLength(1);

      const callArgs = openAICalls[0][0];
      expect(callArgs).toBeDefined();

      // Check that ephemeral context items are rendered into the system prompt
      expect(callArgs.instructions).toMatchInlineSnapshot(`
        "You are a helpful assistant.

        <test-context>
          <context>
            This is important ephemeral context data
          </context>
        </test-context>

        <another-context>
          <rule>
            Another piece of context information
          </rule>
        </another-context>"
      `);

      // Verify that input messages no longer contain the ephemeral context items
      const inputMessages = callArgs.input;
      expect(inputMessages).toHaveLength(1); // Only the user message
      expect(inputMessages[0]).toEqual({
        content: [
          {
            text: "Please use the context provided",
            type: "input_text",
          },
        ],
        role: "user",
        type: "message",
      });
    },
  );

  createAgentCoreTest([])("should filter out empty ephemeral prompt fragments", async ({ h }) => {
    // Set up context items including some that will render to empty strings
    const contextItems: ContextItem[] = [
      {
        key: "empty-context",
        prompt: f("empty", ""), // This will render to empty
        description: "Empty context item",
      },
      {
        key: "whitespace-context",
        prompt: f("whitespace", "   \n\t   "), // This will render to whitespace only
        description: "Whitespace context item",
      },
      {
        key: "null-context",
        prompt: null as any, // This should be filtered out
        description: "Null context item",
      },
      {
        key: "valid-context",
        prompt: f("valid", "This is valid context"),
        description: "Valid context item",
      },
    ];

    // Override the collectContextItems dependency to return our test items
    const originalDeps = (h.agentCore as any).deps;
    (h.agentCore as any).deps = {
      ...originalDeps,
      collectContextItems: vi.fn().mockResolvedValue(contextItems),
    };

    // Initialize the agent
    await h.initializeAgent();

    // Set up mock OpenAI response
    const stream = h.enqueueMockOpenAIStream();
    stream.streamChunks(makeResponseChunks("Response with filtered context"));
    stream.complete();

    // Send user message to trigger LLM request
    await h.agentCore.addEvent(makeUserInputTextEvent("Use context"));

    // Wait for LLM request to complete
    await h.waitUntilThinking();
    await h.waitUntilNotThinking();

    // Assert on the OpenAI client call
    const openAICalls = h.openAIClient.streamMock.mock.calls;
    expect(openAICalls).toHaveLength(1);

    const callArgs = openAICalls[0][0];
    expect(callArgs).toBeDefined();

    // Check that ephemeral context items are rendered into the system prompt with filtering
    expect(callArgs.instructions).toMatchInlineSnapshot(`"You are a helpful assistant."`);

    // Verify that input messages only contain the user message
    const inputMessages = callArgs.input;
    expect(inputMessages).toHaveLength(1); // Only the user message
    expect(inputMessages[0]).toEqual({
      content: [
        {
          text: "Use context",
          type: "input_text",
        },
      ],
      role: "user",
      type: "message",
    });
  });
});
