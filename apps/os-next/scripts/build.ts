// scripts/build.ts — THE BUILD: one esbuild script. wrangler bundles the worker itself
// (wrangler.jsonc `main: src/worker.ts` — `wrangler dev`, `wrangler deploy`, the test harness), so
// this writes only what the worker cannot import from source:
//
//   1. wrangler.jsonc from the root envs.ts (scripts/generate-wrangler-config.ts).
//   2. src/generated/processor-sdk.js — the text of `iterate/next/sdk` bundled for a LOADED isolate:
//      what context/worker-loader.ts injects into every loaded worker as "processor.js" (zod, the
//      capnweb fork and json5 inlined; cloudflare:workers is the isolate's own). A neutral platform
//      resolving `module`/`main` (json5 has no exports entry esbuild would pick otherwise) under the
//      `workerd` condition (capnweb's workerd build: inside a loaded isolate its RpcTarget IS the
//      cloudflare:workers one, so one class, not two). The SDK is the branch's: whatever `iterate` the
//      workspace holds is what dev, tests, a preview and prd inject — pinning by construction.
//   3. src/generated/presence-processor-source.js — the presence facet (src/client/presence/), the e2e
//      fixtures' demo processor, bundled the way an author's tooling would: its SDK imports left
//      external as "./processor.js", the module the host injects.
//
// The issuer's pages need no build at all: they are files in public/ (login.html, authorize.html,
// their stylesheet and scripts), served by the assets binding. The two generated modules have
// committed `.d.ts` siblings, so `tsc` and knip resolve the imports without a build; every runtime
// lane runs this first (vitest.global-setup.ts, scripts/dev.ts, scripts/deploy.ts).
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { build as esbuild, type Plugin } from "esbuild";
import { writeWranglerConfig } from "./generate-wrangler-config.ts";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const SDK_ENTRY = require.resolve("iterate/next/sdk");
const PRESENCE_ENTRY = path.join(root, "src/client/presence/durable-object.ts");

async function processorSdkModule(): Promise<string> {
  const bundled = await esbuild({
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
const externalizeToProcessorJs: Plugin = {
  name: "externalize-to-processor-js",
  setup(pluginBuild) {
    pluginBuild.onResolve(
      { filter: /^(zod|iterate\/next\/sdk|iterate\/next\/stream\/processor)$/ },
      () => ({ path: "./processor.js", external: true }),
    );
  },
};

async function presenceProcessorSource(): Promise<{ "cap.js": string }> {
  const bundled = await esbuild({
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

/** Everything above, written. */
export async function build(): Promise<void> {
  writeWranglerConfig();
  mkdirSync(path.join(root, "src/generated"), { recursive: true });
  writeFileSync(
    path.join(root, "src/generated/processor-sdk.js"),
    `export default ${JSON.stringify(await processorSdkModule())};\n`,
  );
  writeFileSync(
    path.join(root, "src/generated/presence-processor-source.js"),
    `export default ${JSON.stringify(await presenceProcessorSource())};\n`,
  );
}

if (process.argv[1]?.endsWith("build.ts")) await build();
