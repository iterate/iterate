/**
 * Build Docker sandbox image.
 *
 * Uses docker buildx build to create the sandbox image locally.
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

const builtBy = process.env.ITERATE_USER ?? "unknown";

// Local tag for Docker daemon (used by local-docker provider and tests)
const localImageName = process.env.LOCAL_DOCKER_IMAGE_NAME ?? "iterate-sandbox:local";

// Ensure cache directory exists
const cacheDir = join(repoRoot, ".cache");
mkdirSync(cacheDir, { recursive: true });

const buildArgs = [
  "docker",
  "buildx",
  "build",
  "--platform",
  buildPlatform,
  "--load",
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
  ".",
];

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
const buildInfoPath = join(cacheDir, "docker-build-info.json");
writeFileSync(
  buildInfoPath,
  JSON.stringify(
    {
      localImageName,
      gitSha,
      builtBy,
      buildPlatform,
    },
    null,
    2,
  ),
);
console.log(`Build info written to: ${buildInfoPath}`);

// Output the image name for CI to use
console.log(`image_name=${localImageName}`);
