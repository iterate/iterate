import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import type { AppConfig } from "~/app.ts";
import { buildCodemodeContractContext } from "~/lib/codemode-contract-runtime.ts";
import { buildCodemodeWrapperSource } from "~/lib/codemode-v2.ts";

export interface CodemodeExecutionResult {
  result: string;
  logs: string[];
  error: string | null;
}

function stringifyUnknown(value: unknown) {
  if (typeof value === "string") return value;
  if (typeof value === "undefined") return "undefined";

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export async function executeCodemodeFunction(options: {
  code: string;
  config: AppConfig;
  loader: WorkerLoader;
}): Promise<CodemodeExecutionResult> {
  const contractContext = buildCodemodeContractContext(options.config);
  const executor = new DynamicWorkerExecutor({
    loader: options.loader,
    globalOutbound: null,
  });
  const response = await executor.execute(
    buildCodemodeWrapperSource({
      userCode: options.code,
      sandboxPrelude: contractContext.sandboxPrelude,
    }),
    [contractContext.provider],
  );

  return {
    result: stringifyUnknown(response.result),
    logs: response.logs ?? [],
    error: response.error ?? null,
  };
}
