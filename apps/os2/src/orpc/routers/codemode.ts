import { CodemodeExecutor } from "@iterate-com/shared/codemode/executor";
import { resolveToolProviderDescriptor } from "@iterate-com/shared/codemode/resolve";
import { validateProviderPaths } from "@iterate-com/shared/codemode/validate";
import type { CodemodeEvent, ToolProviderDescriptor } from "@iterate-com/shared/codemode/types";
import type { CallableContext } from "@iterate-com/shared/callable/types.ts";
import { deriveDurableObjectNameFromInitParams } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
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

      if (context.codemodeSession) {
        const streamPath = input.streamPath ?? defaultStreamPathForBlock(blockId);
        const duplicateProviderPath = findDuplicateProviderPath(input.providers.map((p) => p.path));
        if (duplicateProviderPath) {
          yield {
            blockId,
            timestamp: now(),
            type: "codemode-block-result-added",
            result: undefined,
            error: `Duplicate provider path: ${duplicateProviderPath}`,
          };
          return;
        }

        const sessionName = deriveDurableObjectNameFromInitParams({
          initParams: { streamPath },
        });
        const session = context.codemodeSession.getByName(
          sessionName,
        ) as unknown as CodemodeSessionRpcStub;
        await session.initialize({ name: sessionName, streamPath });

        for (const provider of input.providers) {
          if (signal?.aborted) return;
          const event = await session.registerToolProvider({ provider });
          const eventOffset = (event as { offset: number }).offset;
          yield {
            blockId,
            timestamp: now(),
            type: "codemode-tool-provider-registered",
            path: provider.path,
          };
          context.log.info("os.codemode.tool-provider-registered", {
            eventOffset,
            path: provider.path,
            streamPath,
          });
        }

        if (signal?.aborted) return;

        yield { blockId, timestamp: now(), type: "codemode-block-added", code: input.code };
        const requestedEvent: unknown = await session.executeScript({ code: input.code });
        yield {
          blockId,
          timestamp: now(),
          type: "codemode-block-result-added",
          result: {
            event: requestedEvent,
            streamPath,
          },
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

      const callableCtx: CallableContext = {
        env: context.callableEnv ?? {},
        fetch: globalThis.fetch,
      };

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

    describe: os.codemode.describe
      .use(activeOrganizationMiddleware)
      .handler(async ({ input, context }) => {
        const callableCtx: CallableContext = {
          env: context.callableEnv ?? {},
          fetch: globalThis.fetch,
        };
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

function defaultStreamPathForBlock(blockId: string) {
  return `/codemode-sessions/${blockId}`;
}

function findDuplicateProviderPath(paths: string[][]) {
  const seen = new Set<string>();
  for (const path of paths) {
    const key = path.join(".");
    if (seen.has(key)) return key;
    seen.add(key);
  }

  return null;
}

type CodemodeSessionRpcStub = {
  initialize(params: { name: string; streamPath: string }): Promise<unknown>;
  registerToolProvider(input: { provider: ToolProviderDescriptor }): Promise<unknown>;
  executeScript(input: { code: string }): Promise<unknown>;
};
