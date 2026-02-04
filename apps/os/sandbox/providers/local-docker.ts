/**
 * Local Docker Test Provider
 *
 * Creates sandbox containers via Docker API (not docker-compose).
 * Uses the same Docker API helpers as the backend provider.
 */

import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { dockerApi } from "../../backend/providers/local-docker.ts";
import { execInContainer, getLocalDockerGitInfo } from "../test/helpers.ts";
import type {
  CreateSandboxOptions,
  SandboxHandle,
  SandboxProvider,
  WaitHealthyResponse,
} from "./types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = join(__dirname, "../../../../..");

export interface LocalDockerProviderOptions {
  /** Override the repo root to mount into the container. Defaults to the iterate monorepo root. */
  repoRoot?: string;
  /** Enable syncing the host repo into the container (slow). Defaults to false. */
  syncFromHostRepo?: boolean;
}

const PIDNAP_PORT = 9876;

// Port definitions matching backend/daemons.ts
const DAEMON_PORTS = [
  { id: "iterate-daemon", internalPort: 3000 },
  { id: "iterate-daemon-server", internalPort: 3001 },
  { id: "opencode", internalPort: 4096 },
] as const;

interface DockerInspect {
  NetworkSettings?: {
    Ports?: Record<string, Array<{ HostPort?: string }> | null>;
  };
}

function getDefaultComposeProjectName(repoRoot: string): string {
  const repoName = basename(repoRoot);
  return repoName.toLowerCase().replace(/[^a-z0-9-]/g, "");
}

function resolveBaseImage(repoRoot: string): string {
  if (process.env.LOCAL_DOCKER_IMAGE_NAME) {
    return process.env.LOCAL_DOCKER_IMAGE_NAME;
  }

  const localDefault = "ghcr.io/iterate/sandbox:local";
  try {
    execSync(`docker image inspect ${localDefault}`, { stdio: "ignore" });
    return localDefault;
  } catch {
    // fall back
  }

  const bakedDefault = "ghcr.io/iterate/sandbox:main";
  try {
    execSync(`docker image inspect ${bakedDefault}`, { stdio: "ignore" });
    return bakedDefault;
  } catch {
    // fall back
  }

  const baseProjectName = getDefaultComposeProjectName(repoRoot);
  return `${baseProjectName}-sandbox`;
}

function rewriteLocalhost(url: string): string {
  return url.replace(/localhost/g, "host.docker.internal");
}

function sanitizeEnvVars(envVars: Record<string, string>): string[] {
  return Object.entries(envVars).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Invalid environment variable name: ${key}`);
    }
    // eslint-disable-next-line no-control-regex -- intentionally matching control chars
    const sanitizedValue = String(value).replace(/[\u0000-\u001f]/g, "");
    return `${key}=${sanitizedValue}`;
  });
}

class LocalDockerSandboxHandle implements SandboxHandle {
  public readonly id: string;

  constructor(
    private containerId: string,
    private ports: Record<number, number>, // containerPort -> hostPort
    private internalPorts: number[],
  ) {
    this.id = containerId;
  }

  async exec(cmd: string[]): Promise<string> {
    return execInContainer(this.containerId, cmd);
  }

  getUrl(opts: { port: number }): string {
    const hostPort = this.ports[opts.port] ?? opts.port;
    return `http://127.0.0.1:${hostPort}`;
  }

  async waitForServiceHealthy(opts: {
    process: string;
    timeoutMs?: number;
  }): Promise<WaitHealthyResponse> {
    const { process, timeoutMs = 180_000 } = opts;
    const pollIntervalMs = 1000;
    const start = Date.now();

    // Poll until timeout - never fail fast on connection errors
    while (Date.now() - start < timeoutMs) {
      const remainingMs = timeoutMs - (Date.now() - start);
      // Use shorter timeout for individual requests so we can retry
      const requestTimeoutMs = Math.min(remainingMs, 30_000);
      const payload = JSON.stringify({
        json: {
          target: process,
          timeoutMs: requestTimeoutMs,
          includeLogs: true,
          logTailLines: 200,
        },
      });

      try {
        const result = await this.exec([
          "curl",
          "-sf",
          "--max-time",
          String(Math.ceil(requestTimeoutMs / 1000)),
          "http://localhost:9876/rpc/processes/waitForRunning",
          "-H",
          "Content-Type: application/json",
          "-d",
          payload,
        ]);
        const parsed = JSON.parse(result) as {
          json?: { name: string; state: string; elapsedMs: number; logs?: string };
        };
        const response = (parsed.json ?? parsed) as {
          name: string;
          state: string;
          elapsedMs: number;
          logs?: string;
        };

        if (response.state === "running") {
          return {
            healthy: true,
            state: response.state,
            elapsedMs: Date.now() - start,
            logs: response.logs,
          };
        }
        if (response.state === "stopped" || response.state === "max-restarts-reached") {
          // Terminal failure state - don't retry
          return {
            healthy: false,
            state: response.state,
            elapsedMs: Date.now() - start,
            error: `Service ${process} in terminal state: ${response.state}`,
            logs: response.logs,
          };
        }
        // Non-terminal state (idle, starting, etc.) - the waitForRunning endpoint
        // should have waited, but if we get here, wait a bit and retry
      } catch {
        // Connection failed (pidnap not ready yet) - wait and retry
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    // Timeout reached
    return {
      healthy: false,
      state: "timeout",
      elapsedMs: Date.now() - start,
      error: `Timeout waiting for ${process} to become healthy`,
    };
  }

  async stop(): Promise<void> {
    try {
      await dockerApi("POST", `/containers/${this.containerId}/stop`, {});
    } catch {
      // Container might already be stopped
    }
  }

  async restart(): Promise<void> {
    await dockerApi("POST", `/containers/${this.containerId}/restart`, {});
    this.ports = await resolveHostPorts(this.containerId, this.internalPorts);
  }

  async delete(): Promise<void> {
    try {
      await dockerApi("DELETE", `/containers/${this.containerId}?force=true`, undefined);
    } catch {
      // Best effort cleanup
    }
  }
}

async function resolveHostPorts(
  containerId: string,
  internalPorts: number[],
): Promise<Record<number, number>> {
  const inspect = await dockerApi<DockerInspect>("GET", `/containers/${containerId}/json`);
  const ports = inspect.NetworkSettings?.Ports ?? {};
  const resolved: Record<number, number> = {};
  for (const internalPort of internalPorts) {
    const key = `${internalPort}/tcp`;
    const bindings = ports[key];
    const hostPortRaw = Array.isArray(bindings) ? bindings[0]?.HostPort : undefined;
    if (!hostPortRaw) {
      throw new Error(`No host port mapped for ${key}`);
    }
    const hostPort = Number(hostPortRaw);
    if (Number.isNaN(hostPort)) {
      throw new Error(`Invalid host port for ${key}: ${hostPortRaw}`);
    }
    resolved[internalPort] = hostPort;
  }
  return resolved;
}

export function createLocalDockerProvider(
  providerOpts?: LocalDockerProviderOptions,
): SandboxProvider {
  const repoRoot = providerOpts?.repoRoot ?? DEFAULT_REPO_ROOT;

  return {
    name: "local-docker",

    async createSandbox(opts?: CreateSandboxOptions): Promise<SandboxHandle> {
      const imageName = resolveBaseImage(repoRoot);

      const portBindings: Record<string, Array<{ HostPort: string }>> = {};
      const exposedPorts: Record<string, object> = {};

      DAEMON_PORTS.forEach((daemon) => {
        const internalPortKey = `${daemon.internalPort}/tcp`;
        portBindings[internalPortKey] = [{ HostPort: "0" }];
        exposedPorts[internalPortKey] = {};
      });

      // Pidnap port
      portBindings[`${PIDNAP_PORT}/tcp`] = [{ HostPort: "0" }];
      exposedPorts[`${PIDNAP_PORT}/tcp`] = {};

      // Container name
      const suffix = randomBytes(4).toString("hex");
      const containerName = `sandbox-test-${Date.now()}-${suffix}`;

      // Git mounts for repo sync (opt-in for tests that need host parity)
      const binds: string[] = [];
      const gitInfo = providerOpts?.syncFromHostRepo ? getLocalDockerGitInfo(repoRoot) : null;
      if (gitInfo) {
        binds.push(`${gitInfo.repoRoot}:/host/repo-checkout:ro`);
        binds.push(`${gitInfo.gitDir}:/host/gitdir:ro`);
        binds.push(`${gitInfo.commonDir}:/host/commondir:ro`);
      }

      // Docker env vars (minimal - just what's needed for container startup)
      const dockerEnv: Record<string, string> = {
        ITERATE_DEV: "true",
        ...(gitInfo ? { LOCAL_DOCKER_SYNC_FROM_HOST_REPO: "true" } : {}),
      };

      const envArray = sanitizeEnvVars(dockerEnv);

      // Env vars to write to ~/.iterate/.env (available to shells)
      const iterateEnv: Record<string, string> = { ...(opts?.env ?? {}) };
      if (iterateEnv.ITERATE_OS_BASE_URL) {
        iterateEnv.ITERATE_OS_BASE_URL = rewriteLocalhost(iterateEnv.ITERATE_OS_BASE_URL);
      }
      if (iterateEnv.ITERATE_EGRESS_PROXY_URL) {
        iterateEnv.ITERATE_EGRESS_PROXY_URL = rewriteLocalhost(iterateEnv.ITERATE_EGRESS_PROXY_URL);
      }
      const labels: Record<string, string> = {
        "com.iterate.test": "true",
        "com.iterate.container_name": containerName,
      };

      const hostConfig: Record<string, unknown> = {
        PortBindings: portBindings,
        Binds: binds,
        ExtraHosts: ["host.docker.internal:host-gateway"],
      };

      // Create container
      // When opts.command is provided, entry.sh will exec it directly instead of starting pidnap.
      // See apps/os/sandbox/entry.sh for the pattern: `if [[ $# -gt 0 ]]; then exec "$@"; fi`
      const createResponse = await dockerApi<{ Id: string }>(
        "POST",
        `/containers/create?name=${encodeURIComponent(containerName)}`,
        {
          Image: imageName,
          ...(opts?.command ? { Cmd: opts.command } : {}),
          Env: envArray,
          ExposedPorts: exposedPorts,
          HostConfig: hostConfig,
          Labels: labels,
        },
      );

      const containerId = createResponse.Id;

      // Start container
      await dockerApi("POST", `/containers/${containerId}/start`, {});

      const internalPorts = [...DAEMON_PORTS.map((daemon) => daemon.internalPort), PIDNAP_PORT];
      const ports = await resolveHostPorts(containerId, internalPorts);
      const handle = new LocalDockerSandboxHandle(containerId, ports, internalPorts);

      // Wait for entry.sh to complete (pidnap will be listening)
      // This ensures sync-home-skeleton has finished and won't overwrite our env vars
      if (Object.keys(iterateEnv).length > 0) {
        const maxWaitMs = 30000;
        const start = Date.now();
        while (Date.now() - start < maxWaitMs) {
          try {
            await handle.exec(["curl", "-sf", "http://localhost:9876/rpc/health"]);
            break;
          } catch {
            await new Promise((r) => setTimeout(r, 500));
          }
        }

        // Ensure initial sync scripts have finished before writing env vars
        const syncStart = Date.now();
        while (Date.now() - syncStart < maxWaitMs) {
          const running = await handle.exec([
            "bash",
            "-c",
            "pgrep -f 'sync-home-skeleton.sh|sync-repo-from-host.sh' || true",
          ]);
          if (!running.trim()) {
            break;
          }
          await new Promise((r) => setTimeout(r, 500));
        }

        // Write env vars to ~/.iterate/.env (appending to existing content)
        // First add a newline in case the file doesn't end with one
        await handle.exec(["sh", "-c", "echo '' >> ~/.iterate/.env"]);
        for (const [key, value] of Object.entries(iterateEnv)) {
          const encoded = Buffer.from(`export ${key}="${value}"\n`).toString("base64");
          await handle.exec(["sh", "-c", `echo '${encoded}' | base64 -d >> ~/.iterate/.env`]);
        }
      }

      return handle;
    },
  };
}
