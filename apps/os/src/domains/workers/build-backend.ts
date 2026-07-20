import {
  createApp,
  createWorker,
  type CreateAppResult,
  type CreateWorkerResult,
  type Modules,
} from "@cloudflare/worker-bundler";
import { buildFailureMessageFromError, WorkerBuildFailedError } from "./artifact-store.ts";
import {
  WORKER_BUNDLER_CONDITIONS,
  type PreparedWorkerBuild,
  prepareWorkerBuild,
} from "./build-recipe.ts";
import type { WorkerBuildOptions } from "./schemas.ts";

/**
 * Execute one dynamic-worker build with `@cloudflare/worker-bundler` inside
 * workerd and return loader-ready text modules.
 *
 * There is no container, host-toolchain endpoint, wrangler dry-run, or Vite
 * recipe. Source is parsed and bundled (esbuild-wasm); npm dependencies are
 * installed by the package's in-worker registry downloader when `package.json`
 * declares them. Project build scripts never run.
 *
 * Error classification is the caller's contract (worker-loader.ts runBuild):
 * only a genuine build failure — missing entry, unresolvable deps, bundler
 * errors — throws {@link WorkerBuildFailedError}. Everything else stays an
 * ordinary error and therefore retryable, never recorded as a failure.
 */
export async function executeWorkerBuild(input: {
  files: Record<string, string>;
  options: WorkerBuildOptions;
}): Promise<{ mainModule: string; modules: Record<string, string> }> {
  let prepared: PreparedWorkerBuild;
  try {
    prepared = prepareWorkerBuild({ files: input.files, options: input.options });
  } catch (error) {
    throw new WorkerBuildFailedError(buildFailureMessageFromError(error), { cause: error });
  }

  try {
    const result =
      prepared.kind === "app"
        ? await createApp({
            client: prepared.client,
            conditions: [...WORKER_BUNDLER_CONDITIONS],
            files: prepared.files,
            jsx: "automatic",
            jsxImportSource: "react",
            minify: prepared.minify,
            server: prepared.server,
          })
        : await createWorker({
            conditions: [...WORKER_BUNDLER_CONDITIONS],
            entryPoint: prepared.entryPoint,
            files: prepared.files,
            jsx: "automatic",
            jsxImportSource: "react",
            minify: prepared.minify,
          });
    const warnings = result.warnings ?? [];
    if (warnings.length > 0) {
      throw new Error(`worker-bundler returned warnings:\n${warnings.join("\n")}`);
    }
    const collected =
      prepared.kind === "app"
        ? collectAppOutputs(result as CreateAppResult)
        : collectWorkerOutputs(result as CreateWorkerResult);
    // worker-bundler's installer/esbuild path leaves some transitive npm
    // packages as bare externals (form-data, https-proxy-agent, …). The Worker
    // Loader then dies at import time with `No such module "…"`. Stub any
    // remaining non-runtime bare imports so the isolate always loads; code
    // paths that actually need those packages still fail loudly at call time.
    return {
      mainModule: collected.mainModule,
      modules: stubBareNpmExternals(collected.modules),
    };
  } catch (error) {
    if (error instanceof WorkerBuildFailedError) throw error;
    throw new WorkerBuildFailedError(buildFailureMessageFromError(error), { cause: error });
  }
}

function collectWorkerOutputs(result: CreateWorkerResult): {
  mainModule: string;
  modules: Record<string, string>;
} {
  const modules = textModules(result.modules);
  if (!(result.mainModule in modules)) {
    throw new Error(
      `worker-bundler did not produce the entry module "${result.mainModule}" ` +
        `(got: ${Object.keys(modules).join(", ") || "nothing"}).`,
    );
  }
  return { mainModule: result.mainModule, modules };
}

/**
 * Workerd provides these without a modules-map entry when nodejs_compat is on
 * (and cloudflare: always). Everything else that still appears as a bare
 * import after bundling needs an explicit module or the isolate will not load.
 */
const WORKERD_RUNTIME_MODULE_PREFIXES = ["cloudflare:", "node:", "bun:"] as const;
const WORKERD_BARE_NODE_BUILTINS = new Set([
  "assert",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "domain",
  "events",
  "fs",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "repl",
  "stream",
  "string_decoder",
  "sys",
  "timers",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib",
]);

/** Exported for unit tests — pure rewrite over a modules map. */
export function stubBareNpmExternals(modules: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = { ...modules };
  const needed = new Set<string>();
  for (const source of Object.values(out)) {
    for (const spec of bareModuleSpecifiers(source)) {
      if (isWorkerdRuntimeModule(spec)) continue;
      if (spec in out) continue;
      needed.add(spec);
    }
  }
  for (const spec of needed) {
    // Dual CJS/ESM surface: esbuild may emit either import or require for the
    // same leftover external. Empty default is enough for optional SDK paths
    // (proxy agents, node form-data) that user code does not exercise.
    out[spec] =
      `"use strict";\n` +
      `const empty = Object.create(null);\n` +
      `export default empty;\n` +
      `export const __esModule = true;\n`;
  }
  return out;
}

function isWorkerdRuntimeModule(spec: string): boolean {
  if (WORKERD_RUNTIME_MODULE_PREFIXES.some((prefix) => spec.startsWith(prefix))) return true;
  if (WORKERD_BARE_NODE_BUILTINS.has(spec)) return true;
  // Subpaths of node builtins (stream/promises, fs/promises, …)
  const slash = spec.indexOf("/");
  if (slash > 0 && WORKERD_BARE_NODE_BUILTINS.has(spec.slice(0, slash))) return true;
  return false;
}

/** Bare package / builtin specifiers referenced by import or require. */
export function bareModuleSpecifiers(source: string): string[] {
  const found = new Set<string>();
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\s*["']([^"']+)["']/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const spec = match[1];
      if (spec === undefined || spec.length === 0) continue;
      if (spec.startsWith(".") || spec.startsWith("/")) continue;
      found.add(spec);
    }
  }
  return [...found].sort();
}

/**
 * createApp returns a server isolate plus host-side assets (client bundles,
 * static files). The Worker Loader only stores text modules, so assets become
 * a generated module and a thin wrapper entry serves them before falling
 * through to the app's own default export — the same shape the old Vite lane
 * produced, without running Vite.
 */
function collectAppOutputs(result: CreateAppResult): {
  mainModule: string;
  modules: Record<string, string>;
} {
  const modules = textModules(result.modules);
  if (!(result.mainModule in modules)) {
    throw new Error(
      `worker-bundler did not produce the server entry "${result.mainModule}" ` +
        `(got: ${Object.keys(modules).join(", ") || "nothing"}).`,
    );
  }

  const assets: Record<string, { body: string; contentType: string }> = {};
  for (const [pathname, content] of Object.entries(result.assets ?? {})) {
    const body = typeof content === "string" ? content : undefined;
    if (body === undefined) {
      throw new Error(
        `App build produced binary asset "${pathname}"; only text assets are storable today.`,
      );
    }
    assets[pathname.startsWith("/") ? pathname : `/${pathname}`] = {
      body,
      contentType: textAssetContentType(pathname) ?? "application/octet-stream",
    };
  }

  // Unhashed paths like /client.js (basename of the client entry) must not be
  // year-immutable: a rebuild keeps the same URL and browsers would keep the
  // old bundle forever. no-cache lets the browser revalidate every load.
  const assetsModule = ".iterate-build.assets.js";
  const entryModule = ".iterate-build.entry.js";
  modules[assetsModule] = `export const ASSETS = ${JSON.stringify(assets)};`;
  modules[entryModule] = [
    `import * as server from ${JSON.stringify(`./${result.mainModule}`)};`,
    `import { ASSETS } from ${JSON.stringify(`./${assetsModule}`)};`,
    `export * from ${JSON.stringify(`./${result.mainModule}`)};`,
    `const fallback = server.default;`,
    `export default {`,
    `  async fetch(request, env, ctx) {`,
    `    const url = new URL(request.url);`,
    `    const asset = ASSETS[url.pathname];`,
    `    if (asset !== undefined && (request.method === "GET" || request.method === "HEAD")) {`,
    `      return new Response(request.method === "HEAD" ? null : asset.body, {`,
    `        headers: {`,
    `          "cache-control": "no-cache",`,
    `          "content-type": asset.contentType,`,
    `        },`,
    `      });`,
    `    }`,
    `    return fallback.fetch(request, env, ctx);`,
    `  },`,
    `};`,
  ].join("\n");
  return { mainModule: entryModule, modules };
}

function textModules(modules: Modules): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, module] of Object.entries(modules)) {
    out[name] = moduleSource(name, module);
  }
  return out;
}

function moduleSource(name: string, module: Modules[string]): string {
  if (typeof module === "string") return module;
  if (typeof module.js === "string") return module.js;
  if (typeof module.cjs === "string") return module.cjs;
  if (typeof module.text === "string") return module.text;
  throw new Error(
    `Worker build produced module "${name}" in an unsupported format; only text JavaScript modules are storable today.`,
  );
}

const ASSET_CONTENT_TYPES: Record<string, string> = {
  css: "text/css; charset=utf-8",
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  json: "application/json",
  mjs: "text/javascript; charset=utf-8",
  svg: "image/svg+xml",
  txt: "text/plain; charset=utf-8",
  webmanifest: "application/manifest+json",
};

function textAssetContentType(name: string): string | undefined {
  const ext = name.slice(name.lastIndexOf(".") + 1);
  return ASSET_CONTENT_TYPES[ext];
}
