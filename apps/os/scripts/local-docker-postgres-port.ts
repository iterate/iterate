import { execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function resolveLocalDockerPostgresPort(): string {
  // Jonas often runs many worktrees in parallel; compose then assigns dynamic host ports.
  // This keeps local DB commands pointed at the active compose postgres port.
  if (process.env.LOCAL_DOCKER_POSTGRES_PORT) return process.env.LOCAL_DOCKER_POSTGRES_PORT;

  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const repoRoot = resolve(__dirname, "..", "..", "..");
    const out = execSync("tsx ./scripts/docker-compose.ts port postgres 5432", {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.match(/:(\d+)\s*$/m)?.[1] ?? "5432";
  } catch {
    return "5432";
  }
}
