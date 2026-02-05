import { execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function parsePublishedPort(rawOutput: string): string | undefined {
  const line = rawOutput
    .trim()
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .at(-1);
  const match = line?.match(/:(\d+)$/);
  return match?.[1];
}

export function resolveLocalDockerPostgresPort(): string {
  if (process.env.LOCAL_DOCKER_POSTGRES_PORT) {
    return process.env.LOCAL_DOCKER_POSTGRES_PORT;
  }

  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const repoRoot = resolve(__dirname, "..", "..", "..");
    const output = execSync("tsx ./scripts/docker-compose.ts port postgres 5432", {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const port = parsePublishedPort(output);
    return port ?? "5432";
  } catch {
    return "5432";
  }
}
