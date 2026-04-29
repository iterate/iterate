/**
 * Resolve a ToolProviderDescriptor (wire format) into a ToolProvider (runtime interface).
 */

import { dispatchCallable } from "../callable/runtime.ts";
import type { CallableContext } from "../callable/types.ts";
import type { ToolProviderDescriptor, ToolProvider } from "./types.ts";

export function resolveToolProviderDescriptor(
  descriptor: ToolProviderDescriptor,
  ctx: CallableContext,
): ToolProvider {
  return {
    async executeToolFunction(path, payload) {
      return await dispatchCallable({
        callable: descriptor.executeToolFunction,
        payload: { path, payload },
        ctx,
      });
    },

    async describeToolFunctions() {
      if (!descriptor.describeToolFunctions) {
        const pathLabel = descriptor.path.join(".");
        return {
          typeDefinitions: `/** The "${pathLabel}" tool provider has not provided type information. */\n(...args: unknown[]) => Promise<unknown>`,
        };
      }

      const result = await dispatchCallable({
        callable: descriptor.describeToolFunctions,
        payload: {},
        ctx,
      });

      if (
        result != null &&
        typeof result === "object" &&
        "typeDefinitions" in result &&
        typeof (result as Record<string, unknown>).typeDefinitions === "string"
      ) {
        return result as { typeDefinitions: string };
      }

      return { typeDefinitions: "(...args: unknown[]) => Promise<unknown>" };
    },
  };
}
