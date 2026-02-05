import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

export function resolveLocalDockerPostgresPort(): string {
  // Jonas runs many worktrees in parallel; compose gives each postgres container a different host port.
  // Resolve that mapped port so local DB commands target the right worktree.
  return process.env.LOCAL_DOCKER_POSTGRES_PORT ?? resolveComposePostgresPort() ?? "5432";
}

function resolveComposePostgresPort(): string | undefined {
  try {
    return execSync("tsx ./scripts/docker-compose.ts port postgres 5432", {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .split(":")
      .at(-1);
  } catch {
    return undefined;
  }
}
