/**
 * Create Daytona snapshot from GHCR image.
 */
import { execSync } from "node:child_process";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "..", "..", "..");

const commit =
  process.env.SANDBOX_ITERATE_REPO_REF ??
  execSync("git rev-parse HEAD", { cwd: repoRoot, encoding: "utf-8" }).trim();

const snapshotName = process.env.SANDBOX_SNAPSHOT_NAME ?? `iterate-sandbox-${commit}`;
const image = process.env.SANDBOX_IMAGE ?? `ghcr.io/iterate/sandbox:sha-${commit}`;

const cpu = process.env.SANDBOX_SNAPSHOT_CPU ?? "2";
const memory = process.env.SANDBOX_SNAPSHOT_MEMORY ?? "4";
const disk = process.env.SANDBOX_SNAPSHOT_DISK ?? "10";

try {
  execSync("daytona --version", { stdio: "ignore" });
} catch {
  throw new Error("daytona CLI not found. Install it and run `daytona login`.");
}

execSync(
  [
    "daytona",
    "snapshot",
    "create",
    snapshotName,
    "--image",
    image,
    "--cpu",
    cpu,
    "--memory",
    memory,
    "--disk",
    disk,
  ].join(" "),
  {
    stdio: "inherit",
  },
);
