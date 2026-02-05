/**
 * Build Docker sandbox image using Depot.
 *
 * Uses depot.dev for:
 * - Persistent layer caching on fast NVMe SSDs (no network transfer needed)
 * - Shared cache across CI runs and developer machines
 * - Native ARM builds (no QEMU emulation)
 * - Depot Registry for fast image pulls (global CDN)
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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const DEPOT_PROJECT_ID = process.env.DEPOT_PROJECT_ID ?? "lds5v3fpw8";

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

const buildArgs = [
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
  // See file header comment for why this is needed for worktree builds.
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

const quoteArg = (arg: string) => (/\s/.test(arg) ? `"${arg}"` : arg);
const buildCommand = buildArgs.map(quoteArg).join(" ");

console.log(`Depot Registry image: ${depotImageUrl}`);
console.log(`Local image tag: ${localImageName}`);
console.log(`Platform: ${buildPlatform}`);
console.log("Depot build command:");
console.log(buildCommand);

execFileSync(buildArgs[0], buildArgs.slice(1), {
  cwd: repoRoot,
  stdio: "inherit",
});

// Read the actual image name from Depot's metadata file
// --save uses build ID as tag, not our custom tag
const metadataPath = join(cacheDir, "depot-metadata.json");
const depotMetadata = JSON.parse(readFileSync(metadataPath, "utf-8")) as {
  "image.name"?: string;
  "depot.build"?: { buildID?: string; projectID?: string };
};
const actualDepotImageUrl = depotMetadata["image.name"] ?? depotImageUrl;
const buildID = depotMetadata["depot.build"]?.buildID;

// Write the Depot build info for downstream scripts (e.g., push-docker-image-to-daytona.ts)
const depotInfoPath = join(cacheDir, "depot-build-info.json");
writeFileSync(
  depotInfoPath,
  JSON.stringify(
    {
      depotRegistryTag: buildID ?? depotRegistryTag,
      depotImageUrl: actualDepotImageUrl,
      localImageName,
      gitSha,
      builtBy,
      buildPlatform,
      buildID,
    },
    null,
    2,
  ),
);
console.log(`Depot Registry image: ${actualDepotImageUrl}`);
console.log(`Depot build info written to: ${depotInfoPath}`);
