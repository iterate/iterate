// @ts-nocheck
import { describe, it, expect, vi } from "vitest";
import z from "zod";
import type { RuntimeJsonSchema } from "../../dispatcher.ts";
import { toolSpecsToImplementations } from "./tool-spec-to-runtime-tool.ts";
import type { ToolSpec, LocalFunctionRuntimeTool } from "./tool-schemas.ts";

describe.skip("toolSpecsToImplementations", () => {
  // Helper to create mocks
  const createMocks = () => ({
    runCallable: vi.fn().mockResolvedValue({ result: "success" }),
    getRuntimeJsonSchemas: vi
      .fn()
      .mockImplementation(async (callables) => callables.map(() => null)),
  });

  // Helper to create environment
  const createEnv = (mocks: ReturnType<typeof createMocks>) => ({
    PLATFORM: {
      runCallable: mocks.runCallable,
      getRuntimeJsonSchemas: mocks.getRuntimeJsonSchemas,
    },
  });

  const toolDefinitions = () => ({
    ping: {
      description: "Ping a durable object",
      input: z.object({}),
    },
  });

  describe("tool conversion", () => {
    it.each([
      {
        name: "OpenAI builtin tool - returned as-is",
        spec: {
          type: "openai_builtin",
          openAITool: {
            type: "web_search_preview" as const,
            search_context_size: "medium" as const,
          },
        },
        agentOpts: undefined,
        setupMocks: undefined,
        expectedTool: {
          type: "web_search_preview" as const,
          search_context_size: "medium" as const,
        },
      },
      {
        name: "TRPC procedure callable - basic conversion",
        spec: {
          type: "serialized_callable_tool",
          inputJSONSchema: null,
          callable: {
            type: "TRPC_PROCEDURE",
            workerName: "myWorker" as any,
            trpcProcedurePath: "user.getProfile",
            passThroughArgs: {},
          },
        },
        agentOpts: undefined,
        setupMocks: undefined,
        expectedTool: {
          type: "function",
          name: "myWorker_user_getProfile",
          description: null,
          parameters: null,
          strict: false,
        },
      },
      // Removed ability to invoke other DOs, for now, in order to simplify and focus on calling the agent's DO instance.
      // {
      //   name: "Durable object with runtime schema and passthrough args",
      //   spec: {
      //     type: "serialized_callable_tool",
      //     inputJSONSchema: null,
      //     callable: {
      //       type: "DURABLE_OBJECT_PROCEDURE",
      //       workerName: "myWorker" as any,
      //       durableObjectClassName: "MyDO" as any,
      //       procedureName: "process" as any,
      //       durableObjectName: "instance-123" as any,
      //       passThroughArgs: { internalId: "internal-123" },
      //     },
      //   },
      //   agentOpts: undefined,
      //   setupMocks: (mocks: ReturnType<typeof createMocks>) => {
      //     const runtimeSchema: RuntimeJsonSchema = {
      //       inputJsonSchema: {
      //         type: "object",
      //         properties: {
      //           name: { type: "string" },
      //           internalId: { type: "string" },
      //         },
      //         required: ["name", "internalId"],
      //       },
      //       outputJsonSchema: { type: "object" },
      //       metadata: { description: "Processes data" },
      //     };
      //     mocks.getRuntimeJsonSchemas.mockResolvedValue([runtimeSchema]);
      //   },
      //   expectedTool: {
      //     type: "function",
      //     name: "myWorker_MyDO_process",
      //     description: "Processes data",
      //     // internalId should be removed from parameters due to passThroughArgs
      //     parameters: {
      //       type: "object",
      //       properties: {
      //         name: { type: "string" },
      //       },
      //       required: ["name"],
      //       additionalProperties: false,
      //     },
      //     strict: false,
      //   },
      // },
      {
        name: "Agent durable object tool",
        spec: {
          type: "agent_durable_object_tool",
          methodName: "ping",
          passThroughArgs: { contextId: "ctx-123" },
        },
        agentOpts: {
          workerName: "agent" as any,
          durableObjectClassName: "IterateAgent" as any,
          durableObjectName: "agent-instance-456" as any,
        },
        setupMocks: undefined,
        expectedTool: {
          type: "function",
          name: "ping",
          description: expect.any(String),
          parameters: expect.objectContaining({ type: "object" }),
          metadata: expect.objectContaining({ source: "durable-object" }),
          strict: false,
        },
      },
      {
        name: "Spec overrides take precedence",
        spec: {
          type: "serialized_callable_tool",
          inputJSONSchema: null,
          callable: {
            type: "TRPC_PROCEDURE",
            workerName: "myWorker" as any,
            trpcProcedurePath: "user.update",
            passThroughArgs: {},
          },
          overrideName: "customName",
          overrideDescription: "Custom description",
          overrideInputJSONSchema: { type: "object", properties: { id: { type: "number" } } },
          strict: true,
        },
        agentOpts: undefined,
        setupMocks: (mocks: ReturnType<typeof createMocks>) => {
          // Runtime schema should be overridden
          mocks.getRuntimeJsonSchemas.mockResolvedValue([
            {
              inputJsonSchema: { type: "object", properties: { name: { type: "string" } } },
              outputJsonSchema: { type: "object" },
              metadata: { description: "Runtime description" },
            },
          ]);
        },
        expectedTool: {
          type: "function",
          name: "customName",
          description: "Custom description",
          parameters: {
            type: "object",
            properties: { id: { type: "number" } },
            additionalProperties: false,
          },
          strict: true,
        },
      },
      {
        name: "hideOptionalInputs filters out optional fields",
        spec: {
          type: "serialized_callable_tool",
          inputJSONSchema: null,
          callable: {
            type: "TRPC_PROCEDURE",
            workerName: "myWorker" as any,
            trpcProcedurePath: "user.create",
            passThroughArgs: {},
          },
          hideOptionalInputs: true,
          strict: true,
        },
        agentOpts: undefined,
        setupMocks: (mocks: ReturnType<typeof createMocks>) => {
          const runtimeSchema: RuntimeJsonSchema = {
            inputJsonSchema: {
              type: "object",
              properties: {
                name: { type: "string", description: "User's name" },
                email: { type: "string", description: "User's email" },
                age: { type: "number", description: "User's age (optional)" },
                address: {
                  type: "object",
                  properties: {
                    street: { type: "string" },
                    city: { type: "string" },
                    country: { type: "string" },
                    zipCode: { type: "string" },
                  },
                  required: ["street", "city"],
                },
              },
              required: ["name", "email", "address"],
            },
            outputJsonSchema: { type: "object" },
            metadata: { description: "Creates a new user" },
          };
          mocks.getRuntimeJsonSchemas.mockResolvedValue([runtimeSchema]);
        },
        expectedTool: {
          type: "function",
          name: "myWorker_user_create",
          description: "Creates a new user",
          // Only required fields should remain after filtering
          parameters: {
            type: "object",
            properties: {
              name: { type: "string", description: "User's name" },
              email: { type: "string", description: "User's email" },
              address: {
                type: "object",
                properties: {
                  street: { type: "string" },
                  city: { type: "string" },
                },
                required: ["street", "city"],
                additionalProperties: false,
              },
            },
            required: ["name", "email", "address"],
            additionalProperties: false,
          },
          strict: true,
        },
      },
      {
        name: "hideOptionalInputs works with overrideInputJSONSchema",
        spec: {
          type: "serialized_callable_tool",
          inputJSONSchema: null,
          callable: {
            type: "TRPC_PROCEDURE",
            workerName: "myWorker" as any,
            trpcProcedurePath: "data.process",
            passThroughArgs: {},
          },
          overrideInputJSONSchema: {
            type: "object",
            properties: {
              id: { type: "string" },
              title: { type: "string" },
              description: { type: "string" },
              tags: {
                type: "array",
                items: { type: "string" },
              },
              metadata: {
                type: "object",
                properties: {
                  author: { type: "string" },
                  createdAt: { type: "string" },
                  version: { type: "number" },
                },
                required: ["author"],
              },
            },
            required: ["id", "title"],
          },
          hideOptionalInputs: true,
          strict: true,
        },
        agentOpts: undefined,
        setupMocks: undefined,
        expectedTool: {
          type: "function",
          name: "myWorker_data_process",
          description: null,
          parameters: {
            type: "object",
            properties: {
              id: { type: "string" },
              title: { type: "string" },
            },
            required: ["id", "title"],
            additionalProperties: false,
          },
          strict: true,
        },
      },
      {
        name: "hideOptionalInputs filters even when strict is false",
        spec: {
          type: "serialized_callable_tool",
          inputJSONSchema: null,
          callable: {
            type: "TRPC_PROCEDURE",
            workerName: "myWorker" as any,
            trpcProcedurePath: "user.update",
            passThroughArgs: {},
          },
          hideOptionalInputs: true,
          strict: false, // explicitly false
        },
        agentOpts: undefined,
        setupMocks: (mocks: ReturnType<typeof createMocks>) => {
          const runtimeSchema: RuntimeJsonSchema = {
            inputJsonSchema: {
              type: "object",
              properties: {
                id: { type: "string" },
                name: { type: "string" },
                email: { type: "string" },
                age: { type: "number" },
              },
              required: ["id"],
            },
            outputJsonSchema: { type: "object" },
            metadata: { description: "Updates a user" },
          };
          mocks.getRuntimeJsonSchemas.mockResolvedValue([runtimeSchema]);
        },
        expectedTool: {
          type: "function",
          name: "myWorker_user_update",
          description: "Updates a user",
          // Only required fields should remain even though strict is false
          parameters: {
            type: "object",
            properties: {
              id: { type: "string" },
            },
            required: ["id"],
            additionalProperties: false,
          },
          strict: false,
        },
      },
    ])("$name", async ({ spec, agentOpts, setupMocks, expectedTool }) => {
      // Create mocks
      const mocks = createMocks();

      // Setup mocks if needed
      if (setupMocks) {
        setupMocks(mocks);
      }

      // Create environment
      const env = createEnv(mocks);

      // Run the function
      const results = await toolSpecsToImplementations({
        toolSpecs: [spec as ToolSpec],
        theDO: { env, toolDefinitions },
        agentCallableOpts: agentOpts,
      });
      const result = results[0];

      // Check if it has execute function (for non-builtin tools)
      if (expectedTool.type === "function") {
        expect(result).toHaveProperty("execute");
        expect(typeof (result as LocalFunctionRuntimeTool).execute).toBe("function");

        // Compare without execute function
        const { execute: _execute, ...resultWithoutExecute } = result as LocalFunctionRuntimeTool;
        expect(resultWithoutExecute).toEqual(expectedTool);
      } else {
        expect(result).toEqual(expectedTool);
      }
    });
  });

  describe("execute function", () => {
    it("should call runCallable with correct arguments", async () => {
      const mocks = createMocks();
      const env = createEnv(mocks);

      const results = await toolSpecsToImplementations({
        toolSpecs: [
          {
            type: "serialized_callable_tool",
            inputJSONSchema: null,
            callable: {
              type: "TRPC_PROCEDURE",
              workerName: "myWorker" as any,
              trpcProcedurePath: "test.method",
              passThroughArgs: {},
            },
          } as ToolSpec,
        ],
        theDO: { env, toolDefinitions },
      });
      const result = results[0];

      // Execute the function
      const executeResult = await (result as LocalFunctionRuntimeTool).execute(
        { id: "call-123", name: "test", arguments: '{"foo": "bar"}' } as any,
        { foo: "bar" },
      );

      expect(mocks.runCallable).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "TRPC_PROCEDURE",
          workerName: "myWorker",
          trpcProcedurePath: "test.method",
        }),
        { foo: "bar" },
      );
      expect(executeResult).toEqual({
        toolCallResult: { result: "success" },
        triggerLLMRequest: true,
      });
    });

    it("should throw error if multiple arguments are passed", async () => {
      const mocks = createMocks();
      const env = createEnv(mocks);

      const results = await toolSpecsToImplementations({
        toolSpecs: [
          {
            type: "serialized_callable_tool",
            inputJSONSchema: null,
            callable: {
              type: "TRPC_PROCEDURE",
              workerName: "myWorker" as any,
              trpcProcedurePath: "test.method",
              passThroughArgs: {},
            },
          } as ToolSpec,
        ],
        theDO: { env, toolDefinitions },
      });
      const result = results[0];

      // Try to execute with multiple arguments
      await expect(
        (result as LocalFunctionRuntimeTool).execute(
          { id: "call-123", name: "test", arguments: "{}" } as any,
          { foo: "bar" },
          { extra: "arg" },
        ),
      ).rejects.toThrow("Tool must be called with just a single argument that is a JSON object");
    });

    it("maps __triggerLLMRequest to triggerLLMRequest and cleans result", async () => {
      const mocks = createMocks();
      // Default would be false if spec.triggerLLMRequest is set to false; we will override via magic prop
      mocks.runCallable.mockResolvedValue({ ok: true, __triggerLLMRequest: true });
      const env = createEnv(mocks);

      const results = await toolSpecsToImplementations({
        toolSpecs: [
          {
            type: "serialized_callable_tool",
            inputJSONSchema: null,
            callable: {
              type: "TRPC_PROCEDURE",
              workerName: "myWorker" as any,
              trpcProcedurePath: "test.method",
              passThroughArgs: {},
            },
            // Set default to false to ensure magic prop overrides it
            triggerLLMRequest: false,
          } as ToolSpec,
        ],
        theDO: { env, toolDefinitions },
      });
      const tool = results[0] as LocalFunctionRuntimeTool;
      const exec = await tool.execute(
        { id: "call-xyz", name: tool.name, arguments: "{}" } as any,
        {},
      );

      expect(exec.triggerLLMRequest).toBe(true);
      expect(exec.toolCallResult).toEqual({ ok: true });
    });

    it("appends CORE:PAUSE_LLM_REQUESTS after __addAgentCoreEvents and cleans result", async () => {
      const mocks = createMocks();
      mocks.runCallable.mockResolvedValue({
        msg: "ok",
        __addAgentCoreEvents: [{ type: "CORE:SET_METADATA", data: { foo: "bar" } }],
        __pauseAgentUntilMentioned: true,
      });
      const env = createEnv(mocks);

      const results = await toolSpecsToImplementations({
        toolSpecs: [
          {
            type: "serialized_callable_tool",
            inputJSONSchema: null,
            callable: {
              type: "TRPC_PROCEDURE",
              workerName: "myWorker" as any,
              trpcProcedurePath: "test.method",
              passThroughArgs: {},
            },
          } as ToolSpec,
        ],
        theDO: { env, toolDefinitions },
      });

      const tool = results[0] as LocalFunctionRuntimeTool;
      const exec = await tool.execute(
        { id: "call-abc", name: tool.name, arguments: "{}" } as any,
        {},
      );

      expect(exec.toolCallResult).toEqual({ msg: "ok" });
      expect(Array.isArray(exec.addEvents)).toBe(true);
      expect(exec.addEvents?.length).toBe(2);
      expect(exec.addEvents?.[0].type).toBe("CORE:SET_METADATA");
      expect(exec.addEvents?.[1].type).toBe("CORE:PAUSE_LLM_REQUESTS");
    });
  });

  describe("error cases", () => {
    it.skip("should throw if agent instance name is missing", async () => {
      const mocks = createMocks();
      const env = createEnv(mocks);

      await expect(
        toolSpecsToImplementations({
          toolSpecs: [
            {
              type: "agent_durable_object_tool",
              methodName: "ping",
            } as ToolSpec,
          ],
          theDO: { env, toolDefinitions },
        }),
      ).rejects.toThrow("agentCallableOpts is required for agent_durable_object_tool");
    });
  });

  describe("tool name sanitization", () => {
    it("should sanitize tool names to match OpenAI requirements", async () => {
      const mocks = createMocks();
      const env = createEnv(mocks);

      const result = await toolSpecsToImplementations({
        toolSpecs: [
          {
            type: "serialized_callable_tool",
            inputJSONSchema: null,
            callable: {
              type: "TRPC_PROCEDURE",
              workerName: "myWorker" as any,
              trpcProcedurePath: "user.getProfile@v2",
              passThroughArgs: {},
            },
          } as ToolSpec,
        ],
        theDO: { env, toolDefinitions }, // no do tools
      });

      // The generated name would be "myWorker_user.getProfile@v2"
      // After sanitization it should be "myWorker_user_getProfile_v2"
      expect((result[0] as LocalFunctionRuntimeTool).name).toBe("myWorker_user_getProfile_v2");
    });
  });
});
