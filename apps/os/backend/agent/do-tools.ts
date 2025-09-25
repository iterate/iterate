import { z } from "zod";
import type { JSONSchema } from "zod/v4/core";
import type { AgentDurableObjectToolSpec, ToolSpec } from "./tool-schemas.ts";

export type RuntimeJsonSchema = {
  type: "query" | "mutation" | "subscription";
  inputJsonSchema: JSONSchema.JSONSchema;
  outputJsonSchema: JSONSchema.JSONSchema;
  metadata: Record<string, any>;
};

export type DOToolDef<Params, Result> = {
  description?: string;
  input?: z.ZodType<Params>;
  output?: z.ZodType<Awaited<Result>>;
};

export type DOToolDefinitions<DO> = {
  [K in keyof DO]?: DO[K] extends () => infer Result
    ? DOToolDef<{}, Result>
    : DO[K] extends (params: infer Params) => infer Result
      ? DOToolDef<Params, Result>
      : never;
};

/**
 * Define a record of tools that will be implemented by a Durable Object. The record can also be used to
 * get JSON schemas for each tool.
 *
 * @returns The record you passed in, with a compile-time only `$infer` property which has:
 * - `inputTypes` - A record of the input types for each tool. You can use to provide a type for each method in your implementation.
 * - `outputTypes` - A record of the output types for each tool. You can use this similarly, but probably don't need to - typescript will infer output types for you.
 * - `interface` - create a type alias with this like `type MyToolsInterface = typeof myTools.$infer.interface` then do `class MyDO implements MyToolsInterface {...}` to make sure you correctly implement the tools
 */
export const defineDOTools = <Tools extends Record<string, DOToolDef<any, any>>>(tools: Tools) => {
  return tools as Tools & {
    $infer: {
      inputTypes: {
        [K in keyof Tools]: Tools[K] extends DOToolDef<infer Params, any> ? Params : void;
      };
      outputTypes: {
        [K in keyof Tools]: Tools[K] extends DOToolDef<any, infer Result>
          ? z.infer<Result>
          : unknown;
      };
      interface: {
        [K in keyof Tools]: (
          params: z.infer<Tools[K]["input"]>,
        ) => Tools[K]["output"] extends undefined ? unknown : z.infer<Tools[K]["output"]>;
      };
    };
  };
};

export const LooseEmptyObject = z.looseObject({});
export const doToolDefinitionToRuntimeJsonSchema = (
  doToolDefinition: DOToolDefinitions<Record<string, unknown>>,
): Record<string, RuntimeJsonSchema> => {
  return Object.fromEntries(
    Object.entries(doToolDefinition).map(([key, _value]): [string, RuntimeJsonSchema] => {
      const runtimeJsonSchema: RuntimeJsonSchema = doToolToRuntimeJsonSchema(_value);
      return [key as string, runtimeJsonSchema];
    }),
  );
};

export function doToolToRuntimeJsonSchema(_value: unknown) {
  const value = _value as unknown as {
    description?: string;
    input?: z.ZodType<{}>;
    output?: z.ZodType<{}>;
  };
  const runtimeJsonSchema: RuntimeJsonSchema = {
    type: "mutation", // ?
    metadata: {},
    inputJsonSchema: {
      properties: {},
      ...z.toJSONSchema(value.input || LooseEmptyObject, {
        unrepresentable: "any",
        target: "draft-2020-12",
        io: "input",
      }),
    },
    outputJsonSchema: z.toJSONSchema(value.output || LooseEmptyObject, {
      unrepresentable: "any",
      target: "draft-2020-12",
      io: "output",
    }),
  };
  return runtimeJsonSchema;
}

export function createDOToolFactory<T extends ReturnType<typeof defineDOTools>>(definitions: T) {
  return Object.fromEntries(
    Object.keys(definitions).map((key) => {
      return [
        key,
        (toolSpec?: Omit<AgentDurableObjectToolSpec, "type" | "methodName">): ToolSpec => {
          return {
            type: "agent_durable_object_tool",
            methodName: key,
            ...toolSpec,
          };
        },
      ];
    }),
  ) as {
    [K in keyof T]: (
      toolSpec?: Omit<AgentDurableObjectToolSpec, "type" | "methodName">,
    ) => ToolSpec;
  };
}
