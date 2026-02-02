#!/usr/bin/env tsx
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getLocalDockerComposeProjectName,
  getLocalDockerEnvVars,
} from "../apps/os/sandbox/tests/helpers/local-docker-utils.ts";

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
const overrides = Object.fromEntries(
  overrideKeys.flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : [])),
);
const envVars = { ...derivedEnvVars, ...overrides };
const composeProjectName =
  envVars.LOCAL_DOCKER_COMPOSE_PROJECT_NAME ?? getLocalDockerComposeProjectName(repoRoot);

const env = {
  ...process.env,
  ...envVars,
  COMPOSE_PROJECT_NAME: composeProjectName,
};

const args = process.argv.slice(2);
if (args[0] === "--") args.shift();

const cmd = args.length === 0 ? ["docker", "compose"] : ["docker", "compose", ...args];
const result = spawnSync(cmd[0], cmd.slice(1), { env, stdio: "inherit" });
process.exit(result.status ?? 1);
