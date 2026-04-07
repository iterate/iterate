import { basename, dirname, resolve } from "node:path";
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
) {
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
    format: "esm",
    legalComments: "none",
    mainFields: ["browser", "module", "main"],
    minify: false,
    platform: "browser",
    sourcemap: false,
    target: "es2024",
    treeShaking: true,
    write: false,
    stdin: {
      contents: buildDynamicWorkerAdapterModule({
        entryFileName: basename(args.absoluteEntryFile),
      }),
      loader: "ts",
      resolveDir: dirname(args.absoluteEntryFile),
      sourcefile: "dynamic-worker-adapter.ts",
    },
    plugins: [aiEngineerWorkshopShimPlugin()],
  });

  const outputFile = result.outputFiles[0];
  if (outputFile == null) {
    throw new Error("esbuild produced no output when bundling the dynamic worker processor");
  }

  return outputFile.text.trim();
}

function buildDynamicWorkerAdapterModule(args: { entryFileName: string }) {
  const entryImport = JSON.stringify(`./${args.entryFileName}`);

  return `
import importedProcessor from ${entryImport};

function hasFunction(value: unknown, key: string): boolean {
  return value != null && typeof value === "object" && typeof value[key] === "function";
}

function reduce(state: unknown, event: unknown) {
  if (!hasFunction(importedProcessor, "reduce")) {
    return state;
  }

  return importedProcessor.reduce(state, event) ?? state;
}

if (
  importedProcessor == null ||
  typeof importedProcessor !== "object" ||
  !("initialState" in importedProcessor)
) {
  throw new Error(
    "Dynamic worker processor bundle must default-export the current processor shape: { initialState, reduce, onEvent? }.",
  );
}

if (hasFunction(importedProcessor, "afterAppend")) {
  throw new Error(
    "Legacy processor shape with afterAppend() is not supported. Export the current processor shape with onEvent().",
  );
}

if ("slug" in importedProcessor) {
  throw new Error(
    "Dynamic worker processor bundles must not export slug on the processor object. Pass slug in the dynamic-worker/configured event payload instead.",
  );
}

async function onEvent(args: {
  append: (event: unknown) => Promise<unknown>;
  event: unknown;
  state: unknown;
  prevState: unknown;
}) {
  if (!hasFunction(importedProcessor, "onEvent")) {
    return;
  }

  await importedProcessor.onEvent(args);
}

export default {
  initialState: importedProcessor.initialState ?? {},

  reduce,
  onEvent,
};
`.trim();
}

function aiEngineerWorkshopShimPlugin() {
  return {
    name: "ai-engineer-workshop-shim",
    setup(buildApi: import("esbuild").PluginBuild) {
      buildApi.onResolve({ filter: /^ai-engineer-workshop$/ }, () => ({
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

export class PullSubscriptionProcessorRuntime {
  constructor() {
    throw new Error(
      "PullSubscriptionProcessorRuntime is not available in dynamic worker processor bundles.",
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
