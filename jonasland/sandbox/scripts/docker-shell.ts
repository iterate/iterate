/**
 * Start a jonasland sandbox container and drop into an interactive shell.
 *
 * Usage:
 *   pnpm docker:shell
 *   pnpm docker:shell -- --no-pidnap
 *   pnpm docker:shell -- --image jonasland-sandbox:local
 *   pnpm docker:shell -- --no-host-sync
 *   pnpm docker:shell -- --env OPENAI_API_KEY --env ANTHROPIC_API_KEY
 *   pnpm docker:shell -- --env MY_VAR=custom_value
 *
 * Flags:
 *   --image <tag>      Docker image (default: $JONASLAND_SANDBOX_IMAGE)
 *   --no-host-sync     Disable host repo sync (enabled by default)
 *   --no-pidnap        Skip pidnap/caddy/iptables — just a bare shell
 *   --env <VAR>        Forward host env var into the container (repeatable)
 *   --env <K>=<V>      Set an arbitrary env var in the container (repeatable)
 */
import { execFileSync, execSync } from "node:child_process";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "..", "..", "..");

function parseArgs(argv: string[]) {
  let image = process.env.JONASLAND_SANDBOX_IMAGE || "jonasland-sandbox:latest";
  let hostSync = true;
  let pidnap = true;
  const envPairs: Array<{ key: string; value: string }> = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--image" && argv[i + 1]) {
      image = argv[++i]!;
    } else if (arg.startsWith("--image=")) {
      image = arg.slice("--image=".length);
    } else if (arg === "--no-host-sync") {
      hostSync = false;
    } else if (arg === "--host-sync") {
      hostSync = true;
    } else if (arg === "--no-pidnap") {
      pidnap = false;
    } else if (arg === "--pidnap") {
      pidnap = true;
    } else if (arg === "--env" && argv[i + 1]) {
      envPairs.push(resolveEnvArg(argv[++i]!));
    } else if (arg.startsWith("--env=")) {
      envPairs.push(resolveEnvArg(arg.slice("--env=".length)));
    }
  }
  return { image, hostSync, pidnap, envPairs };
}

function resolveEnvArg(raw: string): { key: string; value: string } {
  const eqIdx = raw.indexOf("=");
  if (eqIdx > 0) {
    return { key: raw.slice(0, eqIdx), value: raw.slice(eqIdx + 1) };
  }
  const fromHost = process.env[raw];
  if (fromHost !== undefined) {
    return { key: raw, value: fromHost };
  }
  console.warn(`[docker-shell] warning: env var ${raw} not set on host, skipping`);
  return { key: raw, value: "" };
}

function resolveGitDirs(): { gitDir: string; commonDir: string | null } {
  const gitDir = execSync("git rev-parse --git-dir", {
    cwd: repoRoot,
    encoding: "utf-8",
  }).trim();
  const commonDir = execSync("git rev-parse --git-common-dir", {
    cwd: repoRoot,
    encoding: "utf-8",
  }).trim();
  return { gitDir, commonDir: commonDir !== gitDir ? commonDir : null };
}

function waitForHealthy(containerId: string, timeoutMs: number): void {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const result = execSync(
        `docker exec ${containerId} curl -sf --max-time 2 http://127.0.0.1/__iterate/caddy-health`,
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
      );
      if (result.includes("ok")) return;
    } catch {
      // not ready yet
    }
    execSync("sleep 1");
  }
  throw new Error(`Container did not become healthy within ${timeoutMs}ms`);
}

const { image, hostSync, pidnap, envPairs } = parseArgs(process.argv.slice(2));

const createArgs: string[] = [
  "run",
  "-d",
  "--cap-add",
  "NET_ADMIN",
  "--add-host",
  "host.docker.internal:host-gateway",
];

if (hostSync) {
  const { gitDir, commonDir } = resolveGitDirs();
  createArgs.push(
    "-v",
    `${repoRoot}:/host/repo-checkout:ro`,
    "-v",
    `${gitDir}:/host/gitdir:ro`,
    "-e",
    "DOCKER_HOST_SYNC_ENABLED=true",
  );
  if (commonDir) {
    createArgs.push("-v", `${commonDir}:/host/commondir:ro`);
  }
  console.log(`[docker-shell] host-sync ON (${repoRoot})`);
} else {
  console.log("[docker-shell] host-sync OFF");
}

for (const { key, value } of envPairs) {
  if (value.length > 0) {
    createArgs.push("-e", `${key}=${value}`);
  }
}

createArgs.push(image);

if (!pidnap) {
  createArgs.push("sleep", "infinity");
  console.log("[docker-shell] pidnap OFF (bare shell)");
} else {
  console.log("[docker-shell] pidnap ON (full stack)");
}

console.log(`[docker-shell] image=${image}`);

const containerId = execFileSync("docker", createArgs, {
  cwd: repoRoot,
  encoding: "utf-8",
}).trim();
console.log(`[docker-shell] container=${containerId.slice(0, 12)}`);

function cleanup() {
  try {
    execFileSync("docker", ["rm", "-f", containerId], {
      cwd: repoRoot,
      stdio: "pipe",
    });
    console.log("[docker-shell] container removed");
  } catch {
    // already gone
  }
}

process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});
process.on("SIGTERM", () => {
  cleanup();
  process.exit(143);
});

try {
  if (pidnap) {
    console.log("[docker-shell] waiting for caddy...");
    waitForHealthy(containerId, 120_000);
  } else {
    execSync("sleep 2");
  }

  console.log("[docker-shell] ready — dropping into shell (exit to stop & remove container)");

  const isTTY = Boolean(process.stdin.isTTY);
  try {
    execFileSync(
      "docker",
      ["exec", ...(isTTY ? ["-it"] : ["-i"]), containerId, "bash", "-l"],
      { cwd: repoRoot, stdio: "inherit" },
    );
  } catch {
    // shell exited non-zero — that's fine
  }
} finally {
  cleanup();
}
