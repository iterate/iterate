// Runtime interfaces between the codemode processor and the script executor.
// Ported verbatim from packages/shared/src/stream-processors/codemode/code-executor.ts
// as part of the class-based stream processor migration (the packages/shared
// copy is deleted at the end of the migration).

export type CodemodeProcessorSession = {
  callFunction(input: {
    args: unknown[];
    functionCallId?: string;
    path: string[];
    scriptExecutionId?: string;
  }): Promise<unknown>;
};

export type CodemodeProcessorLogger = {
  log(level: "error" | "log" | "warn", message: string): Promise<void>;
};

export type CodemodeScriptExecutionResult = {
  result: unknown;
  error?: unknown;
};

/**
 * Runtime dependency for executing codemode scripts.
 *
 * The processor owns stream state and event orchestration. Concrete runtimes
 * such as Cloudflare WorkerLoader adapters should live outside the contract and
 * satisfy this small interface.
 */
export type CodemodeScriptExecutor = (args: {
  code: string;
  logger: CodemodeProcessorLogger;
  scriptExecutionId: string;
  session: CodemodeProcessorSession;
  signal: AbortSignal;
  vars: Record<string, string>;
}) => Promise<CodemodeScriptExecutionResult>;
