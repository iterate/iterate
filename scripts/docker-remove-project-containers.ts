#!/usr/bin/env tsx
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getLocalDockerComposeProjectName } from "../apps/os/sandbox/test/helpers.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const projectName = getLocalDockerComposeProjectName(repoRoot);
const projectLabel = `com.docker.compose.project=${projectName}`;

const psResult = spawnSync("docker", ["ps", "-aq", "--filter", `label=${projectLabel}`], {
  stdio: ["ignore", "pipe", "inherit"],
});

if (psResult.status !== 0) {
  process.exit(psResult.status ?? 1);
}

const containerIds = psResult.stdout
  .toString("utf-8")
  .split("\n")
  .map((id) => id.trim())
  .filter(Boolean);

if (containerIds.length === 0) {
  process.exit(0);
}

const rmResult = spawnSync("docker", ["rm", "-f", ...containerIds], { stdio: "inherit" });
process.exit(rmResult.status ?? 1);
