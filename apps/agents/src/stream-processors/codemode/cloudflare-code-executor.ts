import { dispatchCallable } from "@iterate-com/shared/callable/runtime.ts";
import type { CodemodeCodeExecutor } from "@iterate-com/shared/stream-processors/legacy-codemode/code-executor";

export type CloudflareCodemodeCodeExecutorDeps = {
  loader: WorkerLoader;
  outboundFetch: Fetcher;
};

/**
 * Cloudflare-specific adapter for codemode execution.
 *
 * This is deliberately outside `implementation.ts`. Processor implementations
 * should depend on small runtime interfaces, not import Worker loaders,
 * Cloudflare executor classes, or other deployment-specific handles directly.
 */
export function createCloudflareCodemodeCodeExecutor(
  deps: CloudflareCodemodeCodeExecutorDeps,
): CodemodeCodeExecutor {
  return async ({ script, env, toolProviders, webchat }) => {
    const [{ DynamicWorkerExecutor, resolveProvider }, { dynamicTools }] = await Promise.all([
      import("@cloudflare/codemode"),
      import("@cloudflare/codemode/dynamic"),
    ]);
    const executor = new DynamicWorkerExecutor({
      loader: deps.loader,
      globalOutbound: deps.outboundFetch,
    });

    const dynamicResolved = await Promise.all(
      toolProviders.map(async (provider) =>
        resolveProvider(
          dynamicTools({
            name: provider.slug,
            types: provider.types,
            callTool: (name, toolArgs) =>
              dispatchCallable({
                callable: provider.executeCallable,
                payload: { name, args: toolArgs },
                ctx: { env },
              }),
          }),
        ),
      ),
    );
    const webchatProvider = await resolveProvider(
      dynamicTools({
        name: "webchat",
        types: webchat.types,
        callTool: (name, rawArgs) => webchat.callTool({ name, rawArgs }),
      }),
    );

    return await executor.execute(script, [
      { name: "builtin", fns: { answer: async () => 42 } },
      webchatProvider,
      ...dynamicResolved,
    ]);
  };
}
