import { os } from "~/orpc/orpc.ts";
import { CodemodeExecutor } from "@iterate-com/shared/codemode/executor";
import { resolveCallableToolProvider } from "@iterate-com/shared/codemode/resolve";
import { validateProviderPaths } from "@iterate-com/shared/codemode/validate";
import type {
  CallableToolProvider,
  CodemodeEvent,
  ToolProvider,
} from "@iterate-com/shared/codemode/types";
import type { CallableContext } from "@iterate-com/shared/callable/types.ts";

function generateBlockId(): string {
  const chars = "0123456789abcdefghijklmnopqrstuvwxyz";
  let id = "cblk_";
  for (let i = 0; i < 16; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

function generateCallId(): string {
  const chars = "0123456789abcdefghijklmnopqrstuvwxyz";
  let id = "ccal_";
  for (let i = 0; i < 12; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

export const codemodeRouter = {
  codemode: {
    execute: os.codemode.execute.handler(async function* ({ input, context, signal }) {
      const blockId = input.blockId || generateBlockId();
      const now = () => new Date().toISOString();

      if (!context.loader) {
        yield {
          blockId,
          timestamp: now(),
          type: "codemode-block-result-added",
          result: undefined,
          error:
            "LOADER binding not available — codemode execution requires a WorkerLoader binding",
        };
        return;
      }

      // Validate provider paths
      const validationError = validateProviderPaths(input.providers);
      if (validationError) {
        yield {
          blockId,
          timestamp: now(),
          type: "codemode-block-result-added",
          result: undefined,
          error: validationError,
        };
        return;
      }

      // Build callable context for resolving remote providers
      const callableCtx: CallableContext = {
        env: {},
        fetch: globalThis.fetch,
      };

      // 1. Emit provider-registered events
      for (const provider of input.providers) {
        yield {
          blockId,
          timestamp: now(),
          type: "codemode-tool-provider-registered",
          path: provider.path,
        };
      }

      // 2. Resolve providers and emit described events
      const resolvedProviders: Array<{ path: string[]; provider: ToolProvider }> = [];

      for (const descriptor of input.providers) {
        const resolved = resolveCallableToolProvider(descriptor, callableCtx);
        resolvedProviders.push({ path: descriptor.path, provider: resolved });

        if (descriptor.describe) {
          try {
            const description = await resolved.describe();
            yield {
              blockId,
              timestamp: now(),
              type: "codemode-tool-provider-described",
              path: descriptor.path,
              typeDefinitions: description.typeDefinitions,
            };
          } catch (err) {
            yield {
              blockId,
              timestamp: now(),
              type: "codemode-tool-provider-described",
              path: descriptor.path,
              typeDefinitions: `/** Error loading types for "${descriptor.path.join(".")}": ${err instanceof Error ? err.message : String(err)} */`,
            };
          }
        }
      }

      // 3. Emit block-added
      yield {
        blockId,
        timestamp: now(),
        type: "codemode-block-added",
        code: input.code,
      };

      // 4. Execute code with streaming events
      const events: CodemodeEvent[] = [];
      const executor = new CodemodeExecutor({
        loader: context.loader,
      });

      const result = await executor.execute({
        code: input.code,
        providers: resolvedProviders,
        blockId,
        onEvent: (event) => {
          events.push(event);
        },
        signal: signal ?? undefined,
      });

      // Yield all accumulated events from execution
      for (const event of events) {
        yield event as CodemodeEvent & Record<string, unknown>;
      }

      // 5. Emit block-result-added
      yield {
        blockId,
        timestamp: now(),
        type: "codemode-block-result-added",
        result: result.result,
        error: result.error,
      };
    }),

    describe: os.codemode.describe.handler(async ({ input, context }) => {
      const callableCtx: CallableContext = {
        env: {},
        fetch: globalThis.fetch,
      };

      const typeBlocks: string[] = [];

      for (const descriptor of input.providers) {
        const resolved = resolveCallableToolProvider(descriptor, callableCtx);
        try {
          const description = await resolved.describe();
          typeBlocks.push(description.typeDefinitions);
        } catch (err) {
          const pathLabel = descriptor.path.join(".");
          typeBlocks.push(
            `/** Error loading types for "${pathLabel}": ${err instanceof Error ? err.message : String(err)} */`,
          );
        }
      }

      return {
        typeDefinitions: typeBlocks.join("\n\n"),
      };
    }),
  },
};
