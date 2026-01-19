import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DAEMON_DEFINITIONS } from "../daemons.ts";
import type { MachineProvider, CreateMachineConfig, MachineProviderResult } from "./types.ts";

// Common log paths in sandbox
const DAEMON_LOG = "/var/log/iterate-daemon/current";
const OPENCODE_LOG = "/var/log/opencode/current";
const S6_STATUS_CMD =
  'export S6DIR=/home/iterate/src/github.com/iterate/iterate/apps/os/sandbox/s6-daemons && for svc in $S6DIR/*/; do echo "=== $(basename $svc) ==="; s6-svstat "$svc"; done';

const TERMINAL_PORT = 22222;
const DEFAULT_DAEMON_PORT = 3000;

// Support DOCKER_HOST env var, defaulting to TCP for local dev (OrbStack)
// Examples: unix:///var/run/docker.sock, tcp://127.0.0.1:2375
const DOCKER_HOST = process.env.DOCKER_HOST ?? "tcp://127.0.0.1:2375";

function parseDockerHost(): { socketPath?: string; url: string } {
  if (DOCKER_HOST.startsWith("unix://")) {
    // Unix sockets not supported in workerd - must use TCP
    throw new Error(
      "Unix socket not supported in workerd environment. Use TCP instead: DOCKER_HOST=tcp://127.0.0.1:2375",
    );
  }
  if (DOCKER_HOST.startsWith("tcp://")) {
    return { url: `http://${DOCKER_HOST.slice(6)}` };
  }
  // Assume it's a URL
  return { url: DOCKER_HOST };
}

const dockerHostConfig = parseDockerHost();
export const DOCKER_API_URL = dockerHostConfig.url;

// Repo root is ../../../../ from apps/os/backend/providers/
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");

/** Raw docker request using fetch (workerd-compatible) */
export async function dockerRequest(
  endpoint: string,
  options: { method?: string; body?: string; headers?: Record<string, string> } = {},
) {
  const response = await fetch(`${DOCKER_API_URL}${endpoint}`, {
    method: options.method ?? "GET",
    headers: options.headers,
    body: options.body,
  });
  return response;
}

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
        `DOCKER_HOST=${DOCKER_HOST}. ` +
        `For local dev, enable TCP API on port 2375 (OrbStack: Docker Engine settings). ` +
        `For CI, set DOCKER_HOST=unix:///var/run/docker.sock`,
    );
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: response.status }));
    throw new Error(
      `Docker API error: ${(error as { message?: string }).message ?? response.status}. ` +
        `DOCKER_HOST=${DOCKER_HOST}`,
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

// ============================================================================
// Local Provider - references already-running daemon on host
// ============================================================================

export interface LocalProviderConfig {
  metadata: {
    host?: string;
    port?: number;
    ports?: Record<string, number>;
  };
  buildProxyUrl: (port: number) => string;
}

export function createLocalProvider(config: LocalProviderConfig): MachineProvider {
  const { metadata, buildProxyUrl } = config;
  const host = metadata.host ?? "localhost";
  const ports = metadata.ports;

  const getUrl = (port: number): string => {
    if (ports) {
      const daemon = DAEMON_DEFINITIONS.find((d) => d.internalPort === port);
      if (daemon && ports[daemon.id]) {
        return `http://${host}:${ports[daemon.id]}`;
      }
      if (port === TERMINAL_PORT && ports["terminal"]) {
        return `http://${host}:${ports["terminal"]}`;
      }
      if (ports["iterate-daemon"]) {
        return `http://${host}:${ports["iterate-daemon"]}`;
      }
    }
    const legacyPort = metadata.port ?? DEFAULT_DAEMON_PORT;
    return `http://${host}:${legacyPort}`;
  };

  const displayPort = ports?.["iterate-daemon"] ?? metadata.port ?? DEFAULT_DAEMON_PORT;

  return {
    type: "local",

    async create(machineConfig: CreateMachineConfig): Promise<MachineProviderResult> {
      return {
        externalId: machineConfig.machineId,
        metadata: {
          daemonStatus: "ready",
          daemonReadyAt: new Date().toISOString(),
        },
      };
    },

    async start(): Promise<void> {},
    async stop(): Promise<void> {},
    async restart(): Promise<void> {},
    async archive(): Promise<void> {},
    async delete(): Promise<void> {},

    getPreviewUrl: getUrl,
    previewUrl: getUrl(DEFAULT_DAEMON_PORT),

    displayInfo: {
      label: `Local ${host}:${displayPort}`,
      isDevOnly: true,
    },

    commands: [
      { label: "Daemon logs", command: `tail -f ${DAEMON_LOG}` },
      { label: "OpenCode logs", command: `tail -f ${OPENCODE_LOG}` },
    ],

    terminalOptions: [{ label: "Proxy", url: buildProxyUrl(TERMINAL_PORT) }],
  };
}

// ============================================================================
// Local Vanilla Provider - legacy, similar to local
// ============================================================================

export interface LocalVanillaProviderConfig {
  buildProxyUrl: (port: number) => string;
}

export function createLocalVanillaProvider(config: LocalVanillaProviderConfig): MachineProvider {
  const { buildProxyUrl } = config;

  return {
    type: "local-vanilla",

    async create(machineConfig: CreateMachineConfig): Promise<MachineProviderResult> {
      return {
        externalId: machineConfig.machineId,
        metadata: {
          daemonStatus: "ready",
          daemonReadyAt: new Date().toISOString(),
        },
      };
    },

    async start(): Promise<void> {},
    async stop(): Promise<void> {},
    async restart(): Promise<void> {},
    async archive(): Promise<void> {},
    async delete(): Promise<void> {},

    getPreviewUrl: () => `http://localhost:${DEFAULT_DAEMON_PORT}`,
    previewUrl: `http://localhost:${DEFAULT_DAEMON_PORT}`,

    displayInfo: {
      label: "Local Vanilla",
      isDevOnly: true,
    },

    commands: [
      { label: "Daemon logs", command: `tail -f ${DAEMON_LOG}` },
      { label: "OpenCode logs", command: `tail -f ${OPENCODE_LOG}` },
    ],

    terminalOptions: [{ label: "Proxy", url: buildProxyUrl(TERMINAL_PORT) }],
  };
}

// ============================================================================
// Local Docker Provider - manages Docker containers
// ============================================================================

export interface LocalDockerProviderConfig {
  imageName: string;
  externalId: string;
  metadata: {
    containerId?: string;
    port?: number;
    ports?: Record<string, number>;
  };
  buildProxyUrl: (port: number) => string;
}

export function createLocalDockerProvider(config: LocalDockerProviderConfig): MachineProvider {
  const { imageName, externalId, metadata, buildProxyUrl } = config;
  const containerId = metadata.containerId;

  const getUrl = (port: number): string => {
    if (metadata.ports) {
      const daemon = DAEMON_DEFINITIONS.find((d) => d.internalPort === port);
      if (daemon && metadata.ports[daemon.id]) {
        return `http://localhost:${metadata.ports[daemon.id]}`;
      }
      if (port === TERMINAL_PORT && metadata.ports["terminal"]) {
        return `http://localhost:${metadata.ports["terminal"]}`;
      }
      if (metadata.ports["iterate-daemon"]) {
        return `http://localhost:${metadata.ports["iterate-daemon"]}`;
      }
    }
    // Legacy fallback
    const baseHostPort = metadata.port ?? DEFAULT_DAEMON_PORT;
    const hostPort = port === TERMINAL_PORT ? baseHostPort + 1 : baseHostPort;
    return `http://localhost:${hostPort}`;
  };

  const displayPort = metadata.ports?.["iterate-daemon"] ?? metadata.port;

  return {
    type: "local-docker",

    async create(machineConfig: CreateMachineConfig): Promise<MachineProviderResult> {
      const terminalInternalPort = TERMINAL_PORT;
      const numPorts = DAEMON_DEFINITIONS.length + 1;
      const basePort = await findAvailablePortBlock(numPorts);

      const ports: Record<string, number> = {};
      const portBindings: Record<string, Array<{ HostPort: string }>> = {};
      const exposedPorts: Record<string, object> = {};

      DAEMON_DEFINITIONS.forEach((daemon, index) => {
        const hostPort = basePort + index;
        const internalPortKey = `${daemon.internalPort}/tcp`;
        ports[daemon.id] = hostPort;
        portBindings[internalPortKey] = [{ HostPort: String(hostPort) }];
        exposedPorts[internalPortKey] = {};
      });

      const terminalHostPort = basePort + DAEMON_DEFINITIONS.length;
      ports["terminal"] = terminalHostPort;
      portBindings[`${terminalInternalPort}/tcp`] = [{ HostPort: String(terminalHostPort) }];
      exposedPorts[`${terminalInternalPort}/tcp`] = {};

      const rewrittenEnvVars = Object.fromEntries(
        Object.entries(machineConfig.envVars).map(([key, value]) => [
          key,
          value.replace(/localhost/g, "host.docker.internal"),
        ]),
      );

      const envVarsWithDev = {
        ...rewrittenEnvVars,
        ITERATE_DEV: "true",
      };

      const envArray = Object.entries(envVarsWithDev).map(([key, value]) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
          throw new Error(`Invalid environment variable name: ${key}`);
        }
        // eslint-disable-next-line no-control-regex -- intentionally matching control chars to sanitize
        const sanitizedValue = String(value).replace(/[\u0000-\u001f]/g, "");
        return `${key}=${sanitizedValue}`;
      });

      const binds = [`${REPO_ROOT}:/local-iterate-repo`];

      const hostConfig: Record<string, unknown> = {
        PortBindings: portBindings,
        Binds: binds,
      };

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

      const newContainerId = createResponse.Id;

      await dockerApi("POST", `/containers/${newContainerId}/start`, {});

      return {
        externalId: newContainerId,
        metadata: { ports, containerId: newContainerId },
      };
    },

    async start(): Promise<void> {
      await dockerApi("POST", `/containers/${externalId}/start`, {});
    },

    async stop(): Promise<void> {
      try {
        await dockerApi("POST", `/containers/${externalId}/stop`, {});
      } catch {
        // Container might already be stopped
      }
    },

    async restart(): Promise<void> {
      await dockerApi("POST", `/containers/${externalId}/restart`, {});
    },

    async archive(): Promise<void> {
      await this.stop();
    },

    async delete(): Promise<void> {
      await dockerApi("DELETE", `/containers/${externalId}?force=true`, undefined);
    },

    getPreviewUrl: getUrl,
    previewUrl: getUrl(DEFAULT_DAEMON_PORT),

    displayInfo: {
      label: `Local Docker :${displayPort ?? "?"}`,
      isDevOnly: true,
    },

    commands: containerId
      ? [
          { label: "Terminal shell", command: `docker exec -it ${containerId} /bin/bash` },
          { label: "Daemon logs", command: `docker exec ${containerId} tail -f ${DAEMON_LOG}` },
          { label: "OpenCode logs", command: `docker exec ${containerId} tail -f ${OPENCODE_LOG}` },
          { label: "Entry logs", command: `docker logs -f ${containerId}` },
          {
            label: "Service status",
            command: `docker exec ${containerId} sh -c '${S6_STATUS_CMD}'`,
          },
        ]
      : [],

    terminalOptions: [{ label: "Proxy", url: buildProxyUrl(TERMINAL_PORT) }],
  };
}
