/**
 * Start a local Docker sandbox with host repo/git mounts and open a shell.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { getGitInfo as getLocalDockerGitInfo } from "./utils.ts";

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const gitInfo = getLocalDockerGitInfo(repoRoot);

if (!gitInfo) {
  throw new Error("Failed to resolve git info for local Docker shell.");
}

const imageName = process.env.DOCKER_IMAGE_NAME ?? "ghcr.io/iterate/sandbox:local";

const inspect = spawnSync("docker", ["image", "inspect", imageName], { stdio: "ignore" });
if (inspect.status !== 0) {
  throw new Error(`Image not found: ${imageName}. Run 'pnpm os docker:build'.`);
}

const tty = Boolean(process.stdout.isTTY && process.stdin.isTTY);
const command = process.argv.slice(2);

const args = [
  "run",
  "--rm",
  ...(tty ? ["-it"] : []),
  "-v",
  `${gitInfo.repoRoot}:/host/repo-checkout:ro`,
  "-v",
  `${gitInfo.gitDir}:/host/gitdir:ro`,
  "-v",
  `${gitInfo.commonDir}:/host/commondir:ro`,
  "-v",
  "iterate-pnpm-store:/home/iterate/.pnpm-store",
  "--add-host",
  "host.docker.internal:host-gateway",
  "-e",
  "ITERATE_DEV=true",
  "-e",
  "HOST_REPO_CHECKOUT=/host/repo-checkout",
  "-e",
  "HOST_GITDIR=/host/gitdir",
  "-e",
  "HOST_COMMONDIR=/host/commondir",
  imageName,
  ...(command.length > 0 ? command : ["bash"]),
];

const result = spawnSync("docker", args, { stdio: "inherit" });
process.exit(result.status ?? 0);
