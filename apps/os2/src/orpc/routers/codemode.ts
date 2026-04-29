import { CodemodeExecutor } from "@iterate-com/shared/codemode/executor";
import { resolveToolProviderDescriptor } from "@iterate-com/shared/codemode/resolve";
import { validateProviderPaths } from "@iterate-com/shared/codemode/validate";
import type { CodemodeEvent } from "@iterate-com/shared/codemode/types";
import type { CallableContext } from "@iterate-com/shared/callable/types.ts";
import { activeOrganizationMiddleware, os } from "~/orpc/orpc.ts";

export const codemodeRouter = {
  codemode: {
    execute: os.codemode.execute.use(activeOrganizationMiddleware).handler(async function* ({
      input,
      context,
      signal,
    }) {
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

      if (signal?.aborted) return;

      const callableCtx: CallableContext = { env: {}, fetch: globalThis.fetch };

      for (const provider of input.providers) {
        if (signal?.aborted) return;
        yield {
          blockId,
          timestamp: now(),
          type: "codemode-tool-provider-registered",
          path: provider.path,
        };
      }

      const resolvedProviders = [];
      for (const descriptor of input.providers) {
        if (signal?.aborted) return;
        const resolved = resolveToolProviderDescriptor(descriptor, callableCtx);
        resolvedProviders.push({ path: descriptor.path, provider: resolved });

        if (descriptor.describeToolFunctions) {
          try {
            const description = await resolved.describeToolFunctions();
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

      if (signal?.aborted) return;

      yield { blockId, timestamp: now(), type: "codemode-block-added", code: input.code };

      const events: CodemodeEvent[] = [];
      const executor = new CodemodeExecutor({ loader: context.loader });

      const result = await executor.execute({
        code: input.code,
        providers: resolvedProviders,
        blockId,
        onEvent: (event) => events.push(event),
        signal,
      });

      for (const event of events) {
        yield event;
      }

      yield {
        blockId,
        timestamp: now(),
        type: "codemode-block-result-added",
        result: result.result,
        error: result.error,
      };
    }),

    describe: os.codemode.describe.use(activeOrganizationMiddleware).handler(async ({ input }) => {
      const callableCtx: CallableContext = { env: {}, fetch: globalThis.fetch };
      const typeBlocks: string[] = [];

      for (const descriptor of input.providers) {
        const resolved = resolveToolProviderDescriptor(descriptor, callableCtx);
        try {
          const description = await resolved.describeToolFunctions();
          typeBlocks.push(description.typeDefinitions);
        } catch (err) {
          typeBlocks.push(
            `/** Error loading types for "${descriptor.path.join(".")}": ${err instanceof Error ? err.message : String(err)} */`,
          );
        }
      }

      return { typeDefinitions: typeBlocks.join("\n\n") };
    }),
  },
};

function generateBlockId() {
  const chars = "0123456789abcdefghijklmnopqrstuvwxyz";
  let id = "cblk_";
  for (let i = 0; i < 16; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}
