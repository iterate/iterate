import {
  buildFailureMessageFromError,
  WorkerBuildFailedError,
  type WorkerBuildModule,
  type WorkerBuildAssetMetadata,
  type WorkerBuildWranglerConfig,
} from "./artifact-store.ts";
import type { DynamicWorkerSource, WorkerBundlerAssetConfig } from "./schemas.ts";

/** Keep this pin in sync with apps/os/package.json. It participates in every
 * build key so a bundler upgrade cannot reuse artifacts made by older code. */
export const WORKER_BUNDLER_VERSION = "0.2.1";

/** Dynamic-worker compatibility moves independently from the OS worker. */
export const WORKER_COMPATIBILITY_DATE = "2026-05-01";
export const WORKER_COMPATIBILITY_FLAGS = ["nodejs_compat"];

// worker-bundler reports dependency-install failures as warnings, and (via
// our patch — see patches/@cloudflare__worker-bundler@0.2.1.patch) warns when
// its resolver keeps an unresolvable import external. Either way the output
// is not a usable artifact: Worker Loader rejects it only when the first
// request tries to instantiate the module graph, which surfaces as a cryptic
// `No such module` delivery failure instead of a build error. Keep ordinary
// compiler warnings, but fail the build boundary on every install-warning
// shape emitted by worker-bundler's installer and on unresolved imports
// (below).
const DEPENDENCY_INSTALL_FAILURE_WARNING_PATTERNS = [
  /^Failed to parse package\.json\b/,
  /^Could not resolve version for\b/,
  /^Version .+ not found for\b/,
  /^Failed to install\b/,
] as const;

/**
 * Bare node builtins nodejs_compat provides at runtime (WORKER_COMPATIBILITY_FLAGS
 * above): imports of these legitimately stay external, everything else external
 * is a startup failure. Base names only — subpath imports like `stream/web` or
 * `fs/promises` share their base's entry.
 */
const NODE_BUILTIN_BASE_NAMES = new Set([
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

/**
 * The warnings that mean the artifact cannot instantiate: unresolved imports
 * kept external (`Failed to resolve '<specifier>' from <importer>` — emitted
 * by our worker-bundler patch in the esbuild lane and by the stock transform
 * lane) and files the transform lane could not read at all. Scheme'd
 * specifiers (`node:*`, `cloudflare:*`) and bare node builtins are exempt —
 * the runtime provides those.
 */
function unresolvedImportFailures(warnings: readonly string[]): string[] {
  const failures: string[] = [];
  for (const warning of warnings) {
    if (warning.startsWith("File not found: ")) {
      failures.push(warning);
      continue;
    }
    const match = /^Failed to resolve '([^']+)' from /.exec(warning);
    if (match === null) continue;
    const specifier = match[1]!;
    if (/^[a-zA-Z][\w+.-]*:/.test(specifier)) continue;
    const base = specifier.startsWith("@")
      ? specifier.split("/").slice(0, 2).join("/")
      : specifier.split("/")[0]!;
    if (NODE_BUILTIN_BASE_NAMES.has(base)) continue;
    failures.push(warning);
  }
  return failures;
}

const PACKAGE_DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

export type FirstPartyPackageSpecs = {
  iterate: string | undefined;
  tasks: string | undefined;
};

/** Prepare first-party package specs for worker-bundler. Deployment preview
 * pins replace every declaration; root declarations are promoted to runtime
 * dependencies because worker-bundler deliberately ignores devDependencies.
 * The rewrite is build-local and never changes the repo. */
type PackageManifest = Record<string, unknown> &
  Partial<Record<(typeof PACKAGE_DEPENDENCY_FIELDS)[number], Record<string, unknown>>>;

function applyFirstPartyPackageSpecOverrides(
  files: Record<string, string>,
  packageSpecs: FirstPartyPackageSpecs,
): Record<string, string> {
  const content = files["package.json"];
  if (content === undefined) return files;

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    // Preserve worker-bundler's own invalid-manifest error classification.
    return files;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return files;
  // Safe after the object guard; dependency fields get their own shape checks below.
  const manifest = parsed as PackageManifest;

  let changed = false;
  for (const { name, override } of [
    { name: "iterate", override: packageSpecs.iterate },
    { name: "@iterate-com/tasks", override: packageSpecs.tasks },
  ]) {
    let declaredPackageSpec: unknown;
    for (const field of PACKAGE_DEPENDENCY_FIELDS) {
      const dependencies = manifest[field];
      if (
        dependencies === null ||
        typeof dependencies !== "object" ||
        Array.isArray(dependencies) ||
        !Object.hasOwn(dependencies, name)
      ) {
        continue;
      }
      if (declaredPackageSpec === undefined) declaredPackageSpec = dependencies[name];
      if (override !== undefined && dependencies[name] !== override) {
        dependencies[name] = override;
        changed = true;
      }
    }
    if (declaredPackageSpec === undefined) continue;

    const runtimeSpec = override === undefined ? declaredPackageSpec : override;
    if (manifest.dependencies?.[name] !== runtimeSpec) {
      manifest.dependencies = {
        ...manifest.dependencies,
        [name]: runtimeSpec,
      };
      changed = true;
    }
  }
  if (!changed) return files;

  return { ...files, "package.json": `${JSON.stringify(manifest, null, 2)}\n` };
}

/** Resolve `files`, then make one direct createWorker/createApp call in the
 * isolated compiler sidecar. */
export async function executeWorkerBuild(input: {
  files: Record<string, string>;
  packageSpecs: FirstPartyPackageSpecs;
  source: DynamicWorkerSource;
  workerBundler: Pick<import("../../worker-bundler.ts").default, "createApp" | "createWorker">;
}): Promise<{
  assetConfig?: WorkerBundlerAssetConfig;
  assetManifest: Record<string, WorkerBuildAssetMetadata>;
  assets: Record<string, string>;
  mainModule: string;
  modules: Record<string, WorkerBuildModule>;
  warnings: string[];
  wranglerConfig?: WorkerBuildWranglerConfig;
}> {
  const files = applyFirstPartyPackageSpecOverrides(input.files, input.packageSpecs);
  if ("createApp" in input.source) {
    const { files: _files, ...options } = input.source.createApp;
    return unwrapBuildResult(
      await input.workerBundler.createApp({
        ...options,
        files,
      }),
    );
  }

  const { files: _files, ...options } = input.source.createWorker;
  const built = unwrapBuildResult(
    await input.workerBundler.createWorker({
      ...options,
      files,
    }),
  );
  return { assetManifest: {}, assets: {}, ...built };
}

function unwrapBuildResult<T>(result: { error: string } | { result: T }): T {
  if ("error" in result) {
    throw new WorkerBuildFailedError(buildFailureMessageFromError(result.error));
  }
  const built = result.result;
  if (
    typeof built === "object" &&
    built !== null &&
    "warnings" in built &&
    Array.isArray(built.warnings)
  ) {
    const warnings = built.warnings.filter(
      (warning): warning is string => typeof warning === "string",
    );
    const dependencyInstallFailures = warnings.filter((warning) =>
      DEPENDENCY_INSTALL_FAILURE_WARNING_PATTERNS.some((pattern) => pattern.test(warning)),
    );
    if (dependencyInstallFailures.length > 0) {
      throw new WorkerBuildFailedError(
        buildFailureMessageFromError(dependencyInstallFailures.join("\n")),
      );
    }
    const unresolvedImports = unresolvedImportFailures(warnings);
    if (unresolvedImports.length > 0) {
      throw new WorkerBuildFailedError(
        buildFailureMessageFromError(
          [
            "The built worker would fail at startup with `No such module` — it contains imports that do not resolve:",
            ...unresolvedImports.map((warning) => `  ${warning}`),
            "Declare the missing dependency in package.json, or update the import if the installed package no longer provides that entry. Node builtins can be imported with the `node:` prefix.",
          ].join("\n"),
        ),
      );
    }
  }
  return built;
}
