/**
 * Build Docker sandbox image using Depot.
 *
 * Uses depot build for persistent layer caching across CI runs.
 * Depot handles caching automatically - no --cache-from/--cache-to needed.
 */
import { execFileSync, execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const gitSha = execSync("git rev-parse HEAD", { cwd: repoRoot, encoding: "utf-8" }).trim();
const buildPlatform = process.env.SANDBOX_BUILD_PLATFORM ?? "linux/amd64";
const builtBy = process.env.ITERATE_USER ?? "unknown";
const useDepotRegistry = process.env.SANDBOX_USE_DEPOT_REGISTRY === "true";
const depotSaveTag = process.env.SANDBOX_DEPOT_SAVE_TAG;
const flyApiToken = process.env.FLY_API_TOKEN ?? process.env.FLY_API_KEY;
const flyOrg = process.env.FLY_ORG ?? "iterate";
const flyRegistryApp = process.env.SANDBOX_FLY_REGISTRY_APP ?? "iterate-sandbox-image";
const flyRegistryRepository = `registry.fly.io/${flyRegistryApp}`;
const pushFlyRegistryEnv = process.env.SANDBOX_PUSH_FLY_REGISTRY;
const shouldPushFlyRegistry = pushFlyRegistryEnv === "true";
const shouldPushFlyMainTag = process.env.SANDBOX_PUSH_FLY_REGISTRY_MAIN === "true";
const configuredFlyRegistryImageNames = shouldPushFlyRegistry
  ? [
      `${flyRegistryRepository}:sha-${gitSha}`,
      ...(shouldPushFlyMainTag ? [`${flyRegistryRepository}:main`] : []),
    ]
  : [];

// Detect multi-platform builds (comma-separated platforms)
const isMultiPlatform = buildPlatform.includes(",");

// Local tag for Docker provider and tests
const localImageName =
  process.env.DOCKER_IMAGE_NAME ?? process.env.LOCAL_DOCKER_IMAGE_NAME ?? "iterate-sandbox:local";

// Registry image name for multi-platform builds (can't --load multiple platforms)
const registryImageName = process.env.REGISTRY_IMAGE_NAME;

function runFlyctl(params: { command: string[]; token: string }): void {
  const { command, token } = params;
  execFileSync("flyctl", command, {
    cwd: repoRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      FLY_ACCESS_TOKEN: token,
    },
  });
}

function flyRegistryAppExists(token: string): boolean {
  const output = execFileSync("flyctl", ["apps", "list", "-o", flyOrg, "--json"], {
    cwd: repoRoot,
    encoding: "utf-8",
    env: {
      ...process.env,
      FLY_ACCESS_TOKEN: token,
    },
  });
  const apps = JSON.parse(output) as Array<{ Name?: string }>;
  return apps.some((app) => app.Name === flyRegistryApp);
}

function ensureFlyRegistryApp(token: string): void {
  if (flyRegistryAppExists(token)) {
    return;
  }
  runFlyctl({ command: ["apps", "create", flyRegistryApp, "-o", flyOrg, "-y"], token });
}

function ensureFlyDockerAuth(token: string): void {
  try {
    runFlyctl({ command: ["auth", "docker", "-t", token], token });
  } catch {
    execFileSync("docker", ["login", "registry.fly.io", "-u", "x", "--password-stdin"], {
      cwd: repoRoot,
      stdio: "inherit",
      input: `${token}\n`,
    });
  }
}

function ensureFlyRegistryReady(token: string): void {
  ensureFlyRegistryApp(token);
  ensureFlyDockerAuth(token);
}

function readDepotProjectId(): string {
  const depotConfigPath = join(repoRoot, "depot.json");
  const config = JSON.parse(readFileSync(depotConfigPath, "utf-8")) as { id?: string };
  if (!config.id) {
    throw new Error("Missing depot project id in depot.json");
  }
  return config.id;
}

const depotProjectId = useDepotRegistry ? readDepotProjectId() : null;
const depotRegistryImageName =
  useDepotRegistry && depotSaveTag ? `registry.depot.dev/${depotProjectId}:${depotSaveTag}` : null;

// Ensure cache directory exists
const cacheDir = join(repoRoot, ".cache");
mkdirSync(cacheDir, { recursive: true });

// Multi-platform builds require pushing to a registry (can't --load multiple platforms)
if (isMultiPlatform && !registryImageName) {
  console.error("Error: Multi-platform builds require REGISTRY_IMAGE_NAME environment variable");
  console.error(
    "Example: REGISTRY_IMAGE_NAME=registry.depot.dev/<depot-project-id>:iterate-sandbox",
  );
  process.exit(1);
}

if (useDepotRegistry && isMultiPlatform) {
  console.error("Error: SANDBOX_USE_DEPOT_REGISTRY is only supported for single-platform builds");
  console.error("Use REGISTRY_IMAGE_NAME for multi-platform builds.");
  process.exit(1);
}

if (useDepotRegistry && !depotSaveTag) {
  console.error("Error: SANDBOX_DEPOT_SAVE_TAG is required when SANDBOX_USE_DEPOT_REGISTRY=true");
  console.error("Example: SANDBOX_DEPOT_SAVE_TAG=iterate-sandbox-ci-1234");
  process.exit(1);
}

let flyRegistryImageNames = configuredFlyRegistryImageNames;
let integratedFlyPushTags: string[] = [];

if (flyRegistryImageNames.length > 0) {
  if (!flyApiToken) {
    const message =
      "Skipping Fly registry push because FLY_API_TOKEN/FLY_API_KEY is not set in environment";
    if (pushFlyRegistryEnv === "true") {
      throw new Error(message);
    }
    console.warn(message);
    flyRegistryImageNames = [];
  } else if (isMultiPlatform || useDepotRegistry) {
    ensureFlyRegistryReady(flyApiToken);
    integratedFlyPushTags = flyRegistryImageNames;
  } else {
    const message =
      "Fly registry push requires SANDBOX_USE_DEPOT_REGISTRY=true (or a multi-platform --push build)";
    if (pushFlyRegistryEnv === "true") {
      throw new Error(message);
    }
    console.warn(`Skipping Fly registry push: ${message}`);
    flyRegistryImageNames = [];
  }
}

const pushTagsForBuild = isMultiPlatform ? [registryImageName!, ...integratedFlyPushTags] : [];
const outputArgs: string[] = [];
if (isMultiPlatform) {
  outputArgs.push("--push", ...pushTagsForBuild.flatMap((tag) => ["-t", tag]));
} else if (useDepotRegistry) {
  outputArgs.push("--save", "--save-tag", depotSaveTag!);
  if (integratedFlyPushTags.length > 0) {
    outputArgs.push("--push", ...integratedFlyPushTags.flatMap((tag) => ["-t", tag]));
  }
} else {
  outputArgs.push("--load", "-t", localImageName);
}

// Use depot build for persistent layer caching
// depot build accepts the same parameters as docker build
const buildArgs = [
  "depot",
  "build",
  "--platform",
  buildPlatform,
  "--progress=plain", // Show all layer details for cache analysis
  ...outputArgs,
  "-f",
  "sandbox/Dockerfile",
  "--build-arg",
  `GIT_SHA=${gitSha}`,
  "--label",
  `com.iterate.built_by=${builtBy}`,
  ".",
];

const quoteArg = (arg: string) => (/\s/.test(arg) ? `"${arg}"` : arg);
const buildCommand = buildArgs.map(quoteArg).join(" ");

if (isMultiPlatform) {
  console.log(`Multi-platform build: ${buildPlatform}`);
  console.log(`Registry image: ${registryImageName}`);
} else if (useDepotRegistry) {
  console.log(`Depot registry image: ${depotRegistryImageName}`);
  console.log(`Depot save tag: ${depotSaveTag}`);
  console.log(`Platform: ${buildPlatform}`);
} else {
  console.log(`Local image tag: ${localImageName}`);
  console.log(`Platform: ${buildPlatform}`);
}
if (flyRegistryImageNames.length > 0) {
  console.log(`Fly registry push (integrated depot push): ${flyRegistryImageNames.join(", ")}`);
}
console.log("Build command:");
console.log(buildCommand);

// 15-minute timeout for depot build (fails fast instead of GitHub's 6-hour default)
const BUILD_TIMEOUT_MS = 15 * 60 * 1000;

execFileSync(buildArgs[0], buildArgs.slice(1), {
  cwd: repoRoot,
  stdio: "inherit",
  timeout: BUILD_TIMEOUT_MS,
});

const pushedFlyImages = integratedFlyPushTags;

// Write build info for downstream scripts (push-docker-image-to-daytona.ts reads this)
const buildInfoPath = join(cacheDir, "depot-build-info.json");
writeFileSync(
  buildInfoPath,
  JSON.stringify(
    {
      localImageName: isMultiPlatform || useDepotRegistry ? null : localImageName,
      registryImageName: isMultiPlatform ? registryImageName : null,
      depotRegistryImageName,
      depotSaveTag: useDepotRegistry ? depotSaveTag : null,
      depotProjectId,
      gitSha,
      builtBy,
      buildPlatform,
      isMultiPlatform,
      useDepotRegistry,
      flyRegistryImageNames: pushedFlyImages,
      flyRegistryRepository: pushedFlyImages.length > 0 ? flyRegistryRepository : null,
    },
    null,
    2,
  ),
);
console.log(`Build info written to: ${buildInfoPath}`);

// Output the image name for CI to use
const outputImageName = isMultiPlatform
  ? registryImageName!
  : useDepotRegistry
    ? depotRegistryImageName!
    : localImageName;
console.log(`image_name=${outputImageName}`);
