import {
  createApp,
  createWorker,
  type CreateAppResult,
  type CreateWorkerResult,
  type Modules,
} from "@cloudflare/worker-bundler";
import { buildFailureMessageFromError, WorkerBuildFailedError } from "./artifact-store.ts";
import {
  applyRootDir,
  assertSafeSourcePath,
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
    return prepared.kind === "app"
      ? collectAppOutputs(result as CreateAppResult)
      : collectWorkerOutputs(result as CreateWorkerResult);
  } catch (error) {
    if (error instanceof WorkerBuildFailedError) throw error;
    throw new WorkerBuildFailedError(buildFailureMessageFromError(error), { cause: error });
  }
}

/** Re-export pure helpers tests and the seeder still share with the runtime. */
export { applyRootDir, assertSafeSourcePath, prepareWorkerBuild };

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
