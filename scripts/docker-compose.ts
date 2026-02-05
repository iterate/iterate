#!/usr/bin/env tsx
// Wrapper for docker compose that injects repo/git env vars (used by local dev services).
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDockerEnvVars } from "../sandbox/providers/docker/utils.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

const derivedEnvVars = getDockerEnvVars(repoRoot);
const overrideKeys = [
  "DOCKER_COMPOSE_PROJECT_NAME",
  "DOCKER_GIT_COMMON_DIR",
  "DOCKER_GIT_GITDIR",
  "DOCKER_GIT_COMMIT",
  "DOCKER_GIT_BRANCH",
  "DOCKER_GIT_REPO_ROOT",
] as const;
const env = {
  ...process.env,
  ...derivedEnvVars,
  ...Object.fromEntries(
    overrideKeys.map((key) => [key, process.env[key]] as const).filter(([, value]) => value),
  ),
};

const args = process.argv.slice(2);
if (args[0] === "--") args.shift();

const cmd = ["docker", "compose", ...args];
const result = spawnSync(cmd[0], cmd.slice(1), { env, stdio: "inherit" });
process.exit(result.status ?? 1);
