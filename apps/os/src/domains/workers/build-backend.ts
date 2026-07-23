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

// worker-bundler currently reports dependency-install failures as warnings
// and can still return an esbuild output containing unresolved bare imports.
// Such output is not a usable artifact: Worker Loader rejects it only when
// the first request tries to instantiate the module graph. Keep ordinary
// compiler warnings, but fail the build boundary on every install-warning
// shape emitted by worker-bundler's installer.
const DEPENDENCY_INSTALL_FAILURE_WARNING_PATTERNS = [
  /^Failed to parse package\.json\b/,
  /^Could not resolve version for\b/,
  /^Version .+ not found for\b/,
  /^Failed to install\b/,
] as const;

const PACKAGE_DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

type PackageManifest = Record<string, unknown> &
  Partial<Record<(typeof PACKAGE_DEPENDENCY_FIELDS)[number], Record<string, unknown>>>;

/** Prepare declared `iterate` specs for worker-bundler. A deployment preview
 * pin replaces every declaration; the root declaration is always promoted to
 * a runtime dependency because worker-bundler deliberately ignores
 * devDependencies. The rewrite is build-local and never changes the repo. */
function applyIteratePackageSpecOverride(
  files: Record<string, string>,
  iteratePackageSpec: string | undefined,
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

  let declaredPackageSpec: unknown;
  let changed = false;
  for (const field of PACKAGE_DEPENDENCY_FIELDS) {
    const dependencies = manifest[field];
    if (
      dependencies === null ||
      typeof dependencies !== "object" ||
      Array.isArray(dependencies) ||
      !Object.hasOwn(dependencies, "iterate")
    ) {
      continue;
    }
    declaredPackageSpec ??= dependencies.iterate;
    if (iteratePackageSpec !== undefined && dependencies.iterate !== iteratePackageSpec) {
      dependencies.iterate = iteratePackageSpec;
      changed = true;
    }
  }
  if (declaredPackageSpec === undefined) return files;

  const runtimeSpec = iteratePackageSpec ?? declaredPackageSpec;
  if (manifest.dependencies?.iterate !== runtimeSpec) {
    manifest.dependencies = {
      ...manifest.dependencies,
      iterate: runtimeSpec,
    };
    changed = true;
  }
  if (!changed) return files;

  return { ...files, "package.json": `${JSON.stringify(manifest, null, 2)}\n` };
}

/** Resolve `files`, then make one direct createWorker/createApp call in the
 * isolated compiler sidecar. */
export async function executeWorkerBuild(input: {
  files: Record<string, string>;
  iteratePackageSpec?: string;
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
  const files = applyIteratePackageSpecOverride(input.files, input.iteratePackageSpec);
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
    const dependencyInstallFailures = built.warnings.filter(
      (warning): warning is string =>
        typeof warning === "string" &&
        DEPENDENCY_INSTALL_FAILURE_WARNING_PATTERNS.some((pattern) => pattern.test(warning)),
    );
    if (dependencyInstallFailures.length > 0) {
      throw new WorkerBuildFailedError(
        buildFailureMessageFromError(dependencyInstallFailures.join("\n")),
      );
    }
  }
  return built;
}
