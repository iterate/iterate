import { z } from "zod/v4";
import type { JSONSchema } from "zod/v4/core";
import type { JSONSerializable } from "../utils/type-helpers.ts";
import { makeJSONSchemaOpenAICompatible } from "./zod-to-openai-json-schema.ts";
import { hashToolSpec, type AgentCoreEventInput } from "./agent-core-schemas.ts";
import { doToolToRuntimeJsonSchema, type DOToolDef, type DOToolDefinitions } from "./do-tools.ts";
import {
  type AgentDurableObjectToolSpec,
  type RuntimeTool,
  type ToolSpec,
} from "./tool-schemas.ts";
import { parseMagicAgentInstructions } from "./magic.ts";
import { filterOptionalFieldsFromJSONSchema } from "./json-schema.ts";
import { subtractObjectPropsFromJSONSchema } from "./subtract-object-props-from-json-schema.ts";

/**
 * Sanitizes a tool name to match OpenAI's requirements: ^[a-zA-Z0-9_-]+$
 * Replaces any invalid characters with underscores
 */
export function sanitizeToolName(name: string): string {
  // Replace any character that's not alphanumeric, underscore, or dash with underscore
  const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, "_");

  // Ensure the result isn't empty (fallback to 'tool' if somehow everything gets replaced)
  return sanitized || "tool";
}

/** Extract magic properties and compose final response */
function processMagic(rawResult: unknown, toolSpec: ToolSpec) {
  const { magic, cleanedResult } = parseMagicAgentInstructions(rawResult);
  let addEvents = magic.__addAgentCoreEvents;
  if (magic.__pauseAgentUntilMentioned) {
    (addEvents ||= []).push({
      type: "CORE:PAUSE_LLM_REQUESTS",
      data: {},
      metadata: {},
      triggerLLMRequest: false,
    });
  }
  let triggerLLMRequest = true;
  if (typeof magic.__triggerLLMRequest === "boolean") {
    triggerLLMRequest = magic.__triggerLLMRequest;
  } else if (
    toolSpec.type === "serialized_callable_tool" ||
    toolSpec.type === "agent_durable_object_tool"
  ) {
    triggerLLMRequest = toolSpec.triggerLLMRequest !== false;
  }

  return {
    toolCallResult: (cleanedResult as JSONSerializable) || "",
    triggerLLMRequest,
    ...(addEvents && { addEvents: addEvents as AgentCoreEventInput[] }),
  };
}

/**
 * A bunch of hacks we do to make the JSON schema produced by zod more palatable to OpenAI + Iterate
 */
function fiddleWithJsonSchema(
  originalJsonSchema: JSONSchema.JSONSchema,
  /** Options for the hacks - these match the form of an AgentDurableObjectToolSpec `passThroughArgs` and `hideOptionalInputs` props */
  options: Pick<AgentDurableObjectToolSpec, "passThroughArgs" | "hideOptionalInputs">,
) {
  let jsonSchema = structuredClone(originalJsonSchema); // deep since we're going to modify deeply-nested properties
  jsonSchema = subtractObjectPropsFromJSONSchema(jsonSchema, options?.passThroughArgs || {});

  // Save the original schema with correct required arrays before makeJSONSchemaOpenAICompatible modifies them.
  const schemaBeforeOpenAIModification = options?.hideOptionalInputs
    ? structuredClone(jsonSchema)
    : null;

  // This is a function Andy has written a while back
  // We had a problem where the JSON schema for some trpc procedure zod schemas was always rejected by openai
  // so we made this. But it may be broken! If so, you can try removing this line to see if your particular schema
  // suddenly works.
  makeJSONSchemaOpenAICompatible(jsonSchema);

  // Apply optional field filtering if hideOptionalInputs is true
  // NOTE: We use the schema from BEFORE makeJSONSchemaOpenAICompatible because that function
  // overwrites the required arrays to include all properties
  if (options?.hideOptionalInputs && schemaBeforeOpenAIModification) {
    jsonSchema = filterOptionalFieldsFromJSONSchema(schemaBeforeOpenAIModification);
    // We need to make it OpenAI compatible again after filtering
    makeJSONSchemaOpenAICompatible(jsonSchema);
  }

  return jsonSchema;
}

export type DOWithToolDefinitions = {
  toolDefinitions: () => DOToolDefinitions<Record<string, unknown>>;
};

/**
 * Batch convert tool specifications to their runtime implementations
 *
 * @param params - Object containing specs, env, and agentCallableOpts
 * @returns A promise that resolves to an array of runtime tool implementations
 */
// todo: move this to agent.ts - it's only used there
export function toolSpecsToImplementations(params: {
  toolSpecs: ToolSpec[];
  theDO: DOWithToolDefinitions;
}): RuntimeTool[] {
  return params.toolSpecs.reduce((acc, spec) => {
    if (spec.type === "openai_builtin") {
      return [...acc, spec.openAITool];
    }
    if (spec.type === "serialized_callable_tool") {
      throw new Error("SerializedCallableToolSpec not implemented");
    }
    if (spec.type === "agent_durable_object_tool") {
      const { methodName, passThroughArgs } = spec;
      if (typeof (params.theDO as any)[methodName] !== "function") {
        throw new Error(`methodName ${methodName} is not a function on the Durable Object`);
      }

      spec = { ...spec, overrideName: spec.overrideName || spec.methodName };
      const toolDefinitions = params.theDO.toolDefinitions();
      if (!(methodName in toolDefinitions)) {
        throw new Error(`methodName ${methodName} not found in doToolDefinitions`);
      }
      const def = toolDefinitions[methodName] as unknown as DOToolDef<{}, any>;
      const doToolRuntimeJsonSchema = doToolToRuntimeJsonSchema(def);
      const inputJsonSchema = fiddleWithJsonSchema(
        spec.overrideInputJSONSchema || doToolRuntimeJsonSchema.inputJsonSchema,
        spec,
      );
      const tool: RuntimeTool = {
        type: "function",
        name: spec.overrideName || sanitizeToolName(spec.methodName),
        metadata: { source: "durable-object", toolSpecHash: hashToolSpec(spec) },
        parameters: inputJsonSchema,
        // we default strict mode to false because then we can allow the LLM to call us with "any object"
        strict: false,
        description: spec.overrideDescription || def?.description || null,
        execute: async (_openaiExecuteParams, methodParams) => {
          const combinedArgs = { ...(methodParams as {}), ...(passThroughArgs as {}) };
          const validatedArgs = def?.input
            ? def.input.safeParse(combinedArgs)
            : ({ success: true, data: combinedArgs } as const);
          if (!validatedArgs.success) {
            throw new Error(`Invalid arguments: ${z.prettifyError(validatedArgs.error)}`);
          }
          const result = await (params.theDO as any)[methodName](validatedArgs.data);
          return processMagic(result, spec);
        },
      };
      return [...acc, tool];
    }
    return acc;
  }, [] as RuntimeTool[]);
}
