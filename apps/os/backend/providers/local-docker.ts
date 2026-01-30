/**
 * Local Docker Provider
 *
 * Provider for local Docker development using docker-compose.
 * All local-docker machines share the same container (one per worktree).
 *
 * Requires LOCAL_DOCKER_COMPOSE_PROJECT_NAME env var to be set.
 * Uses Docker API to discover dynamically assigned host ports.
 *
 * Limitation: One sandbox container per worktree. Use Daytona for multiple sandboxes.
 */

import type { MachineProvider, CreateMachineConfig, MachineProviderResult } from "./types.ts";

// Container-internal ports (matches Dockerfile EXPOSE)
const DAEMON_PORT = 3000;
const OPENCODE_PORT = 4096;

// ============================================================================
// Docker API helpers (used by test-helpers.ts, not by the provider itself)
// ============================================================================

interface DockerHostConfig {
  socketPath?: string;
  url: string;
}

function parseDockerHost(): DockerHostConfig {
  const dockerHost = process.env.DOCKER_HOST ?? "tcp://127.0.0.1:2375";

  if (dockerHost.startsWith("unix://")) {
    return { socketPath: dockerHost.slice(7), url: "http://localhost" };
  }
  if (dockerHost.startsWith("tcp://")) {
    return { url: `http://${dockerHost.slice(6)}` };
  }
  return { url: dockerHost };
}

/** Get Docker API URL and socket path. Used by test helpers. */
export function getDockerHostConfig(): DockerHostConfig {
  return parseDockerHost();
}

// Lazy-loaded undici dispatcher for Unix socket support
let undiciDispatcher: unknown | undefined;

async function getUndiciDispatcher(socketPath: string): Promise<unknown> {
  if (!undiciDispatcher) {
    const { Agent } = await import("undici");
    undiciDispatcher = new Agent({ connect: { socketPath } });
  }
  return undiciDispatcher;
}

/** Docker API helper - used by test-helpers.ts for exec, logs, etc. */
export async function dockerApi<T>(
  method: string,
  endpoint: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const config = parseDockerHost();
  const dockerHost = process.env.DOCKER_HOST ?? "tcp://127.0.0.1:2375";
  const url = `${config.url}${endpoint}`;

  if (config.socketPath) {
    const { request } = await import("undici");
    const dispatcher = await getUndiciDispatcher(config.socketPath);
    const response = await request(url, {
      method: method as "GET" | "POST" | "DELETE",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      dispatcher: dispatcher as import("undici").Dispatcher,
    }).catch((e: unknown) => {
      throw new Error(
        `Docker API error: ${e}. DOCKER_HOST=${dockerHost}. ` +
          `For CI, set DOCKER_HOST=unix:///var/run/docker.sock`,
      );
    });

    if (response.statusCode < 200 || response.statusCode >= 300) {
      const error = await response.body.json().catch(() => ({ message: response.statusCode }));
      throw new Error(
        `Docker API error: ${(error as { message?: string }).message ?? response.statusCode}. ` +
          `DOCKER_HOST=${dockerHost}`,
      );
    }

    const text = await response.body.text();
    return text ? JSON.parse(text) : ({} as T);
  }

  const response = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).catch((e: unknown) => {
    throw new Error(
      `Docker API error: ${e}. DOCKER_HOST=${dockerHost}. ` +
        `For local dev, enable TCP API on port 2375 (OrbStack: Docker Engine settings).`,
    );
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: response.status }));
    throw new Error(
      `Docker API error: ${(error as { message?: string }).message ?? response.status}. ` +
        `DOCKER_HOST=${dockerHost}`,
    );
  }

  const text = await response.text();
  return text ? JSON.parse(text) : ({} as T);
}

// ============================================================================
// Local Docker Container Discovery
// ============================================================================

/**
 * Get the sandbox container name from compose project name.
 * Throws if project name is not provided - this is required for local-docker to work.
 */
function getLocalDockerContainerName(composeProjectName: string | undefined): string {
  if (!composeProjectName) {
    throw new Error(
      "LOCAL_DOCKER_COMPOSE_PROJECT_NAME is required for local-docker provider. " +
        "Run 'pnpm docker:up' to start containers with correct env vars.",
    );
  }
  // Docker Compose naming convention: {project}-{service}-{instance}
  return `${composeProjectName}-sandbox-1`;
}

/** Docker container inspect response (partial) */
interface DockerContainerInspect {
  Id: string;
  Name: string;
  NetworkSettings: {
    Ports: Record<string, Array<{ HostIp: string; HostPort: string }> | null>;
  };
}

/** Container info with resolved host ports */
interface ContainerInfo {
  containerName: string;
  containerId: string;
  ports: { daemon: number; opencode: number };
}

/**
 * Get container info including dynamically assigned host ports.
 * Queries Docker API once to inspect the container.
 */
async function getLocalDockerContainerInfo(
  composeProjectName: string | undefined,
): Promise<ContainerInfo> {
  const containerName = getLocalDockerContainerName(composeProjectName);

  // Inspect container directly by name
  const container = await dockerApi<DockerContainerInspect>(
    "GET",
    `/containers/${containerName}/json`,
  ).catch(() => {
    throw new Error(`Container ${containerName} not found. Run 'pnpm docker:up' first.`);
  });

  // Extract NetworkSettings.Ports to get host port mappings
  // Format: { "3000/tcp": [{ HostIp: "0.0.0.0", HostPort: "54321" }] }
  const portBindings = container.NetworkSettings.Ports;
  const daemonBinding = portBindings["3000/tcp"]?.[0];
  const opencodeBinding = portBindings["4096/tcp"]?.[0];

  if (!daemonBinding?.HostPort) {
    throw new Error("Daemon port 3000 not exposed. Is the container running?");
  }

  return {
    containerName,
    containerId: container.Id,
    ports: {
      daemon: parseInt(daemonBinding.HostPort, 10),
      opencode: opencodeBinding?.HostPort ? parseInt(opencodeBinding.HostPort, 10) : 0,
    },
  };
}

// ============================================================================
// Local Provider - reference to an already-running daemon on the host
// ============================================================================

export interface LocalProviderConfig {
  host: string;
  ports: Record<string, number>;
  buildProxyUrl: (port: number) => string;
}

export function createLocalProvider(config: LocalProviderConfig): MachineProvider {
  const { host, ports } = config;

  const getUrl = (port: number): string => {
    if (ports["iterate-daemon"] && port === DAEMON_PORT) {
      return `http://${host}:${ports["iterate-daemon"]}`;
    }
    return `http://${host}:${port}`;
  };

  const displayPort = ports["iterate-daemon"] ?? DAEMON_PORT;

  return {
    type: "local",

    async create(machineConfig: CreateMachineConfig): Promise<MachineProviderResult> {
      return {
        externalId: machineConfig.machineId,
        metadata: {
          host,
          ports,
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
    previewUrl: getUrl(DAEMON_PORT),

    displayInfo: {
      label: `Local ${host}:${displayPort}`,
      isDevOnly: true,
    },

    commands: [],
    terminalOptions: [],
  };
}

// ============================================================================
// Local Docker Provider
// All local-docker machines share the same container (managed via docker-compose)
// ============================================================================

/**
 * Create a Local Docker provider.
 * Fetches container info ONCE at creation time - all methods use cached info.
 *
 * @param composeProjectName - The LOCAL_DOCKER_COMPOSE_PROJECT_NAME from worker bindings
 */
export async function createLocalDockerProvider(
  composeProjectName: string | undefined,
): Promise<MachineProvider> {
  // Fetch container info ONCE when provider is created
  const containerInfo = await getLocalDockerContainerInfo(composeProjectName);
  const { containerName, containerId, ports } = containerInfo;

  // Map container-internal port to actual host port
  const getUrl = (port: number): string => {
    if (port === DAEMON_PORT) return `http://localhost:${ports.daemon}`;
    if (port === OPENCODE_PORT) return `http://localhost:${ports.opencode}`;
    // For unknown ports, assume same port (won't work with dynamic mapping)
    return `http://localhost:${port}`;
  };

  return {
    type: "local-docker",

    async create(_machineConfig: CreateMachineConfig): Promise<MachineProviderResult> {
      return {
        externalId: containerName, // Use container name as external ID
        metadata: {
          containerName,
          containerId,
          ports: { "iterate-daemon": ports.daemon, opencode: ports.opencode },
          daemonStatus: "ready",
          daemonReadyAt: new Date().toISOString(),
        },
      };
    },

    // Lifecycle methods use cached containerName
    async start(): Promise<void> {
      await dockerApi("POST", `/containers/${containerName}/start`);
    },

    async stop(): Promise<void> {
      await dockerApi("POST", `/containers/${containerName}/stop`);
    },

    async restart(): Promise<void> {
      await dockerApi("POST", `/containers/${containerName}/restart`);
    },

    // No-op: container is shared across all local-docker machines
    async archive(): Promise<void> {},

    // No-op: container is shared, managed externally via docker-compose
    async delete(): Promise<void> {},

    getPreviewUrl: getUrl,
    previewUrl: getUrl(DAEMON_PORT),

    displayInfo: {
      label: `Local Docker (${containerName})`,
      isDevOnly: true,
    },

    // Runtime metadata - always current, merged with stored metadata
    runtimeMetadata: {
      containerName,
      containerId,
      ports: { "iterate-daemon": ports.daemon, opencode: ports.opencode },
    },

    commands: [],
    terminalOptions: [],
  };
}
