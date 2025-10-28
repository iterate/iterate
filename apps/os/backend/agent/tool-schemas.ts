import z from "zod";
import type { FunctionTool } from "openai/resources/responses/responses.mjs";
import { JSONSerializable } from "../utils/type-helpers.ts";
import { FunctionCall, OpenAIBuiltinTool } from "./openai-response-schemas.ts";
import type { AgentCoreEvent } from "./agent-core-schemas.ts";
export const IntegrationMode = z.enum(["personal", "company"]);
export type IntegrationMode = z.infer<typeof IntegrationMode>;

/*
 * Agents' serialized state contains events, which in turn contain SerializedToolSpec objects.
 *
 * There are different types of SerializedToolSpec objects:
 *  - OpenAIBuiltinToolSpec
 *    These are openai's built-in tools like file_search, web_search, etc.
 *  - AgentDurableObjectToolSpec
 *    This is a reference to a durable object method _on the agent instance_ that is running.
 *
 *  RuntimeTool is identical to openai's internal Tool type, except if `type: "function"`, it gains an additional execute method. Other than that we have
 *  - type - "function", "file_search", "web_search", "computer_use_preview", "mcp", "code_interpreter", "image_generation", "local_shell"
 *  - name
 *  - description
 *  - inputJSONSchema (either as zod or JSON schema)
 *  - strict - When true (default), the SDK returns a model error if the arguments don't validate. Set to false for fuzzy matching.
 */

export const AgentDurableObjectToolSpec = z.object({
  type: z.literal("agent_durable_object_tool"),
  methodName: z.string(),
  passThroughArgs: z.record(z.string(), JSONSerializable).nullable().optional(),
  overrideName: z.string().nullable().optional(),
  overrideDescription: z.string().nullable().optional(),
  overrideInputJSONSchema: z.any().nullable().optional(),
  strict: z.boolean().default(false).optional(), // When true (default), OpenAI returns a model error if the arguments don't validate. Set to false for fuzzy matching.
  triggerLLMRequest: z.boolean().default(true).optional(), // When true (default), the tool call triggers an LLM request after execution
  hideOptionalInputs: z.boolean().default(false).optional(), // When true, filters out optional fields from the JSON schema before execution
  statusIndicatorText: z.string().nullable().optional(), // Text to show in Slack typing indicator when this tool is being called
});
export type AgentDurableObjectToolSpec = z.infer<typeof AgentDurableObjectToolSpec>;

export const OpenAIBuiltinToolSpec = z.object({
  type: z.literal("openai_builtin"),
  openAITool: OpenAIBuiltinTool,
  triggerLLMRequest: z.boolean().default(true).optional(), // When true (default), the tool call triggers an LLM request after execution
  hideOptionalInputs: z.boolean().default(false).optional(), // When true, filters out optional fields from the JSON schema before execution
});
export type OpenAIBuiltinToolSpec = z.infer<typeof OpenAIBuiltinToolSpec>;

export const ToolSpec = z.discriminatedUnion("type", [
  OpenAIBuiltinToolSpec,
  AgentDurableObjectToolSpec,
]);

export type ToolSpec = z.infer<typeof ToolSpec>;

export const MCPParam = z.object({
  key: z.string(),
  type: z.enum(["header", "query_param"]),
  placeholder: z.string(),
  description: z.string(),
  sensitive: z.boolean(),
});

export type MCPParam = z.infer<typeof MCPParam>;

export const MCPServer = z.object({
  serverUrl: z.string(),
  mode: IntegrationMode.default("personal"),
  integrationSlug: z.string().optional(),
  allowedTools: z.array(z.string()).optional(),
  allowedPrompts: z.array(z.string()).optional(),
  allowedResources: z.array(z.string()).optional(),
  triggerLLMRequest: z.boolean().default(true).optional(),
  requiresParams: z.array(MCPParam).optional(),
});
export type MCPServer = z.infer<typeof MCPServer>;
export type MCPServerInput = z.input<typeof MCPServer>;

/**
 * Type definition for tool execution result.
 * Tools can control whether their execution triggers an LLM request by setting triggerLLMRequest.
 */
export type LocalFunctionToolExecuteResult<TEventInput = AgentCoreEvent> = {
  toolCallResult: JSONSerializable;
  triggerLLMRequest?: boolean;
  addEvents?: TEventInput[];
};

/**
 * Type definition for tool execution function.
 * This represents the implementation function for a tool that can be called by an agent.
 *
 */
export type LocalFunctionToolExecuteFunction<TEventInput = AgentCoreEvent> = (
  functionCall: FunctionCall,
  ...args: unknown[]
) => Promise<LocalFunctionToolExecuteResult<TEventInput>>;

export type LocalFunctionRuntimeTool<TEventInput = AgentCoreEvent> = FunctionTool & {
  canBeParallelized?: boolean; // If true, the tool can be called in parallel with other tools
  wrappers?: Array<
    (
      next: LocalFunctionToolExecuteFunction<TEventInput>,
    ) => LocalFunctionToolExecuteFunction<TEventInput>
  >;
  execute:
    | LocalFunctionToolExecuteFunction<TEventInput>
    | "MAKE SURE YOU DO NOT CALL THIS DIRECTLY WITHOUT RUNNING THE WRAPPERS FIRST! THERE IS A UTILITY FUNCTION FOR THIS IN AGENT-CORE.TS. YOU WILL ALSO NEED TO USE A CAST TO EXCLUDE THIS STUPID STRING FROM THE TYPE!";
  isAsync?: boolean; // If true, tool execution creates an ASYNC_TOOL_CALL_CREATED event
  statusIndicatorText?: string; // Text to show in Slack typing indicator when this tool is being called
  metadata?: {
    source?: "mcp" | "trpc" | "durable-object" | "worker";
    toolSpecHash?: string;
  };
};

export type RuntimeTool<TEventInput = AgentCoreEvent> =
  | OpenAIBuiltinTool
  | LocalFunctionRuntimeTool<TEventInput>;
