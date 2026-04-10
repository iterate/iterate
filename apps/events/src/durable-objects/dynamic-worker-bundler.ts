import { basename, resolve } from "node:path";
import {
  DynamicWorkerConfiguredEventInput,
  type DynamicWorkerConfiguredEventInput as DynamicWorkerConfiguredEventInputType,
} from "@iterate-com/events-contract";
import { build } from "esbuild";

type BuildDynamicWorkerConfiguredEventOptions = {
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
    compatibilityFlags: options.compatibilityFlags,
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

async function bundleDynamicWorkerProcessor(args: {
  absoluteEntryFile: string;
  compatibilityFlags?: string[];
}) {
  const result = await build({
    bundle: true,
    entryPoints: [args.absoluteEntryFile],
    external: shouldExternalizeNodeBuiltins(args.compatibilityFlags) ? ["node:*"] : [],
    format: "esm",
    legalComments: "none",
    mainFields: ["browser", "module", "main"],
    minify: false,
    platform: "browser",
    sourcemap: false,
    target: "es2024",
    treeShaking: true,
    write: false,
    plugins: [processorRuntimeShimPlugin()],
  });

  const outputFile = result.outputFiles[0];
  if (outputFile == null) {
    throw new Error("esbuild produced no output when bundling the dynamic worker processor");
  }

  return outputFile.text.trim();
}

function shouldExternalizeNodeBuiltins(compatibilityFlags: string[] | undefined) {
  return compatibilityFlags?.includes("nodejs_compat") ?? false;
}

const processorRuntimePackageName = ["ai", "engineer", "workshop"].join("-");
const processorRuntimeSpecifierPattern = new RegExp(
  `^${processorRuntimePackageName}(?:/runtime)?$`,
);

function processorRuntimeShimPlugin() {
  return {
    name: "processor-runtime-shim",
    setup(buildApi: import("esbuild").PluginBuild) {
      buildApi.onResolve({ filter: processorRuntimeSpecifierPattern }, () => ({
        namespace: "processor-runtime-shim",
        path: processorRuntimePackageName,
      }));

      buildApi.onLoad({ filter: /.*/, namespace: "processor-runtime-shim" }, () => ({
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
