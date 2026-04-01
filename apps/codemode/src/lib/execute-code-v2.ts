import type { CodemodeSource } from "@iterate-com/codemode-contract";
import type { AppConfig } from "~/app.ts";
import { DynamicWorkerExecutor } from "~/lib/codemode/index.ts";
import { buildCodemodeContextFromSources } from "~/lib/codemode-contract-runtime.ts";
import { createCodemodeOutboundFetch } from "~/lib/codemode-outbound-fetch.ts";
import { buildCodemodeWrapperSource } from "~/lib/codemode-v2.ts";

export interface CodemodeExecutionResult {
  result: string;
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
  outbound: Fetcher;
  sources?: CodemodeSource[];
}): Promise<CodemodeExecutionResult> {
  const outboundFetch = createCodemodeOutboundFetch(options.outbound);
  const contractContext = await buildCodemodeContextFromSources({
    config: options.config,
    sources: options.sources,
    includeTypes: false,
    fetch: outboundFetch,
  });
  const executor = new DynamicWorkerExecutor({
    loader: options.loader,
    globalOutbound: options.outbound,
  });
  const response = await executor.execute(
    buildCodemodeWrapperSource({
      userCode: options.code,
      sandboxPrelude: contractContext.sandboxPrelude,
    }),
    contractContext.providers,
  );

  const outputParts = [...(response.logs ?? [])];
  if (typeof response.result !== "undefined") {
    outputParts.push(stringifyUnknown(response.result));
  }

  return {
    result: outputParts.join("\n"),
    error: response.error ?? null,
  };
}
