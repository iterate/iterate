/**
 * Create Daytona snapshot from Dockerfile.
 *
 * Usage: pnpm os daytona:build [--name NAME] [--cpu N] [--memory N] [--disk N]
 *
 * Alternative approaches that don't work well:
 *
 * 1) Using `daytona snapshot create --image ghcr.io/iterate/sandbox:sha-xxx`:
 *    Daytona CLI can't authenticate with ghcr.io to pull. The web UI can pull
 *    from ghcr.io but takes 10+ minutes.
 *
 * 2) Pushing to Daytona's registry via `docker push ghcr.io/iterate/sandbox:sha-xxx`:
 *    Extremely slow push times for unknown reasons.
 *
 * The --dockerfile approach builds directly on Daytona's infra, avoiding both issues.
 */
import { execSync } from "node:child_process";
import { join } from "node:path";
import { parseArgs } from "node:util";

const repoRoot = join(import.meta.dirname, "..", "..", "..");

const gitSha = execSync("git rev-parse HEAD", { cwd: repoRoot, encoding: "utf-8" }).trim();
const gitShaShort = gitSha.slice(0, 7);
const isDirty =
  execSync("git status --porcelain", { cwd: repoRoot, encoding: "utf-8" }).trim().length > 0;
const builtBy = process.env.ITERATE_USER ?? "unknown";

const dirtySuffix = isDirty ? `-${builtBy}-dirty` : "";
const defaultName = `iterate-sandbox-${gitShaShort}${dirtySuffix}`;

const { values } = parseArgs({
  options: {
    name: { type: "string", short: "n" },
    cpu: { type: "string", short: "c", default: "2" },
    memory: { type: "string", short: "m", default: "4" },
    disk: { type: "string", short: "d", default: "10" },
  },
  strict: true,
});

const snapshotName = values.name ?? defaultName;

try {
  execSync("daytona --version", { stdio: "ignore" });
} catch {
  throw new Error("daytona CLI not found. Install it and run `daytona login`.");
}

console.log(`Creating Daytona snapshot: ${snapshotName}`);
console.log(`  cpu=${values.cpu}, memory=${values.memory}, disk=${values.disk}`);

execSync(
  [
    "daytona",
    "snapshot",
    "create",
    snapshotName,
    "--dockerfile",
    "apps/os/sandbox/Dockerfile",
    // Explicitly send entire repo as build context. Daytona's auto-detection
    // from COPY/ADD commands is unreliable and misses files like pnpm-lock.yaml.
    "--context",
    ".",
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
