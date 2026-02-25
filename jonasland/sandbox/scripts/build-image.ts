import { execFileSync, execSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
const tagSuffix = `jonasland-sha-${gitShaShort}${isDirty ? "-dirty" : ""}`;

const buildPlatform = process.env.JONASLAND_BUILD_PLATFORM || "linux/amd64,linux/arm64";
const skipLoad = process.env.JONASLAND_SKIP_LOAD === "true";
const flyApiToken = process.env.FLY_API_TOKEN;
const configuredFlyRegistryApp =
  process.env.JONASLAND_SANDBOX_FLY_REGISTRY_APP || process.env.SANDBOX_FLY_REGISTRY_APP;
const pushFlyRegistryEnv = process.env.JONASLAND_PUSH_FLY_REGISTRY;
const shouldPushFlyRegistry =
  pushFlyRegistryEnv === "false" ? false : pushFlyRegistryEnv === "true" || Boolean(flyApiToken);
if (shouldPushFlyRegistry && !configuredFlyRegistryApp) {
  throw new Error(
    "JONASLAND_SANDBOX_FLY_REGISTRY_APP (or SANDBOX_FLY_REGISTRY_APP) is required when Fly push is enabled",
  );
}

function readDepotProjectId(): string {
  const config = JSON.parse(readFileSync(join(repoRoot, "depot.json"), "utf-8")) as { id?: string };
  if (!config.id) throw new Error("Missing depot project id in depot.json");
  return config.id;
}

const depotProjectId = readDepotProjectId();
const localImageTag = `jonasland-sandbox:${tagSuffix}`;
const flyImageTag = configuredFlyRegistryApp
  ? `registry.fly.io/${configuredFlyRegistryApp}:${tagSuffix}`
  : null;
const depotImageTag = `registry.depot.dev/${depotProjectId}:${tagSuffix}`;

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

const pushTags: string[] = [];
if (shouldPushFlyRegistry) {
  if (!flyApiToken) {
    if (pushFlyRegistryEnv === "true") {
      throw new Error("JONASLAND_PUSH_FLY_REGISTRY=true but FLY_API_TOKEN is not set");
    }
    console.warn("Skipping Fly registry push: FLY_API_TOKEN not set");
  } else if (!flyImageTag) {
    throw new Error("Fly registry app is required when Fly push is enabled");
  } else {
    ensureFlyAuth(flyApiToken);
    pushTags.push(flyImageTag);
  }
}

const wantsLoad = !skipLoad;
const wantsPush = pushTags.length > 0;
const outputArgs: string[] = ["--save", "--save-tag", tagSuffix];

if (wantsLoad && wantsPush) {
  outputArgs.push("--load", "--push", ...pushTags.flatMap((tag) => ["-t", tag]));
} else if (wantsLoad) {
  outputArgs.push("--load", "-t", localImageTag);
} else if (wantsPush) {
  outputArgs.push("--push", ...pushTags.flatMap((tag) => ["-t", tag]));
}

console.log(`Tag suffix: ${tagSuffix}${isDirty ? " (dirty)" : ""}`);
console.log(`Platform: ${buildPlatform}`);
console.log(`Local image: ${localImageTag}`);
console.log(`Depot registry: ${depotImageTag}`);
if (pushTags.length > 0) console.log(`Push tags: ${pushTags.join(", ")}`);
if (wantsLoad) console.log("Loading into local Docker daemon");

execFileSync(
  "depot",
  [
    "build",
    "--platform",
    buildPlatform,
    "--progress=plain",
    ...outputArgs,
    "-f",
    "jonasland/sandbox/Dockerfile",
    "--build-arg",
    `GIT_SHA=${gitShaFull}`,
    ".",
  ],
  {
    cwd: repoRoot,
    stdio: "inherit",
    timeout: 15 * 60 * 1000,
  },
);

if (wantsLoad && wantsPush) {
  const loadedTag = pushTags[0];
  execFileSync("docker", ["tag", loadedTag, localImageTag], { cwd: repoRoot, stdio: "inherit" });
}

console.log(`image_tag=${localImageTag}`);
console.log(`fly_image_tag=${flyImageTag ?? ""}`);
console.log(`depot_image_tag=${depotImageTag}`);
