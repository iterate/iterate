/**
 * Build Docker sandbox image using Depot.
 *
 * Uses depot bake for persistent layer caching across CI runs.
 * Bake is more efficient than build for --load because it only transfers
 * missing layers instead of the full image tarball.
 *
 * Depot handles caching automatically - no --cache-from/--cache-to needed.
 *
 * Minimal .git directory for deterministic caching + working git status:
 * We create a minimal .git by packing just the objects needed for HEAD.
 * This allows `git status` to work in the container (showing dirty files)
 * while keeping the build context 100% deterministic for the same SHA.
 */
import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "..", "..", "..");

const gitSha = execSync("git rev-parse HEAD", { cwd: repoRoot, encoding: "utf-8" }).trim();
const buildPlatform = process.env.SANDBOX_BUILD_PLATFORM ?? "linux/amd64";
const builtBy = process.env.ITERATE_USER ?? "unknown";

// Detect multi-platform builds (comma-separated platforms)
const isMultiPlatform = buildPlatform.includes(",");

// Local tag for Docker daemon (used by local-docker provider and tests)
const localImageName = process.env.LOCAL_DOCKER_IMAGE_NAME ?? "iterate-sandbox:local";

// Registry image name for multi-platform builds (can't --load multiple platforms)
const registryImageName = process.env.REGISTRY_IMAGE_NAME;

// Ensure cache directory exists
const cacheDir = join(repoRoot, ".cache");
mkdirSync(cacheDir, { recursive: true });

/**
 * Create a minimal .git directory with packed objects for HEAD.
 *
 * This creates a functional git directory that allows `git status` to work
 * while being 100% deterministic for the same commit SHA.
 *
 * Contains:
 * - HEAD pointing to the commit SHA
 * - A minimal config file
 * - Packed objects for HEAD (commit + trees + blobs)
 *
 * The pack file is deterministic because `git pack-objects` produces
 * identical output for identical input objects.
 */
function createMinimalGitDir(): string {
  const gitDirPath = join(cacheDir, `minimal-git-${gitSha}`);

  // Check if we already have a valid cached version
  const packDir = join(gitDirPath, "objects", "pack");
  if (existsSync(packDir)) {
    const packFiles = readdirSync(packDir).filter((f) => f.endsWith(".pack"));
    if (packFiles.length > 0) {
      console.log(`Using cached minimal .git for ${gitSha}`);
      return gitDirPath;
    }
  }

  console.log(`Creating minimal .git with packed objects for ${gitSha}...`);

  // Clean and recreate
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

  // Create required directories
  mkdirSync(join(gitDirPath, "objects", "pack"), { recursive: true });
  mkdirSync(join(gitDirPath, "refs", "heads"), { recursive: true });

  // Get all objects reachable from HEAD (commit, trees, blobs)
  // Using --no-object-names to get just SHAs, one per line
  const objectList = execSync(`git rev-list --objects ${gitSha} --no-object-names`, {
    cwd: repoRoot,
    encoding: "utf-8",
    maxBuffer: 100 * 1024 * 1024, // 100MB buffer for large repos
  }).trim();

  // Pack the objects deterministically
  // --threads=1 ensures deterministic output
  // Output goes to pack-HASH.pack and pack-HASH.idx
  const packBasename = join(packDir, "pack");
  execSync(`git pack-objects --threads=1 ${packBasename}`, {
    cwd: repoRoot,
    input: objectList,
    encoding: "utf-8",
    maxBuffer: 100 * 1024 * 1024,
  });

  // Verify pack was created
  const createdPacks = readdirSync(packDir).filter((f) => f.endsWith(".pack"));
  if (createdPacks.length === 0) {
    throw new Error("Failed to create git pack file");
  }

  const packSize = createdPacks
    .map((f) => statSync(join(packDir, f)).size)
    .reduce((a, b) => a + b, 0);

  console.log(`Created pack file: ${(packSize / 1024 / 1024).toFixed(1)}MB`);

  return gitDirPath;
}

// Create minimal .git directory with packed objects for cache-friendly builds
const minimalGitDir = createMinimalGitDir();
console.log(`Minimal .git directory: ${minimalGitDir}`);

// Multi-platform builds require pushing to a registry (can't --load multiple platforms)
if (isMultiPlatform && !registryImageName) {
  console.error("Error: Multi-platform builds require REGISTRY_IMAGE_NAME environment variable");
  console.error("Example: REGISTRY_IMAGE_NAME=ghcr.io/iterate/sandbox:latest");
  process.exit(1);
}

// Use depot bake for efficient --load (only transfers missing layers)
// Bake uses variables from docker-bake.hcl, passed via --set flags
const bakeFile = join(import.meta.dirname, "docker-bake.hcl");

const bakeArgs = [
  "depot",
  "bake",
  "-f",
  bakeFile,
  "--progress=plain",
  // Pass variables to the bake file
  "--set",
  `sandbox.args.GIT_SHA=${gitSha}`,
  "--set",
  `sandbox.platform=${buildPlatform}`,
  "--set",
  `sandbox.tags=${isMultiPlatform ? registryImageName! : localImageName}`,
  "--set",
  `sandbox.labels.com\\.iterate\\.built_by=${builtBy}`,
  "--set",
  `sandbox.contexts.iterate-synthetic-git=${minimalGitDir}`,
  // Output mode
  isMultiPlatform ? "--push" : "--load",
];

const quoteArg = (arg: string) => (/\s/.test(arg) ? `"${arg}"` : arg);
const buildCommand = bakeArgs.map(quoteArg).join(" ");

if (isMultiPlatform) {
  console.log(`Multi-platform build: ${buildPlatform}`);
  console.log(`Registry image: ${registryImageName}`);
} else {
  console.log(`Local image tag: ${localImageName}`);
  console.log(`Platform: ${buildPlatform}`);
}
console.log("Build command:");
console.log(buildCommand);

// 15-minute timeout for depot bake (fails fast instead of GitHub's 6-hour default)
const BUILD_TIMEOUT_MS = 15 * 60 * 1000;

execFileSync(bakeArgs[0], bakeArgs.slice(1), {
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
      localImageName: isMultiPlatform ? null : localImageName,
      registryImageName: isMultiPlatform ? registryImageName : null,
      gitSha,
      builtBy,
      buildPlatform,
      isMultiPlatform,
    },
    null,
    2,
  ),
);
console.log(`Build info written to: ${buildInfoPath}`);

// Output the image name for CI to use
const outputImageName = isMultiPlatform ? registryImageName : localImageName;
console.log(`image_name=${outputImageName}`);
