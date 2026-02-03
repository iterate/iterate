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
import { dockerApi } from "../../../backend/providers/local-docker.ts";
import { execInContainer } from "../helpers/test-helpers.ts";
import { getLocalDockerGitInfo } from "../helpers/local-docker-utils.ts";
import type {
  CreateSandboxOptions,
  SandboxHandle,
  SandboxProvider,
  WaitHealthyResponse,
} from "./types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../../../../..");

const PIDNAP_PORT = 9876;

// Port definitions matching backend/daemons.ts
const DAEMON_PORTS = [
  { id: "iterate-daemon", internalPort: 3000 },
  { id: "iterate-daemon-server", internalPort: 3001 },
  { id: "opencode", internalPort: 4096 },
] as const;

interface DockerContainer {
  Ports?: Array<{ PublicPort?: number }>;
}

/** Find a block of consecutive available host ports by querying Docker */
async function findAvailablePortBlock(count: number): Promise<number> {
  const containers = await dockerApi<DockerContainer[]>("GET", "/containers/json?all=true");

  const usedPorts = new Set<number>();
  for (const container of containers) {
    for (const port of container.Ports ?? []) {
      if (port.PublicPort) {
        usedPorts.add(port.PublicPort);
      }
    }
  }

  // Find a contiguous block of `count` available ports
  for (let basePort = 10000; basePort <= 11000 - count; basePort++) {
    let blockAvailable = true;
    for (let i = 0; i < count; i++) {
      if (usedPorts.has(basePort + i)) {
        blockAvailable = false;
        break;
      }
    }
    if (blockAvailable) return basePort;
  }
  throw new Error(`No available port block of size ${count} in range 10000-11000`);
}

function getDefaultComposeProjectName(): string {
  const repoName = basename(REPO_ROOT);
  return repoName.toLowerCase().replace(/[^a-z0-9-]/g, "");
}

function resolveBaseImage(): string {
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

  const baseProjectName = getDefaultComposeProjectName();
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
  ) {
    this.id = containerId;
  }

  async exec(cmd: string[]): Promise<string> {
    return execInContainer(this.containerId, cmd);
  }

  getHostPort(containerPort: number): number {
    return this.ports[containerPort] ?? containerPort;
  }

  async waitForServiceHealthy(service: string, timeoutMs = 180_000): Promise<WaitHealthyResponse> {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      try {
        const payload = JSON.stringify({ json: { target: service } });
        const result = await this.exec([
          "curl",
          "-sf",
          "http://localhost:9876/rpc/processes/get",
          "-H",
          "Content-Type: application/json",
          "-d",
          payload,
        ]);
        const parsed = JSON.parse(result) as { json?: { state?: string } };
        const response = (parsed.json ?? parsed) as { state?: string };
        const state = response.state;
        const elapsedMs = Date.now() - start;
        if (state === "running") {
          return { healthy: true, state, elapsedMs };
        }
        if (state === "stopped" || state === "max-restarts-reached") {
          throw new Error(`Service ${service} in terminal state: ${state}`);
        }
      } catch (err) {
        if (err instanceof Error && err.message.includes("terminal state")) throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    return {
      healthy: false,
      state: "timeout",
      elapsedMs: timeoutMs,
      error: "timeout",
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
  }

  async delete(): Promise<void> {
    try {
      await dockerApi("DELETE", `/containers/${this.containerId}?force=true`, undefined);
    } catch {
      // Best effort cleanup
    }
  }
}

export function createLocalDockerProvider(): SandboxProvider {
  return {
    name: "local-docker",

    async createSandbox(opts?: CreateSandboxOptions): Promise<SandboxHandle> {
      const imageName = resolveBaseImage();

      // Allocate ports
      const totalPorts = DAEMON_PORTS.length + 1; // +1 for pidnap
      const basePort = await findAvailablePortBlock(totalPorts);

      const ports: Record<number, number> = {};
      const portBindings: Record<string, Array<{ HostPort: string }>> = {};
      const exposedPorts: Record<string, object> = {};

      DAEMON_PORTS.forEach((daemon, index) => {
        const hostPort = basePort + index;
        const internalPortKey = `${daemon.internalPort}/tcp`;
        ports[daemon.internalPort] = hostPort;
        portBindings[internalPortKey] = [{ HostPort: String(hostPort) }];
        exposedPorts[internalPortKey] = {};
      });

      // Pidnap port
      const pidnapHostPort = basePort + DAEMON_PORTS.length;
      ports[PIDNAP_PORT] = pidnapHostPort;
      portBindings[`${PIDNAP_PORT}/tcp`] = [{ HostPort: String(pidnapHostPort) }];
      exposedPorts[`${PIDNAP_PORT}/tcp`] = {};

      // Container name
      const suffix = randomBytes(4).toString("hex");
      const containerName = `sandbox-test-${Date.now()}-${suffix}`;

      // Git mounts for repo sync
      const binds: string[] = [];
      const gitInfo = getLocalDockerGitInfo(REPO_ROOT);
      if (gitInfo) {
        binds.push(`${gitInfo.repoRoot}:/host/repo-checkout:ro`);
        binds.push(`${gitInfo.gitDir}:/host/gitdir:ro`);
        binds.push(`${gitInfo.commonDir}:/host/commondir:ro`);
      }

      // Env vars
      const env: Record<string, string> = { ...(opts?.env ?? {}) };
      if (env.ITERATE_OS_BASE_URL) {
        env.ITERATE_OS_BASE_URL = rewriteLocalhost(env.ITERATE_OS_BASE_URL);
      }
      if (env.ITERATE_EGRESS_PROXY_URL) {
        env.ITERATE_EGRESS_PROXY_URL = rewriteLocalhost(env.ITERATE_EGRESS_PROXY_URL);
      }

      // Pass API keys if available
      if (process.env.ANTHROPIC_API_KEY) {
        env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
      }
      if (process.env.OPENAI_API_KEY) {
        env.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
      }

      const envVarsWithDev = {
        ...env,
        ITERATE_DEV: "true",
        ...(gitInfo ? { LOCAL_DOCKER_SYNC_FROM_HOST_REPO: "true" } : {}),
      };

      const envArray = sanitizeEnvVars(envVarsWithDev);

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
      const createResponse = await dockerApi<{ Id: string }>(
        "POST",
        `/containers/create?name=${encodeURIComponent(containerName)}`,
        {
          Image: imageName,
          Env: envArray,
          ExposedPorts: exposedPorts,
          HostConfig: hostConfig,
          Labels: labels,
        },
      );

      const containerId = createResponse.Id;

      // Start container
      await dockerApi("POST", `/containers/${containerId}/start`, {});

      return new LocalDockerSandboxHandle(containerId, ports);
    },
  };
}
