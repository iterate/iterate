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
      modules: adaptBundleForWorkerd(collected.modules),
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

/**
 * Make worker-bundler ESM output load under workerd:
 * 1. Patch esbuild's `__require` helper (CJS→ESM interop) to resolve
 *    `node:*` builtins and allow-listed Node-only packages.
 * 2. Only import the builtins actually referenced (importing every node:*
 *    into every bundle OOM'd Durable Objects).
 * 3. Stub agent/proxy packages as classes — they are extended with
 *    `class X extends require("agent-base")`.
 */
export function adaptBundleForWorkerd(modules: Record<string, string>): Record<string, string> {
  return polyfillEsbuildNodeRequire(stubBareNpmExternals(modules));
}

/** Exported for unit tests — pure rewrite over a modules map. */
export function stubBareNpmExternals(modules: Record<string, string>): Record<string, string> {
  // After esbuild, leftover externals appear as __require("pkg") not require().
  // Keep bare names for __require — the node-require polyfill resolves them
  // against imported stub modules. Only rewrite static ESM import forms.
  const needed = new Set<string>();
  for (const source of Object.values(modules)) {
    for (const spec of bareModuleSpecifiers(source)) {
      if (!shouldStubBareNpmPackage(spec)) continue;
      if (spec in modules) continue;
      needed.add(spec);
    }
  }
  if (needed.size === 0) return modules;

  const out: Record<string, string> = { ...modules };
  for (const [name, source] of Object.entries(modules)) {
    let rewritten = source;
    for (const spec of needed) {
      const rel = `./${stubModulePath(spec)}`;
      const q = JSON.stringify(rel);
      rewritten = rewritten
        .replaceAll(`from "${spec}"`, `from ${q}`)
        .replaceAll(`from '${spec}'`, `from ${q}`)
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
      out[path] =
        `class IterateExternalStub {\n` +
        `  constructor() {}\n` +
        `}\n` +
        `export default IterateExternalStub;\n` +
        `export { IterateExternalStub as Agent };\n`;
    }
  }
  return out;
}

function shouldStubBareNpmPackage(spec: string): boolean {
  if (STUBBABLE_NPM_PACKAGES.has(spec)) return true;
  const slash = spec.indexOf("/");
  if (slash > 0 && STUBBABLE_NPM_PACKAGES.has(spec.slice(0, slash))) return true;
  if (spec.startsWith("@")) {
    const parts = spec.split("/");
    if (parts.length >= 2 && STUBBABLE_NPM_PACKAGES.has(`${parts[0]}/${parts[1]}`)) return true;
  }
  return false;
}

function stubModulePath(spec: string): string {
  return `.iterate-external/${spec.replace(/^@/, "").replaceAll("/", "__")}.js`;
}

const WORKERD_NODE_BUILTIN_SET = new Set([
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
]);

/** Bare package / builtin / __require specifiers. */
export function bareModuleSpecifiers(source: string): string[] {
  const found = new Set<string>();
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\b__require\s*\(\s*["']([^"']+)["']\s*\)/g,
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

function normalizeNodeBuiltinId(spec: string): string | null {
  if (spec.startsWith("node:")) {
    const name = spec.slice("node:".length).split("/")[0]!;
    return WORKERD_NODE_BUILTIN_SET.has(name) ? name : null;
  }
  const name = spec.split("/")[0]!;
  return WORKERD_NODE_BUILTIN_SET.has(name) ? name : null;
}

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
    const neededBuiltins = new Set<string>();
    const neededStubs = new Set<string>();
    for (const spec of bareModuleSpecifiers(source)) {
      const builtin = normalizeNodeBuiltinId(spec);
      if (builtin !== null) {
        neededBuiltins.add(builtin);
        continue;
      }
      if (shouldStubBareNpmPackage(spec)) neededStubs.add(spec);
    }
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
    out[name] =
      `${nodeRequirePrelude([...neededBuiltins].sort(), [...neededStubs].sort())}\n${rewritten}`;
  }
  return touched ? out : modules;
}

function nodeRequirePrelude(builtinNames: string[], stubSpecs: string[]): string {
  const names = new Set(builtinNames);
  if (names.size > 0 || stubSpecs.length > 0) {
    names.add("events");
    names.add("stream");
    names.add("util");
  }
  const list = [...names].sort();
  const stubImports = stubSpecs
    .map((spec, i) => {
      const path = `./${stubModulePath(spec)}`;
      return `import __iterate_stub_${i} from ${JSON.stringify(path)};`;
    })
    .join("\n");
  const stubEntries = stubSpecs
    .map((spec, i) => `${JSON.stringify(spec)}: __iterate_stub_${i}`)
    .join(",\n  ");

  // Named imports for constructor modules — workerd's `import * as events`
  // is a Module namespace, so `class X extends require("events")` fails with
  // "Class extends value #<Object>". Return the real constructors instead.
  const lines: string[] = [];
  if (stubImports) lines.push(stubImports);
  if (list.includes("events")) {
    lines.push(`import { EventEmitter as __iterate_EventEmitter } from "node:events";`);
  }
  if (list.includes("stream")) {
    lines.push(
      `import { Readable as __iterate_Readable, Writable as __iterate_Writable, Transform as __iterate_Transform, Duplex as __iterate_Duplex, PassThrough as __iterate_PassThrough } from "node:stream";`,
    );
  }
  for (const name of list) {
    if (name === "events" || name === "stream") continue;
    lines.push(`import * as __iterate_node_${name} from ${JSON.stringify(`node:${name}`)};`);
  }

  const builtinEntries: string[] = [];
  if (list.includes("events")) {
    builtinEntries.push(
      `"events": __iterate_EventEmitter`,
      `"node:events": __iterate_EventEmitter`,
    );
  }
  if (list.includes("stream")) {
    builtinEntries.push(`"stream": __iterate_Readable`, `"node:stream": __iterate_Readable`);
  }
  for (const name of list) {
    if (name === "events" || name === "stream") continue;
    builtinEntries.push(
      `${JSON.stringify(name)}: __iterate_node_${name}`,
      `${JSON.stringify(`node:${name}`)}: __iterate_node_${name}`,
    );
  }

  return `${lines.join("\n")}
const __iterateStubs = {
  ${stubEntries}
};
const __iterateNodeBuiltins = {
  ${builtinEntries.join(",\n  ")}
};
function __iterateCjsInterop(mod, id) {
  if (mod == null) return mod;
  // Already a constructor (events, stream named imports).
  if (typeof mod === "function") {
    if (id === "events" || id === "node:events") {
      try { mod.EventEmitter = mod; } catch { /* read-only */ }
    }
    if (id === "stream" || id === "node:stream") {
      try {
        mod.Readable = __iterate_Readable;
        mod.Writable = __iterate_Writable;
        mod.Transform = __iterate_Transform;
        mod.Duplex = __iterate_Duplex;
        mod.PassThrough = __iterate_PassThrough;
        mod.Stream = __iterate_Readable;
      } catch { /* read-only */ }
    }
    return mod;
  }
  // Namespace object from import * — prefer .default, else return as-is
  // (os/path/fs style modules used as objects, not bases).
  if (typeof mod === "object" && mod.default != null) return mod.default;
  return mod;
}
function __iterateNodeRequire(id) {
  if (Object.prototype.hasOwnProperty.call(__iterateStubs, id)) {
    return __iterateStubs[id];
  }
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
