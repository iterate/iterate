import { normalizeCode } from "@cloudflare/codemode";
import { createWorker } from "@cloudflare/worker-bundler";
import type { CodemodeInput, CodemodeSource } from "@iterate-com/codemode-contract";
import type { AppConfig } from "~/app.ts";
import {
  buildCodemodeExecutionBundle,
  DynamicWorkerExecutor,
  type ResolvedProvider,
  type WorkerBundleDefinition,
} from "~/lib/codemode/executor.ts";
import { buildCodemodeContextFromSources } from "~/lib/codemode-contract-runtime.ts";
import {
  formatIterateSecretReference,
  parseGetIterateSecretInput,
} from "~/lib/codemode-secret-injection.ts";

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

function mergeCompatibilityFlags(...groups: Array<string[] | undefined>) {
  return [...new Set(groups.flatMap((group) => group ?? []))];
}

function isModuleScript(script: string) {
  return /^\s*(import|export)\b/m.test(script);
}

function buildCompiledScriptModuleSource(script: string) {
  if (isModuleScript(script)) {
    return script;
  }

  return `export default ${normalizeCode(script)};`;
}

function createRuntimeProvider(): ResolvedProvider {
  return {
    name: "codemodeRuntime",
    fns: {
      getIterateSecret: async (input) => {
        const { secretKey } = parseGetIterateSecretInput(input);
        return formatIterateSecretReference(secretKey);
      },
    },
  };
}

async function bundleCodemodeInput(options: {
  input: CodemodeInput;
  providers: ResolvedProvider[];
  sandboxPrelude: string;
}): Promise<WorkerBundleDefinition> {
  if (options.input.type === "compiled-script") {
    return buildCodemodeExecutionBundle({
      userModulePath: "user-script.js",
      userModules: {
        "user-script.js": buildCompiledScriptModuleSource(options.input.script),
      },
      providers: options.providers,
      sandboxPrelude: options.sandboxPrelude,
      getSecretProviderName: "codemodeRuntime",
    });
  }

  const bundle = await createWorker({
    files: options.input.files,
    entryPoint: options.input.entryPoint,
  });

  return {
    ...buildCodemodeExecutionBundle({
      userModulePath: bundle.mainModule,
      userModules: bundle.modules,
      providers: options.providers,
      sandboxPrelude: options.sandboxPrelude,
      getSecretProviderName: "codemodeRuntime",
    }),
    compatibilityDate: bundle.wranglerConfig?.compatibilityDate ?? "2025-06-01",
    compatibilityFlags: mergeCompatibilityFlags(
      ["nodejs_compat", "global_fetch_strictly_public"],
      bundle.wranglerConfig?.compatibilityFlags,
    ),
  };
}

export async function executeCodemodeFunction(options: {
  input: CodemodeInput;
  config: AppConfig;
  loader: WorkerLoader;
  outbound: Fetcher;
  sources?: CodemodeSource[];
}): Promise<CodemodeExecutionResult> {
  const contractContext = await buildCodemodeContextFromSources({
    config: options.config,
    sources: options.sources,
    includeTypes: false,
    fetch: (input, init) =>
      options.outbound.fetch(
        input instanceof Request ? new Request(input, init) : new Request(input, init),
      ),
  });

  const providers = [...contractContext.providers, createRuntimeProvider()];
  const bundle = await bundleCodemodeInput({
    input: options.input,
    providers,
    sandboxPrelude: contractContext.sandboxPrelude,
  });

  const executor = new DynamicWorkerExecutor({
    loader: options.loader,
    globalOutbound: options.outbound,
  });
  const response = await executor.executeWorkerBundle(bundle, providers);

  return {
    result: typeof response.result === "undefined" ? "" : stringifyUnknown(response.result),
    logs: response.logs ?? [],
    error: response.error ?? null,
  };
}
