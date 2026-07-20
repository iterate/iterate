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
      modules: polyfillEsbuildNodeRequire(stubBareNpmExternals(collected.modules)),
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
 * Node-only packages that worker-bundler often leaves as bare externals when
 * bundling SDKs like @slack/web-api / axios. They are not needed under
 * workerd (native fetch, no HTTP proxy agents). Allow-listed rather than
 * "stub every leftover bare import" so intentional externals (zod for the
 * processors virtual module, user deps the installer missed) stay loud.
 */
const STUBBABLE_NPM_PACKAGES = new Set([
  "agent-base",
  "form-data",
  "http-proxy-agent",
  "https-proxy-agent",
  "pac-proxy-agent",
  "proxy-agent",
  "proxy-from-env",
  "socks-proxy-agent",
]);

/** Exported for unit tests — pure rewrite over a modules map. */
export function stubBareNpmExternals(modules: Record<string, string>): Record<string, string> {
  const needed = new Set<string>();
  for (const source of Object.values(modules)) {
    for (const spec of bareModuleSpecifiers(source)) {
      if (!shouldStubBareNpmPackage(spec)) continue;
      if (spec in modules) continue;
      needed.add(spec);
    }
  }
  if (needed.size === 0) return modules;

  // Relative stub paths: Worker Loader module keys are file-like. Rewriting
  // the import keeps resolution inside the modules map without relying on
  // bare package-name keys.
  const out: Record<string, string> = {};
  for (const [name, source] of Object.entries(modules)) {
    let rewritten = source;
    for (const spec of needed) {
      const rel = `./${stubModulePath(spec)}`;
      const q = JSON.stringify(rel);
      rewritten = rewritten
        .replaceAll(`from "${spec}"`, `from ${q}`)
        .replaceAll(`from '${spec}'`, `from ${q}`)
        .replaceAll(`require("${spec}")`, `require(${q})`)
        .replaceAll(`require('${spec}')`, `require(${q})`)
        .replaceAll(`import("${spec}")`, `import(${q})`)
        .replaceAll(`import('${spec}')`, `import(${q})`)
        .replaceAll(`import "${spec}"`, `import ${q}`)
        .replaceAll(`import '${spec}'`, `import ${q}`);
    }
    out[name] = rewritten;
  }
  for (const spec of needed) {
    const path = stubModulePath(spec);
    if (!(path in out)) {
      // Agent packages (agent-base, *-proxy-agent) are extended with
      // `class X extends require("agent-base")`. An empty object throws
      // "Class extends value #<Object> is not a constructor". Export a
      // no-op class so inheritance and `new` both succeed; real HTTP proxy
      // behaviour is unused under workerd (native fetch).
      out[path] =
        `"use strict";\n` +
        `class IterateExternalStub {\n` +
        `  constructor() {}\n` +
        `}\n` +
        `IterateExternalStub.default = IterateExternalStub;\n` +
        `module.exports = IterateExternalStub;\n` +
        `export default IterateExternalStub;\n` +
        `export const __esModule = true;\n`;
    }
  }
  return out;
}

function shouldStubBareNpmPackage(spec: string): boolean {
  if (STUBBABLE_NPM_PACKAGES.has(spec)) return true;
  const slash = spec.indexOf("/");
  if (slash > 0 && STUBBABLE_NPM_PACKAGES.has(spec.slice(0, slash))) return true;
  // Scoped packages: @scope/name
  if (spec.startsWith("@")) {
    const parts = spec.split("/");
    if (parts.length >= 2 && STUBBABLE_NPM_PACKAGES.has(`${parts[0]}/${parts[1]}`)) return true;
  }
  return false;
}

function stubModulePath(spec: string): string {
  return `.iterate-external/${spec.replace(/^@/, "").replaceAll("/", "__")}.js`;
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
 * Node builtins workerd provides under `nodejs_compat` (our Worker Loader
 * mounts every isolate with that flag). esbuild's CJS→ESM interop emits a
 * `__require` helper that throws `Dynamic require of "node:os" is not
 * supported` at runtime even with `platform: "node"`, because the ESM
 * isolate has no CommonJS `require`. Rewrite that helper to serve real
 * `node:*` modules instead.
 */
const WORKERD_NODE_BUILTINS = [
  "assert",
  "async_hooks",
  "buffer",
  "child_process",
  "constants",
  "crypto",
  "diagnostics_channel",
  "dns",
  "events",
  "fs",
  "http",
  "http2",
  "https",
  "module",
  "net",
  "os",
  "path",
  "process",
  "querystring",
  "stream",
  "string_decoder",
  "timers",
  "tls",
  "tty",
  "url",
  "util",
  "zlib",
] as const;

/** Exported for unit tests. */
export function polyfillEsbuildNodeRequire(
  modules: Record<string, string>,
): Record<string, string> {
  let touched = false;
  const out: Record<string, string> = {};
  for (const [name, source] of Object.entries(modules)) {
    if (!source.includes('Dynamic require of "') && !source.includes("Dynamic require of '")) {
      out[name] = source;
      continue;
    }
    // esbuild emits exactly:
    //   throw Error('Dynamic require of "' + x + '" is not supported')
    // (single-quoted outer string, double quotes around the inserted id).
    // Replace the throw with a lookup into a prelude-provided table.
    const rewritten = source
      .replace(
        /throw Error\('Dynamic require of "' \+ (\w+) \+ '" is not supported'\)/g,
        "return __iterateNodeRequire($1)",
      )
      .replace(
        /throw new Error\('Dynamic require of "' \+ (\w+) \+ '" is not supported'\)/g,
        "return __iterateNodeRequire($1)",
      )
      .replace(
        /throw Error\("Dynamic require of '" \+ (\w+) \+ "' is not supported"\)/g,
        "return __iterateNodeRequire($1)",
      );
    if (rewritten === source) {
      out[name] = source;
      continue;
    }
    touched = true;
    out[name] = `${nodeRequirePrelude()}\n${rewritten}`;
  }
  return touched ? out : modules;
}

function nodeRequirePrelude(): string {
  const imports = WORKERD_NODE_BUILTINS.map(
    (name) => `import * as __iterate_node_${name} from ${JSON.stringify(`node:${name}`)};`,
  ).join("\n");
  const entries = WORKERD_NODE_BUILTINS.flatMap((name) => [
    `${JSON.stringify(name)}: __iterate_node_${name}`,
    `${JSON.stringify(`node:${name}`)}: __iterate_node_${name}`,
  ]).join(",\n  ");
  // Primary CJS export names for builtins that workerd exposes only as named
  // ESM exports (no .default). require("events") === EventEmitter in Node.
  const primaryExports: Record<string, string> = {
    events: "EventEmitter",
    stream: "Stream",
    domain: "Domain",
    string_decoder: "StringDecoder",
  };
  const primaryEntries = Object.entries(primaryExports)
    .flatMap(([name, exportName]) => [
      `${JSON.stringify(name)}: ${JSON.stringify(exportName)}`,
      `${JSON.stringify(`node:${name}`)}: ${JSON.stringify(exportName)}`,
    ])
    .join(",\n  ");
  return `${imports}
const __iterateNodeBuiltins = {
  ${entries}
};
const __iterateNodePrimary = {
  ${primaryEntries}
};
function __iterateCjsInterop(ns, id) {
  if (ns == null || typeof ns !== "object") return ns;
  // Prefer default (matches Node ESM→CJS interop for dual packages).
  let main = ns.default;
  // workerd often omits .default on node:* namespaces — fall back to the
  // historical CJS main export (EventEmitter, Stream, …).
  if (main == null) {
    const primary = __iterateNodePrimary[id];
    if (primary !== undefined && typeof ns[primary] === "function") main = ns[primary];
  }
  if (main == null) return ns;
  // Copy named exports onto the main export so require("events").EventEmitter
  // and require("stream").Readable keep working after interop.
  if (typeof main === "function" || typeof main === "object") {
    for (const key of Object.keys(ns)) {
      if (key === "default") continue;
      if (!(key in main)) {
        try { main[key] = ns[key]; } catch { /* read-only */ }
      }
    }
  }
  return main;
}
function __iterateNodeRequire(id) {
  const mod = __iterateNodeBuiltins[id];
  if (mod === undefined) {
    throw Error('Dynamic require of "' + id + '" is not supported');
  }
  return __iterateCjsInterop(mod, id);
}
`;
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
