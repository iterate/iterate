/**
 * Build sandbox image using Depot.
 *
 * Pushes to Fly registry and Depot registry when tokens are available.
 * Tags use the format: sha-{shortSha}[-dirty]
 *
 * Env vars:
 *   SANDBOX_BUILD_PLATFORM    Target platform(s) (default: linux/amd64,linux/arm64)
 *   SANDBOX_SKIP_LOAD         Skip --load into local Docker (default: false)
 *   SANDBOX_PUSH_FLY_REGISTRY Push to Fly registry (default: auto based on FLY_API_TOKEN)
 *   SANDBOX_UPDATE_DOPPLER    Update Doppler defaults after build (default: true)
 *   SANDBOX_DOPPLER_CONFIGS   Comma-separated Doppler configs to update (default: current)
 */
import { execFileSync, execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "..", "..", "..");

// --- Git info ---
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

/** Universal tag suffix: sha-{shortSha}[-dirty] */
const tagSuffix = `sha-${gitShaShort}${isDirty ? "-dirty" : ""}`;

// --- Config ---
const buildPlatform = process.env.SANDBOX_BUILD_PLATFORM || "linux/amd64,linux/arm64";
const skipLoad = process.env.SANDBOX_SKIP_LOAD === "true";
const shouldUpdateDoppler = process.env.SANDBOX_UPDATE_DOPPLER !== "false";
const dopplerConfigsToUpdate = process.env.SANDBOX_DOPPLER_CONFIGS?.split(",").filter(Boolean);
const builtBy = process.env.ITERATE_USER ?? "unknown";

// --- Fly registry ---
const flyApiToken = process.env.FLY_API_TOKEN;
const flyRegistryApp = process.env.SANDBOX_FLY_REGISTRY_APP;
if (!flyRegistryApp) {
  throw new Error("SANDBOX_FLY_REGISTRY_APP is required");
}
const flyRegistryRepository = `registry.fly.io/${flyRegistryApp}`;
const pushFlyRegistryEnv = process.env.SANDBOX_PUSH_FLY_REGISTRY;
const shouldPushFlyRegistry =
  pushFlyRegistryEnv === "false" ? false : pushFlyRegistryEnv === "true" || Boolean(flyApiToken);

// --- Depot registry ---
function readDepotProjectId(): string {
  const config = JSON.parse(readFileSync(join(repoRoot, "depot.json"), "utf-8")) as { id?: string };
  if (!config.id) throw new Error("Missing depot project id in depot.json");
  return config.id;
}
const depotProjectId = readDepotProjectId();

// --- Derived tags ---
const localImageTag = `iterate-sandbox:${tagSuffix}`;
const flyImageTag = `${flyRegistryRepository}:${tagSuffix}`;
const depotImageTag = `registry.depot.dev/${depotProjectId}:${tagSuffix}`;

// --- Fly auth ---
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

// --- Resolve push tags ---
const pushTags: string[] = [];

if (shouldPushFlyRegistry) {
  if (!flyApiToken) {
    if (pushFlyRegistryEnv === "true") {
      throw new Error("SANDBOX_PUSH_FLY_REGISTRY=true but FLY_API_TOKEN is not set");
    }
    console.warn("Skipping Fly registry push: FLY_API_TOKEN not set");
  } else {
    ensureFlyAuth(flyApiToken);
    pushTags.push(flyImageTag);
  }
}

// --- Build ---
const wantsLoad = !skipLoad;
const wantsPush = pushTags.length > 0;

const outputArgs: string[] = [];
// Always save to Depot registry
outputArgs.push("--save", "--save-tag", tagSuffix);

if (wantsLoad && wantsPush) {
  outputArgs.push("--load", "--push", ...pushTags.flatMap((tag) => ["-t", tag]));
} else if (wantsLoad && !wantsPush) {
  outputArgs.push("--load", "-t", localImageTag);
} else if (wantsPush) {
  outputArgs.push("--push", ...pushTags.flatMap((tag) => ["-t", tag]));
}

const buildArgs = [
  "depot",
  "build",
  "--platform",
  buildPlatform,
  "--progress=plain",
  ...outputArgs,
  "-f",
  "sandbox/Dockerfile",
  "--build-arg",
  `GIT_SHA=${gitShaFull}`,
  "--label",
  `com.iterate.built_by=${builtBy}`,
  ".",
];

console.log(`Tag suffix: ${tagSuffix}${isDirty ? " (dirty)" : ""}`);
console.log(`Platform: ${buildPlatform}`);
console.log(`Local image: ${localImageTag}`);
console.log(`Depot registry: ${depotImageTag}`);
if (pushTags.length > 0) console.log(`Push tags: ${pushTags.join(", ")}`);
if (wantsLoad) console.log("Loading into local Docker daemon");

const BUILD_TIMEOUT_MS = 15 * 60 * 1000;
execFileSync(buildArgs[0], buildArgs.slice(1), {
  cwd: repoRoot,
  stdio: "inherit",
  timeout: BUILD_TIMEOUT_MS,
});

// When --load + --push were combined, the loaded tag is the push tag — re-tag locally
if (wantsLoad && wantsPush) {
  const loadedTag = pushTags[0];
  console.log(`Re-tagging ${loadedTag} → ${localImageTag}`);
  execFileSync("docker", ["tag", loadedTag, localImageTag], { cwd: repoRoot, stdio: "inherit" });
}

// --- Update Doppler ---
function getCurrentDopplerConfig(): string | undefined {
  try {
    const info = JSON.parse(
      execSync("doppler configs get --json", { cwd: repoRoot, encoding: "utf-8" }),
    ) as { name?: string };
    return info.name ?? undefined;
  } catch {
    return undefined;
  }
}

if (shouldUpdateDoppler) {
  const configs = dopplerConfigsToUpdate ?? [getCurrentDopplerConfig()].filter(Boolean);
  const dopplerProject = process.env.DOPPLER_PROJECT ?? "os";
  for (const config of configs) {
    if (!config) continue;
    console.log(
      `Updating Doppler (${dopplerProject}/${config}): DOCKER_DEFAULT_IMAGE=${localImageTag}`,
    );
    execSync(
      `doppler secrets set DOCKER_DEFAULT_IMAGE=${localImageTag} --project ${dopplerProject} --config ${config}`,
      { cwd: repoRoot, stdio: "inherit" },
    );
    if (pushTags.includes(flyImageTag)) {
      console.log(
        `Updating Doppler (${dopplerProject}/${config}): FLY_DEFAULT_IMAGE=${flyImageTag}`,
      );
      execSync(
        `doppler secrets set FLY_DEFAULT_IMAGE=${flyImageTag} --project ${dopplerProject} --config ${config}`,
        { cwd: repoRoot, stdio: "inherit" },
      );
    }
  }
}

// --- Outputs ---
console.log(`image_tag=${localImageTag}`);
console.log(`fly_image_tag=${flyImageTag}`);
console.log(`depot_image_tag=${depotImageTag}`);
