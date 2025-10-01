import { describe, it, expect, vi } from "vitest";
import z from "zod";
import { toolSpecsToImplementations, sanitizeToolName } from "./tool-spec-to-runtime-tool.ts";
import type { ToolSpec } from "./tool-schemas.ts";

describe("toolSpecsToImplementations", () => {
  // Mock DO with tool definitions
  const createMockDO = (toolDefs = {}, methods = {}) => {
    const mockDO: any = {
      constructor: { name: "TestDO" },
      toolDefinitions: () => toolDefs,
      ...methods,
    };
    return mockDO;
  };

  describe("tool conversion", () => {
    it("returns OpenAI builtin tools as-is", async () => {
      const spec: ToolSpec = {
        type: "openai_builtin",
        openAITool: {
          type: "file_search" as const,
          vector_store_ids: ["test-store"],
        },
      };

      const theDO = createMockDO();
      const results = await toolSpecsToImplementations({
        toolSpecs: [spec],
        theDO,
      });

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual(spec.openAITool);
    });

    it("converts agent_durable_object_tool correctly", async () => {
      const pingToolDef = {
        description: "Ping a durable object",
        input: z.object({ message: z.string() }),
      };

      const spec: ToolSpec = {
        type: "agent_durable_object_tool",
        methodName: "ping",
        passThroughArgs: { contextId: "ctx-123" },
      };

      const mockPing = vi.fn().mockResolvedValue({ result: "pong" });
      const theDO = createMockDO({ ping: pingToolDef }, { ping: mockPing });

      const results = await toolSpecsToImplementations({
        toolSpecs: [spec],
        theDO,
      });

      expect(results).toHaveLength(1);
      const tool = results[0] as any; // Cast to any to access properties

      expect(tool).toMatchObject({
        type: "function",
        name: "ping",
        description: "Ping a durable object",
        metadata: { source: "durable-object" },
        strict: false,
      });
      expect(tool.parameters).toBeDefined();
      expect(tool.execute).toBeDefined();
      expect(typeof tool.execute).toBe("function");
    });

    it("uses overrideName when provided", async () => {
      const pingToolDef = {
        description: "Ping a durable object",
        input: z.object({}),
      };

      const spec: ToolSpec = {
        type: "agent_durable_object_tool",
        methodName: "ping",
        overrideName: "customPingName",
      };

      const mockPing = vi.fn();
      const theDO = createMockDO({ ping: pingToolDef }, { ping: mockPing });

      const results = await toolSpecsToImplementations({
        toolSpecs: [spec],
        theDO,
      });

      expect((results[0] as any).name).toBe("customPingName");
    });

    it("uses overrideDescription when provided", async () => {
      const pingToolDef = {
        description: "Original description",
        input: z.object({}),
      };

      const spec: ToolSpec = {
        type: "agent_durable_object_tool",
        methodName: "ping",
        overrideDescription: "Custom description",
      };

      const mockPing = vi.fn();
      const theDO = createMockDO({ ping: pingToolDef }, { ping: mockPing });

      const results = await toolSpecsToImplementations({
        toolSpecs: [spec],
        theDO,
      });

      expect((results[0] as any).description).toBe("Custom description");
    });

    it("applies hideOptionalInputs to filter optional fields", async () => {
      const createUserToolDef = {
        description: "Create a new user",
        input: z.object({
          name: z.string(),
          email: z.string(),
          age: z.number().optional(),
          address: z.string().optional(),
        }),
      };

      const spec: ToolSpec = {
        type: "agent_durable_object_tool",
        methodName: "createUser",
        hideOptionalInputs: true,
      };

      const mockCreateUser = vi.fn();
      const theDO = createMockDO({ createUser: createUserToolDef }, { createUser: mockCreateUser });

      const results = await toolSpecsToImplementations({
        toolSpecs: [spec],
        theDO,
      });

      const parameters = (results[0] as any).parameters;
      expect(parameters.properties).toHaveProperty("name");
      expect(parameters.properties).toHaveProperty("email");
      expect(parameters.properties).not.toHaveProperty("age");
      expect(parameters.properties).not.toHaveProperty("address");
      expect(parameters.required).toEqual(["name", "email"]);
    });

    it("throws error when methodName not found in tool definitions", async () => {
      const toolDefs = {
        ping: {
          description: "Ping",
          input: z.object({}),
        },
      };

      const spec: ToolSpec = {
        type: "agent_durable_object_tool",
        methodName: "nonexistent",
      };

      const theDO = createMockDO(toolDefs);

      await expect(async () => {
        await toolSpecsToImplementations({
          toolSpecs: [spec],
          theDO,
        });
      }).rejects.toThrow("methodName nonexistent is not a function on the Durable Object");
    });

    it("processes multiple tool specs in batch", async () => {
      const basicToolDefs = {
        ping: {
          description: "Ping",
          input: z.object({}),
        },
        echo: {
          description: "Echo",
          input: z.object({ message: z.string() }),
        },
      };

      const specs: ToolSpec[] = [
        {
          type: "openai_builtin",
          openAITool: { type: "web_search" as const },
        },
        {
          type: "agent_durable_object_tool",
          methodName: "ping",
        },
        {
          type: "agent_durable_object_tool",
          methodName: "echo",
        },
      ];

      const mockPing = vi.fn();
      const mockEcho = vi.fn();
      const theDO = createMockDO(basicToolDefs, { ping: mockPing, echo: mockEcho });

      const results = await toolSpecsToImplementations({
        toolSpecs: specs,
        theDO,
      });

      expect(results).toHaveLength(3);
      // First spec is openai_builtin, so it returns the openAITool
      const firstSpec = specs[0];
      if (firstSpec.type === "openai_builtin") {
        expect(results[0]).toEqual(firstSpec.openAITool);
      }
      expect((results[1] as any).name).toBe("ping");
      expect((results[2] as any).name).toBe("echo");
    });
  });

  describe("execute function for agent_durable_object_tool", () => {
    it("calls the DO method with correct arguments", async () => {
      const echoToolDef = {
        description: "Echo message",
        input: z.object({ message: z.string() }),
      };

      const spec: ToolSpec = {
        type: "agent_durable_object_tool",
        methodName: "echo",
      };

      const mockResponse = { result: "echoed" };
      const mockEcho = vi.fn().mockResolvedValue(mockResponse);
      const theDO = createMockDO({ echo: echoToolDef }, { echo: mockEcho });

      const results = await toolSpecsToImplementations({
        toolSpecs: [spec],
        theDO,
      });

      const tool = results[0] as any;
      const executeResult = await tool.execute(
        { id: "call-123", name: "echo", arguments: '{"message": "hello"}' },
        { message: "hello" },
      );

      expect(mockEcho).toHaveBeenCalledWith({ message: "hello" });
      expect(executeResult).toEqual({
        toolCallResult: mockResponse,
        triggerLLMRequest: true,
      });
    });

    it("merges passThroughArgs with method arguments", async () => {
      const processToolDef = {
        description: "Process data",
        input: z.object({
          data: z.string(),
          contextId: z.string(),
        }),
      };

      const spec: ToolSpec = {
        type: "agent_durable_object_tool",
        methodName: "process",
        passThroughArgs: { contextId: "ctx-123" },
      };

      const mockProcess = vi.fn().mockResolvedValue({ success: true });
      const theDO = createMockDO({ process: processToolDef }, { process: mockProcess });

      const results = await toolSpecsToImplementations({
        toolSpecs: [spec],
        theDO,
      });

      const tool = results[0] as any;
      await tool.execute(
        { id: "call-456", name: "process", arguments: '{"data": "test"}' },
        { data: "test" },
      );

      expect(mockProcess).toHaveBeenCalledWith({
        data: "test",
        contextId: "ctx-123",
      });
    });

    it("validates arguments using zod schema", async () => {
      const strictMethodToolDef = {
        description: "Strict validation",
        input: z.object({
          requiredField: z.string(),
          numberField: z.number(),
        }),
      };

      const spec: ToolSpec = {
        type: "agent_durable_object_tool",
        methodName: "strictMethod",
      };

      const mockStrictMethod = vi.fn();
      const theDO = createMockDO(
        { strictMethod: strictMethodToolDef },
        { strictMethod: mockStrictMethod },
      );

      const results = await toolSpecsToImplementations({
        toolSpecs: [spec],
        theDO,
      });

      const tool = results[0] as any;

      // Invalid arguments should throw
      await expect(async () => {
        await tool.execute(
          { id: "call-789", name: "strictMethod", arguments: '{"requiredField": "test"}' },
          { requiredField: "test", numberField: "not-a-number" }, // Invalid type
        );
      }).rejects.toThrow("Invalid arguments");
    });

    it("processes magic __triggerLLMRequest property", async () => {
      const magicMethodToolDef = {
        description: "Returns magic",
        input: z.object({}),
      };

      const spec: ToolSpec = {
        type: "agent_durable_object_tool",
        methodName: "magicMethod",
        triggerLLMRequest: false, // Default is false
      };

      const mockMagicMethod = vi.fn().mockResolvedValue({
        data: "result",
        __triggerLLMRequest: true, // Override the default
      });
      const theDO = createMockDO(
        { magicMethod: magicMethodToolDef },
        { magicMethod: mockMagicMethod },
      );

      const results = await toolSpecsToImplementations({
        toolSpecs: [spec],
        theDO,
      });

      const tool = results[0] as any;
      const executeResult = await tool.execute(
        { id: "call-magic", name: "magicMethod", arguments: "{}" },
        {},
      );

      expect(executeResult.triggerLLMRequest).toBe(true);
      expect(executeResult.toolCallResult).toEqual({ data: "result" });
    });

    it("processes magic __pauseAgentUntilMentioned property", async () => {
      const pauseMethodToolDef = {
        description: "Pauses agent",
        input: z.object({}),
      };

      const spec: ToolSpec = {
        type: "agent_durable_object_tool",
        methodName: "pauseMethod",
      };

      const mockPauseMethod = vi.fn().mockResolvedValue({
        data: "paused",
        __pauseAgentUntilMentioned: true,
      });
      const theDO = createMockDO(
        { pauseMethod: pauseMethodToolDef },
        { pauseMethod: mockPauseMethod },
      );

      const results = await toolSpecsToImplementations({
        toolSpecs: [spec],
        theDO,
      });

      const tool = results[0] as any;
      const executeResult = await tool.execute(
        { id: "call-pause", name: "pauseMethod", arguments: "{}" },
        {},
      );

      expect(executeResult.addEvents).toBeDefined();
      expect(executeResult.addEvents).toHaveLength(1);
      expect(executeResult.addEvents[0]).toEqual({
        type: "CORE:PAUSE_LLM_REQUESTS",
        data: {},
        metadata: {},
        triggerLLMRequest: false,
      });
      expect(executeResult.toolCallResult).toEqual({ data: "paused" });
    });

    it("combines __addAgentCoreEvents with __pauseAgentUntilMentioned", async () => {
      const complexMethodToolDef = {
        description: "Complex method",
        input: z.object({}),
      };

      const spec: ToolSpec = {
        type: "agent_durable_object_tool",
        methodName: "complexMethod",
      };

      const mockComplexMethod = vi.fn().mockResolvedValue({
        data: "complex",
        __addAgentCoreEvents: [{ type: "CORE:SET_METADATA", data: { key: "value" } }],
        __pauseAgentUntilMentioned: true,
      });
      const theDO = createMockDO(
        { complexMethod: complexMethodToolDef },
        { complexMethod: mockComplexMethod },
      );

      const results = await toolSpecsToImplementations({
        toolSpecs: [spec],
        theDO,
      });

      const tool = results[0] as any;
      const executeResult = await tool.execute(
        { id: "call-complex", name: "complexMethod", arguments: "{}" },
        {},
      );

      expect(executeResult.addEvents).toHaveLength(2);
      expect(executeResult.addEvents[0].type).toBe("CORE:SET_METADATA");
      expect(executeResult.addEvents[1].type).toBe("CORE:PAUSE_LLM_REQUESTS");
    });
  });

  describe("sanitizeToolName", () => {
    it("replaces invalid characters with underscores", () => {
      expect(sanitizeToolName("user.getProfile@v2")).toBe("user_getProfile_v2");
      expect(sanitizeToolName("my-tool-name")).toBe("my-tool-name");
      expect(sanitizeToolName("tool_with_underscores")).toBe("tool_with_underscores");
      expect(sanitizeToolName("tool!@#$%^&*()")).toBe("tool__________");
    });

    it("preserves valid characters", () => {
      expect(sanitizeToolName("validToolName123")).toBe("validToolName123");
      expect(sanitizeToolName("tool-with_dash-and_underscore")).toBe(
        "tool-with_dash-and_underscore",
      );
      expect(sanitizeToolName("UPPERCASE_tool")).toBe("UPPERCASE_tool");
    });

    it("returns 'tool' as fallback for empty result", () => {
      expect(sanitizeToolName("!@#$%^&*()")).toBe("__________");
      expect(sanitizeToolName("")).toBe("tool");
    });
  });

  describe("edge cases", () => {
    it("handles tool definitions without description", async () => {
      const noDescToolDef = {
        input: z.object({}),
        // No description provided
      };

      const spec: ToolSpec = {
        type: "agent_durable_object_tool",
        methodName: "noDesc",
      };

      const mockNoDesc = vi.fn();
      const theDO = createMockDO({ noDesc: noDescToolDef }, { noDesc: mockNoDesc });

      const results = await toolSpecsToImplementations({
        toolSpecs: [spec],
        theDO,
      });

      expect((results[0] as any).description).toBeNull();
    });

    it("handles tool definitions without input schema", async () => {
      const noInputToolDef = {
        description: "No input required",
        // No input schema
      };

      const spec: ToolSpec = {
        type: "agent_durable_object_tool",
        methodName: "noInput",
      };

      const mockNoInput = vi.fn().mockResolvedValue({ ok: true });
      const theDO = createMockDO({ noInput: noInputToolDef }, { noInput: mockNoInput });

      const results = await toolSpecsToImplementations({
        toolSpecs: [spec],
        theDO,
      });

      const tool = results[0] as any;
      const executeResult = await tool.execute(
        { id: "call-no-input", name: "noInput", arguments: "{}" },
        {},
      );

      expect(mockNoInput).toHaveBeenCalledWith({});
      expect(executeResult.toolCallResult).toEqual({ ok: true });
    });

    it("handles overrideInputJSONSchema", async () => {
      const overrideToolDef = {
        description: "Override test",
        input: z.object({ originalField: z.string() }),
      };

      const customSchema = {
        type: "object",
        properties: {
          customField: { type: "string" },
        },
        required: ["customField"],
      };

      const spec: ToolSpec = {
        type: "agent_durable_object_tool",
        methodName: "override",
        overrideInputJSONSchema: customSchema,
      };

      const mockOverride = vi.fn();
      const theDO = createMockDO({ override: overrideToolDef }, { override: mockOverride });

      const results = await toolSpecsToImplementations({
        toolSpecs: [spec],
        theDO,
      });

      // The parameters should use the override schema, not the original
      expect((results[0] as any).parameters.properties).toHaveProperty("customField");
      expect((results[0] as any).parameters.properties).not.toHaveProperty("originalField");
    });
  });
});
