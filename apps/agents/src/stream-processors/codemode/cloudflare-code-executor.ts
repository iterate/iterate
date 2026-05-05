import { dispatchCallable } from "@iterate-com/shared/callable/runtime.ts";
import { CodemodeExecutor } from "@iterate-com/shared/codemode/executor";
import type { CodemodeCodeExecutor } from "@iterate-com/shared/stream-processors/codemode/code-executor";

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
  return async ({ script, env, toolProviders, webchat, signal }) => {
    const executor = new CodemodeExecutor({
      loader: deps.loader,
      globalOutbound: deps.outboundFetch,
    });

    return await executor.execute({
      code: script,
      signal,
      blockId: crypto.randomUUID(),
      onEvent() {},
      providers: [
        {
          path: ["builtin"],
          provider: {
            async executeToolFunction(path) {
              if (path.join(".") !== "answer") throw new Error(`Unknown builtin tool: ${path}`);
              return 42;
            },
            async describeToolFunctions() {
              return { typeDefinitions: "" };
            },
          },
        },
        {
          path: ["webchat"],
          provider: {
            async executeToolFunction(path, rawArgs) {
              return await webchat.callTool({ name: path.join("."), rawArgs });
            },
            async describeToolFunctions() {
              return { typeDefinitions: webchat.types };
            },
          },
        },
        ...toolProviders.map((provider) => ({
          path: [provider.slug],
          provider: {
            async executeToolFunction(path: string[], rawArgs: unknown) {
              return await dispatchCallable({
                callable: provider.executeCallable,
                payload: {
                  name: path.join("."),
                  args: Array.isArray(rawArgs) ? rawArgs : [rawArgs],
                },
                ctx: { env },
              });
            },
            async describeToolFunctions() {
              return { typeDefinitions: provider.types ?? "" };
            },
          },
        })),
      ],
    });
  };
}
