import { execFileSync, execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "..", "..", "..");

const gitShaFull = execSync("git rev-parse HEAD", { cwd: repoRoot, encoding: "utf-8" }).trim();
const gitShaShort = gitShaFull.slice(0, 7);
const isDirty = (() => {
  try {
    return (
      execSync("git status --porcelain", { cwd: repoRoot, encoding: "utf-8" }).trim().length > 0
    );
  } catch {
    return false;
  }
})();

const tagSuffix = `sha-${gitShaShort}${isDirty ? "-dirty" : ""}`;
const buildPlatform = process.env.JONASLAND_SANDBOX_BUILD_PLATFORM ?? "linux/amd64,linux/arm64";
const skipLoad = process.env.JONASLAND_SANDBOX_SKIP_LOAD === "true";
const explicitLocalImage = process.env.JONASLAND_SANDBOX_IMAGE;
const localImageTag =
  explicitLocalImage && !explicitLocalImage.startsWith("registry.fly.io/")
    ? explicitLocalImage
    : `jonasland-sandbox:${tagSuffix}`;

const flyRegistryApp =
  process.env.JONASLAND_FLY_REGISTRY_APP ?? process.env.JONASLAND_FLY_APP ?? "jonasland-sandbox";
const flyImageTag = `registry.fly.io/${flyRegistryApp}:${tagSuffix}`;
const flyApiToken = process.env.FLY_API_TOKEN;
const pushFlyRegistryEnv = process.env.JONASLAND_SANDBOX_PUSH_FLY_REGISTRY;
const shouldPushFlyRegistry = pushFlyRegistryEnv !== "false";

function readDepotProjectId(): string {
  const config = JSON.parse(readFileSync(join(repoRoot, "depot.json"), "utf-8")) as { id?: string };
  if (!config.id) throw new Error("Missing depot project id in depot.json");
  return config.id;
}

const depotProjectId = readDepotProjectId();
const depotImageTag = `registry.depot.dev/${depotProjectId}:${tagSuffix}`;

function hasFlySession(): boolean {
  try {
    execFileSync("flyctl", ["auth", "whoami"], {
      cwd: repoRoot,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

function ensureFlyAuth(token: string | undefined): void {
  try {
    const args = token ? ["auth", "docker", "-t", token] : ["auth", "docker"];
    execFileSync("flyctl", args, {
      cwd: repoRoot,
      stdio: "inherit",
      env: { ...process.env, FLY_ACCESS_TOKEN: token },
    });
  } catch {
    if (!token) throw new Error("flyctl auth docker failed and FLY_API_TOKEN is not set");
    execFileSync("docker", ["login", "registry.fly.io", "-u", "x", "--password-stdin"], {
      cwd: repoRoot,
      input: `${token}\n`,
      stdio: ["pipe", "inherit", "inherit"],
    });
  }
}

let wantsPush = false;
if (shouldPushFlyRegistry) {
  const canAuth = Boolean(flyApiToken) || hasFlySession();
  if (!canAuth) {
    if (pushFlyRegistryEnv === "true") {
      throw new Error(
        "Fly push requested but no auth found. Set FLY_API_TOKEN or run flyctl auth login.",
      );
    }
    console.warn("Skipping Fly registry push: no FLY_API_TOKEN and no flyctl auth session");
  } else {
    ensureFlyAuth(flyApiToken);
    wantsPush = true;
  }
}

const wantsLoad = !skipLoad;
const pushTags = wantsPush ? [flyImageTag] : [];

const outputArgs: string[] = [];
outputArgs.push("--save", "--save-tag", tagSuffix);

if (wantsLoad && wantsPush) {
  outputArgs.push("--load", "--push", ...pushTags.flatMap((tag) => ["-t", tag]));
} else if (wantsLoad && !wantsPush) {
  outputArgs.push("--load", "-t", localImageTag);
} else if (wantsPush) {
  outputArgs.push("--push", ...pushTags.flatMap((tag) => ["-t", tag]));
}

console.log(`tag_suffix=${tagSuffix}`);
console.log(`platform=${buildPlatform}`);
console.log(`local_image_tag=${localImageTag}`);
console.log(`fly_image_tag=${flyImageTag}`);
console.log(`depot_image_tag=${depotImageTag}`);
console.log(`push_fly_registry=${wantsPush ? "true" : "false"}`);

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
  execFileSync("docker", ["tag", flyImageTag, localImageTag], {
    cwd: repoRoot,
    stdio: "inherit",
  });
}
