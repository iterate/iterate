import { execFileSync } from "node:child_process";
// scripts/build.ts — THE BUILD: one esbuild script. wrangler bundles the worker itself
// (wrangler.jsonc `main: src/worker.ts` — `wrangler dev`, `wrangler deploy`, the test harness), so
// this writes only what the worker cannot import from source:
//
//   1. wrangler.jsonc from the root envs.ts, and wrangler.self-host.jsonc — the same bindings with no
//      ids, for a deployment into someone else's account (SELF-HOSTING.md) — both from
//      scripts/generate-wrangler-config.ts.
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
//   4. public/capnweb.js — the capnweb fork's browser bundle, copied verbatim beside the consent page
//      (public/authorize.js imports it: the page is a capnweb client of /api like any app, and the
//      pages' CSP loads script from this origin alone). The workspace's capnweb is what the worker
//      speaks, so the copy is the same version by construction.
//
// The issuer's pages need no build at all: they are files in public/ (login.html, oauth2/auth.html,
// their stylesheet and scripts), served by the assets binding. The two generated modules have
// committed `.d.ts` siblings, so `tsc` and knip resolve the imports without a build; every runtime
// path runs this first (vitest.global-setup.ts, scripts/dev.ts, scripts/deploy.ts).
import { copyFileSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { build as esbuild, type Plugin } from "esbuild";
import { writeSelfHostWranglerConfig, writeWranglerConfig } from "./generate-wrangler-config.ts";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const SDK_ENTRY = require.resolve("iterate/next/sdk");
const PRESENCE_ENTRY = path.join(root, "src/client/presence/durable-object.ts");
/** capnweb's package entry resolves to its CommonJS build; the ESM browser bundle sits beside it. */
const CAPNWEB_BROWSER_BUNDLE = require.resolve("capnweb").replace(/index\.cjs$/, "index.js");

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
  writeSelfHostWranglerConfig();
  mkdirSync(path.join(root, "src/generated"), { recursive: true });
  const templatesRoot = path.resolve(root, "../../configs-next");
  const sourceRef =
    process.env.ITERATE_TEMPLATE_SOURCE_REF ||
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const templates = readdirSync(templatesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      label:
        entry.name === "default"
          ? "Minimal"
          : entry.name.charAt(0).toUpperCase() + entry.name.slice(1).replaceAll("-", " "),
      reference: `github:iterate/iterate#${sourceRef}&path:configs-next/${entry.name}`,
    }));
  const defaultFiles = readdirSync(path.join(templatesRoot, "default")).map((file) => ({
    path: file,
    content: readFileSync(path.join(templatesRoot, "default", file), "utf8"),
  }));
  writeFileSync(
    path.join(root, "src/generated/config-templates.js"),
    `export const templates = ${JSON.stringify(templates)};\nexport const defaultFiles = ${JSON.stringify(defaultFiles)};\n`,
  );

  writeFileSync(
    path.join(root, "src/generated/processor-sdk.js"),
    `export default ${JSON.stringify(await processorSdkModule())};\n`,
  );
  writeFileSync(
    path.join(root, "src/generated/presence-processor-source.js"),
    `export default ${JSON.stringify(await presenceProcessorSource())};\n`,
  );
  copyFileSync(CAPNWEB_BROWSER_BUNDLE, path.join(root, "public/capnweb.js"));
}

if (process.argv[1]?.endsWith("build.ts")) await build();
