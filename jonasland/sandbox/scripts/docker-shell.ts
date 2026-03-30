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
 *   pnpm docker:shell -- --name my-sandbox
 *   pnpm docker:shell -- --label dev.orbstack.http-port=80
 *
 * Flags:
 *   --image <tag>      Docker image (default: $JONASLAND_SANDBOX_IMAGE or jonasland-sandbox:local)
 *   --name <name>      Container name (always drives ITERATE_INGRESS_HOST)
 *   --label <K>=<V>    Docker label (repeatable)
 *   --no-host-sync     Disable host repo sync (enabled by default)
 *   --no-pidnap        Skip pidnap/caddy/iptables — just a bare shell
 *   --env <VAR>        Forward host env var into the container (repeatable)
 *   --env <K>=<V>      Set an arbitrary env var in the container (repeatable)
 */
import { execFileSync, execSync } from "node:child_process";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "..", "..", "..");

function parseArgs(argv: string[]) {
  let image = process.env.JONASLAND_SANDBOX_IMAGE || "jonasland-sandbox:local";
  let hostSync = true;
  let pidnap = true;
  let containerName: string | undefined;
  const envPairs: Array<{ key: string; value: string }> = [];
  const labels: Array<{ key: string; value: string }> = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--image" && argv[i + 1]) {
      image = argv[++i]!;
    } else if (arg.startsWith("--image=")) {
      image = arg.slice("--image=".length);
    } else if (arg === "--name" && argv[i + 1]) {
      containerName = argv[++i]!;
    } else if (arg.startsWith("--name=")) {
      containerName = arg.slice("--name=".length);
    } else if (arg === "--label" && argv[i + 1]) {
      labels.push(parseLabelArg(argv[++i]!));
    } else if (arg.startsWith("--label=")) {
      labels.push(parseLabelArg(arg.slice("--label=".length)));
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
  return { image, hostSync, pidnap, containerName, envPairs, labels };
}

function toOrbHost(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]/g, "-")
    .replaceAll(/-+/g, "-")
    .replaceAll(/^-|-$/g, "");
}

function defaultContainerName(): string {
  return `jonasland-${Date.now().toString().slice(-8)}`;
}

function parseLabelArg(raw: string): { key: string; value: string } {
  const eqIdx = raw.indexOf("=");
  if (eqIdx > 0) {
    return { key: raw.slice(0, eqIdx), value: raw.slice(eqIdx + 1) };
  }
  return { key: raw, value: "" };
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

const { image, hostSync, pidnap, containerName, envPairs, labels } = parseArgs(
  process.argv.slice(2),
);
const effectiveContainerName = containerName ?? defaultContainerName();

const createArgs: string[] = [
  "run",
  "-d",
  "--cap-add",
  "NET_ADMIN",
  "--add-host",
  "host.docker.internal:host-gateway",
];

createArgs.push("--name", effectiveContainerName);

const orbHost = toOrbHost(effectiveContainerName);
const hasIngressHost = envPairs.some((e) => e.key === "ITERATE_INGRESS_HOST");
if (!hasIngressHost) {
  envPairs.push(
    { key: "ITERATE_INGRESS_HOST", value: `${orbHost}.orb.local` },
    { key: "ITERATE_INGRESS_ROUTING_TYPE", value: "subdomain-host" },
  );
}
console.log(`[docker-shell] name=${effectiveContainerName}`);
console.log(`[docker-shell] ingress-host=${orbHost}.orb.local`);

if (!labels.some((l) => l.key === "dev.orbstack.http-port")) {
  labels.push({ key: "dev.orbstack.http-port", value: "80" });
}

for (const { key, value } of labels) {
  createArgs.push("--label", `${key}=${value}`);
}

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
    execFileSync("docker", ["exec", ...(isTTY ? ["-it"] : ["-i"]), containerId, "bash", "-l"], {
      cwd: repoRoot,
      stdio: "inherit",
    });
  } catch {
    // shell exited non-zero — that's fine
  }
} finally {
  cleanup();
}
