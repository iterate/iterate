/**
 * Local Docker Provider
 *
 * Minimal provider for local Docker development. Just provides URLs - no management plane calls.
 * Container is managed externally via docker-compose.
 *
 * Limitation: One sandbox container per worktree. Use Daytona for multiple sandboxes.
 */

import type { MachineProvider, CreateMachineConfig, MachineProviderResult } from "./types.ts";

// Fixed ports for local docker (matches docker-compose.yml)
const DAEMON_PORT = 3000;
const OPENCODE_PORT = 4096;

// Common log paths in sandbox (pidnap process manager) - kept for reference/future use
const _DAEMON_LOG = "/var/log/pidnap/process/iterate-daemon.log";
const _OPENCODE_LOG = "/var/log/pidnap/process/opencode.log";
const _PIDNAP_STATUS_CMD = "pidnap status";

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
// Local Docker Provider - minimal, just provides URLs
// Container is managed externally via docker-compose
// ============================================================================

export function createLocalDockerProvider(): MachineProvider {
  const getUrl = (port: number): string => `http://localhost:${port}`;

  return {
    type: "local-docker",

    // No management plane calls - just return metadata
    async create(_machineConfig: CreateMachineConfig): Promise<MachineProviderResult> {
      return {
        externalId: "local-docker",
        metadata: {
          ports: { "iterate-daemon": DAEMON_PORT, opencode: OPENCODE_PORT },
        },
      };
    },

    // All no-ops - container managed externally via docker-compose
    async start(): Promise<void> {},
    async stop(): Promise<void> {},
    async restart(): Promise<void> {},
    async archive(): Promise<void> {},
    async delete(): Promise<void> {},

    getPreviewUrl: getUrl,
    previewUrl: getUrl(DAEMON_PORT),

    displayInfo: {
      label: "Local Docker",
      isDevOnly: true,
    },

    commands: [],
    terminalOptions: [],
  };
}
