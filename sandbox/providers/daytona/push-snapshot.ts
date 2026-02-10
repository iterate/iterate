/**
 * Push local Docker sandbox image to Daytona as a snapshot.
 *
 * Usage: pnpm sandbox daytona:push [--name NAME] [--image IMAGE] [--cpu N] [--memory N] [--disk N] [--no-update-doppler]
 *
 * Expects the image to already be built with `pnpm sandbox build`.
 * By default derives the local image tag from git (iterate-sandbox:sha-{shortSha}[-dirty]).
 *
 * Snapshot name format: iterate-sandbox-sha-{shortSha}[-dirty]
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

// Daytona CLI doesn't respect Docker contexts — auto-detect OrbStack socket.
if (!process.env.DOCKER_HOST) {
  const orbstackSocket = join(homedir(), ".orbstack/run/docker.sock");
  if (existsSync(orbstackSocket)) {
    process.env.DOCKER_HOST = `unix://${orbstackSocket}`;
  }
}

const repoRoot = join(import.meta.dirname, "..", "..", "..");

// --- Git info ---
const gitShaShort = execSync("git rev-parse --short=7 HEAD", {
  cwd: repoRoot,
  encoding: "utf-8",
}).trim();

const isDirty = (() => {
  try {
    const status = execSync("git status --porcelain", { cwd: repoRoot, encoding: "utf-8" });
    return status.trim().length > 0;
  } catch {
    return false;
  }
})();

/** Universal tag suffix matching build-image.ts */
const tagSuffix = `sha-${gitShaShort}${isDirty ? "-dirty" : ""}`;

// --- CLI args ---
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

// --- Daytona CLI setup ---
const daytonaEnv = { ...process.env, CI: "true" };
execSync("daytona --version", { stdio: "ignore", env: daytonaEnv });

const daytonaApiKey = process.env.DAYTONA_API_KEY ?? "";
if (daytonaApiKey) {
  execSync(`daytona login --api-key "${daytonaApiKey}"`, {
    stdio: "ignore",
    env: daytonaEnv,
    input: "",
  });
}

// --- Resolve local image ---
const localImageName = values.image ?? `iterate-sandbox:${tagSuffix}`;

try {
  execSync(`docker image inspect ${localImageName}`, { stdio: "ignore" });
} catch {
  console.error(`Error: Local image '${localImageName}' not found.`);
  console.error("Build the image first with: pnpm sandbox build");
  process.exit(1);
}
console.log(`Local image: ${localImageName}`);

// --- Snapshot name ---
const snapshotName = values.name ?? `iterate-sandbox-${tagSuffix}`;

if (values.name) {
  console.log(`Using snapshot name from --name: ${snapshotName}`);
} else {
  console.log(`Generated snapshot name: ${snapshotName}`);
}

console.log(`Pushing Daytona snapshot: ${snapshotName}`);
console.log(`  image=${localImageName}`);
console.log(`  cpu=${values.cpu}, memory=${values.memory}, disk=${values.disk}`);

// --- Check if snapshot already exists ---
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
        { cwd: repoRoot, stdio: "pipe", encoding: "utf-8", env: daytonaEnv },
      );
      const snapshots = JSON.parse(output) as Array<{ name?: string }>;
      if (snapshots.some((s) => s.name === snapshotName)) return true;
      if (snapshots.length < pageLimit) return false;
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
      localImageName,
      "--name",
      snapshotName,
      "--cpu",
      values.cpu!,
      "--memory",
      values.memory!,
      "--disk",
      values.disk!,
    ].join(" "),
    { cwd: repoRoot, stdio: "inherit", env: daytonaEnv },
  );
}

// --- Update Doppler ---
if (values["update-doppler"]) {
  const dopplerInfo = JSON.parse(
    execSync("doppler configs get --json", { cwd: repoRoot, encoding: "utf-8" }),
  ) as { name?: string; project?: string };
  const dopplerConfig = dopplerInfo.name;
  const dopplerProject = dopplerInfo.project ?? "os";
  if (!dopplerConfig) {
    throw new Error("Unable to determine Doppler config name.");
  }
  console.log(
    `Updating Doppler (${dopplerProject}/${dopplerConfig}): DAYTONA_DEFAULT_SNAPSHOT=${snapshotName}`,
  );
  execSync(
    `doppler secrets set DAYTONA_DEFAULT_SNAPSHOT=${snapshotName} --project ${dopplerProject} --config ${dopplerConfig}`,
    { cwd: repoRoot, stdio: "inherit" },
  );
}

console.log(`snapshot_name=${snapshotName}`);
