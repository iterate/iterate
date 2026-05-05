import type { StreamEvent, StreamEventInput } from "../stream-processor.ts";

export type CodemodeEventInput = Omit<StreamEventInput, "payload"> & {
  payload?: unknown;
};

export type CodemodeProcessorSession = {
  append(input: CodemodeEventInput): Promise<StreamEvent>;
  callToolFunction(input: {
    path: string[];
    payload: unknown;
    scriptExecutionRequestedOffset?: number;
  }): Promise<unknown>;
  executeScript(input: { code: string }): Promise<StreamEvent>;
  getStreamPath(): Promise<string>;
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
  scriptExecutionRequestedOffset: number;
  session: CodemodeProcessorSession;
  signal: AbortSignal;
}) => Promise<CodemodeScriptExecutionResult>;
