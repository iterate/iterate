import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DAEMON_DEFINITIONS } from "../daemons.ts";
import type { MachineProvider, CreateMachineConfig, MachineProviderResult } from "./types.ts";

export const DOCKER_API_URL = "http://127.0.0.1:2375";

// Repo root is ../../../../ from apps/os/backend/providers/
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");

export async function dockerApi<T>(
  method: string,
  endpoint: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(`${DOCKER_API_URL}${endpoint}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).catch((e: unknown) => {
    throw new Error(
      `Docker API error: ${e}. ` +
        `Make sure OrbStack/Docker is running with TCP API enabled on port 2375. Look for "Docker Engine" config in docs.`,
    );
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: response.status }));
    throw new Error(
      `Docker API error: ${(error as { message?: string }).message ?? response.status}. ` +
        `Make sure OrbStack/Docker is running with TCP API enabled on port 2375. Look for "Docker Engine" config in docs.`,
    );
  }

  const text = await response.text();
  return text ? JSON.parse(text) : ({} as T);
}

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

export interface LocalDockerConfig {
  imageName: string;
}

export function createLocalVanillaProvider(): MachineProvider {
  return {
    type: "local-vanilla",
    async create(machineConfig: CreateMachineConfig): Promise<MachineProviderResult> {
      return { externalId: machineConfig.machineId };
    },
    async start(_externalId: string): Promise<void> {
      return;
    },
    async stop(_externalId: string): Promise<void> {
      return;
    },
    async restart(_externalId: string): Promise<void> {
      return;
    },
    async archive(_externalId: string): Promise<void> {
      return;
    },
    async delete(_externalId: string): Promise<void> {
      return;
    },
    getPreviewUrl(
      _externalId: string,
      _metadata?: Record<string, unknown>,
      _port?: number,
    ): string {
      return "http://localhost:3000";
    },
  };
}

export function createLocalDockerProvider(config: LocalDockerConfig): MachineProvider {
  const { imageName } = config;

  return {
    type: "local-docker",

    async create(machineConfig: CreateMachineConfig): Promise<MachineProviderResult> {
      // Allocate a block of consecutive ports: one per daemon + one for terminal (22222)
      const terminalInternalPort = 22222;
      const numPorts = DAEMON_DEFINITIONS.length + 1; // +1 for terminal
      const basePort = await findAvailablePortBlock(numPorts);

      // Build port mappings: { daemonId: hostPort } for metadata
      const ports: Record<string, number> = {};
      const portBindings: Record<string, Array<{ HostPort: string }>> = {};
      const exposedPorts: Record<string, object> = {};

      // Map each daemon to a host port
      DAEMON_DEFINITIONS.forEach((daemon, index) => {
        const hostPort = basePort + index;
        const internalPortKey = `${daemon.internalPort}/tcp`;
        ports[daemon.id] = hostPort;
        portBindings[internalPortKey] = [{ HostPort: String(hostPort) }];
        exposedPorts[internalPortKey] = {};
      });

      // Map terminal to the last port in the block
      const terminalHostPort = basePort + DAEMON_DEFINITIONS.length;
      ports["terminal"] = terminalHostPort;
      portBindings[`${terminalInternalPort}/tcp`] = [{ HostPort: String(terminalHostPort) }];
      exposedPorts[`${terminalInternalPort}/tcp`] = {};

      // For local-docker, rewrite localhost URLs to host.docker.internal
      // so the container can reach services on the host machine
      const rewrittenEnvVars = Object.fromEntries(
        Object.entries(machineConfig.envVars).map(([key, value]) => [
          key,
          value.replace(/localhost/g, "host.docker.internal"),
        ]),
      );

      // Add ITERATE_DEV=true for local-docker so entry.ts uses the right code path
      const envVarsWithDev = {
        ...rewrittenEnvVars,
        ITERATE_DEV: "true",
      };

      // Sanitize env vars to prevent injection attacks
      const envArray = Object.entries(envVarsWithDev).map(([key, value]) => {
        // Validate key contains only safe characters
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
          throw new Error(`Invalid environment variable name: ${key}`);
        }
        // Remove control characters (ASCII 0-31) from values to prevent injection
        // eslint-disable-next-line no-control-regex -- intentionally matching control chars to sanitize
        const sanitizedValue = String(value).replace(/[\u0000-\u001f]/g, "");
        return `${key}=${sanitizedValue}`;
      });

      // Mount local repo for development (allows code changes without rebuilding image)
      // Read-write so entry.ts can delete it after copying to avoid confusion
      const binds = [`${REPO_ROOT}:/local-iterate-repo`];

      const hostConfig: Record<string, unknown> = {
        PortBindings: portBindings,
        Binds: binds,
      };

      // Use machine name (slug) for container name for easier identification
      // Docker container names: alphanumeric, underscore, hyphen, period (must start with alphanumeric)
      const containerName = machineConfig.name
        .toLowerCase()
        .replace(/[^a-z0-9_.-]/g, "-")
        .replace(/^[^a-z0-9]+/, "")
        .slice(0, 63);

      const createResponse = await dockerApi<{ Id: string }>(
        "POST",
        `/containers/create?name=${encodeURIComponent(containerName || machineConfig.machineId)}`,
        {
          Image: imageName,
          Env: envArray,
          ExposedPorts: exposedPorts,
          HostConfig: hostConfig,
        },
      );

      const containerId = createResponse.Id;

      await dockerApi("POST", `/containers/${containerId}/start`, {});

      return {
        externalId: containerId,
        metadata: { ports, containerId },
      };
    },

    async start(externalId: string): Promise<void> {
      await dockerApi("POST", `/containers/${externalId}/start`, {});
    },

    async stop(externalId: string): Promise<void> {
      try {
        await dockerApi("POST", `/containers/${externalId}/stop`, {});
      } catch {
        // Container might already be stopped
      }
    },

    async restart(externalId: string): Promise<void> {
      await dockerApi("POST", `/containers/${externalId}/restart`, {});
    },

    async archive(externalId: string): Promise<void> {
      await this.stop(externalId);
    },

    async delete(externalId: string): Promise<void> {
      await dockerApi("DELETE", `/containers/${externalId}?force=true`, undefined);
    },

    getPreviewUrl(_externalId: string, metadata?: Record<string, unknown>, port?: number): string {
      const meta = metadata as { ports?: Record<string, number>; port?: number };

      // New format: ports is a map of daemonId/terminal -> hostPort
      if (meta?.ports) {
        // Find which daemon this internal port corresponds to
        const daemon = DAEMON_DEFINITIONS.find((d) => d.internalPort === port);
        if (daemon && meta.ports[daemon.id]) {
          return `http://localhost:${meta.ports[daemon.id]}`;
        }
        // Terminal port
        if (port === 22222 && meta.ports["terminal"]) {
          return `http://localhost:${meta.ports["terminal"]}`;
        }
        // Default to iterate-daemon
        if (meta.ports["iterate-daemon"]) {
          return `http://localhost:${meta.ports["iterate-daemon"]}`;
        }
      }

      // Legacy fallback: single port field
      const baseHostPort = meta?.port ?? 3000;
      const hostPort = port === 22222 ? baseHostPort + 1 : baseHostPort;
      return `http://localhost:${hostPort}`;
    },
  };
}
