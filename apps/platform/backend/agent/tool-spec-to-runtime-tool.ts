// import type { ResponseFunctionToolCall } from "openai/resources/responses/responses.mjs";
// import { z } from "zod/v4";
// import type { JSONSchema } from "zod/v4/core";
// import { makeJSONSchemaOpenAICompatible } from "./zod-to-openai-json-schema.ts";
// import type { AgentCoreEventInput } from "./agent-core-schemas.ts";
// import { doToolToRuntimeJsonSchema, type DOToolDef, type DOToolDefinitions } from "./do-tools.ts";
// import {
//   type AgentDurableObjectToolSpec,
//   type LocalFunctionRuntimeTool,
//   type LocalFunctionToolExecuteResult,
//   type RuntimeTool,
//   type ToolSpec,
// } from "./tool-schemas.ts";
// import { parseMagicAgentInstructions } from "./magic.ts";
// import type { SerializedCallable } from "./callable.ts";
// import type { JSONSerializable } from "../utils/type-helpers.ts";

// // /**
// //  * Environment type that includes the PLATFORM binding
// //  */
// // type EnvWithPlatform = {
// //   PLATFORM: {
// //     runCallable: (
// //       callable: SerializedCallable,
// //       payload: JSONSerializable,
// //     ) => Promise<JSONSerializable>;
// //     getRuntimeJsonSchemas: (
// //       callables: GetRuntimeJsonSchemaCallable[],
// //     ) => Promise<(RuntimeJsonSchema | null)[]>;
// //   };
// // };

// /**
//  * Sanitizes a tool name to match OpenAI's requirements: ^[a-zA-Z0-9_-]+$
//  * Replaces any invalid characters with underscores
//  */
// export function sanitizeToolName(name: string): string {
//   // Replace any character that's not alphanumeric, underscore, or dash with underscore
//   const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, "_");

//   // Ensure the result isn't empty (fallback to 'tool' if somehow everything gets replaced)
//   return sanitized || "tool";
// }

// /**
//  * Helper function to build a runtime tool from spec, callable, and optional schema
//  */
// function buildRuntimeTool(
//   toolSpec: ToolSpec,
//   callable: SerializedCallable,
//   runtimeSchema: RuntimeJsonSchema | null | undefined,
//   _agentCallableOpts: Pick<DurableObjectCallable, "workerName" | "durableObjectClassName"> & {
//     durableObjectId: Branded<"DurableObjectId">;
//   }
// ): RuntimeTool {
//   // Generate a default name for the tool based on callable type
//   const generateDefaultName = (): string => {
//     switch (callable.type) {
//       case "TRPC_PROCEDURE":
//         return `${callable.workerName}_${callable.trpcProcedurePath}`;
//       case "DURABLE_OBJECT_PROCEDURE":
//         return `${callable.workerName}_${callable.durableObjectClassName}_${callable.procedureName}`;
//       case "WORKER_PROCEDURE":
//         return `${callable.workerName}_${callable.procedureName}`;
//       default:
//         return `unknown_${callable.type}`;
//     }
//   };

//   // Start with proper defaults for a complete OpenAI function tool
//   const openAIFunctionTool: Omit<LocalFunctionRuntimeTool, "execute"> = {
//     type: "function" as const,
//     name: generateDefaultName(),
//     parameters: null,
//     // we default strict mode to false because then we can allow the LLM to call us with "any object"
//     strict: false,
//     description: null,
//   };

//   // Apply strict mode from callable tools
//   if (
//     toolSpec.type === "serialized_callable_tool" ||
//     toolSpec.type === "agent_durable_object_tool"
//   ) {
//     openAIFunctionTool.strict = toolSpec.strict === undefined ? false : !!toolSpec.strict;
//   }

//   // First layer: Override with runtime schema if available
//   if (runtimeSchema) {
//     openAIFunctionTool.parameters = runtimeSchema.inputJsonSchema;
//     // Use the meta description if available (either via SafeDurableObject meta or via trpc procedure meta)
//     if (runtimeSchema.metadata.description) {
//       openAIFunctionTool.description = runtimeSchema.metadata.description;
//     }
//   }

//   // Second layer: Override with spec overrides for callable tools
//   if (
//     toolSpec.type === "serialized_callable_tool" ||
//     toolSpec.type === "agent_durable_object_tool"
//   ) {
//     if (toolSpec.overrideName) {
//       openAIFunctionTool.name = toolSpec.overrideName;
//     }
//     if (toolSpec.overrideDescription !== undefined) {
//       openAIFunctionTool.description = toolSpec.overrideDescription;
//     }
//     if (toolSpec.overrideInputJSONSchema !== undefined) {
//       openAIFunctionTool.parameters = toolSpec.overrideInputJSONSchema;
//     }
//   }

//   // Sanitize the tool name to ensure it matches OpenAI's requirements
//   openAIFunctionTool.name = sanitizeToolName(openAIFunctionTool.name);

//   // Now we take any passThroughArgs out of the JSON schema
//   if (openAIFunctionTool.parameters) {
//     // This is a function Jonas has written
//     // WARNING: It may well have bugs as it's not a trivial operation! In that case please add
//     // a failing test case and fix the function
//     const hideOptionalInputs =
//       toolSpec.type === "serialized_callable_tool" || toolSpec.type === "agent_durable_object_tool"
//         ? toolSpec.hideOptionalInputs
//         : false;

//     openAIFunctionTool.parameters = fiddleWithJsonSchema(openAIFunctionTool.parameters, {
//       passThroughArgs: callable.passThroughArgs,
//       hideOptionalInputs,
//     });
//   }

//   // Our implementation type is just the type openai expects, plus an `execute` function
//   // that AgentCore can run
//   return {
//     ...openAIFunctionTool,
//     execute: async (
//       _functionCall: ResponseFunctionToolCall,
//       ...args: unknown[]
//     ): Promise<LocalFunctionToolExecuteResult> => {
//       if (args.length > 1) {
//         throw new Error("Tool must be called with just a single argument that is a JSON object");
//       }
//       // Execute callable
//       const rawResult = await env.PLATFORM.runCallable(callable, args[0] as JSONSerializable);

//       return processMagic(rawResult, toolSpec);
//     },
//   };
// }

// /** Extract magic properties and compose final response */
// function processMagic(rawResult: unknown, toolSpec: ToolSpec) {
//   const { magic, cleanedResult } = parseMagicAgentInstructions(rawResult);
//   let addEvents = magic.__addAgentCoreEvents;
//   if (magic.__pauseAgentUntilMentioned) {
//     (addEvents ||= []).push({
//       type: "CORE:PAUSE_LLM_REQUESTS",
//       data: {},
//       metadata: {},
//       triggerLLMRequest: false,
//     });
//   }
//   let triggerLLMRequest = true;
//   if (typeof magic.__triggerLLMRequest === "boolean") {
//     triggerLLMRequest = magic.__triggerLLMRequest;
//   } else if (
//     toolSpec.type === "serialized_callable_tool" ||
//     toolSpec.type === "agent_durable_object_tool"
//   ) {
//     triggerLLMRequest = toolSpec.triggerLLMRequest !== false;
//   }

//   return {
//     toolCallResult: (cleanedResult as JSONSerializable) || "",
//     triggerLLMRequest,
//     ...(addEvents && { addEvents: addEvents as AgentCoreEventInput[] }),
//   };
// }

// /**
//  * A bunch of hacks we do to make the JSON schema produced by zod more palatable to OpenAI + Iterate
//  */
// function fiddleWithJsonSchema(
//   originalJsonSchema: JSONSchema.JSONSchema,
//   /** Options for the hacks - these match the form of an AgentDurableObjectToolSpec `passThroughArgs` and `hideOptionalInputs` props */
//   options: Pick<AgentDurableObjectToolSpec, "passThroughArgs" | "hideOptionalInputs">,
// ) {
//   let jsonSchema = originalJsonSchema;
//   jsonSchema = subtractObjectPropsFromJSONSchema(jsonSchema, options?.passThroughArgs || {});

//   // Save the original schema with correct required arrays before makeJSONSchemaOpenAICompatible modifies them
//   const schemaBeforeOpenAIModification = options?.hideOptionalInputs
//     ? JSON.parse(JSON.stringify(jsonSchema))
//     : null;

//   // This is a function Andy has written a while back
//   // We had a problem where the JSON schema for some trpc procedure zod schemas was always rejected by openai
//   // so we made this. But it may be broken! If so, you can try removing this line to see if your particular schema
//   // suddenly works.
//   makeJSONSchemaOpenAICompatible(jsonSchema);

//   // Apply optional field filtering if hideOptionalInputs is true
//   // NOTE: We use the schema from BEFORE makeJSONSchemaOpenAICompatible because that function
//   // overwrites the required arrays to include all properties
//   if (options?.hideOptionalInputs && schemaBeforeOpenAIModification) {
//     jsonSchema = filterOptionalFieldsFromJSONSchema(schemaBeforeOpenAIModification);
//     // We need to make it OpenAI compatible again after filtering
//     makeJSONSchemaOpenAICompatible(jsonSchema);
//   }

//   return jsonSchema;
// }

// /**
//  * Batch convert tool specifications to their runtime implementations
//  *
//  * @param params - Object containing specs, env, and agentCallableOpts
//  * @returns A promise that resolves to an array of runtime tool implementations
//  */
// // todo: move this to agent.ts - it's only used there
// export async function toolSpecsToImplementations<
//   T extends {
//     env: EnvWithPlatform;
//     toolDefinitions: () => DOToolDefinitions<Record<string, unknown>>;
//   },
// >(params: {
//   toolSpecs: ToolSpec[];
//   theDO: T;
//   agentCallableOpts: Pick<DurableObjectCallable, "workerName" | "durableObjectClassName"> & {
//     durableObjectId: Branded<"DurableObjectId">;
//   };
// }): Promise<RuntimeTool[]> {
//   const { toolSpecs, agentCallableOpts } = params;
//   const env = params.theDO.env;

//   // 1. First pass: map specs to intermediate results
//   type IntermediateResult =
//     | { type: "ready"; tool: RuntimeTool }
//     | { type: "needs-schema"; spec: ToolSpec; callable: SerializedCallable };

//   const intermediateResults: IntermediateResult[] = toolSpecs.map((spec) => {
//     // Handle openai_builtin tools immediately
//     if (spec.type === "openai_builtin") {
//       return { type: "ready", tool: spec.openAITool };
//     }

//     if (spec.type === "agent_durable_object_tool") {
//       spec = { ...spec, overrideName: spec.overrideName || spec.methodName };
//       const { methodName, passThroughArgs } = spec;
//       const toolDefinitions = params.theDO.toolDefinitions();
//       if (!(methodName in toolDefinitions)) {
//         throw new Error(`methodName ${methodName} not found in doToolDefinitions`);
//       }
//       const def = toolDefinitions[methodName] as unknown as DOToolDef<{}, any>;
//       const doToolRuntimeJsonSchema = doToolToRuntimeJsonSchema(def);
//       const inputJsonSchema = fiddleWithJsonSchema(
//         spec.overrideInputJSONSchema || doToolRuntimeJsonSchema.inputJsonSchema,
//         spec,
//       );
//       const tool: RuntimeTool = {
//         type: "function",
//         name:
//           spec.overrideName ||
//           sanitizeToolName(`${params.agentCallableOpts.durableObjectClassName}_${spec.methodName}`),
//         metadata: { source: "durable-object" },
//         parameters: inputJsonSchema,
//         // we default strict mode to false because then we can allow the LLM to call us with "any object"
//         strict: false,
//         description: spec.overrideDescription || def?.description || null,
//         execute: async (_openaiExecuteParams, methodParams) => {
//           const combinedArgs = { ...(methodParams as {}), ...(passThroughArgs as {}) };
//           const validatedArgs = def?.input
//             ? def.input.safeParse(combinedArgs)
//             : ({ success: true, data: combinedArgs } as const);
//           if (!validatedArgs.success) {
//             throw new Error(`Invalid arguments: ${z.prettifyError(validatedArgs.error)}`);
//           }
//           const result = await params.theDO[methodName](validatedArgs.data);
//           return processMagic(result, spec);
//         },
//       };

//       return { type: "ready", tool: tool };
//     }

//     const callable = spec.callable;
//     if (callable.type === "DURABLE_OBJECT_PROCEDURE") {
//       throw new Error(
//         `Calling ${callable.durableObjectClassName}.${callable.procedureName} as a callable not implemented.`,
//       );
//     }
//     if (callable.type === "TRPC_PROCEDURE") {
//       return { type: "needs-schema", spec, callable };
//     } else {
//       return {
//         type: "ready",
//         tool: buildRuntimeTool(spec, callable, null, agentCallableOpts, env),
//       };
//     }
//   });

//   const schemasWithIndices = intermediateResults.map((result, index) => ({ result, index }));
//   const specsNeedingSchemas = schemasWithIndices
//     .filter(({ result }) => result.type === "needs-schema")
//     .map(({ result, index }) => ({
//       index,
//       result: null as unknown as Awaited<
//         ReturnType<typeof env.PLATFORM.getRuntimeJsonSchemas>
//       >[number],
//       spec: (result as Extract<IntermediateResult, { type: "needs-schema" }>).spec,
//       callable: (result as Extract<IntermediateResult, { type: "needs-schema" }>).callable,
//     }));

//   // 3. Batch fetch all schemas if needed
//   if (specsNeedingSchemas.length) {
//     const results = await env.PLATFORM.getRuntimeJsonSchemas(
//       specsNeedingSchemas.map((s) => s.callable as GetRuntimeJsonSchemaCallable),
//     );
//     results.forEach((result, index) => {
//       specsNeedingSchemas[index].result = result;
//     });
//   }

//   const resolvedSchemasMap = Object.fromEntries(
//     specsNeedingSchemas.map((s) => [s.index, s.result]),
//   );
//   // 4. Final pass: map intermediate results to runtime tools
//   return intermediateResults.map((result, index) => {
//     if (result.type === "ready") {
//       return result.tool;
//     } else {
//       const schema = resolvedSchemasMap[index] || null;
//       return buildRuntimeTool(result.spec, result.callable, schema, agentCallableOpts, env);
//     }
//   });
// }
