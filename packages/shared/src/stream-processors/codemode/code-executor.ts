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
  env: Record<string, string>;
  logger: CodemodeProcessorLogger;
  scriptExecutionId: string;
  session: CodemodeProcessorSession;
  signal: AbortSignal;
}) => Promise<CodemodeScriptExecutionResult>;
