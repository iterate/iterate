import type { Callable } from "@iterate-com/shared/callable/types.ts";

export type CodemodeCodeExecutorToolProvider = {
  slug: string;
  executeCallable: Callable;
  types?: string;
};

export type CodemodeCodeExecutionResult = {
  result: unknown;
  error?: string;
  logs?: string[];
};

/**
 * Runtime dependency for executing codemode blocks.
 *
 * Keep concrete runtimes, such as Cloudflare's `DynamicWorkerExecutor`, behind
 * this interface. The codemode processor should only orchestrate stream state
 * and events; importing a specific execution runtime in the processor makes it
 * hard to run the same processor from Node tests, pull runners, Durable Object
 * runners, or future non-Cloudflare deployments.
 */
export type CodemodeCodeExecutor = (args: {
  script: string;
  env: Record<string, unknown>;
  signal: AbortSignal;
  toolProviders: readonly CodemodeCodeExecutorToolProvider[];
  webchat: {
    types: string;
    callTool(args: { name: string; rawArgs: unknown }): Promise<unknown>;
  };
}) => Promise<CodemodeCodeExecutionResult>;
