import type { Plugin } from "esbuild";

const ESM_SH_ORIGIN = "https://esm.sh";
const ESM_SH_NAMESPACE = "esm-sh-iterate";
const ITERATE_PACKAGE_PREFIX = "https://pkg.pr.new/iterate/iterate/iterate@";
const MAX_REMOTE_MODULES = 256;
const MAX_REMOTE_MODULE_BYTES = 2 * 1024 * 1024;
const MAX_REMOTE_GRAPH_BYTES = 8 * 1024 * 1024;
const REMOTE_MODULE_TIMEOUT_MS = 30_000;

type BundlerOptions = {
  bundle?: boolean;
  files: Record<string, string>;
};

type BundlerPluginOptions = {
  __dangerouslyUseEsBuildPluginsDoNotUseOrYouWillBeFired?: unknown[];
};

type PackageManifest = {
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  [key: string]: unknown;
};

/**
 * Replace a validated pkg.pr.new Iterate dependency with an esm.sh resolver.
 *
 * worker-bundler installs manifest dependencies before its esbuild plugins
 * run, and its npm installer only understands registry versions. Removing
 * this one direct URL from the in-memory manifest prevents that unsupported
 * install without changing the source snapshot or any ordinary npm package.
 */
export function withEsmShIteratePackage<T extends BundlerOptions>(
  options: T,
): T & BundlerPluginOptions {
  if (options.bundle === false) return options;

  const manifestSource = options.files["package.json"];
  if (manifestSource === undefined) return options;

  let manifest: PackageManifest;
  try {
    manifest = JSON.parse(manifestSource) as PackageManifest;
  } catch {
    // Preserve worker-bundler's own package.json diagnostics.
    return options;
  }

  const dependencySpec = packageSpec(manifest.dependencies);
  const devDependencySpec = packageSpec(manifest.devDependencies);
  if (
    dependencySpec !== undefined &&
    devDependencySpec !== undefined &&
    dependencySpec !== devDependencySpec
  ) {
    throw new Error(
      "package.json declares different pkg.pr.new versions for iterate in dependencies and devDependencies",
    );
  }
  const packageSpecValue = dependencySpec ?? devDependencySpec;
  if (packageSpecValue === undefined) return options;

  const iterateEsmShRoot = esmShRootForPkgPrNew(packageSpecValue);
  if (iterateEsmShRoot === undefined) return options;

  const preparedManifest: PackageManifest = { ...manifest };
  preparedManifest.dependencies = withoutIterate(manifest.dependencies);
  preparedManifest.devDependencies = withoutIterate(manifest.devDependencies);
  if (preparedManifest.dependencies === undefined) delete preparedManifest.dependencies;
  if (preparedManifest.devDependencies === undefined) delete preparedManifest.devDependencies;

  const pluginOptions = options as T & BundlerPluginOptions;
  return {
    ...options,
    files: {
      ...options.files,
      "package.json": JSON.stringify(preparedManifest),
    },
    __dangerouslyUseEsBuildPluginsDoNotUseOrYouWillBeFired: [
      createEsmShIteratePlugin(iterateEsmShRoot),
      ...(pluginOptions.__dangerouslyUseEsBuildPluginsDoNotUseOrYouWillBeFired ?? []),
    ] as unknown[],
  };
}

type EsmShIteratePluginOptions = {
  fetcher?: typeof fetch;
  maxGraphBytes?: number;
  maxModuleBytes?: number;
  maxModules?: number;
};

/** Fetch an unbundled esm.sh graph and let the caller's esbuild tree-shake it. */
export function createEsmShIteratePlugin(
  iterateEsmShRoot: string,
  options: EsmShIteratePluginOptions = {},
): Plugin {
  const root = esmShUrl(iterateEsmShRoot).href.replace(/\/$/, "");
  const fetcher = options.fetcher ?? globalThis.fetch;
  const maxGraphBytes = options.maxGraphBytes ?? MAX_REMOTE_GRAPH_BYTES;
  const maxModuleBytes = options.maxModuleBytes ?? MAX_REMOTE_MODULE_BYTES;
  const maxModules = options.maxModules ?? MAX_REMOTE_MODULES;
  const moduleSources = new Map<string, Promise<string>>();
  let graphBytes = 0;

  const loadModule = (moduleUrl: string): Promise<string> => {
    const url = esmShUrl(moduleUrl).href;
    const cached = moduleSources.get(url);
    if (cached !== undefined) return cached;
    if (moduleSources.size >= maxModules) {
      throw new Error(`esm.sh Iterate graph exceeded ${maxModules} modules`);
    }

    const loading = (async () => {
      const response = await fetcher(url, {
        headers: { accept: "application/javascript, text/javascript;q=0.9" },
        redirect: "follow",
        signal: AbortSignal.timeout(REMOTE_MODULE_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(
          `esm.sh returned ${response.status} ${response.statusText} for ${JSON.stringify(url)}`,
        );
      }
      if (response.url !== "") esmShUrl(response.url);

      const contentType = response.headers.get("content-type");
      if (
        contentType !== null &&
        !contentType.includes("javascript") &&
        !contentType.startsWith("text/plain")
      ) {
        throw new Error(
          `esm.sh returned unsupported content type ${JSON.stringify(contentType)} for ${JSON.stringify(url)}`,
        );
      }
      const contentLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > maxModuleBytes) {
        throw new Error(`esm.sh module ${JSON.stringify(url)} exceeds ${maxModuleBytes} bytes`);
      }

      const reader = response.body?.getReader();
      if (reader === undefined) return "";
      const decoder = new TextDecoder();
      let source = "";
      let moduleBytes = 0;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        moduleBytes += chunk.value.byteLength;
        graphBytes += chunk.value.byteLength;
        if (moduleBytes > maxModuleBytes) {
          await reader.cancel();
          throw new Error(`esm.sh module ${JSON.stringify(url)} exceeds ${maxModuleBytes} bytes`);
        }
        if (graphBytes > maxGraphBytes) {
          await reader.cancel();
          throw new Error(`esm.sh Iterate graph exceeded ${maxGraphBytes} bytes`);
        }
        source += decoder.decode(chunk.value, { stream: true });
      }
      return source + decoder.decode();
    })();
    moduleSources.set(url, loading);
    return loading;
  };

  return {
    name: ESM_SH_NAMESPACE,
    setup(build) {
      build.onResolve({ filter: /^iterate(?:\/.*)?$/ }, (args) => {
        const subpath = iterateSubpath(args.path);
        return {
          namespace: ESM_SH_NAMESPACE,
          path: `${root}${subpath === "" ? "" : `/${subpath}`}?bundle=false&target=es2022`,
        };
      });
      build.onResolve({ filter: /.*/, namespace: ESM_SH_NAMESPACE }, (args) => {
        const cloudflareModule = cloudflareSpecifier(args.path);
        if (cloudflareModule !== undefined) {
          return { external: true, path: cloudflareModule };
        }
        if (
          args.path.startsWith("/") ||
          args.path.startsWith("./") ||
          args.path.startsWith("../") ||
          args.path.startsWith(`${ESM_SH_ORIGIN}/`)
        ) {
          return {
            namespace: ESM_SH_NAMESPACE,
            path: esmShUrl(new URL(args.path, args.importer).href).href,
          };
        }
        throw new Error(
          `esm.sh Iterate module ${JSON.stringify(args.importer)} returned unsupported import ${JSON.stringify(args.path)}`,
        );
      });
      build.onLoad({ filter: /.*/, namespace: ESM_SH_NAMESPACE }, async (args) => ({
        contents: await loadModule(args.path),
        loader: "js",
      }));
    },
  };
}

function packageSpec(section: Record<string, unknown> | undefined): string | undefined {
  const value = section?.iterate;
  return typeof value === "string" ? value : undefined;
}

function withoutIterate(
  section: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (section === undefined || !Object.hasOwn(section, "iterate")) return section;
  const copy = { ...section };
  delete copy.iterate;
  return Object.keys(copy).length === 0 ? undefined : copy;
}

function esmShRootForPkgPrNew(spec: string): string | undefined {
  if (!spec.startsWith(ITERATE_PACKAGE_PREFIX)) return undefined;
  const ref = spec.slice(ITERATE_PACKAGE_PREFIX.length);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(ref)) {
    throw new Error(`Unsupported Iterate pkg.pr.new ref ${JSON.stringify(ref)}`);
  }
  return `${ESM_SH_ORIGIN}/pr/iterate/iterate/iterate@${encodeURIComponent(ref)}`;
}

function iterateSubpath(specifier: string): string {
  if (specifier === "iterate") return "";
  const subpath = specifier.slice("iterate/".length);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(subpath) || subpath.split("/").includes("..")) {
    throw new Error(`Unsupported Iterate package subpath ${JSON.stringify(subpath)}`);
  }
  return subpath;
}

function cloudflareSpecifier(specifier: string): string | undefined {
  const normalized = specifier.startsWith("/") ? specifier.slice(1) : specifier;
  if (!normalized.startsWith("cloudflare:")) return undefined;
  return normalized.split(/[?#]/, 1)[0];
}

function esmShUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.origin !== ESM_SH_ORIGIN ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  ) {
    throw new Error(`Refusing non-esm.sh module URL ${JSON.stringify(value)}`);
  }
  return url;
}
