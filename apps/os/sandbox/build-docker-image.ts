/**
 * Build Docker sandbox image using Depot.
 *
 * Uses depot build for persistent layer caching across CI runs.
 * Depot handles caching automatically - no --cache-from/--cache-to needed.
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
 * Cache optimization:
 * The raw .git directory contains files that change between runs even when the
 * commit is the same (logs/, index, FETCH_HEAD, etc.). To ensure 100% cache hits
 * when the commit hasn't changed, we create deterministic snapshots containing
 * only the essential git files needed for git operations in the container.
 *
 * For non-worktree builds or builders that don't support --build-context (like
 * Daytona), the Dockerfile's fallback stage copies .git from the build context.
 */
import { execFileSync, execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

/**
 * Create a deterministic snapshot of a git directory.
 *
 * Only copies files that are deterministic for a given commit:
 * - HEAD, config, packed-refs (single files)
 * - refs/, objects/ (directories with actual git data)
 *
 * Excludes files that change between runs:
 * - logs/ (reflog with timestamps)
 * - index (staging area)
 * - FETCH_HEAD, ORIG_HEAD, COMMIT_EDITMSG
 * - hooks/, info/
 */
function createDeterministicGitSnapshot(sourceDir: string, label: string): string {
  const snapshotDir = mkdtempSync(join(tmpdir(), `git-snapshot-${label}-`));

  // Essential single files (deterministic for a commit)
  const essentialFiles = ["HEAD", "config", "packed-refs", "shallow"];
  for (const file of essentialFiles) {
    const src = join(sourceDir, file);
    if (existsSync(src)) {
      cpSync(src, join(snapshotDir, file));
    }
  }

  // Essential directories (contain the actual git data)
  const essentialDirs = ["refs", "objects"];
  for (const dir of essentialDirs) {
    const src = join(sourceDir, dir);
    if (existsSync(src)) {
      cpSync(src, join(snapshotDir, dir), { recursive: true });
    }
  }

  return snapshotDir;
}

// Create deterministic snapshots of git directories for cache-friendly builds
console.log("Creating deterministic git snapshots for build context...");
const gitDirSnapshot = createDeterministicGitSnapshot(gitDir, "gitdir");
const commonDirSnapshot = createDeterministicGitSnapshot(commonDir, "commondir");
console.log(`  gitdir snapshot: ${gitDirSnapshot}`);
console.log(`  commondir snapshot: ${commonDirSnapshot}`);

// Cleanup snapshots on exit
const cleanup = () => {
  try {
    rmSync(gitDirSnapshot, { recursive: true, force: true });
    rmSync(commonDirSnapshot, { recursive: true, force: true });
  } catch {
    // Best effort cleanup
  }
};
process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});
process.on("SIGTERM", () => {
  cleanup();
  process.exit(143);
});

// Use depot build for persistent layer caching
// depot build accepts the same parameters as docker build
const buildArgs = [
  "depot",
  "build",
  "--platform",
  buildPlatform,
  "--progress=plain", // Show all layer details for cache analysis
  "--load", // Load image into local Docker daemon
  "-f",
  "apps/os/sandbox/Dockerfile",
  "-t",
  localImageName,
  // Override the Dockerfile's gitdir/commondir stages with deterministic snapshots
  "--build-context",
  `iterate-repo-gitdir=${gitDirSnapshot}`,
  "--build-context",
  `iterate-repo-commondir=${commonDirSnapshot}`,
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

// Write build info for downstream scripts (push-docker-image-to-daytona.ts reads this)
const buildInfoPath = join(cacheDir, "depot-build-info.json");
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
