import type { Callable } from "../callable/types.ts";
import type { ToolProviderDescriptor } from "./types.ts";

type JSONValue = null | boolean | number | string | JSONValue[] | { [key: string]: JSONValue };

export type SelfToolProviderEntrypoint = {
  workerScriptName: string;
  entrypoint: string;
};

export type SelfToolProviderDescriptorInput = SelfToolProviderEntrypoint & {
  path: string[];
  providerProps?: JSONValue;
  bindingName?: string;
  executeToolFunctionMethod?: string;
};

export function selfToolProviderBindingName(input: SelfToolProviderEntrypoint) {
  return `SELF_TOOL_PROVIDER_${input.workerScriptName}_${input.entrypoint}`
    .replace(/[^A-Za-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .toUpperCase();
}

/**
 * Create a Provider Descriptor that points back to a named WorkerEntrypoint on
 * the app worker that minted it.
 *
 * This deliberately uses an env service binding rather than `loopback-binding`.
 * The descriptor may be stored in a Codemode Session and dispatched by a
 * different worker later, so "self" must resolve to the original worker script,
 * not to the currently dispatching worker's `ctx.exports`.
 */
export function createSelfToolProviderDescriptor(
  input: SelfToolProviderDescriptorInput,
): ToolProviderDescriptor {
  const via = {
    type: "env-binding" as const,
    bindingType: "service" as const,
    bindingName:
      input.bindingName ??
      selfToolProviderBindingName({
        workerScriptName: input.workerScriptName,
        entrypoint: input.entrypoint,
      }),
  };

  return {
    path: input.path,
    callable: createSelfToolProviderCallable({
      via,
      rpcMethod: input.executeToolFunctionMethod ?? "executeToolFunction",
      providerProps: input.providerProps,
    }),
  };
}

function createSelfToolProviderCallable(input: {
  via: Extract<Callable, { type: "workers-rpc" }>["via"];
  rpcMethod: string;
  providerProps: JSONValue | undefined;
}): Callable {
  return {
    type: "workers-rpc",
    via: input.via,
    rpcMethod: input.rpcMethod,
    ...(input.providerProps === undefined
      ? {}
      : {
          transformInput: {
            shallowMerge: {
              providerProps: input.providerProps,
            },
          },
        }),
  };
}
