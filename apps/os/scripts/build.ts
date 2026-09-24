// Prepare source consumed by the Worker build: the loaded processor SDK, bundled presence facet and
// config templates. Vite builds the Worker and Start client after this step; Vitest runs that
// built Worker.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { build as esbuild, type Plugin } from "esbuild";
import { viteBuild } from "../../../scripts/lib/deploy-helpers.ts";

const root = path.resolve(import.meta.dirname, "..");

async function processorSdkModule() {
  const bundled = await esbuild({
    entryPoints: [createRequire(import.meta.url).resolve("iterate/next/sdk")],
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

async function presenceProcessorSource() {
  const bundled = await esbuild({
    entryPoints: [path.join(root, "src/client/presence/durable-object.ts")],
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
export async function build() {
  mkdirSync(path.join(root, "src/generated"), { recursive: true });
  const templatesRoot = path.resolve(root, "../../configs-next");
  const sourceRef = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  // `default` is not a named template: a creation that names none gets its files (`defaultFiles`).
  const templates = readdirSync(templatesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "default")
    .map((entry) => ({
      label: entry.name.charAt(0).toUpperCase() + entry.name.slice(1).replaceAll("-", " "),
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
}

/** Build an environment-specific Worker and its TanStack client into dist/. */
export async function buildOs(env: string) {
  await build();
  await viteBuild(root, env);
}

if (process.argv[1]?.endsWith("build.ts")) await build();
