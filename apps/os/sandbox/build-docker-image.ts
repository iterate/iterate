/**
 * Build Docker sandbox image using Depot.
 *
 * Uses depot build for persistent layer caching across CI runs.
 * Depot handles caching automatically - no --cache-from/--cache-to needed.
 *
 * Minimal .git directory for deterministic caching + working git status:
 * We create a minimal .git by packing only HEAD commit + current tree objects.
 */
import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createMinimalGitDirForSha } from "./minimal-git-dir.ts";

const repoRoot = join(import.meta.dirname, "..", "..", "..");

const gitSha = execSync("git rev-parse HEAD", { cwd: repoRoot, encoding: "utf-8" }).trim();
const buildPlatform = process.env.SANDBOX_BUILD_PLATFORM ?? "linux/amd64";
const builtBy = process.env.ITERATE_USER ?? "unknown";

// Detect multi-platform builds (comma-separated platforms)
const isMultiPlatform = buildPlatform.includes(",");

// Local tag for Docker daemon (used by local-docker provider and tests)
const localImageName = process.env.LOCAL_DOCKER_IMAGE_NAME ?? "iterate-sandbox:local";

const depotProjectId =
  process.env.DEPOT_PROJECT_ID ??
  (() => {
    const depotConfigPath = join(repoRoot, "depot.json");
    if (!existsSync(depotConfigPath)) {
      return undefined;
    }
    try {
      const depotConfig = JSON.parse(readFileSync(depotConfigPath, "utf-8")) as { id?: string };
      return depotConfig.id;
    } catch {
      return undefined;
    }
  })();

// Back-compat: PUSH=1 used to indicate "registry push".
// We now save to Depot registry; if PUSH=1 and no explicit save tag, use sha-<gitSha>.
const legacyPushRequested = process.env.PUSH === "1" || process.env.PUSH?.toLowerCase() === "true";

const depotSaveTag = process.env.DEPOT_SAVE_TAG ?? (legacyPushRequested ? `sha-${gitSha}` : null);
const useDepotSave = Boolean(depotSaveTag);
const registryImageName =
  depotProjectId && depotSaveTag ? `registry.depot.dev/${depotProjectId}:${depotSaveTag}` : null;

// Ensure cache directory exists
const cacheDir = join(repoRoot, ".cache");
mkdirSync(cacheDir, { recursive: true });

const minimalGitDir = createMinimalGitDirForSha({
  repoRoot,
  cacheDir,
  gitSha,
  log: (message) => {
    console.log(message);
  },
});
console.log(`Minimal .git directory: ${minimalGitDir}`);

// Multi-platform builds can't be loaded into local daemon, must be saved.
if (isMultiPlatform && !depotSaveTag) {
  console.error("Error: Multi-platform builds require DEPOT_SAVE_TAG to save to Depot registry.");
  console.error("Example: DEPOT_SAVE_TAG=sha-$(git rev-parse HEAD)");
  process.exit(1);
}

if (depotSaveTag && !depotProjectId) {
  console.error("Error: DEPOT_SAVE_TAG set but Depot project ID is missing.");
  console.error("Set DEPOT_PROJECT_ID or ensure depot.json is present.");
  process.exit(1);
}

// Determine output mode: --save to Depot registry, --load for local daemon
const outputArgs = useDepotSave
  ? ["--save", "--save-tag", depotSaveTag!]
  : ["--load", "-t", localImageName];

// Use depot build for persistent layer caching
// depot build accepts the same parameters as docker build
const projectArgs = depotProjectId ? ["--project", depotProjectId] : [];
const buildArgs = [
  "depot",
  "build",
  ...projectArgs,
  "--platform",
  buildPlatform,
  "--progress=plain", // Show all layer details for cache analysis
  ...outputArgs,
  "-f",
  "apps/os/sandbox/Dockerfile",
  // Override the Dockerfile's iterate-synthetic-git stage with our minimal .git directory
  "--build-context",
  `iterate-synthetic-git=${minimalGitDir}`,
  "--build-arg",
  `GIT_SHA=${gitSha}`,
  "--label",
  `com.iterate.built_by=${builtBy}`,
  ".",
];

const quoteArg = (arg: string) => (/\s/.test(arg) ? `"${arg}"` : arg);
const buildCommand = buildArgs.map(quoteArg).join(" ");

if (useDepotSave) {
  console.log(`Depot registry build: ${buildPlatform}`);
  console.log(`Depot image: ${registryImageName}`);
} else {
  console.log(`Local image tag: ${localImageName}`);
  console.log(`Platform: ${buildPlatform}`);
}
console.log("Build command:");
console.log(buildCommand);

// 15-minute timeout for depot build (fails fast instead of GitHub's 6-hour default)
const BUILD_TIMEOUT_MS = 15 * 60 * 1000;

execFileSync(buildArgs[0], buildArgs.slice(1), {
  cwd: repoRoot,
  stdio: "inherit",
  timeout: BUILD_TIMEOUT_MS,
});

// Write build info for downstream scripts (push-docker-image-to-daytona.ts reads this)
const buildInfoPath = join(cacheDir, "depot-build-info.json");
writeFileSync(
  buildInfoPath,
  JSON.stringify(
    {
      depotProjectId: depotProjectId ?? null,
      depotSaveTag: depotSaveTag ?? null,
      localImageName: useDepotSave ? null : localImageName,
      registryImageName: useDepotSave ? registryImageName : null,
      gitSha,
      builtBy,
      buildPlatform,
      isMultiPlatform,
      isSavedToDepot: useDepotSave,
    },
    null,
    2,
  ),
);
console.log(`Build info written to: ${buildInfoPath}`);

// Output the image name for CI to use
const outputImageName = useDepotSave ? registryImageName : localImageName;
console.log(`image_name=${outputImageName}`);
