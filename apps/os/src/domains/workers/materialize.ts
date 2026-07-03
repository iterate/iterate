import type { Modules } from "@cloudflare/worker-bundler";
import type { WorkerBuildOptions } from "../../types.ts";
import { workerBuildOptionsMatchCloudflare } from "./schemas.ts";

export type MaterializedWorkerBuild = {
  compatibilityDate?: string;
  compatibilityFlags?: string[];
  mainModule: string;
  modules: Record<string, string>;
  warnings: string[];
};

/**
 * Node builtins that workerd provides under `nodejs_compat` at our worker
 * compatibility date. npm packages reach them BARE ("util", not "node:util"),
 * usually via CommonJS `require` — which the bundler's ESM output cannot leave
 * external ("Dynamic require of util is not supported"). Aliasing each bare
 * name to a bundled shim that statically re-exports the `node:` module keeps
 * the require interop inside the bundle and the actual builtin external.
 *
 * Only builtins the runtime actually implements belong here: the shim turns
 * into a STATIC import, so an unavailable module would fail worker startup
 * even if the code path never runs. Changing this list changes build output —
 * bump WORKER_BUILD_ARTIFACT_SCHEMA_VERSION with it.
 */
const NODE_BUILTIN_ALIASES = [
  "assert",
  "async_hooks",
  "buffer",
  "constants",
  "crypto",
  "diagnostics_channel",
  "dns",
  "events",
  "fs",
  "fs/promises",
  "http",
  "http2",
  "https",
  "net",
  "os",
  "path",
  "process",
  "punycode",
  "querystring",
  "stream",
  "stream/promises",
  "stream/web",
  "string_decoder",
  "timers",
  "timers/promises",
  "tls",
  "tty",
  "url",
  "util",
  "util/types",
  "zlib",
];

// Both spellings: bare ("util") and prefixed ("node:util"). The prefixed shim
// imports its own specifier — the patched bundler resolves a virtual module's
// self-import through normal resolution, which leaves it external for workerd.
const nodeBuiltinVirtualModules = Object.fromEntries(
  NODE_BUILTIN_ALIASES.flatMap((name) => {
    const shim = `import module from "node:${name}"; export default module; export * from "node:${name}";`;
    return [
      [name, shim],
      [`node:${name}`, shim],
    ];
  }),
);

/**
 * The one materialization pipeline for dynamic worker source: resolve the file
 * source to a file map elsewhere, then turn it into loader-ready modules here
 * through Cloudflare's bundler. `bundle: false` still comes through this path
 * (transform-only mode); the invariant is one pipeline, not one output file.
 *
 * `@cloudflare/worker-bundler` bundles via an esbuild-wasm module import that
 * only the Workers module loader can resolve, so this import stays dynamic:
 * Node-side unit tests can import this module's callers without dragging the
 * wasm in, and only workerd executes builds.
 */
export async function materializeWorkerBuild(input: {
  files: Record<string, string>;
  options: WorkerBuildOptions;
}): Promise<MaterializedWorkerBuild> {
  const { createWorker } = await import("@cloudflare/worker-bundler");
  const result = await createWorker({
    ...workerBuildOptionsMatchCloudflare(input.options),
    files: input.files,
    // The resolver's built-in default is ["import", "browser"]; "browser"
    // picks package browser builds (UMD bundles, XHR transports) that assume
    // an actual browser. Dynamic workers run under nodejs_compat, so prefer
    // workerd-flavored entries and let the builtin shims above cover node
    // imports. ("import"/"default" are implied by the resolver.)
    conditions: input.options.conditions ?? ["workerd", "worker"],
    virtualModules: {
      ...nodeBuiltinVirtualModules,
      ...input.options.virtualModules,
    },
  });
  return {
    compatibilityDate: result.wranglerConfig?.compatibilityDate,
    compatibilityFlags: result.wranglerConfig?.compatibilityFlags,
    mainModule: result.mainModule,
    modules: loaderReadyModules(result.modules),
    warnings: result.warnings ?? [],
  };
}

/**
 * The artifact store and Worker Loader path carry plain text modules. The
 * bundler can emit richer module records; `js` records are text modules by
 * another name, everything else (binary data, cjs, json) is refused loudly
 * rather than stored corrupted.
 */
function loaderReadyModules(modules: Modules): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, module] of Object.entries(modules)) {
    if (typeof module === "string") {
      result[name] = module;
      continue;
    }
    if (typeof module.js === "string") {
      result[name] = module.js;
      continue;
    }
    if (typeof module.text === "string") {
      result[name] = module.text;
      continue;
    }
    throw new Error(
      `Worker build produced module "${name}" in an unsupported format ` +
        `(${Object.keys(module).join(", ") || "empty"}); only text modules are storable today.`,
    );
  }
  return result;
}
