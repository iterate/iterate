/**
 * Push local Docker sandbox image to Daytona as a snapshot.
 *
 * Usage: pnpm os daytona:build [--name NAME] [--image IMAGE] [--cpu N] [--memory N] [--disk N] [--no-update-doppler]
 *
 * By default, uses the most recently built :local image.
 *
 * Resource limits can be set via env vars (DAYTONA_DEFAULT_SNAPSHOT_CPU, DAYTONA_DEFAULT_SNAPSHOT_MEMORY, DAYTONA_DEFAULT_SNAPSHOT_DISK)
 * or CLI args. CLI args override env vars. Defaults: cpu=2, memory=4, disk=10.
 *
 * We intentionally avoid the `--dockerfile` flow because we rely on BuildKit
 * features (buildx) and Daytona's Dockerfile builder does not support them.
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseArgs } from "node:util";

// Daytona CLI doesn't respect Docker contexts, so we need to set DOCKER_HOST explicitly.
// Auto-detect OrbStack socket if DOCKER_HOST is not already set.
if (!process.env.DOCKER_HOST) {
  const orbstackSocket = join(homedir(), ".orbstack/run/docker.sock");
  if (existsSync(orbstackSocket)) {
    process.env.DOCKER_HOST = `unix://${orbstackSocket}`;
  }
}

const repoRoot = join(import.meta.dirname, "..", "..", "..");

const builtBy = process.env.ITERATE_USER ?? "unknown";

const { values } = parseArgs({
  options: {
    name: { type: "string", short: "n" },
    image: { type: "string", short: "i" },
    cpu: { type: "string", short: "c", default: process.env.DAYTONA_DEFAULT_SNAPSHOT_CPU ?? "2" },
    memory: {
      type: "string",
      short: "m",
      default: process.env.DAYTONA_DEFAULT_SNAPSHOT_MEMORY ?? "4",
    },
    disk: {
      type: "string",
      short: "d",
      default: process.env.DAYTONA_DEFAULT_SNAPSHOT_DISK ?? "10",
    },
    "update-doppler": { type: "boolean", default: true },
  },
  strict: true,
  allowNegative: true,
});

// Ensure CI=true for non-interactive mode (Daytona CLI checks this)
const daytonaEnv = { ...process.env, CI: "true" };

execSync("daytona --version", { stdio: "ignore", env: daytonaEnv });

// Authenticate with Daytona API if key is provided
// Note: "daytona organization use" doesn't work with API key auth - org is scoped to the key
const daytonaApiKey = process.env.DAYTONA_API_KEY ?? "";
if (daytonaApiKey) {
  execSync(`daytona login --api-key "${daytonaApiKey}"`, {
    stdio: "ignore",
    env: daytonaEnv,
    input: "",
  });
}

const baseImageName = process.env.LOCAL_DOCKER_IMAGE_NAME ?? "ghcr.io/iterate/sandbox";
const localImageRef = `${baseImageName}:local`;

// Find the image to push - prefer explicit --image, then :local
const imageRef = values.image ?? localImageRef;
if (values.image) {
  console.log(`Using image from --image: ${imageRef}`);
} else {
  console.log(`Using default image tag: ${imageRef}`);
}

// Verify image exists
try {
  execSync(`docker image inspect ${imageRef}`, {
    cwd: repoRoot,
    stdio: "pipe",
    encoding: "utf-8",
  });
} catch {
  console.error(`Error: Image not found: ${imageRef}`);
  console.error(`\nBuild it first with: pnpm os docker:build`);
  process.exit(1);
}

// Get image creation time and ID for naming
const imageInfo = JSON.parse(
  execSync(`docker image inspect ${imageRef} --format '{{json .}}'`, {
    cwd: repoRoot,
    encoding: "utf-8",
  }),
);
const imageId = (imageInfo.Id as string).replace("sha256:", "").slice(0, 12);
const createdAt = new Date(imageInfo.Created as string);
const dateStr = createdAt.toISOString().slice(0, 10).replace(/-/g, "");

// Default snapshot name includes image ID so it's clear what we're uploading
const defaultName = `iterate-sandbox-${dateStr}-${imageId}-${builtBy}`;
const snapshotName = values.name ?? defaultName;
if (values.name) {
  console.log(`Using snapshot name from --name: ${snapshotName}`);
} else {
  console.log(
    [
      "Inferring snapshot name from image metadata",
      "(created date + image id) and ITERATE_USER:",
      snapshotName,
    ].join(" "),
  );
}

console.log(`Pushing Daytona snapshot: ${snapshotName}`);
console.log(`  image=${imageRef}`);
console.log(`  cpu=${values.cpu}, memory=${values.memory}, disk=${values.disk}`);

const snapshotAlreadyExists = (() => {
  try {
    const pageLimit = 100;
    for (let page = 1; ; page += 1) {
      const output = execSync(
        [
          "daytona",
          "snapshot",
          "list",
          "--format",
          "json",
          "--limit",
          String(pageLimit),
          "--page",
          String(page),
        ].join(" "),
        {
          cwd: repoRoot,
          stdio: "pipe",
          encoding: "utf-8",
          env: daytonaEnv,
        },
      );
      const snapshots = JSON.parse(output) as Array<{ name?: string }>;
      if (snapshots.some((snapshot) => snapshot.name === snapshotName)) {
        return true;
      }
      if (snapshots.length < pageLimit) {
        return false;
      }
    }
  } catch (error) {
    console.warn("Warning: unable to list snapshots to check for conflicts.", error);
    return false;
  }
})();

if (snapshotAlreadyExists) {
  console.log("Snapshot already exists (matched by name). Skipping upload.");
} else {
  execSync(
    [
      "daytona",
      "snapshot",
      "push",
      imageRef,
      "--name",
      snapshotName,
      "--cpu",
      values.cpu!,
      "--memory",
      values.memory!,
      "--disk",
      values.disk!,
    ].join(" "),
    {
      cwd: repoRoot,
      stdio: "inherit",
      env: daytonaEnv,
    },
  );
}

if (values["update-doppler"]) {
  const dopplerInfo = JSON.parse(
    execSync("doppler configs get --json", {
      cwd: repoRoot,
      encoding: "utf-8",
    }),
  ) as { name?: string; project?: string };
  const dopplerConfig = dopplerInfo.name;
  const dopplerProject = dopplerInfo.project ?? "os";
  if (!dopplerConfig) {
    throw new Error("Unable to determine Doppler config name.");
  }
  console.log(
    [
      `Updating Doppler (${dopplerProject}/${dopplerConfig}):`,
      `DAYTONA_SNAPSHOT_NAME=${snapshotName}`,
      "VITE_DAYTONA_SNAPSHOT_NAME='${DAYTONA_SNAPSHOT_NAME}'",
    ].join(" "),
  );
  execSync(
    [
      "doppler secrets set",
      `DAYTONA_SNAPSHOT_NAME=${snapshotName}`,
      "VITE_DAYTONA_SNAPSHOT_NAME='${DAYTONA_SNAPSHOT_NAME}'",
      "--project",
      dopplerProject,
      "--config",
      dopplerConfig,
    ].join(" "),
    { cwd: repoRoot, stdio: "inherit" },
  );
}

console.log(`snapshot_name=${snapshotName}`);
