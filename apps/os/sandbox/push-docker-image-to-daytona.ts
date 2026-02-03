/**
 * Push local Docker sandbox image to Daytona as a snapshot.
 *
 * Usage: pnpm os daytona:build [--name NAME] [--image IMAGE] [--cpu N] [--memory N] [--disk N]
 *
 * By default, uses the most recently built :local image.
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
    cpu: { type: "string", short: "c", default: "2" },
    memory: { type: "string", short: "m", default: "4" },
    disk: { type: "string", short: "d", default: "10" },
  },
  strict: true,
});

execSync("daytona --version", { stdio: "ignore" });

const baseImageName = process.env.LOCAL_DOCKER_IMAGE_NAME ?? "ghcr.io/iterate/sandbox";
const localImageRef = `${baseImageName}:local`;

// Find the image to push - prefer explicit --image, then :local
const imageRef = values.image ?? localImageRef;

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

console.log(`Pushing Daytona snapshot: ${snapshotName}`);
console.log(`  image=${imageRef}`);
console.log(`  cpu=${values.cpu}, memory=${values.memory}, disk=${values.disk}`);

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
  },
);
