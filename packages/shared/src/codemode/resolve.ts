/**
 * Resolve a CallableToolProvider (wire format) into a ToolProvider (runtime interface).
 */

import { dispatchCallable } from "../callable/runtime.ts";
import type { CallableContext } from "../callable/types.ts";
import type { CallableToolProvider, ToolProvider, ToolProviderDescription } from "./types.ts";

const NO_TYPES_DESCRIPTION: ToolProviderDescription = {
  typeDefinitions: "(...args: unknown[]) => Promise<unknown>",
};

export function resolveCallableToolProvider(
  descriptor: CallableToolProvider,
  ctx: CallableContext,
): ToolProvider {
  return {
    async execute(path: string[], payload: unknown): Promise<unknown> {
      return await dispatchCallable({
        callable: descriptor.execute,
        payload: { path, payload },
        ctx,
      });
    },

    async describe(): Promise<ToolProviderDescription> {
      if (!descriptor.describe) {
        const pathLabel = descriptor.path.join(".");
        return {
          typeDefinitions: `/** The "${pathLabel}" tool provider has not provided type information. */\n${NO_TYPES_DESCRIPTION.typeDefinitions}`,
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
        return result as ToolProviderDescription;
      }

      return NO_TYPES_DESCRIPTION;
    },
  };
}
