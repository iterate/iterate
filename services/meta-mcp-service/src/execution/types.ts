import { serializeError } from "../errors.ts";

export interface MetaMcpExecutionResult {
  result: unknown;
  logs: string[];
  error?: ReturnType<typeof serializeError>;
}

export interface MetaMcpExecutionEnvironment<TTools extends Record<string, unknown>> {
  readonly kind: string;
  execute(params: { code: string; tools: TTools }): Promise<MetaMcpExecutionResult>;
}
