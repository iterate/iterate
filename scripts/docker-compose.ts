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
  "DOCKER_HOST_GIT_COMMON_DIR",
  "DOCKER_HOST_GIT_DIR",
  "DOCKER_HOST_GIT_COMMIT",
  "DOCKER_HOST_GIT_BRANCH",
  "DOCKER_HOST_GIT_REPO_ROOT",
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

function runDockerCompose(composeArgs: string[]) {
  const captureOutput = composeArgs[0] === "up";
  const result = spawnSync("docker", ["compose", ...composeArgs], {
    env,
    ...(captureOutput ? { encoding: "utf-8", stdio: ["inherit", "pipe", "pipe"] } : {}),
    ...(!captureOutput ? { stdio: "inherit" } : {}),
  });

  if (captureOutput) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }

  return result;
}

const isUpCommand = args[0] === "up";
let result = runDockerCompose(args);

if ((result.status ?? 1) !== 0 && isUpCommand) {
  const combinedOutput = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const shouldRetry =
    combinedOutput.includes("No such container") ||
    combinedOutput.includes("dependency failed to start") ||
    combinedOutput.includes("is unhealthy");

  if (shouldRetry) {
    console.error("docker compose up failed with transient startup error; retrying once...");
    spawnSync("sleep", ["1"], { stdio: "inherit" });
    result = runDockerCompose(args);
  }
}

process.exit(result.status ?? 1);
