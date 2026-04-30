/**
 * Resolve a ToolProviderDescriptor (wire format) into a ToolProvider (runtime interface).
 */

import { dispatchCallable } from "../callable/runtime.ts";
import type { CallableContext } from "../callable/types.ts";
import {
  DESCRIBE_TOOL_FUNCTION_NAME,
  type ToolProviderDescriptor,
  type ToolProvider,
} from "./types.ts";

export function resolveToolProviderDescriptor(
  descriptor: ToolProviderDescriptor,
  ctx: CallableContext,
): ToolProvider {
  return {
    async executeToolFunction(path, payload) {
      return await dispatchCallable({
        callable: descriptor.callable,
        payload: { path, payload },
        ctx,
      });
    },

    async describeToolFunctions() {
      const result = await dispatchCallable({
        callable: descriptor.callable,
        payload: { path: [DESCRIBE_TOOL_FUNCTION_NAME], payload: {} },
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

      return {
        typeDefinitions: `/** The "${descriptor.path.join(
          ".",
        )}" tool provider has not provided type information via __describe. */\n(...args: unknown[]) => Promise<unknown>`,
      };
    },
  };
}
