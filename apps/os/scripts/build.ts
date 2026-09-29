// Prepare source consumed by the Worker build: the platform packages loaded workers import and the
// config templates. Vite builds the Worker and Start client after this step; Vitest runs that
// built Worker.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { build as esbuild } from "esbuild";
import { isMainModule } from "@iterate-com/shared/dev/is-main-module";
import { viteBuild } from "../../../scripts/lib/deploy-helpers.ts";

const root = path.resolve(import.meta.dirname, "..");

/** The packages a loaded worker imports from THIS deployment rather than from npm: every `iterate/*`
 *  subpath that runs in workerd, and the zod the SDK itself is built on (one zod per isolate, so a
 *  schema made by user code is the schema the SDK checks). `iterate/with-itx` is `withItx` alone
 *  (~1.5 KB): an `itx.run` script or the agents' AI transport imports it and never loads the SDK. `package.json` naming `iterate` as
 *  `latest` (or not at all) links against these — on a preview, the PR's own SDK. */
const PLATFORM_ENTRIES = [
  "iterate/sdk",
  "iterate/stream/processor",
  "iterate/stream/run",
  "iterate/api",
  "iterate/lib",
  "iterate/expression",
  "iterate/principal",
  "iterate/with-itx",
  "zod",
] as const;

/** The platform packages as loader modules: one split esbuild graph (shared code lands in chunks,
 *  so `iterate/sdk` and `iterate/stream/processor` share one zod and one kernel), each output under
 *  `node_modules/…` with the modules it imports — the resolver (context/module-resolution.ts) hands
 *  a loaded worker only what its imports reach. */
async function platformModules() {
  // Every entry is a re-export resolved from the SDK's own directory, exactly as the SDK's imports
  // are: `require.resolve("zod")` would pick zod's CJS build while the SDK links its ESM one — two
  // zods in one graph.
  const sdkDir = path.dirname(createRequire(import.meta.url).resolve("iterate/sdk"));
  const entryPoints = Object.fromEntries(
    PLATFORM_ENTRIES.map((specifier) => [
      `node_modules/${specifier}`,
      `platform-entry:${specifier}`,
    ]),
  );
  const outdir = path.join(root, "src/generated/.platform-modules");
  const bundled = await esbuild({
    entryPoints,
    plugins: [
      {
        name: "platform-entry",
        setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /^platform-entry:/ }, (args) => ({
            path: args.path.slice("platform-entry:".length),
            namespace: "platform-entry",
          }));
          pluginBuild.onLoad({ filter: /.*/, namespace: "platform-entry" }, (args) => ({
            contents:
              `export * from ${JSON.stringify(args.path)};` +
              (args.path === "zod" ? ` export { default } from "zod";` : ""),
            resolveDir: sdkDir,
            loader: "js",
          }));
        },
      },
    ],
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "neutral",
    mainFields: ["module", "main"],
    conditions: ["workerd"],
    target: "es2022",
    minify: true,
    write: false,
    metafile: true,
    outdir,
    chunkNames: "node_modules/.platform/[name]-[hash]",
    external: ["cloudflare:workers"],
  });
  const moduleName = (file: string) => path.relative(outdir, file).split(path.sep).join("/");
  const modules: Record<string, string> = {};
  for (const file of bundled.outputFiles) modules[moduleName(file.path)] = file.text;
  const imports: Record<string, string[]> = {};
  for (const [file, output] of Object.entries(bundled.metafile!.outputs)) {
    const name = moduleName(path.resolve(file));
    imports[name] = output.imports
      .filter((imported) => !imported.external)
      .map((imported) => moduleName(path.resolve(imported.path)));
  }
  return { modules, imports };
}

/** Everything above, written. */
export async function build() {
  mkdirSync(path.join(root, "src/generated"), { recursive: true });
  const templatesRoot = path.resolve(root, "../../configs");
  const sourceRef = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  // `default` is not a named template: a creation that names none gets its files (`defaultFiles`).
  const templates = readdirSync(templatesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "default")
    .map((entry) => ({
      label: entry.name.charAt(0).toUpperCase() + entry.name.slice(1).replaceAll("-", " "),
      reference: `github:iterate/iterate#${sourceRef}&path:configs/${entry.name}`,
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
    path.join(root, "src/generated/platform-modules.js"),
    `export default ${JSON.stringify(await platformModules())};\n`,
  );
}

/** Build an environment-specific Worker and its TanStack client into dist/. */
export async function buildOs(env: string) {
  await build();
  await viteBuild(root, env);
}

if (isMainModule(import.meta.url)) await build();
