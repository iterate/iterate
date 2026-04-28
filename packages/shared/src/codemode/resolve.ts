/**
 * Resolve a CallableToolProvider (wire format) into a ToolProvider (runtime interface).
 */

import { dispatchCallable } from "../callable/runtime.ts";
import type { CallableContext } from "../callable/types.ts";
import type { CallableToolProvider, ToolProvider } from "./types.ts";

export function resolveCallableToolProvider(
  descriptor: CallableToolProvider,
  ctx: CallableContext,
): ToolProvider {
  return {
    async execute(path, payload) {
      return await dispatchCallable({
        callable: descriptor.execute,
        payload: { path, payload },
        ctx,
      });
    },

    async describe() {
      if (!descriptor.describe) {
        const pathLabel = descriptor.path.join(".");
        return {
          typeDefinitions: `/** The "${pathLabel}" tool provider has not provided type information. */\n(...args: unknown[]) => Promise<unknown>`,
        };
      }

      const result = await dispatchCallable({
        callable: descriptor.describe,
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
