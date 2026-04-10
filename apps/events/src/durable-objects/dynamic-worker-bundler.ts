import { basename, resolve } from "node:path";
import {
  DynamicWorkerConfiguredEventInput,
  type DynamicWorkerConfiguredEventInput as DynamicWorkerConfiguredEventInputType,
} from "@iterate-com/events-contract";
import { build } from "esbuild";

export type BuildDynamicWorkerConfiguredEventOptions = {
  compatibilityDate?: string;
  compatibilityFlags?: string[];
  entryFile: string;
  outboundGateway?: DynamicWorkerConfiguredEventInputType["payload"]["outboundGateway"];
  slug?: string;
};

export async function buildDynamicWorkerConfiguredEvent(
  options: BuildDynamicWorkerConfiguredEventOptions,
): Promise<DynamicWorkerConfiguredEventInputType> {
  const absoluteEntryFile = resolve(options.entryFile);
  const script = await bundleDynamicWorkerProcessor({
    absoluteEntryFile,
  });

  return DynamicWorkerConfiguredEventInput.parse({
    type: "https://events.iterate.com/events/stream/dynamic-worker/configured",
    payload: {
      slug: options.slug ?? slugFromEntryFile(absoluteEntryFile),
      ...(options.compatibilityDate != null
        ? { compatibilityDate: options.compatibilityDate }
        : {}),
      ...(options.compatibilityFlags != null && options.compatibilityFlags.length > 0
        ? { compatibilityFlags: options.compatibilityFlags }
        : {}),
      ...(options.outboundGateway != null ? { outboundGateway: options.outboundGateway } : {}),
      script,
    },
  });
}

export function slugFromEntryFile(entryFile: string) {
  return basename(entryFile).replace(/\.[^/.]+$/, "");
}

async function bundleDynamicWorkerProcessor(args: { absoluteEntryFile: string }) {
  const result = await build({
    bundle: true,
    entryPoints: [args.absoluteEntryFile],
    format: "esm",
    legalComments: "none",
    mainFields: ["browser", "module", "main"],
    minify: false,
    platform: "browser",
    sourcemap: false,
    target: "es2024",
    treeShaking: true,
    write: false,
    plugins: [aiEngineerWorkshopShimPlugin()],
  });

  const outputFile = result.outputFiles[0];
  if (outputFile == null) {
    throw new Error("esbuild produced no output when bundling the dynamic worker processor");
  }

  return outputFile.text.trim();
}

function aiEngineerWorkshopShimPlugin() {
  return {
    name: "ai-engineer-workshop-shim",
    setup(buildApi: import("esbuild").PluginBuild) {
      buildApi.onResolve({ filter: /^ai-engineer-workshop(?:\/runtime)?$/ }, () => ({
        namespace: "ai-engineer-workshop-shim",
        path: "ai-engineer-workshop",
      }));

      buildApi.onLoad({ filter: /.*/, namespace: "ai-engineer-workshop-shim" }, () => ({
        contents: `
export function defineProcessor(input) {
  return typeof input === "function" ? input() : input;
}

export function createEventsClient() {
  throw new Error("createEventsClient is not available in dynamic worker processor bundles.");
}

export class PullProcessorRuntime {
  constructor() {
    throw new Error(
      "PullProcessorRuntime is not available in dynamic worker processor bundles.",
    );
  }
}

export function runWorkshopMain() {
  throw new Error("runWorkshopMain is not available in dynamic worker processor bundles.");
}

export function normalizePathPrefix(pathPrefix) {
  return pathPrefix.startsWith("/") ? pathPrefix : \`/\${pathPrefix}\`;
}
        `.trim(),
        loader: "ts",
      }));
    },
  } satisfies import("esbuild").Plugin;
}
