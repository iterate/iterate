import { execFileSync, execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "..", "..", "..");

const imageTag = process.env.JONASLAND_SANDBOX_IMAGE || "jonasland-sandbox:local";
const buildPlatform = process.env.JONASLAND_SANDBOX_BUILD_PLATFORM;
const skipLoad = process.env.JONASLAND_SANDBOX_SKIP_LOAD === "true";
const cacheDir =
  process.env.JONASLAND_SANDBOX_CACHE_DIR ||
  join(repoRoot, ".cache", "buildx", "jonasland-sandbox");
const cacheMode = process.env.JONASLAND_SANDBOX_CACHE_MODE || "max";

function getBuildxDriver(): string | null {
  try {
    const inspect = execSync("docker buildx inspect", { cwd: repoRoot, encoding: "utf-8" });
    const match = inspect.match(/^Driver:\s+(\S+)/m);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

const buildxDriver = getBuildxDriver();
const supportsLocalCacheExport = buildxDriver !== "docker";
const gitSha = (() => {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: repoRoot, encoding: "utf-8" }).trim();
  } catch {
    return "unknown";
  }
})();

mkdirSync(cacheDir, { recursive: true });

console.log(`Building ${imageTag} (git=${gitSha})`);
if (supportsLocalCacheExport) {
  console.log(`Build cache dir: ${cacheDir}`);
} else {
  console.log(
    `Skipping explicit local cache export (buildx driver=${buildxDriver ?? "unknown"} does not support --cache-to type=local).`,
  );
}
if (buildPlatform) {
  console.log(`Build platform: ${buildPlatform}`);
}

const baseArgs = [
  "buildx",
  "build",
  "--progress=plain",
  "-f",
  "jonasland/sandbox/Dockerfile",
  "-t",
  imageTag,
  "--build-arg",
  `GIT_SHA=${gitSha}`,
  ...(buildPlatform ? ["--platform", buildPlatform] : []),
  ...(skipLoad ? [] : ["--load"]),
  ".",
];

const cacheArgs = supportsLocalCacheExport
  ? [
      "--cache-from",
      `type=local,src=${cacheDir}`,
      "--cache-to",
      `type=local,dest=${cacheDir},mode=${cacheMode}`,
    ]
  : [];

execFileSync("docker", [...baseArgs.slice(0, -1), ...cacheArgs, baseArgs.at(-1)!], {
  cwd: repoRoot,
  stdio: "inherit",
});

console.log(`Built image: ${imageTag}`);
