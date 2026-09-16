// scripts/vite-plugin-processor-sdk.ts — THE INJECTED SDK, built where the worker is built. Two
// virtual modules, served by Vite to the worker bundle (vite.config.ts) and to the vitest projects
// (vitest.config.ts) alike — no generated file in the tree:
//   virtual:processor-sdk             — the text of `iterate/next/sdk` bundled for a loaded isolate:
//                                       what context/worker-loader.ts injects into every loaded
//                                       worker as "processor.js" (zod, the capnweb fork and json5
//                                       inlined; cloudflare:workers is the isolate's own)
//   virtual:presence-processor-source — the userspace demo facet (src/client/presence/) bundled the
//                                       way an author's tooling would: its SDK imports left external
//                                       as "./processor.js", the module the host injects
// esbuild, the options the retired build-sdk.mjs used: a neutral platform resolving `module`/`main`
// (json5 has no exports entry esbuild would pick otherwise) under the `workerd` condition (capnweb's
// workerd build: inside a loaded isolate its RpcTarget IS the cloudflare:workers one, so one class,
// not two). The SDK is the branch's: whatever `iterate` the workspace holds is what dev, tests, a
// preview and prd inject — pinning by construction, no registry in the loop.
import { createRequire } from "node:module";
import { build, type Plugin as EsbuildPlugin } from "esbuild";
import type { Plugin } from "vite";

const require = createRequire(import.meta.url);
const SDK_ENTRY = require.resolve("iterate/next/sdk");
const PRESENCE_ENTRY = new URL("../src/client/presence/durable-object.ts", import.meta.url)
  .pathname;

async function processorSdkModule(): Promise<string> {
  const bundled = await build({
    entryPoints: [SDK_ENTRY],
    bundle: true,
    format: "esm",
    platform: "neutral",
    mainFields: ["module", "main"],
    conditions: ["workerd"],
    target: "es2022",
    minify: true,
    write: false,
    external: ["cloudflare:workers"],
  });
  return bundled.outputFiles[0]!.text;
}

/** A facet's SDK imports link against the injected module: every import of the SDK, the stream
 *  kernel or zod becomes "./processor.js", external. */
const externalizeToProcessorJs: EsbuildPlugin = {
  name: "externalize-to-processor-js",
  setup(pluginBuild) {
    pluginBuild.onResolve(
      { filter: /^(zod|iterate\/next\/sdk|iterate\/next\/stream\/processor)$/ },
      () => ({
        path: "./processor.js",
        external: true,
      }),
    );
  },
};

async function presenceProcessorSource(): Promise<{ "cap.js": string }> {
  const bundled = await build({
    entryPoints: [PRESENCE_ENTRY],
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    minify: true,
    write: false,
    plugins: [externalizeToProcessorJs],
  });
  return { "cap.js": bundled.outputFiles[0]!.text };
}

const VIRTUAL_MODULES: Record<string, () => Promise<unknown>> = {
  "virtual:processor-sdk": processorSdkModule,
  "virtual:presence-processor-source": presenceProcessorSource,
};

export function processorSdkModules(): Plugin {
  return {
    name: "os-next:processor-sdk",
    resolveId(id) {
      return id in VIRTUAL_MODULES ? `\0${id}` : undefined;
    },
    async load(id) {
      if (!id.startsWith("\0")) return undefined;
      const produce = VIRTUAL_MODULES[id.slice(1)];
      if (!produce) return undefined;
      return `export default ${JSON.stringify(await produce())};`;
    },
  };
}
