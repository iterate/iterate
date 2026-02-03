/**
 * Build local Docker sandbox image.
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
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const baseImageName = process.env.LOCAL_DOCKER_IMAGE_NAME ?? "ghcr.io/iterate/sandbox:local";
const gitSha = execSync("git rev-parse HEAD", { cwd: repoRoot, encoding: "utf-8" }).trim();

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

function splitImageRef(image: string): { name: string; tag: string } {
  const lastSlash = image.lastIndexOf("/");
  const lastColon = image.lastIndexOf(":");
  if (lastColon > lastSlash) {
    return { name: image.slice(0, lastColon), tag: image.slice(lastColon + 1) };
  }
  return { name: image, tag: "latest" };
}

const imageName = baseImageName;
const imageRepo = splitImageRef(baseImageName).name;
const builtBy = process.env.ITERATE_USER ?? "unknown";
const gitShaShort = gitSha.slice(0, 7);
const shortShaTag = `sha-${gitShaShort}${isDirty ? `-${builtBy}-dirty` : ""}`;
const fullShaTag = `sha-${gitSha}${isDirty ? `-${builtBy}-dirty` : ""}`;

const push = process.env.PUSH === "1";
const cacheRef = process.env.SANDBOX_BUILD_CACHE_REF ?? "ghcr.io/iterate/sandbox:buildcache";
const localCacheDir =
  process.env.SANDBOX_BUILD_CACHE_DIR ?? join(repoRoot, ".cache", "buildx", "sandbox-local");

const tags = [`${imageRepo}:${shortShaTag}`, `${imageRepo}:${fullShaTag}`, imageName];

const cacheFrom = [`type=local,src=${localCacheDir}`, `type=registry,ref=${cacheRef}`];

const cacheTo = push
  ? [`type=registry,ref=${cacheRef},mode=max`]
  : [`type=local,dest=${localCacheDir},mode=max`];

const buildArgs = [
  "docker",
  "buildx",
  "build",
  "--platform",
  "linux/amd64",
  push ? "--push" : "--load",
  "-f",
  "apps/os/sandbox/Dockerfile",
  ...tags.flatMap((tag) => ["-t", tag]),
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
  ...cacheFrom.flatMap((value) => ["--cache-from", value]),
  ...cacheTo.flatMap((value) => ["--cache-to", value]),
  ".",
];

const quoteArg = (arg: string) => (/\s/.test(arg) ? `"${arg}"` : arg);
const buildCommand = buildArgs.map(quoteArg).join(" ");

if (!push) {
  mkdirSync(localCacheDir, { recursive: true });
}

console.log("Docker image tags (preferred first):");
for (const tag of tags) {
  console.log(`  - ${tag}`);
}
console.log("Docker buildx command:");
console.log(buildCommand);

execFileSync(buildArgs[0], buildArgs.slice(1), {
  cwd: repoRoot,
  stdio: "inherit",
});
