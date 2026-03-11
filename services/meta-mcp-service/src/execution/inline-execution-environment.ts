import { inspect } from "node:util";
import { serializeError } from "../errors.ts";
import { logInfo, logWarn } from "../logger.ts";
import type { MetaMcpExecutionEnvironment, MetaMcpExecutionResult } from "./types.ts";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<unknown>;

function formatValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  return inspect(value, { depth: 4, breakLength: 120 });
}

export class InlineMetaMcpExecutionEnvironment<
  TTools extends Record<string, unknown>,
> implements MetaMcpExecutionEnvironment<TTools> {
  readonly kind = "inline";

  async execute(params: { code: string; tools: TTools }): Promise<MetaMcpExecutionResult> {
    const logs: string[] = [];
    const startedAt = Date.now();

    logInfo("starting inline metamcp execution", {
      codeLength: params.code.length,
      helperKeys: Object.keys(params.tools),
    });

    try {
      const fn = new AsyncFunction(
        "tools",
        "console",
        `return await (async () => {\n${params.code}\n})();`,
      );

      const consoleLike = {
        ...console,
        log: (...args: unknown[]) => logs.push(args.map(formatValue).join(" ")),
        warn: (...args: unknown[]) => logs.push(`[warn] ${args.map(formatValue).join(" ")}`),
        error: (...args: unknown[]) => logs.push(`[error] ${args.map(formatValue).join(" ")}`),
      };

      const result = await fn(params.tools, consoleLike);
      logInfo("inline metamcp execution completed", {
        durationMs: Date.now() - startedAt,
        logCount: logs.length,
      });
      return { result, logs };
    } catch (error) {
      logWarn("inline metamcp execution failed", {
        durationMs: Date.now() - startedAt,
        logCount: logs.length,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        result: null,
        logs,
        error: serializeError(error),
      };
    }
  }
}
