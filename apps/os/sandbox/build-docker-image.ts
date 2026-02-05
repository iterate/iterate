/**
 * Build Docker sandbox image.
 *
 * Supports two build modes (controlled by DOCKER_BUILD_MODE env var):
 *
 * 1. "depot" (default for local dev):
 *    Uses depot build for persistent NVMe layer caching shared across all builds.
 *    Requires depot CLI and authentication.
 *
 * 2. "local" (recommended for CI on fast runners like Depot runners):
 *    Uses docker buildx build with registry cache (ghcr.io).
 *    Builds locally on the runner - no remote builder, no 5GB download.
 *    Cache is fetched from/pushed to registry for cross-run persistence.
 *
 * Git worktree handling:
 * In a git worktree, .git is a file (not a directory) pointing to the real .git
 * folder in the main checkout. That path doesn't exist inside the container, so
 * we can't just COPY .git directly.
 *
 * Solution: We pass --build-context iterate-repo-gitdir=<resolved-git-dir> and
 * --build-context iterate-repo-commondir=<resolved-commondir> to BuildKit, which
 * override the fallback stages in the Dockerfile. The Dockerfile's
 * COPY --from=iterate-repo-* then pulls from our host paths instead of the
 * fallback stages.
 *
 * For non-worktree builds or builders that don't support --build-context (like
 * Daytona), the Dockerfile's fallback stage copies .git from the build context.
 */
import { execFileSync, execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const DEPOT_PROJECT_ID = process.env.DEPOT_PROJECT_ID ?? "lds5v3fpw8";

// Build mode: "depot" uses remote Depot builders with NVMe cache, "local" uses local docker buildx with registry cache
// For CI on Depot runners, "local" is often faster because it avoids downloading the full image from remote builders
const buildMode = (process.env.DOCKER_BUILD_MODE ?? "depot") as "depot" | "local";

// Registry for cache layers (used in "local" mode)
const cacheRegistry = process.env.DOCKER_CACHE_REGISTRY ?? "ghcr.io/iterate/sandbox-cache";

const gitSha = execSync("git rev-parse HEAD", { cwd: repoRoot, encoding: "utf-8" }).trim();
const buildPlatform = process.env.SANDBOX_BUILD_PLATFORM ?? "linux/amd64";

// Get resolved git directory path. For worktrees, this returns the actual .git
// folder (e.g., /repo/.git/worktrees/branch-name), not the .git file in the worktree.
const gitDir = execSync("git rev-parse --absolute-git-dir", {
  cwd: repoRoot,
  encoding: "utf-8",
}).trim();

const commonDir = execSync("git rev-parse --git-common-dir", {
  cwd: repoRoot,
  encoding: "utf-8",
}).trim();

const isDirty =
  execSync("git status --porcelain", { cwd: repoRoot, encoding: "utf-8" }).trim().length > 0;
const builtBy = process.env.ITERATE_USER ?? "unknown";
const gitShaShort = gitSha.slice(0, 7);

// Tag for Depot Registry - this is the canonical image location
const depotRegistryTag = isDirty ? `sha-${gitShaShort}-${builtBy}-dirty` : `sha-${gitSha}`;
const depotImageUrl = `registry.depot.dev/${DEPOT_PROJECT_ID}:${depotRegistryTag}`;

// Local tag for Docker daemon (used by local-docker provider and tests)
const localImageName = process.env.LOCAL_DOCKER_IMAGE_NAME ?? "iterate-sandbox:local";

// Ensure cache directory exists
const cacheDir = join(repoRoot, ".cache");
mkdirSync(cacheDir, { recursive: true });

let buildArgs: string[];

if (buildMode === "local") {
  // Local build mode: use docker buildx with registry cache
  // This builds locally on the runner (no remote builder) and uses registry for cache persistence
  console.log("Build mode: local (docker buildx with registry cache)");
  console.log(`Cache registry: ${cacheRegistry}`);

  buildArgs = [
    "docker",
    "buildx",
    "build",
    "--platform",
    buildPlatform,
    "--load", // Load into local Docker daemon
    "-f",
    "apps/os/sandbox/Dockerfile",
    "-t",
    localImageName,
    // Override the Dockerfile's gitdir/commondir stages with host git paths.
    "--build-context",
    `iterate-repo-gitdir=${gitDir}`,
    "--build-context",
    `iterate-repo-commondir=${commonDir}`,
    "--build-arg",
    `GIT_SHA=${gitSha}`,
    "--label",
    `com.iterate.built_by=${builtBy}`,
    // Registry cache for layer persistence across CI runs
    "--cache-from",
    `type=registry,ref=${cacheRegistry}:cache`,
    "--cache-to",
    `type=registry,ref=${cacheRegistry}:cache,mode=max`,
    ".",
  ];
} else {
  // Depot build mode: use remote Depot builders with persistent NVMe cache
  // Faster for repeated builds due to NVMe cache, but requires downloading the image
  console.log("Build mode: depot (remote Depot builders with NVMe cache)");

  buildArgs = [
    "depot",
    "build",
    "--platform",
    buildPlatform,
    "--load", // Load into local Docker daemon
    "--save", // Save to Depot Registry
    "--metadata-file",
    join(cacheDir, "depot-metadata.json"),
    "-f",
    "apps/os/sandbox/Dockerfile",
    "-t",
    localImageName,
    // Override the Dockerfile's gitdir/commondir stages with host git paths.
    "--build-context",
    `iterate-repo-gitdir=${gitDir}`,
    "--build-context",
    `iterate-repo-commondir=${commonDir}`,
    "--build-arg",
    `GIT_SHA=${gitSha}`,
    "--label",
    `com.iterate.built_by=${builtBy}`,
    // Depot handles caching automatically - no --cache-from/--cache-to needed
    ".",
  ];
}

const quoteArg = (arg: string) => (/\s/.test(arg) ? `"${arg}"` : arg);
const buildCommand = buildArgs.map(quoteArg).join(" ");

console.log(`Local image tag: ${localImageName}`);
console.log(`Platform: ${buildPlatform}`);
console.log("Build command:");
console.log(buildCommand);

execFileSync(buildArgs[0], buildArgs.slice(1), {
  cwd: repoRoot,
  stdio: "inherit",
});

// Write build info for downstream scripts
const depotInfoPath = join(cacheDir, "depot-build-info.json");
writeFileSync(
  depotInfoPath,
  JSON.stringify(
    {
      buildMode,
      depotRegistryTag,
      depotImageUrl: buildMode === "depot" ? depotImageUrl : undefined,
      localImageName,
      gitSha,
      builtBy,
      buildPlatform,
    },
    null,
    2,
  ),
);
console.log(`Build info written to: ${depotInfoPath}`);
