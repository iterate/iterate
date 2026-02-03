#!/usr/bin/env tsx
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getLocalDockerEnvVars } from "../apps/os/sandbox/tests/helpers/local-docker-utils.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

const derivedEnvVars = getLocalDockerEnvVars(repoRoot);
const overrideKeys = [
  "LOCAL_DOCKER_COMPOSE_PROJECT_NAME",
  "LOCAL_DOCKER_GIT_COMMON_DIR",
  "LOCAL_DOCKER_GIT_GITDIR",
  "LOCAL_DOCKER_GIT_COMMIT",
  "LOCAL_DOCKER_GIT_BRANCH",
  "LOCAL_DOCKER_GIT_REPO_ROOT",
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
