import { execFileSync, execSync } from "node:child_process";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "..", "..", "..");

const gitShaFull = execSync("git rev-parse HEAD", { cwd: repoRoot, encoding: "utf-8" }).trim();
const gitShaShort = gitShaFull.slice(0, 7);
const isDirty = (() => {
  try {
    const status = execSync("git status --porcelain", { cwd: repoRoot, encoding: "utf-8" });
    return status.trim().length > 0;
  } catch {
    return false;
  }
})();

const tagSuffix = `sha-${gitShaShort}${isDirty ? "-dirty" : ""}`;
const defaultPlatform = process.arch === "arm64" ? "linux/arm64" : "linux/amd64";
const buildPlatform = process.env.JONASLAND_SANDBOX_BUILD_PLATFORM || defaultPlatform;
const skipLoad = process.env.JONASLAND_SANDBOX_SKIP_LOAD === "true";
const wantsLoad = !skipLoad;

const flyApiToken = process.env.FLY_API_TOKEN;
const flyRegistryApp =
  process.env.JONASLAND_SANDBOX_FLY_REGISTRY_APP ||
  process.env.SANDBOX_FLY_REGISTRY_APP ||
  "iterate-sandbox";
const wantsPush =
  process.env.JONASLAND_SANDBOX_PUSH_FLY_REGISTRY === "true" && Boolean(flyApiToken);

if (process.env.JONASLAND_SANDBOX_PUSH_FLY_REGISTRY === "true" && !flyApiToken) {
  throw new Error("JONASLAND_SANDBOX_PUSH_FLY_REGISTRY=true but FLY_API_TOKEN is not set");
}

const localImageTag = process.env.JONASLAND_SANDBOX_IMAGE || `jonasland-sandbox:${tagSuffix}`;
const flyImageTag = `registry.fly.io/${flyRegistryApp}:${tagSuffix}`;
const builtBy = process.env.ITERATE_USER ?? "unknown";

function ensureFlyAuth(token: string): void {
  try {
    execFileSync("flyctl", ["auth", "docker", "-t", token], {
      cwd: repoRoot,
      stdio: "inherit",
      env: { ...process.env, FLY_ACCESS_TOKEN: token },
    });
  } catch {
    execFileSync("docker", ["login", "registry.fly.io", "-u", "x", "--password-stdin"], {
      cwd: repoRoot,
      input: `${token}\n`,
      stdio: ["pipe", "inherit", "inherit"],
    });
  }
}

if (wantsPush && flyApiToken) {
  ensureFlyAuth(flyApiToken);
}

if (wantsLoad && buildPlatform.includes(",")) {
  throw new Error(
    `--load cannot be used with multi-platform builds (${buildPlatform}). Set JONASLAND_SANDBOX_SKIP_LOAD=true or single platform.`,
  );
}

const buildArgs = [
  "buildx",
  "build",
  "--platform",
  buildPlatform,
  "--progress=plain",
  "-f",
  "jonasland/sandbox/Dockerfile",
  "--build-arg",
  `GIT_SHA=${gitShaFull}`,
  "--label",
  `com.iterate.built_by=${builtBy}`,
  "-t",
  localImageTag,
];

if (wantsPush) {
  buildArgs.push("-t", flyImageTag, "--push");
}
if (wantsLoad) {
  buildArgs.push("--load");
}

buildArgs.push(".");

console.log(`Tag suffix: ${tagSuffix}${isDirty ? " (dirty)" : ""}`);
console.log(`Platform: ${buildPlatform}`);
console.log(`Local image: ${localImageTag}`);
if (wantsPush) console.log(`Fly image: ${flyImageTag}`);
if (wantsLoad) console.log("Loading into local Docker daemon");

const BUILD_TIMEOUT_MS = 15 * 60 * 1000;
execFileSync("docker", buildArgs, {
  cwd: repoRoot,
  stdio: "inherit",
  timeout: BUILD_TIMEOUT_MS,
});

console.log(`image_tag=${localImageTag}`);
if (wantsPush) console.log(`fly_image_tag=${flyImageTag}`);
