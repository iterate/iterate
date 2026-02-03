/**
 * Build local Docker sandbox image.
 */
import { execFileSync, execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const baseImageName = process.env.LOCAL_DOCKER_IMAGE_NAME ?? "ghcr.io/iterate/sandbox:local";
const gitSha = execSync("git rev-parse HEAD", { cwd: repoRoot, encoding: "utf-8" }).trim();
const gitDir = execSync("git rev-parse --absolute-git-dir", {
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
const shaTag = `sha-${gitSha}${isDirty ? "-dirty" : ""}`;
const imageRepo = splitImageRef(baseImageName).name;
const builtBy = process.env.ITERATE_USER ?? "unknown";

const push = process.env.PUSH === "1";
const cacheRef = process.env.SANDBOX_BUILD_CACHE_REF ?? "ghcr.io/iterate/sandbox:buildcache";
const localCacheDir =
  process.env.SANDBOX_BUILD_CACHE_DIR ?? join(repoRoot, ".cache", "buildx", "sandbox-local");

const tags = [imageName, `${imageRepo}:${shaTag}`];

const cacheFrom = [`type=local,src=${localCacheDir}`, `type=registry,ref=${cacheRef}`];

const cacheTo = push
  ? [`type=registry,ref=${cacheRef},mode=max`]
  : [`type=local,dest=${localCacheDir},mode=max`];

const buildArgs = [
  "docker",
  "buildx",
  "build",
  push ? "--push" : "--load",
  "-f",
  "apps/os/sandbox/Dockerfile",
  "-t",
  imageName,
  "-t",
  `${imageRepo}:${shaTag}`,
  // BuildKit extra context: lets Dockerfile COPY real .git dir even for worktrees.
  "--build-context",
  `gitdir=${gitDir}`,
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

console.log("Local Docker snapshot tags:");
for (const tag of tags) {
  console.log(`  - ${tag}`);
}
console.log("Docker buildx command:");
console.log(buildCommand);

execFileSync(buildArgs[0], buildArgs.slice(1), {
  cwd: repoRoot,
  stdio: "inherit",
});
