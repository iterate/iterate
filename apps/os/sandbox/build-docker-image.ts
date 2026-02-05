/**
 * Build Docker sandbox image using Depot.
 *
 * Uses depot build for persistent layer caching across CI runs.
 * Depot handles caching automatically - no --cache-from/--cache-to needed.
 *
 * Synthetic .git directory for 100% cache hits:
 * To ensure deterministic layer caching when the commit SHA hasn't changed, we
 * create a minimal synthetic .git directory containing only:
 * - HEAD pointing directly to the commit SHA
 * - A minimal config file
 * - Empty objects and refs directories
 *
 * This is 100% deterministic because the only variable content is the SHA.
 * The container can use GIT_SHA env var for commit identification.
 */
import { execFileSync, execSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "..", "..", "..");

const gitSha = execSync("git rev-parse HEAD", { cwd: repoRoot, encoding: "utf-8" }).trim();
const buildPlatform = process.env.SANDBOX_BUILD_PLATFORM ?? "linux/amd64";
const builtBy = process.env.ITERATE_USER ?? "unknown";

// Local tag for Docker daemon (used by local-docker provider and tests)
const localImageName = process.env.LOCAL_DOCKER_IMAGE_NAME ?? "iterate-sandbox:local";

// Ensure cache directory exists
const cacheDir = join(repoRoot, ".cache");
mkdirSync(cacheDir, { recursive: true });

/**
 * Create a minimal synthetic .git directory that is 100% deterministic.
 *
 * This creates a bare-minimum git directory with:
 * - HEAD pointing directly to the commit SHA (detached HEAD)
 * - A minimal config file
 * - Empty objects and refs directories (required for git to recognize this as a repo)
 *
 * This is 100% deterministic because the only variable content is the SHA,
 * which is captured in HEAD. We don't copy any objects - the container can
 * use GIT_SHA env var for commit identification, or fetch from remote if
 * full git history is needed.
 *
 * Uses a fixed path based on git SHA so Docker can cache the build context.
 */
function createDeterministicGitDir(): string {
  // Use a fixed path in .cache based on git SHA
  const gitDirPath = join(cacheDir, `synthetic-git-${gitSha}`);

  // Clean and recreate to ensure fresh state
  rmSync(gitDirPath, { recursive: true, force: true });
  mkdirSync(gitDirPath, { recursive: true });

  // Create HEAD pointing to the SHA (detached HEAD format)
  writeFileSync(join(gitDirPath, "HEAD"), `${gitSha}\n`);

  // Create minimal config
  writeFileSync(
    join(gitDirPath, "config"),
    `[core]
\trepositoryformatversion = 0
\tfilemode = true
\tbare = false
`,
  );

  // Create empty objects directory (required for git to recognize this as a repo)
  mkdirSync(join(gitDirPath, "objects"), { recursive: true });

  // Create empty refs directory (required for git to recognize this as a repo)
  mkdirSync(join(gitDirPath, "refs", "heads"), { recursive: true });

  return gitDirPath;
}

// Create deterministic synthetic .git directory for cache-friendly builds
const syntheticGitDir = createDeterministicGitDir();
console.log(`Synthetic .git directory: ${syntheticGitDir}`);

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
  // Override the Dockerfile's synthetic-git stage with our deterministic .git directory
  "--build-context",
  `iterate-synthetic-git=${syntheticGitDir}`,
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
