import type { SerializedError } from "../errors.ts";
import type { MetaMcpTools } from "../metamcp/tools.ts";

export type MetaMcpExecutionResult =
  | { success: true; logs: string[]; result: unknown }
  | { success: false; logs: string[]; error: SerializedError };

export interface MetaMcpExecutionEnvironment {
  readonly kind: string;
  execute(params: { code: string; tools: MetaMcpTools }): Promise<MetaMcpExecutionResult>;
}
